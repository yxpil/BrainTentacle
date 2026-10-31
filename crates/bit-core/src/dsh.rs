// yxpil · BIT core
//! DeepSeek Harness（dsh）插件兼容：扫描 dsh 技能/插件目录导入为 BIT 技能，
//! 提供已装插件状态查询、启停开关，以及 dsh MCP 桥（dsh-bridge/dsh-mcp.mjs）的注册。
//!
//! 目录布局（toolhomes/dsh，见 toolenv::dir）：
//!   plugins/        dsh 插件包（每包一个含 package.json 的目录），启停记在 disabled.json
//!   skills/         dsh 技能（*/SKILL.md 或顶层 *.md），插件自带技能在 plugins/*/skills/
//!   disabled.json   被禁用插件名列表 {"plugins":["name1",...]}，不存在 = 全部启用
//!
//! 桥注册为 stdio MCP server：command = 主程序自身（Electron 主程序配
//! ELECTRON_RUN_AS_NODE=1 即以纯 Node 运行），免依赖用户机器上的 Node。
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

/// 已注册的桥 server id：按 command（当前主程序路径）+ args（唯一参数为 dsh-mcp.mjs）
/// 匹配 ctx.mcp 里的 stdio 条目；未注册返回 None。
fn bridge_server_id(ctx: &Arc<Ctx>) -> Option<String> {
    let exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned());
    let list = ctx.mcp.lock().unwrap();
    list.iter()
        .find(|s| {
            s.transport == crate::mcp::McpTransport::Stdio
                && s.args.len() == 1
                && s.args[0].ends_with("dsh-mcp.mjs")
                && exe.as_ref().map_or(true, |e| s.command == *e)
        })
        .map(|s| s.id.clone())
}

/// dsh 状态：已装插件（plugins/*/package.json）+ 启停 + 桥注册情况 + 技能根路径
pub fn status_impl(ctx: &Arc<Ctx>) -> Result<Value, String> {
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
    let bridge = match bridge_server_id(ctx) {
        Some(id) => json!({ "registered": true, "server_id": id }),
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
/// 然后定位桥脚本并注册为 stdio MCP server（同 command+args 自动替换旧条目）。
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
    crate::commands_api::mcp_add_stdio(
        ctx,
        "DeepSeek Harness 插件桥".into(),
        command,
        args,
        env,
    )
    .await
}
