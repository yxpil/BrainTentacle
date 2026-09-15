// yxpil · BIT
// 全屏 TUI（Ratatui）：状态栏 + 消息区（按角色着色 + 时间戳） + 圆角输入框（完整行编辑 + 历史 + Tab 补全）。
// F 键面板：F1=帮助, F2=会话侧栏, F3=工具侧栏, F4=目标/待办侧栏。
// 键盘事件由专用 OS 线程读取（crossterm event::read 阻塞），跨线程送 tokio 循环；
// Agent 回合在独立 task 跑，输出走 Out::Chan 回流，打字/中断不被 await 卡住。
use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Direction};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::Terminal;

use crate::state::Ctx;
use crate::tui::{Flow, MsgKind, Out, handle, HELP};

/// 键盘事件线程 → UI 循环
type KeyTx = tokio::sync::mpsc::UnboundedSender<crossterm::event::KeyEvent>;
/// Agent 回合结束通知
type DoneTx = tokio::sync::mpsc::UnboundedSender<Result<Flow, String>>;

/// 斜杠命令列表（Tab 补全 + F1 帮助面板共用）
const SLASH_COMMANDS: &[&str] = &[
    "/help", "/sessions", "/new", "/use", "/rename", "/delete", "/clear",
    "/goals", "/todo", "/approval", "/interrupt", "/tools", "/runtimes",
    "/mem", "/mems", "/pwd", "/cd", "/install-cli", "/quit",
];

/// RAII 终端恢复：任何退出路径（含 unwinding panic）都还原用户终端
struct TerminalGuard {
    _t: Terminal<CrosstermBackend<Stdout>>,
}

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
        let t = Terminal::new(CrosstermBackend::new(stdout))?;
        Ok(Self { _t: t })
    }
    fn terminal(&mut self) -> &mut Terminal<CrosstermBackend<Stdout>> {
        &mut self._t
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen, DisableMouseCapture);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SidePanel {
    None,
    Sessions,
    Tools,
    Goals,
}

struct App {
    /// 消息列表：(kind, text)
    lines: Vec<(MsgKind, String)>,
    input: String,
    /// 输入光标位置（字符索引）
    cursor: usize,
    /// 距底部的滚动行数：0 = 始终贴底；PageUp 翻历史时挂住
    scroll_back: usize,
    busy: bool,
    /// 命令历史（已发送的非空输入），用于 Up/Down 箭头
    history: Vec<String>,
    /// 当前正在浏览的历史索引（None = 正在输入新内容）
    history_idx: Option<usize>,
    /// 当前侧栏
    panel: SidePanel,
}

impl App {
    fn new() -> Self {
        Self {
            lines: vec![(MsgKind::System, HELP.to_string())],
            input: String::new(),
            cursor: 0,
            scroll_back: 0,
            busy: false,
            history: Vec::new(),
            history_idx: None,
            panel: SidePanel::None,
        }
    }
    fn push(&mut self, kind: MsgKind, s: String) {
        const MAX_LINES: usize = 8000;
        self.lines.push((kind, s));
        if self.lines.len() > MAX_LINES {
            let drop_n = self.lines.len() - MAX_LINES;
            self.lines.drain(0..drop_n);
        }
    }

    /// 将光标保持在合法范围内
    fn clamp_cursor(&mut self) {
        if self.cursor > self.input.len() {
            self.cursor = self.input.len();
        }
    }

    /// Tab 补全斜杠命令
    fn tab_complete(&mut self) {
        let input = self.input.as_str();
        if !input.starts_with('/') {
            return;
        }
        // 取最后一个空格后的部分（支持在 /cmd1 /cmd2 这种多命令场景只补最后一个）
        let segment_start = input.rfind(' ').map(|i| i + 1).unwrap_or(0);
        let segment = &input[segment_start..];
        if segment.is_empty() || segment.contains(' ') {
            return;
        }
        let matches: Vec<&&str> = SLASH_COMMANDS.iter().filter(|c| c.starts_with(segment)).collect();
        if matches.len() == 1 {
            let replacement = matches[0];
            self.input = format!("{}{}", &input[..segment_start], replacement);
            self.cursor = self.input.len();
        } else if matches.len() > 1 {
            // 找公共前缀
            let strs: Vec<&str> = matches.iter().map(|s| **s).collect();
            let common = longest_common_prefix(&strs);
            if common.len() > segment.len() {
                self.input = format!("{}{}", &input[..segment_start], common);
                self.cursor = self.input.len();
            } else {
                // 无解，列出候选（作为系统消息追加）
                let mut preview = String::from("可用命令: ");
                for c in matches {
                    preview.push_str(c);
                    preview.push(' ');
                }
                self.push(MsgKind::System, preview.trim_end().to_string());
            }
        }
    }
}

