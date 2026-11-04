// yxpil · BIT core
//! DeepSeek Harness（dsh）插件兼容：扫描 dsh 技能/插件目录导入为 BIT 技能，
//! 提供已装插件状态查询、启停开关，以及 dsh MCP 桥（dsh-bridge/dsh-mcp.mjs）的注册。
//!
//! 目录布局（toolhomes/dsh，见 toolenv::dir）：
//!   plugins/        dsh 插件包（每包一个含 package.json 的目录），启停记在 disabled.json
//!   skills/         dsh 技能（*/SKILL.md 或顶层 *.md），插件自带技能在 plugins/*/skills/
//!   disabled.json   被禁用插件名列表 {"plugins":["name1",...]}，不存在 = 全部启用
//!
//! 桥注册为 stdio MCP server，但进程由 WorkWith 托管（条目 id 固定 "dsh-bridge"）：
//! command = 主程序自身（Electron 主程序配 ELECTRON_RUN_AS_NODE=1 即以纯 Node 运行），
//! 免依赖用户机器上的 Node。启停、日志、MCP 联动全部走 workwith 一套生命周期，
//! 用户既能在 WorkWith 页看到并管理它，AI 也能通过 workwith 工具操作它。
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::state::Ctx;

/// dsh 根目录（toolhomes/dsh）
fn dsh_dir(ctx: &Arc<Ctx>) -> PathBuf {
    crate::toolenv::dir(ctx).join("dsh")
}

/// dsh 技能根目录
fn skills_dir(ctx: &Arc<Ctx>) -> PathBuf {
    dsh_dir(ctx).join("skills")
}

/// dsh 插件根目录
fn plugins_dir(ctx: &Arc<Ctx>) -> PathBuf {
    dsh_dir(ctx).join("plugins")
}

/// 禁用列表文件（dsh 桥端与本模块共用同一路径，见 setup_bridge 注入的 DshDisabledFile）
fn disabled_file(ctx: &Arc<Ctx>) -> PathBuf {
    dsh_dir(ctx).join("disabled.json")
}

// ---------- SKILL.md 解析 ----------

/// 一份解析后的 SKILL.md
struct SkillDoc {
    /// frontmatter 的 name，缺失时为调用方给的兜底（目录名 / 文件名）
    name: String,
    /// frontmatter 的 description（可能为空）
    description: String,
    /// frontmatter 之后的正文
    body: String,
}

/// 解析 dsh 格式 SKILL.md：首行 `---` 起的 YAML frontmatter 取 name / description
/// （只认顶层单行 `key: value`，值去引号），其余为正文；
/// 无 frontmatter 时用兜底名当 name。frontmatter 未闭合报错（记入 errors 不中断）。
fn parse_skill_md(text: &str, fallback_name: &str) -> Result<SkillDoc, String> {
    // Windows 记事本/编辑器可能带 UTF-8 BOM，去掉再看首行
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        // 无 frontmatter：全文即正文
        return Ok(SkillDoc {
            name: fallback_name.to_string(),
            description: String::new(),
            body: text.trim().to_string(),
        });
    }
    // 找闭合围栏
    let Some(close) = lines.iter().skip(1).position(|l| l.trim() == "---").map(|i| i + 1) else {
        return Err("frontmatter 未闭合".into());
    };
    let mut name = String::new();
    let mut description = String::new();
    for line in &lines[1..close] {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim().trim_matches(['"', '\'']);
        match k.trim() {
            "name" => name = v.to_string(),
            "description" => description = v.to_string(),
            _ => {} // 其余键（version/tags/...）导入不消费
        }
    }
    let body = lines[close + 1..].join("\n");
    Ok(SkillDoc {
        // frontmatter 里 name 为空时同样回退兜底名
        name: if name.trim().is_empty() { fallback_name.to_string() } else { name },
        description,
        body: body.trim().to_string(),
    })
}

/// 收集 `<root>/*/SKILL.md`，兜底名取子目录名
fn collect_dir_skills(root: &Path, out: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let f = path.join("SKILL.md");
        if f.is_file() {
            out.push((f, dir_name.to_string()));
        }
    }
}

// ---------- disabled.json ----------

/// 读禁用列表：不存在 / 损坏一律按"全部启用"处理（不阻断状态页）
fn load_disabled(path: &Path) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(path) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return Vec::new() };
    v.get("plugins")
        .and_then(|p| p.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// 写禁用列表（父目录不存在先建）
fn save_disabled(path: &Path, list: &[String]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 dsh 目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(&json!({ "plugins": list })).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| format!("写入 disabled.json 失败: {e}"))
}

// ---------- 四个命令 ----------

