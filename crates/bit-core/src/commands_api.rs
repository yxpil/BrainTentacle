// yxpil · BIT core
//! 命令 API 面（A 类命令）：自 src-tauri/commands.rs 逐段迁入的框架无关命令体。
//!
//! 转换规则：
//! - `#[tauri::command] pub fn xxx(state: State<'_, Arc<Ctx>>, a: String) -> T`
//!   → `pub fn xxx(ctx: &Arc<Ctx>, a: String) -> Result<serde_json::Value, String>`
//!   - `let ctx = ctx(state);` 删除，参数直接叫 ctx
//!   - 原 T = serde_json::Value → `Ok(原返回值)`；原 T = bool/u64/usize/Vec<_>/String 等
//!     → `Ok(json!(原返回值))`；原 T = Result<Value, String> → 原样
//!   - async 命令保持 async fn
//! - B 类（Tauri / rfd / 插件绑定）不迁：save_file_as（rfd 对话框）、get/set_autostart
//!   （tauri-plugin-autostart）、set_hotkey（tauri-plugin-global-shortcut）、
//!   set_elevation / relaunch_with_elevation（AppHandle 重启提权）、update_apply（AppHandle 重启）；
//!   notify_done 由 chat / chat_stream 内联为 ctx.emit("notify-done", …) 事件；
//!   is_headless / ui_mounted / mem_usage / get_overview / list_tools / check_updates /
//!   quit_app / install_cli（install_cli_impl）已在 api.rs，install.rs 已有 install_cli_into。
//! - 辅助函数去重：estimate_context_tokens / fetch_provider_models / persist_model_context /
//!   refresh_model_context / active_max_context / claude_context_for / context_len_from / ctx_key
//!   已下沉 crate::ai；version_gt 已下沉 crate::update；qr_payload 已下沉 crate::relay；
//!   normalize_user_path / clean_display_path 已下沉 crate::paths —— 本模块直接复用，
//!   仅补齐尚缺的 normalize_base_url / open_target / is_elevated。

use crate::state::Ctx;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// 当前进程是否已提权：Windows 探测 `net session`（仅管理员可成功，无新依赖）；
/// unix 看 `id -u` 是否为 0
fn is_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("net")
            .arg("session")
            .creation_flags(0x0800_0000)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u32>() == Ok(0))
            .unwrap_or(false)
    }
}

/// base_url 归一化：去首尾空白与尾部斜杠；scheme 缺失时默认补 https://
/// （本机/局域网 http 端点在模型列表探测时会自动降级并回写正确 scheme）
fn normalize_base_url(b: &str) -> String {
    let b = b.trim().trim_end_matches('/');
    if b.starts_with("http://") || b.starts_with("https://") {
        b.to_string()
    } else {
        format!("https://{b}")
    }
}

fn open_target(p: &std::path::Path, reveal: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(p);
        // open 是快速返回的 LaunchServices 调用：必须等退出码，失败时不能静默——
        // 否则 Finder 停在原窗口，用户看到的是"定位到了错误的位置"
        let out = cmd.output().map_err(|e| format!("打开失败: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let reason = stderr.trim();
            return Err(format!(
                "打开失败: {}",
                if reason.is_empty() { format!("系统拒绝打开 {}", p.display()) } else { reason.to_string() }
            ));
        }
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW：避免后台命令闪黑框
        // 统一走 explorer.exe：不能用 `cmd /C start` 中转——路径/URL 含 & | ^ 等
        // cmd 元字符且无空格时 std 不加引号，cmd.exe 会把它们当命令分隔符执行（注入）
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // 剥 \\?\ verbatim 前缀 + 统一反斜杠：explorer 解析不了 verbatim 路径会退回打开默认文件夹
        let disp = crate::paths::clean_display_path(p);
        if reveal {
            // /select, 与路径必须是单个参数且路径自带引号：std 会给含空格的参数整体加引号，
            // explorer 解析 "/select,C:\a b\c.txt" 会定位到错误位置——必须 raw_arg 预引号
            return std::process::Command::new("explorer")
                .raw_arg(format!("/select,\"{disp}\""))
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("打开失败: {e}"));
        }
        // explorer 对文件按默认关联程序打开、对目录打开文件夹（exit code 不可靠，只 spawn 不判状态）
        return std::process::Command::new("explorer")
            .raw_arg(format!("\"{disp}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开失败: {e}"));
    }
    #[cfg(target_os = "linux")]
    {
        let target = if reveal {
            // xdg-open 无「定位选中」能力，退化为打开所在文件夹
            p.parent().unwrap_or(p).to_path_buf()
        } else {
            p.to_path_buf()
        };
        return std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开失败: {e}"));
    }
    #[allow(unreachable_code)]
    Err("不支持的平台".into())
}

// ---------- 工具 ----------

#[allow(clippy::too_many_arguments)]
pub async fn register_tool(
    ctx: &Arc<Ctx>,
    name: String,
    description: String,
    url: String,
) -> Result<serde_json::Value, String> {
    if url.trim().is_empty() {
        return Err("回调 URL 不能为空".into());
    }
    let tool = crate::registry::register(
        ctx,
        &name,
        &description,
        json!({"type": "object", "properties": {}, "additionalProperties": true}),
        crate::registry::ToolKind::Remote { url: url.trim().to_string() },
        "local-user",
    )?;
    crate::audit::record(ctx, "local-user", "tool.register", &tool.name, json!({ "url": url }), true);
    Ok(json!({ "tool": tool }))
}

pub fn remove_tool(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    let name = {
        let tools = ctx.tools.lock().unwrap();
        tools.iter().find(|t| t.id == id).map(|t| t.name.clone())
    };
    let removed = crate::registry::remove(ctx, &id)?;
    crate::audit::record(ctx, "local-user", "tool.remove", &name.unwrap_or_default(), json!({}), true);
    Ok(json!({ "removed": removed }))
}

pub fn set_tool_enabled(
    ctx: &Arc<Ctx>,
    id: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let now = crate::registry::set_enabled(ctx, &id, enabled)?;
    Ok(json!({ "id": id, "enabled": now }))
}

pub async fn invoke_tool(
    ctx: &Arc<Ctx>,
    id: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::registry::invoke(ctx, &id, params, "local-user", None).await
}

/// 注册脚本工具：把一段 JS/PY 代码沉淀为常驻工具，由本机解释器执行
pub fn register_script_tool(
    ctx: &Arc<Ctx>,
    name: String,
    description: String,
    runtime: String,
    code: String,
) -> Result<serde_json::Value, String> {
    if code.trim().is_empty() {
        return Err("脚本代码不能为空".into());
    }
    if crate::runtime::get(ctx, &runtime).is_none() {
        return Err(format!("解释器 `{runtime}` 未注册"));
    }
    let tool = crate::registry::register(
        ctx,
        &name,
        &description,
        json!({"type": "object", "properties": {}, "additionalProperties": true}),
        crate::registry::ToolKind::Interpreter { runtime: runtime.clone(), code },
        "local-user",
    )?;
    crate::audit::record(ctx, "local-user", "tool.register", &tool.name, json!({ "runtime": runtime }), true);
    Ok(json!({ "tool": tool }))
}

// ---------- 解释器 / 运行时 ----------

pub fn list_runtimes(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    Ok(json!({ "runtimes": ctx.runtimes.lock().unwrap().clone() }))
}

pub fn refresh_runtimes(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let list = crate::runtime::refresh(ctx);
    crate::audit::record(ctx, "local-user", "runtime.refresh", "detect", json!({ "count": list.len() }), true);
    Ok(json!({ "runtimes": list }))
}

pub fn add_runtime(
    ctx: &Arc<Ctx>,
    id: String,
    name: String,
    path: String,
    lang: String,
) -> Result<serde_json::Value, String> {
    let rt = crate::runtime::add_manual(ctx, &id, &name, &path, &lang)?;
    crate::audit::record(ctx, "local-user", "runtime.add", &rt.id, json!({ "path": rt.path }), true);
    Ok(json!({ "runtime": rt }))
}

pub fn remove_runtime(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    crate::runtime::remove(ctx, &id)?;
    crate::audit::record(ctx, "local-user", "runtime.remove", &id, json!({}), true);
    Ok(json!({ "removed": id }))
}

/// 暂停 / 启用解释器：暂停后 AI 不能用它执行代码或注册工具
pub fn set_runtime_enabled(
    ctx: &Arc<Ctx>,
    id: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let now = crate::runtime::set_enabled(ctx, &id, enabled)?;
    crate::audit::record(
        ctx,
        "local-user",
        if now { "runtime.enable" } else { "runtime.disable" },
        &id,
        json!({ "enabled": now }),
        true,
    );
    Ok(json!({ "id": id, "enabled": now }))
}

/// 直接用某个解释器跑一段代码（不落地为工具），用于测试
pub async fn run_script(
    ctx: &Arc<Ctx>,
    runtime: String,
    code: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let runtime2 = runtime.clone();
    let code2 = code.clone();
    let ctx2 = ctx.clone();
    // 超时取 config.tool_timeout_secs（默认 120，上限 600），与自定义工具一致
    let timeout_secs = ctx.config.lock().unwrap().tool_timeout_secs.clamp(1, 600) as u64;
    let handle = crate::task::spawn_blocking(move || {
        crate::script_runtime::run(&ctx2, &runtime2, &code2, &params, std::time::Duration::from_secs(timeout_secs))
    });
    let result = match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs + 5), handle).await {
        Ok(res) => res.map_err(|e| format!("脚本任务失败: {e}"))?,
        Err(_) => Err(format!("脚本执行超时（{timeout_secs} 秒）")),
    };
    crate::audit::record(ctx, "local-user", "script.run", &runtime, json!({ "ok": result.is_ok() }), result.is_ok());
    result
}

// ---------- 审计 ----------

pub fn list_audit(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let log = ctx.audit.lock().unwrap();
    let mut entries = log.clone();
    entries.reverse();
    Ok(json!({ "entries": entries }))
}

/// 清空审计日志；清空动作本身记一条，保证操作可追溯
pub fn clear_audit(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    crate::audit::clear(ctx);
    crate::audit::record(ctx, "local-user", "audit.clear", "audit", json!({}), true);
    Ok(json!({ "cleared": true }))
}

/// 删除单条审计记录；删除动作本身记一条
pub fn delete_audit_entry(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    if !crate::audit::delete(ctx, &id) {
        return Err("记录不存在".into());
    }
    crate::audit::record(ctx, "local-user", "audit.delete", &id, json!({}), true);
    Ok(json!({ "deleted": true }))
}

// ---------- 远程访问 ----------

pub fn get_remote_config(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.config.lock().unwrap();
    Ok(json!({
        "remote_enabled": cfg.remote_enabled,
        "host": cfg.host,
        "port": cfg.port,
        "client_key": cfg.client_key,
        "access_password": cfg.access_password.clone().unwrap_or_default(),
        "password_enabled": cfg.password_enabled,
        "cloud_relay_url": cfg.cloud_relay_url.clone().unwrap_or_default(),
        "revision": cfg.revision,
    }))
}

