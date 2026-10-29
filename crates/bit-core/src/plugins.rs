// yxpil · BIT
// 本地插件系统：toolhomes/plugins/<插件目录>/plugin.json 声明式插件。
//
// plugin.json 语法（全部字段除 name 外可选）：
// {
//   "name": "我的插件",
//   "version": "0.1.0",
//   "description": "一句话说明",
//   "tools": [{
//     "name": "mouse_move", "description": "…",
//     "parameters": { "type": "object", "properties": { … } },
//     "kind": "interpreter",              // interpreter（本机解释器）| script（Rhai 沙盒）
//     "runtime": "py",                    // interpreter 必填：py/js/ps1/…
//     "code": "…源码…",                   // 内联源码（stdin 收 JSON params，stdout 出结果）
//     "file": "tool.py"                   // 或相对插件目录的源码文件（与 code 二选一，file 优先）
//   }],
//   "prompts": ["启用时追加到系统提示词的指令片段"],
//   "skills": [{ "name": "技能名", "summary": "技能说明" }],
//   "memories": ["作为记忆注入的内容"],
//   "jobs": [{
//     "name": "日报", "schedule": "every 1h | daily 09:00",
//     "runtime": "py", "code": "…", "file": "…",
//     "session": "可选：结果注入的会话 id（复用后台 shell 唤回链路）"
//   }]
// }
//
// 启用开关存 config.disabled_plugins（不在插件包里），重扫不丢用户选择。
// 工具经 ToolKind::Interpreter/Script 走既有执行链（自动继承 toolhomes 环境与超时配置）。
use serde::{Deserialize, Serialize};
use chrono::Timelike;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

/// 插件声明的工具
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema 参数描述；缺省为无参
    #[serde(default)]
    pub parameters: serde_json::Value,
    /// interpreter（本机解释器）| script（Rhai 沙盒），默认 interpreter
    #[serde(default = "default_tool_kind")]
    pub kind: String,
    /// interpreter 模式必填：运行时 id（py/js/ps1/…）
    #[serde(default)]
    pub runtime: String,
    /// 内联源码
    #[serde(default)]
    pub code: Option<String>,
    /// 相对插件目录的源码文件（优先于 code）
    #[serde(default)]
    pub file: Option<String>,
}

fn default_tool_kind() -> String {
    "interpreter".into()
}

/// 插件声明的技能（注入技能列表，与自动提炼技能同构）
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginSkill {
    pub name: String,
    #[serde(default)]
    pub summary: String,
}

/// 插件声明的定时任务
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginJob {
    pub name: String,
    /// "every 30m" / "every 2h" / "every 90s" / "daily 09:00"
    pub schedule: String,
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    /// 结果要注入的会话 id（空 = 只记审计日志）
    #[serde(default)]
    pub session: Option<String>,
}

/// 一个本地插件包（plugin.json）
#[derive(Serialize, Deserialize, Clone)]
pub struct Plugin {
    /// 插件 id = 目录名（sync 时强制用目录名覆盖，故 manifest 里可不写此字段；
    /// 不加 default 会让按文档格式编写的 plugin.json 解析失败、整个插件被静默跳过）
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tools: Vec<PluginTool>,
    #[serde(default)]
    pub prompts: Vec<String>,
    #[serde(default)]
    pub skills: Vec<PluginSkill>,
    #[serde(default)]
    pub memories: Vec<String>,
    #[serde(default)]
    pub jobs: Vec<PluginJob>,
    // ── 插件化加强（前后端统一插件包）──
    /// 权限声明（启用时向用户明示）：css=注入界面样式 js=执行界面脚本 invoke=调用后端命令
    #[serde(default)]
    pub permissions: Vec<String>,
    /// 前端 UI 能力：css/js 均为相对插件目录的文件路径列表（按序加载）
    #[serde(default)]
    pub ui: Option<PluginUi>,
}

