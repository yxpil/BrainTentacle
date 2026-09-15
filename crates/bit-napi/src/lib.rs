// yxpil · BIT napi
//! bit.node：把 bit-core 加载进 Electron 主进程。
//! - host_start(data_dir?)：宿主点火（Ctx 装载 + 任务运行时 + 后台任务），幂等
//! - on_ui_event(cb)：注册唯一 UI 事件回调（TSFN 强引用，保序）
//! - invoke(cmd, args)：命令 dispatch（M1 先放代表性命令，M2 补满 ~115 个）
//! 密钥材料（device_key/BITENC1/DPAPI）只在 Rust 侧，不暴露任何解密原语到导出面。
mod bridge;
mod emitter_napi;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, OnceLock};

static CTX: OnceLock<Arc<bit_core::state::Ctx>> = OnceLock::new();
static EMITTER: OnceLock<Arc<emitter_napi::NapiEmitter>> = OnceLock::new();

fn ctx() -> napi::Result<Arc<bit_core::state::Ctx>> {
    CTX.get()
        .cloned()
        .ok_or_else(|| Error::new(Status::GenericFailure, "host not started — call hostStart() first"))
}

/// 宿主点火：装 napi 托管 tokio 运行时的 Handle（async fn 体运行在该 runtime 上，
/// Handle::current() 即正确 Handle —— 装错症状 = core 任务静默失效，M1 专项验证过），
/// 装载 Ctx（数据目录与 Tauri 版同源，bit.db 无感共享）。
#[napi]
pub async fn host_start(data_dir: Option<String>, version: Option<String>) -> Result<()> {
    bit_core::task::init(tokio::runtime::Handle::current());
    let dir = data_dir
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(bit_core::state::default_data_dir);
    let emitter: Arc<dyn bit_core::emitter::UiEmitter> = EMITTER
        .get()
        .cloned()
        .map(|e| e as Arc<dyn bit_core::emitter::UiEmitter>)
        .unwrap_or_else(|| Arc::new(bit_core::emitter::NoopEmitter));
    let ctx = bit_core::state::Ctx::load(bit_core::state::LoadOpts {
        data_dir: dir,
        emitter,
        host: Arc::new(bit_core::emitter::NoopHost), // M3：Electron HostHooks（托盘/热键/退出）
        app_version: version.unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        // worker 子进程：Electron 形态指向 extraResources 的 bit-cli sidecar（M2 接管）
        worker_exe: None,
        app_exe: None,
    });
    bit_core::crash::install(&ctx.data_dir);
    bit_core::trace::init(&ctx.data_dir);
    // 后台 shell 顶层续跑 worker
    bit_core::shellbg::init(&ctx);
    bit_core::audit::record(&ctx, "local-app", "app.start", "BIT-napi", serde_json::json!({}), true);
    let _ = CTX.set(ctx);
    Ok(())
}

/// 注册 UI 事件回调（全应用唯一一条 TSFN；重复注册以最后一次为准）
#[napi]
pub fn on_ui_event(callback: JsFunction) -> Result<()> {
    let emitter = emitter_napi::NapiEmitter::new(callback)?;
    let _ = EMITTER.set(Arc::new(emitter));
    Ok(())
}

/// 命令 dispatch：cmd 白名单查表 → core api 函数；panic 转 rejected Promise（进程不退）
#[napi]
pub async fn invoke(cmd: String, args: Option<serde_json::Value>) -> Result<serde_json::Value> {
    let ctx = ctx()?;
    let args = args.unwrap_or(serde_json::Value::Null);
    let cmd_in = cmd.clone();
    // 派发到 napi 托管的 tokio runtime：core panic 被 JoinError 捕获，
    // 转普通错误交给 JS 侧弹提示（napi 异步任务裸 panic 会 abort 进程，必须兜住）
    match tokio::spawn(async move { bridge::dispatch(&ctx, &cmd_in, args).await }).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(Error::new(Status::GenericFailure, e)),
        Err(je) => Err(Error::new(
            Status::GenericFailure,
            format!("命令 {cmd} 执行崩溃（panic），详情见数据目录 crash.log：{je}"),
        )),
    }
}