pub async fn save_remote_config(
    ctx: &Arc<Ctx>,
    remote_enabled: bool,
    host: String,
    port: u16,
) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.remote_enabled = remote_enabled;
        // 归一化主机输入：剥 IPv6 方括号 + 拒绝非 IP/域名形态（绑定时由 join_host_port 加回括号）
        let host = crate::config::normalize_host(&host)?;
        if port < 1024 {
            return Err("端口需不小于 1024".into());
        }
        cfg.host = host;
        cfg.port = port;
        cfg.revision += 1; // 每次保存自动递增版本号
    }
    // save_config 内部会再取 config 锁：std Mutex 不可重入，持锁调用同线程二次
    // 加锁在 macOS 上直接死锁（主线程卡死整个程序）。必须出锁后再落盘。
    ctx.save_config();
    crate::audit::record(ctx, "local-user", "remote.save", "config", json!({ "revision": ctx.config.lock().unwrap().revision }), true);
    let addr = crate::http_api::restart_server(ctx).await?;
    // 远程地址变化，同步托盘菜单显示
    ctx.host.refresh_tray();
    Ok(json!({ "addr": addr }))
}

/// 远程服务运行状态：供前端启动时查询端口是否被占用自动切换（事件可能早于 JS 监听而丢失）
pub fn get_remote_status(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.config.lock().unwrap();
    let switched_from = *ctx.port_switch.lock().unwrap();
    Ok(json!({
        "enabled": cfg.remote_enabled,
        "addr": cfg.listen_addr(),
        "switched_from": switched_from,
    }))
}

/// 宿主调度：显式派生子代理。
/// 模型侧没有这个工具（宿主管控），只有 UI / 远程 API / 宿主逻辑能触发。
pub async fn subagent_spawn(
    ctx: &Arc<Ctx>,
    task: String,
    title: Option<String>,
    session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let parent = session_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    crate::delegation::spawn(ctx, parent, &task, title.as_deref()).await
}

/// 当前在跑的子代理数量（宿主调度面板用）
pub fn subagent_running() -> Result<serde_json::Value, String> {
    Ok(json!(crate::registry::subagent_depth()))
}

/// 停止一个在跑的子代理（委派面板的「停止」按钮触发；只停该子会话，保留其进度）
pub fn stop_subagent(ctx: &Arc<Ctx>, session_id: String) -> Result<serde_json::Value, String> {
    let stopped = crate::registry::stop_subagent(ctx, &session_id);
    if stopped {
        crate::audit::record(ctx, "local-user", "subagent.stop", &session_id, json!({}), true);
    }
    Ok(json!({ "stopped": stopped, "session_id": session_id }))
}

/// 停止一个在跑的后台命令（面板「停止」按钮 / 输入框「停止 <job_id>」；kill 进程，随后 shell-job killed 事件广播）
/// 作业登记表每进程独立：AI 在 worker 里起的命令登记在 worker 侧 → 先问 worker，本地表兜底
pub async fn cancel_shell(ctx: &Arc<Ctx>, job_id: String) -> Result<serde_json::Value, String> {
    if crate::worker::active() && !crate::worker::IN_WORKER.load(std::sync::atomic::Ordering::Relaxed) {
        if let Ok(v) = crate::worker::proxy_shell_cancel(&job_id).await {
            if v.get("cancelled").and_then(|x| x.as_bool()).unwrap_or(false) {
                return Ok(v);
            }
        }
    }
    if crate::shellbg::cancel(&job_id) {
        crate::audit::record(ctx, "local-user", "shell.cancel_request", &job_id, json!({}), true);
        Ok(json!({ "cancelled": true, "job_id": job_id }))
    } else {
        Err(format!("后台命令 {job_id} 不存在或已结束"))
    }
}

/// 所有在跑的后台命令（面板挂载时恢复初始状态用）：合并 worker 与本地两张登记表
pub async fn list_running_shells() -> Result<serde_json::Value, String> {
    let mut arr: Vec<serde_json::Value> = Vec::new();
    if crate::worker::active() && !crate::worker::IN_WORKER.load(std::sync::atomic::Ordering::Relaxed) {
        if let Ok(v) = crate::worker::proxy_shell_list().await {
            if let Some(list) = v.as_array() {
                arr.extend(list.iter().cloned());
            }
        }
    }
    let local = crate::shellbg::list();
    if let Some(list) = local.as_array() {
        for j in list {
            let id = j.get("job_id").and_then(|x| x.as_str()).unwrap_or("");
            if !arr.iter().any(|x| x.get("job_id").and_then(|y| y.as_str()) == Some(id)) {
                arr.push(j.clone());
            }
        }
    }
    Ok(serde_json::Value::Array(arr))
}

/// 单个后台 shell 作业详情（含实时日志缓冲）：优先 worker 侧，worker 不活跃时回退本地表
pub async fn get_shell_detail(job_id: String) -> Result<serde_json::Value, String> {
    if crate::worker::active() && !crate::worker::IN_WORKER.load(std::sync::atomic::Ordering::Relaxed) {
        if let Ok(v) = crate::worker::proxy_shell_detail(&job_id).await {
            if !v.get("error").and_then(|e| e.as_str()).is_some() {
                return Ok(v);
            }
        }
    }
    crate::shellbg::detail(&job_id).ok_or_else(|| format!("后台命令 {job_id} 不存在或已结束"))
}

// ---------- 设置页各分组 ----------

/// AI 行为设置（设置页读写）：自动推进 / 子代理自动委派 / 审批模式 / 敏感词审核 / 兼容模式
pub fn get_behavior_settings(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.config.lock().unwrap();
    // 当前生效敏感词表：用户未自定义（None/空）时回退内置默认词库，供设置页直接展示编辑
    let words: Vec<String> = match cfg.blocked_words.as_ref() {
        Some(l) if !l.is_empty() => l.clone(),
        _ => crate::security::DEFAULT_BLOCKED_WORDS
            .iter()
            .map(|s| s.to_string())
            .collect(),
    };
    Ok(json!({
        "auto_drive": cfg.auto_drive,
        "auto_delegate": cfg.auto_delegate,
        "subagent_max": cfg.subagent_max,
        "tool_approval": cfg.tool_approval,
        "moderation_enabled": cfg.moderation_enabled,
        "compat_mode": cfg.compat_mode,
        "blocked_words": words,
        "blocked_words_custom": matches!(cfg.blocked_words.as_ref(), Some(l) if !l.is_empty()),
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn set_behavior_settings(
    ctx: &Arc<Ctx>,
    auto_drive: bool,
    tool_approval: String,
    moderation_enabled: bool,
    auto_delegate: Option<bool>,
    compat_mode: Option<bool>,
    subagent_max: Option<u32>,
    blocked_words: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.auto_drive = auto_drive;
        cfg.tool_approval = tool_approval;
        cfg.moderation_enabled = moderation_enabled;
        // 可选参数：老前端不传时保持原值
        if let Some(v) = auto_delegate {
            cfg.auto_delegate = v;
        }
        if let Some(v) = compat_mode {
            cfg.compat_mode = v;
        }
        if let Some(v) = subagent_max {
            cfg.subagent_max = v.clamp(1, crate::delegation::MAX_CFG_SUBAGENTS as u32);
        }
        // 敏感词表：传入即整体替换（清空空白项）；空数组 = 恢复内置默认（置 None），未传 = 保持原值
        if let Some(list) = blocked_words {
            let clean: Vec<String> = list
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            cfg.blocked_words = if clean.is_empty() { None } else { Some(clean) };
        }
        drop(cfg);
    }
    ctx.save_config();
    Ok(json!({ "ok": true }))
}

/// 幻觉防护阈值（设置页读写）：word_repeat_max=单回复词重复上限 / tool_loop_max=单回合工具轮上限，0=关闭
pub fn get_guard_limits(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.config.lock().unwrap();
    Ok(json!({ "word_repeat_max": cfg.word_repeat_max, "tool_loop_max": cfg.tool_loop_max }))
}

pub fn set_guard_limits(
    ctx: &Arc<Ctx>,
    word_repeat_max: u32,
    tool_loop_max: u32,
) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.word_repeat_max = word_repeat_max.min(10000);
        cfg.tool_loop_max = tool_loop_max.min(10000);
    }
    ctx.save_config();
    crate::audit::record(
        ctx,
        "local-user",
        "guard.limits",
        "set",
        json!({ "word_repeat_max": word_repeat_max, "tool_loop_max": tool_loop_max }),
        true,
    );
    Ok(json!({ "ok": true }))
}

/// 工具环境设置：自定义工具超时 + 默认 shell（含本机可用 shell 列表供下拉选择）
pub fn get_tool_env_settings(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.config.lock().unwrap();
    Ok(json!({
        "tool_timeout_secs": cfg.tool_timeout_secs,
        "default_shell": cfg.default_shell,
        "available_shells": crate::toolenv::available_shells(),
    }))
}

pub fn set_tool_env_settings(
    ctx: &Arc<Ctx>,
    tool_timeout_secs: u32,
    default_shell: String,
) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.tool_timeout_secs = tool_timeout_secs.clamp(10, 600);
        cfg.default_shell = default_shell.clone();
    }
    ctx.save_config();
    crate::audit::record(
        ctx,
        "local-user",
        "toolenv.settings",
        "set",
        json!({ "tool_timeout_secs": tool_timeout_secs, "default_shell": default_shell }),
        true,
    );
    Ok(json!({ "ok": true }))
}

/// 本机操控开关（screen / mouse / keyboard / draw_diagram / view_image）：设置页卡片。
/// 开启后模型可见并可调用（experimental；macOS 需 TCC 授权）
#[allow(clippy::too_many_arguments)]
pub fn set_desktop_tools(
    ctx: &Arc<Ctx>,
    screen: bool,
    mouse: bool,
    keyboard: bool,
    diagram: bool,
    viewimage: bool,
) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.tool_screen = screen;
        cfg.tool_mouse = mouse;
        cfg.tool_keyboard = keyboard;
        cfg.tool_diagram = diagram;
        cfg.tool_viewimage = viewimage;
    }
    ctx.save_config();
    crate::audit::record(
        ctx,
        "local-user",
        "desktop.tools",
        "set",
        json!({ "screen": screen, "mouse": mouse, "keyboard": keyboard, "diagram": diagram, "viewimage": viewimage }),
        true,
    );
    Ok(json!({ "ok": true }))
}

/// 读取本机操控开关状态
pub fn get_desktop_tools(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.config.lock().unwrap();
    Ok(json!({
        "screen": cfg.tool_screen,
        "mouse": cfg.tool_mouse,
        "keyboard": cfg.tool_keyboard,
        "diagram": cfg.tool_diagram,
        "viewimage": cfg.tool_viewimage,
    }))
}

