// yxpil · BIT
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use crate::ai::AiConfig;
use crate::audit::AuditEntry;

/// 工具质量评估模块（挂在 state 下声明，避免 main.rs 被外部同步回退时丢 mod 声明）
#[path = "toolstats.rs"]
pub mod toolstats;

/// 设备指纹与设备凭证（账号凭证 + 信道签名材料）
#[path = "device.rs"]
pub mod device;
use crate::goal::{Goal, Todo};
use crate::memory::{Memory, Skill};
use crate::registry::ToolDef;
use crate::runtime::Runtime;
use crate::session::SessionStore;

/// 会话累计的 token 用量与缓存命中统计（内存态，重启清零）
#[derive(Default, Clone, Debug, Serialize)]
pub struct CacheStats {
    pub requests: u64,
    pub prompt_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub completion_tokens: u64,
    /// 上游返回过缓存统计字段的请求数（0 = 本会话命中率不可知，UI 显示「未知」）
    pub cache_known_requests: u64,
}

impl CacheStats {
    /// 提示词缓存命中率 = 命中缓存的输入 token / 总输入 token（0.0 ~ 1.0）。
    /// 仅当上游确实上报过缓存字段时才有意义（cache_known_requests > 0）
    pub fn hit_rate(&self) -> f64 {
        if self.prompt_tokens == 0 {
            0.0
        } else {
            self.cache_read_tokens as f64 / self.prompt_tokens as f64
        }
    }
}

/// 把单次请求用量累计进会话统计，返回累计值。
/// 端点未返回用量（全 0）时不计入，避免拉低命中率可信度
pub fn record_usage(ctx: &Arc<Ctx>, session: &str, usage: &crate::ai::TokenUsage) -> CacheStats {
    if usage.prompt_tokens == 0 && usage.completion_tokens == 0 {
        let map = ctx.cache_stats.lock().unwrap();
        if let Some(s) = map.get(session) {
            return s.clone();
        }
        return CacheStats::default();
    }
    let mut map = ctx.cache_stats.lock().unwrap();
    let e = map.entry(session.to_string()).or_default();
    e.requests += 1;
    e.prompt_tokens += usage.prompt_tokens;
    e.cache_read_tokens += usage.cache_read_tokens;
    e.cache_write_tokens += usage.cache_write_tokens;
    e.completion_tokens += usage.completion_tokens;
    if usage.cache_known {
        e.cache_known_requests += 1;
    }
    e.clone()
}

/// 宿主注入的启动参数：数据目录 / 事件出口 / 宿主钩子 / 版本号 / 子进程与主程序路径。
/// Tauri GUI、bit-cli（TUI/worker/guardian）、Electron napi 三种宿主各自构造
pub struct LoadOpts {
    pub data_dir: PathBuf,
    pub emitter: Arc<dyn crate::emitter::UiEmitter>,
    pub host: Arc<dyn crate::emitter::HostHooks>,
    pub app_version: String,
    pub worker_exe: Option<PathBuf>,
    pub app_exe: Option<PathBuf>,
    /// 宿主主程序启动参数（guardian 复活时原样透传）：Electron 形态传 [main.cjs]，
    /// 否则裸拉 electron.exe 只会打开默认欢迎页而非本应用
    #[allow(dead_code)]
    pub app_args: Vec<String>,
}

