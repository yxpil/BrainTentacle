// yxpil · BIT
//! 插件能力调度：页面桥（渲染层）与插件自带服务器（本机 HTTP）共用的唯一入口。
//!
//! 为什么收成一个函数而不是十来个命令：
//! - 两条传输链路（postMessage / HTTP）必须给出完全相同的能力语义，分开写必然漂移；
//! - 权限闸门只在一处判定，新增 verb 必须在这里登记所需权限位，不存在"默认放开"；
//! - 插件 id 由传输层给出（HTTP 是 Bearer 令牌反查，渲染层是宿主登记过的帧），
//!   插件自己报的 id 一律不采信——否则任何页面都能冒充别的插件。
//!
//! 命名空间纪律与对话 API 同口径：
//! - 设置值存在 `plugin_settings` 文档里，键名带 `<插件id>/` 前缀；
//! - 数据文件只能落在 `toolhomes/plugin_data/<插件id>/`（插件目录之外，
//!   往插件目录里写会撞上防篡改哈希基线，插件会被自动停用）；
//! - 会话只能在 `plugin:<id>` 及其子会话里读写，碰不到用户正在用的会话；
//! - 托管服务条目的 id 前缀 `psvc-<插件id>-`，只能管自己的，也碰不到别人的。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::state::Ctx;

/// verb → 所需权限位。未知 verb 返回 None = 拒绝（能力必须在此登记）。
fn required_perm(verb: &str) -> Option<&'static str> {
    Some(match verb {
        "settings.get" | "settings.all" | "settings.set" => "settings",
        "data.list" | "data.read" | "data.write" | "data.remove" => "data",
        "session.list" | "session.read" | "session.append" | "session.wake" => "session",
        "workwith.list" | "workwith.save" | "workwith.start" | "workwith.stop" | "workwith.remove" => "workwith",
        "server.status" | "server.start" | "server.stop" => "server",
        // 外部连接：列自己的声明、连上、断开。连接名只能是本插件清单里的，
        // 传 id 也必须带本插件前缀——别人插件的 pmcp- 条目碰不到
        "net.connections" | "net.connect" | "net.disconnect" => "net",
        "notify" => "notify",
        // 控制台执行：命令或程序（含参数/工作目录/超时）
        "exec.run" => "exec",
        // 文件与程序修改：路径不做目录白名单限制，但每一项都必须先申报 write
        "fs.list" | "fs.stat" | "fs.read" | "fs.write" | "fs.append" | "fs.remove" | "fs.mkdir" | "fs.move" => "write",
        "info" | "caps" | "runtime.list" => "", // 只回本插件自己的申报与本机解释器，不开任何能力
        // 看自己登记了哪些文件类型（宿主当前实际生效的那份，不是清单原文）
        "files.kinds" => "files",
        _ => return None,
    })
}

/// 全部能力动词（给 caps 查询与文档用）
const ALL_VERBS: &[&str] = &[
    "info",
    "caps",
    "runtime.list",
    "files.kinds",
    "settings.get",
    "settings.all",
    "settings.set",
    "data.list",
    "data.read",
    "data.write",
    "data.remove",
    "session.list",
    "session.read",
    "session.append",
    "session.wake",
    "workwith.list",
    "workwith.save",
    "workwith.start",
    "workwith.stop",
    "workwith.remove",
    "server.status",
    "server.start",
    "server.stop",
    "net.connections",
    "net.connect",
    "net.disconnect",
    "notify",
    "exec.run",
    "fs.list",
    "fs.stat",
    "fs.read",
    "fs.write",
    "fs.append",
    "fs.remove",
    "fs.mkdir",
    "fs.move",
];

use crate::plugins::{service_id, service_prefix};

/// 名字/ id 两种写法都接受：优先显式 id，其次由 name 推导
fn target_id(plugin_id: &str, body: &Value) -> Result<String, String> {
    if let Some(id) = body.get("id").and_then(|v| v.as_str()) {
        let id = id.trim().to_string();
        if id.is_empty() {
            return Err("缺少 id 或 name".into());
        }
        // 插件服务器（清单里的 server）用固定键，允许碰自己那一枚
        let own_server = crate::plugins::server_key(plugin_id);
        if id != own_server && !id.starts_with(&service_prefix(plugin_id)) {
            return Err(format!("只能操作本插件自己的条目（前缀 {}）", service_prefix(plugin_id)));
        }
        return Ok(id);
    }
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("缺少 id 或 name".into());
    }
    Ok(service_id(plugin_id, &name))
}

/// 外部连接的目标：`name`（清单里的连接名）或 `id`（宿主侧条目 id）两种写法都认，
/// 但只能是本插件自己声明的那几条——前缀不对直接拒，条目 id 也对不上清单同样拒
fn conn_target(plugin: &crate::plugins::Plugin, body: &Value) -> Result<String, String> {
    let prefix = crate::netconn::conn_prefix(&plugin.id);
    if let Some(raw) = body.get("id").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if !raw.starts_with(&prefix) {
            return Err(format!("只能操作本插件自己的连接（前缀 {prefix}）"));
        }
        return plugin
            .connections
            .iter()
            .find(|c| crate::netconn::conn_id(&plugin.id, &c.name) == raw)
            .map(|c| c.name.clone())
            .ok_or_else(|| format!("插件未声明连接条目 {raw}"));
    }
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err("缺少 name 或 id".into());
    }
    let want = crate::plugins::sanitize(&name);
    plugin
        .connections
        .iter()
        .find(|c| c.name == name || crate::plugins::sanitize(&c.name) == want)
        .map(|c| c.name.clone())
        .ok_or_else(|| format!("插件未声明连接 {name}"))
}