/// 插件声明的界面能力（渲染进程侧加载）
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PluginUi {
    /// 样式文件（相对插件目录），注入 <style>
    #[serde(default)]
    pub css: Vec<String>,
    /// 界面脚本入口（相对插件目录，按序执行），拿到受限插件 API
    #[serde(default)]
    pub js: Vec<String>,
}

/// 允许声明的权限位（未知权限 = 清单校验失败，插件不加载）
const KNOWN_PERMS: &[&str] = &["css", "js", "invoke"];

pub fn dir(ctx: &Arc<crate::state::Ctx>) -> PathBuf {
    crate::toolenv::dir(ctx).join("plugins")
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
}

/// 解析工具源码：file 相对插件目录优先，回退内联 code
fn resolve_code(plugin_dir: &std::path::Path, file: &Option<String>, code: &Option<String>) -> Option<String> {
    if let Some(f) = file {
        let p = plugin_dir.join(f);
        if let Ok(s) = fs::read_to_string(&p) {
            return Some(s);
        }
    }
    code.clone().filter(|s| !s.trim().is_empty())
}

/// 相对路径包含性检查：拒绝绝对路径与 `..` 逃逸（ui/css/js 文件读取的统一闸门）
fn safe_rel(raw: &str) -> Result<(), String> {
    let p = std::path::Path::new(raw);
    if p.is_absolute() {
        return Err(format!("absolute path not allowed: {raw}"));
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("path escapes plugin dir: {raw}"));
    }
    Ok(())
}

/// 自我安全校验：清单 schema + 权限位 + 路径包含性。
/// 不合格的插件整体不加载（scan 阶段拦截，错误进 errs 列表展示给用户）。
fn validate(p: &Plugin, pdir: &std::path::Path) -> Result<(), String> {
    if p.name.trim().is_empty() {
        return Err("name is required".into());
    }
    for perm in &p.permissions {
        if !KNOWN_PERMS.contains(&perm.as_str()) {
            return Err(format!("unknown permission: {perm} (known: {})", KNOWN_PERMS.join(", ")));
        }
    }
    // ui 能力必须有对应权限位声明（有文件无声明 = 拒绝，防"看起来无害"的插件夹带脚本）
    if let Some(ui) = &p.ui {
        if !ui.css.is_empty() && !p.permissions.iter().any(|x| x == "css") {
            return Err("ui.css declared but missing permission \"css\"".into());
        }
        if !ui.js.is_empty() && !p.permissions.iter().any(|x| x == "js") {
            return Err("ui.js declared but missing permission \"js\"".into());
        }
        for f in ui.css.iter().chain(ui.js.iter()) {
            safe_rel(f)?;
            if !pdir.join(f).is_file() {
                return Err(format!("ui file not found: {f}"));
            }
        }
    }
    // interpreter 工具必须有运行时；工具源码文件同样过路径闸门
    for t in &p.tools {
        if t.kind != "script" && t.runtime.trim().is_empty() {
            return Err(format!("tool `{}`: interpreter kind requires runtime", t.name));
        }
        if let Some(f) = &t.file {
            safe_rel(f)?;
        }
    }
    for j in &p.jobs {
        if parse_schedule(&j.schedule).is_none() {
            return Err(format!("job `{}`: bad schedule `{}`", j.name, j.schedule));
        }
        if let Some(f) = &j.file {
            safe_rel(f)?;
        }
    }
    Ok(())
}

