// yxpil · BIT core
//! 模型下载公共链路（voice 语音识别 / tts 语音合成共用）。
//!
//! 原实现内嵌在 voice.rs，TTS 本地引擎需要同一套能力（HTTP Range 断点续传、
//! 候选源 HEAD 探活排序、SHA-256 校验、原子改名落位、节流进度事件），故抽到此模块：
//! - 清单条目 [`AssetEntry`]：name / url / bytes / sha256（字节数是权威长度）
//! - [`download_one`]：单文件下载；网络中断保留 .part 供下次续传，校验不过才删残件换源
//! - 进度事件名由调用方传入（voice 用 "voice-progress"，tts 用 "tts-progress"），
//!   载荷形状保持一致：{done, total, file}
//!
//! voice.rs 的行为与抽离前完全一致（同样的重试顺序、同样的错误文案、同样的 200ms 节流）。

use serde_json::json;
use std::io::Write as _;
use std::path::Path;
use std::sync::Arc;

use crate::state::Ctx;

/// 清单里单个文件的条目（name / url / 精确字节数 / SHA-256）
#[derive(Clone, serde::Deserialize)]
pub struct AssetEntry {
    pub name: String,
    pub url: String,
    pub bytes: u64,
    /// 缺省（或空串）= 清单未收录哈希，下载只按字节数校验
    #[serde(default)]
    pub sha256: String,
}

/// 单文件就位判定：存在且字节数与清单完全一致
pub fn file_ready(dir: &Path, e: &AssetEntry) -> bool {
    std::fs::metadata(dir.join(&e.name))
        .map(|m| m.len() == e.bytes)
        .unwrap_or(false)
}

/// 全部文件就位才算 ready（空清单视为未就绪）
pub fn all_ready(dir: &Path, entries: &[AssetEntry]) -> bool {
    !entries.is_empty() && entries.iter().all(|e| file_ready(dir, e))
}

/// 下载源候选：清单主源（huggingface.co）→ hf-mirror.com 镜像（国内可达时回退）
pub fn candidate_urls(url: &str) -> Vec<String> {
    let mut v = vec![url.to_string()];
    if let Some(rest) = url.strip_prefix("https://huggingface.co") {
        v.push(format!("https://hf-mirror.com{rest}"));
    }
    v
}

/// 学 dsh 的 HEAD 探活：并发探测各候选源，先响应的排前面（失败源仍留在后面作回退）。
/// 被 DNS 污染的主源连不上时，能让下载直接从镜像源开始，省掉每次 15s 连接超时。
pub async fn probe_order(urls: Vec<String>) -> Vec<String> {
    use futures_util::future::join_all;
    if urls.len() < 2 {
        return urls;
    }
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return urls,
    };
    let probes = urls.iter().map(|u| {
        let (client, u) = (client.clone(), u.clone());
        async move {
            client
                .head(&u)
                .header("User-Agent", "BIT-Agent")
                .send()
                .await
                .is_ok()
        }
    });
    let alive = join_all(probes).await;
    let mut ordered = Vec::with_capacity(urls.len());
    // 活源在前（保持原顺序），失败源仍在后面作回退
    for (url, ok) in urls.iter().zip(alive.iter()) {
        if *ok {
            ordered.push(url.clone());
        }
    }
    for (url, ok) in urls.iter().zip(alive.iter()) {
        if !*ok {
            ordered.push(url.clone());
        }
    }
    ordered
}