/// 能力调用入口。pid 由传输层给出，payload 是插件提供的参数。
pub async fn call(ctx: &Arc<Ctx>, pid: &str, verb: &str, payload: Value) -> Result<Value, String> {
    let perm = required_perm(verb).ok_or_else(|| format!("未知能力: {verb}"))?;
    // 权限位来自清单且以"当前启用+未篡改"的插件为准：停用后令牌还在也调不动
    let plugin = crate::plugins::enabled_plugin(ctx, pid).ok_or("插件未启用或安全校验未通过")?;
    if !perm.is_empty() && !crate::plugins::has_grant(ctx, &plugin, perm) {
        return Err(format!("插件未开启权限 \"{perm}\"，能力 {verb} 不可用"));
    }
    let body = if payload.is_null() { json!({}) } else { payload };
    let out = match verb {
        "info" => json!({
            "plugin_id": pid,
            "plugin_name": plugin.name,
            "version": plugin.version,
            "permissions": crate::plugins::effective_perms(ctx, &plugin),
            "has_settings": crate::plugins::settings_declared(&plugin),
        }),
        "caps" => json!({
            "caps": ALL_VERBS.iter().filter(|v| {
                let need = required_perm(v).unwrap_or("");
                need.is_empty() || crate::plugins::has_grant(ctx, &plugin, need)
            }).collect::<Vec<_>>(),
        }),
        "runtime.list" => json!({
            // 只报已启用的：被暂停的解释器 exec.run 也跑不动，别让它白试一次
            // 这条能力免权限：插件写代码时最想知道的就是"这台机器上有什么"
            "runtimes": ctx
                .runtimes
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.enabled)
                .map(|r| {
                    json!({
                        "id": r.id,
                        "name": r.name,
                        "path": r.path,
                        "version": r.version,
                        "lang": r.lang,
                        "mode": r.mode,
                    })
                })
                .collect::<Vec<_>>(),
        }),
        "files.kinds" => json!({
            // 宿主当前真正生效的那份登记（插件被停用、files 位被关、清单没洗过时这里就空）
            "kinds": crate::filekinds::all()
                .into_iter()
                .filter(|k| k.plugin_id == pid)
                .map(|k| json!({
                    "id": k.key.split(':').next_back().unwrap_or(""),
                    "label": k.label,
                    "exts": k.exts,
                    "paths": k.paths,
                    "tool": k.tool_id,
                }))
                .collect::<Vec<_>>(),
        }),
        "settings.get" => {
            let key = a_str(&body, "key")?;
            json!({ "key": key, "value": get_setting(ctx, pid, &key) })
        }
        "settings.all" => json!({ "values": all_settings(ctx, pid) }),
        "settings.set" => {
            let key = a_str(&body, "key")?;
            set_setting(ctx, pid, &key, body.get("value").cloned().unwrap_or(Value::Null))?;
            json!({ "ok": true })
        }
        "data.list" => data_list(ctx, pid)?,
        "data.read" => {
            let rel = a_str(&body, "path")?;
            json!({ "path": rel, "text": data_read(ctx, pid, &rel)? })
        }
        "data.write" => {
            let rel = a_str(&body, "path")?;
            let text = body.get("text").and_then(|v| v.as_str()).ok_or("缺少 text")?;
            data_write(ctx, pid, &rel, text)?;
            json!({ "ok": true, "bytes": text.len() })
        }
        "data.remove" => {
            let rel = a_str(&body, "path")?;
            data_remove(ctx, pid, &rel)?;
            json!({ "ok": true })
        }
        "session.list" => session_list(ctx, pid),
        "session.read" => session_read(ctx, pid, &opt_str(&body, "session_id"))?,
        "session.append" => session_append(ctx, pid, &body)?,
        "session.wake" => session_wake(ctx, pid, &body)?,
        "workwith.list" => workwith_list(ctx, pid),
        "workwith.save" => workwith_save(ctx, pid, &body).await?,
        "workwith.start" => workwith_start_stop(ctx, pid, &body, true).await?,
        "workwith.stop" => workwith_start_stop(ctx, pid, &body, false).await?,
        "workwith.remove" => {
            let id = target_id(pid, &body)?;
            crate::workwith::remove(ctx, &id).await?
        }
        "server.status" => crate::plugins::server_status(pid),
        "server.start" => crate::plugins::start_server(ctx, pid).await?,
        "server.stop" => crate::plugins::stop_server(ctx, pid).await?,
        "net.connections" => json!({ "connections": crate::netconn::status(ctx, pid) }),
        "net.connect" => {
            let name = conn_target(&plugin, &body)?;
            crate::netconn::connect(ctx, pid, &name).await?
        }
        "net.disconnect" => {
            let name = conn_target(&plugin, &body)?;
            crate::netconn::disconnect(ctx, pid, &name)?
        }
        "notify" => notify(ctx, &plugin, &body)?,
        "exec.run" => exec_run(ctx, &plugin, &body).await?,
        "fs.list" => fs_list(ctx, &plugin, &body)?,
        "fs.stat" => fs_stat(ctx, &plugin, &body)?,
        "fs.read" => fs_read(ctx, &plugin, &body)?,
        "fs.write" => fs_write(ctx, &plugin, &body, false)?,
        "fs.append" => fs_write(ctx, &plugin, &body, true)?,
        "fs.remove" => fs_remove(ctx, &plugin, &body)?,
        "fs.mkdir" => fs_mkdir(ctx, &plugin, &body)?,
        "fs.move" => fs_move(ctx, &plugin, &body)?,
        other => return Err(format!("未知能力: {other}")),
    };
    // 只给改动类能力记审计：读类调用（回显设置、列条目）在页面上是高频动作，
    // 全记会把审计流水刷成噪音
    if mutates(verb) {
        crate::audit::record(
            ctx,
            &format!("plugin:{pid}"),
            &format!("plugin.cap.{verb}"),
            pid,
            audit_detail(verb, &body),
            true,
        );
    }
    Ok(out)
}

/// 会不会改动本机状态（决定要不要留审计痕迹）
fn mutates(verb: &str) -> bool {
    matches!(
        verb,
        "settings.set"
            | "data.write"
            | "data.remove"
            | "session.append"
            | "session.wake"
            | "notify"
            | "workwith.save"
            | "workwith.start"
            | "workwith.stop"
            | "workwith.remove"
            | "server.start"
            | "server.stop"
            | "net.connect"
            | "net.disconnect"
            | "exec.run"
            | "fs.write"
            | "fs.append"
            | "fs.remove"
            | "fs.mkdir"
            | "fs.move"
    )
}

/// 系统通知：复用 notify-done 事件——桌面壳已经会把这个名字变成系统通知，
/// 点击还能唤回主窗口。标题一律带上插件名：通知栏里分不清是谁发的，
/// 用户就没法判断该不该点，而这正是插件能碰系统通知唯一的代价。
fn notify(ctx: &Arc<Ctx>, plugin: &crate::plugins::Plugin, body: &Value) -> Result<Value, String> {
    let title = opt_str(body, "title");
    let text = opt_str(body, "body");
    if text.is_empty() {
        return Err("缺少 body".into());
    }
    let head = if title.is_empty() {
        format!("插件 · {}", plugin.name)
    } else {
        format!("{} · {}", plugin.name, title)
    };
    ctx.emit(
        "notify-done",
        json!({ "session_id": "", "title": head.chars().take(80).collect::<String>(), "reply": crate::plaintext::for_plugin_notify(&text), "ok": true }),
    );
    Ok(json!({ "ok": true }))
}

// ── 控制台执行 / 文件与程序修改（需 exec / write 权限）──

/// 执行类路径：绝对路径原样使用，相对路径以插件目录为基准（随包分发的程序/脚本最常用）。
fn plugin_path(ctx: &Arc<Ctx>, plugin: &crate::plugins::Plugin, raw: &str) -> PathBuf {
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        crate::plugins::dir(ctx).join(&plugin.id).join(p)
    }
}

/// 文件修改路径：绝对路径原样使用；相对路径落在插件数据目录——
/// 插件包本身是哈希基线的一部分，往包里写会立刻触发防篡改、把插件停用。
fn fs_path(ctx: &Arc<Ctx>, plugin: &crate::plugins::Plugin, raw: &str) -> PathBuf {
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        data_dir(ctx, &plugin.id).join(p)
    }
}

fn path_arg(
    ctx: &Arc<Ctx>,
    plugin: &crate::plugins::Plugin,
    body: &Value,
    key: &str,
) -> Result<(String, PathBuf), String> {
    let raw = a_str(body, key)?;
    let p = fs_path(ctx, plugin, &raw);
    Ok((raw, p))
}

/// 输出上限（字节）：命令可以打印很多，但回给插件的正文不超过这个量，超出部分只标记截断
const EXEC_OUTPUT_CAP: usize = 60_000;
/// 单次执行硬上限（毫秒）：由调用方在 1s–10min 之间自选
const EXEC_TIMEOUT_DEFAULT_MS: u64 = 30_000;
const EXEC_TIMEOUT_MAX_MS: u64 = 600_000;
/// 文件读写上限（字节）
const FS_READ_DEFAULT_MAX: usize = 4 * 1024 * 1024;
const FS_MAX_BYTES: usize = 32 * 1024 * 1024;

/// 边读边截断：超过 cap 后继续把管道读空（只丢弃），避免子进程因管道写满而卡死
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(mut r: R, cap: usize) -> (Vec<u8>, bool) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut cut = false;
    loop {
        match r.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < cap {
                    let take = (cap - buf.len()).min(n);
                    buf.extend_from_slice(&chunk[..take]);
                    if take < n {
                        cut = true;
                    }
                } else {
                    cut = true;
                }
            }
            Err(_) => break,
        }
    }
    (buf, cut)
}

