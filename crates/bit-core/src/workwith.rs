// yxpil · BIT
//! WorkWith：本地服务程序托管。
//! 用本机已探测的运行环境（node / java / python / 自定义 exe）手动或联动运行
//! 本地服务器程序（server.js / xxx.jar 等），两种 MCP 联动方式：
//!   http  —— 端口就绪后自动接入为 MCP 服务器（Streamable HTTP）
//!   stdio —— 进程本身就是 MCP 服务器（dsh 插件桥这类不开端口的 node 脚本），
//!            启动即接管它的 stdin/stdout 做 JSON-RPC；进程句柄仍归本模块所有，
//!            mcp.rs 只借管道通信，不会自己重拉第二个进程
//! 把服务上的工具扩展给 AI；停止 / 崩溃时自动禁用该 MCP 服务器并同步移除其导入的
//! 工具，避免残留死工具。
//!
//! 生命周期：
//!   save/remove → 条目持久化（bit.db key "workwith"）
//!   start       → spawn（无窗口）→ 日志缓冲 → 端口探测 / 管道接管 → MCP 接入
//!   stop/崩溃   → kill → MCP 禁用 + 工具移除（stdio 连会话一起作废）→ 事件广播
//!   ensure_auto_started → 新会话首回合联动（幂等，已运行即跳过）
//!   ai_call     → builtin.workwith 工具（默认关闭）：增删查改 + 启停 + 日志
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
    /// 服务监听端口；0 = 仅托管进程，不联动 MCP（stdio 模式忽略此项）
    #[serde(default)]
    pub port: u16,
    /// MCP 联动方式：空 / "http" = 等端口就绪后按 Streamable HTTP 接入；
    /// "stdio" = 进程本身就是 MCP 服务器（JSON-RPC 走 stdin/stdout），启动即接管管道。
    /// dsh 插件桥这类 node 脚本不开端口，只能走后者。
    #[serde(default)]
    pub mcp_mode: String,
    /// 会话联动：新会话首回合自动拉起（幂等）
    #[serde(default)]
    pub auto_with_session: bool,
    /// 由插件清单 services[] 声明（重扫时按清单对账；用户自建条目恒为 false）
    #[serde(default)]
    pub declared: bool,
}

impl WorkWithEntry {
    /// stdio 联动模式
    pub fn is_stdio_mcp(&self) -> bool {
        self.mcp_mode == MCP_MODE_STDIO
    }

    /// 是否需要 MCP 联动：stdio 必然联动，http 看端口
    pub fn wants_mcp(&self) -> bool {
        self.is_stdio_mcp() || self.port > 0
    }
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
pub fn mcp_id(entry_id: &str) -> String {
    format!("ww-{entry_id}")
}

/// 反解：MCP 服务器 id 是否出自 WorkWith 联动，是则给出其中的条目 id。
/// mcp.rs 靠它判断「这条 stdio 会话的进程归托管方所有，不能自己重拉」。
pub fn entry_id_of_mcp(server_id: &str) -> Option<&str> {
    server_id.strip_prefix("ww-")
}

/// 日志缓冲上限（行）：默认值，实际按设置 svc_log_lines 走
const DEFAULT_LOG_LINES: usize = 1000;
/// 端口就绪探测的默认预算（秒）：实际按设置 svc_ready_secs 走
const DEFAULT_READY_SECS: u64 = 60;
/// MCP 联动方式取值（存进条目的 mcp_mode 字段，前端下拉同值）
pub const MCP_MODE_HTTP: &str = "http";
pub const MCP_MODE_STDIO: &str = "stdio";

// ── 生命周期可调参数（设置 → 执行与安全 → 托管服务）──

/// 生效中的生命周期口径（一次读全，避免各处各自 lock config）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tuning {
    /// 启动前等待（毫秒）
    pub start_delay_ms: u32,
    /// 端口就绪等待上限（秒）
    pub ready_secs: u32,
    /// 意外退出后的自动重启次数上限（0 = 关闭）
    pub retries: u32,
    /// stop() 等退出监控收尾的上限（秒）
    pub stop_grace_secs: u32,
    /// 单服务日志环形缓冲行数上限
    pub log_lines: u32,
}

/// 各值的允许区间：设置页写不进去越界值（set_service_tuning 当场钳制），
/// 读取时也再钳一次——老配置文件里的怪数字不能把探测器变成 0 秒或 20 万行
pub const TUNING_RANGE: [(&str, u32, u32); 5] = [
    ("start_delay_ms", 0, 10_000),
    ("ready_secs", 5, 600),
    ("retries", 0, 10),
    ("stop_grace_secs", 1, 60),
    ("log_lines", 100, 20_000),
];

impl Tuning {
    pub fn clamp(self) -> Self {
        let r = TUNING_RANGE;
        Self {
            start_delay_ms: self.start_delay_ms.clamp(r[0].1, r[0].2),
            ready_secs: self.ready_secs.clamp(r[1].1, r[1].2),
            retries: self.retries.clamp(r[2].1, r[2].2),
            stop_grace_secs: self.stop_grace_secs.clamp(r[3].1, r[3].2),
            log_lines: self.log_lines.clamp(r[4].1, r[4].2),
        }
    }
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            start_delay_ms: 300,
            ready_secs: DEFAULT_READY_SECS as u32,
            retries: 2,
            stop_grace_secs: 5,
            log_lines: DEFAULT_LOG_LINES as u32,
        }
    }
}