/// 扫描插件目录：读取全部 plugin.json（解析失败/校验不过的目录跳过并列出错误）
pub fn scan(ctx: &Arc<crate::state::Ctx>) -> (Vec<Plugin>, Vec<String>) {
    let mut out = Vec::new();
    let mut errs = Vec::new();
    let root = dir(ctx);
    let Ok(entries) = fs::read_dir(&root) else {
        return (out, errs);
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let Some(pid) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let manifest = path.join("plugin.json");
        match fs::read_to_string(&manifest) {
            Ok(text) => match serde_json::from_str::<Plugin>(&text) {
                Ok(mut p) => {
                    p.id = pid.to_string();
                    if p.name.trim().is_empty() {
                        p.name = pid.to_string();
                    }
                    // 自我安全校验（schema/权限/路径）：不过的插件不进加载列表
                    if let Err(e) = validate(&p, &path) {
                        errs.push(format!("{pid}: {e}"));
                        continue;
                    }
                    out.push(p);
                }
                Err(e) => errs.push(format!("{pid}: {e}")),
            },
            Err(_) => errs.push(format!("{pid}: plugin.json missing or unreadable")),
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    (out, errs)
}

// ---------- 自我安全校验：全文件 SHA-256 基线（防篡改）----------
//
// 首次启用插件时对插件目录全部文件算哈希基线（bit.db 文档 "plugin_baselines"），
// 此后每次 scan 对比：文件被改动/新增/删除 → 该插件按未启用处理（不注入任何能力），
// 错误进 errs 并记审计。用户在 UI 点「信任并启用」可重录基线（覆盖为当前内容）。

/// 递归计算插件目录内容哈希：路径（相对、正斜杠）+ 内容 逐条喂 sha256，
/// 顺序固定（目录遍历后排序），结果为 64 位 hex。
fn dir_fingerprint(pdir: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    fn walk(base: &std::path::Path, cur: &std::path::Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
        let entries = fs::read_dir(cur).map_err(|e| e.to_string())?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out)?;
            } else {
                let rel = p
                    .strip_prefix(base)
                    .map_err(|_| "strip_prefix failed".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, p));
            }
        }
        Ok(())
    }
    walk(pdir, pdir, &mut files)?;
    files.sort();
    let mut h = Sha256::new();
    for (rel, p) in &files {
        h.update(rel.as_bytes());
        h.update([0]);
        let bytes = fs::read(p).map_err(|e| format!("{rel}: {e}"))?;
        h.update(&(bytes.len() as u64).to_le_bytes());
        h.update(&bytes);
    }
    Ok(format!("{:x}", h.finalize()))
}

type Baselines = HashMap<String, String>;

fn load_baselines(ctx: &Arc<crate::state::Ctx>) -> Baselines {
    let db = ctx.db.lock().unwrap();
    crate::store::get_json::<Baselines>(&db, "plugin_baselines").unwrap_or_default()
}

fn save_baselines(ctx: &Arc<crate::state::Ctx>, st: &Baselines) {
    let db = ctx.db.lock().unwrap();
    crate::store::put_json(&db, "plugin_baselines", st);
}

