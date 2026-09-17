// yxpil · BIT
//! WorkWith：本地服务程序托管。
//! 用本机已探测的运行环境（node / java / python / 自定义 exe）手动或联动运行
//! 本地服务器程序（server.js / xxx.jar 等）；端口就绪后自动接入为 MCP 服务器
//! （Streamable HTTP），把服务上的工具扩展给 AI；停止 / 崩溃时自动禁用该
//! MCP 服务器并同步移除其导入的工具，避免残留死工具。
//!
//! 生命周期：
//!   save/remove → 条目持久化（bit.db key "workwith"）
//!   start       → spawn（无窗口）→ 日志缓冲 → 端口就绪探测 → MCP 接入
//!   stop/崩溃   → kill → MCP 禁用 + 工具移除 → 事件广播
//!   ensure_auto_started → 新会话首回合联动（幂等，已运行即跳过）
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 持久化条目（bit.db key "workwith"，随 Ctx 启动加载）
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkWithEntry {
    /// 新增时可缺省，save 内自动生成
    #[serde(default)]
    pub id: String,
    /// 展示名称
    pub name: String,
    /// 运行环境 id（对应 runtimes 探测列表；"custom" = program 即可执行文件直接跑）
    #[serde(default)]
    pub runtime_id: String,
    /// 程序路径：脚本（server.js / app.py）、jar 包，或自定义可执行文件
    pub program: String,
    /// 附加参数（逐个传给程序，不含程序自身）
    #[serde(default)]
    pub args: Vec<String>,
    /// 工作目录（空 = 继承主进程）
    #[serde(default)]
    pub cwd: String,
    /// 额外环境变量
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 服务监听端口；0 = 仅托管进程，不联动 MCP
    #[serde(default)]
    pub port: u16,
    /// 会话联动：新会话首回合自动拉起（幂等）
    #[serde(default)]
    pub auto_with_session: bool,
}

/// 运行态（内存，重启清零）：进程句柄 + 实时日志环形缓冲
pub struct Running {
    pub pid: u32,
    /// 进程句柄。monitor 任务会 take 走并 await 退出；stop 用 start_kill() 同步发终止信号
    pub child: Mutex<Option<tokio::process::Child>>,
    /// 实时输出缓冲（按行，复用 shellbg::LogLine 结构）
    pub logs: Arc<Mutex<Vec<crate::shellbg::LogLine>>>,
    pub started_at: std::time::Instant,
    /// 用户主动停止时置位：monitor 看到退出后按 "killed" 汇报而非 "exited"
    pub stopping: AtomicBool,
}

/// 全局进程注册表：entry_id → 运行态
fn reg() -> &'static Mutex<HashMap<String, Arc<Running>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<Running>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// WorkWith 条目联动出的 MCP 服务器 id（稳定：重启 / 重启进程不换 id）
fn mcp_id(entry_id: &str) -> String {
    format!("ww-{entry_id}")
}

/// 日志缓冲上限（行）：超过丢弃最早的，防大输出泄漏
const MAX_LOG_LINES: usize = 1000;
/// 端口就绪探测上限：超时后放弃 MCP 联动（进程继续跑，用户可手动重连）
const PORT_WAIT_SECS: u64 = 60;

// ── 持久化 ──

pub fn load_entries(ctx: &Arc<crate::state::Ctx>) -> Vec<WorkWithEntry> {
    ctx.db_get_json("workwith").unwrap_or_default()
}

fn save_entries(ctx: &Arc<crate::state::Ctx>, entries: &[WorkWithEntry]) {
    ctx.db_put_json("workwith", &entries.to_vec());
}

// ── 查询 ──

