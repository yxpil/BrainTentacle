// yxpil · BIT
// 后台 shell（长命令异步化）：
//   - shell 工具调用若在「前台窗口」内未结束，自动转入后台作业（job）；
//   - 转后台立即返回 { status:"background", job_id }，AI 回合不再干等；
//   - 命令生命周期全程广播 `shell-job` 事件（started / done / killed），供 UI 面板展示；
//   - 命令自然结束时，若所属会话空闲，把结果作为新消息自动唤回该会话的 AI 继续处理；
//     会话忙则先把结果注入会话历史，等下一次上下文自然读到。
//   - 提供 cancel / list / find_running：用户可手动停止，重复命令会被拦截。
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::Notify;

/// 前台判定窗口：命令在窗口内结束走原有「快命令」路径；否则转后台。
const FRONT_WINDOW_MS: u128 = 2000;
/// wait=true 强制同步模式的硬上限（秒）：AI 显式要等完再继续，但如果命令跑超过这个值，
/// 为了不让 agent 回合永久挂死，自动回退到后台模式并在 note 里告知 AI 转换发生了。
const WAIT_TIMEOUT_SECS: u64 = 600;
/// 后台命令硬上限（小时）：防止程序失控后作业永久挂起泄漏。正常作业由用户/结果终止。
const BG_TIMEOUT_SECS: u64 = 6 * 3600;

use crate::console_codec::decode_console;

/// 一条自然结束的后台命令：交给顶层续跑 worker，把结果唤回所属会话的 AI。
/// 之所以走 channel 而不是在 run/finish 链里直接 await agent 回合：
/// agent 回合最终又会经过 builtin_invoke 的 shell 分支（spawn(run)），若在 run 链内 await 会形成
/// 类型级的无限递归（E0391: opaque future not Send）。顶层 worker 是进程启动时单独 spawn 的，
/// 与 run 链无类型依赖，彻底断开递归。
pub struct JobDone {
    pub session: String,
    pub job_id: String,
    pub command: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// 结束方式：done=自然结束 / cancelled=用户手动停止 / timeout=运行超时被强制终止。
    /// 三种结束都要告知所属会话的 AI——尤其 cancelled 必须让 AI 知道「是用户主动干预」，
    /// 而不是误以为任务失败或仍在运行。
    pub reason: String,
}

static DONE_TX: OnceLock<tokio::sync::mpsc::UnboundedSender<JobDone>> = OnceLock::new();

pub struct ShellJob {
    pub id: String,
    /// 发起命令的会话 id：完成后要唤回这个会话
    pub session: Option<String>,
    pub command: String,
    pub cwd: Option<String>,
    pub started: std::time::Instant,
    /// cancel() 时 notify 一次，后台等待任务随即 kill 进程
    pub cancel: Arc<Notify>,
    /// 后台进程句柄（仅 finish 任务取走）
    pub child: Mutex<Option<Child>>,
    /// 实时输出缓冲：边读管道边 append，给前端 detail() 和增量事件用；
    /// 上限 MAX_LOG_LINES 防止大输出泄漏；按行存储，每行带 stream 标记（stdout/stderr）。
    /// Arc 包装 Mutex 是因为 finish() 的 stdout/stderr 两个并发读取任务要共享同一份缓冲。
    pub logs: Arc<Mutex<Vec<LogLine>>>,
}

/// 一条 shell 输出行
#[derive(Clone, Debug, serde::Serialize)]
pub struct LogLine {
    pub stream: String,   // "out" / "err"
    pub text: String,
    pub ts_ms: u64,       // 相对 job 启动的 ms
}

/// 每个后台 job 最多留存这么多行——前端实时 tail 超过这个量就只看尾部
const MAX_LOG_LINES: usize = 2000;

