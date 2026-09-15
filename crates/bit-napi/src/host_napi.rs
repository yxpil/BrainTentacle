// yxpil · BIT napi
//! ElectronHostHooks：HostHooks 的 Electron 实现。
//! - exit_app → TSFN 回调 JS（app.quit()，走 Electron 正常退出链：before-quit 清理 → 退出）
//! - refresh_tray：M3 托盘接入后实现（当前空）
//! - register_hotkey：实际注册在 Electron 主进程 globalShortcut（B 类 set_hotkey 拦截），
//!   core 侧只落盘配置，这里恒 Ok 保证配置流程不受阻
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::JsFunction;
use std::sync::OnceLock;

static EXIT_TSFN: OnceLock<ThreadsafeFunction<(), ErrorStrategy::Fatal>> = OnceLock::new();

/// 注册退出回调（lib.rs on_host_exit，全应用唯一；重复注册以最后一次为准）
pub fn install_exit_callback(callback: JsFunction) -> napi::Result<()> {
    let tsfn = callback.create_threadsafe_function::<(), (), _, ErrorStrategy::Fatal>(
        0,
        |ctx| Ok(vec![ctx.value]),
    )?;
    let _ = EXIT_TSFN.set(tsfn);
    Ok(())
}

pub struct ElectronHostHooks;

impl bit_core::emitter::HostHooks for ElectronHostHooks {
    fn refresh_tray(&self) {}

    fn register_hotkey(&self) -> Result<(), String> {
        Ok(()) // Electron 侧 globalShortcut 负责，见 electron/main.cjs set_hotkey 拦截
    }

    fn exit_app(&self) {
        // 优雅退出：交还主进程 app.quit()（NoopHost 的硬退 exit(0) 只做兜底，
        // 这里先走正常链，窗口关闭/before-quit 清理都能执行）
        if let Some(tsfn) = EXIT_TSFN.get() {
            tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}