fn longest_common_prefix(strs: &[&str]) -> String {
    if strs.is_empty() {
        return String::new();
    }
    let first = strs[0];
    for (i, _) in first.char_indices().skip(1) {
        if !strs.iter().all(|s| s.starts_with(&first[..i])) {
            return first[..i - 1].to_string();
        }
    }
    first.to_string()
}

/// 不返回（进程内退出）
pub fn run(ctx: Arc<Ctx>) -> ! {
    let mut term = match TerminalGuard::enter() {
        Ok(t) => t,
        // raw mode 进不去（某些奇葩终端）：回退行协议，保证可用
        Err(_) => return super::plain::run(ctx),
    };

    let (key_tx, mut key_rx) = tokio::sync::mpsc::unbounded_channel::<crossterm::event::KeyEvent>();
    spawn_key_thread(key_tx);

    let result = crate::task::block_on(async_main(ctx.clone(), &mut term, &mut key_rx));

    // drop guard 还原终端后再打印收尾/退出
    drop(term);
    if let Err(e) = result {
        println!("BIT TUI 异常退出：{e}");
    }
    crate::audit::record(&ctx, "local-cli", "app.quit", "tui", serde_json::json!({ "ui": "ratatui" }), true);
    crate::restore_console_cp();
    std::process::exit(0)
}