/// 条目列表 + 运行态快照（status: running/stopped；running 附 pid / 运行秒数）
pub fn list(ctx: &Arc<crate::state::Ctx>) -> serde_json::Value {
    let reg = reg().lock().unwrap();
    let entries: Vec<serde_json::Value> = load_entries(ctx)
        .iter()
        .map(|e| {
            let run = reg.get(&e.id);
            json!({
                "id": e.id, "name": e.name, "runtime_id": e.runtime_id,
                "program": e.program, "args": e.args, "cwd": e.cwd,
                "env": e.env, "port": e.port, "auto_with_session": e.auto_with_session,
                "status": if run.is_some() { "running" } else { "stopped" },
                "pid": run.map(|r| r.pid).unwrap_or(0),
                "uptime_ms": run.map(|r| r.started_at.elapsed().as_millis() as u64).unwrap_or(0),
            })
        })
        .collect();
    json!({ "entries": entries })
}

/// 某条目的实时日志（可选尾部行数）
pub fn logs_of(id: &str, tail: Option<usize>) -> serde_json::Value {
    let reg = reg().lock().unwrap();
    let logs = match reg.get(id) {
        Some(r) => r.logs.lock().unwrap().clone(),
        None => Vec::new(),
    };
    let logs = match tail {
        Some(n) if logs.len() > n => logs[logs.len() - n..].to_vec(),
        _ => logs,
    };
    json!({ "logs": logs })
}

// ── 进程命令构造 ──

/// 按运行环境解析出 (可执行文件, 参数列表)：
/// - custom / 未指定：program 即可执行文件
/// - java：.jar → [-jar, program]，其余按主类处理
/// - 其余（解释型 node/python/...）：[解释器, program, ...args]
fn build_command(ctx: &Arc<crate::state::Ctx>, e: &WorkWithEntry) -> Result<(String, Vec<String>), String> {
    if e.runtime_id.is_empty() || e.runtime_id == "custom" {
        if e.program.trim().is_empty() {
            return Err("请填写程序路径".into());
        }
        return Ok((e.program.clone(), e.args.clone()));
    }
    let rt = ctx
        .runtimes
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.id == e.runtime_id)
        .cloned()
        .ok_or_else(|| format!("找不到运行环境 {0}，请先在工具页刷新运行环境", e.runtime_id))?;
    if rt.id == "java" {
        let head = if e.program.to_lowercase().ends_with(".jar") {
            vec!["-jar".to_string(), e.program.clone()]
        } else {
            vec![e.program.clone()]
        };
        return Ok((rt.path, [head, e.args.clone()].concat()));
    }
    Ok((rt.path, [vec![e.program.clone()], e.args.clone()].concat()))
}

// ── MCP 联动 ──

/// 端口就绪后接入 MCP：握手 → 注册/更新（enabled=true）→ 导入工具（同名跳过）
async fn link_mcp(ctx: &Arc<crate::state::Ctx>, e: &WorkWithEntry) {
    let url = format!("http://127.0.0.1:{}", e.port);
    let mid = mcp_id(&e.id);
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            ctx.emit("workwith", json!({ "phase": "mcp-failed", "id": e.id, "name": e.name, "error": err.to_string() }));
            return;
        }
    };
    let (name, version, protocol, session) = match crate::mcp::initialize(&http, &url).await {
        Ok(v) => v,
        Err(err) => {
            ctx.emit("workwith", json!({ "phase": "mcp-failed", "id": e.id, "name": e.name, "error": err }));
            return;
        }
    };
    {
        let mut list = ctx.mcp.lock().unwrap();
        match list.iter_mut().find(|s| s.id == mid) {
            Some(s) => {
                s.name = name.clone();
                s.url = url.clone();
                s.version = version;
                s.protocol = protocol;
                s.session = session;
                s.enabled = true;
                s.connected_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            }
            None => list.push(crate::mcp::McpServer {
                id: mid.clone(),
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
            }),
        }
    }
    ctx.save_mcp();
    // 导入工具进注册中心（同名跳过）；save_tools 内部广播 tools-updated，工具列表即时刷新
    let server = match crate::mcp::find(ctx, &mid) {
        Some(s) => s,
        None => return,
    };
    let imported = match crate::mcp::list_tools(&server).await {
        Ok(tools) => {
            let mut n = 0usize;
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
                    crate::registry::ToolKind::Mcp { server_id: mid.clone(), tool: t.name.clone() },
                    "mcp",
                );
                if ok.is_ok() {
                    n += 1;
                }
            }
            n
        }
        Err(_) => 0,
    };
    ctx.emit("workwith", json!({ "phase": "mcp-linked", "id": e.id, "name": e.name, "url": url, "imported": imported }));
    crate::audit::record(ctx, "local-app", "workwith.mcp-link", &e.name, json!({ "url": url, "imported": imported }), true);
}