fn jobs() -> &'static Mutex<HashMap<String, Arc<ShellJob>>> {
    static J: OnceLock<Mutex<HashMap<String, Arc<ShellJob>>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("sh{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// 构造 shell 命令：按 config.default_shell 解析（空 = 自动识别，指定不存在时回退自动）。
/// PowerShell 系沿用强制 UTF-8（与旧实现一致），Unix 用解析出的 -c 系 shell。
fn shell_command(pref: &str, command: &str, cwd: Option<&str>) -> tokio::process::Command {
    let (prog, args) = match crate::toolenv::resolve_shell(pref) {
        Ok(v) => v,
        Err(_) => crate::toolenv::resolve_shell("")
            .unwrap_or_else(|_| ("powershell".to_string(), vec!["-Command".to_string()])),
    };
    let is_ps = prog
        .rsplit(['/', '\\'])
        .next()
        .map(|b| b == "pwsh" || b == "powershell")
        .unwrap_or(false);
    // PowerShell 强制 UTF-8 输出，避免中文乱码
    let full = if is_ps {
        format!("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {command}")
    } else {
        command.to_string()
    };
    let mut c = tokio::process::Command::new(prog);
    c.args(args);
    c.arg(full);
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    crate::registry::no_window_tokio(&mut c);
    c
}

/// 解析出的默认 shell 是否为 PowerShell 系（裸 `&` 语义判断需要）
fn shell_is_ps(pref: &str) -> bool {
    let (prog, _) = match crate::toolenv::resolve_shell(pref) {
        Ok(v) => v,
        Err(_) => return true, // 两次解析都失败时的兜底就是 powershell
    };
    prog.rsplit(['/', '\\'])
        .next()
        .map(|b| b == "pwsh" || b == "powershell")
        .unwrap_or(false)
}

/// PowerShell 裸 `&` 检测（引号感知）。`a & b` 在 PS 里是后台 Job 操作符：
/// 前序命令输出进 Job 表丢失、退出码恒 0（假成功）。合法用法需排除：
/// `&&`（逻辑与）、`2>&1` / `&>`（重定向）、语句开头的调用操作符（`& script.ps1`）。
/// 判定：引号外的 `&`，所在语句段已有内容，且其后是空白/串尾 → Job 操作符。
fn ps_bare_ampersand(cmd: &str) -> bool {
    let mut quote: Option<char> = None;
    let mut seg_has_content = false; // 自 ; | ( { 或串首以来是否已出现非空白
    let chars: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
        } else {
            match c {
                '\'' | '"' => quote = Some(c),
                ';' | '|' | '(' | '{' | '\n' => seg_has_content = false,
                '&' => {
                    let prev = if i > 0 { chars[i - 1] } else { '\0' };
                    let next = chars.get(i + 1).copied().unwrap_or('\0');
                    let is_chain = prev == '&' || next == '&';
                    let is_redirect = prev == '>' || next == '>';
                    if !is_chain && !is_redirect && seg_has_content {
                        return true;
                    }
                    if next == '&' {
                        i += 1; // && 的第二个 & 无需复判
                    }
                }
                c if c.is_whitespace() => {}
                _ => seg_has_content = true,
            }
        }
        i += 1;
    }
    false
}

/// PowerShell 中不存在、模型最常误用的 Unix 命令 → PowerShell 替代写法。
/// 注意 cat/ls/rm/cp/mv/echo/pwd 在 PS 有内置别名（行为略异但不报错），故不列入。
const PS_MISSING_UNIX_CMDS: &[(&str, &str)] = &[
    ("head", "Select-Object -First N"),
    ("tail", "Select-Object -Last N"),
    ("grep", "Select-String"),
    ("sed", "文本替换用 -replace 运算符"),
    ("awk", "常用 ForEach-Object / Select-Object / Measure-Object"),
    ("wc", "Measure-Object -Line/-Character/-Word"),
    ("cut", "ForEach-Object 取子串或 -split"),
    ("xargs", "ForEach-Object { ... }"),
    ("which", "Get-Command"),
    ("touch", "New-Item"),
    ("du", "Get-ChildItem | Measure-Object"),
    ("df", "Get-PSDrive"),
    ("uname", "系统信息用 $PSVersionTable"),
    ("env", "Get-ChildItem Env:"),
    ("export", "$env:NAME = value"),
];

/// 命中判定：词处于「命令位」（尚无任何词元，或引号外前一有意义字符是 | ; & ( ）才算，
/// 避免 `Select-String head`、`C:\head\x` 之类误报。
fn check_unix_word(
    word: &str,
    prev_is_word: bool,
    last: Option<char>,
    hits: &mut Vec<&'static str>,
) {
    if word.is_empty() || prev_is_word {
        return;
    }
    let at_cmd_pos = match last {
        None => true,
        Some(ch) => matches!(ch, '|' | ';' | '&' | '('),
    };
    if !at_cmd_pos {
        return;
    }
    if let Some((name, _)) = PS_MISSING_UNIX_CMDS.iter().find(|(k, _)| *k == word) {
        if !hits.contains(name) {
            hits.push(name);
        }
    }
}

/// 引号感知的 Unix 命令扫描：路径段（含 / \ . 连接）合并成一个词不拆分，
/// 引号内内容跳过，管道 / 分号 / && / ( 之后的词才参与匹配。
fn ps_unix_cmd_hits(cmd: &str) -> Vec<&'static str> {
    let mut hits: Vec<&'static str> = Vec::new();
    let mut quote: Option<char> = None;
    let mut last_meaningful: Option<char> = None;
    let mut prev_is_word = false; // 上一个词元是单词或引号串 → 当前词是参数位
    let mut word = String::new();
    for ch in cmd.chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
                prev_is_word = true; // 引号串整体视作一个词（参数位）
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                check_unix_word(&word, prev_is_word, last_meaningful, &mut hits);
                if !word.is_empty() {
                    prev_is_word = true; // 刚 flush 的词成为「上一个词元」
                    word.clear();
                }
                quote = Some(ch);
            }
            c if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '\\') => word.push(c),
            other => {
                check_unix_word(&word, prev_is_word, last_meaningful, &mut hits);
                if !word.is_empty() {
                    prev_is_word = true; // 刚 flush 的词成为「上一个词元」
                    word.clear();
                }
                if !other.is_whitespace() {
                    prev_is_word = false; // 操作符取代词元成为「上一个」
                    last_meaningful = Some(other);
                }
            }
        }
    }
    check_unix_word(&word, prev_is_word, last_meaningful, &mut hits);
    hits
}

