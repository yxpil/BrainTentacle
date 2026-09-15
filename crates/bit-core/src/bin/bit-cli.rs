// yxpil · BIT CLI
//! 独立三模式入口（无 Tauri / 无 GUI 依赖）：
//!   bit-cli                    → TUI（真终端全屏；管道/无 TTY 自动回退行协议）
//!   bit-cli tui                → 同上（显式）
//!   bit-cli --agent-worker     → agent worker 子进程（宿主经环境变量注入鉴权 token）
//!   bit-cli --bit-guardian <handshake> <log> → 看门狗守护进程
//! 数据目录：state::default_data_dir()（与桌面端 com.bit.hub 同源，无感共享）
use bit_core::{crash, guardian, state, task, trace, tui, worker};

fn main() {
    let argv: Vec<String> = std::env::args().collect();

    // ── 看门狗守护进程：主进程拉起，握手文件/日志路径/复活目标/复活参数由参数传入 ──
    if argv.len() >= 4 && argv[1] == guardian::GUARDIAN_FLAG {
        guardian::run_guardian(
            argv[2].clone().into(),
            argv[3].clone().into(),
            argv.get(4).map(std::path::PathBuf::from),
            argv.iter().skip(5).cloned().collect(),
        );
        return;
    }

    // ── --data-dir <path>：隔离数据目录（E2E / 多实例测试）──
    if let Some(pos) = argv.iter().position(|a| a == "--data-dir") {
        if let Some(dir) = argv.get(pos + 1) {
            std::env::set_var("BIT_DATA_DIR", dir);
        }
    }

    // 全局任务运行时：CLI 自建（core 所有 spawn 都派生到这里）
    task::init_standalone();

    // ── agent worker 子进程模式：无 UI，跑对话引擎 / 工具执行 / 审批 / 后台 shell ──
    let worker_flagged = argv.iter().any(|a| a == worker::WORKER_FLAG);
    let worker_env = std::env::var("BIT_WORKER_TOKEN").map(|v| !v.trim().is_empty()).unwrap_or(false);
    if worker_flagged || worker_env {
        worker::IN_WORKER.store(true, std::sync::atomic::Ordering::Relaxed);
        let ctx = state::Ctx::load(state::LoadOpts {
            data_dir: state::default_data_dir(),
            emitter: std::sync::Arc::new(worker::HostRelayEmitter),
            host: std::sync::Arc::new(bit_core::emitter::NoopHost),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            worker_exe: None,
            app_exe: None,
            app_args: Vec::new(),
        });
        crash::install(&ctx.data_dir);
        trace::init(&ctx.data_dir);
        // 后台 shell 续跑：DONE_TX 初始化，finish() 的 JobDone 才能唤回会话
        bit_core::shellbg::init(&ctx);
        bit_core::audit::record(&ctx, "host", "worker.start", "agent-worker", serde_json::json!({}), true);
        if let Err(e) = task::block_on(worker::serve(ctx.clone())) {
            // 服务致命错误（绑定失败等）：退出码 3，宿主监督循环检测到后重拉
            bit_core::audit::record(&ctx, "host", "worker.serve_error", "agent-worker", serde_json::json!({ "error": e }), false);
            std::process::exit(3);
        }
        return;
    }

    // ── TUI 模式：无窗口、无托盘、无 HTTP 服务（与桌面端可同时运行，共用数据目录）──
    std::env::set_var("BIT_TUI", "1"); // 审批自动放行标记（agent.rs 读）
    let ctx = state::Ctx::load(state::LoadOpts {
        data_dir: state::default_data_dir(),
        emitter: std::sync::Arc::new(bit_core::emitter::NoopEmitter),
        host: std::sync::Arc::new(bit_core::emitter::NoopHost),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        worker_exe: None,
        app_exe: None,
        app_args: Vec::new(),
    });
    crash::install(&ctx.data_dir);
    bit_core::audit::record(&ctx, "local-cli", "app.start", "tui", serde_json::json!({}), true);
    // 工作区沙箱：TUI 默认锚定启动目录（config.workspace_root 显式配置时以配置为准）
    if bit_core::sandbox::effective_root(&ctx).is_none() {
        if let Ok(cwd) = std::env::current_dir() {
            *ctx.workspace_root.lock().unwrap() = Some(cwd);
        }
    }
    // 解释器探测同步执行：CLI 场景不赶时间，脚本类工具需要完整列表
    let _ = ctx.refresh_runtimes();
    // 内部 std::process::exit，不会返回
    tui::run_blocking(ctx);
}
