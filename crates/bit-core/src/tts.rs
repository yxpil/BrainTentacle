// yxpil · BIT core
//! TTS 语音合成后端：本地 sherpa-onnx 预编译 CLI（8 个引擎）+ 在线四家（edge/gtts/siliconflow/openai）。
//!
//! 结构（对齐 voice.rs 的既有模式）：
//! - 配置存 bit.db 文档 "tts"（敏感：含 API key，双层加密入库）：
//!   `{engine, voice, speed, pitch, volume, extra:{...}, keys:{siliconflow, openai}}`
//! - 模型清单 voice-bridge/assets.json 的 `tts.engines` 分区：每引擎的文件
//!   （name/url/bytes/sha256，`inner` 表示从 tar.bz2 归档里取出的成员）+ CLI 参数模板
//!   + `tunables`（前端可调项白名单：range/select/text）
//! - `tts_prepare`：后台下载该引擎全部文件（模型 → 词表 → vocoder），复用 download.rs
//!   的 Range 断点续传 / HEAD 探活 / SHA-256 / 原子落位；进度走 "tts-progress" 事件
//! - `tts_speak`：本地引擎 spawn sherpa-onnx-offline-tts CLI（参数按清单白名单拼装，
//!   不允许透传任意 flag）；在线引擎 spawn tts-worker.mjs（current_exe +
//!   ELECTRON_RUN_AS_NODE=1）+ POST /synthesize（Bearer）
//!
//! 三个能力经 commands_api 暴露：tts_status / tts_prepare / tts_speak。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::download::{download_one, AssetEntry};
use crate::state::Ctx;

// ---------- 引擎清单 ----------

/// 在线引擎（无本地下载，走 tts-worker HTTP）
const ONLINE_ENGINES: &[&str] = &["edge", "gtts", "siliconflow", "openai"];
/// 本地引擎固定顺序（与 assets.json 的 tts.engines 键一致）
const LOCAL_ENGINES: &[&str] = &[
    "supertonic",
    "kitten",
    "matcha",
    "zipvoice",
    "pocket",
    "kokoro",
    "piper-zh",
    "piper-en",
];

/// 默认引擎：EdgeTTS（免 key，开箱可用）
fn default_engine() -> String {
    "edge".into()
}

/// 各在线引擎的默认音色（voice 留空时兜底）
fn default_voice(engine: &str) -> &'static str {
    match engine {
        "edge" => "zh-CN-XiaoxiaoNeural",
        "siliconflow" => "FunAudioLLM/CosyVoice2-0.5B:alex",
        "openai" => "alloy",
        _ => "",
    }
}

fn default_one() -> f64 {
    1.0
}

// ---------- 配置（bit.db "tts"） ----------

/// 在线引擎 API key（仅存本机 bit.db，不上传）
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct TtsKeys {
    #[serde(default)]
    pub siliconflow: String,
    #[serde(default)]
    pub openai: String,
}

/// TTS 设置：引擎 / 音色 / 语速 / 音调 / 音量 / 引擎专属可调项 / key
#[derive(Clone, Serialize, Deserialize)]
pub struct TtsSettings {
    #[serde(default = "default_engine")]
    pub engine: String,
    #[serde(default)]
    pub voice: String,
    #[serde(default = "default_one")]
    pub speed: f64,
    #[serde(default)]
    pub pitch: f64,
    #[serde(default = "default_one")]
    pub volume: f64,
    #[serde(default)]
    pub extra: HashMap<String, Value>,
    #[serde(default)]
    pub keys: TtsKeys,
}

impl Default for TtsSettings {
    fn default() -> Self {
        Self {
            engine: default_engine(),
            voice: String::new(),
            speed: 1.0,
            pitch: 0.0,
            volume: 1.0,
            extra: HashMap::new(),
            keys: TtsKeys::default(),
        }
    }
}

/// 读配置（bit.db 文档 "tts"，缺失/损坏回退默认值）
fn load_settings(ctx: &Arc<Ctx>) -> TtsSettings {
    ctx.db_get_secret::<TtsSettings>("tts").unwrap_or_default()
}

/// 写配置（设备密钥双层加密）
fn save_settings(ctx: &Arc<Ctx>, s: &TtsSettings) {
    ctx.db_put_secret("tts", s);
}

/// 把前端传入的局部设置合并进配置（只认白名单字段；key 只在显式传入时覆盖）
fn apply_patch(s: &mut TtsSettings, patch: &Value) -> bool {
    let Some(obj) = patch.as_object() else {
        return false;
    };
    let mut changed = false;
    if let Some(v) = obj.get("engine").and_then(|x| x.as_str()) {
        if !v.trim().is_empty() && s.engine != v {
            s.engine = v.trim().to_string();
            changed = true;
        }
    }
    if let Some(v) = obj.get("voice").and_then(|x| x.as_str()) {
        if s.voice != v {
            s.voice = v.to_string();
            changed = true;
        }
    }
    for (key, field) in [("speed", 0usize), ("pitch", 1usize), ("volume", 2usize)] {
        if let Some(v) = obj.get(key).and_then(|x| x.as_f64()) {
            let nv = match field {
                0 => v.clamp(0.25, 4.0),
                1 => v.clamp(-50.0, 50.0),
                _ => v.clamp(0.0, 1.0),
            };
            let cur = match field {
                0 => s.speed,
                1 => s.pitch,
                _ => s.volume,
            };
            if (cur - nv).abs() > f64::EPSILON {
                match field {
                    0 => s.speed = nv,
                    1 => s.pitch = nv,
                    _ => s.volume = nv,
                }
                changed = true;
            }
        }
    }
    if let Some(ex) = obj.get("extra").and_then(|x| x.as_object()) {
        for (k, v) in ex {
            if s.extra.get(k) != Some(v) {
                s.extra.insert(k.clone(), v.clone());
                changed = true;
            }
        }
    }
    if let Some(keys) = obj.get("keys").and_then(|x| x.as_object()) {
        if let Some(v) = keys.get("siliconflow").and_then(|x| x.as_str()) {
            if s.keys.siliconflow != v {
                s.keys.siliconflow = v.trim().to_string();
                changed = true;
            }
        }
        if let Some(v) = keys.get("openai").and_then(|x| x.as_str()) {
            if s.keys.openai != v {
                s.keys.openai = v.trim().to_string();
                changed = true;
            }
        }
    }
    changed
}

// ---------- 清单（voice-bridge/assets.json 的 tts 分区） ----------

/// tar.bz2 归档（多文件模型共用同一包）
#[derive(Clone, Deserialize)]
struct ArchiveDef {
    url: String,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    sha256: String,
}

/// 引擎需要的一个文件；`inner` 非空表示从 archive 里解出该成员
#[derive(Clone, Deserialize)]
struct TtsFile {
    name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    inner: String,
}

/// CLI 固定参数：单文件 / 多文件（join 分隔）/ 固定字符串值
#[derive(Clone, Deserialize)]
struct TtsArg {
    flag: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    join: String,
    #[serde(default)]
    value: String,
}

/// 单个本地引擎定义
#[derive(Clone, Deserialize)]
struct EngineDef {
    #[serde(default)]
    label: String,
    #[serde(default)]
    languages: Vec<String>,
    #[serde(default)]
    note: String,
    #[serde(default)]
    archive: Option<ArchiveDef>,
    #[serde(default)]
    files: Vec<TtsFile>,
    #[serde(default)]
    args: Vec<TtsArg>,
    /// 语速对应的 CLI flag（不同模型 --speed / --matcha-length-scale / ...）
    #[serde(default)]
    speed_flag: String,
    /// 前端可调项模板（白名单，逐引擎）
    #[serde(default)]
    tunables: Vec<Value>,
}

#[derive(Deserialize)]
struct TtsSection {
    #[serde(default)]
    engines: HashMap<String, EngineDef>,
}

/// 合成内核（sherpa-onnx CLI）的一个候选发行包。
/// `kind`：`archive` = tar.bz2（内含 bin/ 可执行 + lib/ 依赖库），
/// `exe` = 单个自包含可执行文件直接落位（官方为 Windows 单独打包的 TTS CLI）。
#[derive(Clone, Deserialize)]
struct CliPkgDef {
    #[serde(default)]
    kind: String,
    url: String,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    sha256: String,
    /// 人工标注（体积/依赖说明），前端 tooltip 用
    #[serde(default)]
    note: String,
}