/// PowerShell 语义前置警告合集：裸 `&`（假成功）+ 不存在的 Unix 命令（CommandNotFound）。
/// 随执行结果一并返回给模型，当轮自纠，不再等到报错后盲试。
pub(crate) fn ps_semantic_warning(command: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if ps_bare_ampersand(command) {
        parts.push("PowerShell 语义警告：命令含裸 `&`（后台 Job 操作符），前序命令的输出会丢失且退出码恒为 0。多条命令请用 `;` 串联；需要 cmd 的 `&` 语义请用 cmd /c \"...\" 包裹。".to_string());
    }
    let hits = ps_unix_cmd_hits(command);
    if !hits.is_empty() {
        let list = hits.iter().map(|h| format!("`{h}`")).collect::<Vec<_>>().join("、");
        let repls = hits
            .iter()
            .filter_map(|h| {
                PS_MISSING_UNIX_CMDS
                    .iter()
                    .find(|(k, _)| k == h)
                    .map(|(_, r)| format!("`{h}` → {r}"))
            })
            .collect::<Vec<_>>()
            .join("；");
        parts.push(format!(
            "PowerShell 语义警告：以下 Unix 命令在 PowerShell 中不存在（会报 CommandNotFound）：{list}。替代写法：{repls}。"
        ));
    }
    if parts.is_empty() { None } else { Some(parts.join("\n")) }
}

fn emit(ctx: &Arc<crate::state::Ctx>, phase: &str, job: &ShellJob, extra: Option<serde_json::Value>) {
    use tauri::Emitter;
    let mut payload = json!({
        "phase": phase,
        "job_id": job.id,
        "command": job.command,
        "cwd": job.cwd,
        "session_id": job.session,
        "at": chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    });
    if let (Some(obj), Some(ext)) =
        (payload.as_object_mut(), extra.as_ref().and_then(|v| v.as_object()))
    {
        for (k, v) in ext {
            obj.insert(k.clone(), v.clone());
        }
    }
    let _ = crate::worker::emit_ui(&ctx.app, "shell-job", payload);
}