/// 导入 dsh 技能：扫三个技能根的 SKILL.md 解析入库（source="dsh"），同名已存在跳过。
/// 单个文件解析失败记入 errors 不中断；目录不存在直接跳过（roots 不含它）。
pub fn import_skills_impl(ctx: &Arc<Ctx>) -> Result<Value, String> {
    let mut roots: Vec<String> = Vec::new();
    // (SKILL 文件路径, frontmatter 缺 name 时的兜底名)
    let mut files: Vec<(PathBuf, String)> = Vec::new();

    // a. toolhomes/dsh/skills：*/SKILL.md（目录名兜底）+ 顶层 *.md（文件名兜底）
    let sk_root = skills_dir(ctx);
    if sk_root.is_dir() {
        roots.push(sk_root.to_string_lossy().into_owned());
        collect_dir_skills(&sk_root, &mut files);
        if let Ok(entries) = fs::read_dir(&sk_root) {
            for e in entries.flatten() {
                let p = e.path();
                let is_md = p
                    .is_file()
                    && p.extension().map(|x| x.to_string_lossy().eq_ignore_ascii_case("md")).unwrap_or(false);
                if is_md {
                    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("skill").to_string();
                    files.push((p, stem));
                }
            }
        }
    }

    // b. toolhomes/dsh/plugins/*/skills/*/SKILL.md（插件自带技能）
    let pl_root = plugins_dir(ctx);
    if pl_root.is_dir() {
        roots.push(pl_root.to_string_lossy().into_owned());
        if let Ok(entries) = fs::read_dir(&pl_root) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    collect_dir_skills(&p.join("skills"), &mut files);
                }
            }
        }
    }

    // c. 用户主目录 ~/.dsh/skills/*/SKILL.md（dsh 标准发现根之一，不存在跳过）
    if let Some(home) = dirs::home_dir() {
        let user_root = home.join(".dsh").join("skills");
        if user_root.is_dir() {
            roots.push(user_root.to_string_lossy().into_owned());
            collect_dir_skills(&user_root, &mut files);
        }
    }

    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for (path, fallback) in &files {
        let text = match fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                errors.push(format!("{}: {e}", path.display()));
                continue;
            }
        };
        let doc = match parse_skill_md(&text, fallback) {
            Ok(d) => d,
            Err(e) => {
                errors.push(format!("{}: {e}", path.display()));
                continue;
            }
        };
        let name = doc.name.trim().to_string();
        if name.is_empty() {
            errors.push(format!("{}: 缺少技能名", path.display()));
            continue;
        }
        // summary = description + 空行 + 正文（任一侧为空则只取另一侧）
        let summary = if doc.description.trim().is_empty() {
            doc.body
        } else if doc.body.trim().is_empty() {
            doc.description
        } else {
            format!("{}\n\n{}", doc.description, doc.body)
        };
        if summary.trim().is_empty() {
            errors.push(format!("{}: 描述与正文均为空", path.display()));
            continue;
        }
        // 同名技能已存在则跳过（含本批刚导入的：add_skill 会立即进 ctx.skills）
        let exists = ctx
            .skills
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.name.eq_ignore_ascii_case(&name));
        if exists {
            skipped += 1;
            continue;
        }
        crate::memory::add_skill(ctx, &name, &summary, "dsh");
        imported += 1;
    }
    if imported > 0 || !errors.is_empty() {
        crate::audit::record(
            ctx,
            "local-user",
            "dsh.import_skills",
            "skills",
            json!({ "imported": imported, "skipped": skipped }),
            errors.is_empty(),
        );
    }
    Ok(json!({ "imported": imported, "skipped": skipped, "roots": roots, "errors": errors }))
}

/// 桥在 WorkWith 里的固定条目 id：稳定——重启应用 / 重启进程都不换，
/// 联动出的 MCP 行恒为 ww-dsh-bridge，用户在 WorkWith 页看到的就是这一条
const BRIDGE_ENTRY_ID: &str = "dsh-bridge";
/// 旧版（未迁移前）把桥注册成手写 stdio MCP server，靠这两个特征识别并清理
const BRIDGE_SCRIPT_NAME: &str = "dsh-mcp.mjs";

/// 桥的 WorkWith 条目；必须是 stdio 联动模式才算桥（同名手写条目不算）
fn bridge_entry(ctx: &Arc<Ctx>) -> Option<crate::workwith::WorkWithEntry> {
    crate::workwith::load_entries(ctx)
        .into_iter()
        .find(|e| e.id == BRIDGE_ENTRY_ID && e.is_stdio_mcp())
}