/// 从配置读出生命周期口径（钳制后返回）
pub fn tuning(ctx: &Arc<crate::state::Ctx>) -> Tuning {
    let cfg = ctx.config.lock().unwrap();
    Tuning {
        start_delay_ms: cfg.svc_start_delay_ms,
        ready_secs: cfg.svc_ready_secs,
        retries: cfg.svc_retries,
        stop_grace_secs: cfg.svc_stop_grace_secs,
        log_lines: cfg.svc_log_lines,
    }
    .clamp()
}

/// 第 attempt 次（1 起）重试前总共要等多久：以启动延时为基数翻倍，封顶 15 秒。
/// 崩溃循环不该变成机关枪——退避是它唯一的刹车。
pub fn retry_backoff_ms(base_delay_ms: u32, attempt: u32) -> u64 {
    let step = base_delay_ms.max(200) as u64;
    let factor = 1u64 << (attempt.saturating_sub(1).min(3)); // 1,2,4,8 后保持 8
    (step * factor).min(15_000)
}

/// 进程活过这个秒数就算"跑稳了"：连续失败计数归零，之后的崩溃重新拿到完整重试预算。
/// 只看存活时长，不看端口——没有 MCP 联动的纯托管进程同样适用
const STEADY_SECS: u64 = 60;

/// 每个条目的连续重启尝试数（内存，运行期口径）
fn attempts() -> &'static Mutex<HashMap<String, u32>> {
    static A: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 记一次重试并返回第几次（1 起）
fn bump_attempt(id: &str) -> u32 {
    let mut m = attempts().lock().unwrap();
    let n = m.entry(id.to_string()).or_insert(0);
    *n += 1;
    *n
}

/// 服务站稳了（端口就绪/握手成功）或用户手动启动：计数清零，别把预算欠完
pub fn note_steady(id: &str) {
    attempts().lock().unwrap().remove(id);
}

// ── 持久化 ──

pub fn load_entries(ctx: &Arc<crate::state::Ctx>) -> Vec<WorkWithEntry> {
    ctx.db_get_json("workwith").unwrap_or_default()
}

fn save_entries(ctx: &Arc<crate::state::Ctx>, entries: &[WorkWithEntry]) {
    ctx.db_put_json("workwith", &entries.to_vec());
}

/// 整表对账（插件清单 services[] 同步用）：有变化才落库，返回是否写入。
pub(crate) fn replace_entries(ctx: &Arc<crate::state::Ctx>, entries: &[WorkWithEntry]) -> bool {
    let old = serde_json::to_value(load_entries(ctx)).unwrap_or_default();
    let new = serde_json::to_value(entries).unwrap_or_default();
    if old == new {
        return false;
    }
    save_entries(ctx, entries);
    true
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
                "env": e.env, "port": e.port, "mcp_mode": e.mcp_mode,
                "auto_with_session": e.auto_with_session,
                "declared": e.declared,
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
    let http = match crate::mcp::http_client(&url) {
        Ok(c) => c,
        Err(err) => {
            ctx.emit("workwith", json!({ "phase": "mcp-failed", "id": e.id, "name": e.name, "error": err.to_string() }));
            return;
        }
    };
    let (name, version, protocol, session) = match crate::mcp::initialize(&http, &url, &Default::default()).await {
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
                headers: Default::default(),
                plugin_id: String::new(),
            }),
        }
    }
    ctx.save_mcp();
    let imported = import_tools(ctx, &mid).await;
    ctx.emit("workwith", json!({ "phase": "mcp-linked", "id": e.id, "name": e.name, "url": url, "imported": imported }));
    crate::audit::record(ctx, "local-app", "workwith.mcp-link", &e.name, json!({ "url": url, "imported": imported }), true);
}

/// 拉取该 MCP 条目的工具清单并进注册中心（同名跳过）。
/// 实现与插件外部连接共用一份（见 mcp::import_server_tools）：两处都是
/// 「握手成功后把远端工具搬进注册中心」，语义必须一致，不能各写各的。
/// 这里容忍拉不到：进程可能还在起、工具稍后才出现，端口联动本来就会再来一次；
/// 插件外部连接那边则把失败如实报给用户（见 netconn::connect）。
async fn import_tools(ctx: &Arc<crate::state::Ctx>, mid: &str) -> usize {
    crate::mcp::import_server_tools(ctx, mid).await.unwrap_or(0)
}