/// assets.json 顶层 `tts_bin` 分区：按 `std::env::consts` 的 "os-arch" 给候选包列表，
/// 逐个尝试（装完能在目录里找到 CLI 才算成功），避免单一包的内部结构假设失效
#[derive(Clone, Deserialize)]
struct CliSection {
    #[serde(default)]
    version: String,
    #[serde(default)]
    platforms: HashMap<String, Vec<CliPkgDef>>,
}

#[derive(Deserialize)]
struct TtsManifest {
    #[serde(default)]
    tts: Option<TtsSection>,
    #[serde(default)]
    tts_bin: Option<CliSection>,
}

/// 三段路径探测（仿 voice.rs find_worker_script）：
/// a) 主程序目录向上找 Resources / resources/app.asar.unpacked（打包后布局）
/// b) 进程 cwd 及其祖先（开发态仓库根）
/// c) 源码树回退 CARGO_MANIFEST_DIR/../../（cargo run / cargo test）
fn find_in_bridge(rel: &str) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for anc in dir.ancestors() {
                cands.push(anc.join("Resources").join(rel));
                cands.push(anc.join("resources/app.asar.unpacked").join(rel));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for anc in cwd.ancestors() {
            cands.push(anc.join(rel));
        }
    }
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join(rel),
    );
    cands.into_iter().find(|p| p.is_file())
}

/// 清单路径（voice-bridge/assets.json）
fn manifest_path() -> Result<PathBuf, String> {
    find_in_bridge("voice-bridge/assets.json")
        .ok_or_else(|| "找不到语音模型清单（voice-bridge/assets.json）".to_string())
}

/// 读取并解析清单的 tts 分区
fn load_manifest() -> Result<HashMap<String, EngineDef>, String> {
    manifest_doc()?
        .tts
        .ok_or_else(|| "语音合成清单缺少 tts 分区".to_string())
        .map(|s| s.engines)
}

/// 清单全文（引擎分区 + 内核分区一次读盘）
fn manifest_doc() -> Result<TtsManifest, String> {
    let p = manifest_path()?;
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("读取语音合成清单失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("语音合成清单损坏: {e}"))
}

/// 在线桥脚本（tts-worker.mjs）
fn worker_script() -> Result<PathBuf, String> {
    find_in_bridge("voice-bridge/tts-worker.mjs")
        .ok_or_else(|| "找不到语音合成桥脚本（voice-bridge/tts-worker.mjs）".to_string())
}

/// 本机在内核清单里的键：与 `std::env::consts` 对齐（macos-aarch64 / windows-x86_64 / …）
fn platform_key() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// 内核可执行文件名（Windows 带 .exe）
fn cli_exe_name() -> &'static str {
    if cfg!(windows) {
        "sherpa-onnx-offline-tts.exe"
    } else {
        "sherpa-onnx-offline-tts"
    }
}

/// 合成内核安装根目录：数据目录下 tts/cli/<platform>/
/// 按平台分目录，便于同一数据目录被多架构复用（如 Rosetta / 移动机器）
fn cli_root(ctx: &Ctx) -> PathBuf {
    ctx.data_dir.join("tts").join("cli").join(platform_key())
}

/// 在已解包的内核目录里找 CLI 可执行文件：归档带一层包名目录
/// （`<pkg>/bin/xxx`），故递归找而不是写死路径。
/// 同一 bin 目录里全是兄弟程序（`-play` / `-microphone` / `-websocket-server`…），
/// 它们参数不同（`-play` 要抢音频设备），所以只认精确名或「名-版本号」，
/// 绝不能按前缀匹配——实测 osx-arm64 归档里 read_dir 先给出 -play 就会装错内核。
fn find_cli_exe(root: &Path) -> Option<PathBuf> {
    fn hit(name: &str) -> bool {
        let want = cli_exe_name();
        if name == want {
            return true;
        }
        // 兜底：容忍 sherpa-onnx-offline-tts-1.13.8 这类「名字后面直接跟版本号」的改名。
        // Windows 上版本号插在扩展名之前（…-1.13.8.exe），所以先拆掉扩展名再比。
        let (stem, ext) = match want.rsplit_once('.') {
            Some((s, e)) => (s, format!(".{e}")),
            None => (want, String::new()),
        };
        let rest = match name.strip_prefix(stem).and_then(|r| r.strip_prefix('-')) {
            Some(r) => r,
            None => return false,
        };
        let rest = match rest.strip_suffix(ext.as_str()) {
            Some(r) => r,
            None => return false,
        };
        rest.chars().next().map_or(false, |c| c.is_ascii_digit())
    }
    fn walk(dir: &Path, depth: u32) -> Option<PathBuf> {
        if depth > 3 {
            return None;
        }
        let entries = std::fs::read_dir(dir).ok()?;
        let mut subdirs = Vec::new();
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name();
            let name = name.to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if p.is_file() && hit(&name) {
                return Some(p);
            }
            if p.is_dir() {
                subdirs.push(p);
            }
        }
        subdirs.into_iter().find_map(|d| walk(&d, depth + 1))
    }
    walk(root, 0)
}

/// 本平台的内核候选包（清单未收录该架构时返回空列表，如 linux-riscv64）
fn cli_pkg_list() -> (String, Vec<CliPkgDef>) {
    let key = platform_key();
    match manifest_doc().ok().and_then(|m| m.tts_bin) {
        Some(s) => {
            let list = s.platforms.get(&key).cloned().unwrap_or_default();
            (s.version, list)
        }
        None => (String::new(), Vec::new()),
    }
}

/// 内核包总体积（用于进度分母；取首个候选，各候选体积接近）
fn cli_pkg_bytes() -> u64 {
    cli_pkg_list()
        .1
        .first()
        .map(|p| p.bytes)
        .unwrap_or(0)
}

/// 内核版本戳：目录里的内核对不上当前清单版本时当没装。
/// 0.7.1 的 Windows 就踩过这个坑——误装的 GUI exe 一直在目录里，
/// 不校验版本就永远「已就位」，换了正确包也不会重下。
fn cli_stamp(ctx: &Ctx) -> PathBuf {
    cli_root(ctx).join(".installed")
}

fn write_cli_stamp(ctx: &Ctx, version: &str) {
    let _ = std::fs::write(cli_stamp(ctx), version);
}

/// 内核就位判定 + 权限自愈：tar 解出的可执行位在少数文件系统上会丢
fn cli_ready(ctx: &Ctx) -> Option<PathBuf> {
    let (version, _) = cli_pkg_list();
    if version.is_empty() {
        return None;
    }
    let stamp = std::fs::read_to_string(cli_stamp(ctx)).unwrap_or_default();
    if stamp.trim() != version {
        return None;
    }
    let exe = find_cli_exe(&cli_root(ctx))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&exe) {
            if meta.permissions().mode() & 0o111 == 0 {
                let _ = std::fs::set_permissions(
                    &exe,
                    std::fs::Permissions::from_mode(0o755),
                );
            }
        }
    }
    Some(exe)
}

/// 内核状态（tts_status 的 cli 字段，供前端做能力位与文案）
fn cli_status(ctx: &Ctx) -> Value {
    let (version, pkgs) = cli_pkg_list();
    let exe = cli_ready(ctx);
    let ready = exe.is_some();
    json!({
        "platform": platform_key(),
        "supported": !pkgs.is_empty(),
        "ready": ready,
        "version": version,
        "bytes": pkgs.first().map(|p| p.bytes).unwrap_or(0),
        "path": exe.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "note": match (!pkgs.is_empty(), ready) {
            (false, _) => "当前系统架构没有对应的本地合成内核，请改用在线引擎",
            (true, false) => "本地合成内核尚未安装，下载该引擎时会自动一并获取",
            (true, true) => "",
        },
    })
}