/// 本地插件：列表（含启用状态与内容摘要）
pub fn list_plugins(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    // 确保插件目录存在：全新安装时「打开文件夹」按钮才不会因目录缺失而失败
    let _ = std::fs::create_dir_all(crate::plugins::dir(ctx));
    let plugins = ctx.plugins.lock().unwrap().clone();
    let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };
    let list: Vec<serde_json::Value> = plugins
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "version": p.version,
                "description": p.description,
                "enabled": !disabled.contains(&p.id),
                "tools": p.tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
                "prompts": p.prompts.len(),
                "skills": p.skills.len(),
                "memories": p.memories.len(),
                "jobs": p.jobs.iter().map(|j| json!({ "name": j.name, "schedule": j.schedule })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "plugins": list, "dir": crate::plugins::dir(ctx).to_string_lossy() }))
}

/// 本地插件：启用/停用（停用后工具/技能/记忆/提示词/定时任务全部摘除）
pub fn toggle_plugin(ctx: &Arc<Ctx>, id: String, enabled: bool) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        if enabled {
            cfg.disabled_plugins.retain(|x| x != &id);
        } else if !cfg.disabled_plugins.contains(&id) {
            cfg.disabled_plugins.push(id.clone());
        }
    }
    ctx.save_config();
    crate::plugins::sync(ctx);
    crate::audit::record(ctx, "local-user", "plugin.toggle", &id, json!({ "enabled": enabled }), true);
    Ok(json!({ "ok": true }))
}

/// 本地插件：重扫目录（新建/修改插件后无需重启）
pub fn refresh_plugins(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    crate::plugins::sync(ctx);
    let plugins = ctx.plugins.lock().unwrap().len();
    crate::audit::record(ctx, "local-user", "plugin.refresh", "plugins", json!({ "count": plugins }), true);
    Ok(json!({ "ok": true, "count": plugins }))
}

/// 用户自定义提示词/人设：读取
pub fn get_custom_prompt(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.config.lock().unwrap();
    Ok(json!({ "custom_prompt": cfg.custom_prompt }))
}

/// 用户自定义提示词/人设：保存（空串清除）
pub fn set_custom_prompt(ctx: &Arc<Ctx>, custom_prompt: String) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.custom_prompt = custom_prompt.trim().to_string();
    }
    ctx.save_config();
    Ok(json!({ "ok": true }))
}

/// 读取当前全局快捷键设置（只读配置；注册写入由宿主 JS 层处理）
pub fn get_hotkey(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    Ok(json!({ "hotkey": ctx.config.lock().unwrap().hotkey_show }))
}

/// 保存全局快捷键（空 = 关闭）。实际注册/冲突检测由宿主实现（Tauri HostHook /
/// Electron JS 拦截层先注册成功再调本命令持久化），这里只落盘
pub fn set_hotkey(ctx: &Arc<Ctx>, hotkey: &str) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.hotkey_show = hotkey.trim().to_string();
    }
    ctx.save_config();
    Ok(json!({ "ok": true, "hotkey": hotkey.trim() }))
}

/// 写文件后轻量语法检查开关：读取
pub fn get_syntax_check(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    Ok(json!({ "enabled": ctx.config.lock().unwrap().syntax_check }))
}

/// 写文件后轻量语法检查开关：保存（开 = 写入/编辑 json/js/py 后自动体检并提醒）
pub fn set_syntax_check(ctx: &Arc<Ctx>, enabled: bool) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.syntax_check = enabled;
    }
    ctx.save_config();
    Ok(json!({ "ok": true }))
}

/// 系统提示词模板覆盖：读取（config 为空则返回默认模板，方便用户基于默认修改）
pub fn get_system_prompt(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    // 锁序纪律：config 锁只用于读取 system_prompt 字段，读完立即释放。
    // default_system_prompt_for_display 内部（v0.6.3 新增的 native 分支）会再次取
    // config 锁——std Mutex 不可重入，持锁调用 = 主线程同线程死锁，表现为启动数秒后
    // 窗口与托盘整体冻结（get_overview 等处此前已修过同类问题，此处为漏网之鱼）
    let (stored_default, stored) = {
        let cfg = ctx.config.lock().unwrap();
        (cfg.system_prompt.trim().is_empty(), cfg.system_prompt.trim().to_string())
    };
    if stored_default {
        // 返回默认模板让前端直接显示
        Ok(json!({ "system_prompt": crate::ai::default_system_prompt_for_display(ctx), "is_default": true }))
    } else {
        Ok(json!({ "system_prompt": stored, "is_default": false }))
    }
}

/// 系统提示词模板覆盖：保存（空串 = 恢复默认）
pub fn set_system_prompt(ctx: &Arc<Ctx>, system_prompt: String) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.system_prompt = system_prompt.to_string(); // 允许空串（恢复默认）
    }
    ctx.save_config();
    Ok(json!({ "ok": true }))
}

/// 云中继地址（手机远程 App 用）：对称 NAT 无法直连时改连该地址
pub fn save_cloud_relay(ctx: &Arc<Ctx>, url: String) -> Result<serde_json::Value, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("云中继地址需以 http:// 或 https:// 开头".into());
    }
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.cloud_relay_url = if url.is_empty() { None } else { Some(url) };
        cfg.revision += 1;
    }
    ctx.save_config();
    crate::audit::record(ctx, "local-user", "remote.cloud_relay", "set", json!({}), true);
    Ok(json!({ "ok": true }))
}

/// 网络探测：LAN/公网候选地址 + NAT 粗判（远程二维码数据源）
pub async fn get_lan_info(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let stun = ctx.config.lock().unwrap().stun_servers.clone();
    Ok(crate::netinfo::lan_probe(stun.as_deref()).await)
}

/// 自定 STUN 服务器列表（host:port，逗号/分号分隔或数组）：整体替换内置免费列表，
/// 空列表 = 恢复默认。NAT 探测即时生效（下次打开二维码/探测即用新列表）
pub fn save_stun_servers(ctx: &Arc<Ctx>, servers: Vec<String>) -> Result<serde_json::Value, String> {
    // 展平：数组元素本身也允许逗号/分号分隔（前端单输入框直接整串传进来）
    let mut list: Vec<String> = Vec::new();
    for item in &servers {
        for part in item.split([',', ';', '，', '；']) {
            let p = part.trim().trim_end_matches('/').to_string();
            if !p.is_empty() && !list.contains(&p) {
                list.push(p);
            }
        }
    }
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.stun_servers = if list.is_empty() { None } else { Some(list) };
        cfg.revision += 1;
    }
    ctx.save_config();
    crate::audit::record(ctx, "local-user", "remote.stun_servers", "set", json!({}), true);
    Ok(json!({ "ok": true }))
}

/// 远程连接二维码：payload 携带全部连接信息（地址候选 / 端口 / 密钥 / 密码 / 会话绑定 /
/// 128 位识别码 / 三种连接方式），手机 App 扫码后按 局域网 → IPv6 直连（NAT1）→ 云中继依次尝试。
/// 返回 payload JSON 与离线渲染的 SVG（黑码白底，深浅主题下均可识别）。
/// payload 构造复用 crate::relay::qr_payload（与 HTTP /api/qr 共用）。
pub async fn get_remote_qr(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let payload = crate::relay::qr_payload(ctx).await?;
    // 二维码图只编加密块（BIT1: 密文）：截图/扫码器读不出明文凭据，
    // 本 App 扫码后用内置主密钥解出 payload JSON（手机端解密实现在 security.rs 注释）
    let enc = payload["enc"].as_str().ok_or("enc missing")?.to_string();
    let svg = qrcode::QrCode::new(enc.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    Ok(json!({ "payload": payload, "svg": svg }))
}

/// 任意 URL 的二维码 SVG（离线渲染，黑码白底，深浅主题下均可识别）。
/// 用于「关于」弹窗的安卓版扫码下载等公开链接场景（连接凭据二维码走 get_remote_qr 加密通道）
pub fn qr_svg_url(url: String) -> Result<serde_json::Value, String> {
    let url = url.trim().to_string();
    // 仅放行 https 链接：本命令面向公开下载地址，防止被滥用构造任意协议码
    if !url.starts_with("https://") {
        return Err("only https URLs are allowed".into());
    }
    let svg = qrcode::QrCode::new(url.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    Ok(json!(svg))
}

pub fn regenerate_client_key(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let key = {
        let mut cfg = ctx.config.lock().unwrap();
        let key = cfg.new_client_key();
        cfg.revision += 1;
        key
    };
    ctx.save_config();
    crate::audit::record(ctx, "local-user", "remote.rotate_key", "client_key", json!({}), true);
    Ok(json!({ "client_key": key }))
}

pub async fn test_connectivity(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let (addr, key, pwd, pwd_enabled) = {
        let cfg = ctx.config.lock().unwrap();
        (
            cfg.listen_addr(),
            cfg.client_key.clone(),
            cfg.access_password.clone().unwrap_or_default(),
            cfg.password_enabled,
        )
    };
    let url = format!("http://{addr}/api/health");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    // 健康检查（无需认证）
    let health_ok = matches!(
        client.get(&url).send().await,
        Ok(resp) if resp.status().is_success()
    );
    if !health_ok {
        return Err(format!("无法连接 {addr}"));
    }

    // 双重认证检查：带 Client Key + 密码访问受保护端点
    let mut req = client
        .get(format!("http://{addr}/api/tools"))
        .header("Authorization", format!("Bearer {key}"));
    if pwd_enabled {
        req = req.header("X-Access-Password", &pwd);
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => Ok(json!({
            "ok": true,
            "addr": addr,
            "message": format!("服务运行中，双重认证通过: http://{addr}")
        })),
        Ok(resp) => Err(format!("认证异常: HTTP {}", resp.status())),
        Err(e) => Err(format!("无法连接 {addr}: {e}")),
    }
}

/// 设置远程访问密码（自定义），并可选启用/停用密码校验
pub fn save_access_password(
    ctx: &Arc<Ctx>,
    password: String,
    password_enabled: bool,
) -> Result<serde_json::Value, String> {
    let password = password.trim().to_string();
    if password_enabled && (password.len() < 4 || password.len() > 64) {
        return Err("密码长度需在 4-64 位之间".into());
    }
    {
        let mut cfg = ctx.config.lock().unwrap();
        if password.is_empty() {
            // 未填密码时自动生成
            cfg.new_access_password();
        } else {
            cfg.access_password = Some(password);
        }
        cfg.password_enabled = password_enabled;
        cfg.revision += 1;
    }
    ctx.save_config();
    crate::audit::record(ctx, "local-user", "remote.save_password", "access_password", json!({ "enabled": password_enabled }), true);
    Ok(json!({ "saved": true }))
}

/// 重新生成随机访问密码（8 位数字）
pub fn regenerate_access_password(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let pwd = {
        let mut cfg = ctx.config.lock().unwrap();
        let pwd = cfg.new_access_password();
        cfg.revision += 1;
        pwd
    };
    ctx.save_config();
    crate::audit::record(ctx, "local-user", "remote.rotate_password", "access_password", json!({}), true);
    Ok(json!({ "access_password": pwd }))
}

// ---------- AI（多协议提供方） ----------

/// 列出所有提供方（含当前激活项）
pub fn list_providers(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.ai_config.lock().unwrap();
    Ok(json!({ "providers": cfg.providers.clone() }))
}

/// 新增一个提供方（默认不激活）
pub fn add_provider(
    ctx: &Arc<Ctx>,
    name: String,
    protocol: String,
    base_url: String,
    api_key: String,
    model: String,
) -> Result<serde_json::Value, String> {
    let protocol = match protocol.as_str() {
        "gemini" | "claude" | "openai" => protocol,
        _ => "openai".to_string(),
    };
    let base_url = {
        let b = base_url.trim();
        if b.is_empty() {
            crate::ai::Provider::default_base_url(&protocol).to_string()
        } else {
            b.to_string()
        }
    };
    let model = {
        let m = model.trim();
        if m.is_empty() {
            crate::ai::Provider::default_model(&protocol).to_string()
        } else {
            m.to_string()
        }
    };
    let name = {
        let n = name.trim();
        if n.is_empty() { protocol.clone() } else { n.to_string() }
    };
    let p = crate::ai::Provider {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name,
        protocol,
        base_url,
        api_key: api_key.trim().to_string(),
        model,
        active: false,
    };
    let id = p.id.clone();
    {
        let mut cfg = ctx.ai_config.lock().unwrap();
        // 首个提供方自动设为激活
        let first = cfg.providers.is_empty();
        let mut p = p;
        p.active = first;
        cfg.providers.push(p);
    }
    ctx.save_ai_config();
    crate::audit::record(ctx, "local-user", "ai.provider.add", &id, json!({}), true);
    Ok(json!({ "id": id }))
}

/// 更新某提供方的字段
pub fn update_provider(
    ctx: &Arc<Ctx>,
    id: String,
    name: String,
    protocol: String,
    base_url: String,
    api_key: String,
    model: String,
) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.ai_config.lock().unwrap();
        let p = cfg
            .providers
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("提供方不存在")?;
        let protocol = match protocol.as_str() {
            "gemini" | "claude" | "openai" => protocol,
            _ => "openai".to_string(),
        };
        p.name = { let n = name.trim(); if n.is_empty() { protocol.clone() } else { n.to_string() } };
        p.base_url = {
            let b = base_url.trim();
            if b.is_empty() { crate::ai::Provider::default_base_url(&protocol).to_string() } else { normalize_base_url(b) }
        };
        p.model = {
            let m = model.trim();
            if m.is_empty() { crate::ai::Provider::default_model(&protocol).to_string() } else { m.to_string() }
        };
        p.api_key = api_key.trim().to_string();
        p.protocol = protocol;
    }
    ctx.save_ai_config();
    crate::audit::record(ctx, "local-user", "ai.provider.update", &id, json!({}), true);
    Ok(json!({ "saved": true }))
}

