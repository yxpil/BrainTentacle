// yxpil · BIT napi
//! 命令 dispatch：cmd 白名单查表 → bit-core::api / bit-core::commands_api 函数。
//! M1 代表性命令走 api::；A 类命令已自 src-tauri/commands.rs 迁入 commands_api，
//! 在此逐命令接线（参数用 arg 系助手提取，snake_case / camelCase 双兼容）。
//! B 类（save_file_as / set·get_autostart / set_hotkey / set_elevation / update_apply）
//! 与 qr_payload / estimate_context_tokens 不对外，由 Electron JS 层拦截或内部复用。
use std::sync::Arc;

use bit_core::state::Ctx;

/// 按 snake_case → camelCase 顺序取参数（Tauri invoke 的 JS camelCase 键与 Rust snake_case 双兼容）
fn arg<'a>(args: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    if let serde_json::Value::Object(m) = args {
        if let Some(v) = m.get(key) {
            return Some(v);
        }
        // camelCase：下划线后首字母大写
        let mut camel = String::with_capacity(key.len());
        let mut up = false;
        for ch in key.chars() {
            if ch == '_' {
                up = true;
            } else if up {
                camel.extend(ch.to_uppercase());
                up = false;
            } else {
                camel.push(ch);
            }
        }
        return m.get(&camel);
    }
    None
}