/// 已注册的桥 server id：条目存在即算注册（进程是否活着看 status 里的 running）
fn bridge_server_id(ctx: &Arc<Ctx>) -> Option<String> {
    bridge_entry(ctx).map(|_| crate::workwith::mcp_id(BRIDGE_ENTRY_ID))
}

/// 升级迁移：旧版把桥注册成手写 stdio MCP server，这里照搬它的配置建成 WorkWith 条目，
/// 再清掉旧行（旧进程随 unregister 一起终止）。只在桥条目还不存在时搬一次，重复调用幂等；
/// 原本处于启用状态时搬完立即由 WorkWith 重新拉起，避免用户的桥出现空窗。
fn migrate_bridge_entry(ctx: &Arc<Ctx>) {
    if bridge_entry(ctx).is_some() {
        retire_legacy_bridge_rows(ctx);
        return;
    }
    let legacy = {
        let list = ctx.mcp.lock().unwrap();
        list.iter()
            .filter(|s| {
                s.transport == crate::mcp::McpTransport::Stdio
                    && s.args.iter().any(|a| a.ends_with(BRIDGE_SCRIPT_NAME))
            })
            .cloned()
            .next()
    };
    let Some(old) = legacy else { return };
    let name = if old.name.trim().is_empty() {
        "DeepSeek Harness 插件桥".to_string()
    } else {
        old.name.clone()
    };
    // 先落新条目，成功后才拆旧的：save 失败（配置残缺等）时旧桥原样留着，不弄成半残
    if crate::workwith::save(
        ctx,
        json!({
            "id": BRIDGE_ENTRY_ID,
            "name": name,
            "runtime_id": "custom",
            "program": old.command,
            "args": old.args,
            "env": old.env,
            "port": 0,
            "mcp_mode": crate::workwith::MCP_MODE_STDIO,
            "auto_with_session": true,
        }),
    )
    .is_err()
    {
        return;
    }
    let restart = old.enabled;
    retire_legacy_bridge_rows(ctx);
    if restart {
        let c2 = ctx.clone();
        crate::task::spawn(async move {
            let _ = crate::workwith::start(&c2, BRIDGE_ENTRY_ID).await;
        });
    }
}

/// 清掉迁移前遗留的手写桥条目：不删就会和 WorkWith 版并存——两个进程同时当桥，
/// 工具重复导入、启停各管一半。返回清理条数（0 是常态，重复调用幂等）。
fn retire_legacy_bridge_rows(ctx: &Arc<Ctx>) -> usize {
    let keep = crate::workwith::mcp_id(BRIDGE_ENTRY_ID);
    let stale: Vec<String> = {
        let list = ctx.mcp.lock().unwrap();
        list.iter()
            .filter(|s| {
                s.id != keep
                    && s.transport == crate::mcp::McpTransport::Stdio
                    && s.args.iter().any(|a| a.ends_with(BRIDGE_SCRIPT_NAME))
            })
            .map(|s| s.id.clone())
            .collect()
    };
    if stale.is_empty() {
        return 0;
    }
    for id in &stale {
        // 旧会话自己持有子进程句柄：unregister 会真的把那个桥进程杀掉
        crate::mcp::unregister_stdio(&ctx.mcp_stdio, id);
        ctx.mcp.lock().unwrap().retain(|s| s.id != *id);
        let mut tools = ctx.tools.lock().unwrap();
        tools.retain(|t| match &t.kind {
            crate::registry::ToolKind::Mcp { server_id, .. } => server_id != id,
            _ => true,
        });
    }
    ctx.save_mcp();
    ctx.save_tools();
    stale.len()
}