/// 信任并启用：重录该插件的哈希基线（当前内容即信任基线）
pub fn record_baseline(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<(), String> {
    let fp = dir_fingerprint(&dir(ctx).join(id))?;
    let mut st = load_baselines(ctx);
    st.insert(id.to_string(), fp);
    save_baselines(ctx, &st);
    Ok(())
}

/// 校验单个插件：无基线 = 从未启用过（返回 Ok，首次启用时补录）；
/// 有基线且不匹配 = 篡改，返回差异说明
pub fn verify(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<(), String> {
    let Some(base) = load_baselines(ctx).get(id).cloned() else {
        return Ok(());
    };
    let now = dir_fingerprint(&dir(ctx).join(id))?;
    if now != base {
        return Err("内容与启用时基线不一致（文件被改动）".into());
    }
    Ok(())
}

/// 启用插件的基线核对（sync / prompt_fragment / scheduler 共用，幂等）：
/// 无基线 → 补录当前内容（首次启用/升级接入）；不匹配 → 进返回列表（篡改）。
/// 审计只在 sync 里记，避免非 sync 调用点重复刷审计流水。
pub fn tampered_ids(ctx: &Arc<crate::state::Ctx>, enabled: &[&Plugin]) -> Vec<String> {
    let mut out = Vec::new();
    let mut baselines = load_baselines(ctx);
    let mut dirty = false;
    for p in enabled {
        match dir_fingerprint(&dir(ctx).join(&p.id)) {
            Ok(now) => match baselines.get(&p.id) {
                Some(base) if *base != now => out.push(p.id.clone()),
                None => {
                    baselines.insert(p.id.clone(), now);
                    dirty = true;
                }
                _ => {}
            },
            Err(_) => out.push(p.id.clone()), // 读不出文件按不可信处理
        }
    }
    if dirty {
        save_baselines(ctx, &baselines);
    }
    out
}

/// 工具/技能/记忆 与插件状态的同步：
/// 先清掉旧的 plugin 来源条目，再按当前启用列表重新写入。
/// 幂等：重扫/开关后调用都安全。
/// 含自我安全校验：启用中的插件逐个过哈希基线，篡改的按未启用处理（不注入任何能力）。
pub fn sync(ctx: &Arc<crate::state::Ctx>) {
    let (plugins, mut errs) = scan(ctx);
    let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };

    // ---- 哈希基线校验（防篡改）----
    // 无基线的启用插件补录当前内容为基线；不匹配 = 篡改 → 按未启用处理 + errs + 审计。
    let enabled_refs: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
    let tampered = tampered_ids(ctx, &enabled_refs);
    for id in &tampered {
        errs.push(format!(
            "{id}: 安全校验失败 — 内容与启用时基线不一致，已停用（在工具页重新启用可信任当前内容）"
        ));
        crate::audit::record(
            ctx,
            "system",
            "plugin.verify",
            id,
            serde_json::json!({ "ok": false, "reason": "baseline mismatch" }),
            false,
        );
    }
    let is_on = |p: &Plugin| !disabled.contains(&p.id) && !tampered.contains(&p.id);

    // ---- 工具 ----
    {
        let mut tools = ctx.tools.lock().unwrap();
        tools.retain(|t| !t.created_by.starts_with("plugin:"));
        for p in plugins.iter().filter(|p| is_on(p)) {
            let pdir = dir(ctx).join(&p.id);
            for t in &p.tools {
                let Some(code) = resolve_code(&pdir, &t.file, &t.code) else {
                    continue;
                };
                let kind = if t.kind == "script" {
                    crate::registry::ToolKind::Script { code }
                } else {
                    if t.runtime.trim().is_empty() {
                        continue; // interpreter 模式必须指定运行时
                    }
                    crate::registry::ToolKind::Interpreter { runtime: t.runtime.trim().to_string(), code }
                };
                let parameters = if t.parameters.is_null() {
                    serde_json::json!({ "type": "object", "properties": {} })
                } else {
                    t.parameters.clone()
                };
                tools.push(crate::registry::ToolDef {
                    id: format!("plugin::{}::{}", p.id, sanitize(&t.name)),
                    name: format!("p_{}_{}", sanitize(&p.id), sanitize(&t.name)),
                    description: if t.description.is_empty() {
                        format!("Plugin `{}` tool `{}`", p.name, t.name)
                    } else {
                        t.description.clone()
                    },
                    parameters,
                    kind,
                    created_by: format!("plugin:{}", p.id),
                    created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                    enabled: true,
                });
            }
        }
    }
    let _ = ctx.save_tools();

    // ---- 技能 / 记忆：来源标记 plugin:<id>，重扫时整体重建 ----
    {
        let mut skills = ctx.skills.lock().unwrap();
        skills.retain(|s| !s.source.starts_with("plugin:"));
        for p in plugins.iter().filter(|p| is_on(p)) {
            for sk in &p.skills {
                skills.push(crate::memory::Skill {
                    id: String::new(), // 注入型技能不参与 memory(id) 取回，空 id
                    ts: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                    name: sk.name.clone(),
                    summary: sk.summary.clone(),
                    source: format!("plugin:{}", p.id),
                });
            }
        }
    }
    {
        let mut memories = ctx.memories.lock().unwrap();
        memories.retain(|m| !m.source.starts_with("plugin:"));
        for p in plugins.iter().filter(|p| is_on(p)) {
            for content in &p.memories {
                memories.push(crate::memory::Memory {
                    id: String::new(),
                    ts: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                    kind: "raw".into(),
                    content: content.clone(),
                    source: format!("plugin:{}", p.id),
                });
            }
        }
    }
    // 持久化 skills/memories（统一走 bit.db，复用 memory::persist——原直写 JSON 文件与启动加载源分裂）
    crate::memory::persist(ctx);

    // 更新内存里的插件列表
    {
        let mut cur = ctx.plugins.lock().unwrap();
        *cur = plugins;
    }
    // 成功也留痕：出问题时可区分"没扫到目录/没插件"与"解析失败"（此前排查靠它定位 id 字段缺失 bug）
    let total_tools: usize = ctx.tools.lock().unwrap().iter().filter(|t| t.created_by.starts_with("plugin:")).count();
    crate::trace::event(
        "plugins",
        &format!(
            "sync: {} plugin(s), {} plugin tool(s), {} memory(ies), {} skill(s), {} err(s)",
            ctx.plugins.lock().unwrap().len(),
            total_tools,
            ctx.memories.lock().unwrap().iter().filter(|m| m.source.starts_with("plugin:")).count(),
            ctx.skills.lock().unwrap().iter().filter(|s| s.source.starts_with("plugin:")).count(),
            errs.len()
        ),
    );
    if !errs.is_empty() {
        crate::trace::event("plugins", &format!("scan errors: {}", errs.join("; ")));
    }
}

/// 启用插件注入的提示词片段（禁用/篡改插件不注入）。供 ai.rs 组装系统提示词时调用。
pub fn prompt_fragment(ctx: &Arc<crate::state::Ctx>) -> String {
    let plugins = ctx.plugins.lock().unwrap();
    let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };
    let enabled: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
    let tampered = tampered_ids(ctx, &enabled);
    let mut out = String::new();
    for p in enabled.into_iter().filter(|p| !tampered.contains(&p.id)) {
        for text in &p.prompts {
            if !text.trim().is_empty() {
                out.push_str(&format!("### Plugin `{}`\n{}\n", p.name, text.trim()));
            }
        }
    }
    if out.is_empty() {
        String::new()
    } else {
        format!("\n## Plugin instructions\n{out}")
    }
}