/// stdio 模式联动：握手 → MCP 条目（transport=Stdio）→ 导入工具 → 事件。
/// 握手失败说明这条程序根本不是 MCP 服务器：留着它只会占着管道装死，直接终止进程，
/// 让用户在事件与日志（stderr）里看到真实原因。
async fn link_stdio(
    ctx: &Arc<crate::state::Ctx>,
    e: &WorkWithEntry,
    command: String,
    args: Vec<String>,
    session: std::sync::Arc<crate::mcp::stdio_session::StdioSession>,
) {
    let mid = mcp_id(&e.id);
    let (name, version, protocol) = match crate::mcp::stdio_session::initialize(&session).await {
        Ok(v) => v,
        Err(err) => {
            ctx.emit("workwith", json!({ "phase": "mcp-failed", "id": e.id, "name": e.name, "error": err }));
            crate::audit::record(ctx, "local-app", "workwith.mcp-failed", &e.name, json!({ "error": err }), false);
            if let Some(r) = reg().lock().unwrap().get(&e.id) {
                r.stopping.store(true, Ordering::Relaxed);
                if let Some(ch) = r.child.lock().unwrap().as_mut() {
                    ch.start_kill().ok();
                }
            }
            return;
        }
    };
    // 会话先入注册表：紧接着的 import_tools 要靠它发 tools/list
    ctx.mcp_stdio.lock().unwrap().insert(mid.clone(), session);
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    {
        let mut list = ctx.mcp.lock().unwrap();
        match list.iter_mut().find(|s| s.id == mid) {
            Some(s) => {
                s.name = name.clone();
                s.transport = crate::mcp::McpTransport::Stdio;
                s.command = command.clone();
                s.args = args.clone();
                s.env = e.env.clone();
                s.version = version;
                s.protocol = protocol;
                s.enabled = true;
                s.connected_at = now;
            }
            None => list.push(crate::mcp::McpServer {
                id: mid.clone(),
                name: name.clone(),
                url: String::new(),
                transport: crate::mcp::McpTransport::Stdio,
                command,
                args,
                env: e.env.clone(),
                version,
                protocol,
                session: String::new(),
                enabled: true,
                connected_at: now,
                headers: Default::default(),
                plugin_id: String::new(),
            }),
        }
    }
    ctx.save_mcp();
    let imported = import_tools(ctx, &mid).await;
    note_steady(&e.id); // 握手成功、工具都导进来了：这条服务的重试预算重新充满
    ctx.emit("workwith", json!({ "phase": "mcp-linked", "id": e.id, "name": e.name, "transport": "stdio", "imported": imported }));
    crate::audit::record(ctx, "local-app", "workwith.mcp-link", &e.name, json!({ "transport": "stdio", "imported": imported }), true);
}

/// 停止 / 崩溃后的解绑：MCP 禁用 + 该服务导入的工具全部移除
fn unlink_mcp(ctx: &Arc<crate::state::Ctx>, e: &WorkWithEntry) {
    let mid = mcp_id(&e.id);
    // stdio 会话随进程一起作废（留着会把死管道交给下一次调用）。
    // 托管场景会话不持 Child，这里的 kill 是 no-op——终止由调用方（停止 / 退出监控）负责
    if e.is_stdio_mcp() {
        crate::mcp::unregister_stdio(&ctx.mcp_stdio, &mid);
    }
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

/// 单次端口试连，封顶 250ms。
/// 不封顶就不叫「秒级预算」：本机端口空着时 Windows 的 connect 可能卡上一两秒才回
/// ECONNREFUSED，按试连次数循环会把设置里的 5 秒拖成实测量 25 秒（真机探针踩到的）。
/// 超时即视为「这次没通」，下轮再试——服务真在监听时连接是立刻成功的，不受影响。
pub async fn probe_port(addr: (&str, u16)) -> bool {
    tokio::time::timeout(std::time::Duration::from_millis(250), tokio::net::TcpStream::connect(addr))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
}

/// 端口就绪探测：按墙上时间给预算（设置 svc_ready_secs），到点没通就事件告知。
/// 每 250ms 试连一次，单次试连也封顶 250ms——见 probe_port。
async fn wait_port_and_link(ctx: Arc<crate::state::Ctx>, e: WorkWithEntry) {
    let addr = ("127.0.0.1", e.port);
    let t = tuning(&ctx);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(t.ready_secs as u64);
    loop {
        if !reg().lock().unwrap().contains_key(&e.id) {
            return; // 进程已退出，联动终止
        }
        if probe_port(addr).await {
            note_steady(&e.id); // 服务真的在听了：欠下的重试预算清零
            link_mcp(&ctx, &e).await;
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    ctx.emit(
        "workwith",
        json!({ "phase": "port-timeout", "id": e.id, "name": e.name, "port": e.port, "wait_secs": t.ready_secs }),
    );
}

// ── 进程退出监控 ──

/// 读一路输出管道进日志缓冲（按行；末行无换行也保留）
async fn pipe_logs(
    pipe: impl tokio::io::AsyncRead + Unpin,
    stream: &'static str,
    logs: Arc<Mutex<Vec<crate::shellbg::LogLine>>>,
    base: std::time::Instant,
    cap: usize,
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
                    push_log(&logs, &line[..line.len() - 1], stream, base, cap);
                }
                // 尾部残留（进程可能不发换行就输出/退出）：留待下次或结束时输出，
                // 不在这里强行 flush，避免把二进制进度条刷成洪水日志
            }
        }
    }
    if !carry.is_empty() {
        push_log(&logs, &carry, stream, base, cap);
    }
}

fn push_log(logs: &Mutex<Vec<crate::shellbg::LogLine>>, raw: &[u8], stream: &str, base: std::time::Instant, cap: usize) {
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
    let over = v.len().saturating_sub(cap);
    if over > 0 {
        v.drain(0..over);
    }
}