/// dsh 状态：已装插件（plugins/*/package.json）+ 启停 + 桥注册情况 + 技能根路径
pub fn status_impl(ctx: &Arc<Ctx>) -> Result<Value, String> {
    // 打开工具页即完成升级迁移：老桥搬进 WorkWith，此后状态一律按托管口径报
    migrate_bridge_entry(ctx);
    let dsh_root = dsh_dir(ctx);
    let disabled = load_disabled(&dsh_root.join("disabled.json"));
    // 扫有 package.json 的目录即"已安装的 dsh 插件"
    let mut list: Vec<(String, String, String, bool)> = Vec::new();
    if let Ok(entries) = fs::read_dir(dsh_root.join("plugins")) {
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_dir() {
                continue;
            }
            let dir_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if dir_name.is_empty() {
                continue;
            }
            let Ok(raw) = fs::read_to_string(path.join("package.json")) else {
                continue; // 无 package.json = 未安装
            };
            // package.json 损坏时按目录名兜底，单个坏包不拖垮整个状态页
            let pkg = serde_json::from_str::<Value>(&raw).ok();
            let name = pkg
                .as_ref()
                .and_then(|v| v.get("name"))
                .and_then(|x| x.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(String::from)
                .unwrap_or(dir_name);
            let version = pkg
                .as_ref()
                .and_then(|v| v.get("version"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let enabled = !disabled.iter().any(|d| *d == name);
            list.push((name, version, path.to_string_lossy().into_owned(), enabled));
        }
    }
    list.sort_by(|a, b| a.0.cmp(&b.0));
    let plugins: Vec<Value> = list
        .into_iter()
        .map(|(name, version, dir, enabled)| json!({ "name": name, "version": version, "dir": dir, "enabled": enabled }))
        .collect();
    // 桥状态：条目在 = 已接入；running/pid 由 WorkWith 托管态给出（进程可能停着等用户启动）
    let bridge = match bridge_server_id(ctx) {
        Some(id) => {
            let (running, pid, uptime_ms) = match crate::workwith::status_of(BRIDGE_ENTRY_ID) {
                Some((pid, uptime_ms)) => (true, pid, uptime_ms),
                None => (false, 0, 0),
            };
            json!({
                "registered": true, "server_id": id, "hosted_by": "workwith",
                "entry_id": BRIDGE_ENTRY_ID, "running": running, "pid": pid, "uptime_ms": uptime_ms,
            })
        }
        None => json!({ "registered": false }),
    };
    Ok(json!({
        "plugins": plugins,
        "bridge": bridge,
        "skills_root": skills_dir(ctx).to_string_lossy().into_owned(),
    }))
}

/// dsh 插件启停：写 disabled.json（启用移出列表、禁用加入），返回新状态
pub fn toggle_plugin_impl(ctx: &Arc<Ctx>, name: String, enabled: bool) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("插件名不能为空".into());
    }
    let file = disabled_file(ctx);
    let mut list = load_disabled(&file);
    if enabled {
        list.retain(|x| x != name);
    } else if !list.iter().any(|x| x == name) {
        list.push(name.to_string());
    }
    save_disabled(&file, &list)?;
    crate::audit::record(ctx, "local-user", "dsh.toggle", name, json!({ "enabled": enabled }), true);
    Ok(json!({ "name": name, "enabled": enabled, "disabled": list }))
}

/// 定位桥脚本 dsh-bridge/dsh-mcp.mjs：
/// a) 主程序所在目录向上逐级找 Resources/…（macOS bundle）与
///    resources/app.asar.unpacked/…（Windows/Linux electron-builder）
/// b) 进程 cwd 及其祖先目录（开发态仓库根）下直接找
fn find_bridge_script() -> Option<PathBuf> {
    const REL: &str = "dsh-bridge/dsh-mcp.mjs";
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for anc in dir.ancestors() {
                cands.push(anc.join("Resources").join(REL));
                cands.push(anc.join("resources/app.asar.unpacked").join(REL));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for anc in cwd.ancestors() {
            cands.push(anc.join(REL));
        }
    }
    cands.into_iter().find(|p| p.is_file())
}