/// shell 工具入口：短命令照旧秒回；超过前台窗口的命令转后台（含登记 + 事件 + 自动唤回）。
/// force_background=true（AI 显式标记长任务）时跳过前台窗口，spawn 后直接转后台。
/// wait=true 时强制同步等完（跳过前台窗口，不转后台），供 AI 显式表达「命令产物要喂给下一步」。
/// wait=true 与 force_background=true 互斥，wait 优先。
pub async fn run(
    ctx: &Arc<crate::state::Ctx>,
    command: &str,
    cwd: Option<&str>,
    session: Option<&str>,
    force_background: bool,
    wait: bool,
) -> Result<serde_json::Value, String> {
    // 重复命令拦截：同一会话同一命令正在后台跑时，不重复执行，提示等待或停止
    if let Some(jid) = find_running(session, command) {
        return Err(format!(
            "命令已在后台运行（job {jid}）：`{}`。请等它结束，或发送「停止 {jid}」取消它，不要重复执行同一命令。",
            crate::registry::safe_trunc(command, 120)
        ));
    }
    // 快照默认 shell 后立即释放配置锁（锁序纪律：不跨 spawn 持锁）
    let pref = { ctx.config.lock().unwrap().default_shell.clone() };
    // PS 语义前置检测：裸 `&`（静默丢输出 + 假成功）与不存在的 Unix 命令（head/grep 等）
    let amp_warning = if shell_is_ps(&pref) { ps_semantic_warning(command) } else { None };
    let mut cmd = shell_command(&pref, command, cwd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn command: {e}"))?;

    // ── wait=true 强制同步路径 ──────────────────────────────────────
    // AI 显式说「等完再继续」：跳过前台窗口，直接等 child.wait_with_output()，
    // 但加 WAIT_TIMEOUT_SECS 硬上限防 AI 把 dev server / watch 这种长驻命令也标 wait。
    // 超时后转后台并在 note 里明确告知 AI 它的 wait 被降级了。
    if wait {
        // 先 take stdout/stderr，避免 select! 里两个 arm 对 child 的所有权争夺
        // 命令刚 spawn 完 pipe 一定是 Some，直接 unwrap
        let mut so = child.stdout.take().unwrap();
        let mut se = child.stderr.take().unwrap();

        let timeout_sleep = tokio::time::sleep(std::time::Duration::from_secs(WAIT_TIMEOUT_SECS));
        tokio::pin!(timeout_sleep);
        let mut timed_out = false;
        let out: std::process::Output = tokio::select! {
            status = child.wait() => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut so, &mut stdout).await;
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut se, &mut stderr).await;
                std::process::Output {
                    status: status.map_err(|e| format!("Failed to wait command: {e}"))?,
                    stdout, stderr,
                }
            }
            _ = &mut timeout_sleep => {
                timed_out = true;
                tree_kill(&mut child);
                // 杀掉后等进程退出（最多 5s），再读管道
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut so, &mut stdout).await;
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut se, &mut stderr).await;
                std::process::Output {
                    status: child.try_wait().ok().flatten().unwrap_or_default(),
                    stdout, stderr,
                }
            }
        };
        let mut result = json!({
            "code": out.status.code(),
            "stdout": crate::registry::safe_trunc(&decode_console(&out.stdout), 60000),
            "stderr": crate::registry::safe_trunc(&decode_console(&out.stderr), 60000),
        });
        if timed_out {
            // wait 超时降级为后台：job 刚被 kill，AI 收到的是 killed 状态而不是 done；
            // 把状态标注出来让 AI 知道这次 wait 被强制终止、不是正常完成。
            if let Some(obj) = result.as_object_mut() {
                obj.insert("status".into(), json!("wait_killed"));
                obj.insert(
                    "note".into(),
                    json!(format!(
                        "wait=true but command exceeded {}s and was killed. If this is a long-running task (dev server, watch loop, data pipeline), run again with `background: true` instead.",
                        WAIT_TIMEOUT_SECS
                    )),
                );
            }
        }
        if let (Some(obj), Some(w)) = (result.as_object_mut(), amp_warning) {
            obj.insert("warning".into(), json!(w));
        }
        return Ok(result);
    }

    // 前台判定：显式标记后台 → 跳过窗口直接转后台；否则窗口内轮询是否已退出
    let mut exited: Option<std::process::ExitStatus> = None;
    if !force_background {
        let t0 = std::time::Instant::now();
        loop {
            if t0.elapsed().as_millis() >= FRONT_WINDOW_MS {
                break;
            }
            match child.try_wait() {
                Ok(Some(st)) => {
                    exited = Some(st);
                    break;
                }
                Ok(None) => {}
                Err(e) => return Err(format!("Failed to wait for command: {e}")),
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
    }

    // 快命令：与旧行为一致——收集输出后直接返回
    if exited.is_some() {
        let out = child
            .wait_with_output()
            .await
            .map_err(|e| format!("Failed to collect command output: {e}"))?;
        let mut result = json!({
            "code": out.status.code(),
            "stdout": crate::registry::safe_trunc(&decode_console(&out.stdout), 60000),
            "stderr": crate::registry::safe_trunc(&decode_console(&out.stderr), 60000),
        });
        if let (Some(obj), Some(w)) = (result.as_object_mut(), amp_warning) {
            obj.insert("warning".into(), json!(w));
        }
        return Ok(result);
    }

    // 长命令：转后台
    let job = Arc::new(ShellJob {
        id: next_id(),
        session: session.map(|s| s.to_string()),
        command: command.to_string(),
        cwd: cwd.map(|s| s.to_string()),
        started: std::time::Instant::now(),
        cancel: Arc::new(Notify::new()),
        child: Mutex::new(Some(child)),
        logs: Arc::new(Mutex::new(Vec::new())),
    });
    jobs().lock().unwrap().insert(job.id.clone(), job.clone());
    emit(ctx, "started", &job, None);
    crate::audit::record(
        ctx,
        "host",
        "shell.background",
        &job.id,
        json!({ "command": job.command, "session": job.session }),
        true,
    );
    let c2 = ctx.clone();
    let j2 = job.clone();
    tauri::async_runtime::spawn(async move {
        finish(c2, j2).await;
    });
    let mut bg_result = json!({
        "status": "background",
        "job_id": job.id,
        "note": if force_background {
            format!(
                "Started in background as job {}. The chat continues; the result will be delivered to this session when the command finishes — do not run this command again.",
                job.id
            )
        } else {
            format!(
                "Command was still running after {}ms; it has been moved to background job {}. The result will be delivered to the session when it finishes — do not run this command again.",
                FRONT_WINDOW_MS, job.id
            )
        },
    });
    if let (Some(obj), Some(w)) = (bg_result.as_object_mut(), amp_warning) {
        obj.insert("warning".into(), json!(w));
    }
    Ok(bg_result)
}

#[cfg(test)]
mod amp_tests {
    use super::{ps_bare_ampersand, ps_semantic_warning, ps_unix_cmd_hits};

    #[test]
    fn bare_ampersand_detected() {
        // 典型踩坑写法：裸 & 分隔多条命令
        assert!(ps_bare_ampersand("echo one & echo two"));
        assert!(ps_bare_ampersand("echo one &echo two"));
        assert!(ps_bare_ampersand("echo one &"));
        assert!(ps_bare_ampersand("echo one&echo two"));
    }

    #[test]
    fn legitimate_ampersand_not_flagged() {
        // 逻辑与
        assert!(!ps_bare_ampersand("cmd /c \"exit 0\" && echo ok"));
        assert!(!ps_bare_ampersand("exit 1 || echo fallback"));
        // 重定向
        assert!(!ps_bare_ampersand("node app.js 2>&1"));
        assert!(!ps_bare_ampersand("foo &> log.txt"));
        // 调用操作符（语句开头）
        assert!(!ps_bare_ampersand("& \"C:\\my script.ps1\""));
        assert!(!ps_bare_ampersand("echo a; & \"x.ps1\""));
        // 引号内的 &（cmd /c 包裹、字符串字面量）
        assert!(!ps_bare_ampersand("cmd /c \"echo one & echo two\""));
        assert!(!ps_bare_ampersand("echo \"a & b\""));
        assert!(!ps_bare_ampersand("echo 'a & b'"));
        // 无 & 的普通命令
        assert!(!ps_bare_ampersand("echo hello"));
    }

    #[test]
    fn unix_cmd_hits_at_command_position() {
        // 典型踩坑：管道后接 Unix 命令（PowerShell 无 head，报 CommandNotFound）
        assert_eq!(ps_unix_cmd_hits("git log | head -5"), vec!["head"]);
        assert_eq!(ps_unix_cmd_hits("cat a.txt | tail -n 3"), vec!["tail"]);
        assert_eq!(ps_unix_cmd_hits("ps aux | grep node"), vec!["grep"]);
        // 命令串首
        assert_eq!(ps_unix_cmd_hits("head -5 README.md"), vec!["head"]);
        // && / ; / ( 之后也是命令位
        assert_eq!(ps_unix_cmd_hits("cd x && which node"), vec!["which"]);
        assert_eq!(ps_unix_cmd_hits("echo a; wc -l b"), vec!["wc"]);
        assert_eq!(ps_unix_cmd_hits("(head x)"), vec!["head"]);
        // 多个命中去重、保持出现顺序
        assert_eq!(ps_unix_cmd_hits("grep a b | head -3"), vec!["grep", "head"]);
    }

    #[test]
    fn unix_cmd_no_false_positives() {
        // 非命令位的出现不算：参数、路径、引号内
        assert!(ps_unix_cmd_hits("Select-String head file.txt").is_empty());
        assert!(ps_unix_cmd_hits("Get-Content -Tail 5 a.log").is_empty());
        assert!(ps_unix_cmd_hits("type C:\\head\\x.txt").is_empty());
        assert!(ps_unix_cmd_hits("echo \"head | grep | tail\"").is_empty());
        assert!(ps_unix_cmd_hits("echo 'grep'").is_empty());
        assert!(ps_unix_cmd_hits("foo-head --grep x").is_empty());
        // PS 自带别名的 cat/ls/rm 不在名单内
        assert!(ps_unix_cmd_hits("cat a.txt | ls").is_empty());
        // 完全无关的命令
        assert!(ps_unix_cmd_hits("git status").is_empty());
    }

    #[test]
    fn ps_semantic_warning_combines_both() {
        // 只有 Unix 命令
        let w = ps_semantic_warning("git log | head -5").unwrap();
        assert!(w.contains("`head`") && w.contains("Select-Object -First N"));
        // 只有裸 &
        let w2 = ps_semantic_warning("echo one & echo two").unwrap();
        assert!(w2.contains("后台 Job 操作符"));
        assert!(!w2.contains("Unix 命令"));
        // 两者都有：两条警告合并
        let w3 = ps_semantic_warning("echo a & echo b | grep c").unwrap();
        assert!(w3.contains("后台 Job 操作符") && w3.contains("`grep`"));
        // 正常命令无警告
        assert!(ps_semantic_warning("git status; Get-Content a.log").is_none());
    }
}

/// 进程树终止：shell 壳（pwsh/cmd）被杀后，它启动的孙进程会变成孤儿继续运行，
/// 既占资源又握着 stdout 管道写端，卡住收尾任务。start_kill 只杀直接子进程，
/// 这里 Windows 用 taskkill /T（整棵树）/F（强制），其他平台逐个杀子进程树尽力而为。
fn tree_kill(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("pkill")
                .args(["-TERM", "-P", &pid.to_string()])
                .output();
        }
    }
    let _ = child.start_kill(); // 兜底：直接子进程必杀
}