// ---------- 前端 UI 资源导出（供渲染进程插件加载器读取）----------

/// 导出启用且通过安全校验的插件 UI 资源（css/js 源文本）。
/// 只导出 permissions 里声明了对应权限位的内容；路径统一过 safe_rel 闸门。
/// 返回 [{ id, name, version, permissions, css: [{path, text}], js: [{path, text}] }]
pub fn ui_bundle(ctx: &Arc<crate::state::Ctx>) -> Vec<serde_json::Value> {
    let (plugins, _) = scan(ctx);
    let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };
    let enabled: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
    let tampered = tampered_ids(ctx, &enabled);
    let mut out = Vec::new();
    for p in enabled.into_iter().filter(|p| !tampered.contains(&p.id)) {
        let Some(ui) = &p.ui else { continue };
        let pdir = dir(ctx).join(&p.id);
        let has = |perm: &str| p.permissions.iter().any(|x| x == perm);
        let read = |paths: &[String]| -> Vec<serde_json::Value> {
            let mut v = Vec::new();
            for f in paths {
                if safe_rel(f).is_err() {
                    continue;
                }
                if let Ok(text) = fs::read_to_string(pdir.join(f)) {
                    // 单文件 512KB 上限：防清单指个巨型文件把渲染层拖死
                    if text.len() <= 512 * 1024 {
                        v.push(serde_json::json!({ "path": f, "text": text }));
                    }
                }
            }
            v
        };
        let css = if has("css") { read(&ui.css) } else { Vec::new() };
        let js = if has("js") { read(&ui.js) } else { Vec::new() };
        if css.is_empty() && js.is_empty() {
            continue;
        }
        out.push(serde_json::json!({
            "id": p.id,
            "name": p.name,
            "version": p.version,
            "permissions": p.permissions,
            "css": css,
            "js": js,
        }));
    }
    out
}