/// 这条托管进程归哪个插件的健康台账管：插件自带服务器按 id 前缀认，
/// 清单声明的托管服务（psvc-）靠宿主注入的 BIT_PLUGIN_ID 认回所属插件。
/// 启动成功用它清异常，意外退出用它登记异常——两头必须同一个口径，
/// 否则「崩了亮灯、重启好了灯却退不掉」。
fn health_owner(e: &WorkWithEntry) -> Option<String> {
    if let Some(pid) = e.id.strip_prefix("plugin:") {
        return Some(pid.to_string());
    }
    if e.id.starts_with(crate::plugins::SERVICE_ID_MARK) {
        return e.env.get("BIT_PLUGIN_ID").cloned();
    }
    None
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
    if e.wants_mcp() {
        unlink_mcp(&ctx, &e);
    }
    let is_plugin = e.id.starts_with("plugin:");
    // 异常登记覆盖两类进程：插件自带服务器（plugin:<id>）与清单声明的托管服务（psvc-<id>-<名>）。
    // 后者靠宿主注入的 BIT_PLUGIN_ID 认回所属插件——否则服务崩了页眉异常灯不会亮
    // （插件套件的 svc-crash 夹具就是这么暴露的：进程 code 1 退出，health 却一直是空）。
    if let Some(pid) = health_owner(&e) {
        // 主动停止算正常收尾；意外退出（崩溃）登记给页眉异常灯
        if killed {
            crate::plugins::mark_healthy(&ctx, &pid);
        } else {
            let code = exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "未知".into());
            crate::plugins::mark_unhealthy(
                &ctx,
                &pid,
                &e.name,
                "crashed",
                &format!("进程意外退出（退出码 {code}）"),
            );
        }
    }
    ctx.emit(
        if is_plugin { "plugin-server" } else { "workwith" },
        json!({
            "phase": if killed { "killed" } else { "exited" },
            "id": e.id, "name": e.name, "code": exit_code,
        }),
    );
    crate::audit::record(
        &ctx,
        "local-app",
        match (is_plugin, killed) {
            (true, true) => "plugin.server.stop",
            (true, false) => "plugin.server.exit",
            (false, true) => "workwith.stop",
            (false, false) => "workwith.exit",
        },
        &e.name,
        json!({ "code": exit_code, "port": e.port }),
        true,
    );
    if !killed {
        maybe_retry(&ctx, &e, &running);
    }
}

/// 意外退出后的自动重启：只对「本该常驻」的条目生效——插件清单声明的服务（declared）
/// 或勾了新会话自动拉起的条目（auto_with_session）。用户手动建、没勾常驻的条目崩了就停着，
/// 悄悄给他重拉一个进程反而是惊吓。
/// 次数上限来自设置 svc_retries，退避以 svc_start_delay_ms 为基数翻倍；
/// 到上限就明确放弃并留一条事件（页眉异常灯此时已经亮着，别再无限重启掩盖它）。
fn maybe_retry(ctx: &Arc<crate::state::Ctx>, e: &WorkWithEntry, running: &Arc<Running>) {
    if !(e.declared || e.auto_with_session) {
        return;
    }
    // 活够久的进程算另起一局：先还满预算，再按这次的连续失败计数
    if running.started_at.elapsed().as_secs() >= STEADY_SECS {
        note_steady(&e.id);
    }
    let t = tuning(ctx);
    if t.retries == 0 {
        return;
    }
    let attempt = bump_attempt(&e.id);
    if attempt > t.retries {
        note_steady(&e.id); // 这局放弃，下次手动启动重新拿满预算
        ctx.emit(
            if e.id.starts_with("plugin:") || e.declared { "plugin-server" } else { "workwith" },
            json!({
                "phase": "retry-given-up", "id": e.id, "name": e.name,
                "attempts": attempt - 1, "max": t.retries,
            }),
        );
        crate::audit::record(
            ctx,
            "local-app",
            "workwith.retry-giveup",
            &e.name,
            json!({ "attempts": attempt - 1, "max": t.retries }),
            false,
        );
        return;
    }
    let backoff = retry_backoff_ms(t.start_delay_ms, attempt);
    // start_entry 自己还会等一轮启动延时，这里只补到退避总额，避免重复累加
    let extra = backoff.saturating_sub(t.start_delay_ms as u64);
    ctx.emit(
        if e.id.starts_with("plugin:") || e.declared { "plugin-server" } else { "workwith" },
        json!({
            "phase": "retry", "id": e.id, "name": e.name,
            "attempt": attempt, "max": t.retries, "wait_ms": backoff,
        }),
    );
    crate::audit::record(
        ctx,
        "local-app",
        "workwith.retry",
        &e.name,
        json!({ "attempt": attempt, "max": t.retries, "wait_ms": backoff, "pid": running.pid }),
        true,
    );
    let c2 = ctx.clone();
    let id2 = e.id.clone();
    crate::task::spawn(async move {
        if extra > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(extra)).await;
        }
        if reg().lock().unwrap().contains_key(&id2) {
            return; // 已经有人（用户/会话联动）把它拉起来了
        }
        let _ = start_internal(&c2, &id2).await; // 失败路径自带事件与审计
    });
}

/// 某条目是否在运行（插件服务器状态查询用）
pub fn is_running(id: &str) -> bool {
    reg().lock().unwrap().contains_key(id)
}

/// 某条目的运行态快照 (pid, 运行毫秒)；未运行返回 None
pub fn status_of(id: &str) -> Option<(u32, u64)> {
    reg().lock().unwrap().get(id).map(|r| (r.pid, r.started_at.elapsed().as_millis() as u64))
}

/// 按 id 前缀列出在跑的条目 id（退出时清理插件服务器进程用）
pub fn running_ids_with_prefix(prefix: &str) -> Vec<String> {
    reg().lock().unwrap().keys().filter(|k| k.starts_with(prefix)).cloned().collect()
}

/// 按精确 id 发终止信号（声明式条目被清单删除时用；前缀匹配会误伤同前缀的其它条目）
pub fn kill_id(id: &str) {
    let reg = reg().lock().unwrap();
    if let Some(r) = reg.get(id) {
        r.stopping.store(true, Ordering::Relaxed);
        if let Some(ch) = r.child.lock().unwrap().as_mut() {
            ch.start_kill().ok();
        }
    }
}