async fn async_main(
    ctx: Arc<Ctx>,
    term: &mut TerminalGuard,
    key_rx: &mut tokio::sync::mpsc::UnboundedReceiver<crossterm::event::KeyEvent>,
) -> Result<(), String> {
    let mut ui = App::new();
    let ver = ctx.app_version.clone();
    ui.push(MsgKind::System, format!("BIT TUI v{}（全屏界面 · 输入 /help 查看命令）", ver));
    if !ctx.ai_config.lock().unwrap().is_configured() {
        ui.push(
            MsgKind::Error,
            "[提示] AI 尚未配置：请先在桌面端「AI 设置」配置提供方，对话功能暂不可用。".into(),
        );
    }

    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<(MsgKind, String)>();
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<Result<Flow, String>>();

    draw(term.terminal(), &ctx, &ui).ok();

    loop {
        tokio::select! {
            // Agent/命令输出行
            Some((kind, line)) = out_rx.recv() => {
                ui.push(kind, line);
                draw(term.terminal(), &ctx, &ui).ok();
            }
            // 回合结束
            Some(res) = done_rx.recv() => {
                ui.busy = false;
                match res {
                    Ok(Flow::Exit) => {
                        ui.push(MsgKind::System, "再见。".into());
                        draw(term.terminal(), &ctx, &ui).ok();
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        return Ok(());
                    }
                    Ok(Flow::Continue) => {}
                    Err(e) => ui.push(MsgKind::Error, format!("错误：{e}")),
                }
                draw(term.terminal(), &ctx, &ui).ok();
            }
            // 键盘
            maybe_key = key_rx.recv() => {
                let Some(key) = maybe_key else { return Ok(()); };
                // Windows 下 release/repeat 都会来，只吃 press 避免重复触发
                if key.kind != crossterm::event::KeyEventKind::Press && key.kind != crossterm::event::KeyEventKind::Repeat {
                    continue;
                }
                let mut want_quit = false;
                match key.code {
                    KeyCode::Enter if !ui.busy => {
                        let line = ui.input.trim().to_string();
                        ui.input.clear();
                        ui.cursor = 0;
                        ui.scroll_back = 0;
                        ui.history_idx = None;
                        if !line.is_empty() {
                            ui.history.push(line.clone());
                            // full 模式自己发回合分隔 + 用户回显（plain 模式由 REPL 提示符处理）
                            ui.push(MsgKind::Divider, "───".into());
                            ui.push(MsgKind::User, format!("你: {line}"));
                            spawn_turn(ctx.clone(), line, out_tx.clone(), done_tx.clone());
                            ui.busy = true;
                        }
                    }
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => want_quit = true,
                    KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) && ui.input.is_empty() => want_quit = true,
                    KeyCode::Esc => {
                        // Esc = 中断当前回合（不退出；退出请 /quit 或 Ctrl+C）
                        if ui.busy {
                            let active = ctx.sessions.lock().unwrap().active.clone();
                            if crate::agent::request_stop(&ctx, &active) {
                                ui.push(MsgKind::System, "[interrupt] 已请求中断当前回合…".into());
                            }
                        } else {
                            // 非 busy 时 Esc 关闭侧栏
                            ui.panel = SidePanel::None;
                        }
                    }
                    // ── 完整行编辑 ──
                    KeyCode::Left => {
                        if ui.cursor > 0 {
                            ui.cursor -= 1;
                            // 处理多字节 UTF-8：可能需要再退
                            while ui.cursor > 0 && !ui.input.is_char_boundary(ui.cursor) {
                                ui.cursor -= 1;
                            }
                        }
                    }
                    KeyCode::Right => {
                        if ui.cursor < ui.input.len() {
                            ui.cursor += 1;
                            while ui.cursor < ui.input.len() && !ui.input.is_char_boundary(ui.cursor) {
                                ui.cursor += 1;
                            }
                        }
                    }
                    KeyCode::Home => ui.cursor = 0,
                    KeyCode::End => ui.cursor = ui.input.len(),
                    KeyCode::Backspace => {
                        if ui.cursor > 0 {
                            let mut del_end = ui.cursor;
                            ui.cursor -= 1;
                            while ui.cursor > 0 && !ui.input.is_char_boundary(ui.cursor) {
                                ui.cursor -= 1;
                            }
                            ui.input.replace_range(ui.cursor..del_end, "");
                        }
                    }
                    KeyCode::Delete => {
                        if ui.cursor < ui.input.len() {
                            let mut del_end = ui.cursor;
                            del_end += 1;
                            while del_end < ui.input.len() && !ui.input.is_char_boundary(del_end) {
                                del_end += 1;
                            }
                            ui.input.replace_range(ui.cursor..del_end, "");
                        }
                    }
                    KeyCode::PageUp => ui.scroll_back = ui.scroll_back.saturating_add(15),
                    KeyCode::PageDown => ui.scroll_back = ui.scroll_back.saturating_sub(15),
                    KeyCode::End => {
                        // 先处理 Ctrl+End = 删到末尾
                        if key.modifiers.contains(KeyModifiers::CONTROL) {
                            ui.input.replace_range(ui.cursor.., "");
                        } else {
                            ui.scroll_back = 0;
                        }
                    }
                    KeyCode::Tab => ui.tab_complete(),
                    // ── Ctrl 组合 ──
                    KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => ui.cursor = 0,
                    KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => ui.cursor = ui.input.len(),
                    KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        ui.input.replace_range(..ui.cursor, "");
                        ui.cursor = 0;
                    }
                    KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        // 删前一个词
                        let mut end = ui.cursor;
                        while end > 0 && !ui.input.is_char_boundary(end) {
                            end -= 1;
                        }
                        let mut start = end;
                        while start > 0 {
                            let mut p = start - 1;
                            while p > 0 && !ui.input.is_char_boundary(p) {
                                p -= 1;
                            }
                            let c = ui.input[p..start].chars().next().unwrap();
                            if c.is_whitespace() {
                                break;
                            }
                            start = p;
                        }
                        ui.input.replace_range(start..end, "");
                        ui.cursor = start;
                    }
                    // ── 历史（上下箭头）──
                    KeyCode::Up => {
                        if ui.history.is_empty() {
                            continue;
                        }
                        let idx = match ui.history_idx {
                            None => ui.history.len() - 1,
                            Some(i) if i > 0 => i - 1,
                            _ => continue,
                        };
                        ui.history_idx = Some(idx);
                        ui.input = ui.history[idx].clone();
                        ui.cursor = ui.input.len();
                    }
                    KeyCode::Down => {
                        match ui.history_idx {
                            Some(i) => {
                                if i < ui.history.len() - 1 {
                                    let ni = i + 1;
                                    ui.history_idx = Some(ni);
                                    ui.input = ui.history[ni].clone();
                                    ui.cursor = ui.input.len();
                                } else {
                                    // 到底了，清空
                                    ui.history_idx = None;
                                    ui.input.clear();
                                    ui.cursor = 0;
                                }
                            }
                            None => {}
                        }
                    }
                    // ── F 键面板 ──
                    KeyCode::F(1) | KeyCode::F(5) => ui.panel = SidePanel::None,
                    KeyCode::F(2) => ui.panel = if ui.panel == SidePanel::Sessions { SidePanel::None } else { SidePanel::Sessions },
                    KeyCode::F(3) => ui.panel = if ui.panel == SidePanel::Tools { SidePanel::None } else { SidePanel::Tools },
                    KeyCode::F(4) => ui.panel = if ui.panel == SidePanel::Goals { SidePanel::None } else { SidePanel::Goals },
                    // ── 普通字符 ──
                    KeyCode::Char(c) => {
                        // Ctrl 组合里 a/e/u/w 已处理，剩余的 Ctrl+X 等忽略
                        if key.modifiers.contains(KeyModifiers::CONTROL) || key.modifiers.contains(KeyModifiers::ALT) {
                            continue;
                        }
                        // 多行输入：Shift+Enter（但 crossterm 对 Shift 处理不一致，这里只接受直接回车）
                        let mut end = ui.cursor;
                        end += c.len_utf8();
                        while end < ui.input.len() && !ui.input.is_char_boundary(end) {
                            end += 1;
                        }
                        ui.input.insert_str(ui.cursor, &c.to_string());
                        ui.cursor = end;
                        ui.history_idx = None;
                    }
                    _ => {}
                }
                ui.clamp_cursor();
                if want_quit {
                    return Ok(());
                }
                draw(term.terminal(), &ctx, &ui).ok();
            }
        }
    }
}

