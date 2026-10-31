// yxpil · BIT core
//! 语音输入后端：本地 SenseVoice 离线识别（voice-bridge/voice-worker.mjs 子进程）+ 模型下载。
//!
//! 结构（移植自 @deepseek-ai/dsh-experimental-speech-to-text-sensevoice，MIT）：
//! - 模型清单 voice-bridge/assets.json：三个文件（model.int8.onnx / tokens.txt /
//!   silero_vad.onnx）的精确字节数、SHA-256 与下载 URL
//! - voice_prepare：后台流式下载到数据目录 voice/，边下边算 SHA-256，校验通过原子落位；
//!   进度经 ctx.emit("voice-progress", …) 推给前端；重复调用幂等
//! - worker 单例：spawn current_exe（配 ELECTRON_RUN_AS_NODE=1）执行 worker 脚本，
//!   env DSH_SPEECH_TOKEN 传 64 hex 令牌，stdout 读到 {"port":N} 即就绪
//! - voice_transcribe：base64 WAV → POST 127.0.0.1:port/transcribe（Bearer），
//!   起不来或转写失败自动重启 worker 重试一次
//!
//! 四个能力经 commands_api 暴露：voice_status / voice_prepare / voice_transcribe。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::download::{all_ready, download_one, AssetEntry};
use crate::state::Ctx;

// ---------- 模型清单（voice-bridge/assets.json） ----------

/// assets.json 结构：models 按精度（int8/fp32）分键 + tokens + vad；
/// variants 为多识别模型选一清单（dir 为相对 voice/ 的落盘子目录）
#[derive(serde::Deserialize)]
struct AssetsManifest {
    models: HashMap<String, AssetEntry>,
    #[serde(default)]
    variants: HashMap<String, VariantDef>,
    tokens: AssetEntry,
    vad: AssetEntry,
    /// 关键词唤醒（可选节；旧清单没有也能解析）
    #[serde(default)]
    kws: Option<KwsDef>,
}

/// 唤醒模型定义：固定 transducer 型 KWS，落盘 model_dir/kws；包内成员经 archive 解出
#[derive(serde::Deserialize, Clone)]
struct KwsDef {
    #[serde(default)]
    label: String,
    /// tar.bz2 归档（与 TTS 引擎同构：整包下载 → tar -O 逐成员解出）
    #[serde(default)]
    archive: Option<KwsArchive>,
    files: Vec<KwsFile>,
}

#[derive(serde::Deserialize, Clone)]
struct KwsArchive {
    url: String,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    sha256: String,
}

/// 唤醒模型文件：inner 非空表示归档成员（name 为落盘名）；inner 空则 url 直链
#[derive(serde::Deserialize, Clone)]
struct KwsFile {
    name: String,
    #[serde(default)]
    inner: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    sha256: String,
}

/// 唤醒文件就位判定：bytes>0 按字节数，否则存在即可
fn kws_file_ready(dir: &Path, f: &KwsFile) -> bool {
    let p = dir.join(&f.name);
    if f.bytes > 0 {
        std::fs::metadata(&p).map(|m| m.len() == f.bytes).unwrap_or(false)
    } else {
        p.is_file()
    }
}

fn kws_ready(dir: &Path, files: &[KwsFile]) -> bool {
    !files.is_empty() && files.iter().all(|f| kws_file_ready(dir, f))
}

/// 识别模型变体（多模型选一）：引擎类型 + 落盘子目录 + 文件清单
#[derive(serde::Deserialize, Clone)]
struct VariantDef {
    #[serde(default)]
    label: String,
    dir: String,
    /// sherpa 识别器引擎：senseVoice / transducer / paraformer / whisper
    engine: String,
    #[serde(default)]
    languages: Vec<String>,
    files: Vec<AssetEntry>,
}

/// 定位 voice-bridge/voice-worker.mjs：
/// a) 主程序所在目录向上逐级找 Resources/…（macOS bundle）与
///    resources/app.asar.unpacked/…（Windows/Linux electron-builder）
/// b) 进程 cwd 及其祖先目录（开发态仓库根）
/// c) 源码树回退：crates/bit-core/../../voice-bridge（cargo run / cargo test 也能找到）
fn find_worker_script() -> Option<PathBuf> {
    const REL: &str = "voice-bridge/voice-worker.mjs";
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for anc in dir.ancestors() {
                cands.push(anc.join("Resources").join(REL));
                cands.push(anc.join("resources/app.asar.unpacked").join(REL));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for anc in cwd.ancestors() {
            cands.push(anc.join(REL));
        }
    }
    // 开发态回退：CARGO_MANIFEST_DIR = crates/bit-core
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join(REL),
    );
    cands.into_iter().find(|p| p.is_file())
}

/// 桥脚本定位（找不到给出中文错误）
fn bridge_script() -> Result<PathBuf, String> {
    find_worker_script()
        .ok_or_else(|| "找不到语音识别桥脚本（voice-bridge/voice-worker.mjs）".to_string())
}

/// sherpa 平台原生包的 npm 命名（`sherpa-onnx-<os>-<arch>`）：包名用 Node 的
/// os.platform()/os.arch() 口径，与 Rust 的 std::env::consts 不同，需要转换。
fn sherpa_pkg_stem(os: &str, arch: &str) -> String {
    let os = match os {
        "macos" => "darwin",
        "windows" => "win",
        other => other,
    };
    let arch = match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        "arm" => "arm",
        other => other,
    };
    format!("sherpa-onnx-{os}-{arch}")
}

/// worker 里 sherpa-onnx-node 的平台原生包目录（含 sherpa-onnx.node 与同级动态库）。
fn sherpa_native_dir(script: &Path) -> Option<PathBuf> {
    let dir = script
        .parent()?
        .join("node_modules")
        .join(sherpa_pkg_stem(std::env::consts::OS, std::env::consts::ARCH));
    dir.is_dir().then_some(dir)
}

/// 给 worker 子进程补动态库搜索路径。
/// 原生包里 sherpa-onnx.node 与 libsherpa-onnx-c-api / libonnxruntime 同目录发布：
/// Linux 的 .node 带 `RUNPATH $ORIGIN`，但 RUNPATH 只对自身直接依赖生效，
/// 而 libsherpa-onnx-c-api.so 没有任何 RPATH，它再找 libonnxruntime.so 时
/// 只认 LD_LIBRARY_PATH / 系统缓存——不设就会 dlopen 失败。
/// Windows 同理把目录并进 PATH，覆盖 DLL 隐式加载的搜索顺序。
/// macOS 的 dylib 自带 `LC_RPATH @loader_path`，链条自洽（签名进程也会被系统剥掉 DYLD_*），故不设。
fn apply_native_lib_paths(cmd: &mut tokio::process::Command, script: &Path) {
    let Some(native) = sherpa_native_dir(script) else {
        return;
    };
    let s = native.to_string_lossy().to_string();
    if cfg!(target_os = "linux") {
        let old = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
        cmd.env("LD_LIBRARY_PATH", if old.is_empty() { s } else { format!("{s}:{old}") });
    } else if cfg!(windows) {
        let old = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", if old.is_empty() { s } else { format!("{s};{old}") });
    }
}