pub struct Ctx {
    /// UI 事件出口（Tauri webview / worker 转发 / TUI 无输出），经 emit() 统一走 emitter.rs
    pub emitter: Arc<dyn crate::emitter::UiEmitter>,
    /// 宿主能力钩子：托盘 / 热键 / 退出（只有桌面壳实现，核心逻辑不感知框架）
    pub host: Arc<dyn crate::emitter::HostHooks>,
    /// 应用版本号（宿主注入；替代 package_info()，napi/CLI 侧同样可给）
    pub app_version: String,
    /// worker 子进程可执行文件：None = current_exe()（单二进制形态）；Electron 形态指向 bit-cli sidecar
    pub worker_exe: Option<PathBuf>,
    /// 宿主主程序路径（guardian 布防校验对象）；None = current_exe()
    pub app_exe: Option<PathBuf>,
    /// 宿主主程序启动参数（guardian 复活透传；Electron = [main.cjs]，单二进制形态为空）
    pub app_args: Vec<String>,
    pub data_dir: PathBuf,
    pub config: Mutex<crate::config::Config>,
    pub ai_config: Mutex<AiConfig>,
    pub tools: Mutex<Vec<ToolDef>>,
    pub runtimes: Mutex<Vec<Runtime>>,
    pub audit: Mutex<Vec<AuditEntry>>,
    pub memories: Mutex<Vec<Memory>>,
    pub skills: Mutex<Vec<Skill>>,
    pub goals: Mutex<Vec<Goal>>,
    pub todos: Mutex<Vec<Todo>>,
    pub sessions: Mutex<SessionStore>,
    /// bit.db 变更计数：判断库是否被其他进程（worker / bit 命令行）改过（见 store.rs）
    pub sessions_rev: Mutex<u64>,
    /// 全量数据存储：bit.db（SQLite，WAL 多进程共享；文档/会话统一入库，见 store.rs）
    pub db: Mutex<rusqlite::Connection>,
    /// 已接入的 MCP 服务器（Streamable HTTP + stdio）
    pub mcp: Mutex<Vec<crate::mcp::McpServer>>,
    /// stdio MCP 子进程注册表：server_id → StdioSession。进程存活期间持有；重启需重连
    pub mcp_stdio: crate::mcp::McpProcessRegistry,
    /// HiddenCode 敏感信息条目（hidden_codes.json，设备密钥加密存储）
    pub hidden_codes: Mutex<Vec<crate::hidden_code::HiddenCodeEntry>>,
    /// 本地插件列表（toolhomes/plugins/*/plugin.json）
    pub plugins: Mutex<Vec<crate::plugins::Plugin>>,
    /// BIT 作为 MCP 服务器时分配的会话（session_id → 最后活跃时刻）。
    /// 内存态：进程重启即失效，客户端需重新 initialize
    pub mcp_sessions: Mutex<HashMap<String, std::time::Instant>>,
    /// 小圆片播放/暂停状态（true = 播放，自动总结进行中）
    pub autopilot_running: AtomicBool,
    /// 会话中断标志（session_id → flag），chat_interrupt 置位后执行循环在检查点停止
    pub interrupts: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 同会话回合互斥：同一会话同时只允许一个对话回合在跑，防止并发回合交错写会话历史
    pub turn_locks: Mutex<HashMap<String, ()>>,
    /// 提示词缓存命中率统计（session_id → 累计用量）。内存态，重启清零
    pub cache_stats: Mutex<HashMap<String, CacheStats>>,
    /// 待审批工具调用（request_id → 应答通道 + 元信息，供审批列表接口展示）
    pub approvals: Mutex<HashMap<String, PendingApproval>>,
    /// 审批请求自增 id
    pub approval_seq: AtomicU64,
    /// ask_user 待应答提问（ask_id → 应答通道）。模型主动向用户提问（选项 + 补充）的挂起表
    pub asks: Mutex<HashMap<String, PendingAsk>>,
    /// 提问自增 id
    pub ask_seq: AtomicU64,
    pub server_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 云中继客户端循环句柄（随远程服务启停）
    pub relay_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 远程端口被占用自动切换时的原端口（内存态；正常绑定即清空，前端启动时查询展示提示）
    pub port_switch: Mutex<Option<u16>>,
    /// 目标自动推进计数（goal_id → 已自动续跑轮数，防空转；目标完成后残留条目无害）
    pub auto_drive_counts: Mutex<HashMap<String, u32>>,
    /// 远程对话限速：客户端标识（IP）→ 最近请求时刻滑动窗口。内存态，重启清零
    pub chat_rate: Mutex<HashMap<String, std::collections::VecDeque<std::time::Instant>>>,
    /// 每 IP 并发在途对话请求计数（IP → 计数）。防单 IP 洪泛占满对话通道；请求结束即递减
    pub active_per_ip: Mutex<HashMap<String, u32>>,
    /// bitsign 验签的 nonce 重放缓存（信道防护：同一签名 nonce 只允许用一次）
    pub nonce_seen: Mutex<crate::security::NonceCache>,
    /// 工具质量统计：tool_id → 成功率等（内存态 + tool_stats.json 落盘）
    pub tool_stats: Mutex<toolstats::Store>,
    /// 工作区沙箱根（运行时）：TUI 启动时默认锚定进程 cwd；None = 不限制（桌面端默认）。
    /// config.workspace_root 可显式指定；shell 未传 cwd 时以此兜底，文件工具路径禁止逃逸
    pub workspace_root: Mutex<Option<PathBuf>>,
    /// 进程启动时刻（诊断报告的运行时长）
    pub started: std::time::Instant,
}