/// 停止 / 崩溃后的解绑：MCP 禁用 + 该服务导入的工具全部移除
fn unlink_mcp(ctx: &Arc<crate::state::Ctx>, e: &WorkWithEntry) {
    let mid = mcp_id(&e.id);
    let linked = {
        let mut list = ctx.mcp.lock().unwrap();
        match list.iter_mut().find(|s| s.id == mid) {
            Some(s) => {
                let was = s.enabled;
                s.enabled = false;
                s.session.clear();
                was
            }
            None => return, // 从未联动过，无需处理
        }
    };
    ctx.save_mcp();
    {
        let mut tools = ctx.tools.lock().unwrap();
        tools.retain(|t| match &t.kind {
            crate::registry::ToolKind::Mcp { server_id, .. } => server_id != &mid,
            _ => true,
        });
    }
    ctx.save_tools(); // 广播 tools-updated，前端工具列表同步删除
    if linked {
        crate::audit::record(ctx, "local-app", "workwith.mcp-unlink", &e.name, json!({ "id": mid }), true);
    }
}

/// 端口就绪探测：进程存活期间每 500ms 试连一次；就绪 → link_mcp，超时 → 事件告知
async fn wait_port_and_link(ctx: Arc<crate::state::Ctx>, e: WorkWithEntry) {
    let addr = ("127.0.0.1", e.port);
    for _ in 0..(PORT_WAIT_SECS * 2) {
        if !reg().lock().unwrap().contains_key(&e.id) {
            return; // 进程已退出，联动终止
        }
        if tokio::net::TcpStream::connect(addr).await.is_ok() {
            link_mcp(&ctx, &e).await;
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    ctx.emit("workwith", json!({ "phase": "port-timeout", "id": e.id, "name": e.name, "port": e.port }));
}

// ── 进程退出监控 ──

/// 读一路输出管道进日志缓冲（按行；末行无换行也保留）
async fn pipe_logs(
    pipe: impl tokio::io::AsyncRead + Unpin,
    stream: &'static str,
    logs: Arc<Mutex<Vec<crate::shellbg::LogLine>>>,
    base: std::time::Instant,
) {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 4096];
    let mut carry: Vec<u8> = Vec::new();
    let mut pipe = pipe;
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                carry.extend_from_slice(&buf[..n]);
                while let Some(pos) = carry.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = carry.drain(..=pos).collect();
                    push_log(&logs, &line[..line.len() - 1], stream, base);
                }
                // 尾部残留（进程可能不发换行就输出/退出）：留待下次或结束时输出，
                // 不在这里强行 flush，避免把二进制进度条刷成洪水日志
            }
        }
    }
    if !carry.is_empty() {
        push_log(&logs, &carry, stream, base);
    }
}

fn push_log(logs: &Mutex<Vec<crate::shellbg::LogLine>>, raw: &[u8], stream: &str, base: std::time::Instant) {
    let text = crate::console_codec::decode_console(raw);
    if text.trim().is_empty() {
        return;
    }
    let mut v = logs.lock().unwrap();
    v.push(crate::shellbg::LogLine {
        stream: stream.to_string(),
        text,
        ts_ms: base.elapsed().as_millis() as u64,
    });
    let over = v.len().saturating_sub(MAX_LOG_LINES);
    if over > 0 {
        v.drain(0..over);
    }
}