/// 执行一条控制台命令（经默认 shell）或直接启动一个程序。
/// payload: { command } 或 { program, args? }；可选 cwd / timeout_ms / stdin。
async fn exec_run(
    ctx: &Arc<Ctx>,
    plugin: &crate::plugins::Plugin,
    body: &Value,
) -> Result<Value, String> {
    let command = opt_str(body, "command");
    let program = opt_str(body, "program");
    if command.is_empty() == program.is_empty() {
        return Err("command 与 program 必须且只能提供一个".into());
    }
    if command.len() > 32_768 {
        return Err("command 过长（上限 32KB）".into());
    }
    let mut args: Vec<String> = Vec::new();
    if let Some(list) = body.get("args").and_then(|v| v.as_array()) {
        if list.len() > 256 {
            return Err("args 过多（上限 256 个）".into());
        }
        for a in list {
            let s = a.as_str().ok_or("args 里每一项都必须是字符串")?;
            if s.len() > 8_192 {
                return Err("单个参数过长（上限 8KB）".into());
            }
            args.push(s.to_string());
        }
    }
    let timeout_ms = body
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(EXEC_TIMEOUT_DEFAULT_MS)
        .clamp(1_000, EXEC_TIMEOUT_MAX_MS);
    let cwd_raw = opt_str(body, "cwd");
    let cwd = if cwd_raw.is_empty() {
        None
    } else {
        let p = plugin_path(ctx, plugin, &cwd_raw);
        if !p.is_dir() {
            return Err(format!("cwd 不是目录: {}", p.to_string_lossy()));
        }
        Some(p)
    };

    let mut cmd = if !command.is_empty() {
        // 与 AI 的 shell 工具同一套默认 shell 解析（配置里的 default_shell，缺省自动识别）
        let pref = { ctx.config.lock().unwrap().default_shell.clone() };
        let (prog, wrap) = crate::toolenv::resolve_shell(&pref)
            .map_err(|e| format!("无法解析默认 shell: {e}"))?;
        let mut c = tokio::process::Command::new(prog);
        c.args(wrap);
        c.arg(&command);
        c
    } else {
        // 纯程序名（如 node / cmd / python）交给系统 PATH 解析；
        // 带目录成分的相对路径才按插件目录展开
        let exe = if Path::new(&program).components().count() > 1 {
            plugin_path(ctx, plugin, &program)
        } else {
            PathBuf::from(&program)
        };
        let mut c = tokio::process::Command::new(&exe);
        c.args(&args);
        c
    };
    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }
    // 解释器白名单：清单里写了 interpreters 就把 exec.run 收窄到那几个解释器。
    // 比对的是"最终要执行的那个程序"而不是插件传来的字符串——绝对路径与裸名两种写法
    // 都绕不过去。留空 = 沿用 exec 权限本身的宽口径，既有插件行为不变。
    if !plugin.interpreters.is_empty() {
        let want_shell = !command.is_empty();
        let exe = cmd.as_std().get_program().to_string_lossy().to_lowercase();
        let base = Path::new(&exe)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| exe.clone());
        let base = base.trim_end_matches(".exe").to_string();
        let allowed = plugin.interpreters.iter().any(|want| {
            let w = want.trim().to_lowercase();
            if w.is_empty() {
                return false;
            }
            if w == base {
                return true;
            }
            if want_shell {
                return w == "shell" || w == "command";
            }
            // 声明写注册表 id（node / python）也要能对上真实可执行文件名
            match crate::runtime::get(ctx, &w) {
                Some(rt) => {
                    let rp = rt.path.to_lowercase();
                    let rb = Path::new(&rp)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| rp.clone());
                    rb.trim_end_matches(".exe") == base
                }
                None => false,
            }
        });
        if !allowed {
            let list = plugin.interpreters.join(", ");
            return Err(if want_shell {
                format!("清单 interpreters 只允许：{list}；要跑 shell 命令请把 \"shell\" 也写进 interpreters")
            } else {
                format!("清单 interpreters 只允许：{list}；不接受运行 {program}（本机可用解释器见能力 runtime.list）")
            });
        }
    }
    cmd.env("BIT_PLUGIN_ID", &plugin.id);
    // 被放行起来的解释器进程带本插件身份与凭据：脚本里 require("bit") 就能回连能力
    for (k, v) in crate::plugin_sdk::plugin_env(ctx, &plugin.id) {
        cmd.env(k, v);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let has_stdin = body.get("stdin").and_then(|v| v.as_str()).is_some();
    cmd.stdin(if has_stdin {
        std::process::Stdio::piped()
    } else {
        // 不继承宿主的 stdin：子进程读标准输入时立即收到 EOF，不会把调用挂死
        std::process::Stdio::null()
    });
    cmd.kill_on_drop(true);
    crate::registry::no_window_tokio(&mut cmd);

    let started = std::time::Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
    if let Some(text) = body.get("stdin").and_then(|v| v.as_str()) {
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(text.as_bytes()).await;
            let _ = si.shutdown().await;
        }
    }
    // stdout/stderr 必须并发读：只 wait 不读，输出超过管道缓冲区就会互相等死
    let out_task = tokio::spawn(read_capped(
        child.stdout.take().ok_or("无法读取 stdout")?,
        EXEC_OUTPUT_CAP,
    ));
    let err_task = tokio::spawn(read_capped(
        child.stderr.take().ok_or("无法读取 stderr")?,
        EXEC_OUTPUT_CAP,
    ));
    let sleep = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms));
    tokio::pin!(sleep);
    let (status, timed_out) = tokio::select! {
        st = child.wait() => (st.map_err(|e| format!("等待进程失败: {e}"))?, false),
        _ = &mut sleep => {
            crate::shellbg::tree_kill(&mut child);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
            (child.try_wait().ok().flatten().unwrap_or_default(), true)
        }
    };
    let (out, out_cut) = tokio::time::timeout(std::time::Duration::from_secs(5), out_task)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    let (err, err_cut) = tokio::time::timeout(std::time::Duration::from_secs(5), err_task)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();

    let mut result = json!({
        "code": status.code(),
        "stdout": crate::registry::safe_trunc(&crate::console_codec::decode_console(&out), EXEC_OUTPUT_CAP),
        "stderr": crate::registry::safe_trunc(&crate::console_codec::decode_console(&err), EXEC_OUTPUT_CAP),
        "stdout_truncated": out_cut,
        "stderr_truncated": err_cut,
        "timed_out": timed_out,
        "timeout_ms": timeout_ms,
        "duration_ms": started.elapsed().as_millis() as u64,
    });
    if let Some(obj) = result.as_object_mut() {
        if command.is_empty() {
            obj.insert("program".into(), json!(program));
            obj.insert("args".into(), json!(args));
        } else {
            obj.insert("command".into(), json!(command));
        }
        if let Some(dir) = &cwd {
            obj.insert("cwd".into(), json!(dir.to_string_lossy()));
        }
    }
    Ok(result)
}

fn fs_list(ctx: &Arc<Ctx>, plugin: &crate::plugins::Plugin, body: &Value) -> Result<Value, String> {
    let raw = opt_str(body, "path");
    let dir = fs_path(ctx, plugin, &raw);
    if !dir.is_dir() {
        return Err(format!("不是目录: {}", dir.to_string_lossy()));
    }
    let mut entries: Vec<(String, PathBuf, bool, u64)> = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))? {
        let e = match e {
            Ok(x) => x,
            Err(_) => continue,
        };
        if entries.len() >= 5_000 {
            break;
        }
        let p = e.path();
        let meta = e.metadata().ok();
        entries.push((
            e.file_name().to_string_lossy().to_string(),
            p,
            meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            meta.as_ref().map(|m| m.len()).unwrap_or(0),
        ));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let list: Vec<Value> = entries
        .into_iter()
        .map(|(name, p, is_dir, size)| {
            json!({ "name": name, "path": p.to_string_lossy(), "dir": is_dir, "size": size })
        })
        .collect();
    Ok(json!({ "path": dir.to_string_lossy(), "entries": list }))
}

