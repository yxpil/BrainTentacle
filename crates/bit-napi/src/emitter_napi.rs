// yxpil · BIT napi
//! NapiEmitter：Electron 形态唯一的 UiEmitter 实现 ——
//! core（Ctx::emit）发出的 UI 事件经 TSFN（ThreadsafeFunction）送 Electron 主进程。
//! TSFN 强引用、内部自带队列保序；主进程 JS 侧收到 `{ event, payload }`
//! 后再决定转发给哪个 webview（M2 ipc 处理）。
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::JsFunction;

/// UI 事件桥：全应用一条 TSFN（lib.rs on_ui_event 注册，重复注册以最后一次为准）
pub struct NapiEmitter {
    tsfn: ThreadsafeFunction<serde_json::Value, ErrorStrategy::Fatal>,
}

impl NapiEmitter {
    pub fn new(callback: JsFunction) -> napi::Result<Self> {
        let tsfn = callback.create_threadsafe_function::<serde_json::Value, serde_json::Value, _, ErrorStrategy::Fatal>(
            0,
            |ctx| Ok(vec![ctx.value]),
        )?;
        Ok(Self { tsfn })
    }
}

impl bit_core::emitter::UiEmitter for NapiEmitter {
    fn emit(&self, name: &str, payload: serde_json::Value) {
        // 事件名包进载荷，JS 侧只收一条通道；NonBlocking 不阻塞 core 线程，
        // TSFN 队列保序；返回的 Status（队列满/Closing）忽略——UI 挂了 core 照常跑
        let v = serde_json::json!({ "event": name, "payload": payload });
        self.tsfn.call(v, ThreadsafeFunctionCallMode::NonBlocking);
    }
}