/// 下载并安装本平台合成内核到 tts/cli/<platform>/（幂等：已就位直接返回）。
/// 清单给了多个候选包时逐个尝试，装完能在目录里找到 CLI 才算成功。
/// done/total 由调用方给出（与模型下载共用一条进度线）。
async fn ensure_cli(ctx: &Arc<Ctx>, done: u64, total: u64) -> Result<PathBuf, String> {
    if let Some(exe) = cli_ready(ctx) {
        return Ok(exe);
    }
    let key = platform_key();
    let (version, pkgs) = cli_pkg_list();
    if pkgs.is_empty() {
        return Err(format!(
            "本系统（{key}）没有可用的本地合成内核包，请改用在线引擎（edge / gtts）"
        ));
    }
    let root = cli_root(ctx);
    // 能走到这里说明目录里没有可用内核（缺版本戳或版本对不上），旧文件先清掉：
    // 否则 find_cli_exe 会先命中残留的旧 exe，新包解出来也用不上。
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).map_err(|e| format!("创建内核安装目录失败: {e}"))?;
    let mut last_err = String::new();
    for pkg in pkgs {
        let installed = if pkg.kind == "exe" {
            install_cli_exe(ctx, &root, &pkg, done, total).await
        } else {
            install_cli_archive(ctx, &root, &pkg, done, total).await
        };
        match installed {
            Ok(()) => {
                // 先落版本戳再判定就位（cli_ready 就靠它认账）
                write_cli_stamp(ctx, &version);
                if let Some(exe) = cli_ready(ctx) {
                    return Ok(exe);
                }
                last_err = format!("内核安装后未找到 {}", cli_exe_name());
            }
            Err(e) => last_err = e,
        }
    }
    Err(format!("本地合成内核安装失败：{last_err}"))
}

/// 候选一：单个自包含可执行文件直接落位到 bin/<exe>
async fn install_cli_exe(
    ctx: &Arc<Ctx>,
    root: &Path,
    pkg: &CliPkgDef,
    done: u64,
    total: u64,
) -> Result<(), String> {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("创建内核 bin 目录失败: {e}"))?;
    download_one(
        ctx,
        &bin,
        &AssetEntry {
            name: cli_exe_name().to_string(),
            url: pkg.url.clone(),
            bytes: pkg.bytes,
            sha256: pkg.sha256.clone(),
        },
        done,
        total,
        "tts-progress",
    )
    .await
}

/// 候选二：tar.bz2 归档整包解出（bin/ 可执行 + lib/ 依赖库同层）
async fn install_cli_archive(
    ctx: &Arc<Ctx>,
    root: &Path,
    pkg: &CliPkgDef,
    done: u64,
    total: u64,
) -> Result<(), String> {
    let name = pkg
        .url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("sherpa-tts-cli.tar.bz2")
        .to_string();
    let cache = archive_cache_dir(ctx);
    std::fs::create_dir_all(&cache).map_err(|e| format!("创建内核缓存目录失败: {e}"))?;
    download_one(
        ctx,
        &cache,
        &AssetEntry {
            name: name.clone(),
            url: pkg.url.clone(),
            bytes: pkg.bytes,
            sha256: pkg.sha256.clone(),
        },
        done,
        total,
        "tts-progress",
    )
    .await?;
    extract_all(&cache.join(&name), root).await
}

/// 整包解档：`tar -xf archive -C dest`（macOS/BSD tar、Windows 10+ bsdtar、Linux GNU tar 均支持）
async fn extract_all(archive: &Path, dest: &Path) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new("tar");
    cmd.arg("-x")
        .arg("-j")
        .arg("-f")
        .arg(archive)
        .arg("-C")
        .arg(dest)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    crate::registry::no_window_tokio(&mut cmd);
    let output = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
        .await
        .map_err(|_| "解包合成内核超时（300 秒）".to_string())?
        .map_err(|e| format!("解包合成内核失败（找不到 tar 命令）: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let msg = err.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
        return Err(format!("解包合成内核失败：{msg}"));
    }
    Ok(())
}

/// CLI 依赖库目录（mac/linux 的 dylib/so；Windows 的 dll 与 exe 同目录）
fn cli_lib_dir(cli: &Path) -> Option<PathBuf> {
    let dir = cli.parent()?.parent()?.join("lib");
    dir.is_dir().then_some(dir)
}

/// 模型落盘目录：数据目录下 tts/<engine>/
fn engine_dir(ctx: &Ctx, engine: &str) -> PathBuf {
    ctx.data_dir.join("tts").join(engine)
}

/// 归档缓存目录：数据目录下 tts/.cache/
fn archive_cache_dir(ctx: &Ctx) -> PathBuf {
    ctx.data_dir.join("tts").join(".cache")
}

/// 文件就位判定：清单给了精确字节数就按字节数，未收录（bytes=0）按存在即可
fn file_present(dir: &Path, f: &TtsFile) -> bool {
    let p = dir.join(&f.name);
    if f.bytes > 0 {
        std::fs::metadata(&p).map(|m| m.len() == f.bytes).unwrap_or(false)
    } else {
        p.is_file()
    }
}

/// 引擎全部文件就位
fn engine_ready(dir: &Path, def: &EngineDef) -> bool {
    !def.files.is_empty() && def.files.iter().all(|f| file_present(dir, f))
}

/// 引擎总体积（清单字节数累加）
fn engine_total_bytes(def: &EngineDef) -> u64 {
    def.files.iter().map(|f| f.bytes).sum()
}

// ---------- 全局状态 ----------

/// 下载互斥：tts_prepare 幂等入口
static DL_BUSY: AtomicBool = AtomicBool::new(false);
/// 当前下载中的引擎（进度事件与状态页标注）
static DL_ENGINE: Mutex<Option<String>> = Mutex::new(None);
/// 最近进度 (done, total)
static PROGRESS: Mutex<Option<(u64, u64)>> = Mutex::new(None);
/// 最近一次下载失败原因（tts_status 的 error 字段）
static DL_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// 单例合成子进程：端口 + 鉴权令牌 + 进程句柄
struct WorkerHandle {
    port: u16,
    token: String,
    child: tokio::process::Child,
}

static WORKER: Mutex<Option<WorkerHandle>> = Mutex::new(None);
/// 启动互斥：并发 ensure_worker 只允许一个起进程
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

/// 主动停掉 worker（重试前调用）
fn stop_worker() {
    if let Some(mut h) = WORKER.lock().unwrap().take() {
        h.child.start_kill().ok();
    }
}

/// 从 stderr 缓冲取一段失败原因
fn stderr_snippet(buf: &Arc<Mutex<String>>) -> String {
    let s = buf.lock().unwrap();
    let t = s.trim();
    if t.is_empty() {
        String::new()
    } else {
        format!("：{t}")
    }
}

// ---------- tts_status ----------

/// 本地引擎状态：就绪 / 目录 / 已下字节 / 总字节 / 缺失文件
fn local_engine_status(dir: &Path, def: &EngineDef, cli_ok: bool) -> Value {
    let total = engine_total_bytes(def);
    let mut bytes = 0u64;
    let mut missing: Vec<String> = Vec::new();
    for f in &def.files {
        if file_present(dir, f) {
            bytes += f.bytes;
        } else {
            missing.push(f.name.clone());
        }
    }
    let models_ready = missing.is_empty() && !def.files.is_empty();
    json!({
        // 可用 = 模型齐 + 本平台合成内核已装（内核只装一次，多引擎共用）
        "ready": models_ready && cli_ok,
        "modelsReady": models_ready,
        "cliReady": cli_ok,
        "dir": dir.to_string_lossy(),
        "bytes": bytes,
        "totalBytes": total,
        "missing": missing,
        "label": def.label,
        "languages": def.languages,
        "note": def.note,
    })
}

/// 在线引擎状态：edge 看桥依赖是否装了 node-edge-tts；需 key 的看 key 是否配置
fn online_engine_status(engine: &str, keys: &TtsKeys) -> Value {
    let ready = match engine {
        "edge" => worker_script()
            .map(|p| p.with_file_name("node_modules").join("node-edge-tts").is_dir())
            .unwrap_or(false),
        "gtts" => true,
        "siliconflow" => !keys.siliconflow.is_empty(),
        "openai" => !keys.openai.is_empty(),
        _ => false,
    };
    json!({ "ready": ready })
}