fn fs_stat(ctx: &Arc<Ctx>, plugin: &crate::plugins::Plugin, body: &Value) -> Result<Value, String> {
    let (raw, p) = path_arg(ctx, plugin, body, "path")?;
    match std::fs::symlink_metadata(&p) {
        Ok(m) => {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let kind = if m.file_type().is_symlink() {
                "symlink"
            } else if m.is_dir() {
                "dir"
            } else {
                "file"
            };
            Ok(json!({
                "path": raw,
                "exists": true,
                "kind": kind,
                "size": m.len(),
                "readonly": m.permissions().readonly(),
                "modified_ms": modified,
            }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({ "path": raw, "exists": false }))
        }
        Err(e) => Err(format!("读取文件信息失败: {e}")),
    }
}

fn fs_read(ctx: &Arc<Ctx>, plugin: &crate::plugins::Plugin, body: &Value) -> Result<Value, String> {
    use base64::Engine as _;
    let (raw, p) = path_arg(ctx, plugin, body, "path")?;
    let max = body
        .get("max_bytes")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(FS_READ_DEFAULT_MAX)
        .clamp(1, FS_MAX_BYTES);
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取文件失败: {e}"))?;
    if meta.is_dir() {
        return Err(format!("是目录，不是文件: {raw}"));
    }
    if meta.len() as usize > max {
        return Err(format!(
            "文件过大：{} 字节（上限 {max}，可传 max_bytes 放宽到 {FS_MAX_BYTES}）",
            meta.len()
        ));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("读取文件失败: {e}"))?;
    let encoding = opt_str(body, "encoding");
    if encoding == "base64" {
        Ok(json!({
            "path": raw,
            "bytes": bytes.len(),
            "encoding": "base64",
            "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        }))
    } else {
        let text = String::from_utf8(bytes).map_err(|_| {
            "文件不是合法的 UTF-8 文本；二进制内容请传 encoding: \"base64\"".to_string()
        })?;
        Ok(json!({
            "path": raw,
            "bytes": text.len(),
            "encoding": "utf8",
            "text": text,
        }))
    }
}

fn fs_write(
    ctx: &Arc<Ctx>,
    plugin: &crate::plugins::Plugin,
    body: &Value,
    append: bool,
) -> Result<Value, String> {
    use base64::Engine as _;
    use std::io::Write as _;
    let (raw, p) = path_arg(ctx, plugin, body, "path")?;
    let bytes: Vec<u8> = if let Some(text) = body.get("text").and_then(|v| v.as_str()) {
        text.as_bytes().to_vec()
    } else if let Some(b64) = body.get("base64").and_then(|v| v.as_str()) {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("base64 解码失败: {e}"))?
    } else {
        return Err("缺少 text 或 base64".into());
    };
    if bytes.len() > FS_MAX_BYTES {
        return Err(format!("内容过大（上限 {FS_MAX_BYTES} 字节）"));
    }
    if body
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
    {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true);
    if append {
        opts.append(true);
    } else {
        opts.truncate(true);
    }
    let mut f = opts.open(&p).map_err(|e| format!("打开文件失败: {e}"))?;
    f.write_all(&bytes).map_err(|e| format!("写入失败: {e}"))?;
    Ok(json!({
        "ok": true,
        "path": raw,
        "bytes": bytes.len(),
        "appended": append,
    }))
}

fn fs_remove(ctx: &Arc<Ctx>, plugin: &crate::plugins::Plugin, body: &Value) -> Result<Value, String> {
    let (raw, p) = path_arg(ctx, plugin, body, "path")?;
    let meta = std::fs::symlink_metadata(&p).map_err(|e| format!("路径不存在或不可读: {e}"))?;
    let recursive = body.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
    if meta.is_dir() {
        if recursive {
            std::fs::remove_dir_all(&p).map_err(|e| format!("删除目录失败: {e}"))?;
        } else {
            std::fs::remove_dir(&p)
                .map_err(|e| format!("删除目录失败（非空目录需 recursive: true）: {e}"))?;
        }
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("删除文件失败: {e}"))?;
    }
    Ok(json!({ "ok": true, "path": raw }))
}

fn fs_mkdir(ctx: &Arc<Ctx>, plugin: &crate::plugins::Plugin, body: &Value) -> Result<Value, String> {
    let (raw, p) = path_arg(ctx, plugin, body, "path")?;
    std::fs::create_dir_all(&p).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(json!({ "ok": true, "path": raw }))
}

fn fs_move(ctx: &Arc<Ctx>, plugin: &crate::plugins::Plugin, body: &Value) -> Result<Value, String> {
    let (from_raw, from) = path_arg(ctx, plugin, body, "from")?;
    let (to_raw, to) = path_arg(ctx, plugin, body, "to")?;
    if body
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
    {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    std::fs::rename(&from, &to).map_err(|e| format!("移动失败: {e}"))?;
    Ok(json!({ "ok": true, "from": from_raw, "to": to_raw }))
}

/// 审计里只记"改了什么"，不记文件正文；exec 记命令/程序与工作目录，便于事后追查
fn audit_detail(verb: &str, body: &Value) -> Value {
    match verb {
        "exec.run" => json!({
            "command": opt_str(body, "command"),
            "program": opt_str(body, "program"),
            "cwd": opt_str(body, "cwd"),
        }),
        "fs.move" => json!({ "from": opt_str(body, "from"), "to": opt_str(body, "to") }),
        v if v.starts_with("fs.") => json!({ "path": opt_str(body, "path") }),
        _ => json!({}),
    }
}

// ── 参数取值 ──

fn a_str(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少 {key}"))
}

fn opt_str(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
}

// ── 设置值（bit.db "plugin_settings"，键名 <插件id>/<键>）──

type SettingsMap = std::collections::HashMap<String, Value>;

fn load_settings(ctx: &Arc<Ctx>) -> SettingsMap {
    ctx.db_get_json::<SettingsMap>("plugin_settings").unwrap_or_default()
}

fn scoped_key(pid: &str, key: &str) -> String {
    format!("{pid}/{key}")
}

fn get_setting(ctx: &Arc<Ctx>, pid: &str, key: &str) -> Value {
    load_settings(ctx).get(&scoped_key(pid, key)).cloned().unwrap_or(Value::Null)
}

fn all_settings(ctx: &Arc<Ctx>, pid: &str) -> Value {
    let prefix = format!("{pid}/");
    let mut out = serde_json::Map::new();
    for (k, v) in load_settings(ctx) {
        if let Some(name) = k.strip_prefix(&prefix) {
            out.insert(name.to_string(), v);
        }
    }
    Value::Object(out)
}

/// 本插件设置值的字符串视图（数字/布尔一律转成字面文本）。
/// 外部连接的 `{setting:KEY}` 取值走这里：键名不带前缀，取不到就是没填
pub fn settings_strings(ctx: &Arc<Ctx>, pid: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let map = match all_settings(ctx, pid) {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    for (k, v) in map {
        let s = match &v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        out.insert(k, s);
    }
    out
}

fn set_setting(ctx: &Arc<Ctx>, pid: &str, key: &str, value: Value) -> Result<(), String> {
    if key.is_empty() || key.contains('/') {
        return Err("设置键名不能为空且不含 /".into());
    }
    // 单值 64KB：设置项不是数据库，超限的让插件去用 data.write
    const MAX: usize = 64 * 1024;
    if value.to_string().len() > MAX {
        return Err("设置值过大（上限 64KB），请改用 data.write".into());
    }
    let mut m = load_settings(ctx);
    if value.is_null() {
        m.remove(&scoped_key(pid, key));
    } else {
        m.insert(scoped_key(pid, key), value);
    }
    ctx.db_put_json("plugin_settings", &m);
    Ok(())
}

// ── 数据目录（插件目录之外，避免撞上防篡改基线）──

pub fn data_dir(ctx: &Arc<Ctx>, pid: &str) -> std::path::PathBuf {
    crate::toolenv::dir(ctx)
        .join("plugin_data")
        .join(crate::plugins::sanitize(pid))
}

fn data_path(ctx: &Arc<Ctx>, pid: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    crate::plugins::safe_rel(rel)?;
    let root = data_dir(ctx, pid);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let p = root.join(rel);
    // 符号链接逃逸防线：canonical 后必须仍在自己的数据目录里
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    let parent = p
        .parent()
        .map(|d| std::fs::create_dir_all(d).and_then(|_| d.canonicalize()))
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or(canon_root.clone());
    if !parent.starts_with(&canon_root) {
        return Err("path outside plugin data dir".into());
    }
    Ok(p)
}

fn data_list(ctx: &Arc<Ctx>, pid: &str) -> Result<Value, String> {
    let root = data_dir(ctx, pid);
    let mut files = Vec::new();
    if root.is_dir() {
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                let rel = p.strip_prefix(&root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                files.push(json!({ "path": rel, "bytes": size }));
            }
        }
    }
    files.sort_by(|a, b| a["path"].as_str().unwrap_or("").cmp(b["path"].as_str().unwrap_or("")));
    Ok(json!({ "dir": data_dir(ctx, pid).to_string_lossy(), "files": files }))
}

fn data_read(ctx: &Arc<Ctx>, pid: &str, rel: &str) -> Result<String, String> {
    let p = data_path(ctx, pid, rel)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败: {e}"))?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("文件过大（上限 4MB）".into());
    }
    String::from_utf8(bytes).map_err(|_| "不是 UTF-8 文本，请用 text 字段写入".into())
}

fn data_write(ctx: &Arc<Ctx>, pid: &str, rel: &str, text: &str) -> Result<(), String> {
    if text.len() > 4 * 1024 * 1024 {
        return Err("写入过大（上限 4MB）".into());
    }
    let p = data_path(ctx, pid, rel)?;
    std::fs::write(&p, text).map_err(|e| format!("写入失败: {e}"))
}

fn data_remove(ctx: &Arc<Ctx>, pid: &str, rel: &str) -> Result<(), String> {
    let p = data_path(ctx, pid, rel)?;
    if p.is_dir() {
        return Err("只能删文件".into());
    }
    std::fs::remove_file(&p).map_err(|e| format!("删除失败: {e}"))
}

// ── 会话（限本插件命名空间）──

fn own_session(pid: &str, want: &str) -> Result<String, String> {
    crate::plugin_api::scoped_session(pid, want)
}

fn session_list(ctx: &Arc<Ctx>, pid: &str) -> Value {
    crate::session::refresh_from_disk(ctx);
    let own = format!("plugin:{pid}");
    let list: Vec<Value> = {
        let store = ctx.sessions.lock().unwrap();
        store
            .sessions
            .iter()
            .filter(|s| s.id == own || s.id.starts_with(&format!("{own}:")))
            .map(|s| json!({ "session_id": s.id, "title": s.title, "updated": s.updated, "messages": s.messages.len() }))
            .collect()
    };
    json!({ "sessions": list })
}

fn session_read(ctx: &Arc<Ctx>, pid: &str, want: &str) -> Result<Value, String> {
    let sid = own_session(pid, want)?;
    crate::session::refresh_from_disk(ctx);
    let msgs = {
        let store = ctx.sessions.lock().unwrap();
        store
            .sessions
            .iter()
            .find(|s| s.id == sid)
            .map(|s| s.messages.clone())
            .unwrap_or_default()
    };
    Ok(json!({ "session_id": sid, "messages": msgs }))
}

fn session_append(ctx: &Arc<Ctx>, pid: &str, body: &Value) -> Result<Value, String> {
    let sid = own_session(pid, &opt_str(body, "session_id"))?;
    let role = opt_str(body, "role");
    // 只允许三种角色：插入一个没听说过的角色会让前端渲染出空气泡
    if !matches!(role.as_str(), "user" | "assistant" | "system") {
        return Err(format!("role 只能是 user / assistant / system，收到 {role}"));
    }
    let content = body.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if content.trim().is_empty() {
        return Err("缺少 content".into());
    }
    crate::session::refresh_from_disk(ctx);
    {
        let mut store = ctx.sessions.lock().unwrap();
        let s = store.get_or_create_mut(&sid);
        s.messages.push(crate::ai::ChatMessage {
            role: role.clone(),
            content,
            tool_calls: Vec::new(),
            thinking: None,
            ts: Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
            diagram: None,
            images: Vec::new(),
        });
        s.touch();
    }
    crate::session::persist(ctx);
    ctx.emit("sessions-updated", json!(sid));
    Ok(json!({ "session_id": sid, "role": role }))
}

/// 唤醒：把一段话作为后台产物送回本插件的某个会话，让那个会话的 AI 下一轮看到它。
/// 复用 shellbg 的唤回链路（与插件定时任务注入结果同一条路），不新造机制。
fn session_wake(ctx: &Arc<Ctx>, pid: &str, body: &Value) -> Result<Value, String> {
    let sid = own_session(pid, &a_str(body, "session_id")?)?;
    let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if text.trim().is_empty() {
        return Err("缺少 text".into());
    }
    // 续跑链路对不存在的会话直接丢弃（resume 先查会话在不在），所以先把会话补出来
    // 并通知前端，唤回正文才有落点；会话仍在插件自己的命名空间里，碰不到用户的对话。
    {
        crate::session::refresh_from_disk(ctx);
        let mut store = ctx.sessions.lock().unwrap();
        store.get_or_create_mut(&sid);
    }
    crate::session::persist(ctx);
    ctx.emit("sessions-updated", json!(sid));
    crate::shellbg::notify_session_result(
        &sid,
        &format!("plugin:{pid}"),
        &format!("插件 {pid} 的唤回消息"),
        0,
        text,
        String::new(),
        "done",
    );
    Ok(json!({ "session_id": sid, "ok": true }))
}

// ── 托管服务（WorkWith）──

fn workwith_list(ctx: &Arc<Ctx>, pid: &str) -> Value {
    let prefix = service_prefix(pid);
    let own_server = crate::plugins::server_key(pid);
    let all = crate::workwith::list(ctx)["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let entries: Vec<Value> = all
        .into_iter()
        .filter(|e| {
            let id = e["id"].as_str().unwrap_or("");
            id.starts_with(&prefix) || id == own_server
        })
        .collect();
    json!({ "entries": entries })
}

/// 保存（新增或更新）一个本插件的服务条目。
/// program 可以是插件目录内的相对路径，也可以是绝对路径；
/// 未指定运行环境（custom）时，纯程序名（node / python / cmd）交给系统 PATH。
/// cwd 相对路径以插件目录为基准；环境里补令牌与端口——插件进程不必知道自己被放在哪儿跑。
async fn workwith_save(ctx: &Arc<Ctx>, pid: &str, body: &Value) -> Result<Value, String> {
    let name = a_str(body, "name")?;
    let id = service_id(pid, &name);
    let program = a_str(body, "program")?;
    let pdir = crate::plugins::dir(ctx).join(pid);
    let runtime = opt_str(body, "runtime");
    let runtime_custom = runtime.trim().is_empty() || runtime.trim() == "custom";
    // 运行环境在保存这一刻就查：写错 id（"js" 这类语言标签）过去要等到启动才炸，
    // 现在当场说清本机注册了哪些。探测表还是空的（首启未完成）时不判——
    // 那时"查不到"不代表"不存在"，误判会把正常插件挡在保存这一步。
    if !runtime_custom {
        let id = runtime.trim();
        let registry = ctx.runtimes.lock().unwrap();
        if !registry.is_empty() && registry.iter().all(|r| r.id != id) && crate::runtime::get(ctx, id).is_none() {
            let have: Vec<&str> = registry.iter().map(|r| r.id.as_str()).collect();
            return Err(format!(
                "运行环境 \"{id}\" 未注册；本机可用：{}（或用 \"custom\" 直接执行程序）",
                have.join(", ")
            ));
        }
    }
    let p = Path::new(program.trim());
    let program_abs = if p.is_absolute() {
        p.to_path_buf()
    } else if p.components().count() > 1 || !runtime_custom {
        // 带目录成分的相对路径、或解释器脚本：按插件目录展开
        crate::plugins::safe_rel(program.trim())?;
        pdir.join(p)
    } else {
        // 纯程序名：交给系统 PATH，不要求插件目录里存在
        PathBuf::from(p)
    };
    if program_abs.is_absolute() && !program_abs.is_file() {
        return Err(format!("程序不存在: {program}"));
    }
    let cwd_raw = opt_str(body, "cwd");
    let cwd = if cwd_raw.trim().is_empty() {
        pdir.to_string_lossy().to_string()
    } else {
        let cp = Path::new(cwd_raw.trim());
        if cp.is_absolute() {
            cwd_raw.trim().to_string()
        } else {
            crate::plugins::safe_rel(cwd_raw.trim())?;
            pdir.join(cp).to_string_lossy().to_string()
        }
    };
    if !Path::new(&cwd).is_dir() {
        return Err(format!("工作目录不存在: {cwd}"));
    }
    let want_port = body.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    let port = if want_port > 0 { want_port } else { crate::plugins::alloc_port()? };
    let mut env = std::collections::HashMap::new();
    if let Some(map) = body.get("env").and_then(|v| v.as_object()) {
        for (k, v) in map {
            let val = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            env.insert(k.clone(), val);
        }
    }
    env.insert("BIT_PLUGIN_ID".into(), pid.to_string());
    env.insert("BIT_PLUGIN_SERVICE".into(), name.clone());
    env.insert("BIT_PLUGIN_PORT".into(), port.to_string());
    env.insert("BIT_PLUGIN_TOKEN".into(), crate::plugin_api::token_for(pid));
    env.insert("BIT_PLUGIN_API".into(), crate::plugin_api::base_url());
    env.insert("BIT_PLUGIN_DIR".into(), pdir.to_string_lossy().to_string());
    if let Some(p) = crate::plugins::enabled_plugin(ctx, pid) {
        env.insert("BIT_PLUGIN_PERMS".into(), crate::plugins::effective_perms(ctx, &p).join(","));
    }
    // SDK 搜索路径：服务进程里 require("bit") / import bit / python 的 import bit 可用
    crate::plugin_sdk::apply_env(ctx, &mut env);
    let entry = json!({
        "id": id,
        "name": format!("{pid} · {name}"),
        "runtime_id": runtime,
        "program": program_abs.to_string_lossy(),
        "args": body.get("args").cloned().unwrap_or(json!([])),
        "cwd": cwd,
        "env": env,
        "port": port,
        "mcp_mode": opt_str(body, "mcp_mode"),
        "auto_with_session": body.get("auto_with_session").and_then(|v| v.as_bool()).unwrap_or(false),
        "declared": false,
    });
    let r = crate::workwith::save(ctx, entry)?;
    Ok(r)
}

/// 启停：既支持本插件的服务条目，也支持清单里的自带服务器（server 权限已在 verb 上把关）
async fn workwith_start_stop(ctx: &Arc<Ctx>, pid: &str, body: &Value, start: bool) -> Result<Value, String> {
    let id = target_id(pid, body)?;
    if id == crate::plugins::server_key(pid) {
        return if start {
            crate::plugins::start_server(ctx, pid).await
        } else {
            crate::plugins::stop_server(ctx, pid).await
        };
    }
    if start {
        crate::workwith::start(ctx, &id).await
    } else {
        crate::workwith::stop(ctx, &id).await
    }
}

/// 插件被停用/篡改时收掉它注册的托管服务进程（条目留着，用户重新启用后还能用）
/// 只收本插件经 workwith 能力登记的服务（逐权限关掉 workwith 时用）
pub fn stop_workwith_services(ctx: &Arc<Ctx>, pid: &str) {
    let prefix = service_prefix(pid);
    if crate::workwith::load_entries(ctx).iter().any(|e| e.id.starts_with(&prefix)) {
        crate::workwith::kill_all_with_prefix(&prefix);
    }
}

pub fn stop_services(ctx: &Arc<Ctx>, pid: &str) {
    stop_workwith_services(ctx, pid);
    // 清单里的自带服务器走同一条 kill（前缀 plugin: 精确到本插件那一枚）
    let own_server = crate::plugins::server_key(pid);
    if crate::workwith::is_running(&own_server) {
        crate::workwith::kill_all_with_prefix(&own_server);
    }
}

// ── 单测 ──

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 造一个只申报指定权限位的启用插件（清单写进临时数据目录的插件包里）
    fn plugin_with(ctx: &Arc<Ctx>, id: &str, perms: &[&str]) {
        crate::plugins::write_test_plugin(
            ctx,
            id,
            json!({ "name": id, "permissions": perms }),
            &[],
        );
    }

    /// files.kinds 只回自己登记的类型；没申报 files 的插件直接拒
    #[tokio::test]
    async fn files_kinds_reports_only_this_plugin() {
        let ctx = crate::plugins::test_ctx("caps-files");
        crate::plugins::write_test_plugin(
            &ctx,
            "mine",
            json!({
                "name": "我的类型",
                "permissions": ["files"],
                "file_kinds": [{ "id": "fz", "label": "FZ", "exts": "fz" }],
            }),
            &[],
        );
        crate::plugins::write_test_plugin(&ctx, "other", json!({ "name": "别人的", "permissions": ["files"] }), &[]);
        crate::filekinds::refresh(&ctx);
        let v = call(&ctx, "mine", "files.kinds", json!({})).await.unwrap();
        assert_eq!(v["kinds"].as_array().unwrap().len(), 1, "只看得到自己那一条");
        assert_eq!(v["kinds"][0]["exts"], json!([".fz"]));
        assert_eq!(call(&ctx, "other", "files.kinds", json!({})).await.unwrap()["kinds"], json!([]));
        // 关掉 files 权限位 → 能力与登记一起消失
        ctx.config.lock().unwrap().plugin_denied_perms.insert("mine".into(), vec!["files".into()]);
        assert!(call(&ctx, "mine", "files.kinds", json!({})).await.unwrap_err().contains("未开启权限 \"files\""));
        assert_eq!(crate::filekinds::refresh(&ctx), 0);
    }

    /// 没登记的 verb 一律拒绝；登记了的必须对应一个已知权限位
    #[test]
    fn every_verb_is_registered_against_a_permission() {        let mut known: Vec<&str> = crate::plugins::KNOWN_PERMS.to_vec();
        known.push("");
        for v in ALL_VERBS {
            let perm = required_perm(v).unwrap_or_else(|| panic!("{v} 没登记权限位"));
            assert!(known.contains(&perm), "{v} 指向未知权限 {perm}");
        }
        assert!(required_perm("shell.run").is_none(), "未登记的能力不能返回权限位");
    }

    /// exec/write 必须真的按清单声明与用户开关放行；all 展开后逐项权限同样可关
    #[tokio::test]
    async fn exec_and_write_need_declared_permissions() {
        let ctx = crate::plugins::test_ctx("caps-exec");
        plugin_with(&ctx, "risky", &["exec", "write"]);
        // 没声明 exec 的插件连能力都看不到
        plugin_with(&ctx, "safe", &["exec"]);
        assert!(call(&ctx, "safe", "fs.write", json!({ "path": "x.txt", "text": "x" })).await.unwrap_err().contains("未开启权限 \"write\""));
        // write：相对路径落在插件目录，能写能读能删
        let w = call(&ctx, "risky", "fs.write", json!({ "path": "out/demo.txt", "text": "你好" })).await.unwrap();
        assert_eq!(w["bytes"], 6);
        assert_eq!(call(&ctx, "risky", "fs.read", json!({ "path": "out/demo.txt" })).await.unwrap()["text"], "你好");
        assert_eq!(call(&ctx, "risky", "fs.stat", json!({ "path": "out/demo.txt" })).await.unwrap()["kind"], "file");
        call(&ctx, "risky", "fs.remove", json!({ "path": "out/demo.txt" })).await.unwrap();
        assert_eq!(call(&ctx, "risky", "fs.stat", json!({ "path": "out/demo.txt" })).await.unwrap()["exists"], false);
        // exec：用默认 shell 执行一条无副作用的命令
        let r = call(&ctx, "risky", "exec.run", json!({ "command": "echo bit-exec", "timeout_ms": 5000 })).await.unwrap();
        assert_eq!(r["code"], 0);
        assert!(r["stdout"].as_str().unwrap_or("").contains("bit-exec"), "{r}");
        // 用户在设置里关掉 write 后，读写立刻被拒（清单仍申报着）
        ctx.config.lock().unwrap().plugin_denied_perms.insert("risky".into(), vec!["write".into()]);
        assert!(call(&ctx, "risky", "fs.write", json!({ "path": "out/x.txt", "text": "x" })).await.unwrap_err().contains("未开启权限 \"write\""));
        // all 展开后 exec/write 都生效；再单独关掉 exec 也只影响这一项
        plugin_with(&ctx, "wide", &["all"]);
        assert!(call(&ctx, "wide", "caps", json!({})).await.unwrap()["caps"].as_array().unwrap().contains(&json!("exec.run")));
        let p = crate::plugins::enabled_plugin(&ctx, "wide").unwrap();
        let perms = crate::plugins::declared_perms(&p);
        assert!(perms.contains(&"exec".to_string()) && perms.contains(&"write".to_string()), "{perms:?}");
        ctx.config.lock().unwrap().plugin_denied_perms.insert("wide".into(), vec!["exec".into()]);
        assert!(call(&ctx, "wide", "exec.run", json!({ "command": "echo x" })).await.unwrap_err().contains("未开启权限 \"exec\""));
        assert!(call(&ctx, "wide", "fs.write", json!({ "path": "wide.txt", "text": "x" })).await.is_ok());
    }

    /// 托管服务 id 命名空间：只能碰自己前缀下的条目（或清单自带的服务器）
    #[test]
    fn service_targets_are_scoped_to_the_plugin() {
        assert_eq!(service_id("aa", "sync"), "psvc-aa-sync");
        assert_eq!(service_id("a", "b_c"), "psvc-a-b_c");
        // 前切分用 `-`：psvc-a- 不能命中插件 a_b 的条目
        assert!(!service_id("a_b", "x").starts_with(&service_prefix("a")));
        let own = target_id("aa", &json!({ "id": "psvc-aa-sync" })).unwrap();
        assert_eq!(own, "psvc-aa-sync");
        assert_eq!(target_id("aa", &json!({ "name": "sync" })).unwrap(), "psvc-aa-sync");
        assert!(target_id("aa", &json!({ "id": "psvc-bb-sync" })).is_err(), "不许操作别的插件的条目");
        assert!(target_id("aa", &json!({ "id": "ww-9f3" })).is_err(), "不许操作用户自己登记的条目");
        assert_eq!(target_id("aa", &json!({ "id": "plugin:aa" })).unwrap(), "plugin:aa", "允许碰自己的自带服务器");
        assert!(target_id("aa", &json!({})).is_err(), "id 与 name 都没有要报错");
    }

    #[tokio::test]
    async fn undeclared_and_unknown_capabilities_are_refused() {
        let ctx = crate::plugins::test_ctx("caps-perm");
        plugin_with(&ctx, "narrow", &["settings"]);
        // 未申报 → 拒绝，且错误里点名缺哪一位
        let e = call(&ctx, "narrow", "data.write", json!({ "path": "a.txt", "text": "x" })).await.unwrap_err();
        assert!(e.contains("未开启权限 \"data\""), "{e}");
        // 没登记过的 verb → 连权限都不查
        assert!(call(&ctx, "narrow", "shell.run", json!({})).await.unwrap_err().contains("未知能力"));
        // 申报了的就能用
        assert_eq!(call(&ctx, "narrow", "settings.set", json!({ "key": "k", "value": 1 })).await.unwrap()["ok"], true);
        // 用户在插件页单独关掉某一位 → 运行时同样拒绝（清单仍申报着）
        ctx.config.lock().unwrap().plugin_denied_perms.insert("narrow".into(), vec!["settings".into()]);
        let e_denied = call(&ctx, "narrow", "settings.all", json!({})).await.unwrap_err();
        assert!(e_denied.contains("未开启权限 \"settings\""), "{e_denied}");
        // 免权限位的三条永远可见：身份、能力清单、本机解释器
        assert_eq!(
            call(&ctx, "narrow", "caps", json!({})).await.unwrap()["caps"],
            json!(["info", "caps", "runtime.list"])
        );
        // 停用后令牌/清单都不作数
        ctx.config.lock().unwrap().disabled_plugins.push("narrow".into());
        let e2 = call(&ctx, "narrow", "settings.all", json!({})).await.unwrap_err();
        assert!(e2.contains("未启用"), "{e2}");
    }

    /// 清单 interpreters 把 exec.run 收窄到声明过的解释器；不写就维持原口径
    #[tokio::test]
    async fn interpreters_list_narrows_exec_run() {
        let ctx = crate::plugins::test_ctx("caps-interp");
        crate::plugins::write_test_plugin(
            &ctx,
            "gated",
            json!({ "name": "gated", "permissions": ["exec"], "interpreters": ["node"] }),
            &[],
        );
        // 只声明了解释器 → shell 那条路被拒，并教作者怎么放开
        let e = call(&ctx, "gated", "exec.run", json!({ "command": "echo hi" })).await.unwrap_err();
        assert!(e.contains("只允许：node") && e.contains("shell"), "{e}");
        // 跑别的程序同样被拒（哪怕它在本机 PATH 上）
        let e2 = call(&ctx, "gated", "exec.run", json!({ "program": "ping", "args": ["-n", "1", "127.0.0.1"] }))
            .await
            .unwrap_err();
        assert!(e2.contains("不接受运行 ping"), "{e2}");
        // 声明过的解释器放行
        let ok = call(&ctx, "gated", "exec.run", json!({ "program": "node", "args": ["-e", "console.log(1)"], "timeout_ms": 20000 }))
            .await
            .unwrap();
        assert_eq!(ok["code"], 0, "{ok}");
        assert!(ok["stdout"].as_str().unwrap_or("").contains('1'), "{ok}");
        // 没写 interpreters 的插件行为不变（既有插件不受这轮收紧影响）
        crate::plugins::write_test_plugin(&ctx, "open", json!({ "name": "open", "permissions": ["exec"] }), &[]);
        let r = call(&ctx, "open", "exec.run", json!({ "command": "echo bit-open", "timeout_ms": 5000 })).await.unwrap();
        assert_eq!(r["code"], 0);
    }

    /// runtime.list 免权限：插件写代码时最想知道"这台机器上有什么"
    #[tokio::test]
    async fn runtime_list_needs_no_permission() {
        let ctx = crate::plugins::test_ctx("caps-runtime");
        plugin_with(&ctx, "bare", &[]);
        let r = call(&ctx, "bare", "runtime.list", json!({})).await.unwrap();
        assert!(r["runtimes"].is_array(), "{r}");
        // 注册表里有的条目必须带 id 与路径
        for item in r["runtimes"].as_array().unwrap() {
            assert!(item["id"].is_string() && item["path"].is_string(), "{item}");
        }
    }

    #[tokio::test]
    async fn settings_values_are_namespaced_per_plugin() {
        let ctx = crate::plugins::test_ctx("caps-settings");
        plugin_with(&ctx, "pa", &["settings"]);
        plugin_with(&ctx, "pb", &["settings"]);
        call(&ctx, "pa", "settings.set", json!({ "key": "theme", "value": "dark" })).await.unwrap();
        assert_eq!(call(&ctx, "pa", "settings.get", json!({ "key": "theme" })).await.unwrap()["value"], "dark");
        // 同名键在另一个插件名下是另一份数据
        assert_eq!(call(&ctx, "pb", "settings.get", json!({ "key": "theme" })).await.unwrap()["value"], Value::Null);
        assert_eq!(call(&ctx, "pb", "settings.all", json!({})).await.unwrap()["values"], json!({}));
        // 落盘键带 <插件id>/ 前缀
        let m = ctx.db_get_json::<serde_json::Map<String, Value>>("plugin_settings").unwrap_or_default();
        assert!(m.contains_key("pa/theme"), "{m:?}");
        // null 即删除；带 / 的键名会让命名空间塌陷，拒绝
        call(&ctx, "pa", "settings.set", json!({ "key": "theme", "value": null })).await.unwrap();
        assert!(call(&ctx, "pa", "settings.all", json!({})).await.unwrap()["values"].as_object().unwrap().is_empty());
        assert!(call(&ctx, "pa", "settings.set", json!({ "key": "a/b", "value": 1 })).await.is_err());
    }

    #[tokio::test]
    async fn data_files_stay_inside_the_plugins_own_dir() {
        let ctx = crate::plugins::test_ctx("caps-data");
        plugin_with(&ctx, "da", &["data"]);
        call(&ctx, "da", "data.write", json!({ "path": "sub/note.txt", "text": "你好" })).await.unwrap();
        let listed = call(&ctx, "da", "data.list", json!({})).await.unwrap();
        assert_eq!(listed["files"][0]["path"], "sub/note.txt");
        assert_eq!(call(&ctx, "da", "data.read", json!({ "path": "sub/note.txt" })).await.unwrap()["text"], "你好");
        // 目录在插件目录之外：往插件目录里写会撞上防篡改基线
        let root = crate::toolenv::dir(&ctx).join("plugin_data");
        assert!(data_dir(&ctx, "da").starts_with(&root), "{:?}", data_dir(&ctx, "da"));
        // 逃逸与绝对路径：闸门在 safe_rel，符号链接另有 canonical 兜底
        assert!(call(&ctx, "da", "data.write", json!({ "path": "../evil.txt", "text": "x" })).await.is_err());
        assert!(call(&ctx, "da", "data.read", json!({ "path": "C:/Windows/win.ini" })).await.is_err());
        // 别的插件读不到这条文件
        plugin_with(&ctx, "db", &["data"]);
        assert_eq!(call(&ctx, "db", "data.list", json!({})).await.unwrap()["files"].as_array().unwrap().len(), 0);
        call(&ctx, "da", "data.remove", json!({ "path": "sub/note.txt" })).await.unwrap();
        assert!(call(&ctx, "da", "data.read", json!({ "path": "sub/note.txt" })).await.is_err());
    }

    #[tokio::test]
    async fn sessions_are_scoped_and_roles_restricted() {
        let ctx = crate::plugins::test_ctx("caps-session");
        plugin_with(&ctx, "sa", &["session"]);
        call(&ctx, "sa", "session.append", json!({ "role": "user", "content": "插件写进来的" })).await.unwrap();
        let read = call(&ctx, "sa", "session.read", json!({})).await.unwrap();
        assert_eq!(read["session_id"], "plugin:sa");
        assert_eq!(read["messages"].as_array().unwrap().len(), 1);
        // 只能写进自己的命名空间
        assert!(call(&ctx, "sa", "session.read", json!({ "session_id": "chat:main" })).await.is_err());
        // 角色限定三种，插一个没听过的角色前端会渲染空气泡
        assert!(call(&ctx, "sa", "session.append", json!({ "role": "admin", "content": "x" })).await.is_err());
        assert!(call(&ctx, "sa", "session.append", json!({ "role": "user", "content": "  " })).await.is_err());
        assert_eq!(call(&ctx, "sa", "session.list", json!({})).await.unwrap()["sessions"].as_array().unwrap().len(), 1);
        // 唤醒：会话不存在也要有落点（续跑链路会丢弃不存在的会话，所以这里先补出来）
        let w = call(&ctx, "sa", "session.wake", json!({ "session_id": "plugin:sa:task-1", "text": "该活了" })).await.unwrap();
        assert_eq!(w["session_id"], "plugin:sa:task-1");
        assert_eq!(call(&ctx, "sa", "session.list", json!({})).await.unwrap()["sessions"].as_array().unwrap().len(), 2);
        assert!(call(&ctx, "sa", "session.wake", json!({ "session_id": "chat:main", "text": "x" })).await.is_err());
        assert!(call(&ctx, "sa", "session.wake", json!({ "session_id": "plugin:sa" })).await.is_err(), "空 text 不算唤醒");
    }

    #[tokio::test]
    async fn workwith_and_notify_inputs_are_checked() {
        let ctx = crate::plugins::test_ctx("caps-ww");
        plugin_with(&ctx, "wa", &["workwith", "notify"]);
        // 先放好脚本再触发首次校验：首调会记录哈希基线，之后再写插件目录会被判成篡改
        std::fs::write(crate::plugins::dir(&ctx).join("wa").join("svc.js"), "// demo").unwrap();
        // 绝对路径放行（清单/用户已明示 workwith），但仍要求真实存在
        let self_exe = std::env::current_exe().unwrap().to_string_lossy().to_string();
        call(&ctx, "wa", "workwith.save", json!({ "name": "abs", "program": self_exe })).await.unwrap();
        let e = call(&ctx, "wa", "workwith.save", json!({ "name": "svc", "program": "missing/none.js" })).await.unwrap_err();
        assert!(e.contains("程序不存在"), "{e}");
        // 纯程序名（custom）交给 PATH；解释器脚本仍按插件目录解析并要求存在
        call(&ctx, "wa", "workwith.save", json!({ "name": "path", "program": "cmd" })).await.unwrap();
        call(&ctx, "wa", "workwith.save", json!({ "name": "rel", "program": "svc.js", "runtime": "js" })).await.unwrap();
        let e = call(&ctx, "wa", "workwith.save", json!({ "name": "cwd", "program": "svc.js", "runtime": "js", "cwd": "missing" })).await.unwrap_err();
        assert!(e.contains("工作目录不存在"), "{e}");
        assert_eq!(call(&ctx, "wa", "workwith.list", json!({})).await.unwrap()["entries"].as_array().unwrap().len(), 3);
        // 通知要有正文，否则弹一条空通知只会打扰用户
        assert!(call(&ctx, "wa", "notify", json!({ "title": "完成了" })).await.is_err());
        assert_eq!(call(&ctx, "wa", "notify", json!({ "title": "完成了", "body": "同步 12 条" })).await.unwrap()["ok"], true);
    }

    #[tokio::test]
    async fn caps_only_lists_what_the_plugin_declared() {
        let ctx = crate::plugins::test_ctx("caps-info");
        plugin_with(&ctx, "ia", &["settings", "notify"]);
        let out = call(&ctx, "ia", "caps", json!({})).await.unwrap();
        let caps = out["caps"].as_array().unwrap();
        let has = |v: &str| caps.iter().any(|x| x.as_str() == Some(v));
        assert!(has("settings.set") && has("notify") && has("info") && has("caps"), "{out}");
        assert!(!has("data.write") && !has("workwith.start") && !has("session.append"), "未申报的不能出现在 caps 里：{out}");
        let info = call(&ctx, "ia", "info", json!({})).await.unwrap();
        assert_eq!(info["plugin_id"], "ia");
        assert_eq!(info["has_settings"], false);
    }
}