/// 删除某提供方（若删的是激活项，自动把剩余第一条设为激活）
pub fn remove_provider(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.ai_config.lock().unwrap();
        let was_active = cfg.providers.iter().find(|p| p.id == id).map(|p| p.active).unwrap_or(false);
        cfg.providers.retain(|p| p.id != id);
        if was_active {
            if let Some(first) = cfg.providers.first_mut() {
                first.active = true;
            }
        }
    }
    ctx.save_ai_config();
    crate::audit::record(ctx, "local-user", "ai.provider.remove", &id, json!({}), true);
    Ok(json!({ "removed": true }))
}

/// 播放/暂停：设定当前激活提供方。active=true 时激活该项并暂停其余（互斥）；
/// active=false 时暂停该项（全部暂停 = 无激活项）。
pub fn set_provider_active(
    ctx: &Arc<Ctx>,
    id: String,
    active: bool,
) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.ai_config.lock().unwrap();
        if !cfg.providers.iter().any(|p| p.id == id) {
            return Err("提供方不存在".into());
        }
        for p in cfg.providers.iter_mut() {
            if p.id == id {
                p.active = active;
            } else if active {
                // 互斥：激活一个即暂停其余
                p.active = false;
            }
        }
    }
    ctx.save_ai_config();
    // 激活项变更：后台刷新模型上下文缓存（尽量获取最大上下文，失败静默）
    if active {
        let rf = ctx.clone();
        let rid = id.clone();
        crate::task::spawn(async move {
            let p = rf.ai_config.lock().unwrap().providers.iter().find(|p| p.id == rid).cloned();
            if let Some(p) = p {
                crate::ai::refresh_model_context(&rf, &p.protocol, &p.base_url, &p.api_key).await;
            }
        });
    }
    crate::audit::record(ctx, "local-user", "ai.provider.active", &id, json!({ "active": active }), true);
    Ok(json!({ "active": active }))
}

/// 读取模型采样参数（温度 / 思考强度）
pub fn get_ai_params(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.ai_config.lock().unwrap();
    Ok(json!({ "temperature": cfg.temperature, "reasoning_effort": cfg.reasoning_effort }))
}

/// 设置模型采样参数：temperature None=默认（0-2）；reasoning_effort ""=默认 / low / medium / high
pub fn set_ai_params(
    ctx: &Arc<Ctx>,
    temperature: Option<f64>,
    reasoning_effort: String,
) -> Result<serde_json::Value, String> {
    let effort = match reasoning_effort.as_str() {
        "low" | "medium" | "high" => reasoning_effort,
        _ => String::new(),
    };
    {
        let mut cfg = ctx.ai_config.lock().unwrap();
        cfg.temperature = temperature.filter(|t| (0.0..=2.0).contains(t));
        cfg.reasoning_effort = effort.clone();
    }
    ctx.save_ai_config();
    crate::audit::record(
        ctx,
        "local-app",
        "ai.params",
        "set",
        json!({ "temperature": temperature, "reasoning_effort": effort }),
        true,
    );
    Ok(json!({ "ok": true }))
}

/// 从提供方 API 拉取可用模型列表（顺带把上下文长度写入持久缓存）：
/// 返回 {base, models}，base 为自动检测后的生效端点（纠正过 /v1 时前端据此回填输入框），
/// models 元素为 {id, context_length}，context_length 为 null 表示该端点未提供。
/// 拉取逻辑复用 crate::ai::fetch_provider_models（协议分支 / scheme 降级自动检测）。
pub async fn list_provider_models(
    ctx: &Arc<Ctx>,
    protocol: String,
    base_url: String,
    api_key: String,
) -> Result<serde_json::Value, String> {
    let (effective, models) = crate::ai::fetch_provider_models(&protocol, &base_url, &api_key).await?;
    crate::ai::persist_model_context(ctx, &effective, &models);
    Ok(json!({
        "base": effective,
        "models": models
            .into_iter()
            .map(|(id, len)| json!({ "id": id, "context_length": len }))
            .collect::<Vec<_>>(),
    }))
}