/// 状态查询：逐引擎探测 + key 配置 + 下载进度 + 最近错误。
/// patch 为可选的设置补丁（前端保存引擎/key/参数时不必额外命令）。
pub fn status_impl(ctx: &Arc<Ctx>, patch: Option<Value>) -> Result<Value, String> {
    let mut settings = load_settings(ctx);
    let mut error = DL_ERROR.lock().unwrap().clone();
    if let Some(p) = patch.as_ref() {
        if apply_patch(&mut settings, p) {
            save_settings(ctx, &settings);
        }
    }
    let engines_manifest = match load_manifest() {
        Ok(m) => m,
        Err(e) => {
            if error.is_none() {
                error = Some(e);
            }
            HashMap::new()
        }
    };
    let cli = cli_status(ctx);
    let cli_ok = cli.get("ready").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut engines = serde_json::Map::new();
    for id in LOCAL_ENGINES {
        match engines_manifest.get(*id) {
            Some(def) => {
                let dir = engine_dir(ctx, id);
                engines.insert((*id).to_string(), local_engine_status(&dir, def, cli_ok));
            }
            None => {
                engines.insert(
                    (*id).to_string(),
                    json!({
                        "ready": false,
                        "modelsReady": false,
                        "cliReady": cli_ok,
                        "dir": engine_dir(ctx, id).to_string_lossy(),
                        "bytes": 0,
                        "totalBytes": 0,
                        "missing": [],
                        "label": id,
                        "languages": [],
                        "note": "",
                    }),
                );
            }
        }
    }
    for id in ONLINE_ENGINES {
        engines.insert(
            (*id).to_string(),
            online_engine_status(id, &settings.keys),
        );
    }
    Ok(json!({
        "engine": settings.engine,
        "engines": engines,
        "cli": cli,
        "keys": {
            "siliconflow": !settings.keys.siliconflow.is_empty(),
            "openai": !settings.keys.openai.is_empty(),
        },
        "voice": settings.voice,
        "speed": settings.speed,
        "pitch": settings.pitch,
        "volume": settings.volume,
        "extra": settings.extra,
        "downloading": DL_BUSY.load(Ordering::SeqCst),
        "downloadEngine": DL_ENGINE.lock().unwrap().clone(),
        "progress": PROGRESS.lock().unwrap().map(|(d, t)| json!({ "done": d, "total": t })),
        "error": error,
    }))
}

// ---------- tts_prepare ----------

/// 触发下载（幂等）。engine 支持两种形态：
/// - 字符串（契约形态）：只下载该引擎
/// - 对象：先按 tts_status 的补丁语义保存设置（含 key），再下载其中的 engine
pub async fn prepare_impl(ctx: &Arc<Ctx>, engine: Value) -> Result<Value, String> {
    let engine_id = match &engine {
        Value::String(s) => {
            let mut st = load_settings(ctx);
            let id = if s.trim().is_empty() {
                st.engine.clone()
            } else {
                s.trim().to_string()
            };
            st.engine = id.clone();
            save_settings(ctx, &st);
            id
        }
        Value::Object(_) => {
            let mut st = load_settings(ctx);
            apply_patch(&mut st, &engine);
            let id = engine
                .get("engine")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| st.engine.clone());
            st.engine = id.clone();
            save_settings(ctx, &st);
            id
        }
        _ => load_settings(ctx).engine,
    };

    // 在线引擎：无下载，直接返回就绪状态
    if ONLINE_ENGINES.contains(&engine_id.as_str()) {
        DL_ERROR.lock().unwrap().take();
        return status_impl(ctx, None);
    }
    if !LOCAL_ENGINES.contains(&engine_id.as_str()) {
        return Err(format!("不支持的语音引擎：{engine_id}"));
    }
    let manifest = load_manifest()?;
    let def = manifest
        .get(&engine_id)
        .ok_or_else(|| format!("语音合成清单缺少引擎：{engine_id}"))?;
    let dir = engine_dir(ctx, &engine_id);

    if engine_ready(&dir, def) && cli_ready(ctx).is_some() {
        DL_ERROR.lock().unwrap().take();
        return status_impl(ctx, None);
    }
    if DL_BUSY.load(Ordering::SeqCst) {
        // 已在下载：幂等返回当前状态（不重复起任务）
        return status_impl(ctx, None);
    }
    DL_BUSY.store(true, Ordering::SeqCst);
    *DL_ENGINE.lock().unwrap() = Some(engine_id.clone());
    *DL_ERROR.lock().unwrap() = None;
    *PROGRESS.lock().unwrap() = Some((0, local_bundle_bytes(ctx, def)));

    let c = ctx.clone();
    let id = engine_id.clone();
    let d = def.clone();
    crate::task::spawn(async move {
        let result = download_engine(&c, &id, &d, &dir).await;
        if let Err(e) = result {
            *DL_ERROR.lock().unwrap() = Some(e);
        }
        DL_BUSY.store(false, Ordering::SeqCst);
        *DL_ENGINE.lock().unwrap() = None;
    });
    status_impl(ctx, None)
}

/// 一个本地引擎的完整下载体积：模型 + （未安装时的）本平台合成内核
fn local_bundle_bytes(ctx: &Ctx, def: &EngineDef) -> u64 {
    let mut total = engine_total_bytes(def);
    if cli_ready(ctx).is_none() {
        total += cli_pkg_bytes();
    }
    total
}

/// 更新进度静态量并广播 tts-progress（download.rs 内部另有 200ms 节流的逐块事件）
fn report_progress(ctx: &Arc<Ctx>, engine: &str, done: u64, total: u64, file: &str) {
    *PROGRESS.lock().unwrap() = Some((done, total));
    ctx.emit(
        "tts-progress",
        json!({ "done": done, "total": total, "file": file, "engine": engine }),
    );
}

/// 下载一个本地引擎的全部文件：先补齐本平台合成内核（一次安装多引擎共用），
/// 再走模型（归档成员先下归档再解包，独立文件直下；全部幂等）
async fn download_engine(
    ctx: &Arc<Ctx>,
    engine: &str,
    def: &EngineDef,
    dir: &Path,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建模型目录失败: {e}"))?;
    let total = local_bundle_bytes(ctx, def);
    let mut done: u64 = 0;
    if cli_ready(ctx).is_none() {
        report_progress(ctx, engine, done, total, "tts-cli");
        ensure_cli(ctx, done, total).await?;
        done += cli_pkg_bytes();
        report_progress(ctx, engine, done, total, "tts-cli");
    }
    // 同一个归档内的成员只下载/解包一次
    let mut fetched_archive: Option<PathBuf> = None;
    for f in &def.files {
        if file_present(dir, f) {
            done += f.bytes;
            continue;
        }
        if !f.inner.is_empty() {
            let arch = def
                .archive
                .as_ref()
                .ok_or_else(|| format!("清单缺少归档定义：{}", f.name))?;
            let cache = archive_cache_dir(ctx);
            std::fs::create_dir_all(&cache).map_err(|e| format!("创建缓存目录失败: {e}"))?;
            let arch_name = arch
                .url
                .rsplit('/')
                .next()
                .unwrap_or("archive.tar.bz2")
                .to_string();
            let arch_path = cache.join(&arch_name);
            let got = fetched_archive
                .as_ref()
                .map(|p| p == &arch_path)
                .unwrap_or(false)
                || archive_ok(&arch_path, arch);
            if !got {
                let entry = AssetEntry {
                    name: arch_name.clone(),
                    url: arch.url.clone(),
                    bytes: arch.bytes,
                    sha256: arch.sha256.clone(),
                };
                download_one(ctx, &cache, &entry, done, total, "tts-progress").await?;
            }
            extract_member(&arch_path, &f.inner, dir, &f.name, f.bytes, &f.sha256).await?;
            fetched_archive = Some(arch_path);
        } else {
            let entry = AssetEntry {
                name: f.name.clone(),
                url: f.url.clone(),
                bytes: f.bytes,
                sha256: f.sha256.clone(),
            };
            download_one(ctx, dir, &entry, done, total, "tts-progress").await?;
        }
        done += f.bytes;
        report_progress(ctx, engine, done, total, &f.name);
    }
    // 归档已用完：删掉省磁盘（下次仍可从清单重新下载）
    if let Some(p) = fetched_archive {
        let _ = std::fs::remove_file(p);
        let cache = archive_cache_dir(ctx);
        let _ = std::fs::remove_dir(&cache);
    }
    if !engine_ready(dir, def) {
        return Err("模型下载完成但校验未通过（文件缺失或大小不符）".into());
    }
    Ok(())
}

/// 归档是否已完整缓存（有清单字节数就核长度，有哈希再核哈希）
fn archive_ok(path: &Path, arch: &ArchiveDef) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if arch.bytes > 0 && meta.len() != arch.bytes {
        return false;
    }
    if !arch.sha256.is_empty() {
        use sha2::{Digest, Sha256};
        let Ok(bytes) = std::fs::read(path) else {
            return false;
        };
        let mut h = Sha256::new();
        h.update(&bytes);
        let sum = h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
        return sum.eq_ignore_ascii_case(&arch.sha256);
    }
    true
}