/// 后台作业收尾：等待进程结束（或用户取消/硬超时）→ 广播 done/killed → 移除登记 → 自然结束时唤回 AI
async fn finish(ctx: Arc<crate::state::Ctx>, job: Arc<ShellJob>) {
    let child = { job.child.lock().unwrap().take() };
    let Some(mut child) = child else {
        jobs().lock().unwrap().remove(&job.id);
        return;
    };

    // 实时读：边读管道边存进 job.logs，同时每 500ms / 每 20 行增量广播 shell-job-log
    let so_pipe = child.stdout.take();
    let se_pipe = child.stderr.take();
    let jid = job.id.clone();
    let jstart = job.started;

    // 独立 spawn 两个读任务（不用闭包——Rust 闭包单态化不能同时接受 ChildStdout / ChildStderr）
    // 命令刚 spawn 完 pipe 一定是 Some，直接 unwrap
    let so_task = tauri::async_runtime::spawn(read_pipe(
        so_pipe.unwrap(), "out", ctx.clone(), jid.clone(), jstart, job.logs.clone(),
    ));
    let se_task = tauri::async_runtime::spawn(read_pipe(
        se_pipe.unwrap(), "err", ctx.clone(), jid.clone(), jstart, job.logs.clone(),
    ));

    let timeout_sleep = tokio::time::sleep(std::time::Duration::from_secs(BG_TIMEOUT_SECS));
    tokio::pin!(timeout_sleep);
    // 结束方式：done=自然结束 / cancelled=用户手动停止 / timeout=运行超时强制终止
    let mut reason = "done".to_string();
    let status: Option<std::process::ExitStatus> = tokio::select! {
        st = child.wait() => st.ok(),
        _ = job.cancel.notified() => {
            reason = "cancelled".into();
            tree_kill(&mut child);
            let _ = child.wait().await;
            None
        }
        _ = &mut timeout_sleep => {
            reason = "timeout".into();
            tree_kill(&mut child);
            let _ = child.wait().await;
            None
        }
    };
    // 停止后读取剩余输出，但最多等 5s：管道写端可能被 shell 的孙进程继承持有
    // （shell 壳被杀后孙进程变孤儿继续握着 stdout），无限等会让 killed 事件
    // 和审计遥遥无期，UI 卡片"停了但一直显示运行中"。超时放弃读取即可，
    // cancelled/timeout 的输出本就不需要完整回收。
    let (stdout, stderr) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        async { (so_task.await.unwrap_or_default(), se_task.await.unwrap_or_default()) },
    )
    .await
    .unwrap_or_default();
    // so_task/se_task 已经是 String（read_stream 内部 BufReader 累积），不再需要 from_utf8_lossy
    jobs().lock().unwrap().remove(&job.id);
    let ms = job.started.elapsed().as_millis() as u64;
    let code = status.and_then(|st| st.code());

    if reason == "done" {
        emit(&ctx, "done", &job, Some(json!({ "code": code, "ms": ms })));
        crate::audit::record(
            &ctx,
            "host",
            "shell.done",
            &job.id,
            json!({ "command": job.command, "code": code }),
            true,
        );
    } else {
        emit(&ctx, "killed", &job, Some(json!({ "ms": ms, "reason": reason.as_str() })));
        crate::audit::record(
            &ctx,
            "host",
            if reason == "cancelled" { "shell.cancelled" } else { "shell.timeout" },
            &job.id,
            json!({ "command": job.command }),
            true,
        );
    }

    // 无论自然结束、被用户手动停止还是超时终止，都把「结束方式」投递给顶层续跑 worker，
    // 由 resume 按 reason 生成说明唤回所属会话的 AI：
    //   自然结束 → 带结果继续推进任务；cancelled → 明确告知「用户手动停止」，避免 AI 误以为
    //   任务失败或仍在运行而干等 / 重复执行同一命令；timeout → 告知超时被终止、需与用户确认再走。
    if let Some(tx) = DONE_TX.get() {
        if let Some(sid) = job.session.clone() {
            let _ = tx.send(JobDone {
                session: sid,
                job_id: job.id.clone(),
                command: job.command.clone(),
                code,
                stdout,
                stderr,
                reason,
            });
        }
    }
}