/// 退出链路专用：只发终止信号，不等监控收尾。
/// quit_app 之后主进程 1.5s 内就 exit(0)，异步 stop() 的等待窗口根本用不上；
/// 插件服务器是 BIT 因用户开关才拉起的子进程，不能留成孤儿继续占端口。
pub fn kill_all_with_prefix(prefix: &str) {
    let reg = reg().lock().unwrap();
    for (id, r) in reg.iter() {
        if !id.starts_with(prefix) {
            continue;
        }
        r.stopping.store(true, Ordering::Relaxed);
        if let Some(ch) = r.child.lock().unwrap().as_mut() {
            ch.start_kill().ok();
        }
    }
}

// ── 对外命令 ──

/// 条目保存（新增或更新；id 为空自动生成，给了新 id 就按该 id 建档）
pub fn save(ctx: &Arc<crate::state::Ctx>, entry: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut e: WorkWithEntry =
        serde_json::from_value(entry).map_err(|err| format!("条目格式错误: {err}"))?;
    if e.name.trim().is_empty() {
        return Err("请填写条目名称".into());
    }
    if e.program.trim().is_empty() {
        return Err("请填写程序路径".into());
    }
    // 联动方式只有三种写法：空 / http / stdio。手滑写成 "sdtio" 会让条目变成
    // 「既不握手也不监听」的哑进程，宁可当场拒绝
    e.mcp_mode = e.mcp_mode.trim().to_lowercase();
    if !matches!(e.mcp_mode.as_str(), "" | MCP_MODE_HTTP | MCP_MODE_STDIO) {
        return Err(format!("MCP 联动方式只支持 http / stdio，收到 {}", e.mcp_mode));
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
        // 带着一个还不存在的 id 进来 = 按这个 id 新建。固定 id 的内置条目（如 dsh 桥）
        // 要靠这一点做到「幂等迁移」：重复调用只会覆盖同一条，不会越搬越多
        entries.push(e.clone());
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
    if e.is_stdio_mcp() {
        crate::mcp::unregister_stdio(&ctx.mcp_stdio, &mid);
    }
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

/// 手动启动（持久化条目）：spawn 后做 MCP 联动
pub async fn start(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<serde_json::Value, String> {
    // 有人主动要它起来（用户点启动 / AI / 新会话联动）= 新的一局，重试预算重新充满
    note_steady(id);
    start_internal(ctx, id).await
}

/// 自动重启走这条：不清计数，否则预算永远花不完，崩溃的服务就变成无限重启机
async fn start_internal(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<serde_json::Value, String> {
    let e = load_entries(ctx)
        .into_iter()
        .find(|e| e.id == id)
        .ok_or("条目不存在")?;
    start_entry(ctx, &e, true).await
}

/// 启动一个进程并接管其日志/退出监控。
/// mcp_link=false：端口就绪后不接入 MCP——插件自带服务器是给页面用的，不是 MCP 服务，
/// 强行握手只会白等 10s 再报一条 mcp-failed 噪声（插件服务器复用本引擎托管）。
pub async fn start_entry(
    ctx: &Arc<crate::state::Ctx>,
    e: &WorkWithEntry,
    mcp_link: bool,
) -> Result<serde_json::Value, String> {
    let id = e.id.as_str();
    if reg().lock().unwrap().contains_key(id) {
        return Err("已在运行".into());
    }
    // 启动延时：端口与文件锁的释放常常就差这几百毫秒；等完再抢一次注册位，
    // 免得延时期间别的入口（会话联动 / 用户点启动）已经把同一条目拉起来了
    let t = tuning(ctx);
    if t.start_delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(t.start_delay_ms as u64)).await;
        if reg().lock().unwrap().contains_key(id) {
            return Err("已在运行".into());
        }
    }
    let (prog, args) = build_command(ctx, e)?;
    // stdio 联动：本进程就是 MCP 服务器，stdin/stdout 是 JSON-RPC 通道，必须由托管方接管
    let stdio_link = e.is_stdio_mcp() && mcp_link;
    let mut c = tokio::process::Command::new(&prog);
    c.args(&args);
    if !e.cwd.trim().is_empty() {
        c.current_dir(e.cwd.trim());
    }
    // 插件托管条目：令牌/API 基址按启动这一刻刷新（持久化配置可能形成于插件 API 绑定端口之前）
    let mut env = e.env.clone();
    if let Some(pid) = env.get("BIT_PLUGIN_ID").cloned() {
        env.insert("BIT_PLUGIN_TOKEN".into(), crate::plugin_api::token_for(&pid));
        env.insert("BIT_PLUGIN_API".into(), crate::plugin_api::base_url_ready(1500).await);
    }
    c.envs(&env);
    c.stdout(std::process::Stdio::piped());
    c.stderr(std::process::Stdio::piped());
    c.stdin(if stdio_link { std::process::Stdio::piped() } else { std::process::Stdio::null() });
    crate::registry::no_window_tokio(&mut c);
    let mut child = c.spawn().map_err(|err| format!("启动失败: {err}"))?;
    let pid = child.id().unwrap_or(0);
    let base = std::time::Instant::now();
    let logs = Arc::new(Mutex::new(Vec::new()));
    // 接管管道：stdout 不进日志缓冲（一堆 JSON-RPC 刷屏没有可读性，stderr 才是排障入口）。
    // attach 时 child 传 None —— 进程句柄留在下面的 Running 里，kill / 退出监控只有一处做。
    let stdio_session = if stdio_link {
        match (child.stdin.take(), child.stdout.take()) {
            (Some(stdin), Some(stdout)) => Some(crate::mcp::stdio_session::attach(
                mcp_id(id),
                None,
                stdin,
                stdout,
            )),
            _ => {
                child.start_kill().ok();
                return Err("无法接管子进程的标准输入/输出".into());
            }
        }
    } else {
        None
    };
    let running = Arc::new(Running {
        pid,
        child: Mutex::new(Some(child)),
        logs: logs.clone(),
        started_at: base,
        stopping: AtomicBool::new(false),
    });
    reg().lock().unwrap().insert(id.to_string(), running.clone());
    // 日志读取：stdout / stderr 两路并发进同一缓冲（缓冲上限按设置 svc_log_lines）
    let cap = t.log_lines as usize;
    if let Some(out) = running.child.lock().unwrap().as_mut().and_then(|c| c.stdout.take()) {
        let l2 = logs.clone();
        crate::task::spawn(async move { pipe_logs(out, "out", l2, base, cap).await });
    }
    if let Some(err) = running.child.lock().unwrap().as_mut().and_then(|c| c.stderr.take()) {
        let l3 = logs.clone();
        crate::task::spawn(async move { pipe_logs(err, "err", l3, base, cap).await });
    }
    // 插件托管的进程（id 前缀 plugin:）由插件清单声明，审计与事件按插件口径记，
    // 避免用户在联动流水里看到"WorkWith 启动了一个他没建过的条目"
    let is_plugin = id.starts_with("plugin:");
    ctx.emit(
        if is_plugin { "plugin-server" } else { "workwith" },
        json!({ "phase": "started", "id": id, "name": e.name, "pid": pid, "port": e.port }),
    );
    crate::audit::record(
        ctx,
        "local-app",
        if is_plugin { "plugin.server.start" } else { "workwith.start" },
        &e.name,
        json!({ "pid": pid, "port": e.port }),
        true,
    );
    // 起来就清异常：上一次崩溃留在页眉的登记要跟着退掉，用户重启后才看得见好转。
    // 真起不来（秒退）下面的退出监控会立刻重新登记，所以这里不必等端口就绪。
    if let Some(pid) = health_owner(e) {
        crate::plugins::mark_healthy(ctx, &pid);
    }
    if let Some(sess) = stdio_session {
        let c2 = ctx.clone();
        let e2 = e.clone();
        crate::task::spawn(async move { link_stdio(&c2, &e2, prog, args, sess).await });
    } else if e.port > 0 && mcp_link {
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
/// Unix 的礼貌终止：发 SIGTERM 让进程自己收尾（关 socket、删临时文件、带走自己的子进程）。
/// 不带 cfg 写，是为了在 Windows 上也参与编译——本机跑测试就能给这条路径做类型检查
#[allow(dead_code)]
fn terminate_gently(pid: u32) -> std::io::Result<()> {
    std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map(|_| ())
}

pub async fn stop(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<serde_json::Value, String> {
    let running = reg()
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or("未在运行")?;
    running.stopping.store(true, Ordering::Relaxed);
    // 先给一次礼貌退出的机会：Unix 上 start_kill 就是 SIGKILL，进程没有收尾窗口
    // （socket / 临时文件 / 子进程一堆留档），那样设置里的「停止宽限」只是等收尸。
    // Windows 的 TerminateProcess 没有对应的"优雅档"（taskkill 不带 /F 会弹对话框），
    // 所以维持直接终止，宽限仍然用来等退出监控把状态收干净。
    // 用 cfg! 而不是 #[cfg]：两条分支在每个平台都参与编译，本机跑测试就能给 Unix 路径做类型检查
    if cfg!(unix) {
        let _ = terminate_gently(running.pid);
    } else {
        let mut g = running.child.lock().unwrap();
        if let Some(ch) = g.as_mut() {
            ch.start_kill().ok();
        }
    }
    // 等退出监控完成清理（上限来自设置 svc_stop_grace_secs），保证返回时状态已一致
    let ticks = tuning(ctx).stop_grace_secs as u64 * 10;
    for _ in 0..ticks {
        if !reg().lock().unwrap().contains_key(id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    // 宽限到点仍赖着：硬杀（无视 SIGTERM 的进程不能停在"半停"状态）
    if reg().lock().unwrap().contains_key(id) {
        let mut g = running.child.lock().unwrap();
        if let Some(ch) = g.as_mut() {
            ch.start_kill().ok();
        }
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

/// AI 技能入口（builtin.workwith 工具的实现体）：条目增删查改 + 服务启停 + 日志。
/// 插件清单自动创建的条目（plugin: 前缀）对 AI 只读——它们的期望状态由插件自己的
/// 开关决定，AI 删掉或改配置会直接破坏插件运行态，且重启后又被清单重建，只会造成困惑。
pub async fn ai_call(
    ctx: &Arc<crate::state::Ctx>,
    action: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let need_id = |want: &str| -> Result<String, String> {
        params
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("Missing parameter: id (get it from action=\"{want}\")"))
    };
    // 查询类动作要坐实条目真的存在：id 打错时「未运行」是个会骗人的答案，
    // AI 会因此反复 start 一个根本不存在的条目
    let known_id = |want: &str| -> Result<String, String> {
        let id = need_id(want)?;
        if load_entries(ctx).iter().any(|e| e.id == id) {
            Ok(id)
        } else {
            Err(format!("条目不存在: {id}（先用 action=\"list\" 取真实 id）"))
        }
    };
    match action {
        "list" => Ok(list(ctx)),
        "status" => {
            let id = known_id("list")?;
            let (running, pid, uptime_ms) = match status_of(&id) {
                Some((pid, uptime_ms)) => (true, pid, uptime_ms),
                None => (false, 0, 0),
            };
            Ok(json!({
                "id": id,
                "running": running,
                "pid": pid,
                "uptime_ms": uptime_ms,
                "mcp_server_id": mcp_id(&id),
            }))
        }
        "logs" => {
            let id = known_id("list")?;
            // 默认尾部 100 行：全量日志动辄上千行，会把上下文挤爆
            let tail = params.get("tail").and_then(|v| v.as_u64()).map(|n| n as usize).unwrap_or(100);
            Ok(logs_of(&id, Some(tail)))
        }
        "save" => {
            let entry = params
                .get("entry")
                .cloned()
                .filter(|v| v.is_object())
                .ok_or("Missing parameter: entry (an object with name + program)")?;
            if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                guard_plugin_entry(id)?;
            }
            save(ctx, entry)
        }
        "start" => {
            let id = need_id("list")?;
            guard_plugin_entry(&id)?;
            start(ctx, &id).await
        }
        "stop" => {
            let id = need_id("list")?;
            guard_plugin_entry(&id)?;
            stop(ctx, &id).await
        }
        "remove" => {
            let id = need_id("list")?;
            guard_plugin_entry(&id)?;
            remove(ctx, &id).await
        }
        other => Err(format!("unknown action: {other} (use list/status/logs/save/start/stop/remove)")),
    }
}

/// 插件托管条目不允许 AI 改动（见 ai_call 说明）
fn guard_plugin_entry(id: &str) -> Result<(), String> {
    if id.starts_with("plugin:") {
        return Err("该条目由插件清单托管（plugin: 前缀），请在插件页管理，WorkWith 工具不改动它".into());
    }
    Ok(())
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

    /// 生命周期口径：配置缺省即 Tuning::default，越界值读出来必须被钳回区间
    #[test]
    fn tuning_defaults_and_clamps() {
        assert_eq!(Tuning::default(), Tuning {
            start_delay_ms: 300, ready_secs: DEFAULT_READY_SECS as u32,
            retries: 2, stop_grace_secs: 5, log_lines: DEFAULT_LOG_LINES as u32,
        });
        let r = TUNING_RANGE;
        // 每个字段各摆一个「太小」和一个「太大」，两头都得落回区间端点
        let hi = Tuning {
            start_delay_ms: r[0].2 + 99_000, ready_secs: r[1].2 + 9,
            retries: r[2].2 + 7, stop_grace_secs: r[3].2 + 3, log_lines: r[4].2 + 99_000,
        }
        .clamp();
        assert_eq!(hi, Tuning {
            start_delay_ms: r[0].2, ready_secs: r[1].2,
            retries: r[2].2, stop_grace_secs: r[3].2, log_lines: r[4].2,
        });
        let lo = Tuning {
            start_delay_ms: 0, ready_secs: 1, retries: 0, stop_grace_secs: 0, log_lines: 1,
        }
        .clamp();
        assert_eq!(
            lo,
            Tuning {
                start_delay_ms: r[0].1, ready_secs: r[1].1,
                retries: r[2].1, stop_grace_secs: r[3].1, log_lines: r[4].1,
            }
        );
        // retries=0 是「关掉重试」的合法表达，不能被钳成 1
        assert_eq!(lo.retries, 0);
    }

    /// 从配置读取：读的是 svc_* 五个字段，钳制后交给调用方
    #[test]
    fn tuning_reads_config_fields() {
        let dir = test_dir("tuning");
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: dir,
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        });
        assert_eq!(tuning(&ctx), Tuning::default());
        {
            let mut cfg = ctx.config.lock().unwrap();
            cfg.svc_start_delay_ms = 1200;
            cfg.svc_ready_secs = 90;
            cfg.svc_retries = 4;
            cfg.svc_stop_grace_secs = 20;
            cfg.svc_log_lines = 500;
        }
        assert_eq!(
            tuning(&ctx),
            Tuning { start_delay_ms: 1200, ready_secs: 90, retries: 4, stop_grace_secs: 20, log_lines: 500 }
        );
        // 老配置里的荒谬数字（0 秒就绪 / 200 万行日志）到不了探测器手里
        {
            let mut cfg = ctx.config.lock().unwrap();
            cfg.svc_ready_secs = 0;
            cfg.svc_log_lines = 2_000_000;
        }
        let t = tuning(&ctx);
        assert_eq!((t.ready_secs, t.log_lines), (TUNING_RANGE[1].1, TUNING_RANGE[4].2));
    }

    /// 退避：以启动延时为基数翻倍，最多四档，封顶 15 秒
    #[test]
    fn retry_backoff_doubles_then_caps() {
        assert_eq!(retry_backoff_ms(300, 1), 300);
        assert_eq!(retry_backoff_ms(300, 2), 600);
        assert_eq!(retry_backoff_ms(300, 3), 1200);
        assert_eq!(retry_backoff_ms(300, 4), 2400);
        // 第 5 次不再继续翻倍：因子停在 8
        assert_eq!(retry_backoff_ms(300, 5), 2400);
        assert_eq!(retry_backoff_ms(300, 99), 2400);
        // 封顶：10s × 8 也不能把退避变成分钟级
        assert_eq!(retry_backoff_ms(10_000, 4), 15_000);
        // 启动延时设成 0 也要留出至少 200ms 的刹车
        assert_eq!(retry_backoff_ms(0, 1), 200);
    }

    /// 连续失败计数：站稳/手动启动清零，之后重新拿满预算
    #[test]
    fn attempt_counter_resets_on_steady() {
        let id = "tuning-attempt-counter";
        note_steady(id);
        assert_eq!(bump_attempt(id), 1);
        assert_eq!(bump_attempt(id), 2);
        note_steady(id);
        assert_eq!(bump_attempt(id), 1);
        note_steady(id);
        // 别的条目不受影响（计数按 id 分账）
        let other = "tuning-attempt-other";
        assert_eq!(bump_attempt(other), 1);
        note_steady(other);
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
            cwd: String::new(), env: HashMap::new(), port: 0, mcp_mode: String::new(),
            auto_with_session: false, declared: false,
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
        // stdio 联动：模式落盘 + 端口不再参与判定
        let stdio = json!({ "id": id, "name": "bridge", "program": "node.exe", "mcp_mode": "stdio" });
        save(&ctx, stdio).unwrap();
        let e = load_entries(&ctx).remove(0);
        assert!(e.is_stdio_mcp() && e.wants_mcp());
        // 拼错的联动方式直接拒绝
        assert!(save(&ctx, json!({ "name": "x", "program": "a.exe", "mcp_mode": "sdtio" })).is_err());
        // 自带新 id 也算新增（固定 id 的内置条目靠这一点幂等迁移），且不会多出一条
        save(&ctx, json!({ "id": "dsh-bridge", "name": "桥", "program": "node.exe", "mcp_mode": "stdio" })).unwrap();
        save(&ctx, json!({ "id": "dsh-bridge", "name": "桥2", "program": "node.exe", "mcp_mode": "stdio" })).unwrap();
        let entries = load_entries(&ctx);
        assert_eq!(entries.iter().filter(|e| e.id == "dsh-bridge").count(), 1);
        assert_eq!(entries.iter().find(|e| e.id == "dsh-bridge").unwrap().name, "桥2");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// ww- 前缀是 WorkWith 与 mcp.rs 之间的唯一约定：反解必须和 mcp_id 对齐，
    /// 否则 ensure_stdio 的托管守卫会漏判，MCP 层就可能自己重拉第二个进程
    #[test]
    fn mcp_id_roundtrips_through_entry_guard() {
        assert_eq!(entry_id_of_mcp(&mcp_id("dsh-bridge")), Some("dsh-bridge"));
        assert_eq!(entry_id_of_mcp("mcp-9f3a"), None); // MCP 页自建的手动条目
    }

    /// wants_mcp：stdio 必然联动；http 只在有端口时联动
    #[test]
    fn wants_mcp_per_mode() {
        let base = WorkWithEntry {
            id: "x".into(), name: "x".into(), runtime_id: "custom".into(),
            program: "a.exe".into(), args: vec![], cwd: String::new(),
            env: HashMap::new(), port: 0, mcp_mode: String::new(), auto_with_session: false,
            declared: false,
        };
        assert!(!base.wants_mcp());
        assert!(WorkWithEntry { port: 3000, ..base.clone() }.wants_mcp());
        assert!(WorkWithEntry { mcp_mode: MCP_MODE_STDIO.into(), ..base.clone() }.wants_mcp());
    }

    /// AI 技能：非法 action 报错；插件条目拒绝改动；缺 id 给出取数指引
    #[test]
    fn ai_call_validates_arguments() {
        let dir = test_dir("ai");
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
        assert!(tokio_block(ai_call(&ctx, "launch", &json!({}))).is_err());
        assert!(tokio_block(ai_call(&ctx, "start", &json!({}))).is_err());
        assert!(tokio_block(ai_call(&ctx, "remove", &json!({ "id": "plugin:foo" }))).is_err());
        assert!(tokio_block(ai_call(&ctx, "save", &json!({ "entry": { "name": "n" } }))).is_err());
        // list 对插件条目只读放行
        assert!(tokio_block(ai_call(&ctx, "list", &json!({}))).unwrap()["entries"].is_array());
        // 查询动作坐实 id：打错的 id 报「未运行」会把 AI 引到反复 start
        let out = save(&ctx, json!({ "name": "q", "program": "q.exe" })).unwrap();
        let qid = out["entry"]["id"].as_str().unwrap().to_string();
        let st = tokio_block(ai_call(&ctx, "status", &json!({ "id": qid.clone() }))).unwrap();
        assert_eq!(st["running"], json!(false));
        assert!(tokio_block(ai_call(&ctx, "logs", &json!({ "id": qid }))).is_ok());
        for act in ["status", "logs"] {
            let err = tokio_block(ai_call(&ctx, act, &json!({ "id": "no-such-entry" }))).unwrap_err();
            assert!(err.contains("条目不存在"), "{act}: {err}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 同步测试里跑 async：ai_call 内部只做纯状态判断的分支不会真正 await，
    /// 用 current-thread runtime 足够（不引 tokio::test 是为了跟本模块其余 #[test] 保持一致）
    fn tokio_block<T: Send + 'static>(fut: impl std::future::Future<Output = T> + Send) -> T {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(fut)
    }
}