/// 退出监控：轮询 try_wait（句柄保留在 Running 中，stop 才能拿到并 start_kill）
/// → 退出后清理（注册表摘除 / MCP 解绑 / 事件）
async fn monitor_exit(ctx: Arc<crate::state::Ctx>, e: WorkWithEntry, running: Arc<Running>) {
    let mut exit_code: Option<i32> = None;
    loop {
        let status = {
            let mut g = running.child.lock().unwrap();
            match g.as_mut() {
                Some(ch) => ch.try_wait().ok().flatten(),
                None => None,
            }
        };
        if let Some(st) = status {
            exit_code = st.code();
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let killed = running.stopping.load(Ordering::Relaxed);
    reg().lock().unwrap().remove(&e.id);
    if e.port > 0 {
        unlink_mcp(&ctx, &e);
    }
    ctx.emit("workwith", json!({
        "phase": if killed { "killed" } else { "exited" },
        "id": e.id, "name": e.name, "code": exit_code,
    }));
    crate::audit::record(
        &ctx,
        "local-app",
        if killed { "workwith.stop" } else { "workwith.exit" },
        &e.name,
        json!({ "code": exit_code, "port": e.port }),
        true,
    );
}

// ── 对外命令 ──

/// 条目保存（新增或更新；id 为空自动生成）
pub fn save(ctx: &Arc<crate::state::Ctx>, entry: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut e: WorkWithEntry =
        serde_json::from_value(entry).map_err(|err| format!("条目格式错误: {err}"))?;
    if e.name.trim().is_empty() {
        return Err("请填写条目名称".into());
    }
    if e.program.trim().is_empty() {
        return Err("请填写程序路径".into());
    }
    let mut entries = load_entries(ctx);
    if e.id.is_empty() {
        e.id = uuid::Uuid::new_v4().simple().to_string();
        entries.push(e.clone());
    } else if let Some(slot) = entries.iter_mut().find(|x| x.id == e.id) {
        // 运行中禁止改配置（改了也不生效，徒增困惑）：先停再改
        if reg().lock().unwrap().contains_key(&e.id) {
            return Err("条目运行中，请先停止再修改".into());
        }
        *slot = e.clone();
    } else {
        return Err("条目不存在".into());
    }
    save_entries(ctx, &entries);
    Ok(json!({ "entry": e }))
}

/// 条目删除：运行中先杀进程并解绑 MCP，再从持久化里移除
pub async fn remove(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<serde_json::Value, String> {
    let mut entries = load_entries(ctx);
    let pos = entries.iter().position(|e| e.id == id).ok_or("条目不存在")?;
    let e = entries.remove(pos);
    save_entries(ctx, &entries);
    if let Some(running) = reg().lock().unwrap().get(id).cloned() {
        running.stopping.store(true, Ordering::Relaxed);
        if let Some(ch) = running.child.lock().unwrap().as_mut() {
            ch.start_kill().ok(); // 同步发终止信号，退出监控负责收尸与解绑
        }
    }
    // 条目都没了，MCP 服务器条目直接整条移除（而不是禁用）
    let mid = mcp_id(id);
    {
        let mut list = ctx.mcp.lock().unwrap();
        list.retain(|s| s.id != mid);
    }
    ctx.save_mcp();
    {
        let mut tools = ctx.tools.lock().unwrap();
        tools.retain(|t| match &t.kind {
            crate::registry::ToolKind::Mcp { server_id, .. } => server_id != &mid,
            _ => true,
        });
    }
    ctx.save_tools();
    ctx.emit("workwith", json!({ "phase": "removed", "id": id, "name": e.name }));
    Ok(json!({ "removed": id }))
}

/// 手动启动：spawn（无窗口）→ 日志读取 → 端口联动 / 退出监控（均为后台任务）
pub async fn start(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<serde_json::Value, String> {
    let e = load_entries(ctx)
        .into_iter()
        .find(|e| e.id == id)
        .ok_or("条目不存在")?;
    if reg().lock().unwrap().contains_key(id) {
        return Err("已在运行".into());
    }
    let (prog, args) = build_command(ctx, &e)?;
    let mut c = tokio::process::Command::new(&prog);
    c.args(&args);
    if !e.cwd.trim().is_empty() {
        c.current_dir(e.cwd.trim());
    }
    c.envs(&e.env);
    c.stdout(std::process::Stdio::piped());
    c.stderr(std::process::Stdio::piped());
    c.stdin(std::process::Stdio::null());
    crate::registry::no_window_tokio(&mut c);
    let child = c.spawn().map_err(|err| format!("启动失败: {err}"))?;
    let pid = child.id().unwrap_or(0);
    let base = std::time::Instant::now();
    let logs = Arc::new(Mutex::new(Vec::new()));
    let running = Arc::new(Running {
        pid,
        child: Mutex::new(Some(child)),
        logs: logs.clone(),
        started_at: base,
        stopping: AtomicBool::new(false),
    });
    reg().lock().unwrap().insert(id.to_string(), running.clone());
    // 日志读取：stdout / stderr 两路并发进同一缓冲
    if let Some(out) = running.child.lock().unwrap().as_mut().and_then(|c| c.stdout.take()) {
        let l2 = logs.clone();
        crate::task::spawn(async move { pipe_logs(out, "out", l2, base).await });
    }
    if let Some(err) = running.child.lock().unwrap().as_mut().and_then(|c| c.stderr.take()) {
        let l3 = logs.clone();
        crate::task::spawn(async move { pipe_logs(err, "err", l3, base).await });
    }
    ctx.emit("workwith", json!({ "phase": "started", "id": e.id, "name": e.name, "pid": pid, "port": e.port }));
    crate::audit::record(ctx, "local-app", "workwith.start", &e.name, json!({ "pid": pid, "port": e.port }), true);
    if e.port > 0 {
        let c2 = ctx.clone();
        let e2 = e.clone();
        crate::task::spawn(async move { wait_port_and_link(c2, e2).await });
    }
    {
        let c2 = ctx.clone();
        let e2 = e.clone();
        let r2 = running.clone();
        crate::task::spawn(async move { monitor_exit(c2, e2, r2).await });
    }
    Ok(json!({ "id": e.id, "pid": pid, "status": "running" }))
}

/// 手动停止：同步发终止信号，退出监控任务收尾（MCP 解绑 + 事件）
pub async fn stop(_ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<serde_json::Value, String> {
    let running = reg()
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or("未在运行")?;
    running.stopping.store(true, Ordering::Relaxed);
    {
        let mut g = running.child.lock().unwrap();
        if let Some(ch) = g.as_mut() {
            ch.start_kill().ok();
        }
    }
    // 等退出监控完成清理（最多 5s），保证返回时状态已一致
    for _ in 0..50 {
        if !reg().lock().unwrap().contains_key(id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(json!({ "id": id, "status": "stopped" }))
}

/// 新会话首回合联动：auto_with_session 条目未运行的自动拉起（幂等；fire-and-forget）
pub fn ensure_auto_started(ctx: &Arc<crate::state::Ctx>) {
    let ids: Vec<String> = load_entries(ctx)
        .iter()
        .filter(|e| e.auto_with_session)
        .map(|e| e.id.clone())
        .collect();
    for id in ids {
        if reg().lock().unwrap().contains_key(&id) {
            continue; // 已在跑，跳过
        }
        let c2 = ctx.clone();
        crate::task::spawn(async move {
            let _ = start(&c2, &id).await; // 失败由 start 内部 emit 事件告知
        });
    }
}

// ── 单测 ──

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用临时目录：进程级唯一，避免上次运行的残留库污染断言
    /// （remove_dir_all 在 sqlite 句柄未释放的 Windows 上会静默失败）
    fn test_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bit-workwith-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    /// mcp_id 稳定性：联动 / 解绑 / 重启进程必须命中同一条 MCP 记录
    #[test]
    fn mcp_id_is_stable() {
        assert_eq!(mcp_id("abc"), mcp_id("abc"));
        assert_eq!(mcp_id("abc"), "ww-abc");
        assert_ne!(mcp_id("abc"), mcp_id("abd"));
    }

    /// build_command：custom 直跑 / java -jar / 解释型三段式
    #[test]
    fn build_command_shapes() {
        let dir = test_dir("cmd");
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: dir.clone(),
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        });
        // custom：程序即可执行文件
        let e = WorkWithEntry {
            id: "1".into(), name: "t".into(), runtime_id: "custom".into(),
            program: "C:/x/tool.exe".into(), args: vec!["--port".into(), "8080".into()],
            cwd: String::new(), env: HashMap::new(), port: 0, auto_with_session: false,
        };
        let (p, a) = build_command(&ctx, &e).unwrap();
        assert_eq!(p, "C:/x/tool.exe");
        assert_eq!(a, vec!["--port".to_string(), "8080".to_string()]);
        // 解释型：解释器 + 程序 + 参数
        {
            let mut rts = ctx.runtimes.lock().unwrap();
            rts.push(crate::runtime::Runtime {
                id: "node".into(), name: "Node.js".into(), path: "C:/n/node.exe".into(),
                version: "22".into(), lang: "js".into(), mode: "interpret".into(),
                run_args: vec![], manual: false, enabled: true,
            });
        }
        let e2 = WorkWithEntry { runtime_id: "node".into(), program: "server.js".into(), ..e.clone() };
        let (p, a) = build_command(&ctx, &e2).unwrap();
        assert_eq!(p, "C:/n/node.exe");
        assert_eq!(a, vec!["server.js".to_string(), "--port".to_string(), "8080".to_string()]);
        // java：jar 包自动加 -jar
        {
            let mut rts = ctx.runtimes.lock().unwrap();
            rts.push(crate::runtime::Runtime {
                id: "java".into(), name: "Java".into(), path: "C:/j/java.exe".into(),
                version: "21".into(), lang: "java".into(), mode: "compile".into(),
                run_args: vec![], manual: false, enabled: true,
            });
        }
        let e3 = WorkWithEntry { runtime_id: "java".into(), program: "app.jar".into(), ..e.clone() };
        let (p, a) = build_command(&ctx, &e3).unwrap();
        assert_eq!(p, "C:/j/java.exe");
        assert_eq!(a, vec!["-jar".to_string(), "app.jar".to_string(), "--port".to_string(), "8080".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// save 校验：缺名称 / 缺程序路径 / 新增生成 id / 更新保字段
    #[test]
    fn save_validates_and_upserts() {
        let dir = test_dir("save");
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: dir.clone(),
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        });
        // 缺名称拒绝
        let bad = json!({ "program": "a.exe" });
        assert!(save(&ctx, bad).is_err());
        // 新增：id 自动生成并持久化
        let good = json!({ "name": "demo", "program": "server.js", "runtime_id": "node", "port": 3000, "auto_with_session": true });
        let out = save(&ctx, good).unwrap();
        let id = out["entry"]["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());
        assert_eq!(load_entries(&ctx).len(), 1);
        // 更新：同 id 覆盖
        let upd = json!({ "id": id, "name": "demo2", "program": "server2.js", "runtime_id": "node" });
        save(&ctx, upd).unwrap();
        let entries = load_entries(&ctx);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "demo2");
        assert_eq!(entries[0].port, 0); // 未传字段回落默认值
        let _ = std::fs::remove_dir_all(dir);
    }
}