/// 从 tar.bz2 取一个成员到 dir：`tar -xjf archive -O inner` 流式写文件 + 边算哈希。
/// 走系统 tar（macOS/BSD tar、Windows 10+ bsdtar、Linux GNU tar 均支持 -O 与 -j）。
/// name/bytes/sha256 由调用方给出（TTS 与 KWS 唤醒共用）。
pub(crate) async fn extract_member(
    archive: &Path,
    inner: &str,
    dir: &Path,
    name: &str,
    bytes: u64,
    sha256: &str,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncReadExt;

    let part = dir.join(format!("{}.part", name));
    let dest = dir.join(name);
    let mut cmd = tokio::process::Command::new("tar");
    cmd.arg("-x")
        .arg("-j")
        .arg("-f")
        .arg(archive)
        .arg("-O")
        .arg(inner);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    crate::registry::no_window_tokio(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("解包模型失败（找不到 tar 命令）: {e}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "读取解包输出失败".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "读取解包错误输出失败".to_string())?;
    let err_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    {
        let eb = err_buf.clone();
        crate::task::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut g = eb.lock().unwrap();
                if g.len() < 2048 {
                    g.push_str(&line);
                    g.push('\n');
                }
            }
        });
    }
    let mut file = std::fs::File::create(&part).map_err(|e| format!("写入临时文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut got: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match stdout.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                use std::io::Write as _;
                file.write_all(&buf[..n])
                    .map_err(|e| format!("写入失败: {e}"))?;
                hasher.update(&buf[..n]);
                got += n as u64;
            }
            Err(e) => {
                let _ = child.start_kill();
                let _ = std::fs::remove_file(&part);
                return Err(format!("读取解包数据失败: {e}"));
            }
        }
    }
    drop(file);
    let status = child
        .wait()
        .await
        .map_err(|e| format!("等待解包进程失败: {e}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&part);
        return Err(format!("解包 {} 失败{}", name, stderr_snippet(&err_buf)));
    }
    if bytes > 0 && got != bytes {
        let _ = std::fs::remove_file(&part);
        return Err(format!("解包长度不符（{got}/{} 字节）: {}", bytes, name));
    }
    if !sha256.is_empty() {
        let sum = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
        if !sum.eq_ignore_ascii_case(sha256) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("解包 SHA-256 校验失败: {}", name));
        }
    }
    std::fs::rename(&part, &dest).map_err(|e| format!("模型文件落位失败: {e}"))?;
    Ok(())
}

// ---------- tts_speak ----------

/// 合成主入口：text + 可选覆盖（engine/voice/speed/pitch/volume/extra）
pub async fn speak_impl(
    ctx: &Arc<Ctx>,
    text: String,
    opts: Option<Value>,
) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("合成文本为空".into());
    }
    if text.chars().count() > 2000 {
        return Err("合成文本过长（上限 2000 字）".into());
    }
    let mut settings = load_settings(ctx);
    if let Some(o) = opts.as_ref() {
        apply_patch(&mut settings, o);
        // 试听即记住上次选择（不含 key）
        save_settings(ctx, &settings);
    }
    let engine = if settings.engine.trim().is_empty() {
        default_engine()
    } else {
        settings.engine.clone()
    };
    if LOCAL_ENGINES.contains(&engine.as_str()) {
        local_speak(ctx, &engine, &text, &settings).await
    } else if ONLINE_ENGINES.contains(&engine.as_str()) {
        online_speak(ctx, &engine, &text, &settings).await
    } else {
        Err(format!("不支持的语音引擎：{engine}"))
    }
}

/// 按 tunables 模板校验一个可调项，返回拼进 CLI 的字符串值（不合规返回错误）
fn tunable_value(t: &Value, v: &Value) -> Result<String, String> {
    let ty = t.get("type").and_then(|x| x.as_str()).unwrap_or("text");
    match ty {
        "range" => {
            let n = v
                .as_f64()
                .ok_or_else(|| "参数需为数字".to_string())?;
            let min = t.get("min").and_then(|x| x.as_f64()).unwrap_or(f64::MIN);
            let max = t.get("max").and_then(|x| x.as_f64()).unwrap_or(f64::MAX);
            let n = n.clamp(min, max);
            Ok(format!("{n}"))
        }
        "select" => {
            let s = v.as_str().ok_or_else(|| "参数需为字符串".to_string())?;
            let ok = t
                .get("options")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter().any(|o| {
                        o.as_str().map(|x| x == s).unwrap_or(false)
                            || o.get("value").and_then(|x| x.as_str()) == Some(s)
                    })
                })
                .unwrap_or(false);
            if ok {
                Ok(s.to_string())
            } else {
                Err(format!("参数取值不在可选范围：{s}"))
            }
        }
        _ => {
            let s = v.as_str().ok_or_else(|| "参数需为字符串".to_string())?;
            if s.chars().count() > 500 {
                return Err("参数文本过长（上限 500 字）".into());
            }
            Ok(s.to_string())
        }
    }
}

/// 拼装本地 CLI 参数：清单固定参数 + 白名单内可调项（speed / extra），
/// 任何不在 tunables 的 extra 键一律忽略（不透传任意 flag）。
fn build_local_args(def: &EngineDef, dir: &Path, s: &TtsSettings) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    let mut overridden: HashSet<String> = HashSet::new();
    let mut extra_flags: Vec<String> = Vec::new();

    // 1) 可调项：先算出哪些 flag 被 extra/默认值覆盖（对应固定参数要跳过）
    for t in &def.tunables {
        let Some(key) = t.get("key").and_then(|x| x.as_str()) else {
            continue;
        };
        // 显式 extra 优先；缺省时用模板默认值（lang/num-steps 等 CLI 必填项靠它兜底）
        let owned;
        let v: &Value = match s.extra.get(key) {
            Some(v) => v,
            None => match t.get("default") {
                Some(d) if !d.is_null() && d.as_str() != Some("") => {
                    owned = d.clone();
                    &owned
                }
                _ => continue,
            },
        };
        let Some(flag) = t.get("flag").and_then(|x| x.as_str()) else {
            continue;
        };
        if flag.is_empty() {
            continue;
        }
        let mut val = tunable_value(t, v).map_err(|e| format!("参数 {key} 不合法：{e}"))?;
        if key == "reference-audio" {
            // 相对路径按引擎模型目录解析；克隆音频必须是真实存在的文件
            let p = Path::new(&val);
            let resolved = if p.is_absolute() { p.to_path_buf() } else { dir.join(p) };
            if !resolved.is_file() {
                return Err(format!("参考音频文件不存在：{}", resolved.display()));
            }
            val = resolved.to_string_lossy().to_string();
        }
        extra_flags.push(format!("{flag}={val}"));
        overridden.insert(flag.to_string());
    }

    // 2) 清单固定参数（路径绝对化；被 extra 覆盖的 flag 跳过）
    for a in &def.args {
        if overridden.contains(&a.flag) {
            continue;
        }
        if !a.files.is_empty() {
            let sep: &str = if a.join.is_empty() { "," } else { &a.join };
            let joined = a
                .files
                .iter()
                .map(|n| dir.join(n).to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(sep);
            args.push(format!("{}={joined}", a.flag));
        } else if !a.file.is_empty() {
            args.push(format!("{}={}", a.flag, dir.join(&a.file).to_string_lossy()));
        } else if !a.value.is_empty() {
            args.push(format!("{}={}", a.flag, a.value));
        }
    }

    // 3) 语速：各引擎 flag 不同（--speed / --matcha-length-scale / ...）
    if !def.speed_flag.is_empty() && !overridden.contains(&def.speed_flag) {
        let speed = s.speed.clamp(0.5, 2.0);
        if (speed - 1.0).abs() > 1e-6 {
            args.push(format!("{}={speed}", def.speed_flag));
        }
    }

    // 4) 白名单内的 extra
    args.extend(extra_flags);
    Ok(args)
}