pub const AUDIT_MAX: usize = 2000;
pub const CHAT_MAX: usize = 200;

/// 默认数据目录（与 Tauri app_data_dir 同一路径规则，identifier 固定 com.bit.hub）：
/// - Windows：{%APPDATA%}/com.bit.hub
/// - macOS：~/Library/Application Support/com.bit.hub
/// - Linux：{$XDG_DATA_HOME|~/.local/share}/com.bit.hub
/// bit-cli / Electron(napi setPath userData) 与 Tauri 版共用同一份数据，无感迁移
pub fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(|d| PathBuf::from(d).join("com.bit.hub"))
            .unwrap_or_else(|| PathBuf::from(".").join("bit-data"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library").join("Application Support").join("com.bit.hub"))
            .unwrap_or_else(|| PathBuf::from(".").join("bit-data"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("com.bit.hub")
    }
    #[cfg(not(any(windows, unix)))]
    {
        PathBuf::from(".").join("bit-data")
    }
}

/// 一条待审批的工具调用：应答通道 + 展示用元信息（工具名 / 参数 / 发起时刻）
pub struct PendingApproval {
    pub tx: tokio::sync::oneshot::Sender<bool>,
    pub tool: String,
    pub params: serde_json::Value,
    pub created: std::time::Instant,
}

/// ask_user 的一条待应答提问：应答通道 + 会话归属（中断联动清理用）
pub struct PendingAsk {
    pub tx: tokio::sync::oneshot::Sender<serde_json::Value>,
    pub session: String,
    pub created: std::time::Instant,
}

impl Ctx {
    /// 图片缓存目录（数据目录下 images/）：模型生成图片 / 工具产图的统一落盘位置，
    /// 系统提示词会把该路径告知模型作为工作区
    pub fn image_dir(&self) -> PathBuf {
        let d = self.data_dir.join("images");
        fs::create_dir_all(&d).ok();
        d
    }

    /// UI 事件统一出口：所有 ctx.app.emit / emit_ui 调用点的唯一替代。
    /// 持有 Ctx 其他锁时不要调用（emitter 可能跨线程唤醒）；先 drop 锁再 emit
    pub fn emit(&self, name: &str, payload: serde_json::Value) {
        self.emitter.emit(name, payload);
    }

    /// worker 子进程可执行文件解析：显式注入优先，否则当前进程自身（单二进制形态）
    pub fn worker_program(&self) -> PathBuf {
        self.worker_exe
            .clone()
            .unwrap_or_else(|| std::env::current_exe().expect("current_exe"))
    }

    /// 宿主主程序路径解析（guardian 布防校验对象）
    pub fn host_program(&self) -> PathBuf {
        self.app_exe
            .clone()
            .unwrap_or_else(|| std::env::current_exe().expect("current_exe"))
    }

    pub fn load(opts: LoadOpts) -> Arc<Ctx> {
        // BIT_DATA_DIR：测试/E2E 用的数据目录覆盖（隔离环境验证默认配置），未设置走宿主注入目录
        let data_dir = match std::env::var("BIT_DATA_DIR") {
            Ok(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir),
            _ => opts.data_dir,
        };
        fs::create_dir_all(&data_dir).ok();

        // 全量数据存储：先开 bit.db，再由 Config::load 处理引导锚点与配置迁移
        let mut db = crate::store::open(&data_dir);
        let config = crate::config::Config::load(&data_dir, &db);
        let device_key = config.device_key.clone();
        // 一次性导入遗留 JSON 文件（幂等；导入后原文件改名 .migrated 留档）
        crate::store::import_legacy(&db, &data_dir, device_key.as_deref());

        let ai_config: AiConfig = crate::store::get_secret_json(&db, "ai_config", device_key.as_deref())
            .unwrap_or_default();
        let tools: Vec<ToolDef> =
            crate::store::get_json(&db, "tools").unwrap_or_default();
        let audit: Vec<AuditEntry> = crate::audit::db_entries(&db);
        let mut memories: Vec<Memory> =
            crate::store::get_json(&db, "memories").unwrap_or_default();
        let mut skills: Vec<Skill> = crate::store::get_json(&db, "skills").unwrap_or_default();
        // goals/todos 已行级化：从独立表加载（import_legacy 已把旧 blob/文件迁入）
        let mut goals: Vec<Goal> = crate::goal::db_goals(&db);
        let mut todos: Vec<Todo> = crate::goal::db_todos(&db);
        // 一次性迁移：旧 32 位 hex uuid id → 短数字 id（幂等，已是数字则保持）；
        // todo.goal_id 引用同步重映射。提示词/面板可读性（对比 4dca90f7… → 3）
        {
            let mut gmap: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            for (i, g) in goals.iter_mut().enumerate() {
                let new = (i + 1).to_string();
                if g.id != new {
                    gmap.insert(g.id.clone(), new.clone());
                    g.id = new;
                }
            }
            for (i, t) in todos.iter_mut().enumerate() {
                if let Some(gid) = t.goal_id.as_ref() {
                    if let Some(n) = gmap.get(gid) {
                        t.goal_id = Some(n.clone());
                    }
                }
                t.id = (i + 1).to_string();
            }
            for (i, m) in memories.iter_mut().enumerate() {
                m.id = (i + 1).to_string();
            }
            for (i, s) in skills.iter_mut().enumerate() {
                s.id = (i + 1).to_string();
            }
            crate::store::put_json(&db, "memories", &memories);
            crate::store::put_json(&db, "skills", &skills);
            // goals/todos 重映射后全量同步回行级表
            crate::goal::sync_rows(&mut db, &goals, &todos);
        }
        let sessions = SessionStore::load(&data_dir, &db);
        let mcp: Vec<crate::mcp::McpServer> =
            crate::store::get_secret_json(&db, "mcp_servers", device_key.as_deref())
                .unwrap_or_default();
        let hidden_codes: Vec<crate::hidden_code::HiddenCodeEntry> =
            crate::store::get_secret_json(&db, "hidden_codes", device_key.as_deref())
                .unwrap_or_default();

        // 内置工具随版本演进：始终以当前出厂的内置工具为准，
        // 移除历史遗留的内置项，保留用户 / AI 自建的工具，再把最新内置放到最前。
        let tools = {
            let builtin = crate::registry::builtin_tools();
            let builtin_names: std::collections::HashSet<String> =
                builtin.iter().map(|t| t.name.clone()).collect();
            let mut custom: Vec<ToolDef> = tools
                .into_iter()
                .filter(|t| {
                    !matches!(t.kind, crate::registry::ToolKind::Builtin { .. })
                        && !builtin_names.contains(&t.name)
                })
                .collect();
            let mut merged = builtin;
            merged.append(&mut custom);
            crate::store::put_json(&db, "tools", &merged);
            merged
        };

        // 解释器列表：每次启动都重新探测本机（自动发现新装的语言），
        // 同时沿用旧列表里的启用状态，并保留用户手动添加的项。
        let cached: Vec<Runtime> =
            crate::store::get_json(&db, "runtimes").unwrap_or_default();
        // 解释器列表：启动时直接用缓存（探测在后台进行，不阻塞窗口显示），
        // 后台 refresh_runtimes() 完成后更新状态并通知前端
        let runtimes: Vec<Runtime> = cached;
        let tool_stats: toolstats::Store =
            crate::store::get_json(&db, "tool_stats").unwrap_or_default();
        let sessions_rev = crate::store::sessions_rev(&db);

        Arc::new(Ctx {
            emitter: opts.emitter,
            host: opts.host,
            app_version: opts.app_version,
            worker_exe: opts.worker_exe,
            app_exe: opts.app_exe,
            app_args: opts.app_args,
            data_dir,
            config: Mutex::new(config),
            ai_config: Mutex::new(ai_config),
            tools: Mutex::new(tools),
            runtimes: Mutex::new(runtimes),
            audit: Mutex::new(audit),
            memories: Mutex::new(memories),
            skills: Mutex::new(skills),
            goals: Mutex::new(goals),
            todos: Mutex::new(todos),
            sessions: Mutex::new(sessions),
            sessions_rev: Mutex::new(sessions_rev),
            db: Mutex::new(db),
            mcp: Mutex::new(mcp),
            hidden_codes: Mutex::new(hidden_codes),
            mcp_stdio: std::sync::Mutex::new(std::collections::HashMap::new()),
            // 本地插件列表（toolhomes/plugins/*/plugin.json，启动/重扫时刷新）
            plugins: Mutex::new(Vec::new()),
            mcp_sessions: Mutex::new(HashMap::new()),
            interrupts: Mutex::new(HashMap::new()),
            turn_locks: Mutex::new(HashMap::new()),
            cache_stats: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            approval_seq: AtomicU64::new(1),
            asks: Mutex::new(HashMap::new()),
            ask_seq: AtomicU64::new(1),
            autopilot_running: AtomicBool::new(false),
            server_task: Mutex::new(None),
            relay_task: Mutex::new(None),
            port_switch: Mutex::new(None),
            auto_drive_counts: Mutex::new(HashMap::new()),
            chat_rate: Mutex::new(HashMap::new()),
            active_per_ip: Mutex::new(HashMap::new()),
            nonce_seen: Mutex::new(crate::security::NonceCache::new(
                std::time::Duration::from_secs(crate::security::BITSIGN_TS_WINDOW as u64),
                8192,
            )),
            tool_stats: Mutex::new(tool_stats),
            workspace_root: Mutex::new(None),
            started: std::time::Instant::now(),
        })
    }

    pub fn save_config(&self) {
        let cfg = self.config.lock().unwrap();
        let db = self.db.lock().unwrap();
        cfg.save(&self.data_dir, &db);
    }

    // ---- store 快捷封装：文档读写 / 敏感文档双层加密读写 ----
    // 锁序纪律：config → db（save_* 系列先锁业务 Mutex 再锁 db，均不反向）

    pub fn db_put_json<T: serde::Serialize>(&self, name: &str, val: &T) {
        crate::store::put_json(&self.db.lock().unwrap(), name, val);
    }

    pub fn db_get_json<T: serde::de::DeserializeOwned>(&self, name: &str) -> Option<T> {
        crate::store::get_json(&self.db.lock().unwrap(), name)
    }

    /// 敏感文档：device_key（config 锁）→ 双层加密（BITENC1 + DPAPI）入库
    pub fn db_put_secret<T: serde::Serialize>(&self, name: &str, val: &T) {
        let key = self.config.lock().unwrap().device_key.clone();
        crate::store::put_secret_json(&self.db.lock().unwrap(), name, key.as_deref().unwrap_or(""), val);
    }

    pub fn db_get_secret<T: serde::de::DeserializeOwned>(&self, name: &str) -> Option<T> {
        let key = self.config.lock().unwrap().device_key.clone();
        crate::store::get_secret_json(&self.db.lock().unwrap(), name, key.as_deref())
    }

    /// 后台重新探测本机解释器（保留启用状态与手动添加项）。
    /// 返回列表是否发生变化（由调用方决定是否通知前端）。
    pub fn refresh_runtimes(&self) -> bool {
        let cached: Vec<Runtime> =
            crate::store::get_json(&self.db.lock().unwrap(), "runtimes").unwrap_or_default();
        let prev_enabled: std::collections::HashMap<String, bool> =
            cached.iter().map(|r| (r.id.clone(), r.enabled)).collect();
        let manual: Vec<Runtime> = cached.iter().filter(|r| r.manual).cloned().collect();
        let mut runtimes = crate::runtime::detect();
        for r in runtimes.iter_mut() {
            if let Some(&en) = prev_enabled.get(&r.id) {
                r.enabled = en;
            }
        }
        for m in manual {
            if !runtimes.iter().any(|r| r.id == m.id) {
                runtimes.push(m);
            }
        }
        let changed = serde_json::to_string(&runtimes).unwrap()
            != serde_json::to_string(&cached).unwrap();
        crate::store::put_json(&self.db.lock().unwrap(), "runtimes", &runtimes);
        *self.runtimes.lock().unwrap() = runtimes;
        changed
    }

    pub fn save_ai_config(&self) {
        // 锁序：config（取 key 即放）→ ai_config → db，避免反序死锁
        let cfg = self.ai_config.lock().unwrap();
        self.db_put_secret("ai_config", &*cfg);
        drop(cfg);
        // 必须通知 worker 重读：worker 的 ai_config 是启动时一次性加载的，
        // 漏通知会导致"设置里换了 provider，worker 还打旧端点"→ 旧端点限流/欠费时
        // 每条消息先冒 429 失败气泡（worker 报错 → engine 回退 host 用新配置重跑成功）
        crate::worker::notify_reload();
    }

    pub fn save_tools(&self) {
        let tools = self.tools.lock().unwrap();
        self.db_put_json("tools", &*tools);
        drop(tools);
        // 热加载：通知前端工具清单已变化（AI 注册/更新/删除/启停工具后页面即时刷新）
        self.emit("tools-updated", serde_json::json!({}));
        // worker 模式下宿主保存工具后同步通知 worker 重读磁盘
        crate::worker::notify_reload();
    }

    pub fn save_runtimes(&self) {
        let runtimes = self.runtimes.lock().unwrap();
        self.db_put_json("runtimes", &*runtimes);
    }

    pub fn save_sessions(&self) {
        let store = self.sessions.lock().unwrap();
        crate::store::sync_sessions(&self.db.lock().unwrap(), &store.sessions, &store.active);
        drop(store);
        self.refresh_sessions_rev();
    }

    /// 从 bit.db 读最新变更计数（合并守卫用）
    pub fn refresh_sessions_rev(&self) {
        *self.sessions_rev.lock().unwrap() =
            crate::store::sessions_rev(&self.db.lock().unwrap());
    }

    pub fn save_mcp(&self) {
        let mcp = self.mcp.lock().unwrap();
        self.db_put_secret("mcp_servers", &*mcp);
    }

    /// HiddenCode 条目入库（设备密钥 + DPAPI 双层加密）。锁顺序同 save_mcp。
    pub fn save_hidden_codes(&self) {
        let codes = self.hidden_codes.lock().unwrap();
        self.db_put_secret("hidden_codes", &*codes);
        drop(codes);
        // worker 进程同样一次性加载 hidden_codes，改条目后必须通知重读
        crate::worker::notify_reload();
    }
}

pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Option<T> {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

impl Serialize for Ctx {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("Ctx")
    }
}

#[cfg(test)]
mod read_json_tests {
    use super::*;

    /// 配置/数据文件缺失 → None（上层 unwrap_or_default 走默认值，不 panic）
    #[test]
    fn missing_file_is_none() {
        assert!(read_json::<serde_json::Value>(std::path::Path::new("/nonexistent/bit-x.json")).is_none());
    }

    /// 文件损坏（非法 JSON）→ None，同样不 panic
    #[test]
    fn malformed_json_is_none() {
        let dir = std::env::temp_dir().join("bit-readjson-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("broken.json");
        std::fs::write(&p, "{not valid json").unwrap();
        assert!(read_json::<serde_json::Value>(&p).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