/// 读取并解析 assets.json（与桥脚本同目录）
fn load_manifest(script: &Path) -> Result<AssetsManifest, String> {
    let p = script.with_file_name("assets.json");
    let raw = std::fs::read_to_string(&p)
        .map_err(|e| format!("读取语音模型清单失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("语音模型清单损坏: {e}"))
}

/// 当前选中的识别模型（bit.db "voice" 分区 "variant" 键；缺省 sense-voice）
const DEFAULT_VARIANT: &str = "sense-voice";

/// 从配置读当前变体 id（非法值回落默认）
fn load_variant(ctx: &Ctx) -> String {
    let saved: String =
        crate::store::get_json(&ctx.db.lock().unwrap(), "voice.variant").unwrap_or_default();
    let v = saved.trim().to_string();
    if v.is_empty() {
        DEFAULT_VARIANT.into()
    } else {
        v
    }
}

// ---------- 关键词唤醒（KWS）辅助 ----------

/// 唤醒模型落盘目录：model_dir/kws
fn kws_dir(ctx: &Ctx) -> PathBuf {
    model_dir(ctx).join("kws")
}

/// 唤醒开关（bit.db voice.kwsOn；默认关）
fn kws_on(ctx: &Ctx) -> bool {
    crate::store::get_json(&ctx.db.lock().unwrap(), "voice.kwsOn").unwrap_or(false)
}

/// 唤醒灵敏度 keywordsScore（bit.db voice.kwsScore；默认 1.5，越大越严）
fn kws_score(ctx: &Ctx) -> f64 {
    let s: f64 = crate::store::get_json(&ctx.db.lock().unwrap(), "voice.kwsScore").unwrap_or(1.5);
    if s.is_finite() { s.clamp(0.5, 4.0) } else { 1.5 }
}

/// worker 启动配置的 kws 节：开关开启 + 清单含 kws + 模型全部就位时返回 Some。
/// 文件名带 epoch 后缀，按前缀/后缀谓词匹配；int8 优先。
fn kws_config_value(ctx: &Ctx, m: &AssetsManifest) -> Option<Value> {
    if !kws_on(ctx) {
        return None;
    }
    let def = m.kws.as_ref()?;
    let dir = kws_dir(ctx);
    let pick = |pred: &dyn Fn(&str) -> bool| -> Option<String> {
        let f = def
            .files
            .iter()
            .find(|f| pred(&f.name))
            .map(|f| dir.join(&f.name).to_string_lossy().to_string())?;
        Some(f)
    };
    // encoder / joiner 优先 int8；decoder 无 int8
    let encoder = pick(&|n| n.starts_with("encoder") && n.contains("int8"))
        .or_else(|| pick(&|n| n.starts_with("encoder")))?;
    let decoder = pick(&|n| n.starts_with("decoder"))?;
    let joiner = pick(&|n| n.starts_with("joiner") && n.contains("int8"))
        .or_else(|| pick(&|n| n.starts_with("joiner")))?;
    let tokens = pick(&|n| n == "tokens.txt")?;
    // 自定义唤醒词（用户拼音生成的词表）优先；其次内置词表
    let custom = model_dir(ctx).join("kws-keywords-custom.txt");
    let keywords = if custom.is_file() {
        custom.to_string_lossy().to_string()
    } else {
        pick(&|n| n == "keywords.txt").or_else(|| {
            // keywords 内置随应用分发（ModelScope 镜像仓库不含该文件）
            bridge_script()
                .ok()
                .and_then(|s| PathBuf::from(s).parent().map(|p| p.join("kws-keywords.txt").to_string_lossy().to_string()))
                .filter(|p| Path::new(p).is_file())
        })?
    };
    if !kws_ready(&dir, &def.files) {
        return None;
    }
    Some(json!({
        "encoder": encoder,
        "decoder": decoder,
        "joiner": joiner,
        "tokens": tokens,
        "keywords": keywords,
        "score": kws_score(ctx),
        "threshold": 0.25,
        "threads": worker_threads(),
    }))
}

/// 取当前变体定义；清单缺 variants（旧包）时回退构造 sense-voice 旧三件
fn variant_entry(ctx: &Ctx, m: &AssetsManifest) -> Result<(String, VariantDef), String> {
    let id = load_variant(ctx);
    if let Some(v) = m.variants.get(&id) {
        return Ok((id, v.clone()));
    }
    // 回退：变体缺失时若请求的是默认且旧清单结构存在，用 models.int8 + tokens + vad 拼
    if id == DEFAULT_VARIANT {
        let model = m
            .models
            .get("int8")
            .ok_or_else(|| "语音模型清单缺少 int8 模型条目".to_string())?;
        return Ok((
            id,
            VariantDef {
                label: "SenseVoice".into(),
                dir: "sense-voice".into(),
                engine: "senseVoice".into(),
                languages: vec!["auto".into(), "zh".into(), "en".into(), "yue".into(), "ja".into(), "ko".into()],
                files: vec![model.clone(), m.tokens.clone(), m.vad.clone()],
            },
        ));
    }
    Err(format!("清单中不存在识别模型：{id}"))
}

/// 当前使用 int8 精度模型（体积小、CPU 快；fp32 条目仅留档不使用）
#[allow(dead_code)]
fn model_entry(m: &AssetsManifest) -> Result<&AssetEntry, String> {
    m.models
        .get("int8")
        .ok_or_else(|| "语音模型清单缺少 int8 模型条目".to_string())
}

/// 需要就位的文件清单（当前变体全部文件）
fn required_files(ctx: &Ctx, m: &AssetsManifest) -> Result<(String, VariantDef, Vec<AssetEntry>), String> {
    let (id, v) = variant_entry(ctx, m)?;
    Ok((id, v.clone(), v.files.clone()))
}

/// 变体模型落盘子目录：数据目录下 voice/<dir>/
fn variant_dir(ctx: &Ctx, v: &VariantDef) -> PathBuf {
    model_dir(ctx).join(&v.dir)
}

/// 模型落盘目录：数据目录下 voice/
fn model_dir(ctx: &Ctx) -> PathBuf {
    ctx.data_dir.join("voice")
}

// ---------- 全局状态 ----------

/// 下载互斥：voice_prepare 幂等入口（已在下载中则直接返回当前状态）
static DL_BUSY: AtomicBool = AtomicBool::new(false);
/// 最近进度 (done, total)，下载中由后台任务持续刷新
static PROGRESS: Mutex<Option<(u64, u64)>> = Mutex::new(None);
/// 最近一次下载/准备失败原因（voice_status 的 error 字段；重新下载成功后清空）
static DL_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// 单例识别子进程：端口 + 鉴权令牌 + 进程句柄
struct WorkerHandle {
    port: u16,
    token: String,
    child: tokio::process::Child,
}

/// worker 单例注册表
static WORKER: Mutex<Option<WorkerHandle>> = Mutex::new(None);
/// 启动互斥：并发 ensure_worker 只允许一个在起进程，其余轮询等待结果
static STARTING: AtomicBool = AtomicBool::new(false);

/// 生成 64 位小写 hex 鉴权令牌（32 字节随机）
fn gen_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// worker 是否存活（顺带回收已退出的句柄）
fn worker_alive() -> bool {
    let mut g = WORKER.lock().unwrap();
    let dead = match g.as_mut() {
        Some(h) => !matches!(h.child.try_wait(), Ok(None)),
        None => return false,
    };
    if dead {
        *g = None;
        return false;
    }
    true
}

/// 主动停掉 worker（转写失败重试前调用）
fn stop_worker() {
    if let Some(mut h) = WORKER.lock().unwrap().take() {
        h.child.start_kill().ok();
    }
}

/// 从 stderr 缓冲取一段失败原因（附加到中文错误后）
fn stderr_snippet(buf: &Arc<Mutex<String>>) -> String {
    let s = buf.lock().unwrap();
    let t = s.trim();
    if t.is_empty() {
        String::new()
    } else {
        format!("：{t}")
    }
}

// ---------- voice_status ----------

/// 状态查询：模型就绪 / 下载中 / 进度 / worker 存活 / 最近错误。
/// 清单或脚本缺失不报错，折进 error 字段（状态页始终可渲染）。
pub fn status_impl(ctx: &Arc<Ctx>) -> Result<Value, String> {
    let dir = model_dir(ctx);
    let mut error = DL_ERROR.lock().unwrap().clone();
    // 当前变体 + 全变体状态（设置页下拉用）
    let (variant_id, variants_info, ready) = match bridge_script().and_then(|s| load_manifest(&s)) {
        Ok(m) => {
            let mut list = Vec::new();
            // 有序输出：按清单 variants 顺序
            let ids: Vec<String> = m.variants.keys().cloned().collect();
            let cur = load_variant(ctx);
            let mut ready = false;
            for id in &ids {
                let v = &m.variants[id];
                let vdir = model_dir(ctx).join(&v.dir);
                let vready = all_ready(&vdir, &v.files);
                if id == &cur {
                    ready = vready;
                }
                list.push(json!({
                    "id": id,
                    "label": if v.label.is_empty() { id.as_str() } else { v.label.as_str() },
                    "engine": v.engine,
                    "languages": v.languages,
                    "bytes": v.files.iter().map(|f| f.bytes).sum::<u64>(),
                    "ready": vready,
                }));
            }
            (cur, list, ready)
        }
        Err(e) => {
            if error.is_none() {
                error = Some(e);
            }
            (load_variant(ctx), Vec::new(), false)
        }
    };
    // 唤醒状态：清单含 kws 节才输出（旧清单为 null，前端隐藏唤醒卡）
    let kws_info = bridge_script()
        .ok()
        .and_then(|s| load_manifest(&s).ok())
        .and_then(|m| m.kws)
        .map(|k| {
            let kd = kws_dir(ctx);
            let words: Vec<KwsWord> =
                crate::store::get_json(&ctx.db.lock().unwrap(), "voice.kwsWords").unwrap_or_default();
            json!({
                "label": if k.label.is_empty() { "关键词唤醒".to_string() } else { k.label.clone() },
                "bytes": k.files.iter().map(|f| f.bytes).sum::<u64>(),
                "ready": kws_ready(&kd, &k.files),
                "enabled": kws_on(ctx),
                "score": kws_score(ctx),
                "words": words,
                "custom": model_dir(ctx).join("kws-keywords-custom.txt").is_file(),
            })
        });
    Ok(json!({
        "ready": ready,
        "downloading": DL_BUSY.load(Ordering::SeqCst),
        "variant": variant_id,
        "variants": variants_info,
        "model_dir": dir.to_string_lossy(),
        "progress": PROGRESS.lock().unwrap().map(|(d, t)| json!({ "done": d, "total": t })),
        "worker_running": worker_alive(),
        "worker_http": WORKER.lock().unwrap().as_ref().map(|w| json!({ "port": w.port, "token": w.token })),
        "kws": kws_info,
        "error": error,
    }))
}

// ---------- voice_select ----------

/// 选择识别模型：写配置；已就绪则直接热切换（杀旧 worker，下次转写起新模型）；
/// 未下载时返回 status（前端引导先下载）。
pub fn select_impl(ctx: &Arc<Ctx>, variant: String) -> Result<Value, String> {
    let script = bridge_script()?;
    let manifest = load_manifest(&script)?;
    if !manifest.variants.contains_key(&variant) {
        return Err(format!("未知识别模型：{variant}"));
    }
    crate::store::put_json(&ctx.db.lock().unwrap(), "voice.variant", &variant);
    // 热切换：停掉旧 worker（不同模型不能复用同一识别进程）
    if worker_alive() {
        stop_worker();
    }
    status_impl(ctx)
}

// ---------- 自定义唤醒词：用户拼音 → sherpa 音素行 ----------

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct KwsWord {
    pub word: String,
    pub pinyin: String,
}

/// 带调 Unicode 拼音字符 → (无调字母, 调号 1-4)
fn tone_fold(ch: char) -> Option<(char, u8)> {
    let (letter, tone) = match ch {
        'ā' => ('a', 1), 'á' => ('a', 2), 'ǎ' => ('a', 3), 'à' => ('a', 4),
        'ō' => ('o', 1), 'ó' => ('o', 2), 'ǒ' => ('o', 3), 'ò' => ('o', 4),
        'ē' => ('e', 1), 'é' => ('e', 2), 'ě' => ('e', 3), 'è' => ('e', 4),
        'ī' => ('i', 1), 'í' => ('i', 2), 'ǐ' => ('i', 3), 'ì' => ('i', 4),
        'ū' => ('u', 1), 'ú' => ('u', 2), 'ǔ' => ('u', 3), 'ù' => ('u', 4),
        'ǖ' => ('v', 1), 'ǘ' => ('v', 2), 'ǚ' => ('v', 3), 'ǜ' => ('v', 4),
        _ => return None,
    };
    Some((letter, tone))
}

/// 调号标到韵母主元音：a > o > e > (iu 取后者) > 末字符；0/5 轻声原样
fn tone_mark(letters: &str, tone: u8) -> Result<String, String> {
    if tone == 0 || tone == 5 {
        return Ok(letters.replace('v', "ü"));
    }
    let chars: Vec<char> = letters.chars().collect();
    let idx = chars
        .iter()
        .position(|&c| c == 'a')
        .or_else(|| chars.iter().position(|&c| c == 'o'))
        .or_else(|| chars.iter().position(|&c| c == 'e'))
        .or_else(|| chars.iter().rposition(|&c| c == 'i' || c == 'u' || c == 'v'))
        .ok_or_else(|| format!("韵母 {letters} 无法标调"))?;
    let row: &[&str] = &["āáǎà", "ōóǒò", "ēéěè", "īíǐì", "ūúǔù", "ǖǘǚǜ"];
    let k = match chars[idx] {
        'a' => 0, 'o' => 1, 'e' => 2, 'i' => 3, 'u' => 4, _ => 5,
    };
    let marked = row[k].chars().nth((tone - 1) as usize).unwrap();
    let mut out = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if i == idx {
            out.push(marked);
        } else if c == 'v' {
            out.push('ü');
        } else {
            out.push(c);
        }
    }
    Ok(out)
}

/// 单音节（如 ni3 / xīn / lve4）→ (声母, 带调韵母)
fn split_syllable(syl: &str) -> Result<(String, String), String> {
    let mut letters = String::new();
    let mut tone: u8 = 0;
    for ch in syl.chars() {
        if let Some(d) = ch.to_digit(10) {
            if !(1..=5).contains(&d) {
                return Err(format!("音节 {syl} 调号只能是 1-5"));
            }
            tone = d as u8;
        } else if let Some((l, t)) = tone_fold(ch) {
            if tone == 0 { tone = t; }
            letters.push(l);
        } else if ch.is_ascii_alphabetic() {
            letters.push(ch.to_ascii_lowercase());
        } else if ch == 'ü' {
            letters.push('v');
        } else {
            return Err(format!("音节 {syl} 含无法识别的字符 {ch}"));
        }
    }
    if letters.is_empty() {
        return Err(format!("音节 {syl} 为空"));
    }
    // 声母：双字母 zh/ch/sh 优先，再单字母集；其余归韵母
    let initials = ["zh", "ch", "sh"];
    let (initial, fin) = if initials.iter().any(|i| letters.starts_with(i)) && letters.len() > 2 {
        (letters[..2].to_string(), letters[2..].to_string())
    } else if letters.len() > 1 && "bpmfdtnlgkhjqxrywzcs".contains(letters.chars().next().unwrap()) {
        (letters[..1].to_string(), letters[1..].to_string())
    } else {
        (String::new(), letters.clone())
    };
    if fin.is_empty() {
        return Err(format!("音节 {syl} 缺韵母"));
    }
    Ok((initial, tone_mark(&fin, tone)?))
}

/// 唤醒模型 tokens.txt 的音素集合（每行「音素 id」取第一列）
fn kws_tokens_set(dir: &Path) -> Result<std::collections::HashSet<String>, String> {
    let txt = std::fs::read_to_string(dir.join("tokens.txt")).map_err(|e| format!("读唤醒模型 tokens 失败: {e}"))?;
    Ok(txt
        .lines()
        .filter_map(|l| l.split_whitespace().next().map(|s| s.to_string()))
        .collect())
}

/// 用户词表 → 自定义 keywords 文件（voice/kws-keywords-custom.txt）；空列表删除回退内置
fn write_custom_keywords(ctx: &Ctx, words: &[KwsWord]) -> Result<(), String> {
    let path = model_dir(ctx).join("kws-keywords-custom.txt");
    if words.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let tokens = kws_tokens_set(&kws_dir(ctx))?;
    let mut out = String::new();
    for w in words {
        let word = w.word.trim();
        if word.is_empty() || w.pinyin.trim().is_empty() {
            continue;
        }
        let mut phones: Vec<String> = Vec::new();
        for syl in w.pinyin.split_whitespace() {
            let (initial, fin) = split_syllable(syl)?;
            for p in [initial, fin] {
                if p.is_empty() {
                    continue;
                }
                if !tokens.contains(&p) {
                    return Err(format!("「{word}」的音素 {p} 不在唤醒模型词表，请检查拼音（如 xin1 / hǎo）"));
                }
                phones.push(p);
            }
        }
        if phones.is_empty() {
            continue;
        }
        out.push_str(&format!("{} @{word}\n", phones.join(" ")));
    }
    if out.is_empty() {
        return Err("没有有效的唤醒词条目".to_string());
    }
    std::fs::write(&path, out).map_err(|e| format!("写自定义唤醒词失败: {e}"))
}

// ---------- voice_kws_set / voice_kws_prepare ----------

/// 唤醒开关/灵敏度/自定义词表：写配置并重建 worker（argv 配置变化需重启进程生效）
pub async fn kws_set_impl(
    ctx: &Arc<Ctx>,
    enabled: bool,
    score: Option<f64>,
    keywords: Option<Vec<KwsWord>>,
) -> Result<Value, String> {
    crate::store::put_json(&ctx.db.lock().unwrap(), "voice.kwsOn", &enabled);
    if let Some(s) = score {
        if s.is_finite() {
            crate::store::put_json(&ctx.db.lock().unwrap(), "voice.kwsScore", &s.clamp(0.5, 4.0));
        }
    }
    if let Some(ws) = &keywords {
        write_custom_keywords(ctx, ws)?;
        crate::store::put_json(&ctx.db.lock().unwrap(), "voice.kwsWords", ws);
    }
    // 配置变化热切换：杀旧 worker；开启时把 worker 拉起来（新进程才带 kws 配置），
    // 前端立即可开始唤醒监听；识别模型未就绪则保持停止（报错返回给前端展示）
    stop_worker();
    if enabled {
        start_worker(ctx).await?;
    }
    status_impl(ctx)
}

/// 触发唤醒模型下载（幂等）：与识别模型共用 DL_BUSY（同时只允许一个语音模型下载）；
/// 整包下载 tar.bz2 → 逐成员解出（与 TTS 引擎同一套 extract_member）
pub async fn kws_prepare_impl(ctx: &Arc<Ctx>) -> Result<Value, String> {
    let script = bridge_script()?;
    let manifest = load_manifest(&script)?;
    let def = manifest
        .kws
        .clone()
        .ok_or_else(|| "清单没有唤醒模型（voice-bridge/assets.json 缺 kws 节）".to_string())?;
    let dir = kws_dir(ctx);
    if kws_ready(&dir, &def.files) {
        DL_ERROR.lock().unwrap().take();
        return status_impl(ctx);
    }
    if DL_BUSY.load(Ordering::SeqCst) {
        return status_impl(ctx);
    }
    DL_BUSY.store(true, Ordering::SeqCst);
    *DL_ERROR.lock().unwrap() = None;

    let c = ctx.clone();
    crate::task::spawn(async move {
        let result = kws_download_all(&c, def).await;
        if let Err(e) = result {
            *DL_ERROR.lock().unwrap() = Some(e);
        } else if kws_on(&c) {
            // 下载完重建 worker（新进程才带 kws）；识别模型未就绪则留给转写链路起
            stop_worker();
            if let Ok(m) = bridge_script().and_then(|s| load_manifest(&s)) {
                if let Ok((_i, v, entries)) = required_files(&c, &m) {
                    if all_ready(&variant_dir(&c, &v), &entries) {
                        let _ = start_worker(&c).await;
                    }
                }
            }
        }
        DL_BUSY.store(false, Ordering::SeqCst);
    });
    status_impl(ctx)
}

/// 下载唤醒模型全部文件：归档整包下到缓存 → 逐成员解出 → 删归档（全部幂等）
async fn kws_download_all(ctx: &Arc<Ctx>, def: KwsDef) -> Result<(), String> {
    let dir = kws_dir(ctx);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建唤醒模型目录失败: {e}"))?;
    let total: u64 = def
        .archive
        .as_ref()
        .map(|a| a.bytes.max(def.files.iter().map(|f| f.bytes).sum()))
        .unwrap_or_else(|| def.files.iter().map(|f| f.bytes).sum());
    let mut done: u64 = 0;
    for f in &def.files {
        if kws_file_ready(&dir, f) {
            done += f.bytes;
            continue;
        }
        if !f.inner.is_empty() {
            let arch = def
                .archive
                .as_ref()
                .ok_or_else(|| format!("清单缺少归档定义：{}", f.name))?;
            // 归档缓存：数据目录 voice/.cache（用完即删）
            let cache = ctx.data_dir.join("voice").join(".cache");
            std::fs::create_dir_all(&cache).map_err(|e| format!("创建缓存目录失败: {e}"))?;
            let arch_name = arch.url.rsplit('/').next().unwrap_or("kws.tar.bz2").to_string();
            let arch_path = cache.join(&arch_name);
            let cached = std::fs::metadata(&arch_path)
                .map(|m| arch.bytes == 0 || m.len() == arch.bytes)
                .unwrap_or(false);
            if !cached {
                let entry = AssetEntry {
                    name: arch_name,
                    url: arch.url.clone(),
                    bytes: arch.bytes,
                    sha256: arch.sha256.clone(),
                };
                download_one(ctx, &cache, &entry, done, total, "voice-progress").await?;
            }
            crate::tts::extract_member(&arch_path, &f.inner, &dir, &f.name, f.bytes, &f.sha256).await?;
            done += f.bytes;
        } else {
            let entry = AssetEntry {
                name: f.name.clone(),
                url: f.url.clone(),
                bytes: f.bytes,
                sha256: f.sha256.clone(),
            };
            download_one(ctx, &dir, &entry, done, total, "voice-progress").await?;
            done += f.bytes;
        }
        set_progress(done, total);
        ctx.emit(
            "voice-progress",
            json!({ "done": done, "total": total, "file": f.name }),
        );
    }
    // 归档用完即删
    if let Some(a) = &def.archive {
        let cache = ctx.data_dir.join("voice").join(".cache");
        let name = a.url.rsplit('/').next().unwrap_or("kws.tar.bz2");
        let _ = std::fs::remove_file(cache.join(name));
        let _ = std::fs::remove_dir(&cache);
    }
    if !kws_ready(&dir, &def.files) {
        return Err("唤醒模型下载完成但校验未通过（文件缺失或大小不符）".into());
    }
    Ok(())
}

// ---------- voice_prepare ----------

/// 触发模型下载（幂等）：已就位直接返回；已在下载中直接返回当前状态；
/// 否则开后台任务逐文件流式下载 → 校验 → 原子落位，进度走 voice-progress 事件。
pub async fn prepare_impl(ctx: &Arc<Ctx>) -> Result<Value, String> {
    let script = bridge_script()?;
    let manifest = load_manifest(&script)?;
    let (_id, variant, entries) = required_files(ctx, &manifest)?;
    let dir = variant_dir(ctx, &variant);

    if all_ready(&dir, &entries) {
        // 已就绪：清掉历史错误，幂等返回
        DL_ERROR.lock().unwrap().take();
        return status_impl(ctx);
    }
    if DL_BUSY.load(Ordering::SeqCst) {
        // 已在下载：幂等返回（不重复起任务）
        return status_impl(ctx);
    }
    DL_BUSY.store(true, Ordering::SeqCst);
    *DL_ERROR.lock().unwrap() = None;

    let c = ctx.clone();
    crate::task::spawn(async move {
        let result = download_all(&c, &dir, &entries).await;
        if let Err(e) = result {
            *DL_ERROR.lock().unwrap() = Some(e);
        }
        DL_BUSY.store(false, Ordering::SeqCst);
    });
    status_impl(ctx)
}

/// 逐文件下载（跳过已就位的），累计 done 上报整体进度
async fn download_all(ctx: &Arc<Ctx>, dir: &Path, entries: &[AssetEntry]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建模型目录失败: {e}"))?;
    let total: u64 = entries.iter().map(|e| e.bytes).sum();
    let mut done: u64 = 0;
    for e in entries {
        if crate::download::file_ready(dir, e) {
            done += e.bytes;
            continue;
        }
        download_one(ctx, dir, e, done, total, "voice-progress").await?;
        done += e.bytes;
        set_progress(done, total);
        ctx.emit(
            "voice-progress",
            json!({ "done": done, "total": total, "file": e.name }),
        );
    }
    Ok(())
}

/// 更新进度静态量（voice_status 的 progress 字段）
fn set_progress(done: u64, total: u64) {
    *PROGRESS.lock().unwrap() = Some((done, total));
}

// ---------- worker 进程管理 ----------

/// 识别进程线程数：按 CPU 数夹到 [1, 8]（默认 2）
fn worker_threads() -> u64 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u64)
        .unwrap_or(2)
        .clamp(1, 8)
}

