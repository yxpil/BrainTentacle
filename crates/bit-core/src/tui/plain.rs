// yxpil · BIT
// Line-protocol REPL: stdin line-by-line → stdout line-by-line.
// Used for pipes, no TTY, E2E, --plain forced mode.
use std::io::Write;
use std::sync::Arc;

use crate::state::Ctx;
use crate::tui::{Flow, Out, handle};

/// Never returns (process exits here)
pub fn run(ctx: Arc<Ctx>) -> ! {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stdin_ctx = ctx.clone();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = String::new();
        loop {
            buf.clear();
            match std::io::BufRead::read_line(&mut stdin.lock(), &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = buf.trim_end().trim();
                    if line.eq_ignore_ascii_case("/interrupt") {
                        let active = stdin_ctx.sessions.lock().unwrap().active.clone();
                        if crate::agent::request_stop(&stdin_ctx, &active) {
                            println!("[interrupt] stop requested…");
                        } else {
                            println!("[interrupt] no turn in progress");
                        }
                        let _ = std::io::stdout().flush();
                        continue;
                    }
                    if tx.send(line.to_string()).is_err() { break; }
                }
            }
        }
    });

    let inner_ctx = ctx.clone();
    let ver = ctx.app_version.clone();
    crate::task::block_on(async move {
        let ctx = inner_ctx;
        use std::io::IsTerminal;
        let is_term = std::io::stdout().is_terminal();

        // ── Banner ──
        if is_term {
            println!("\x1b[1;35m╭─ BIT TUI v{ver} ────────────────────────────────────────╮\x1b[0m");
            println!("\x1b[1;35m│\x1b[0m  \x1b[36m/help\x1b[0m commands · \x1b[36m/quit\x1b[0m exit · \x1b[36m/interrupt\x1b[0m stop turn  \x1b[1;35m│\x1b[0m");
            println!("\x1b[1;35m╰─────────────────────────────────────────────────────────╯\x1b[0m");
        } else {
            println!("BIT TUI v{ver}");
            println!("/help commands · /quit exit");
        }
        if !ctx.ai_config.lock().unwrap().is_configured() {
            println!("[Note] No AI provider configured — open desktop Settings → AI.");
        }

        let out = Out::Stdout;
        loop {
            if is_term {
                print!("{}", crate::tui::ansi_prompt(&ctx));
            } else {
                print!("bit> ");
            }
            let _ = std::io::stdout().flush();
            let Some(line) = rx.recv().await else { break };
            let line = line.trim();
            if line.is_empty() { continue; }
            let is_chat = !line.starts_with('/');
            if is_chat {
                let ts = chrono::Local::now().format("%H:%M").to_string();
                if is_term {
                    println!("\x1b[90m─── {ts} ───\x1b[0m");
                    println!("\x1b[1;36m{ts} you: {line}\x1b[0m");
                    println!("\x1b[90m⏳ Thinking…\x1b[0m");
                } else {
                    println!("─── {ts} ───");
                    println!("{ts} you: {line}");
                    println!("⏳ Thinking…");
                }
            }
            let start = std::time::Instant::now();
            match handle(&ctx, line, &out).await {
                Ok(Flow::Continue) => {
                    if is_chat {
                        let elapsed = start.elapsed().as_secs_f64();
                        if is_term {
                            let stats = {
                                let store = ctx.sessions.lock().unwrap();
                                let active = store.active.clone();
                                drop(store);
                                let map = ctx.cache_stats.lock().unwrap();
                                map.get(&active).cloned()
                            };
                            let info = if let Some(s) = stats {
                                let hit_pct = if s.prompt_tokens > 0 {
                                    (s.cache_read_tokens as f64 / s.prompt_tokens as f64) * 100.0
                                } else { 0.0 };
                                match (s.prompt_tokens > 0, s.cache_read_tokens > 0) {
                                    (true, true) => format!("{:.1}s · {}tok · \x1b[32mcache {:.0}%\x1b[0m", elapsed, s.prompt_tokens, hit_pct),
                                    (true, false) => format!("{:.1}s · {}tok", elapsed, s.prompt_tokens),
                                    _ => format!("{:.1}s", elapsed),
                                }
                            } else { format!("{:.1}s", elapsed) };
                            println!("\x1b[90m└─ {}\x1b[0m", info);
                        } else {
                            println!("└─ {:.1}s", elapsed);
                        }
                    }
                }
                Ok(Flow::Exit) => break,
                Err(e) => {
                    let elapsed = start.elapsed().as_secs_f64();
                    if is_term {
                        println!("\x1b[1;31mError: {e}\x1b[0m");
                        println!("\x1b[90m└─ {:.1}s\x1b[0m", elapsed);
                    } else {
                        println!("Error: {e}");
                    }
                }
            }
        }
        if is_term { println!("\x1b[1;32m👋 Bye.\x1b[0m"); } else { println!("Bye."); }
    });

    crate::audit::record(&ctx, "local-cli", "app.quit", "tui", serde_json::json!({}), true);
    crate::restore_console_cp();
    std::process::exit(0)
}
