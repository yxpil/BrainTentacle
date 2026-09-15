// yxpil · BIT core
//! 命令 API 面：宿主（Tauri 壳 / Electron napi）共享的命令体。
//! M1 先落代表性命令，M2 起 128 个命令逐批从 src-tauri/commands.rs 迁入本模块
//! （去 State 化：参数即 ctx + 原生参数，壳层只做 #[tauri::command] 薄包装）。

use crate::state::Ctx;
use serde_json::json;
use std::sync::Arc;

/// 自动更新检测结果
#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    pub notes: String,
    pub url: String,
    /// 已下载到升级目录（可点击直接重启换装）
    pub downloaded: bool,
}

/// 无界面模式（BIT_HEADLESS=1）：E2E/专项测试用，窗口保持隐藏不弹到前台
pub fn is_headless() -> bool {
    std::env::var("BIT_HEADLESS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// 前端挂载信号：App 首帧成功渲染后由前端调用，落审计供 CI 冒烟断言
/// 「渲染树完整挂载」（页面渲染崩溃时本事件缺席 → Windows 冒烟判失败，拦住黑屏包）
pub fn ui_mounted(ctx: &Arc<Ctx>) {
    crate::audit::record(
        ctx,
        "local-app",
        "ui.mounted",
        "BIT",
        json!({}),
        true,
    );
}

/// 本进程内存占用（字节）：页眉仪表盘展示，前端每 3 秒轮询。
/// Electron 形态下此值是 bit.node 所在的主进程内存（诊断页注明）
pub fn mem_usage() -> u64 {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    let pid = sysinfo::Pid::from_u32(std::process::id());
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map(|p| p.memory()).unwrap_or(0)
}

/// 首页概览聚合（工具/记忆/技能/目标/待办/审计计数 + 远程访问状态 + AI 配置态）
pub fn get_overview(ctx: &Arc<Ctx>) -> serde_json::Value {
    // 锁治理：config 锁只用于读取自身字段，立即释放后再取其他锁；
    // 禁止持 config 锁期间再抢 memories/tools 等（与 system_prompt_mode 的
    // memories→config 反向锁序形成永久死锁，表现为点击页面卡死）
    let (remote_enabled, addr) = {
        let cfg = ctx.config.lock().unwrap();
        (cfg.remote_enabled, cfg.listen_addr())
    };
    json!({
        "tool_count": ctx.tools.lock().unwrap().len(),
        "memory_count": ctx.memories.lock().unwrap().len(),
        "skill_count": ctx.skills.lock().unwrap().len(),
        "goal_count": ctx.goals.lock().unwrap().iter().filter(|g| g.status == "active").count(),
        "todo_count": ctx.todos.lock().unwrap().iter().filter(|t| t.status != "completed").count(),
        "audit_count": ctx.audit.lock().unwrap().len(),
        "remote": {
            "enabled": remote_enabled,
            "addr": addr,
        },
        "ai_configured": ctx.ai_config.lock().unwrap().is_configured(),
        "autopilot_running": ctx.autopilot_running.load(std::sync::atomic::Ordering::SeqCst),
    })
}

/// 工具清单（含 gate_enabled 本机操控闸门状态）
pub fn list_tools(ctx: &Arc<Ctx>) -> serde_json::Value {
    // gate_enabled：设置页"本机操控"闸门状态。工具页据此把被闸门关掉的工具同步显示为停用，
    // 避免"设置里关了、工具页还显示运行中"的状态分裂
    let cfg = ctx.config.lock().unwrap().clone();
    let tools = ctx.tools.lock().unwrap().clone();
    let list: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            let mut v = serde_json::to_value(t).unwrap_or_else(|_| json!({}));
            v["gate_enabled"] = json!(cfg.tool_gate(&t.name));
            v
        })
        .collect();
    json!({ "tools": list })
}

/// 自动更新检测：镜像 latest.json 回退 GitHub API（BIT_FAKE_UPDATE_URL 测试注入在首位）
pub async fn check_updates(ctx: &Arc<Ctx>) -> Result<UpdateInfo, String> {
    let current = ctx.app_version.clone();
    let latest = crate::update::fetch_latest().await?;
    let has_update = crate::update::version_gt(&latest.version, &current);
    let downloaded = crate::update::read_state(ctx)
        .is_some_and(|st| {
            st["version"] == latest.version.as_str() && st["state"] == "downloaded"
        });
    Ok(UpdateInfo {
        current,
        latest: latest.version,
        has_update,
        notes: latest.notes,
        url: latest.url,
        downloaded,
    })
}

/// 真正退出应用（关闭窗口只是隐藏到托盘）
/// 与托盘退出保持一致：通知守护进程不要接力拉起 + 关闭时静默更新
pub fn quit_app(ctx: &Arc<Ctx>) -> serde_json::Value {
    crate::audit::record(ctx, "local-app", "app.quit", "BIT", json!({ "via": "ui" }), true);
    // 正常退出：先通知守护进程不要接力拉起
    crate::guardian::expect_exit(ctx);
    // 硬退出兜底（与托盘退出一致）：事件循环消费 exit(0) 失败时强制退出，保证 100% 退掉
    let hard_ctx = ctx.clone();
    std::thread::spawn(move || {
        let _ = crate::update::apply_update(&hard_ctx, false);
        std::thread::sleep(std::time::Duration::from_millis(1500));
        std::process::exit(0);
    });
    ctx.host.exit_app();
    json!({ "quit": true })
}

/// 安装 `bit` 命令到终端 PATH（设置页 / TUI / Electron 均可触发）
pub fn install_cli(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    crate::install::install_cli_impl(ctx)
}