/// worker 启动配置（argv[2] JSON）：按变体引擎给出模型路径组 + 调参默认值。
/// start_worker 与 e2e 测试共用，保证起进程的配置完全一致。
/// 路径协议（voice-worker.mjs 校验的键）：
/// - senseVoice: model / tokens / vad
/// - transducer: encoder / decoder / joiner / tokens / vad
/// - paraformer: model / tokens / vad
/// - whisper:    model / tokens（whisper 的 tokens 即 .txt 词表）/ vad
fn worker_config_json(dir: &Path, v: &VariantDef) -> Result<String, String> {
    let mut cfg = json!({
        "engine": v.engine,
        "vad": dir.join("silero_vad.onnx").to_string_lossy(),
        "threads": worker_threads(),
        "segmentSeconds": 30,
        "vadThreshold": 0.5,
        "minSpeechSeconds": 0.25,
        "minSilenceSeconds": 0.5,
        "vadOnsetPaddingSeconds": 0.3,
        "maxAudioBytes": 4 * 1024 * 1024,
    });
    let find = |suffix: &str| -> Result<String, String> {
        let f = v
            .files
            .iter()
            .find(|f| f.name == suffix)
            .ok_or_else(|| format!("变体清单缺少文件：{suffix}"))?;
        Ok(dir.join(&f.name).to_string_lossy().to_string())
    };
    // 按谓词找文件（transducer 的 encoder/decoder/joiner、whisper 的模型名都带哈希后缀）
    let find_pred = |pred: &dyn Fn(&str) -> bool| -> Result<String, String> {
        let f = v
            .files
            .iter()
            .find(|f| pred(&f.name))
            .ok_or_else(|| "变体清单缺少匹配文件".to_string())?;
        Ok(dir.join(&f.name).to_string_lossy().to_string())
    };
    let obj = cfg.as_object_mut().unwrap();
    match v.engine.as_str() {
        "transducer" => {
            obj.insert("encoder".into(), json!(find_pred(&|n| n.starts_with("encoder") && n.contains("int8"))?));
            obj.insert("decoder".into(), json!(find_pred(&|n| n.starts_with("decoder") && n.contains("int8"))?));
            obj.insert("joiner".into(), json!(find_pred(&|n| n.starts_with("joiner") && n.contains("int8"))?));
            obj.insert("tokens".into(), json!(find("tokens.txt")?));
        }
        "whisper" => {
            // encoder/decoder 分开的两个 int8 onnx（ModelScope tiny 包拆两半）
            obj.insert("encoder".into(), json!(find_pred(&|n| n.starts_with("encoder") && n.ends_with(".onnx"))?));
            obj.insert("decoder".into(), json!(find_pred(&|n| n.starts_with("decoder") && n.ends_with(".onnx"))?));
            obj.insert("tokens".into(), json!(find_pred(&|n| n.ends_with("tokens.txt"))?));
        }
        // senseVoice / paraformer 都是单 model + tokens 结构
        _ => {
            obj.insert("model".into(), json!(find_pred(&|n| n.ends_with(".onnx") && n.contains("model"))?));
            obj.insert("tokens".into(), json!(find_pred(&|n| n.ends_with(".txt") || n.ends_with(".json"))?));
        }
    }
    Ok(cfg.to_string())
}

