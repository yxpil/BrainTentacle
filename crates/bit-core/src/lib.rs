// yxpil · BIT core
//! 框架无关的核心库：对话引擎 / 工具注册与执行 / 存储与加密 / worker / TUI。
//! 宿主形态（Tauri 壳 / Electron napi / bit-cli）各自注入 emitter 与 host 钩子。
//!
//! 三种宿主的安装时机（见 task.rs）：
//! - Tauri GUI：setup 回调里 task::init_standalone()
//! - bit-cli / napi：各自 main() / module_init 里安装 Handle

pub mod agent;
pub mod ai;
pub mod api;
pub mod audit;
pub mod autopilot;
pub mod commands_api;
pub mod config;
pub mod console_codec;
pub mod crash;
// TUI 用的控制台附加/代码页还原，提升到 crate 根（tui/full.rs、tui/plain.rs 调 crate::restore_console_cp）
pub use console_codec::{attach_console, restore_console_cp};
pub mod delegation;
// 本机操控三件套：依赖 enigo（Linux 需要 libxdo）。musl / exotic 架构 / 无 GUI 目标
// 用 --no-default-features 编译时替换为 stub，保证链接通过、工具返回明确错误
#[cfg(feature = "desktop-ctl")]
pub mod desktop_ctl;
#[cfg(not(feature = "desktop-ctl"))]
pub mod desktop_ctl {
    use std::sync::Arc;
    type Ctx = Arc<crate::state::Ctx>;
    pub fn screenshot(
        _ctx: &Ctx,
        _d: usize,
        _r: Option<(u32, u32, u32, u32)>,
        _grid: bool,
    ) -> Result<String, String> {
        Err("此构建未编译本机操控能力（no-GUI/musl 目标）".into())
    }
    /// 格子规格 stub（exotic/musl 无屏幕概念）：签名与 desktop-ctl 版对齐，运行时报错
    pub fn screen_dims(_d: usize) -> Result<(u32, u32, f64), String> {
        Err("此构建未编译本机操控能力（no-GUI/musl 目标）".into())
    }
    /// 格子引用解析 stub：同上
    pub fn parse_cell(_s: &str, _w: u32, _h: u32) -> Result<(i32, i32), String> {
        Err("此构建未编译本机操控能力（no-GUI/musl 目标）".into())
    }
    pub fn mouse(_a: &str, _p: &serde_json::Value) -> Result<serde_json::Value, String> {
        Err("此构建未编译本机操控能力（no-GUI/musl 目标）".into())
    }
    pub fn keyboard(_a: &str, _p: &serde_json::Value) -> Result<serde_json::Value, String> {
        Err("此构建未编译本机操控能力（no-GUI/musl 目标）".into())
    }
}
pub mod emitter;
pub mod engine;
pub mod extract;
pub mod goal;
pub mod guardian;
pub mod hidden_code;
pub mod http_api;
pub mod install;
pub mod l2pass;
pub mod mcp;
pub mod memory;
pub mod netinfo;
pub mod osprotect;
pub mod paths;
pub mod perms;
pub mod plugins;
pub mod registry;
pub mod relay;
pub mod repetition;
pub mod runtime;
pub mod sandbox;
pub mod script;
pub mod script_runtime;
pub mod security;
pub mod securefile;
pub mod session;
pub mod shellbg;
pub mod state;
pub mod store;
pub mod syntax;
pub mod task;
pub mod toolenv;
pub mod trace;
pub mod tui;
pub mod update;
pub mod worker;
pub mod workwith;