/// 跑一条命令/对话：输出行与结束通知分别走两个 channel
fn spawn_turn(
    ctx: Arc<Ctx>,
    line: String,
    out_tx: tokio::sync::mpsc::UnboundedSender<(MsgKind, String)>,
    done_tx: DoneTx,
) {
    crate::task::spawn(async move {
        let out = Out::Chan(out_tx);
        let res = handle(&ctx, &line, &out).await;
        let _ = done_tx.send(res);
    });
}

/// 键盘读取线程：event::read 阻塞直到有键，跨线程送出后继续
fn spawn_key_thread(tx: KeyTx) {
    std::thread::spawn(move || loop {
        match crossterm::event::read() {
            Ok(Event::Key(k)) => {
                if tx.send(k).is_err() {
                    break;
                }
            }
            Ok(_) => {} // 鼠标等事件暂时忽略
            Err(_) => break,
        }
    });
}

// ── 颜色映射 ──────────────────────────────────────────────────
fn kind_style(kind: MsgKind) -> Style {
    match kind {
        MsgKind::System => Style::default().fg(Color::White),
        MsgKind::User => Style::default().fg(Color::Cyan),
        MsgKind::Assistant => Style::default().fg(Color::Green),
        MsgKind::Tool => Style::default().fg(Color::Yellow),
        MsgKind::Error => Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        MsgKind::Divider => Style::default().fg(Color::DarkGray),
    }
}

/// 画整个 UI
fn draw(t: &mut Terminal<CrosstermBackend<Stdout>>, ctx: &Arc<Ctx>, ui: &App) -> io::Result<()> {
    // 在 terminal 外面获取 ctx 数据，避免 lock 跨越 draw closure
    let (status_info, panel_items) = gather_status(ctx, ui);
    let panel_title = match ui.panel {
        SidePanel::None => String::new(),
        SidePanel::Sessions => "会话 (F2 切换)".into(),
        SidePanel::Tools => "工具 (F3 切换)".into(),
        SidePanel::Goals => "目标/待办 (F4 切换)".into(),
    };
    let show_panel = ui.panel != SidePanel::None;

    t.draw(|f| {
        let area = f.area();

        // 根布局：行（状态栏 | [可选侧栏 + 消息区] | 输入框）
        let mut outer_chunks = if show_panel {
            Layout::vertical([
                Constraint::Length(1), // 状态栏
                Constraint::Min(3),    // 主体（侧栏+消息区）
                Constraint::Length(3), // 输入框
            ])
            .split(area)
        } else {
            Layout::vertical([
                Constraint::Length(1),
                Constraint::Min(5),
                Constraint::Length(3),
            ])
            .split(area)
        };

        // 状态栏
        draw_status_bar(f, outer_chunks[0], &status_info, ui);

        // 主体：侧栏 + 消息区
        if show_panel {
            let main_split = Layout::horizontal([
                Constraint::Length(30),  // 侧栏宽度
                Constraint::Percentage(100), // 消息区
            ])
            .split(outer_chunks[1]);
            draw_side_panel(f, main_split[0], &panel_title, &panel_items, ui);
            draw_message_area(f, main_split[1], ui);
        } else {
            draw_message_area(f, outer_chunks[1], ui);
        }

        // 输入框
        draw_input_box(f, outer_chunks[2], ui);
    })?;
    Ok(())
}

