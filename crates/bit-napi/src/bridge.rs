// yxpil · BIT napi
//! 命令 dispatch：cmd 白名单查表 → bit-core api 函数。
//! M1 只放代表性命令打通链路（host_start → invoke → TSFN 事件回流）；
//! M2 起 ~128 个命令按页分批迁入 bit-core::api 并在此补齐映射。
use std::sync::Arc;

use bit_core::state::Ctx;

/// 单一入口：与 Tauri 壳 invoke 同语义 —— 白名单外一律拒绝
pub async fn dispatch(
    ctx: &Arc<Ctx>,
    cmd: &str,
    _args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match cmd {
        "is_headless" => Ok(serde_json::json!({ "headless": bit_core::api::is_headless() })),
        "ui_mounted" => {
            bit_core::api::ui_mounted(ctx);
            Ok(serde_json::json!({ "ok": true }))
        }
        "mem_usage" => Ok(serde_json::json!({ "bytes": bit_core::api::mem_usage() })),
        "get_overview" => Ok(bit_core::api::get_overview(ctx)),
        "list_tools" => Ok(bit_core::api::list_tools(ctx)),
        "check_updates" => bit_core::api::check_updates(ctx)
            .await
            .and_then(|u| serde_json::to_value(u).map_err(|e| e.to_string())),
        "quit_app" => Ok(bit_core::api::quit_app(ctx)),
        "install_cli" => bit_core::api::install_cli(ctx),
        _ => Err(format!("未知命令: {cmd}")),
    }
}
