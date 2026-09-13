// yxpil · BIT
// 行协议 REPL：stdin 逐行、stdout 逐行。管道 / 无 TTY / E2E / --plain 走这里。
use std::io::Write;
use std::sync::Arc;

use crate::state::Ctx;
use crate::tui::{Flow, Out, handle};

/// 不返回（进程内退出）
pub fn run(ctx: Arc<Ctx>, app: tauri::AppHandle) -> ! {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // stdin 线程持有 ctx 副本：/interrupt 必须在回合 await 期间也能即时置位，
    // 不能走 mpsc 队列（队列里的命令要等当前回合结束才被处理）
    let stdin_ctx = ctx.clone();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = String::new();
        loop {
            buf.clear();
            match std::io::BufRead::read_line(&mut stdin.lock(), &mut buf) {
                Ok(0) | Err(_) => break, // EOF（管道关闭）与读错误都视为退出
                Ok(_) => {
                    let line = buf.trim_end().trim();
                    // 中断行就地处理：对当前激活会话置标志，回执直接打到 stdout
                    if line.eq_ignore_ascii_case("/interrupt") {
                        let active = stdin_ctx.sessions.lock().unwrap().active.clone();
                        if crate::agent::request_stop(&stdin_ctx, &active) {
                            println!("[interrupt] 已请求中断当前回合…");
                        } else {
                            println!("[interrupt] 当前会话没有进行中的回合");
                        }
                        let _ = std::io::stdout().flush();
                        continue;
                    }
                    if tx.send(line.to_string()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let inner_ctx = ctx.clone();
    let ver = app.package_info().version.clone();
    tauri::async_runtime::block_on(async move {
        let ctx = inner_ctx;
        // ── 启动横幅（带 ANSI 真彩）──
        use std::io::IsTerminal;
        let is_term = std::io::stdout().is_terminal();
        if is_term {
            println!("\x1b[1;35m╭─ BIT TUI v{ver} ────────────────────────────────────────╮\x1b[0m");
            println!("\x1b[1;35m│\x1b[0m  \x1b[36m/help\x1b[0m 查看命令 · \x1b[36m/quit\x1b[0m 退出 · \x1b[36m/interrupt\x1b[0m 中断当前回合  \x1b[1;35m│\x1b[0m");
            println!("\x1b[1;35m╰─────────────────────────────────────────────────────────╯\x1b[0m");
        } else {
            println!("BIT TUI v{ver}");
            println!("/help 查看命令 · /quit 退出");
        }
        if !ctx.ai_config.lock().unwrap().is_configured() {
            println!("[提示] AI 尚未配置：请先在桌面端「AI 设置」配置提供方，对话功能暂不可用。");
        }

        let out = Out::Stdout;
        loop {
            // prompt：terminal 时彩色 + 会话标题 + model，管道时简单 bit>
            if is_term {
                print!("{}", crate::tui::ansi_prompt(&ctx));
            } else {
                print!("bit> ");
            }
            let _ = std::io::stdout().flush();
            let Some(line) = rx.recv().await else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // 非斜杠命令 = 对话：先打印回合分隔 + 用户回显（handle 内部不做回显，
            // plain 模式由外层统一处理，让彩色/时间戳/loading 一致）
            let is_chat = !line.starts_with('/');
            if is_chat {
                let ts = chrono::Local::now().format("%H:%M").to_string();
                if is_term {
                    println!("\x1b[90m─── {ts} ───\x1b[0m");
                    println!("\x1b[1;36m{ts} 你: {line}\x1b[0m");
                    println!("\x1b[90m⏳ 思考中…\x1b[0m");
                } else {
                    println!("─── {ts} ───");
                    println!("{ts} 你: {line}");
                    println!("⏳ 思考中…");
                }
            }
            let start = std::time::Instant::now();
            match handle(&ctx, line, &out).await {
                Ok(Flow::Continue) => {
                    if is_chat {
                        let elapsed = start.elapsed().as_secs_f64();
                        // 回合尾部：耗时 + token 用量 + 缓存命中
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
                                    (true, true) => format!("{:.1}s · {}tok · \x1b[32m缓存 {:.0}%\x1b[0m", elapsed, s.prompt_tokens, hit_pct),
                                    (true, false) => format!("{:.1}s · {}tok", elapsed, s.prompt_tokens),
                                    _ => format!("{:.1}s", elapsed),
                                }
                            } else {
                                format!("{:.1}s", elapsed)
                            };
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
                        println!("\x1b[1;31m错误：{e}\x1b[0m");
                        println!("\x1b[90m└─ {:.1}s\x1b[0m", elapsed);
                    } else {
                        println!("错误：{e}");
                    }
                }
            }
        }
        if is_term {
            println!("\x1b[1;32m👋 再见。\x1b[0m");
        } else {
            println!("再见。");
        }
    });

    crate::audit::record(&ctx, "local-cli", "app.quit", "tui", serde_json::json!({}), true);
    // Windows：还原 attach_console 改过的控制台代码页（UTF-8 → 原值），不污染用户终端
    crate::restore_console_cp();
    // CLI 直接退出：不依赖 tauri 事件循环收尾（Linux 无窗口场景 app.exit 不可靠）
    std::process::exit(0)
}