/// 流式下载：分块写 .part + 边下边算 SHA-256 + 每 ~200ms 广播进度事件。
/// 空 sha256 的条目（清单未收录哈希的模型）跳过哈希比对，只按字节数收尾。
pub async fn stream_download(
    ctx: &Arc<Ctx>,
    url: &str,
    part: &Path,
    e: &AssetEntry,
    base_done: u64,
    total: u64,
    event: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        // 兜底上限：慢网 1 小时拉不完视为失败（避免 DL_BUSY 永久卡住）
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|e| format!("构建下载客户端失败: {e}"))?;

    // 断点续传：本地残件在清单长度内则带 Range 从断点继续；超长残件不可信，丢弃重来
    let mut have: u64 = 0;
    if e.bytes > 0 {
        if let Ok(len) = std::fs::metadata(part).map(|m| m.len()) {
            if len >= e.bytes {
                let _ = std::fs::remove_file(part);
            } else if len > 0 {
                have = len;
            }
        }
    }
    let mut req = client.get(url).header("User-Agent", "BIT-Agent");
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    // 206 = 服务器认了断点；200 = 服务器整份重给，覆盖写并从头算哈希
    let resume = have > 0 && status.as_u16() == 206;
    let mut hasher = Sha256::new();
    let mut got: u64 = 0;
    if resume {
        use std::io::Read;
        // 已有前缀先喂进哈希，保证最终 SHA 覆盖整个文件
        let mut pre = std::fs::File::open(part).map_err(|e| format!("读取断点失败: {e}"))?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = pre.read(&mut buf).map_err(|e| format!("读取断点失败: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        got = have;
    }
    let mut file = if resume {
        std::fs::OpenOptions::new()
            .append(true)
            .open(part)
            .map_err(|e| format!("写入临时文件失败: {e}"))?
    } else {
        std::fs::File::create(part).map_err(|e| format!("写入临时文件失败: {e}"))?
    };
    let mut stream = resp.bytes_stream();
    let mut last_at = std::time::Instant::now();
    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("下载中断: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("写入失败: {e}"))?;
        hasher.update(&chunk);
        got += chunk.len() as u64;
        if last_at.elapsed().as_millis() >= 200 {
            last_at = std::time::Instant::now();
            ctx.emit(
                event,
                json!({ "done": base_done + got, "total": total, "file": e.name }),
            );
        }
    }
    file.flush().map_err(|e| format!("写入失败: {e}"))?;
    drop(file);
    // 清单给了精确字节数时按它校验（content-length 缺失也能兜住截断下载）
    if e.bytes > 0 && got > e.bytes {
        // 比清单还长说明内容不可信，整件作废
        let _ = std::fs::remove_file(part);
        return Err(format!("下载长度超出清单（{got}/{} 字节）", e.bytes));
    }
    if e.bytes > 0 && got != e.bytes {
        // 早于清单长度收尾：数据是合法前缀，保留断点供续传
        return Err(format!("下载不完整（{got}/{} 字节），已保留断点", e.bytes));
    }
    // 清单未给哈希（部分新模型未收录）时只校验长度
    if e.sha256.is_empty() {
        return Ok(());
    }
    let sum = hasher.finalize();
    let sum = sum.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !sum.eq_ignore_ascii_case(&e.sha256) {
        // 内容坏了，续传只会把坏数据越攒越多，必须整件丢弃
        let _ = std::fs::remove_file(part);
        return Err(format!("SHA-256 校验失败（{sum}）"));
    }
    Ok(())
}

/// 校验临时文件：落位前再核一次字节数（SHA 已在流式阶段算过，此处只查长度）
pub fn verify_part(part: &Path, e: &AssetEntry) -> Result<(), String> {
    let len = std::fs::metadata(part)
        .map_err(|err| format!("读取临时文件失败: {err}"))?
        .len();
    if e.bytes > 0 && len != e.bytes {
        return Err(format!("大小不符（{len}/{} 字节）", e.bytes));
    }
    Ok(())
}

/// 单文件：按候选源依次流式下载到 .part → 大小 + SHA-256 校验 → 原子改名落位。
/// 网络类错误保留 .part 供下次续传，仅校验不过时删残件换源。
pub async fn download_one(
    ctx: &Arc<Ctx>,
    dir: &Path,
    e: &AssetEntry,
    base_done: u64,
    total: u64,
    event: &str,
) -> Result<(), String> {
    let part = dir.join(format!("{}.part", e.name));
    let dest = dir.join(&e.name);
    let mut last_err = String::from("无可用下载源");
    for url in probe_order(candidate_urls(&e.url)).await {
        match stream_download(ctx, &url, &part, e, base_done, total, event).await {
            Ok(()) => {
                // 大小 + SHA-256 双校验；不符删残件换源（清单字节数是权威长度）
                match verify_part(&part, e) {
                    Ok(()) => {
                        std::fs::rename(&part, &dest)
                            .map_err(|err| format!("模型文件落位失败: {err}"))?;
                        return Ok(());
                    }
                    Err(err) => {
                        // 内容不可信（长度不对），必须丢弃；否则保留 .part 让后续源续传
                        let _ = std::fs::remove_file(&part);
                        last_err = err;
                    }
                }
            }
            Err(err) => {
                // 网络中断/超时：保留已下数据，换源或下次重进都从断点续
                last_err = err;
            }
        }
    }
    Err(format!("下载 {} 失败：{}", e.name, last_err))
}