/// dsh 首次接入：建 toolhomes/dsh/{plugins,skills}（首次创建时写 README 说明用法），
/// 然后定位桥脚本、建/更新 WorkWith 条目（stdio 联动）并立即启动。
/// 进程与 MCP 联动全交给 WorkWith 托管：用户在 WorkWith 页能看到、能停、能看日志，
/// AI 也能用 workwith 工具启停它（默认关闭，需用户开启）。
pub async fn setup_bridge_impl(ctx: &Arc<Ctx>) -> Result<Value, String> {
    let root = dsh_dir(ctx);
    let first_create = !root.is_dir();
    fs::create_dir_all(root.join("plugins")).map_err(|e| format!("创建 dsh 目录失败: {e}"))?;
    fs::create_dir_all(root.join("skills")).map_err(|e| format!("创建 dsh 目录失败: {e}"))?;
    // 仅首次创建时写 README（用户已有自己的说明时不覆盖）
    if first_create {
        let readme = root.join("README.md");
        if !readme.exists() {
            let _ = fs::write(
                &readme,
                "# DeepSeek Harness（dsh）\n\n- 把 dsh 插件包放进 `plugins/`（每包一个含 package.json 的目录）\n- 技能（SKILL.md）放进 `skills/`\n",
            );
        }
    }
    let script = find_bridge_script().ok_or("找不到 dsh-bridge 桥脚本")?;
    let exe =
        std::env::current_exe().map_err(|e| format!("无法定位可执行文件: {e}"))?;
    // command = 主程序自身：Electron 主程序配 ELECTRON_RUN_AS_NODE=1 即以纯 Node 运行
    let command = exe.to_string_lossy().into_owned();
    let args = vec![script.to_string_lossy().into_owned()];
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
    env.insert("DshPluginsDir".into(), plugins_dir(ctx).to_string_lossy().into_owned());
    env.insert("DshDisabledFile".into(), disabled_file(ctx).to_string_lossy().into_owned());
    // 条目运行中不允许改配置（改了也不生效）：接入按钮语义是「按当前路径重接」，
    // 所以先停掉旧的托管进程
    if crate::workwith::is_running(BRIDGE_ENTRY_ID) {
        let _ = crate::workwith::stop(ctx, BRIDGE_ENTRY_ID).await;
    }
    // 老版手写桥条目可能还在跑：拆掉它（含进程与导入的工具），由 WorkWith 接管同一份配置
    let retired = retire_legacy_bridge_rows(ctx);
    crate::workwith::save(
        ctx,
        json!({
            "id": BRIDGE_ENTRY_ID,
            "name": "DeepSeek Harness 插件桥",
            "runtime_id": "custom",
            "program": command,
            "args": args,
            "env": env,
            "port": 0,
            "mcp_mode": crate::workwith::MCP_MODE_STDIO,
            // 会话联动：桥是 AI 侧能力，新会话首回合自动拉起（幂等，等价于旧的懒恢复）
            "auto_with_session": true,
        }),
    )?;
    let started = crate::workwith::start(ctx, BRIDGE_ENTRY_ID).await?;
    let mid = crate::workwith::mcp_id(BRIDGE_ENTRY_ID);
    // 握手与工具导入在 start 的后台任务里完成：等几秒让本次结果带回真实服务器信息，
    // 页面一次刷新就能看到已接入的工具，而不是先回一个空壳
    let mut server = None;
    for _ in 0..25 {
        match crate::mcp::find(ctx, &mid) {
            Some(s) if s.enabled => { server = Some(s); break; }
            _ => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
        }
    }
    crate::audit::record(
        ctx,
        "local-user",
        "dsh.setup_bridge",
        "dsh-bridge",
        json!({ "pid": started.get("pid").cloned().unwrap_or(json!(0)), "retired": retired }),
        server.is_some(),
    );
    Ok(json!({ "server": server, "id": mid, "workwith": started, "retired": retired }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ctx(tag: &str) -> Arc<Ctx> {
        let dir = std::env::temp_dir().join(format!(
            "bit-dsh-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: dir,
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        })
    }

    fn legacy_row(enabled: bool) -> crate::mcp::McpServer {
        crate::mcp::McpServer {
            id: "mcp-old".into(),
            name: "DeepSeek Harness 插件桥".into(),
            url: String::new(),
            transport: crate::mcp::McpTransport::Stdio,
            command: "C:/app/electron.exe".into(),
            args: vec!["C:/app/dsh-bridge/dsh-mcp.mjs".into()],
            env: HashMap::from([("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string())]),
            version: String::new(),
            protocol: String::new(),
            session: String::new(),
            enabled,
            connected_at: String::new(),
            headers: Default::default(),
            plugin_id: String::new(),
        }
    }

    /// 升级迁移：旧版手写 stdio 桥条目搬成 WorkWith 条目（配置原样照搬），旧行随之清掉。
    /// 用 enabled=false 的旧行：迁移不触发重新拉起，单测里没有 tokio runtime 也不会炸
    #[test]
    fn legacy_bridge_row_migrates_into_workwith() {
        let ctx = test_ctx("migrate");
        ctx.mcp.lock().unwrap().push(legacy_row(false));
        migrate_bridge_entry(&ctx);
        let entries = crate::workwith::load_entries(&ctx);
        assert_eq!(entries.len(), 1, "旧桥行应搬成一条 WorkWith 条目");
        let e = &entries[0];
        assert_eq!(e.id, BRIDGE_ENTRY_ID);
        assert!(e.is_stdio_mcp(), "搬过来的条目必须是 stdio 联动");
        assert_eq!(e.program, "C:/app/electron.exe");
        assert_eq!(e.args, vec!["C:/app/dsh-bridge/dsh-mcp.mjs".to_string()]);
        assert_eq!(e.env.get("ELECTRON_RUN_AS_NODE").map(|s| s.as_str()), Some("1"));
        assert_eq!(ctx.mcp.lock().unwrap().len(), 0, "旧的手写桥行应被清理");
        // 幂等：再来一次不产生第二条条目
        migrate_bridge_entry(&ctx);
        assert_eq!(crate::workwith::load_entries(&ctx).len(), 1);
    }
}
