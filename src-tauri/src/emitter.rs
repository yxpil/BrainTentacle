// yxpil · BIT Tauri 壳
//! 壳层本地 emitter：TauriEmitter 直发 webview；trait 从 bit-core re-export。
//! M1-c：bit-core 不再依赖 tauri，桌面实现归壳层（Electron 侧另有 NapiEmitter）。
pub use bit_core::emitter::{HostHooks, NoopEmitter, NoopHost, UiEmitter};

/// Tauri 过渡期实现：直发 webview
pub struct TauriEmitter(pub tauri::AppHandle);
impl UiEmitter for TauriEmitter {
    fn emit(&self, name: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.0.emit(name, payload);
    }
}