/// 本地引擎合成：sherpa CLI 子进程 → 读 wav → base64
async fn local_speak(
    ctx: &Arc<Ctx>,
    engine: &str,
    text: &str,
    settings: &TtsSettings,
) -> Result<Value, String> {
    let manifest = load_manifest()?;
    let def = manifest
        .get(engine)
        .ok_or_else(|| format!("语音合成清单缺少引擎：{engine}"))?;
    let dir = engine_dir(ctx, engine);
    if !engine_ready(&dir, def) {
        return Err(format!(
            "本地语音模型尚未就绪，请先下载该引擎模型（{engine}）"
        ));
    }
    let cli = cli_ready(ctx).ok_or_else(|| {
        format!(
            "本地合成内核未安装（{}），请先下载该引擎模型（会一并获取内核）",
            platform_key()
        )
    })?;
    let tmp_dir = ctx.data_dir.join("tts").join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建合成临时目录失败: {e}"))?;
    let out = tmp_dir.join(format!(
        "tts-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let args = build_local_args(def, &dir, settings)?;
    let mut cmd = tokio::process::Command::new(&cli);
    for a in &args {
        cmd.arg(a);
    }
    cmd.arg(format!("--output-filename={}", out.to_string_lossy()));
    cmd.arg(text);
    cmd.current_dir(&dir);
    if let Some(lib) = cli_lib_dir(&cli) {
        // mac/linux 走 DYLD/LD_LIBRARY_PATH 兜底（二进制自身 rpath 已指向 ../lib）
        #[cfg(target_os = "macos")]
        cmd.env("DYLD_LIBRARY_PATH", &lib);
        #[cfg(all(unix, not(target_os = "macos")))]
        cmd.env("LD_LIBRARY_PATH", &lib);
        #[cfg(windows)]
        cmd.env("PATH", {
            let old = std::env::var("PATH").unwrap_or_default();
            format!("{};{}", lib.display(), old)
        });
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    crate::registry::no_window_tokio(&mut cmd);

    let output = tokio::time::timeout(std::time::Duration::from_secs(180), cmd.output())
        .await
        .map_err(|_| "本地语音合成超时（180 秒）".to_string())?
        .map_err(|e| format!("启动本地语音合成失败: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let msg = err.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
        let _ = std::fs::remove_file(&out);
        return Err(format!("本地语音合成失败：{msg}"));
    }
    let wav = std::fs::read(&out).map_err(|e| format!("读取合成音频失败: {e}"))?;
    let _ = std::fs::remove_file(&out);
    if wav.is_empty() {
        return Err("本地语音合成输出为空".into());
    }
    use base64::Engine as _;
    let audio_base64 = base64::engine::general_purpose::STANDARD.encode(&wav);
    Ok(json!({
        "audioBase64": audio_base64,
        "sampleRate": wav_sample_rate(&wav),
        "format": "wav",
    }))
}


/// WAV 采样率（头里 24..28 字节）；非标准头回退 22050（sherpa 常见输出）
fn wav_sample_rate(wav: &[u8]) -> u32 {
    if wav.len() >= 28 && &wav[0..4] == b"RIFF" && &wav[8..12] == b"WAVE" {
        u32::from_le_bytes(wav[24..28].try_into().unwrap())
    } else {
        22050
    }
}

// ---------- 在线引擎（tts-worker HTTP） ----------

/// worker 启动配置（argv[2] JSON）：只放非敏感项；API key 走环境变量
fn worker_config_json(ctx: &Ctx) -> String {
    json!({
        "dataDir": ctx.data_dir.to_string_lossy(),
        "baseUrls": {
            "siliconflow": "https://api.siliconflow.cn",
            "openai": "https://api.openai.com",
        },
    })
    .to_string()
}

/// 确保 worker 存活（STARTING 单飞，其余轮询等待）
async fn ensure_worker(ctx: &Arc<Ctx>) -> Result<(), String> {
    if worker_alive() {
        return Ok(());
    }
    if STARTING.swap(true, Ordering::SeqCst) {
        for _ in 0..300 {
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
        return Err("语音合成服务启动中，请稍候重试".into());
    }
    let result = start_worker(ctx).await;
    STARTING.store(false, Ordering::SeqCst);
    result
}

/// spawn tts-worker：current_exe + ELECTRON_RUN_AS_NODE=1；就绪 stdout {"port":N}
async fn start_worker(ctx: &Arc<Ctx>) -> Result<(), String> {
    if worker_alive() {
        return Ok(());
    }
    let script = worker_script()?;
    let exe = std::env::current_exe().map_err(|e| format!("无法定位可执行文件: {e}"))?;
    let token = gen_token();
    let settings = load_settings(ctx);
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.arg(&script).arg(worker_config_json(ctx));
    cmd.env("ELECTRON_RUN_AS_NODE", "1");
    cmd.env("DSH_TTS_TOKEN", &token);
    // API key 走环境变量，不进 argv（避免进程列表泄露）
    cmd.env(
        "DSH_TTS_KEYS",
        json!({
            "siliconflow": settings.keys.siliconflow,
            "openai": settings.keys.openai,
        })
        .to_string(),
    );
    cmd.env("DSH_TTS_DATA_DIR", ctx.data_dir.to_string_lossy().to_string());
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    crate::registry::no_window_tokio(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("启动语音合成进程失败: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "读取合成进程输出失败".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "读取合成进程错误输出失败".to_string())?;
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
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            child.start_kill().ok();
            return Err(format!(
                "语音合成服务启动超时（30 秒）{}",
                stderr_snippet(&err_buf)
            ));
        }
        let line = tokio::select! {
            r = lines.next_line() => r,
            _ = tokio::time::sleep(remaining) => {
                child.start_kill().ok();
                return Err(format!(
                    "语音合成服务启动超时（30 秒）{}",
                    stderr_snippet(&err_buf)
                ));
            }
        };
        match line {
            Ok(Some(text)) => {
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
                child.start_kill().ok();
                return Err(format!(
                    "语音合成进程启动失败{}",
                    stderr_snippet(&err_buf)
                ));
            }
            Err(e) => {
                child.start_kill().ok();
                return Err(format!("读取合成进程输出失败: {e}"));
            }
        }
    }
}

/// 在线引擎合成：缺 key / 断网 / 不支持的语言都在 worker 侧折成中文错误
async fn online_speak(
    ctx: &Arc<Ctx>,
    engine: &str,
    text: &str,
    settings: &TtsSettings,
) -> Result<Value, String> {
    match engine {
        "siliconflow" if settings.keys.siliconflow.is_empty() => {
            return Err("尚未配置 SiliconFlow API Key（请先在设置里填写）".into())
        }
        "openai" if settings.keys.openai.is_empty() => {
            return Err("尚未配置 OpenAI API Key（请先在设置里填写）".into())
        }
        _ => {}
    }
    let voice = if settings.voice.trim().is_empty() {
        default_voice(engine).to_string()
    } else {
        settings.voice.clone()
    };
    let body = json!({
        "engine": engine,
        "text": text,
        "voice": voice,
        "speed": settings.speed,
        "pitch": settings.pitch,
        "volume": settings.volume,
    });
    let mut last_err = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            stop_worker();
        }
        match ensure_worker(ctx).await {
            Ok(()) => match post_synthesize(&body).await {
                Ok(v) => return Ok(v),
                Err(e) => last_err = e,
            },
            Err(e) => last_err = e,
        }
    }
    Err(format!("语音合成失败：{last_err}"))
}

/// POST 到 worker /synthesize（Bearer 鉴权），校验返回形状
async fn post_synthesize(body: &Value) -> Result<Value, String> {
    let (port, token) = {
        let g = WORKER.lock().unwrap();
        let h = g.as_ref().ok_or_else(|| "合成服务未运行".to_string())?;
        (h.port, h.token.clone())
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        // 在线 TTS 含 429 退避（worker 内部最多 5 次重试），客户端留足余量
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("构建请求客户端失败: {e}"))?;
    let resp = client
        .post(format!("http://127.0.0.1:{port}/synthesize"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("与语音合成服务通信失败: {e}"))?;
    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("读取合成结果失败: {e}"))?;
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| v.get("error").and_then(|x| x.as_str()).map(String::from))
            .unwrap_or(raw);
        return Err(format!(
            "语音合成服务返回错误（HTTP {}）：{msg}",
            status.as_u16()
        ));
    }
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("合成结果解析失败: {e}"))?;
    let audio = v
        .get("audioBase64")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "合成结果缺少音频数据".to_string())?;
    if audio.is_empty() {
        return Err("合成结果音频为空".into());
    }
    Ok(json!({
        "audioBase64": audio,
        "sampleRate": v.get("sampleRate").and_then(|x| x.as_u64()).unwrap_or(24000),
        "format": v.get("format").and_then(|x| x.as_str()).unwrap_or("mp3"),
    }))
}

// ---------- 在线引擎音色 ----------