/// 插件定时任务等外部产物的会话注入入口：把结果打包成 JobDone 交给顶层续跑 worker。
/// 会话空闲则自动开新回合处理，忙则注入历史等下轮上下文读到（与后台 shell 同链路）。
pub fn notify_session_result(
    session: &str,
    job_id: &str,
    command: &str,
    code: i32,
    stdout: String,
    stderr: String,
    reason: &str,
) {
    if let Some(tx) = DONE_TX.get() {
        let _ = tx.send(JobDone {
            session: session.to_string(),
            job_id: job_id.to_string(),
            command: command.to_string(),
            code: Some(code),
            stdout,
            stderr,
            reason: reason.to_string(),
        });
    }
}

/// 后台命令结束 → 唤回所属会话的 AI：
/// 会话空闲则自动开一个新回合处理结果；会话忙则先把结果注入历史，等下一次上下文自然读到。
async fn resume(ctx: &Arc<crate::state::Ctx>, msg: &JobDone) {
    use tauri::Emitter;
    let sid = &msg.session;
    if crate::agent::interrupted(ctx, sid) {
        return; // 会话已被中断，不自动续跑
    }
    {
        let store = ctx.sessions.lock().unwrap();
        if !store.sessions.iter().any(|s| &s.id == sid) {
            return; // 会话已删除
        }
    }
    let cmd = crate::registry::safe_trunc(&msg.command, 120);
    let code_txt = msg
        .code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "?".to_string());
    // 结束方式决定正文口径。cancelled 必须明确「用户手动停止」，避免 AI 误判为命令失败
    // 或以为任务仍在跑（干等 / 重复执行同一条命令）；timeout 同理给出处置指引。
    let (title, cap_out, cap_err, guide) = match msg.reason.as_str() {
        "cancelled" => (
            "[后台任务已手动停止]",
            4000,
            2000,
            "命令被用户手动停止（用户在面板点了「停止」或发送了停止指令），任务未完成——这是用户主动干预，不是命令本身出错。不要继续等待它的结果，也不要自动重新执行同一条命令；若任务仍需推进，先询问用户希望如何调整或是否重新运行。",
        ),
        "timeout" => (
            "[后台任务超时终止]",
            4000,
            2000,
            "命令运行超过后台上限（6 小时）被强制终止，任务未完成。不要原样自动重跑同一条命令；先与用户确认是否需要分拆步骤或改用更稳妥的方式执行。",
        ),
        _ => (
            "[后台任务完成]",
            16000,
            6000,
            "请基于上面的结果继续推进任务；若任务已全部完成，直接给出结论即可，不要重复执行该命令。",
        ),
    };
    let so = crate::registry::safe_trunc(msg.stdout.trim_end(), cap_out);
    let se = crate::registry::safe_trunc(msg.stderr.trim_end(), cap_err);
    let body = format!(
        "{title} 命令 `{cmd}`（job {}）已结束，退出码 {code_txt}。{guide}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        msg.job_id,
        if so.is_empty() { "(空)".to_string() } else { so },
        if se.is_empty() { "(空)".to_string() } else { se },
    );

    // 会话忙（用户正在发的回合 / 其他回合在跑）：只注入历史，不强开回合抢锁
    let busy = ctx.turn_locks.lock().unwrap().contains_key(sid);
    if busy {
        push_system_user(ctx, sid, &body);
        return;
    }
    // 会话空闲：稍作让渡避免与刚结束的回合抢锁，随后自动唤回 AI 处理
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    if ctx.turn_locks.lock().unwrap().contains_key(sid) {
        push_system_user(ctx, sid, &body);
        return;
    }
    let _ = crate::engine::chat_auto(ctx, sid, &body, Vec::new()).await;
    let _ = crate::worker::emit_ui(&ctx.app, "sessions-updated", json!(sid));
}