struct StatusInfo {
    title: String,
    session_id: String,
    msg_count: usize,
    approval: String,
    ws: String,
    model: String,
    busy: bool,
}

/// 收集状态栏 + 侧栏所需的所有数据
fn gather_status(ctx: &Arc<Ctx>, ui: &App) -> (StatusInfo, Vec<String>) {
    let (title, sid_prefix, msg_count) = {
        let store = ctx.sessions.lock().unwrap();
        let active = store.active.clone();
        let s = store.sessions.iter().find(|s| s.id == active).cloned();
        match s {
            Some(s) => (
                s.title.clone(),
                s.id[..s.id.len().min(8)].to_string(),
                s.messages.len(),
            ),
            None => (String::from("未命名"), String::from("--------"), 0),
        }
    };
    // TUI 模式下审批自动放行（没有 WebView 审批通道），状态栏显式标注
    let approval = if std::env::var("BIT_TUI").is_ok() {
        String::from("tui-自动")
    } else {
        ctx.config.lock().unwrap().tool_approval.clone()
    };
    let ws = crate::sandbox::effective_root(ctx)
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "-".into());
    let model = ctx
        .ai_config
        .lock()
        .unwrap()
        .active()
        .map(|p| p.model.clone())
        .unwrap_or_else(|| "未配置".into());

    let status = StatusInfo {
        title,
        session_id: sid_prefix,
        msg_count,
        approval,
        ws,
        model,
        busy: ui.busy,
    };

    // 侧栏数据
    let panel_items: Vec<String> = match ui.panel {
        SidePanel::None => Vec::new(),
        SidePanel::Sessions => {
            let store = ctx.sessions.lock().unwrap();
            store
                .sessions
                .iter()
                .map(|s| {
                    let mark = if s.id == store.active { "●" } else { " " };
                    format!("{} {} [{}] {}", mark, &s.id[..s.id.len().min(8)], s.messages.len(), s.title)
                })
                .rev()
                .collect()
        }
        SidePanel::Tools => {
            let tools = ctx.tools.lock().unwrap();
            tools
                .iter()
                .map(|t| {
                    let mark = if t.enabled { "✓" } else { "✗" };
                    format!("{} {} {}", mark, t.name, t.description)
                })
                .collect()
        }
        SidePanel::Goals => {
            let goals = ctx.goals.lock().unwrap();
            let todos = ctx.todos.lock().unwrap();
            let mut items: Vec<String> = Vec::new();
            for g in goals.iter().rev() {
                items.push(format!("G [{}] {} · {}", g.status, &g.id[..8.min(g.id.len())], g.title));
            }
            for t in todos.iter().rev() {
                let prefix = t.goal_id.as_ref().map(|gid| format!("  ({}) ", &gid[..8.min(gid.len())])).unwrap_or_default();
                items.push(format!("T [{}]{}{}", t.status, prefix, t.content));
            }
            items
        }
    };

    (status, panel_items)
}

fn draw_status_bar(f: &mut ratatui::Frame, area: ratatui::layout::Rect, s: &StatusInfo, ui: &App) {
    let chunks = Layout::horizontal([Constraint::Percentage(78), Constraint::Percentage(22)]).split(area);

    let left_text = format!(
        " BIT · {} · {} · 💬{} · 🤖{} · 🛡{} · 📁{} ",
        s.title, s.session_id, s.msg_count, s.model, s.approval, s.ws
    );
    let left = Line::from(Span::styled(
        left_text,
        Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD),
    ));

    let (bg_color, busy_label) = if s.busy {
        (Color::Yellow, " ● 思考中")
    } else {
        (Color::Green, " ○ 就绪")
    };
    let panel_label = match ui.panel {
        SidePanel::None => String::new(),
        SidePanel::Sessions => String::from(" · F2开"),
        SidePanel::Tools => String::from(" · F3开"),
        SidePanel::Goals => String::from(" · F4开"),
    };
    let right_text = format!("{}{} ", busy_label, panel_label);
    let right = Line::from(Span::styled(
        right_text,
        Style::default().fg(Color::Black).bg(bg_color).add_modifier(Modifier::BOLD),
    ));

    f.render_widget(Paragraph::new(left), chunks[0]);
    f.render_widget(Paragraph::new(right).right_aligned(), chunks[1]);
}