// ---------- 定时任务调度 ----------

/// 任务上次执行时间（bit.db documents "plugin_jobs"）：key = "<插件id>/<job名>"
/// 历史遗留：曾存 toolhomes/plugins/_jobs.json，启动时一次性迁移入库
type JobState = HashMap<String, String>;

fn jobs_legacy_path(ctx: &Arc<crate::state::Ctx>) -> PathBuf {
    dir(ctx).join("_jobs.json")
}

fn load_job_state(ctx: &Arc<crate::state::Ctx>) -> JobState {
    {
        let db = ctx.db.lock().unwrap();
        if let Some(st) = crate::store::get_json::<JobState>(&db, "plugin_jobs") {
            return st;
        }
    } // db 锁先释放
      // 一次性迁移遗留 _jobs.json（db 无该文档时）：导入后改名 .migrated 留档
    let p = jobs_legacy_path(ctx);
    if let Ok(raw) = fs::read_to_string(&p) {
        if let Ok(st) = serde_json::from_str::<JobState>(&raw) {
            {
                let db = ctx.db.lock().unwrap();
                crate::store::put_json(&db, "plugin_jobs", &st);
            }
            let _ = fs::rename(&p, p.with_extension("json.migrated"));
            return st;
        }
    }
    JobState::default()
}

fn save_job_state(ctx: &Arc<crate::state::Ctx>, st: &JobState) {
    let db = ctx.db.lock().unwrap();
    crate::store::put_json(&db, "plugin_jobs", st);
}

/// 解析 "every Ns/m/h" 与 "daily HH:MM"。
enum Sched {
    Every(std::time::Duration),
    Daily(u32, u32),
}

fn parse_schedule(s: &str) -> Option<Sched> {
    let s = s.trim().to_lowercase();
    if let Some(rest) = s.strip_prefix("every ") {
        let rest = rest.trim();
        let (num, unit) = rest.split_at(rest.len().saturating_sub(1));
        let n: u64 = num.trim().parse().ok()?;
        let secs = match unit {
            "s" => n,
            "m" => n * 60,
            "h" => n * 3600,
            _ => return None,
        };
        if secs == 0 {
            return None;
        }
        return Some(Sched::Every(std::time::Duration::from_secs(secs)));
    }
    if let Some(rest) = s.strip_prefix("daily ") {
        let parts: Vec<&str> = rest.trim().split(':').collect();
        if parts.len() == 2 {
            let h: u32 = parts[0].trim().parse().ok()?;
            let m: u32 = parts[1].trim().parse().ok()?;
            if h < 24 && m < 60 {
                return Some(Sched::Daily(h, m));
            }
        }
    }
    None
}

fn is_due(sched: &Sched, last: Option<&String>) -> bool {
    match sched {
        Sched::Every(d) => match last.and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()) {
            Some(t) => {
                let elapsed = chrono::Local::now().naive_local() - t;
                elapsed.to_std().map(|e| e >= *d).unwrap_or(true)
            }
            None => true,
        },
        Sched::Daily(h, m) => {
            let now = chrono::Local::now();
            // 今天没跑过 && 已到点（当天任意时刻错过则补跑一次）
            let ran_today = last
                .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
                .map(|t| t.date() == now.date_naive())
                .unwrap_or(false);
            !ran_today && (now.hour() > *h || (now.hour() == *h && now.minute() >= *m))
        }
    }
}