/// 启动后台 shell 的顶层续跑 worker（进程 setup 时调用一次）：
/// 常驻消费 JobDone，把命令结果逐个唤回所属会话的 AI。
pub fn init(ctx: &Arc<crate::state::Ctx>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<JobDone>();
    let _ = DONE_TX.set(tx);
    let c = ctx.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            resume(&c, &msg).await;
        }
    });
}

/// 把后台任务结果作为一条 role=user 的系统说明消息注入会话历史（前端会特殊渲染 [后台任务] 前缀）
fn push_system_user(ctx: &Arc<crate::state::Ctx>, sid: &str, body: &str) {
    use tauri::Emitter;
    {
        let mut store = ctx.sessions.lock().unwrap();
        if let Some(sess) = store.get_mut(sid) {
            sess.messages.push(crate::ai::ChatMessage::user(body));
            sess.touch();
            if sess.messages.len() > crate::state::CHAT_MAX {
                let drop_n = sess.messages.len() - crate::state::CHAT_MAX;
                sess.messages.drain(0..drop_n);
            }
        }
    }
    crate::session::persist(ctx);
    let _ = crate::worker::emit_ui(&ctx.app, "sessions-updated", json!(sid));
}

/// read_pipe: 单个 pipe（stdout/stderr）的读取循环——BufReader + read_until 按行切字节，
/// 每行经 decode_console 解码（GBK/UTF-16 兜底）后 push 进全局 logs buffer
/// （MAX_LOG_LINES 截断），同时节流广播 shell-job-log 事件（500ms 或 20 行）。
/// 接受 ChildStdout / ChildStderr 通用类型（它们都 AsyncRead + Unpin）。
async fn read_pipe<P>(
    pipe: P,
    stream_tag: &'static str,
    ctx: Arc<crate::state::Ctx>,
    job_id: String,
    started_at: std::time::Instant,
    logs: Arc<std::sync::Mutex<Vec<LogLine>>>,
) -> String
where
    P: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncBufReadExt;
    let mut reader = tokio::io::BufReader::new(pipe);
    let mut full = String::new();
    let mut pending: Vec<LogLine> = Vec::new();
    let mut last_flush = std::time::Instant::now();

    loop {
        // 按 \n 切字节再解码，而不是 read_line(String)：GBK 输出不是合法 UTF-8，
        // read_line 会报 InvalidData 直接断流。GBK 双字节序列不含 0x0A
        // （首字节 0x81-0xFE，次字节 0x40-0xFE 除 0x7F），按行切分不会切碎多字节字符。
        let mut buf: Vec<u8> = Vec::new();
        let n = match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,  // EOF —— 进程结束
            Ok(n) => n,
            Err(_) => break,
        };
        let line = decode_console(&buf);
        let _ = n;
        full.push_str(&line);
        let ts_ms = started_at.elapsed().as_millis() as u64;
        let ll = LogLine {
            stream: stream_tag.to_string(),
            text: line.trim_end().to_string(),
            ts_ms,
        };
        // 全局日志缓冲
        {
            let mut v = logs.lock().unwrap();
            v.push(ll.clone());
            if v.len() > MAX_LOG_LINES {
                let drop = v.len() - MAX_LOG_LINES;
                v.drain(0..drop);
            }
        }
        pending.push(ll);
        let _ = n;
        // 节流广播
        let now = std::time::Instant::now();
        if now.duration_since(last_flush).as_millis() >= 500 || pending.len() >= 20 {
            flush_log_batch(&ctx, &job_id, &mut pending);
            last_flush = now;
        }
    }
    // 管道关闭后 flush 剩余
    flush_log_batch(&ctx, &job_id, &mut pending);
    full
}