/// 必填字符串：缺失或非字符串报错（对齐 Tauri invoke 缺参即拒绝的语义）
fn a_str(args: &serde_json::Value, key: &str) -> Result<String, String> {
    match arg(args, key) {
        Some(serde_json::Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(format!("参数 {key} 需为字符串")),
        None => Err(format!("缺少参数: {key}")),
    }
}

fn opt_str(args: &serde_json::Value, key: &str) -> Option<String> {
    match arg(args, key) {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn a_bool(args: &serde_json::Value, key: &str) -> Result<bool, String> {
    match arg(args, key) {
        Some(serde_json::Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("参数 {key} 需为布尔值")),
        None => Err(format!("缺少参数: {key}")),
    }
}

fn opt_bool(args: &serde_json::Value, key: &str) -> Option<bool> {
    match arg(args, key) {
        Some(serde_json::Value::Bool(b)) => Some(*b),
        _ => None,
    }
}

fn a_u64(args: &serde_json::Value, key: &str) -> Result<u64, String> {
    match arg(args, key) {
        Some(v) => v.as_u64().ok_or_else(|| format!("参数 {key} 需为数字")),
        None => Err(format!("缺少参数: {key}")),
    }
}

fn opt_u64(args: &serde_json::Value, key: &str) -> Option<u64> {
    arg(args, key).and_then(|v| v.as_u64())
}

/// 任意 JSON 参数：缺省 Null
fn a_val(args: &serde_json::Value, key: &str) -> serde_json::Value {
    arg(args, key).cloned().unwrap_or(serde_json::Value::Null)
}

/// 数组参数：存在且为数组时返回克隆，否则 None（保留给后续接线的数组型命令）
#[allow(dead_code)]
fn opt_arr(args: &serde_json::Value, key: &str) -> Option<Vec<serde_json::Value>> {
    arg(args, key).and_then(|v| v.as_array()).cloned()
}

/// 必填字符串数组（delete_memories / delete_skills / delete_sessions / save_stun_servers）
fn a_str_vec(args: &serde_json::Value, key: &str) -> Result<Vec<String>, String> {
    match arg(args, key).and_then(|v| v.as_array()) {
        Some(a) => Ok(a.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        None => Err(format!("缺少参数或参数需为数组: {key}")),
    }
}

/// 可选字符串数组（chat / chat_stream 的 images、blocked_words）
fn opt_str_vec(args: &serde_json::Value, key: &str) -> Option<Vec<String>> {
    arg(args, key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
}

/// 字符串映射参数（mcp_add_stdio 的 env）：非字符串值跳过，缺省空表
fn a_str_map(args: &serde_json::Value, key: &str) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    if let Some(o) = arg(args, key).and_then(|v| v.as_object()) {
        for (k, v) in o {
            if let Some(s) = v.as_str() {
                m.insert(k.clone(), s.to_string());
            }
        }
    }
    m
}

/// 单一入口：与 Tauri 壳 invoke 同语义 —— 白名单外一律拒绝
pub async fn dispatch(
    ctx: &Arc<Ctx>,
    cmd: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match cmd {
        // ---------- M1 代表性命令（api.rs） ----------
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
        // Electron 启动链（Tauri setup 等价物）：守护布防/toolhomes/插件/HTTP/autopilot/自动更新
        "bootstrap_services" => Ok(bit_core::api::bootstrap_services(ctx)),
        "install_cli" => bit_core::api::install_cli(ctx),

        // ---------- 工具 ----------
        "register_tool" => {
            bit_core::commands_api::register_tool(
                ctx,
                a_str(&args, "name")?,
                a_str(&args, "description")?,
                a_str(&args, "url")?,
            )
            .await
        }
        "remove_tool" => bit_core::commands_api::remove_tool(ctx, a_str(&args, "id")?),
        "set_tool_enabled" => bit_core::commands_api::set_tool_enabled(ctx, a_str(&args, "id")?, a_bool(&args, "enabled")?),
        "invoke_tool" => {
            bit_core::commands_api::invoke_tool(ctx, a_str(&args, "id")?, a_val(&args, "params")).await
        }
        "register_script_tool" => {
            bit_core::commands_api::register_script_tool(
                ctx,
                a_str(&args, "name")?,
                a_str(&args, "description")?,
                a_str(&args, "runtime")?,
                a_str(&args, "code")?,
            )
        }

        // ---------- 解释器 / 运行时 ----------
        "list_runtimes" => bit_core::commands_api::list_runtimes(ctx),
        "refresh_runtimes" => bit_core::commands_api::refresh_runtimes(ctx),
        "add_runtime" => {
            bit_core::commands_api::add_runtime(
                ctx,
                a_str(&args, "id")?,
                a_str(&args, "name")?,
                a_str(&args, "path")?,
                a_str(&args, "lang")?,
            )
        }
        "remove_runtime" => bit_core::commands_api::remove_runtime(ctx, a_str(&args, "id")?),
        "set_runtime_enabled" => {
            bit_core::commands_api::set_runtime_enabled(ctx, a_str(&args, "id")?, a_bool(&args, "enabled")?)
        }
        "run_script" => {
            bit_core::commands_api::run_script(ctx, a_str(&args, "runtime")?, a_str(&args, "code")?, a_val(&args, "params"))
                .await
        }

        // ---------- 审计 ----------
        "list_audit" => bit_core::commands_api::list_audit(ctx),
        "clear_audit" => bit_core::commands_api::clear_audit(ctx),
        "delete_audit_entry" => bit_core::commands_api::delete_audit_entry(ctx, a_str(&args, "id")?),

        // ---------- 远程访问 ----------
        "get_remote_config" => bit_core::commands_api::get_remote_config(ctx),
        "save_remote_config" => {
            bit_core::commands_api::save_remote_config(
                ctx,
                a_bool(&args, "remote_enabled")?,
                a_str(&args, "host")?,
                a_u64(&args, "port")? as u16,
            )
            .await
        }
        "get_remote_status" => bit_core::commands_api::get_remote_status(ctx),
        "get_lan_info" => bit_core::commands_api::get_lan_info(ctx).await,
        "save_stun_servers" => bit_core::commands_api::save_stun_servers(ctx, a_str_vec(&args, "servers")?),
        "get_remote_qr" => bit_core::commands_api::get_remote_qr(ctx).await,
        "qr_svg_url" => bit_core::commands_api::qr_svg_url(a_str(&args, "url")?),
        "regenerate_client_key" => bit_core::commands_api::regenerate_client_key(ctx),
        "test_connectivity" => bit_core::commands_api::test_connectivity(ctx).await,
        "save_access_password" => {
            bit_core::commands_api::save_access_password(ctx, a_str(&args, "password")?, a_bool(&args, "password_enabled")?)
        }
        "regenerate_access_password" => bit_core::commands_api::regenerate_access_password(ctx),
        "save_cloud_relay" => bit_core::commands_api::save_cloud_relay(ctx, a_str(&args, "url")?),

        // ---------- 子代理 / 后台命令 ----------
        "subagent_spawn" => {
            bit_core::commands_api::subagent_spawn(
                ctx,
                a_str(&args, "task")?,
                opt_str(&args, "title"),
                opt_str(&args, "session_id"),
            )
            .await
        }
        "subagent_running" => bit_core::commands_api::subagent_running(),
        "stop_subagent" => bit_core::commands_api::stop_subagent(ctx, a_str(&args, "session_id")?),
        "cancel_shell" => bit_core::commands_api::cancel_shell(ctx, a_str(&args, "job_id")?).await,
        "list_running_shells" => bit_core::commands_api::list_running_shells().await,
        "get_shell_detail" => bit_core::commands_api::get_shell_detail(a_str(&args, "job_id")?).await,

        // ---------- 设置页 ----------
        "get_behavior_settings" => bit_core::commands_api::get_behavior_settings(ctx),
        "set_behavior_settings" => {
            bit_core::commands_api::set_behavior_settings(
                ctx,
                a_bool(&args, "auto_drive")?,
                a_str(&args, "tool_approval")?,
                a_bool(&args, "moderation_enabled")?,
                opt_bool(&args, "auto_delegate"),
                opt_bool(&args, "compat_mode"),
                opt_u64(&args, "subagent_max").map(|v| v as u32),
                opt_str_vec(&args, "blocked_words"),
            )
        }
        "get_guard_limits" => bit_core::commands_api::get_guard_limits(ctx),
        "set_guard_limits" => {
            bit_core::commands_api::set_guard_limits(
                ctx,
                a_u64(&args, "word_repeat_max")? as u32,
                a_u64(&args, "tool_loop_max")? as u32,
            )
        }
        "get_tool_env_settings" => bit_core::commands_api::get_tool_env_settings(ctx),
        "set_tool_env_settings" => {
            bit_core::commands_api::set_tool_env_settings(
                ctx,
                a_u64(&args, "tool_timeout_secs")? as u32,
                a_str(&args, "default_shell")?,
            )
        }
        "set_desktop_tools" => {
            bit_core::commands_api::set_desktop_tools(
                ctx,
                a_bool(&args, "screen")?,
                a_bool(&args, "mouse")?,
                a_bool(&args, "keyboard")?,
                a_bool(&args, "diagram")?,
                a_bool(&args, "viewimage")?,
            )
        }
        "get_desktop_tools" => bit_core::commands_api::get_desktop_tools(ctx),
        "get_custom_prompt" => bit_core::commands_api::get_custom_prompt(ctx),
        "set_custom_prompt" => bit_core::commands_api::set_custom_prompt(ctx, a_str(&args, "custom_prompt")?),
        "get_hotkey" => bit_core::commands_api::get_hotkey(ctx),
        "set_hotkey" => bit_core::commands_api::set_hotkey(ctx, a_str(&args, "hotkey")?.as_str()),
        "get_syntax_check" => bit_core::commands_api::get_syntax_check(ctx),
        "set_syntax_check" => bit_core::commands_api::set_syntax_check(ctx, a_bool(&args, "enabled")?),
        "get_system_prompt" => bit_core::commands_api::get_system_prompt(ctx),
        "set_system_prompt" => bit_core::commands_api::set_system_prompt(ctx, a_str(&args, "system_prompt")?),

        // ---------- 插件 ----------
        "list_plugins" => bit_core::commands_api::list_plugins(ctx),
        "toggle_plugin" => bit_core::commands_api::toggle_plugin(ctx, a_str(&args, "id")?, a_bool(&args, "enabled")?),
        "refresh_plugins" => bit_core::commands_api::refresh_plugins(ctx),

        // ---------- AI（多协议提供方） ----------
        "list_providers" => bit_core::commands_api::list_providers(ctx),
        "add_provider" => {
            bit_core::commands_api::add_provider(
                ctx,
                a_str(&args, "name")?,
                a_str(&args, "protocol")?,
                a_str(&args, "base_url")?,
                a_str(&args, "api_key")?,
                a_str(&args, "model")?,
            )
        }
        "update_provider" => {
            bit_core::commands_api::update_provider(
                ctx,
                a_str(&args, "id")?,
                a_str(&args, "name")?,
                a_str(&args, "protocol")?,
                a_str(&args, "base_url")?,
                a_str(&args, "api_key")?,
                a_str(&args, "model")?,
            )
        }
        "remove_provider" => bit_core::commands_api::remove_provider(ctx, a_str(&args, "id")?),
        "set_provider_active" => {
            bit_core::commands_api::set_provider_active(ctx, a_str(&args, "id")?, a_bool(&args, "active")?)
        }
        "get_ai_params" => bit_core::commands_api::get_ai_params(ctx),
        "set_ai_params" => {
            bit_core::commands_api::set_ai_params(
                ctx,
                arg(&args, "temperature").and_then(|v| v.as_f64()),
                a_str(&args, "reasoning_effort")?,
            )
        }
        "list_provider_models" => {
            bit_core::commands_api::list_provider_models(
                ctx,
                a_str(&args, "protocol")?,
                a_str(&args, "base_url")?,
                a_str(&args, "api_key")?,
            )
            .await
        }
        "context_preview" => bit_core::commands_api::context_preview(ctx, a_str(&args, "session_id")?).await,
        "context_metrics" => bit_core::commands_api::context_metrics(ctx, a_str(&args, "session_id")?).await,

        // ---------- 对话 ----------
        "chat" => {
            bit_core::commands_api::chat(
                ctx,
                a_str(&args, "session_id")?,
                a_str(&args, "message")?,
                opt_str_vec(&args, "images"),
            )
            .await
        }
        "chat_stream" => {
            bit_core::commands_api::chat_stream(
                ctx,
                a_str(&args, "session_id")?,
                a_str(&args, "message")?,
                a_str(&args, "event_name")?,
                opt_str_vec(&args, "images"),
            )
            .await
        }
        "chat_interrupt" => bit_core::commands_api::chat_interrupt(ctx, a_str(&args, "session_id")?).await,
        "tool_approve" => bit_core::commands_api::tool_approve(ctx, a_str(&args, "id")?, a_bool(&args, "allow")?).await,
        "set_tool_approval" => bit_core::commands_api::set_tool_approval(ctx, a_str(&args, "mode")?).await,
        "get_tool_approval" => bit_core::commands_api::get_tool_approval(ctx).await,

        // ---------- 附件 / 网页 / 端口 ----------
        "extract_file" => bit_core::commands_api::extract_file(a_str(&args, "filename")?, a_str(&args, "data")?).await,
        "fetch_webpage" => bit_core::commands_api::fetch_webpage(a_str(&args, "url")?).await,
        "check_port" => {
            bit_core::commands_api::check_port(a_str(&args, "host")?, a_u64(&args, "port")? as u16).await
        }

        // ---------- MCP ----------
        "mcp_discover" => {
            bit_core::commands_api::mcp_discover(
                a_str(&args, "host")?,
                a_u64(&args, "start")? as u16,
                a_u64(&args, "end")? as u16,
            )
            .await
        }
        "mcp_connect" => bit_core::commands_api::mcp_connect(ctx, a_str(&args, "url")?).await,
        "mcp_add_stdio" => {
            bit_core::commands_api::mcp_add_stdio(
                ctx,
                opt_str(&args, "name").unwrap_or_default(),
                a_str(&args, "command")?,
                opt_str_vec(&args, "args").unwrap_or_default(),
                a_str_map(&args, "env"),
            )
            .await
        }
        "mcp_list" => bit_core::commands_api::mcp_list(ctx).await,
        "mcp_toggle" => bit_core::commands_api::mcp_toggle(ctx, a_str(&args, "id")?, a_bool(&args, "enabled")?).await,
        "mcp_remove" => bit_core::commands_api::mcp_remove(ctx, a_str(&args, "id")?).await,
        "mcp_import" => bit_core::commands_api::mcp_import(ctx, a_str(&args, "id")?).await,

        // ---------- WorkWith 本地服务托管 ----------
        "list_workwith" => bit_core::commands_api::list_workwith(ctx),
        "save_workwith" => bit_core::commands_api::save_workwith(ctx, a_val(&args, "entry")),
        "remove_workwith" => bit_core::commands_api::remove_workwith(ctx, a_str(&args, "id")?).await,
        "start_workwith" => bit_core::commands_api::start_workwith(ctx, a_str(&args, "id")?).await,
        "stop_workwith" => bit_core::commands_api::stop_workwith(ctx, a_str(&args, "id")?).await,
        "workwith_logs" => bit_core::commands_api::workwith_logs(a_str(&args, "id")?, opt_u64(&args, "tail")),

        // ---------- 会话 ----------
        "compress_session" => bit_core::commands_api::compress_session(ctx, a_str(&args, "session_id")?).await,
        "list_sessions" => bit_core::commands_api::list_sessions(ctx),
        "get_session" => bit_core::commands_api::get_session(ctx, a_str(&args, "session_id")?),
        "create_session" => bit_core::commands_api::create_session(ctx, a_str(&args, "title")?),
        "set_active_session" => bit_core::commands_api::set_active_session(ctx, a_str(&args, "session_id")?),
        "rename_session" => {
            bit_core::commands_api::rename_session(ctx, a_str(&args, "session_id")?, a_str(&args, "title")?)
        }
        "delete_session" => bit_core::commands_api::delete_session(ctx, a_str(&args, "session_id")?),
        "set_session_favorite" => {
            bit_core::commands_api::set_session_favorite(ctx, a_str(&args, "session_id")?, a_bool(&args, "favorite")?)
        }
        "set_session_color" => {
            bit_core::commands_api::set_session_color(ctx, a_str(&args, "session_id")?, a_str(&args, "color")?)
        }
        "delete_sessions" => bit_core::commands_api::delete_sessions(ctx, a_str_vec(&args, "session_ids")?),
        "clear_session" => bit_core::commands_api::clear_session(ctx, a_str(&args, "session_id")?),

        // ---------- 记忆 / 技能 ----------
        "list_memories" => bit_core::commands_api::list_memories(ctx),
        "add_memory" => bit_core::commands_api::add_memory(ctx, a_str(&args, "content")?),
        "delete_memories" => bit_core::commands_api::delete_memories(ctx, a_str_vec(&args, "ids")?),
        "list_skills" => bit_core::commands_api::list_skills(ctx),
        "add_skill" => bit_core::commands_api::add_skill(ctx, a_str(&args, "name")?, a_str(&args, "summary")?),
        "delete_skills" => bit_core::commands_api::delete_skills(ctx, a_str_vec(&args, "ids")?),

        // ---------- Autopilot / 目标 / 待办 ----------
        "toggle_autopilot" => bit_core::commands_api::toggle_autopilot(ctx),
        "list_goals" => bit_core::commands_api::list_goals(ctx),
        "create_goal" => bit_core::commands_api::create_goal(ctx, a_str(&args, "title")?, a_str(&args, "detail")?),
        "update_goal_status" => {
            bit_core::commands_api::update_goal_status(ctx, a_str(&args, "id")?, a_str(&args, "status")?)
        }
        "remove_goal" => bit_core::commands_api::remove_goal(ctx, a_str(&args, "id")?),
        "list_todos" => bit_core::commands_api::list_todos(ctx),
        "add_todo" => {
            bit_core::commands_api::add_todo(ctx, a_str(&args, "content")?, opt_str(&args, "goal_id"))
        }
        "update_todo_status" => {
            bit_core::commands_api::update_todo_status(ctx, a_str(&args, "id")?, a_str(&args, "status")?)
        }
        "remove_todo" => bit_core::commands_api::remove_todo(ctx, a_str(&args, "id")?),

        // ---------- 文件打开 ----------
        "open_path" => bit_core::commands_api::open_path(ctx, a_str(&args, "path")?, opt_bool(&args, "reveal")),
        "open_external" => bit_core::commands_api::open_external(a_str(&args, "url")?),

        // ---------- 诊断 / 提权 ----------
        "get_tool_stats" => bit_core::commands_api::get_tool_stats(ctx),
        "get_diagnostics" => bit_core::commands_api::get_diagnostics(ctx),
        "get_elevation" => bit_core::commands_api::get_elevation(ctx),

        // ---------- 安全中心 ----------
        "get_hidden_codes" => bit_core::commands_api::get_hidden_codes(ctx),
        "add_hidden_code" => {
            bit_core::commands_api::add_hidden_code(
                ctx,
                a_str(&args, "kind")?,
                a_str(&args, "value")?,
                a_bool(&args, "as_pattern")?,
                a_str(&args, "alias")?,
            )
        }
        "remove_hidden_code" => bit_core::commands_api::remove_hidden_code(ctx, a_str(&args, "id")?),
        "set_hidden_code_enabled" => {
            bit_core::commands_api::set_hidden_code_enabled(ctx, a_str(&args, "id")?, a_bool(&args, "enabled")?)
        }
        "scan_hidden_candidates" => bit_core::commands_api::scan_hidden_candidates(a_str(&args, "text")?),
        "get_security_settings" => bit_core::commands_api::get_security_settings(ctx),
        "set_security_settings" => {
            bit_core::commands_api::set_security_settings(
                ctx,
                opt_bool(&args, "hidden_code_enabled"),
                opt_bool(&args, "l2pass_enabled"),
                opt_str(&args, "l2pass_provider_id"),
                opt_bool(&args, "l2pass_cover_auto"),
            )
        }

        "get_language" => bit_core::commands_api::get_language(ctx),
        "set_language" => bit_core::commands_api::set_language(ctx, a_str(&args, "language")?),
        "get_theme" => bit_core::commands_api::get_theme(ctx),
        "set_theme" => bit_core::commands_api::set_theme(ctx, a_str(&args, "theme")?),

        // ---------- 更新 ----------
        "update_download" => bit_core::commands_api::update_download(ctx).await,

        _ => Err(format!("未知命令: {cmd}")),
    }
}