/// 执行一个插件任务：跑代码 → 审计 → 指定了 session 就复用后台 shell 唤回链路注入会话
async fn run_job(ctx: Arc<crate::state::Ctx>, pid: String, job: PluginJob) {
    let pdir = dir(&ctx).join(&pid);
    let Some(code) = resolve_code(&pdir, &job.file, &job.code) else {
        crate::audit::record(&ctx, "host", "plugin.job", &format!("{pid}/{}", job.name), serde_json::json!({ "error": "no code" }), false);
        return;
    };
    let runtime = if job.runtime.trim().is_empty() { "py".to_string() } else { job.runtime.trim().to_string() };
    let timeout = {
        let cfg = ctx.config.lock().unwrap();
        std::time::Duration::from_secs(cfg.tool_timeout_secs.clamp(1, 600) as u64)
    };
    let ctx2 = ctx.clone();
    let rt = runtime.clone();
    let code2 = code.clone();
    let handle = crate::task::spawn_blocking(move || {
        crate::script_runtime::run(&ctx2, &rt, &code2, &serde_json::json!({}), timeout)
    });
    let out = tokio::time::timeout(std::time::Duration::from_secs(600), handle).await;
    let (ok, stdout, stderr) = match out {
        Ok(Ok(Ok(v))) => (true, serde_json::to_string_pretty(&v).unwrap_or_default(), String::new()),
        Ok(Ok(Err(e))) => (false, String::new(), e),
        Ok(Err(e)) => (false, String::new(), format!("task failed: {e}")),
        Err(_) => (false, String::new(), "job timed out (600s)".into()),
    };
    crate::audit::record(
        &ctx,
        "host",
        "plugin.job",
        &format!("{pid}/{}", job.name),
        serde_json::json!({ "ok": ok, "runtime": runtime }),
        ok,
    );
    // 有目标会话 → 结果作为后台任务产物唤回该会话的 AI（复用 shellbg 链路）
    if let Some(sid) = job.session.clone().filter(|s| !s.trim().is_empty()) {
        crate::shellbg::notify_session_result(
            &sid,
            &format!("plugin:{pid}/{}", job.name),
            &format!("定时任务 {}（插件 {pid}）", job.name),
            if ok { 0 } else { 1 },
            stdout,
            stderr,
            if ok { "done" } else { "timeout" },
        );
    }
}

/// 插件定时任务调度循环：每 30 秒检查一次到期任务。
/// 全程静默失败：单个任务出错不影响调度循环与其他插件。
pub async fn scheduler(ctx: Arc<crate::state::Ctx>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let plugins = ctx.plugins.lock().unwrap().clone();
        if plugins.is_empty() {
            continue;
        }
        let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };
        // 防篡改：篡改插件的定时任务不执行（校验顺便给新启用插件补录基线）
        let enabled: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
        let tampered = tampered_ids(&ctx, &enabled);
        let mut state = load_job_state(&ctx);
        let mut dirty = false;
        for p in enabled.into_iter().filter(|p| !tampered.contains(&p.id)) {
            for job in &p.jobs {
                let key = format!("{}/{}", p.id, job.name);
                let Some(sched) = parse_schedule(&job.schedule) else {
                    continue;
                };
                if !is_due(&sched, state.get(&key)) {
                    continue;
                }
                // 记录执行时间（先写后跑：同间隔长任务不会在每 tick 重复触发）
                state.insert(key, chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
                dirty = true;
                let jc = ctx.clone();
                let j = job.clone();
                let pid = p.id.clone();
                crate::task::spawn(async move { run_job(jc, pid, j).await });
            }
        }
        if dirty {
            save_job_state(&ctx, &state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_schedule_works() {
        assert!(matches!(parse_schedule("every 30m"), Some(Sched::Every(d)) if d.as_secs() == 1800));
        assert!(matches!(parse_schedule("every 2h"), Some(Sched::Every(d)) if d.as_secs() == 7200));
        assert!(matches!(parse_schedule("daily 09:00"), Some(Sched::Daily(9, 0))));
        assert!(parse_schedule("weekly").is_none());
        assert!(parse_schedule("every 0m").is_none());
    }

    #[test]
    fn sanitize_keeps_model_friendly_names() {
        assert_eq!(sanitize("我的-工具 v1"), "______v1");
        assert_eq!(sanitize("mouse_move"), "mouse_move");
    }
}