/// transducer 编码器（int8 优先）
fn find_encoder(dir: &Path, v: &VariantDef) -> Result<String, String> {
    let f = v
        .files
        .iter()
        .find(|f| f.name.starts_with("encoder-"))
        .ok_or_else(|| "变体清单缺少 encoder 文件".to_string())?;
    Ok(dir.join(&f.name).to_string_lossy().to_string())
}

/// 确保 worker 存活：不在跑则启动（STARTING 单飞，其余调用轮询等待）
async fn ensure_worker(ctx: &Arc<Ctx>) -> Result<(), String> {
    if worker_alive() {
        return Ok(());
    }
    if STARTING.swap(true, Ordering::SeqCst) {
        // 另一个任务正在启动：轮询等它出结果（上限略大于启动超时 30s）
        for _ in 0..350 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if worker_alive() {
                return Ok(());
            }
            if !STARTING.load(Ordering::SeqCst) {
                break;
            }
        }
        if worker_alive() {
            return Ok(());
        }
        return Err("语音识别服务启动中，请稍候重试".into());
    }
    let result = start_worker(ctx).await;
    STARTING.store(false, Ordering::SeqCst);
    result
}

/// spawn worker：current_exe + ELECTRON_RUN_AS_NODE=1 执行 worker 脚本，
/// argv[2] 传配置 JSON，env DSH_SPEECH_TOKEN 传令牌；等 stdout {"port":N} 就绪。
/// 就绪前失败（30s 超时 / 进程退出）带 stderr 片段报中文错误。
async fn start_worker(ctx: &Arc<Ctx>) -> Result<(), String> {
    if worker_alive() {
        return Ok(());
    }
    let script = bridge_script()?;
    let manifest = load_manifest(&script)?;
    let (_id, variant, entries) = required_files(ctx, &manifest)?;
    let dir = variant_dir(ctx, &variant);
    if !all_ready(&dir, &entries) {
        return Err("语音模型尚未就绪，请先下载模型".into());
    }
    // worker 脚本（argv[2]）的配置：按变体引擎生成路径组 + 调参默认值；唤醒开启时注入 kws 节
    let mut cfg_val: Value = serde_json::from_str(&worker_config_json(&dir, &variant)?)
        .map_err(|e| format!("生成 worker 配置失败: {e}"))?;
    if let Some(k) = kws_config_value(ctx, &manifest) {
        cfg_val["kws"] = k;
    }
    let cfg = cfg_val.to_string();

    let exe = std::env::current_exe().map_err(|e| format!("无法定位可执行文件: {e}"))?;
    let token = gen_token();
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.arg(&script).arg(cfg);
    // Electron 主程序配此变量即以纯 Node 运行（免依赖用户机器上的 Node）
    cmd.env("ELECTRON_RUN_AS_NODE", "1");
    cmd.env("DSH_SPEECH_TOKEN", &token);
    apply_native_lib_paths(&mut cmd, &script);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    crate::registry::no_window_tokio(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动语音识别进程失败: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "读取识别进程输出失败".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "读取识别进程错误输出失败".to_string())?;

    // stderr 持续排空进缓冲（就绪失败时取末尾做错误信息；排空防管道写满阻塞子进程）
    let err_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    {
        let eb = err_buf.clone();
        crate::task::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut g = eb.lock().unwrap();
                if g.len() < 4096 {
                    g.push_str(&line);
                    g.push('\n');
                }
            }
        });
    }

    // 读就绪行：30 秒超时，进程提前退出（stdout 关闭）也算失败
    use tokio::io::AsyncBufReadExt;
    let mut child = child;
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            child.start_kill().ok();
            return Err(format!(
                "语音识别服务启动超时（30 秒）{}",
                stderr_snippet(&err_buf)
            ));
        }
        let line = tokio::select! {
            r = lines.next_line() => r,
            _ = tokio::time::sleep(remaining) => {
                child.start_kill().ok();
                return Err(format!(
                    "语音识别服务启动超时（30 秒）{}",
                    stderr_snippet(&err_buf)
                ));
            }
        };
        match line {
            Ok(Some(text)) => {
                // stdout 唯一协议输出：{"port":N}；其余行忽略
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if let Some(port) = v.get("port").and_then(|p| p.as_u64()) {
                        *WORKER.lock().unwrap() = Some(WorkerHandle {
                            port: port as u16,
                            token,
                            child,
                        });
                        return Ok(());
                    }
                }
            }
            Ok(None) => {
                // 管道关闭 = 进程退出
                child.start_kill().ok();
                return Err(format!(
                    "语音识别进程启动失败{}",
                    stderr_snippet(&err_buf)
                ));
            }
            Err(e) => {
                child.start_kill().ok();
                return Err(format!("读取识别进程输出失败: {e}"));
            }
        }
    }
}

