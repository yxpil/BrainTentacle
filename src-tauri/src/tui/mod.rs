// yxpil · BIT
// TUI entry + shared command dispatch.
// Two UIs share handle():
// - plain: line-reader REPL (no TTY, pipes, --plain)
// - full:  Ratatui fullscreen (real terminal)
#[cfg(feature = "tui-ui")]
mod full;
mod plain;

use std::sync::Arc;
use crate::state::Ctx;

pub(crate) const HELP: &str = "\
Commands:
  /help            Show this help
  /sessions        List sessions
  /new [title]     Create and switch session
  /use <id>        Switch session (prefix OK)
  /rename [id] <t> Rename session
  /delete [id]     Delete session
  /clear           Clear messages (keep session)
  /goals           List goals
  /todo            List todos
  /approval [m]    Approval mode: ask | auto | allow_all
  /interrupt       Stop current turn
  /tools           List tools
  /runtimes        List runtimes
  /mem <text>      Save a memory
  /mems            List memories
  /pwd             Show workspace root
  /cd <path>       Change workspace
  /install-cli     Install 'bit' to PATH
  /quit            Exit
Anything else → chat with AI.";

pub(crate) enum Flow { Continue, Exit }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MsgKind {
    System, User, Assistant, Tool, Error, Divider,
}

#[derive(Clone)]
pub(crate) enum Out {
    Stdout,
    Chan(tokio::sync::mpsc::UnboundedSender<(MsgKind, String)>),
}

impl Out {
    pub(crate) fn line(&self, s: impl Into<String>) {
        self.line_with_kind(MsgKind::System, s.into());
    }
    pub(crate) fn line_with_kind(&self, kind: MsgKind, s: impl Into<String>) {
        let s = s.into();
        match self {
            Out::Stdout => {
                use std::io::IsTerminal;
                if std::io::stdout().is_terminal() {
                    println!("{}", ansi_colorize(kind, &s));
                } else {
                    println!("{}", s);
                }
            }
            Out::Chan(tx) => { let _ = tx.send((kind, s)); }
        }
    }
}

fn ansi_colorize(kind: MsgKind, s: &str) -> String {
    let (fg, bold) = match kind {
        MsgKind::System => (90, false),
        MsgKind::User => (36, true),
        MsgKind::Assistant => (32, false),
        MsgKind::Tool => (33, false),
        MsgKind::Error => (31, true),
        MsgKind::Divider => (90, false),
    };
    if bold { format!("\x1b[1;{fg}m{s}\x1b[0m") } else { format!("\x1b[{fg}m{s}\x1b[0m") }
}

pub(crate) fn ansi_prompt(ctx: &Arc<Ctx>) -> String {
    let (sid, title) = {
        let store = ctx.sessions.lock().unwrap();
        let active = store.active.clone();
        match store.sessions.iter().find(|s| s.id == active) {
            Some(s) => (
                s.id[..s.id.len().min(6)].to_string(),
                if s.title.trim().is_empty() { "Untitled".into() } else { s.title.clone() },
            ),
            None => ("------".into(), "Untitled".into()),
        }
    };
    let model = ctx.ai_config.lock().unwrap().active()
        .map(|p| p.model.clone())
        .unwrap_or_else(|| "none".into());
    format!(
        "\x1b[1;36m[{}]\x1b[0;90m {model} · {sid}\x1b[0m \x1b[1;32mbit>\x1b[0m ",
        title.chars().take(16).collect::<String>()
    )
}

pub fn run_blocking(ctx: Arc<Ctx>, app: tauri::AppHandle) -> ! {
    use std::io::IsTerminal;
    let force_plain = std::env::args().any(|a| a == "--plain");
    if force_plain || !std::io::stdout().is_terminal() {
        plain::run(ctx, app)
    } else {
        #[cfg(feature = "tui-ui")] { full::run(ctx, app) }
        #[cfg(not(feature = "tui-ui"))] { plain::run(ctx, app) }
    }
}

