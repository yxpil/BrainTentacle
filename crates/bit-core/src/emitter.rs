// yxpil · BIT
//! UI 事件出口与宿主能力抽象：核心逻辑只认 trait，不感知具体桌面框架。
//! - UiEmitter：全部 UI 事件（chat-chunk / tool-approval / shell-job …）经 Ctx::emit 走这里；
//!   宿主形态各自实现（Tauri webview / Electron TSFN / worker 转发 / TUI 无输出）
//! - HostHooks：托盘刷新 / 全局热键注册 / 应用退出这类"只有桌面壳才有"的能力
use std::sync::Arc;

pub trait UiEmitter: Send + Sync + 'static {
    fn emit(&self, name: &str, payload: serde_json::Value);
}

/// 无输出实现：TUI / guardian / 单测等无 webview 场景
pub struct NoopEmitter;
impl UiEmitter for NoopEmitter {
    fn emit(&self, _name: &str, _payload: serde_json::Value) {}
}

// TauriEmitter 已归入 src-tauri 薄壳（壳层本地实现，bit-core 不依赖 tauri crate）

pub trait HostHooks: Send + Sync + 'static {
    /// 托盘状态文案/菜单刷新（tray::refresh）
    fn refresh_tray(&self) {}
    /// 注册全局唤起热键；Err = 被占用等（审计 + 前端提示）
    fn register_hotkey(&self) -> Result<(), String> {
        Ok(())
    }
    /// 优雅退出整个应用（quit_app / 远程关停）
    fn exit_app(&self) {}
}

pub struct NoopHost;
impl HostHooks for NoopHost {}