/// AI 接收信息预览：当前会话实际发给模型的 system prompt / 消息 / 工具清单
pub async fn context_preview(ctx: &Arc<Ctx>, session_id: String) -> Result<serde_json::Value, String> {
    let (convo, tools) = crate::agent::build_context(ctx, &session_id)?;
    let est_tokens = crate::ai::estimate_context_tokens(ctx, &session_id, &convo);
    let messages: Vec<serde_json::Value> = convo
        .iter()
        .enumerate()
        .map(|(i, m)| {
            // 工具调用轮次的 assistant 消息正文为空：预览改展示调用摘要，避免"AI 记录空白"
            let preview = if m.content.is_empty() && !m.tool_calls.is_empty() {
                m.tool_calls
                    .iter()
                    .map(|tc| {
                        let args: String = tc.params.to_string().chars().take(120).collect();
                        let mark = if tc.ok { "" } else { " ✗" };
                        format!("⚙ {}({args}){mark}", tc.tool)
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                m.content.chars().take(500).collect::<String>()
            };
            json!({
                "index": i,
                "role": m.role,
                "content": crate::ai::strip_dynamic_mark(&m.content),
                "preview": crate::ai::strip_dynamic_mark(&preview),
            })
        })
        .collect();
    let tools_list = tools
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|t| {
            Some(json!({
                "name": t.get("name")?.as_str()?,
                "description": t.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "system": convo.first().map(|m| crate::ai::strip_dynamic_mark(&m.content)).unwrap_or_default(),
        "messages": messages,
        "tools": tools_list,
        "est_tokens": est_tokens,
        "max_context": crate::ai::active_max_context(ctx),
        "approval_mode": ctx.config.lock().unwrap().tool_approval.clone(),
    }))
}

/// 当前会话上下文用量估算：与预览口径一致，包含 system prompt / 历史消息 /
/// 原生函数调用模式下额外发送的 tool definitions。
pub async fn context_metrics(ctx: &Arc<Ctx>, session_id: String) -> Result<serde_json::Value, String> {
    let (convo, _) = crate::agent::build_context(ctx, &session_id)?;
    Ok(json!({
        "est_tokens": crate::ai::estimate_context_tokens(ctx, &session_id, &convo),
        "max_context": crate::ai::active_max_context(ctx),
    }))
}

/// 解析上传的文件（Excel→Markdown 表格 / Word(.docx)→纯文本 / CSV→原文）。
/// `filename` 用于按后缀分派，`data` 为 base64（可含 data:URL 前缀）。
pub async fn extract_file(filename: String, data: String) -> Result<serde_json::Value, String> {
    // 解析可能较重，放到阻塞线程
    let handle = crate::task::spawn_blocking(move || crate::extract::extract(&filename, &data));
    let text = handle.await.map_err(|e| format!("解析任务失败: {e}"))??;
    Ok(json!({ "text": text }))
}

/// 抓取网页并提取正文文字，返回 { title, text }
pub async fn fetch_webpage(url: String) -> Result<serde_json::Value, String> {
    let (title, text) = crate::extract::fetch_webpage(&url).await?;
    Ok(json!({ "title": title, "text": text }))
}

/// 端口冲突检测：true=可用，false=已被占用（保存远程配置前调用）
pub async fn check_port(host: String, port: u16) -> Result<serde_json::Value, String> {
    let addr = crate::config::join_host_port(host.trim(), port);
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => {
            drop(l);
            Ok(json!({ "available": true, "addr": addr }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            Ok(json!({ "available": false, "addr": addr, "reason": "端口已被占用" }))
        }
        Err(e) => Err(format!("检测 {addr} 失败: {e}")),
    }
}

/// ── MCP（Model Context Protocol）接入 ──

/// 自动发现：扫描本机端口范围，识别运行中的 MCP 服务器（Streamable HTTP）
pub async fn mcp_discover(host: String, start: u16, end: u16) -> Result<serde_json::Value, String> {
    let found = crate::mcp::discover(&host, start, end).await?;
    Ok(json!({ "servers": found, "scanned": (end as u32 - start as u32 + 1) }))
}

/// 手动接入：对任意 URL 做 MCP 握手，成功则保存并返回服务器信息
pub async fn mcp_connect(ctx: &Arc<Ctx>, url: String) -> Result<serde_json::Value, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err("请填写 MCP 服务器 URL".into());
    }
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let (name, version, protocol, session) = crate::mcp::initialize(&http, &url).await?;
    let server = crate::mcp::McpServer {
        id: format!("mcp-{}", uuid::Uuid::new_v4().simple()),
        name: name.clone(),
        url: url.clone(),
        transport: crate::mcp::McpTransport::Http,
        version,
        protocol,
        session,
        enabled: true,
        connected_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        command: Default::default(),
        args: Default::default(),
        env: Default::default(),
    };
    // 同一 URL 只保留一条
    let id = server.id.clone();
    {
        let mut list = ctx.mcp.lock().unwrap();
        list.retain(|s| s.url != url);
        list.push(server.clone());
    }
    ctx.save_mcp();
    crate::audit::record(ctx, "local-app", "mcp.connect", &name, json!({ "url": url }), true);
    Ok(json!({ "server": server, "id": id }))
}

/// 已接入服务器列表
pub async fn mcp_list(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let list = ctx.mcp.lock().unwrap().clone();
    Ok(json!({ "servers": list }))
}

/// stdio 接入：spawn 本地命令并 initialize 握手（如 python -m mcp_server_fetch），
/// 成功则保存；同 command+args 已存在则替换旧条目并杀掉旧进程
pub async fn mcp_add_stdio(
    ctx: &Arc<Ctx>,
    name: String,
    command: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("请填写启动命令".into());
    }
    // 同 command+args 的旧 stdio 条目（替换目标），握手成功后再移除
    let old_id = {
        let list = ctx.mcp.lock().unwrap();
        list.iter()
            .find(|s| {
                s.transport == crate::mcp::McpTransport::Stdio
                    && s.command == command
                    && s.args == args
            })
            .map(|s| s.id.clone())
    };
    let id = format!("mcp-{}", uuid::Uuid::new_v4().simple());
    // spawn + initialize 握手：失败直接报错（不动已有状态），前端展示
    let (session, srv_name, version, protocol) =
        crate::mcp::stdio_session::spawn_and_initialize(id.clone(), command.clone(), args.clone(), env.clone())
            .await?;
    // 名称：用户填的 > serverInfo.name > command 文件名
    let mut name = if name.trim().is_empty() { srv_name } else { name.trim().to_string() };
    if name.is_empty() {
        name = std::path::Path::new(&command)
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or(&command)
            .to_string();
    }
    let server = crate::mcp::McpServer {
        id: id.clone(),
        name: name.clone(),
        url: String::new(),
        transport: crate::mcp::McpTransport::Stdio,
        command,
        args,
        env,
        version,
        protocol,
        session: String::new(),
        enabled: true,
        connected_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    };
    // 替换旧条目：杀旧进程、删旧条目及其导入的工具（避免同名挡住重新导入）
    if let Some(old) = &old_id {
        crate::mcp::unregister_stdio(&ctx.mcp_stdio, old);
        ctx.mcp.lock().unwrap().retain(|s| s.id != *old);
        {
            let mut tools = ctx.tools.lock().unwrap();
            tools.retain(|t| match &t.kind {
                crate::registry::ToolKind::Mcp { server_id, .. } => server_id != old,
                _ => true,
            });
        }
        ctx.save_tools();
    }
    ctx.mcp.lock().unwrap().push(server.clone());
    ctx.save_mcp();
    // 握手成功的会话直接入注册表（模仿 register_stdio 的插入方式，避免二次 spawn）
    ctx.mcp_stdio.lock().unwrap().insert(id.clone(), session);
    crate::audit::record(ctx, "local-app", "mcp.add_stdio", &name, json!({ "command": server.command, "args": server.args }), true);
    Ok(json!({ "server": server, "id": id }))
}

/// 暂停 / 继续某个 MCP 服务器（暂停后其全部工具拒绝调用）
pub async fn mcp_toggle(ctx: &Arc<Ctx>, id: String, enabled: bool) -> Result<serde_json::Value, String> {
    // stdio 传输：继续时先拉起进程（失败保持暂停状态并报错）；暂停时杀掉子进程
    let server = crate::mcp::find(ctx, &id).ok_or("MCP 服务器不存在")?;
    if server.transport == crate::mcp::McpTransport::Stdio {
        if enabled {
            crate::mcp::ensure_stdio(ctx, &server).await?;
        } else {
            crate::mcp::unregister_stdio(&ctx.mcp_stdio, &id);
        }
    }
    let name = {
        let mut list = ctx.mcp.lock().unwrap();
        let s = list.iter_mut().find(|s| s.id == id).ok_or("MCP 服务器不存在")?;
        s.enabled = enabled;
        s.name.clone()
    };
    ctx.save_mcp();
    crate::audit::record(ctx, "local-app", if enabled { "mcp.enable" } else { "mcp.disable" }, &name, json!({ "enabled": enabled }), true);
    Ok(json!({ "id": id, "enabled": enabled }))
}

/// 移除接入（其导入的工具同步移除）
pub async fn mcp_remove(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    // stdio 传输：先杀掉子进程（http 无注册表条目，no-op）
    crate::mcp::unregister_stdio(&ctx.mcp_stdio, &id);
    let removed = {
        let mut list = ctx.mcp.lock().unwrap();
        let before = list.len();
        list.retain(|s| s.id != id);
        list.len() != before
    };
    if !removed {
        return Err("MCP 服务器不存在".into());
    }
    // 同步移除该服务器导入的工具
    {
        let mut tools = ctx.tools.lock().unwrap();
        tools.retain(|t| match &t.kind {
            crate::registry::ToolKind::Mcp { server_id, .. } => server_id != &id,
            _ => true,
        });
    }
    ctx.save_mcp();
    ctx.save_tools();
    crate::audit::record(ctx, "local-app", "mcp.remove", &id, json!({}), true);
    Ok(json!({ "removed": id }))
}

/// 重新拉取某服务器的工具清单并导入注册中心（同名跳过）
pub async fn mcp_import(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    let server = crate::mcp::find(ctx, &id).ok_or("MCP 服务器不存在")?;
    // stdio：先确保子进程已拉起（重启后懒恢复）再走 dispatch；http 原样
    let tools = if server.transport == crate::mcp::McpTransport::Stdio {
        crate::mcp::ensure_stdio(ctx, &server).await?;
        crate::mcp::list_tools_dispatch(&server, Some(&ctx.mcp_stdio)).await?
    } else {
        crate::mcp::list_tools(&server).await?
    };
    let mut imported = 0usize;
    let mut skipped = 0usize;
    for t in &tools {
        let ok = crate::registry::register(
            ctx,
            &t.name,
            &format!("{}（MCP · {}）", t.description, server.name),
            if t.input_schema.is_null() || !t.input_schema.is_object() {
                json!({"type": "object", "properties": {}, "additionalProperties": true})
            } else {
                t.input_schema.clone()
            },
            crate::registry::ToolKind::Mcp { server_id: id.clone(), tool: t.name.clone() },
            "mcp",
        );
        match ok {
            Ok(_) => imported += 1,
            Err(_) => skipped += 1,
        }
    }
    crate::audit::record(ctx, "local-app", "mcp.import", &server.name, json!({ "imported": imported, "skipped": skipped }), true);
    Ok(json!({ "imported": imported, "skipped": skipped, "total": tools.len() }))
}

/// ── WorkWith 本地服务托管 ──

/// 条目列表 + 运行态
pub fn list_workwith(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    Ok(crate::workwith::list(ctx))
}

/// 条目保存（新增或更新）
pub fn save_workwith(ctx: &Arc<Ctx>, entry: serde_json::Value) -> Result<serde_json::Value, String> {
    crate::workwith::save(ctx, entry)
}

/// 条目删除（运行中先停止并解绑 MCP）
pub async fn remove_workwith(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    crate::workwith::remove(ctx, &id).await
}

/// 手动启动
pub async fn start_workwith(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    crate::workwith::start(ctx, &id).await
}

/// 手动停止
pub async fn stop_workwith(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    crate::workwith::stop(ctx, &id).await
}

/// 实时日志（tail = 只取尾部 N 行）
pub fn workwith_logs(id: String, tail: Option<u64>) -> Result<serde_json::Value, String> {
    Ok(crate::workwith::logs_of(&id, tail.map(|n| n as usize)))
}

/// 手动压缩会话：用 AI 把全部历史总结为一条摘要（system 消息），释放上下文空间。
/// 摘要写入会话后返回新消息列表；压缩不影响会话本身，可继续对话。
pub async fn compress_session(ctx: &Arc<Ctx>, session_id: String) -> Result<serde_json::Value, String> {
    let target = if session_id.is_empty() {
        ctx.sessions.lock().unwrap().active.clone()
    } else {
        session_id
    };

    // 取出历史（在锁外进行 AI 调用，避免阻塞其他会话）
    let history: Vec<crate::ai::ChatMessage> = {
        let store = ctx.sessions.lock().unwrap();
        let sess = store
            .sessions
            .iter()
            .find(|s| s.id == target)
            .ok_or("会话不存在")?;
        sess.messages.iter().filter(|m| m.role != "system").cloned().collect()
    };
    if history.len() < 4 {
        return Err("对话内容太少，无需压缩".into());
    }

    let mut convo = vec![crate::ai::ChatMessage::system(
        "你是对话压缩助手。请把下面这段 AI 对话历史浓缩成一份结构化中文摘要，保留：用户的需求与偏好、已达成的结论、关键事实与数据、未完成的待办。直接输出摘要正文，不要寒暄，控制在 800 字以内。",
    )];
    for m in &history {
        let who = if m.role == "user" { "用户" } else { "AI" };
        convo.push(crate::ai::ChatMessage::user(format!("【{who}】{}", m.content)));
    }
    let summary = crate::ai::chat(ctx, &convo).await?;

    // 用摘要替换全部历史（摘要以 system 消息存放，前端气泡不显示）
    let before = {
        let mut store = ctx.sessions.lock().unwrap();
        let sess = store.get_mut(&target).ok_or("会话不存在")?;
        let n = sess.messages.len();
        sess.messages = vec![crate::ai::ChatMessage::system(format!(
            "以下是对此前对话的压缩摘要，请结合它继续对话：\n\n{summary}"
        ))];
        sess.touch();
        n
    };
    crate::session::persist(ctx);
    crate::audit::record(ctx, "local-app", "session.compress", &target, json!({ "messages_before": before }), true);
    Ok(json!({
        "messages": ctx.sessions.lock().unwrap()
            .sessions.iter().find(|s| s.id == target)
            .map(|s| s.messages.clone()).unwrap_or_default(),
        "summary": summary,
        "messages_before": before
    }))
}

// ---------- 会话（多对话分组） ----------

/// 列出所有会话（不含完整消息，仅元信息 + 预览），并返回当前激活会话 id
pub fn list_sessions(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    crate::session::refresh_from_disk(ctx);
    let store = ctx.sessions.lock().unwrap();
    let mut list: Vec<serde_json::Value> = store
        .sessions
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "title": s.title,
                "created": s.created,
                "updated": s.updated,
                "count": s.messages.iter().filter(|m| m.role != "system").count(),
                "preview": s.preview(),
                "favorite": s.favorite,
                "color": s.color,
            })
        })
        .collect();
    // 收藏的置顶；其余按最近更新排序
    list.sort_by(|a, b| {
        let fa = a["favorite"].as_bool().unwrap_or(false);
        let fb = b["favorite"].as_bool().unwrap_or(false);
        fb.cmp(&fa).then_with(|| {
            b["updated"].as_str().unwrap_or("").cmp(a["updated"].as_str().unwrap_or(""))
        })
    });
    Ok(json!({ "sessions": list, "active": store.active }))
}