/// 在线引擎音色列表（目前仅 EdgeTTS）：确保 worker 存活后 GET /voices?engine=edge。
/// 返回 {engine, groups:[{language, label, voices:[{name, label}]}]}；其他在线引擎暂不支持动态拉取。
pub async fn voices_impl(ctx: &Arc<Ctx>, engine: String) -> Result<Value, String> {
    let engine = {
        let e = engine.trim().to_lowercase();
        if e.is_empty() {
            "edge".to_string()
        } else {
            e
        }
    };
    if engine != "edge" {
        return Ok(json!({ "engine": engine, "groups": [] }));
    }
    ensure_worker(ctx).await?;
    let (port, token) = {
        let g = WORKER.lock().unwrap();
        let h = g.as_ref().ok_or_else(|| "合成服务未运行".to_string())?;
        (h.port, h.token.clone())
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("构建请求客户端失败: {e}"))?;
    let resp = client
        .get(format!("http://127.0.0.1:{port}/voices"))
        .query(&[("engine", "edge")])
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("拉取音色列表失败: {e}"))?;
    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("读取音色列表失败: {e}"))?;
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| v.get("error").and_then(|x| x.as_str()).map(String::from))
            .unwrap_or(raw);
        return Err(format!(
            "拉取音色列表失败（HTTP {}）：{msg}",
            status.as_u16()
        ));
    }
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("音色列表解析失败: {e}"))?;
    Ok(json!({
        "engine": engine,
        // voices 为扁平列表（前端按 locale 自行分组），groups 保留 worker 的语言分组便于其他端使用
        "voices": v.get("voices").cloned().unwrap_or_else(|| json!([])),
        "groups": v.get("groups").cloned().unwrap_or_else(|| json!({})),
    }))
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// 内核起不来时的现场：exe 大小 + bin/ 与 lib/ 的内容（Windows 单文件内核没有 lib/，
    /// 缺什么库只能靠这份清单判断）
    fn cli_diag(exe: &Path) -> String {
        let mut s = format!(
            "内核：{}（{} 字节）",
            exe.display(),
            std::fs::metadata(exe).map(|m| m.len()).unwrap_or(0)
        );
        let list = |dir: &Path| -> Vec<String> {
            let mut v: Vec<String> = std::fs::read_dir(dir)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .collect()
                })
                .unwrap_or_default();
            v.sort();
            v
        };
        if let Some(bin) = exe.parent() {
            s.push_str(&format!("\nbin/：{}", list(bin).join(", ")));
        }
        match cli_lib_dir(exe) {
            Some(lib) => s.push_str(&format!("\nlib/：{}", list(&lib).join(", "))),
            None => s.push_str("\nlib/：不存在（单文件内核，依赖需自带）"),
        }
        s
    }

    fn settings_with_extra(extra: Value) -> TtsSettings {
        let mut s = TtsSettings::default();
        s.extra = extra.as_object().unwrap().clone().into_iter().collect();
        s
    }

    /// 设置补丁：只认白名单字段，数值夹取范围，key 可覆盖与清空
    #[test]
    fn settings_patch_is_whitelisted_and_clamped() {
        let mut s = TtsSettings::default();
        let patch = json!({
            "engine": "matcha",
            "voice": "zh",
            "speed": 9.0,
            "pitch": 999.0,
            "volume": -1.0,
            "evil": "x",
            "keys": { "openai": "  sk-test  ", "siliconflow": "" }
        });
        assert!(apply_patch(&mut s, &patch));
        assert_eq!(s.engine, "matcha");
        assert_eq!(s.speed, 4.0);
        assert_eq!(s.pitch, 50.0);
        assert_eq!(s.volume, 0.0);
        assert_eq!(s.keys.openai, "sk-test");
        assert!(s.keys.siliconflow.is_empty());
        // 非对象补丁不改变任何东西
        assert!(!apply_patch(&mut s, &json!("x")));
    }

    /// 白名单外 extra 不透传；范围外取值夹取；select 非法值报错
    #[test]
    fn local_args_only_accept_tunables() {
        let def = EngineDef {
            label: "t".into(),
            languages: vec![],
            note: String::new(),
            archive: None,
            files: vec![],
            args: vec![TtsArg {
                flag: "--kitten-model".into(),
                file: "model.int8.onnx".into(),
                files: vec![],
                join: String::new(),
                value: String::new(),
            }],
            speed_flag: "--kitten-length-scale".into(),
            tunables: vec![
                json!({"key":"sid","flag":"--sid","type":"range","min":0,"max":7,"default":0}),
                json!({"key":"lang","flag":"--lang","type":"select","options":["en","zh"],"default":"en"}),
            ],
        };
        let s = settings_with_extra(json!({
            "sid": 99, "lang": "zh", "not-in-list": "boom"
        }));
        let args = build_local_args(&def, Path::new("/tmp/x"), &s).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("--kitten-model="), "{joined}");
        assert!(joined.contains("--sid=7"), "{joined}");
        assert!(joined.contains("--lang=zh"), "{joined}");
        assert!(!joined.contains("not-in-list"), "{joined}");
        // 语速 1.0 不拼（默认），2.5 夹到 2
        let mut s2 = TtsSettings::default();
        s2.speed = 2.5;
        let args = build_local_args(&def, Path::new("/tmp/x"), &s2).unwrap();
        assert!(args.join(" ").contains("--kitten-length-scale=2"), "{:?}", args);

        // select 非法取值 → 中文错误
        let mut s3 = TtsSettings::default();
        s3.extra.insert("lang".into(), json!("fr"));
        assert!(build_local_args(&def, Path::new("/tmp/x"), &s3).is_err());
    }

    /// 引擎分类与默认音色
    #[test]
    fn engine_classification() {
        assert!(LOCAL_ENGINES.contains(&"matcha"));
        assert!(ONLINE_ENGINES.contains(&"edge"));
        assert_eq!(default_voice("edge"), "zh-CN-XiaoxiaoNeural");
        assert_eq!(default_voice("openai"), "alloy");
        assert_eq!(default_voice("unknown"), "");
        assert_eq!(TtsSettings::default().engine, "edge");
    }

    /// WAV 采样率解析：标准头取 24..28，残缺头回退 22050
    #[test]
    fn wav_sample_rate_parsing() {
        let mut wav = vec![0u8; 44];
        wav[0..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        wav[24..28].copy_from_slice(&24000u32.to_le_bytes());
        assert_eq!(wav_sample_rate(&wav), 24000);
        assert_eq!(wav_sample_rate(&[]), 22050);
    }

    /// 合成内核清单：桌面架构全覆盖。bytes 是续传的权威长度、sha256 是落位校验，
    /// 缺任何一个都会让多端联调时的半包/坏包静默通过。
    #[test]
    fn cli_manifest_covers_desktop_platforms() {
        let doc = manifest_doc().expect("清单读取失败");
        let sec = doc.tts_bin.expect("语音合成清单缺少 tts_bin 分区");
        assert!(!sec.version.is_empty(), "tts_bin.version 缺失");
        for key in [
            "macos-aarch64",
            "macos-x86_64",
            "linux-x86_64",
            "linux-aarch64",
            "windows-x86_64",
            "windows-i686",
            "windows-aarch64",
        ] {
            let list = sec
                .platforms
                .get(key)
                .unwrap_or_else(|| panic!("内核清单缺少架构 {key}"));
            assert!(!list.is_empty(), "{key} 候选包为空");
            for p in list {
                assert!(p.url.starts_with("https://"), "{key} 非 https 源");
                assert!(p.bytes > 0, "{key} 未给权威字节数");
                assert!(
                    p.sha256.len() == 64 && p.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                    "{key} 的 sha256 不是 64 位十六进制"
                );
                assert!(
                    matches!(p.kind.as_str(), "exe" | "archive"),
                    "{key} 的内核包类型未知：{}",
                    p.kind
                );
            }
        }
    }

    /// 内核选名的边界：精确名 > 「名-版本号」改名，兄弟程序（-play / -microphone）一律不选
    #[test]
    fn find_cli_exe_ignores_sibling_binaries() {
        let root = std::env::temp_dir().join(format!("bit-tts-cli-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bin = root.join("pkg").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for name in ["sherpa-onnx-offline-tts-play", "sherpa-onnx-offline-tts-microphone"] {
            std::fs::write(bin.join(name), b"x").unwrap();
        }
        assert!(find_cli_exe(&root).is_none(), "只有兄弟程序时不应误判内核");

        // 官方改名带版本号后缀时仍要认（这是 hit() 唯一的兜底分支）
        let want = cli_exe_name();
        let renamed = match want.strip_suffix(".exe") {
            Some(base) => format!("{base}-1.13.8.exe"),
            None => format!("{want}-1.13.8"),
        };
        std::fs::write(bin.join(&renamed), b"x").unwrap();
        let got = find_cli_exe(&root).expect("版本号后缀的内核应被识别");
        assert_eq!(got.file_name().unwrap().to_string_lossy(), renamed);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 版本戳：目录里有内核对不上版本（0.7.1 误装的那个 GUI exe 就是这种）时不算就位，
    /// 否则换对了包也永远命中旧文件，老用户一直停在坏内核上。
    #[test]
    fn cli_ready_requires_matching_version_stamp() {
        let root = std::env::temp_dir().join(format!("bit-tts-cli-stamp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ctx = Arc::new(crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: root.clone(),
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        }));
        let dest = cli_root(&ctx);
        std::fs::create_dir_all(dest.join("bin")).unwrap();
        let exe = dest.join("bin").join(cli_exe_name());
        std::fs::write(&exe, b"x").unwrap();
        assert!(cli_ready(&ctx).is_none(), "没有版本戳不应判定就位");
        write_cli_stamp(&ctx, "0.0.1-旧版本");
        assert!(cli_ready(&ctx).is_none(), "版本戳对不上不应判定就位");
        write_cli_stamp(&ctx, &cli_pkg_list().0);
        assert_eq!(cli_ready(&ctx).as_deref(), Some(exe.as_path()));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 内核安装链路（Windows/Linux 联调走的就是这条路，本机先验证）：
    /// 合成归档 → 整包解档 → 跨一层包名目录找到 CLI → 可执行位自愈 → 真的能跑。
    #[tokio::test]
    async fn cli_install_extracts_and_self_heals_exec_bit() {
        let root = std::env::temp_dir().join(format!("bit-tts-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let ctx = Arc::new(crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: root.clone(),
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        }));

        // 造一个与官方同结构的归档：<pkg>/bin/<exe> + <pkg>/lib/<依赖库>
        let stage = root.join("stage");
        let pkg = stage.join("sherpa-onnx-v1.13.8-fake-shared");
        std::fs::create_dir_all(pkg.join("bin")).unwrap();
        std::fs::create_dir_all(pkg.join("lib")).unwrap();
        let exe = pkg.join("bin").join(cli_exe_name());
        std::fs::write(&exe, "#!/bin/sh\necho fake-tts-ok\n").unwrap();
        // 兄弟程序干扰项：官方归档的 bin 里真有 -play（参数不同、会抢音频设备），
        // 且 read_dir 顺序不保证——选内核必须按精确名，不能前缀匹配
        std::fs::write(
            pkg.join("bin").join("sherpa-onnx-offline-tts-play"),
            "#!/bin/sh\necho WRONG-PLAY-BINARY\n",
        )
        .unwrap();
        std::fs::write(pkg.join("lib").join("libsherpa-onnx-c-api.so"), b"dep").unwrap();
        // 归档必须落在被打包的树之外：GNU tar（Linux）一边写归档一边扫目录会判
        // 「file changed as we read it」并以退出码 1 失败，BSD tar（macOS）则容忍。
        let arch = root.join("fake.tar.bz2");
        let packed = std::process::Command::new("tar")
            .args(["-c", "-j", "-f"])
            .arg(&arch)
            .arg("-C")
            .arg(&stage)
            .arg(".")
            .output()
            .expect("打包测试归档失败（需要 tar）");
        assert!(
            packed.status.success(),
            "测试归档打包失败: {}",
            String::from_utf8_lossy(&packed.stderr)
        );

        // 解档到内核目录，并确认 lib 与 exe 的相对关系满足 cli_lib_dir 的约定
        let dest = cli_root(&ctx);
        std::fs::create_dir_all(&dest).unwrap();
        extract_all(&arch, &dest).await.expect("整包解档失败");
        let found = find_cli_exe(&dest).expect("解档后未找到合成 CLI");
        assert_eq!(found.file_name().unwrap().to_string_lossy(), cli_exe_name());
        let lib = cli_lib_dir(&found).expect("依赖库目录未按 ../lib 约定解析");
        assert!(lib.join("libsherpa-onnx-c-api.so").is_file());

        // 可执行位丢失时自愈（部分文件系统/解压链路会丢掉 +x）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // ensure_cli 解档成功后写版本戳；这里手动补上，就绪判定才认账
            write_cli_stamp(&ctx, &cli_pkg_list().0);
            std::fs::set_permissions(&found, std::fs::Permissions::from_mode(0o644)).unwrap();
            let ready = cli_ready(&ctx).expect("可执行位自愈后仍未判定就绪");
            assert_eq!(ready, found);
            let mode = std::fs::metadata(&ready).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "可执行位未补回");
            let run = std::process::Command::new(&ready).output().expect("内核不可执行");
            assert!(
                String::from_utf8_lossy(&run.stdout).contains("fake-tts-ok"),
                "解档出的 CLI 未能运行"
            );
        }
        // 只剩兄弟程序时不得当成内核（-play 参数不同、会去抢音频设备）
        std::fs::remove_file(&found).unwrap();
        assert!(find_cli_exe(&dest).is_none(), "只留 -play 时不应被当成内核");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真实联网安装本平台合成内核（约 20MB）并让它跑一次 `--help`：
    /// 校验 assets.json 的 tts_bin 包 → SHA-256 → 解档 → 动态库能装载 → CLI 可执行。
    /// 多端联调时在各自主机上手动触发一次，比只看单测更能确认该平台可用。
    ///
    /// 触发：cargo test -p bit-core --lib tts::tests::e2e -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "需联网下载约 20MB 合成内核"]
    async fn e2e_cli_install_real_and_runs() {
        // 固定目录：内核只下一次，重复跑直接命中幂等分支
        let root = std::env::temp_dir().join("bit-tts-e2e-cli");
        std::fs::create_dir_all(&root).unwrap();
        let ctx = Arc::new(crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: root.clone(),
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        }));
        let total = cli_pkg_bytes().max(1);
        let exe = ensure_cli(&ctx, 0, total)
            .await
            .unwrap_or_else(|e| panic!("{} 平台内核安装失败：{e}", platform_key()));
        println!("内核就位：{}", exe.display());

        let mut cmd = tokio::process::Command::new(&exe);
        cmd.arg("--help");
        // 与 local_speak 同样的子进程卫生：不接管测试进程的 stdin、Windows 不弹控制台窗口
        cmd.stdin(std::process::Stdio::null());
        crate::registry::no_window_tokio(&mut cmd);
        // 超时后必须把子进程一起带走：Windows runner 会等 job 里所有进程退出，
        // 留一个挂死的内核在后台，测试进程退了这一步照样卡到 job 超时。
        cmd.kill_on_drop(true);
        // 与 local_speak 同样的依赖库环境兜底（rpath 之外再指一次 lib/）
        if let Some(lib) = cli_lib_dir(&exe) {
            #[cfg(target_os = "macos")]
            cmd.env("DYLD_LIBRARY_PATH", &lib);
            #[cfg(all(unix, not(target_os = "macos")))]
            cmd.env("LD_LIBRARY_PATH", &lib);
            #[cfg(windows)]
            cmd.env("PATH", {
                let old = std::env::var("PATH").unwrap_or_default();
                format!("{};{}", lib.display(), old)
            });
        }
        // 必须自带超时：Windows 真机上曾出现 --help 永不返回（缺依赖 DLL 时系统会弹框等用户
        // 点确定，CI 里没人点 → 子进程和整个 job 一起挂到超时）。超时时把内核目录内容打出来，
        // 下一趟就能直接判断是缺库还是别的。
        let out = match tokio::time::timeout(std::time::Duration::from_secs(120), cmd.output()).await {
            Err(_) => panic!("内核 --help 120 秒未返回\n{}", cli_diag(&exe)),
            Ok(r) => r
                .map_err(|e| format!("内核无法启动（多半是依赖库没找到）: {e}"))
                .unwrap(),
        };
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            text.contains("offline-tts") || text.contains("--output-filename"),
            "内核 --help 输出异常：{}",
            text.chars().take(400).collect::<String>()
        );
        println!("内核可执行（{} 字节帮助文本）", text.len());
    }
}