// ---------- voice_transcribe ----------

/// 语言白名单（与 SenseVoice 一致）；空/缺省按 auto
fn normalize_language(l: Option<String>) -> Result<String, String> {
    let l = l.map(|s| s.trim().to_lowercase()).unwrap_or_default();
    if l.is_empty() || l == "auto" {
        return Ok("auto".into());
    }
    if ["zh", "en", "yue", "ja", "ko"].contains(&l.as_str()) {
        Ok(l)
    } else {
        Err(format!("不支持的语言：{l}（可选 auto/zh/en/yue/ja/ko）"))
    }
}

/// 转写主入口：确保 worker 在跑 → POST /transcribe；
/// 起不来或转写失败自动重启 worker 再重试一次。
pub async fn transcribe_impl(
    ctx: &Arc<Ctx>,
    wav_base64: String,
    language: Option<String>,
) -> Result<Value, String> {
    let language = normalize_language(language)?;
    use base64::Engine as _;
    let wav = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.trim())
        .map_err(|e| format!("音频数据解码失败: {e}"))?;
    if wav.is_empty() {
        return Err("音频数据为空".into());
    }
    // 模型未就绪先报错，不白起进程
    {
        let script = bridge_script()?;
        let manifest = load_manifest(&script)?;
        let (_id, variant, entries) = required_files(ctx, &manifest)?;
        let dir = variant_dir(ctx, &variant);
        if !all_ready(&dir, &entries) {
            return Err("语音模型尚未就绪，请先下载模型".into());
        }
    }

    let mut last_err = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            // 第一次失败：杀掉旧 worker，重启后再试一次
            stop_worker();
        }
        match ensure_worker(ctx).await {
            Ok(()) => match post_transcribe(&wav, &language).await {
                Ok(v) => return Ok(v),
                Err(e) => last_err = e,
            },
            Err(e) => last_err = e,
        }
    }
    Err(format!("语音识别失败：{last_err}"))
}