/// 把 pending 的 LogLine 批量 drain 掉，组 JSON payload 并通过 tauri emit 广播
fn flush_log_batch(ctx: &Arc<crate::state::Ctx>, job_id: &str, pending: &mut Vec<LogLine>) {
    if pending.is_empty() {
        return;
    }
    let batch: Vec<LogLine> = pending.drain(..).collect();
    let payload = serde_json::json!({
        "job_id": job_id,
        "added": batch.len(),
        "lines": batch,
    });
    let _ = crate::worker::emit_ui(&ctx.app, "shell-job-log", payload);
}

/// 用户 / UI 停止一个后台命令：通知其等待任务 kill 进程，事件 killed 会在片刻后广播
pub fn cancel(id: &str) -> bool {
    let job = jobs().lock().unwrap().get(id).cloned();
    match job {
        Some(j) => {
            j.cancel.notify_one();
            true
        }
        None => false,
    }
}

/// 所有在跑的后台命令（面板初始拉取用）
pub fn list() -> serde_json::Value {
    let m = jobs().lock().unwrap();
    let arr: Vec<serde_json::Value> = m
        .iter()
        .map(|(id, j)| {
            json!({
                "job_id": id,
                "command": j.command,
                "cwd": j.cwd,
                "session_id": j.session,
                "elapsed_ms": j.started.elapsed().as_millis() as u64,
                "log_lines": j.logs.lock().unwrap().len(),
            })
        })
        .collect();
    serde_json::Value::Array(arr)
}

/// 单个 job 详情：前端「日志弹窗」打开时一次性拉取，返回命令元信息 + 当前所有日志行。
/// 已结束的 job 会被 finish 立即 remove，detail 只对运行中的 job 生效——
/// 但由于我们把日志持续塞进 job.logs，运行中的 job 能看到截至当前的所有输出。
pub fn detail(id: &str) -> Option<serde_json::Value> {
    let m = jobs().lock().unwrap();
    let j = m.get(id)?;
    let logs = j.logs.lock().unwrap().clone();
    Some(json!({
        "job_id": j.id,
        "command": j.command,
        "cwd": j.cwd,
        "session_id": j.session,
        "elapsed_ms": j.started.elapsed().as_millis() as u64,
        "logs": logs,
    }))
}

/// 重复命令检测：同一会话里是否已有同一条命令在后台跑。返回其 job_id
pub fn find_running(session: Option<&str>, command: &str) -> Option<String> {
    let m = jobs().lock().unwrap();
    m.values()
        .find(|j| j.session.as_deref() == session && j.command == command)
        .map(|j| j.id.clone())
}