fn draw_side_panel(f: &mut ratatui::Frame, area: ratatui::layout::Rect, title: &str, items: &[String], ui: &App) {
    let items: Vec<ListItem> = items.iter().map(|s| ListItem::new(s.as_str())).collect();
    let list = List::new(items)
        .block(
            Block::default()
                .title(Span::styled(title, Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)))
                .borders(Borders::RIGHT)
                .border_style(Style::default().fg(Color::Cyan)),
        )
        .style(Style::default().fg(Color::White))
        .scroll_padding(2);

    // 侧栏内部也做一个小的滚动（scroll_back 除以 2 粗略映射）
    let panel_scroll = ui.scroll_back.saturating_mul(2) as u16;
    let list = list.highlight_style(Style::default().add_modifier(Modifier::BOLD));
    f.render_widget(list, area);
    let _ = panel_scroll; // 暂时不单独滚动侧栏
}

fn draw_message_area(f: &mut ratatui::Frame, area: ratatui::layout::Rect, ui: &App) {
    let rows: Vec<Line> = ui
        .lines
        .iter()
        .map(|(kind, text)| {
            let ts = now_hhmm();
            let tag = match kind {
                MsgKind::System => "",
                MsgKind::User => "你 ",
                MsgKind::Assistant => "AI ",
                MsgKind::Tool => "tool ",
                MsgKind::Error => "ERR ",
                MsgKind::Divider => "",
            };
            let styled_text = if *kind == MsgKind::Divider {
                Span::styled(format!("{}─── 回合 ───", text), kind_style(*kind))
            } else {
                Span::styled(format!("{ts} {tag}{text}"), kind_style(*kind))
            };
            Line::from(styled_text)
        })
        .collect();

    let body = Paragraph::new(rows)
        .wrap(Wrap { trim: false })
        .scroll((ui.scroll_back as u16, 0))
        .block(Block::default());
    f.render_widget(body, area);
}

fn draw_input_box(f: &mut ratatui::Frame, area: ratatui::layout::Rect, ui: &App) {
    let border_color = if ui.busy { Color::Yellow } else { Color::Cyan };

    // 构造光标位置的显示
    let cursor_pos = ui.cursor;
    let visible_line = if ui.input.is_empty() {
        String::new()
    } else {
        ui.input.clone()
    };

    // Ratatui 的 Paragraph 不支持原生光标，但我们在后面画一个覆盖层
    let input_block = Block::default()
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(border_color))
        .title(Span::styled(
            if ui.busy {
                " 输入（思考中，请稍候… Esc中断 · Ctrl+C退出） "
            } else {
                " 输入（Enter发送 · Tab补全 · ↑↓历史 · Ctrl+A/E/H/W/U · Esc侧栏 · Ctrl+C退出） "
            },
            Style::default().fg(Color::DarkGray),
        ));

    let area_inner = input_block.inner(area);
    f.render_widget(Paragraph::new(visible_line.as_str()), area_inner);
    f.render_widget(input_block, area);

    // 画光标（一个高亮方块）
    if !ui.busy {
        let inner = ratatui::layout::Rect {
            x: area.x + 1,
            y: area.y + 1,
            width: area.width.saturating_sub(2),
            height: area.height.saturating_sub(2),
        };
        let cursor_col = ui.input[..cursor_pos].chars().count() as u16;
        if cursor_col < inner.width {
            let cursor_rect = ratatui::layout::Rect {
                x: inner.x + cursor_col,
                y: inner.y,
                width: 1,
                height: 1,
            };
            let cursor_style = Style::default().bg(Color::Cyan).fg(Color::Black);
            f.render_widget(Paragraph::new(" ").style(cursor_style), cursor_rect);
        }
    }
}

fn now_hhmm() -> String {
    let t = chrono::Local::now();
    format!("{}", t.format("%H:%M"))
}