/// 读取某会话的完整消息（session_id 为空则读激活会话）
pub fn get_session(ctx: &Arc<Ctx>, session_id: String) -> Result<serde_json::Value, String> {
    crate::session::refresh_from_disk(ctx);
    let store = ctx.sessions.lock().unwrap();
    let id = if session_id.is_empty() { store.active.clone() } else { session_id };
    let msgs = store
        .sessions
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.messages.clone())
        .unwrap_or_default();
    Ok(json!({ "id": id, "messages": msgs }))
}

/// 新建会话并设为激活
pub fn create_session(ctx: &Arc<Ctx>, title: String) -> Result<serde_json::Value, String> {
    let id;
    {
        let mut store = ctx.sessions.lock().unwrap();
        let s = crate::session::Session::new(&title);
        id = s.id.clone();
        store.sessions.push(s);
        store.active = id.clone();
    }
    ctx.save_sessions();
    Ok(json!({ "id": id }))
}

/// 切换激活会话
pub fn set_active_session(ctx: &Arc<Ctx>, session_id: String) -> Result<serde_json::Value, String> {
    {
        let mut store = ctx.sessions.lock().unwrap();
        if !store.sessions.iter().any(|s| s.id == session_id) {
            return Err("会话不存在".into());
        }
        store.active = session_id.clone();
    }
    ctx.save_sessions();
    Ok(json!({ "active": session_id }))
}

/// 重命名会话
pub fn rename_session(ctx: &Arc<Ctx>, session_id: String, title: String) -> Result<serde_json::Value, String> {
    {
        let mut store = ctx.sessions.lock().unwrap();
        let s = store.get_mut(&session_id).ok_or("会话不存在")?;
        let t = title.trim();
        s.title = if t.is_empty() { "未命名".into() } else { t.to_string() };
    }
    ctx.save_sessions();
    Ok(json!({ "renamed": true }))
}

/// 删除会话（删完若为空自动补一个默认会话；删的是激活项则切到最近一条）
pub fn delete_session(ctx: &Arc<Ctx>, session_id: String) -> Result<serde_json::Value, String> {
    let active;
    {
        let mut store = ctx.sessions.lock().unwrap();
        store.sessions.retain(|s| s.id != session_id);
        if store.sessions.is_empty() {
            let s = crate::session::Session::new("新对话");
            store.active = s.id.clone();
            store.sessions.push(s);
        } else if store.active == session_id {
            store.active = store.sessions.last().map(|s| s.id.clone()).unwrap_or_default();
        }
        active = store.active.clone();
    }
    // 级联清理该会话派生的目标/待办（否则删对话后"活跃计划"残留且无法删除）
    let ids: std::collections::HashSet<String> = [session_id.clone()].into_iter().collect();
    purge_plan_for_sessions(ctx, &ids);
    ctx.save_sessions();
    Ok(json!({ "deleted": true, "active": active }))
}

/// 删除会话的级联清理：该会话派生的目标/待办一并删除（内存 + 行级表）。
/// 目标被删后，挂在目标下的待办（即使创建于其他会话）也一并清理，避免孤儿数据。
pub fn purge_plan_for_sessions(ctx: &Arc<Ctx>, ids: &std::collections::HashSet<String>) {
    {
        let mut goals = ctx.goals.lock().unwrap();
        goals.retain(|g| g.session_id.as_deref().map_or(true, |s| !ids.contains(s)));
        let live: std::collections::HashSet<&str> = goals.iter().map(|g| g.id.as_str()).collect();
        let mut todos = ctx.todos.lock().unwrap();
        todos.retain(|t| {
            let own = t.session_id.as_deref().map_or(false, |s| ids.contains(s));
            let orphan = t.goal_id.as_deref().map_or(false, |gid| !live.contains(gid));
            !own && !orphan
        });
    }
    // 表侧：行级 SQL 精确删除（goals.session_id / todos.goal_id 有索引）
    let db = ctx.db.lock().unwrap();
    for sid in ids {
        let _ = db.execute("DELETE FROM todos WHERE session_id = ?1", [sid]);
        let _ = db.execute("DELETE FROM goals WHERE session_id = ?1", [sid]);
    }
    // 孤儿待办：挂在已删除目标下（在目标删除后统一清一次）
    let _ = db.execute(
        "DELETE FROM todos WHERE goal_id IS NOT NULL AND goal_id NOT IN (SELECT id FROM goals)",
        [],
    );
}

/// 收藏 / 取消收藏会话（收藏的会话置顶，批量删除时受保护）
pub fn set_session_favorite(ctx: &Arc<Ctx>, session_id: String, favorite: bool) -> Result<serde_json::Value, String> {
    {
        let mut store = ctx.sessions.lock().unwrap();
        let s = store.get_mut(&session_id).ok_or("会话不存在")?;
        s.favorite = favorite;
    }
    ctx.save_sessions();
    Ok(json!({ "favorite": favorite }))
}

/// 设置会话彩色标签（color：十六进制色值或空串=清除）
pub fn set_session_color(ctx: &Arc<Ctx>, session_id: String, color: String) -> Result<serde_json::Value, String> {
    {
        let mut store = ctx.sessions.lock().unwrap();
        let s = store.get_mut(&session_id).ok_or("会话不存在")?;
        let c = color.trim().to_string();
        s.color = if c.starts_with('#') && c.len() >= 4 { c } else { String::new() };
    }
    ctx.save_sessions();
    Ok(json!({ "color": color }))
}

/// 批量删除会话（收藏的会话自动跳过，不会删除）；删空后自动补一个默认会话
pub fn delete_sessions(ctx: &Arc<Ctx>, session_ids: Vec<String>) -> Result<serde_json::Value, String> {
    let mut deleted = 0usize;
    let mut skipped = 0usize;
    let mut removed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let active;
    {
        let mut store = ctx.sessions.lock().unwrap();
        let ids: std::collections::HashSet<String> = session_ids.into_iter().collect();
        store.sessions.retain(|s| {
            if !ids.contains(&s.id) {
                true
            } else if s.favorite {
                skipped += 1;
                true
            } else {
                deleted += 1;
                removed.insert(s.id.clone());
                false
            }
        });
        if store.sessions.is_empty() {
            let s = crate::session::Session::new("新对话");
            store.active = s.id.clone();
            store.sessions.push(s);
        } else if ids.contains(&store.active) && !store.sessions.iter().any(|s| s.id == store.active) {
            store.active = store.sessions.last().map(|s| s.id.clone()).unwrap_or_default();
        }
        active = store.active.clone();
    }
    // 级联清理被删会话（收藏被跳过不删）派生的目标/待办
    if !removed.is_empty() {
        purge_plan_for_sessions(ctx, &removed);
    }
    ctx.save_sessions();
    Ok(json!({ "deleted": deleted, "skipped": skipped, "active": active }))
}

/// 清空某会话的消息（保留会话本身）
pub fn clear_session(ctx: &Arc<Ctx>, session_id: String) -> Result<serde_json::Value, String> {
    {
        let mut store = ctx.sessions.lock().unwrap();
        let id = if session_id.is_empty() { store.active.clone() } else { session_id };
        let s = store.get_mut(&id).ok_or("会话不存在")?;
        s.messages.clear();
        s.touch();
    }
    ctx.save_sessions();
    Ok(json!({ "cleared": true }))
}

// ---------- 记忆 / 技能 / Autopilot ----------

pub fn list_memories(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let mut mem = ctx.memories.lock().unwrap().clone();
    mem.reverse();
    Ok(json!({ "memories": mem }))
}

pub fn add_memory(ctx: &Arc<Ctx>, content: String) -> Result<serde_json::Value, String> {
    if content.trim().is_empty() {
        return Err("记忆内容不能为空".into());
    }
    let m = crate::memory::add_memory(ctx, &content, "raw", "user");
    crate::audit::record(ctx, "local-user", "memory.add", "memories", json!({}), true);
    Ok(json!({ "memory": m }))
}

/// 批量删除记忆（单条删除传一个元素的数组即可）
pub fn delete_memories(ctx: &Arc<Ctx>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    if ids.is_empty() {
        return Err("未选择要删除的记忆".into());
    }
    let removed = crate::memory::delete_memories(ctx, &ids);
    crate::audit::record(
        ctx,
        "local-user",
        "memory.delete",
        "memories",
        json!({ "count": removed }),
        true,
    );
    Ok(json!({ "removed": removed }))
}

pub fn list_skills(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let mut skills = ctx.skills.lock().unwrap().clone();
    skills.reverse();
    Ok(json!({ "skills": skills }))
}

pub fn add_skill(
    ctx: &Arc<Ctx>,
    name: String,
    summary: String,
) -> Result<serde_json::Value, String> {
    if name.trim().is_empty() || summary.trim().is_empty() {
        return Err("技能名称与说明不能为空".into());
    }
    let s = crate::memory::add_skill(ctx, &name, &summary, "user");
    crate::audit::record(ctx, "local-user", "skill.add", &name, json!({}), true);
    Ok(json!({ "skill": s }))
}

/// 批量删除技能（单条删除传一个元素的数组即可）
pub fn delete_skills(ctx: &Arc<Ctx>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    if ids.is_empty() {
        return Err("未选择要删除的技能".into());
    }
    let removed = crate::memory::delete_skills(ctx, &ids);
    crate::audit::record(
        ctx,
        "local-user",
        "skill.delete",
        "skills",
        json!({ "count": removed }),
        true,
    );
    Ok(json!({ "removed": removed }))
}