/// POST 到 worker /transcribe（Bearer 鉴权），返回 {text, audioSeconds, inferenceSeconds}
async fn post_transcribe(wav: &[u8], language: &str) -> Result<Value, String> {
    let (port, token) = {
        let g = WORKER.lock().unwrap();
        let h = g.as_ref().ok_or_else(|| "识别服务未运行".to_string())?;
        (h.port, h.token.clone())
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        // 单次识别推理 + VAD 上限 120s，客户端再留些余量
        .timeout(std::time::Duration::from_secs(150))
        .build()
        .map_err(|e| format!("构建请求客户端失败: {e}"))?;
    let resp = client
        .post(format!("http://127.0.0.1:{port}/transcribe?language={language}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/octet-stream")
        .body(wav.to_vec())
        .send()
        .await
        .map_err(|e| format!("与识别服务通信失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取识别结果失败: {e}"))?;
    if !status.is_success() {
        // worker 的英文内部错误统一折进中文表述
        let msg = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|x| x.as_str()).map(String::from))
            .unwrap_or(body);
        return Err(format!("识别服务返回错误（HTTP {}）：{msg}", status.as_u16()));
    }
    serde_json::from_str::<Value>(&body).map_err(|e| format!("识别结果解析失败: {e}"))
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "bit-voice-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn entry(name: &str, bytes: u64) -> AssetEntry {
        AssetEntry {
            name: name.to_string(),
            url: "https://example.invalid/x".to_string(),
            bytes,
            sha256: "00".to_string(),
        }
    }

    /// ready 判定：三个文件都存在且字节数与清单完全一致才算就绪
    #[test]
    fn readiness_requires_exact_sizes() {
        let dir = tmp_dir("ready");
        std::fs::create_dir_all(&dir).unwrap();
        let entries = vec![
            entry("model.int8.onnx", 10),
            entry("tokens.txt", 5),
            entry("silero_vad.onnx", 3),
        ];
        // 空目录 → 未就绪
        assert!(!all_ready(&dir, &entries));
        // 字节数不符 → 仍未就绪
        std::fs::write(dir.join("model.int8.onnx"), vec![0u8; 9]).unwrap();
        assert!(!all_ready(&dir, &entries));
        // 三个都精确就位 → 就绪
        std::fs::write(dir.join("model.int8.onnx"), vec![0u8; 10]).unwrap();
        std::fs::write(dir.join("tokens.txt"), vec![0u8; 5]).unwrap();
        std::fs::write(dir.join("silero_vad.onnx"), vec![0u8; 3]).unwrap();
        assert!(all_ready(&dir, &entries));
        // 缺任何一个 → 回到未就绪
        std::fs::remove_file(dir.join("tokens.txt")).unwrap();
        assert!(!all_ready(&dir, &entries));
        // 空清单不误报就绪
        assert!(!all_ready(&dir, &[]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 鉴权令牌：64 位小写 hex，且两次生成不重复
    #[test]
    fn token_is_64_hex() {
        let t = gen_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        assert_ne!(gen_token(), gen_token());
    }

    /// 语言白名单：缺省/auto 归一，非法语言给中文错误
    #[test]
    fn language_normalization() {
        assert_eq!(normalize_language(None).unwrap(), "auto");
        assert_eq!(normalize_language(Some(" zh ".into())).unwrap(), "zh");
        assert_eq!(normalize_language(Some("YUE".into())).unwrap(), "yue");
        assert!(normalize_language(Some("fr".into())).is_err());
        assert!(normalize_language(Some("繁体中文".into())).is_err());
    }

    /// 下载源候选：huggingface 主源附带 hf-mirror 回退；其他主机不改写
    #[test]
    fn mirror_candidate_urls() {
        let v = crate::download::candidate_urls("https://huggingface.co/a/b/resolve/x/m.bin");
        assert_eq!(v.len(), 2);
        assert_eq!(v[1], "https://hf-mirror.com/a/b/resolve/x/m.bin");
        let v = crate::download::candidate_urls("https://example.com/m.bin");
        assert_eq!(v, vec!["https://example.com/m.bin".to_string()]);
    }

    /// 起一个支持 HEAD + Range 的极简 HTTP 服务（mode 0：声明全长但只发一半再断；
    /// mode 1：正常发完），用于离线验证断点续传与"网络错误保留 .part"。
    fn spawn_range_server(body: Vec<u8>, mode: Arc<std::sync::atomic::AtomicUsize>) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut sock) = conn else { break };
                let (body, mode) = (body.clone(), mode.clone());
                std::thread::spawn(move || {
                    // 读到请求头结束
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    loop {
                        match sock.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                head.extend_from_slice(&buf[..n]);
                                if head.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                            Err(_) => return,
                        }
                    }
                    let head = String::from_utf8_lossy(&head).to_string();
                    let is_head = head.starts_with("HEAD");
                    let mut start = 0usize;
                    if let Some(line) = head
                        .split("\r\n")
                        .find(|l| l.to_ascii_lowercase().starts_with("range: bytes="))
                    {
                        let spec = line.split('=').nth(1).unwrap_or("0-");
                        start = spec
                            .split('-')
                            .next()
                            .unwrap_or("0")
                            .trim()
                            .parse()
                            .unwrap_or(0);
                    }
                    if start > body.len() {
                        let _ = sock.write_all(
                            b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\n\r\n",
                        );
                        return;
                    }
                    let status = if start > 0 { "206 Partial Content" } else { "200 OK" };
                    let content_range = if start > 0 {
                        format!(
                            "Content-Range: bytes {}-{}/{}\r\n",
                            start,
                            body.len() - 1,
                            body.len()
                        )
                    } else {
                        String::new()
                    };
                    let mut payload = body[start..].to_vec();
                    // 模式 0 且没有断点续传请求时：假装发全量却半路断，制造"下载中断"
                    if mode.load(Ordering::SeqCst) == 0 && start == 0 && payload.len() > 16 * 1024
                    {
                        payload.truncate(payload.len() / 2);
                    }
                    let header = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\n\
                         {content_range}Content-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len() - start
                    );
                    let _ = sock.write_all(header.as_bytes());
                    if !is_head {
                        let _ = sock.write_all(&payload);
                    }
                    let _ = sock.flush();
                });
            }
        });
        port
    }

    /// 断点续传离线验证：第一轮服务端半路断（.part 保留部分数据），
    /// 第二轮从断点续完，最终文件字节与 SHA-256 都对，.part 消失。
    #[tokio::test]
    async fn resume_download_completes_partial() {
        use sha2::Digest;
        use std::sync::atomic::AtomicUsize;

        let data: Vec<u8> = (0..120 * 1024).map(|i: usize| (i % 251) as u8).collect();
        let mut h = sha2::Sha256::new();
        h.update(&data);
        let sha = h
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();

        let mode = Arc::new(AtomicUsize::new(0));
        let port = spawn_range_server(data.clone(), mode.clone());

        let dir = std::env::temp_dir().join(format!("bit-voice-resume-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: dir.clone(),
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        });
        let entry = AssetEntry {
            name: "x.bin".into(),
            url: format!("http://127.0.0.1:{port}/x.bin"),
            bytes: data.len() as u64,
            sha256: sha.clone(),
        };

        // 第一轮：服务端半路断 → 下载失败，但残件必须留下
        let err = download_one(&ctx, &dir, &entry, 0, entry.bytes, "voice-progress")
            .await
            .expect_err("半路断开应报错");
        assert!(err.contains("不完整") || err.contains("中断"), "实际错误: {err}");
        let part = dir.join("x.bin.part");
        let have = std::fs::metadata(&part).expect("网络错误必须保留断点").len();
        assert!(have > 0 && have < entry.bytes, "断点应为部分数据: {have}");

        // 第二轮：服务端恢复正常 → 从断点续传到完整并校验落位
        mode.store(1, Ordering::SeqCst);
        download_one(&ctx, &dir, &entry, 0, entry.bytes, "voice-progress")
            .await
            .expect("续传应成功");
        let final_bytes = std::fs::read(dir.join("x.bin")).unwrap();
        assert_eq!(final_bytes.len(), data.len(), "落位长度不对");
        assert_eq!(final_bytes, data, "落位内容与源数据不一致");
        assert!(!part.exists(), "落位后 .part 应已改名");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 桥脚本定位含源码树回退：cargo test 下也能找到（仓库内文件存在即通过）
    #[test]
    fn bridge_script_fallback_exists() {
        let script = bridge_script().expect("cargo test 下应能经源码树回退找到脚本");
        assert!(script.ends_with("voice-bridge/voice-worker.mjs"));
        assert!(script.with_file_name("assets.json").is_file());
    }

    /// 原生包名的 Node 口径转换（与 sherpa-onnx-node/addon.js 的查找路径一致）
    #[test]
    fn sherpa_pkg_stem_uses_node_naming() {
        assert_eq!(sherpa_pkg_stem("macos", "aarch64"), "sherpa-onnx-darwin-arm64");
        assert_eq!(sherpa_pkg_stem("macos", "x86_64"), "sherpa-onnx-darwin-x64");
        assert_eq!(sherpa_pkg_stem("linux", "x86_64"), "sherpa-onnx-linux-x64");
        assert_eq!(sherpa_pkg_stem("linux", "aarch64"), "sherpa-onnx-linux-arm64");
        assert_eq!(sherpa_pkg_stem("windows", "x86_64"), "sherpa-onnx-win-x64");
        assert_eq!(sherpa_pkg_stem("windows", "x86"), "sherpa-onnx-win-ia32");
    }

    /// 原生包目录定位：只认实际存在的目标架构目录（缺架构时返回 None，
    /// worker 仍能起，只是靠 .node 自身 rpath，不设额外环境变量）
    #[test]
    fn sherpa_native_dir_requires_actual_package() {
        let root = std::env::temp_dir().join(format!("bit-voice-native-{}", std::process::id()));
        let nm = root.join("node_modules").join(sherpa_pkg_stem(
            std::env::consts::OS,
            std::env::consts::ARCH,
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&nm).unwrap();
        let script = root.join("voice-worker.mjs");
        std::fs::write(&script, "").unwrap();

        let found = sherpa_native_dir(&script).expect("已就位的目标架构包应被定位");
        assert_eq!(found, nm);

        std::fs::remove_dir_all(&nm).unwrap();
        assert!(sherpa_native_dir(&script).is_none(), "缺包时不应给出路径");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- 端到端（需网络 + macOS say，手动触发） ----------

    /// 把任意 WAV 的 data 段重排成与前端 encodeWav16k 完全一致的 44 字节规范头。
    /// afconvert 输出可能带附加块，而 worker 的 validateWave 严格要求规范布局。
    fn to_canonical_wav(raw: &[u8]) -> Vec<u8> {
        assert!(raw.len() > 44, "WAV 过短");
        assert_eq!(&raw[0..4], b"RIFF");
        assert_eq!(&raw[8..12], b"WAVE");
        // 顺序扫描块找 data（fmt 必须是 PCM/单声道/16k，与 worker 校验一致）
        let mut off = 12usize;
        let mut fmt = None;
        let mut data = None;
        while off + 8 <= raw.len() {
            let id = &raw[off..off + 4];
            let len = u32::from_le_bytes(raw[off + 4..off + 8].try_into().unwrap()) as usize;
            let body = off + 8;
            if body + len > raw.len() {
                break;
            }
            if id == b"fmt " {
                fmt = Some(&raw[body..body + len]);
            } else if id == b"data" {
                data = Some(&raw[body..body + len]);
                break;
            }
            off = body + len + (len & 1); // 块按偶数字节对齐
        }
        let fmt = fmt.expect("缺 fmt 块");
        let data = data.expect("缺 data 块");
        assert_eq!(u16::from_le_bytes(fmt[0..2].try_into().unwrap()), 1, "非 PCM");
        assert_eq!(u16::from_le_bytes(fmt[2..4].try_into().unwrap()), 1, "非单声道");
        assert_eq!(u32::from_le_bytes(fmt[4..8].try_into().unwrap()), 16000, "非 16kHz");
        assert_eq!(u16::from_le_bytes(fmt[14..16].try_into().unwrap()), 16, "非 16bit");
        let n = data.len();
        let mut out = Vec::with_capacity(44 + n);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&((36 + n) as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&1u16.to_le_bytes()); // 单声道
        out.extend_from_slice(&16000u32.to_le_bytes());
        out.extend_from_slice(&32000u32.to_le_bytes()); // 字节率
        out.extend_from_slice(&2u16.to_le_bytes()); // 块对齐
        out.extend_from_slice(&16u16.to_le_bytes()); // 位深
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(n as u32).to_le_bytes());
        out.extend_from_slice(data);
        out
    }

    /// 真实端到端：voice_prepare 下载模型（SHA 校验）→ status 就绪 →
    /// say 合成中文语音 → 起 worker（与 start_worker 同款 argv/env 协议，测试进程
    /// 非 Electron 故用 node 启动）→ voice_transcribe 返回文本与源句比对。
    ///
    /// 触发：cargo test -p bit-core --lib voice::tests::e2e -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "需下载约 241MB 模型 + macOS say，手动触发"]
    async fn e2e_download_and_transcribe() {
        // 固定目录：模型只下一次，重复跑 e2e 直接复用
        let data_dir = std::env::temp_dir().join("bit-voice-e2e");
        let ctx = crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: data_dir.clone(),
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "e2e".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        });
        stop_worker();

        // 1) 触发下载并轮询就绪（下载失败会经 DL_ERROR 暴露）
        prepare_impl(&ctx).await.expect("触发模型下载失败");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25 * 60);
        loop {
            let st = status_impl(&ctx).unwrap();
            if st["ready"].as_bool() == Some(true) {
                println!("模型已就绪：{}", st["model_dir"]);
                break;
            }
            if st["downloading"].as_bool() != Some(true) {
                if let Some(err) = st["error"].as_str() {
                    if !err.is_empty() {
                        panic!("模型下载失败：{err}");
                    }
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "模型下载超时（25 分钟）"
            );
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }

        // 2) say 合成中文测试句 → 转 16k 单声道 PCM16 → 规范化 WAV
        let work = data_dir.join("e2e-audio");
        std::fs::create_dir_all(&work).unwrap();
        let aiff = work.join("src.aiff");
        let wav_raw = work.join("raw.wav");
        let sentence = "今天天气真不错";
        let say_ok = std::process::Command::new("say")
            .args(["-v", "Tingting", "-o"])
            .arg(&aiff)
            .arg(sentence)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(say_ok, "say 合成语音失败");
        let cvt_ok = std::process::Command::new("afconvert")
            .args(["-f", "WAVE", "-d", "LEI16@16000", "-c", "1"])
            .arg(&aiff)
            .arg(&wav_raw)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(cvt_ok, "afconvert 转码失败");
        let wav = to_canonical_wav(&std::fs::read(&wav_raw).unwrap());
        println!("测试音频 {} 字节（规范 44 字节头）", wav.len());

        // 3) 起 worker：argv/env 协议与 start_worker 完全一致（共用 worker_config_json），
        //    区别仅在可执行文件——测试进程 current_exe 是测试二进制，故用 node。
        let script = bridge_script().expect("找不到 worker 脚本");
        let manifest = load_manifest(&script).expect("清单读取失败");
        let (_vid, variant, _entries) = required_files(&ctx, &manifest).expect("变体解析失败");
        let cfg = worker_config_json(&variant_dir(&ctx, &variant), &variant).expect("配置构造失败");
        let token = gen_token();
        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(&script)
            .arg(cfg)
            .env("DSH_SPEECH_TOKEN", &token)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        apply_native_lib_paths(&mut cmd, &script);
        let mut child = cmd.spawn().expect("node 启动 worker 失败");
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        // stderr 排空防阻塞，失败时打印
        let err_task = crate::task::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            let mut all = String::new();
            while let Ok(Some(l)) = lines.next_line().await {
                println!("[worker stderr] {l}");
                all.push_str(&l);
                all.push('\n');
            }
            all
        });
        let port = {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            let ready = tokio::time::timeout(std::time::Duration::from_secs(120), async {
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        if let Some(p) = v.get("port").and_then(|x| x.as_u64()) {
                            return Some(p as u16);
                        }
                    }
                }
                None
            })
            .await
            .expect("worker 启动超时（120 秒，模型加载慢）");
            ready.expect("worker 未就绪（无就绪行）")
        };
        println!("worker 就绪 port={port}");
        *WORKER.lock().unwrap() = Some(WorkerHandle { port, token, child });

        // 4) 走真实 voice_transcribe（模型就绪检查 → HTTP Bearer → 结果解析）
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&wav);
        let r = transcribe_impl(&ctx, b64, Some("zh".into()))
            .await
            .expect("voice_transcribe 失败");
        let text = r["text"].as_str().unwrap_or("").to_string();
        println!(
            "识别结果：{text}（音频 {}s，推理 {}s）",
            r["audioSeconds"], r["inferenceSeconds"]
        );
        stop_worker();
        let _ = err_task.await;

        // 5) 断言：非空且与源句核心词吻合
        assert!(!text.trim().is_empty(), "识别结果为空");
        assert!(
            text.contains("天气") || text.contains("今天") || text.contains("真不错"),
            "识别文本与源句不符：{text}"
        );
    }
}