pub(crate) async fn handle(ctx: &Arc<Ctx>, line: &str, out: &Out) -> Result<Flow, String> {
    if let Some(cmd) = line.strip_prefix('/') {
        let (cmd, arg) = match cmd.split_once(' ') {
            Some((c, a)) => (c.trim(), a.trim()),
            None => (cmd.trim(), ""),
        };
        return match cmd.to_lowercase().as_str() {
            "help" | "?" => { out.line(HELP); Ok(Flow::Continue) }
            "sessions" => {
                let store = ctx.sessions.lock().unwrap();
                for s in &store.sessions {
                    let mark = if s.id == store.active { "*" } else { " " };
                    out.line(format!("{mark} {}  [{:>2}]  {}", &s.id[..s.id.len().min(8)], s.messages.len(), s.title));
                }
                Ok(Flow::Continue)
            }
            "new" => {
                let id;
                {
                    let mut store = ctx.sessions.lock().unwrap();
                    let s = crate::session::Session::new(arg);
                    id = s.id.clone();
                    store.sessions.push(s);
                    store.active = id.clone();
                }
                ctx.save_sessions();
                out.line(format!("Session {} created and switched", &id[..8]));
                Ok(Flow::Continue)
            }
            "use" => {
                if arg.is_empty() { return Err("Usage: /use <id>".into()); }
                let (sid, title) = {
                    let mut store = ctx.sessions.lock().unwrap();
                    let hit = store.sessions.iter().find(|s| s.id.starts_with(arg))
                        .map(|s| s.id.clone())
                        .ok_or_else(|| "Session not found".to_string())?;
                    store.active = hit.clone();
                    let title = store.sessions.iter().find(|s| s.id == hit).map(|s| s.title.clone()).unwrap_or_default();
                    (hit, title)
                };
                ctx.save_sessions();
                out.line(format!("Switched to {} ({})", &sid[..8], title));
                Ok(Flow::Continue)
            }
            "tools" => {
                let tools = ctx.tools.lock().unwrap();
                if tools.is_empty() { out.line("(no tools)"); }
                for t in tools.iter() {
                    let kind = match &t.kind {
                        crate::registry::ToolKind::Builtin { .. } => "builtin",
                        crate::registry::ToolKind::Remote { .. } => "remote",
                        crate::registry::ToolKind::Script { .. } => "script",
                        crate::registry::ToolKind::Interpreter { .. } => "interp",
                        crate::registry::ToolKind::Mcp { .. } => "mcp",
                    };
                    out.line(format!("{:<3} {:<16} {:<8} {}", if t.enabled { "on" } else { "off" }, t.name, kind, t.description));
                }
                Ok(Flow::Continue)
            }
            "mem" => {
                if arg.is_empty() { return Err("Usage: /mem <text>".into()); }
                let m = crate::memory::add_memory(ctx, arg, "raw", "user");
                crate::audit::record(ctx, "local-cli", "memory.add", "memories", serde_json::json!({}), true);
                out.line(format!("Memory saved: {}", &m.id[..m.id.len().min(8)]));
                Ok(Flow::Continue)
            }
            "mems" => {
                let mems = ctx.memories.lock().unwrap();
                if mems.is_empty() { out.line("(no memories)"); }
                for m in mems.iter().rev() {
                    out.line(format!("{}  {}  {}", &m.id[..m.id.len().min(8)], m.ts, m.content));
                }
                Ok(Flow::Continue)
            }
            "install-cli" => {
                let r = crate::commands::install_cli_impl(ctx)?;
                out.line(format!("bit CLI installed: {}", r["path"].as_str().unwrap_or("")));
                if let Some(hint) = r["hint"].as_str() {
                    if !hint.is_empty() { out.line(format!("Hint: {hint}")); }
                }
                Ok(Flow::Continue)
            }
            "rename" => {
                if arg.is_empty() { return Err("Usage: /rename [prefix] <title>".into()); }
                let (id, title) = {
                    let store = ctx.sessions.lock().unwrap();
                    match arg.split_once(' ') {
                        Some((prefix, rest)) if store.sessions.iter().any(|s| s.id.starts_with(prefix)) => {
                            (store.sessions.iter().find(|s| s.id.starts_with(prefix)).unwrap().id.clone(), rest.trim().to_string())
                        }
                        _ => (store.active.clone(), arg.to_string()),
                    }
                };
                {
                    let mut store = ctx.sessions.lock().unwrap();
                    let s = store.get_mut(&id).ok_or_else(|| "Session not found".to_string())?;
                    s.title = if title.trim().is_empty() { "Untitled".into() } else { title.trim().to_string() };
                }
                ctx.save_sessions();
                out.line(format!("Session {} renamed → {}", &id[..id.len().min(8)], title.trim()));
                Ok(Flow::Continue)
            }
            "delete" | "rm" => {
                let target_id = if arg.is_empty() {
                    ctx.sessions.lock().unwrap().active.clone()
                } else {
                    ctx.sessions.lock().unwrap().sessions.iter()
                        .find(|s| s.id.starts_with(arg))
                        .map(|s| s.id.clone())
                        .ok_or_else(|| "Session not found".to_string())?
                };
                let (active, removed_title) = {
                    let mut store = ctx.sessions.lock().unwrap();
                    let title = store.sessions.iter().find(|s| s.id == target_id).map(|s| s.title.clone()).unwrap_or_default();
                    store.sessions.retain(|s| s.id != target_id);
                    if store.sessions.is_empty() {
                        let s = crate::session::Session::new("New Chat");
                        store.active = s.id.clone();
                        store.sessions.push(s);
                    } else if store.active == target_id {
                        store.active = store.sessions.last().map(|s| s.id.clone()).unwrap_or_default();
                    }
                    (store.active.clone(), title)
                };
                ctx.save_sessions();
                out.line(format!("Session {} deleted ({})", &target_id[..target_id.len().min(8)], removed_title));
                if let Some(s) = ctx.sessions.lock().unwrap().sessions.iter().find(|s| s.id == active) {
                    out.line(format!("Current: {} ({})", &s.id[..s.id.len().min(8)], s.title));
                }
                Ok(Flow::Continue)
            }
            "clear" => {
                let id = ctx.sessions.lock().unwrap().active.clone();
                let n = {
                    let mut store = ctx.sessions.lock().unwrap();
                    let s = store.get_mut(&id).ok_or_else(|| "Session not found".to_string())?;
                    let n = s.messages.len();
                    s.messages.clear();
                    s.touch();
                    n
                };
                ctx.save_sessions();
                out.line(format!("Cleared {n} messages"));
                Ok(Flow::Continue)
            }
            "goals" => {
                let goals = ctx.goals.lock().unwrap();
                if goals.is_empty() { out.line("(no goals)"); }
                for g in goals.iter().rev() {
                    out.line(format!("{:<8} [{}] {}", &g.id[..g.id.len().min(8)], g.status, g.title));
                }
                Ok(Flow::Continue)
            }
            "todo" | "todos" => {
                let todos = ctx.todos.lock().unwrap();
                if todos.is_empty() { out.line("(no todos)"); }
                let goals = ctx.goals.lock().unwrap();
                for t in todos.iter().rev() {
                    let g = t.goal_id.as_deref()
                        .and_then(|gid| goals.iter().find(|g| g.id == gid))
                        .map(|g| g.title.as_str())
                        .unwrap_or("standalone");
                    out.line(format!("[{}] {:<8} {} · {}", t.status, &t.id[..t.id.len().min(8)], t.content, g));
                }
                Ok(Flow::Continue)
            }
            "approval" => {
                if arg.is_empty() {
                    out.line(format!("Approval: {} (ask / auto / allow_all)", ctx.config.lock().unwrap().tool_approval));
                    return Ok(Flow::Continue);
                }
                match arg {
                    "ask" | "auto" | "allow_all" => {
                        ctx.config.lock().unwrap().tool_approval = arg.to_string();
                        ctx.save_config();
                        out.line(format!("Approval → {arg}"));
                    }
                    _ => return Err("Only ask / auto / allow_all".into()),
                }
                Ok(Flow::Continue)
            }
            "runtimes" | "rt" => {
                let runtimes = ctx.runtimes.lock().unwrap();
                if runtimes.is_empty() { out.line("(no runtimes — refresh in desktop app)"); }
                for r in runtimes.iter() {
                    out.line(format!("{:<3} {:<8} {:<10} {}", if r.enabled { "on" } else { "off" }, r.lang, r.id, r.name));
                }
                Ok(Flow::Continue)
            }
            "pwd" => {
                match crate::sandbox::effective_root(ctx) {
                    Some(ws) => out.line(ws.display().to_string()),
                    None => out.line("(no workspace — shell uses cwd)"),
                }
                Ok(Flow::Continue)
            }
            "cd" => {
                if arg.is_empty() {
                    return match crate::sandbox::effective_root(ctx) {
                        Some(ws) => { out.line(ws.display().to_string()); Ok(Flow::Continue) }
                        None => Err("Usage: /cd <absolute path>".into()),
                    };
                }
                let p = std::path::PathBuf::from(arg);
                if !p.is_absolute() { return Err("Use absolute path".into()); }
                if !p.is_dir() { return Err(format!("Not a directory: {}", p.display()).into()); }
                *ctx.workspace_root.lock().unwrap() = Some(p.clone());
                out.line(format!("Workspace → {}", p.display()));
                Ok(Flow::Continue)
            }
            "interrupt" => {
                let active = ctx.sessions.lock().unwrap().active.clone();
                if crate::agent::request_stop(ctx, &active) {
                    out.line("[interrupt] stop requested…".to_string());
                } else {
                    out.line("[interrupt] no turn in progress".to_string());
                }
                Ok(Flow::Continue)
            }
            "quit" | "exit" | "q" => Ok(Flow::Exit),
            other => Err(format!("Unknown /{other} — try /help")),
        };
    }

    let sid = ctx.sessions.lock().unwrap().active.clone();
    let before = {
        let store = ctx.sessions.lock().unwrap();
        store.sessions.iter().find(|s| s.id == sid).map(|s| s.messages.len()).unwrap_or(0)
    };
    let messages = crate::agent::chat_turn_auto(ctx, "", line, Vec::new()).await?;
    let sess = ctx.sessions.lock().unwrap();
    if let Some(s) = sess.sessions.iter().find(|s| s.id == sid) {
        for m in s.messages.iter().skip(before) {
            if m.role == "assistant" {
                if !m.content.trim().is_empty() {
                    out.line_with_kind(MsgKind::Assistant, m.content.trim().to_string());
                }
                for tc in &m.tool_calls {
                    let ok_str = if tc.ok { "OK" } else { "FAIL" };
                    out.line_with_kind(MsgKind::Tool, format!("  \u{25B6} {} → {}", tc.tool, ok_str));
                    let params_str = match &tc.params {
                        serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                            serde_json::to_string_pretty(&tc.params).unwrap_or_else(|_| tc.params.to_string())
                        }
                        _ => tc.params.to_string(),
                    };
                    let preview = if params_str.chars().count() > 140 {
                        params_str.chars().take(140).collect::<String>() + "…"
                    } else { params_str };
                    if !preview.trim().is_empty() {
                        out.line_with_kind(MsgKind::System, format!("    {}", preview.trim()));
                    }
                }
            }
        }
    }
    let _ = messages;
    Ok(Flow::Continue)
}