/// 自动运行开关：控制后台自主循环（记忆总结 / 技能提炼 / 目标行动）。
/// 早期版本有聊天页的「小圆片」播放/暂停 UI；现收敛为 AI 设置里的一个小圆钮。
pub fn toggle_autopilot(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let next = !ctx.autopilot_running.load(Ordering::SeqCst);
    ctx.autopilot_running.store(next, Ordering::SeqCst);
    crate::audit::record(
        ctx,
        "local-user",
        "autopilot.toggle",
        if next { "play" } else { "pause" },
        json!({}),
        true,
    );
    // 通知各窗口刷新小圆钮状态（App 侧另有 overview 轮询兜底）
    ctx.emit("autopilot-changed", json!(next));
    Ok(json!({ "running": next }))
}

// ---------- 目标 / 待办 ----------

pub fn list_goals(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let mut goals = ctx.goals.lock().unwrap().clone();
    goals.reverse();
    Ok(json!({ "goals": goals }))
}

pub fn create_goal(
    ctx: &Arc<Ctx>,
    title: String,
    detail: String,
) -> Result<serde_json::Value, String> {
    let g = crate::goal::create_goal(ctx, &title, &detail, "user", None)?;
    crate::audit::record(ctx, "local-user", "goal.create", &g.title, json!({}), true);
    Ok(json!({ "goal": g }))
}

pub fn update_goal_status(
    ctx: &Arc<Ctx>,
    id: String,
    status: String,
) -> Result<serde_json::Value, String> {
    let g = crate::goal::update_goal_status(ctx, &id, &status)?;
    crate::audit::record(ctx, "local-user", "goal.update", &g.title, json!({ "status": status }), true);
    Ok(json!({ "goal": g }))
}

pub fn remove_goal(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    crate::goal::remove_goal(ctx, &id)?;
    crate::audit::record(ctx, "local-user", "goal.remove", "goal", json!({}), true);
    Ok(json!({ "removed": true }))
}

pub fn list_todos(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let mut todos = ctx.todos.lock().unwrap().clone();
    todos.reverse();
    Ok(json!({ "todos": todos }))
}

pub fn add_todo(
    ctx: &Arc<Ctx>,
    content: String,
    goal_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let t = crate::goal::add_todo(ctx, goal_id, &content, "user", None)?;
    crate::audit::record(ctx, "local-user", "todo.add", &t.content, json!({}), true);
    Ok(json!({ "todo": t }))
}

pub fn update_todo_status(
    ctx: &Arc<Ctx>,
    id: String,
    status: String,
) -> Result<serde_json::Value, String> {
    let t = crate::goal::update_todo_status(ctx, &id, &status)?;
    crate::audit::record(ctx, "local-user", "todo.update", &t.content, json!({ "status": status }), true);
    Ok(json!({ "todo": t }))
}

pub fn remove_todo(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    crate::goal::remove_todo(ctx, &id)?;
    crate::audit::record(ctx, "local-user", "todo.remove", "todo", json!({}), true);
    Ok(json!({ "removed": true }))
}

// ---------- 文件打开 ----------

/// 用系统默认程序打开文件；reveal=true 时打开所在文件夹并定位该文件
pub fn open_path(ctx: &Arc<Ctx>, path: String, reveal: Option<bool>) -> Result<serde_json::Value, String> {
    let cleaned = crate::paths::normalize_user_path(&path);
    let mut p = std::path::PathBuf::from(&cleaned);
    if !p.exists() && p.is_relative() {
        // 兼容旧卡片里的相对路径：send_file 曾原样存储 AI 给的路径
        p = ctx.data_dir.join(&p);
    }
    if !p.exists() {
        return Err(format!("路径不存在: {cleaned}"));
    }
    // 绝对化：消除符号链接与相对段，确保 Finder/资源管理器定位到真实位置
    let abs = std::fs::canonicalize(&p).unwrap_or(p);
    open_target(&abs, reveal.unwrap_or(false))?;
    Ok(json!({ "ok": true }))
}

/// 用系统默认浏览器打开外部链接（更新提示、官网等）
pub fn open_external(url: String) -> Result<serde_json::Value, String> {
    // 只允许 http(s)，防止任意命令注入
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("仅支持 http(s) 链接".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // 不能用 `cmd /C start` 中转：URL 查询串普遍含 &，无空格时 std 不加引号，
        // cmd.exe 会把 & 当命令分隔符（如 https://x/?a=1&calc 会执行 calc）→ 注入。
        // rundll32 FileProtocolHandler 直接调系统 URL 关联处理，不经 cmd
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]);
        crate::registry::no_window(&mut c); // rundll32 是 console 子系统，不闪黑窗
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map_err(|e| format!("打开浏览器失败: {e}"))?;
    Ok(json!({ "ok": true }))
}

// ---------- 诊断 / 工具质量 ----------

/// 工具质量评估快照：每工具近期成功率 / 累计成败 / 平均耗时 / 最近失败原因（失败次数降序）
pub fn get_tool_stats(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    Ok(crate::state::toolstats::snapshot(ctx))
}

/// 诊断报告：版本 / 平台 / 提权 / 守护 / 运行时长 / 数据文件清单 / 最近崩溃 / 低成功率工具，
/// 一键自检排障所需的最小信息集
pub fn get_diagnostics(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.config.lock().unwrap().clone();
    let (sessions_n, messages_n, tools_n, tools_on) = {
        let sessions = ctx.sessions.lock().unwrap();
        let tools = ctx.tools.lock().unwrap();
        (
            sessions.sessions.len(),
            sessions.sessions.iter().map(|s| s.messages.len()).sum::<usize>(),
            tools.len(),
            tools.iter().filter(|t| t.enabled).count(),
        )
    };
    // 数据存储清单（SQLite 迁移后如实报告）：
    //   - bit.db：配置/会话/工具/记忆/技能/审计等真实数据所在（SQLite + 双重加密）
    //   - 仍在使用的边车文件：守护握手 / 守护与崩溃日志
    //   - legacy JSON（config.json / audit.json / sessions.json 等）已完成一次性导入并改名
    //     .migrated，不再列出——列出来只会是常驻的"缺失"误报
    let file = |name: &str, optional: bool| -> serde_json::Value {
        let p = ctx.data_dir.join(name);
        json!({
            "name": name,
            "exists": p.exists(),
            "bytes": std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0),
            "optional": optional,
        })
    };
    let required: &[&str] = &["bit.db", "guardian.json"];
    let optional: &[&str] = &["guardian.log", "crash.log"];
    let mut files: Vec<serde_json::Value> = required.iter().map(|n| file(n, false)).collect();
    files.extend(optional.iter().map(|n| file(n, true)));
    // 低成功率工具：有失败记录的取前 5（快照已按失败次数降序）
    let stats = crate::state::toolstats::snapshot(ctx);
    let worst: Vec<serde_json::Value> = stats
        .as_array()
        .map(|a| a.iter().filter(|t| t["fail"].as_u64().unwrap_or(0) > 0).take(5).cloned().collect())
        .unwrap_or_default();
    Ok(json!({
        "version": ctx.app_version,
        "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "elevated": is_elevated(),
        "uptime_secs": ctx.started.elapsed().as_secs(),
        "remote": { "enabled": cfg.remote_enabled, "port": cfg.port },
        "sessions": { "count": sessions_n, "messages": messages_n },
        "tools": { "total": tools_n, "enabled": tools_on },
        "data_dir": ctx.data_dir.display().to_string(),
        "files": files,
        "worst_tools": worst,
        "guardian": crate::guardian::diagnose(&ctx.data_dir, &cfg.client_key),
        "crashes": crate::crash::tail(&ctx.data_dir, 5),
    }))
}

/// 查询高权限状态：active=当前进程实际已提权；enabled=配置意图（两者可能不一致：
/// 授权弹窗被取消时配置保持开启但进程未提权）
pub fn get_elevation(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    Ok(json!({
        "active": is_elevated(),
        "enabled": ctx.config.lock().unwrap().elevated,
    }))
}

// ═══════════════════════════════════════════════════════════════════════════
// 安全中心：HiddenCode 敏感信息脱敏 + L2 PASS 二级模型审核
// ═══════════════════════════════════════════════════════════════════════════

/// HiddenCode 条目列表（本机 UI 信任边界内返回明文）
pub fn get_hidden_codes(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    Ok(json!(ctx.hidden_codes.lock().unwrap().clone()))
}

/// 新增 HiddenCode 条目。as_pattern=true 且 kind 有内置正则（value 留空或填 builtin:xxx）
/// → pattern 条目；否则 value 条目（value 必填）
pub fn add_hidden_code(
    ctx: &Arc<Ctx>,
    kind: String,
    value: String,
    as_pattern: bool,
    alias: String,
) -> Result<serde_json::Value, String> {
    let value = value.trim().to_string();
    let entry = if as_pattern {
        if value.is_empty() {
            // 值留空 → 用内置正则名
            let pattern = match kind.as_str() {
                "phone" => "builtin:phone",
                "email" => "builtin:email",
                "apikey" => "builtin:apikey",
                other => return Err(format!("类型 {other} 无内置正则，自定义正则请填写在值里")),
            };
            crate::hidden_code::HiddenCodeEntry {
                id: String::new(),
                kind: "pattern".into(),
                label: kind,
                value: pattern.into(),
                alias: String::new(),
                enabled: true,
                created: crate::ai::now_ts(),
            }
        } else {
            // 值非空且 as_pattern → 视为自定义正则（校验合法性）
            regex::Regex::new(&value).map_err(|e| format!("非法正则: {e}"))?;
            crate::hidden_code::HiddenCodeEntry {
                id: String::new(),
                kind: "pattern".into(),
                label: "custom".into(),
                value,
                alias: String::new(),
                enabled: true,
                created: crate::ai::now_ts(),
            }
        }
    } else {
        if value.is_empty() {
            return Err("值不能为空（若要按类型掩码请勾选模式）".into());
        }
        crate::hidden_code::HiddenCodeEntry {
            id: String::new(),
            kind: "value".into(),
            label: kind,
            value,
            alias: String::new(), // value 条目随后由 alias 参数覆盖
            enabled: true,
            created: crate::ai::now_ts(),
        }
    };
    let mut codes = ctx.hidden_codes.lock().unwrap();
    // id 自增（数字串，对齐 memories/skills 惯例）
    let max_id: u64 = codes.iter().filter_map(|e| e.id.parse::<u64>().ok()).max().unwrap_or(0);
    let mut entry = entry;
    entry.id = (max_id + 1).to_string();
    // 别名仅对 value 条目生效：AI 看到别名而非 [HC:] 占位符（如 小明 → 李四）
    if entry.kind == "value" {
        entry.alias = alias.trim().to_string();
    }
    codes.push(entry);
    drop(codes);
    ctx.save_hidden_codes();
    Ok(json!({ "ok": true }))
}

/// 删除 HiddenCode 条目
pub fn remove_hidden_code(ctx: &Arc<Ctx>, id: String) -> Result<serde_json::Value, String> {
    {
        let mut codes = ctx.hidden_codes.lock().unwrap();
        let before = codes.len();
        codes.retain(|e| e.id != id);
        if codes.len() == before {
            return Err(format!("条目 {id} 不存在"));
        }
    }
    ctx.save_hidden_codes();
    Ok(json!({ "ok": true }))
}

/// 启停单个 HiddenCode 条目
pub fn set_hidden_code_enabled(
    ctx: &Arc<Ctx>,
    id: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    {
        let mut codes = ctx.hidden_codes.lock().unwrap();
        match codes.iter_mut().find(|e| e.id == id) {
            Some(e) => e.enabled = enabled,
            None => return Err(format!("条目 {id} 不存在")),
        }
    }
    ctx.save_hidden_codes();
    Ok(json!({ "ok": true }))
}

/// 正则自动探测（录入辅助，不落盘）：返回 [{label, value}] 候选
pub fn scan_hidden_candidates(text: String) -> Result<serde_json::Value, String> {
    Ok(json!(crate::hidden_code::detect_candidates(&text)
        .into_iter()
        .map(|(label, value)| json!({ "label": label, "value": value }))
        .collect::<Vec<_>>()))
}

/// 安全设置读取（HiddenCode / L2 PASS）
pub fn get_security_settings(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let cfg = ctx.config.lock().unwrap();
    Ok(json!({
        "hidden_code_enabled": cfg.hidden_code_enabled,
        "l2pass_enabled": cfg.l2pass_enabled,
        "l2pass_provider_id": cfg.l2pass_provider_id,
        "l2pass_cover_auto": cfg.l2pass_cover_auto,
    }))
}

/// 安全设置保存。L2 开启时必须已选审核 provider。
/// 宽松语义：未传的参数保持原值（历史教训：硬必填导致旧调用方/远程端少传一个字段直接报
/// "缺少参数: l2pass_enabled"，设置页整页保存失败）
/// 校验范围收窄：只在本次触碰 L2（从关到开 / 换 provider）时把关——
/// 否则 provider 被删后的残留态（l2_enabled=true 但 id 失效）会卡死脱敏开关等无关保存
/// 返回更新后的完整设置（历史教训：曾返回 {ok:true}，前端整包覆盖状态后开关全部失灵）
pub fn set_security_settings(
    ctx: &Arc<Ctx>,
    hidden_code_enabled: Option<bool>,
    l2pass_enabled: Option<bool>,
    l2pass_provider_id: Option<String>,
    l2pass_cover_auto: Option<bool>,
) -> Result<serde_json::Value, String> {
    let (hce, l2, pid, ca, need_check) = {
        let cfg = ctx.config.lock().unwrap();
        let l2 = l2pass_enabled.unwrap_or(cfg.l2pass_enabled);
        let pid = l2pass_provider_id.clone().unwrap_or_else(|| cfg.l2pass_provider_id.clone());
        // 触碰判定：显式开了 L2，或显式换了 provider（残留态原样透传时不拦截）
        let touch = l2pass_enabled.map(|v| v && !cfg.l2pass_enabled).unwrap_or(false)
            || l2pass_provider_id.as_deref().map(|p| p != cfg.l2pass_provider_id).unwrap_or(false);
        (
            hidden_code_enabled.unwrap_or(cfg.hidden_code_enabled),
            l2,
            pid,
            l2pass_cover_auto.unwrap_or(cfg.l2pass_cover_auto),
            touch,
        )
    };
    if need_check && l2 {
        let known = ctx
            .ai_config
            .lock()
            .unwrap()
            .providers
            .iter()
            .any(|p| p.id == pid);
        if pid.is_empty() || !known {
            return Err("请先选择一个已配置的审核 provider".into());
        }
    }
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.hidden_code_enabled = hce;
        cfg.l2pass_enabled = l2;
        cfg.l2pass_provider_id = pid.clone();
        cfg.l2pass_cover_auto = ca;
        cfg.revision += 1;
    }
    ctx.save_config();
    Ok(json!({
        "ok": true,
        "hidden_code_enabled": hce,
        "l2pass_enabled": l2,
        "l2pass_provider_id": pid,
        "l2pass_cover_auto": ca,
    }))
}

// ---------- 界面语言（数据库统一标记）----------

/// 读界面语言：config.language（"zh"|"en"，空值视作 "zh"）。
/// 前端 i18n 与 Electron 托盘/任务面板统一从这里取，避免 localStorage 只在渲染层可见
pub fn get_language(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let lang = ctx.config.lock().unwrap().language.clone();
    Ok(json!({ "language": if lang.is_empty() { "zh" } else { lang.as_str() } }))
}

/// 写界面语言（前端 setLang 时调用）。仅接受 "zh"/"en"，其他值忽略
pub fn set_language(ctx: &Arc<Ctx>, language: String) -> Result<serde_json::Value, String> {
    if language != "zh" && language != "en" {
        return Err("language 仅支持 zh / en".into());
    }
    {
        let mut cfg = ctx.config.lock().unwrap();
        if cfg.language == language {
            return Ok(json!({ "ok": true, "language": language }));
        }
        cfg.language = language.clone();
        cfg.revision += 1;
    }
    ctx.save_config();
    Ok(json!({ "ok": true, "language": language }))
}

// ---------- 界面主题（数据库统一标记）----------

/// 读界面主题：config.theme（"light"|"dark"|"auto"，空值视作 "light"）。
/// 前端 useTheme 与 Electron 托盘/任务面板统一从这里取，避免 localStorage 只在渲染层可见
pub fn get_theme(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let theme = ctx.config.lock().unwrap().theme.clone();
    Ok(json!({ "theme": if theme.is_empty() { "light" } else { theme.as_str() } }))
}

/// 写界面主题（前端 setMode 时调用）。仅接受 "light"/"dark"/"auto"
pub fn set_theme(ctx: &Arc<Ctx>, theme: String) -> Result<serde_json::Value, String> {
    if theme != "light" && theme != "dark" && theme != "auto" {
        return Err("theme 仅支持 light / dark / auto".into());
    }
    {
        let mut cfg = ctx.config.lock().unwrap();
        if cfg.theme == theme {
            return Ok(json!({ "ok": true, "theme": theme }));
        }
        cfg.theme = theme.clone();
        cfg.revision += 1;
    }
    ctx.save_config();
    Ok(json!({ "ok": true, "theme": theme }))
}

// ---------- 更新 ----------

/// 自动更新开关状态（更新详情弹窗展示「不再更新/继续更新」用）
pub fn get_auto_update(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    Ok(json!({ "enabled": ctx.config.lock().unwrap().auto_update }))
}

/// 写自动更新开关：false = 启动不检测不静默下载（手动检查更新不受影响），立即持久化 bit.db
pub fn set_auto_update(ctx: &Arc<Ctx>, enabled: bool) -> Result<serde_json::Value, String> {
    {
        let mut cfg = ctx.config.lock().unwrap();
        if cfg.auto_update == enabled {
            return Ok(json!({ "ok": true, "enabled": enabled }));
        }
        cfg.auto_update = enabled;
        cfg.revision += 1;
    }
    ctx.save_config();
    Ok(json!({ "ok": true, "enabled": enabled }))
}

/// 手动触发下载当前平台更新包（启动后台任务会自动下；此处供 pill/远程 API 主动调用）
pub async fn update_download(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let status = crate::update::download_update(ctx).await?;
    ctx.emit("update-state", status.clone());
    Ok(status)
}

// ---------- 对话 ----------

/// 对话主循环入口：写入用户消息 → 模型回合（工具循环）→ 返回最新消息列表。
/// 任务完成提醒改为 notify-done 事件（原 notify_done 的系统通知由宿主 JS 侧消费事件实现）
pub async fn chat(
    ctx: &Arc<Ctx>,
    session_id: String,
    message: String,
    images: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let messages = crate::agent::chat_turn(ctx, &session_id, &message, images.unwrap_or_default()).await?;
    let title = ctx
        .sessions
        .lock()
        .unwrap()
        .sessions
        .iter()
        .find(|s| s.id == session_id)
        .map(|s| s.title.clone())
        .unwrap_or_default();
    let reply = messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .map(|m| crate::registry::safe_trunc(m.content.trim(), 80))
        .unwrap_or_default();
    ctx.emit("notify-done", json!({ "session_id": session_id, "title": title, "reply": reply }));
    Ok(json!({ "messages": messages }))
}

/// 流式对话：过程通过事件 `event_name` 推送增量，返回最终完整消息列表。
/// `images` 为可选的图片（base64 data URL），仅随当前用户轮发给多模态模型。
pub async fn chat_stream(
    ctx: &Arc<Ctx>,
    session_id: String,
    message: String,
    event_name: String,
    images: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let ev = if event_name.trim().is_empty() { "chat-stream".to_string() } else { event_name };
    let messages =
        crate::engine::chat_stream_auto(ctx, &session_id, &message, &ev, images.unwrap_or_default()).await?;
    let title = ctx
        .sessions
        .lock()
        .unwrap()
        .sessions
        .iter()
        .find(|s| s.id == session_id)
        .map(|s| s.title.clone())
        .unwrap_or_default();
    let reply = messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .map(|m| crate::registry::safe_trunc(m.content.trim(), 80))
        .unwrap_or_default();
    ctx.emit("notify-done", json!({ "session_id": session_id, "title": title, "reply": reply }));
    Ok(json!({ "messages": messages }))
}

/// 立即中断某会话正在执行的任务（执行循环在下个检查点停止）
pub async fn chat_interrupt(ctx: &Arc<Ctx>, session_id: String) -> Result<serde_json::Value, String> {
    crate::engine::interrupt(ctx, &session_id).await
}

/// 工具审批应答（允许 / 拒绝）
pub async fn tool_approve(ctx: &Arc<Ctx>, id: String, allow: bool) -> Result<serde_json::Value, String> {
    crate::engine::approve(ctx, &id, allow).await
}

/// 设置工具审批模式：ask（每次询问）/ auto（危险询问、安全自动通过）/ allow_all（完全放行）
pub async fn set_tool_approval(ctx: &Arc<Ctx>, mode: String) -> Result<serde_json::Value, String> {
    if !["ask", "auto", "allow_all"].contains(&mode.as_str()) {
        return Err("无效的审批模式".into());
    }
    {
        let mut cfg = ctx.config.lock().unwrap();
        cfg.tool_approval = mode.clone();
        cfg.revision += 1;
        cfg.save(&ctx.data_dir, &ctx.db.lock().unwrap());
    }
    crate::audit::record(ctx, "local-app", "tool.approval_mode", &mode, json!({ "mode": mode }), true);
    Ok(json!({ "mode": mode }))
}

/// 获取当前审批模式
pub async fn get_tool_approval(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    let mode = ctx.config.lock().unwrap().tool_approval.clone();
    Ok(json!({ "mode": mode }))
}
