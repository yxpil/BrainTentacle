// yxpil · BIT
//! 插件登记的文件类型：图标 + 可选解析器（清单 `file_kinds[]`，需 "files" 权限）。
//!
//! 分工只有一条铁律：核心解析得了的类型永远由核心解析，插件只补核心读不了的那些。
//! 这条在清单校验阶段就钉死了（`validate()` 直接拒绝抢 `.pdf`/`.xlsx`/文本类后缀），
//! 因为插件随时可能被停用——停用后那些文件若已经改由插件解析，用户会突然发现文件打不开。
//!
//! 注册表在 `plugins::sync()` 时刷新：scan 已经过一遍清单闸门，这里再按
//! 「启用 + 未篡改 + files 权限位仍被用户放行」过滤，界面与解析链读同一份表，
//! 不会出现"图标说是插件的、正文却换了别家解析"。
//!
//! 解析复用既有的工具执行链（脚本走 `script::run`，解释器走 `script_runtime::run_env`）：
//! 插件用 `file_kinds[].tool` 指名自己声明的某个工具，宿主把 { filename, path|base64, size, kind, label }
//! 从 stdin 递进去，工具回一份 JSON。这条链不经过模型审批（是用户拖文件这个动作触发的），
//! 所以有三道收口：权限位可单独关掉、工具只能是该插件自己声明的、每次解析都记一条 files.parse 审计。
//! 之所以不走 `registry::invoke`：内置工具 read_doc 也调这条分派链，
//! invoke → builtin → extract_any → parse → invoke 会让 async fn 的 future 自引用而编译不过。

use base64::Engine;
use std::sync::{Arc, Mutex, OnceLock};

use crate::state::Ctx;

/// 一条生效的文件类型登记（清单洗过、权限放行后的形态）
#[derive(Clone)]
pub struct ActiveKind {
    /// 宿主侧稳定 key："<插件id>:<类型id>"
    pub key: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub label: String,
    pub label_en: String,
    /// 已归一的小写带点扩展名
    pub exts: Vec<String>,
    /// 图标字形（24 格 viewBox 的 path d），空 = 界面回退内置文档图标
    pub paths: Vec<String>,
    /// 解析工具的宿主侧 id（`plugin::<插件id>::<工具名>`）；None = 只登记图标
    pub tool_id: Option<String>,
}

fn reg() -> &'static Mutex<Vec<ActiveKind>> {
    static REG: OnceLock<Mutex<Vec<ActiveKind>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(Vec::new()))
}

/// 重扫后刷新注册表；返回生效条目数（单测与探针据此判断是否已就位）
pub fn refresh(ctx: &Arc<Ctx>) -> usize {
    let list = crate::plugins::file_kinds_active(ctx);
    let mut guard = reg().lock().unwrap();
    *guard = list;
    guard.len()
}

/// 当前生效的登记（按插件 id + 类型 id 定序，结果与扫描顺序无关）
pub fn all() -> Vec<ActiveKind> {
    let mut list = reg().lock().unwrap().clone();
    list.sort_by(|a, b| a.key.cmp(&b.key));
    list
}

/// 按文件名命中登记（后缀匹配，大小写不敏感）
pub fn find(filename: &str) -> Option<ActiveKind> {
    let lower = filename.to_ascii_lowercase();
    all().into_iter().find(|k| k.exts.iter().any(|e| lower.ends_with(e)))
}

/// 有没有插件说"这类文件我能读"（右键「查看详情」与侧栏预览据此决定要不要给预览入口）
pub fn parses(filename: &str) -> bool {
    find(filename).map(|k| k.tool_id.is_some()).unwrap_or(false)
}

/// 界面用的清单（新命令 plugin_file_kinds）：只描述已经生效的登记，
/// 渲染层拿到什么，解析时就是什么。
pub fn bundle() -> Vec<serde_json::Value> {
    all()
        .into_iter()
        .map(|k| {
            serde_json::json!({
                "key": k.key,
                "plugin_id": k.plugin_id,
                "plugin_name": k.plugin_name,
                "id": k.key.split(':').next_back().unwrap_or(""),
                "label": k.label,
                "label_en": k.label_en,
                "exts": k.exts,
                "paths": k.paths,
                "parses": k.tool_id.is_some(),
            })
        })
        .collect()
}

/// 请插件解析一个文件：递参 → 跑工具 → 取正文 → 封顶 → 审计。
/// 工具的返回口径（两份都认，写起来都只有一行）：
///   {"text": "正文"}                     —— 小文件直接回吐
///   {"file": "out/relative.txt"}         —— 大文件写在工作目录，回个相对路径
pub async fn parse(
    ctx: &Arc<Ctx>,
    kind: &ActiveKind,
    filename: &str,
    path: Option<&str>,
    bytes: &[u8],
) -> Result<String, String> {
    let tool_id = kind.tool_id.as_ref().ok_or_else(|| format!("文件类型 {} 没申报解析工具", kind.key))?;
    let mut params = serde_json::json!({
        "filename": filename,
        "size": bytes.len(),
        "kind": kind.key,
        "label": kind.label,
    });
    // 有本地路径就别再复制一份 base64：工具自己能读，也不会把几十 MB 塞进进程管道
    match path {
        Some(p) => params["path"] = serde_json::json!(p),
        None => {
            params["base64"] = serde_json::json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        }
    }
    let t0 = std::time::Instant::now();
    // 不经 registry::invoke：read_doc（内置工具）也走这条分派链，
    // invoke → builtin → extract_any → parse → invoke 会让 async fn 的 future 类型自引用而编译不过。
    // 这里直接拿工具定义跑同步执行链，超时与环境仍按工具页那一套口径取。
    let cid = ctx.clone();
    let tid = tool_id.clone();
    let handle = crate::task::spawn_blocking(move || run_tool(&cid, &tid, params));
    let out = handle.await.map_err(|e| format!("解析任务失败: {e}"))?;
    let text = match out {
        Ok(v) => pick_text(ctx, &v),
        Err(e) => Err(e),
    };
    let (ok, detail) = match &text {
        Ok(s) => (true, serde_json::json!({ "chars": s.chars().count() })),
        Err(e) => (false, serde_json::json!({ "error": crate::registry::safe_trunc(e, 500) })),
    };
    crate::audit::record(
        ctx,
        format!("plugin:{}", kind.plugin_id).as_str(),
        "files.parse",
        &kind.key,
        serde_json::json!({ "file": filename, "ms": t0.elapsed().as_millis(), "ok": ok, "detail": detail }),
        ok,
    );
    text.map(|s| crate::extract::cap_text(&s))
}

/// 跑插件自己的解析工具（同步执行链，放阻塞线程里调用）。
/// 只认脚本与解释器两类——远程 MCP / 内置工具不是"插件写的解析器"，不该被这条链拉起。
fn run_tool(ctx: &Arc<Ctx>, tool_id: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let tool = {
        let tools = ctx.tools.lock().unwrap();
        tools.iter().find(|t| t.id == tool_id).cloned()
    };
    let tool = tool.ok_or_else(|| format!("解析工具 `{tool_id}` 已不在工具表里"))?;
    if !tool.enabled {
        return Err(format!("解析工具 `{}` 已被暂停", tool.name));
    }
    // 插件工具带着自己的身份与令牌进进程（内置工具拿到空表）
    let extra_env = crate::plugin_sdk::tool_env(ctx, &tool.id);
    match &tool.kind {
        crate::registry::ToolKind::Script { code } => crate::script::run(code, params),
        crate::registry::ToolKind::Interpreter { runtime, code } => {
            let timeout = std::time::Duration::from_secs(
                ctx.config.lock().unwrap().tool_timeout_secs.clamp(1, 600) as u64,
            );
            crate::script_runtime::run_env(ctx, runtime, code, &params, timeout, &extra_env)
        }
        _ => Err(format!("文件类型只能用脚本/解释器工具解析，`{tool_id}` 不是")),
    }
}

/// 从工具返回里取正文：text / content 直接给，file 指向插件工作目录里的相对路径；
/// 执行链对非 JSON 的 stdout 会包成 {"stdout": "..."}，那种情况正文就在 stdout 里
fn pick_text(ctx: &Arc<Ctx>, v: &serde_json::Value) -> Result<String, String> {
    for key in ["text", "content", "stdout"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if !s.trim().is_empty() {
                return Ok(s.to_string());
            }
        }
    }
    if let Some(rel) = v.get("file").and_then(|x| x.as_str()) {
        crate::plugins::safe_rel(rel).map_err(|e| format!("插件解析返回的 file 不合法: {e}"))?;
        let p = crate::plugins::dir(ctx).join(rel);
        return std::fs::read_to_string(&p).map_err(|e| format!("读取插件写出的正文失败: {e}"));
    }
    Err("插件解析工具没回正文（要 {\"text\": \"…\"} 或 {\"file\": \"相对路径\"}）".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_only_keeps_granted_enabled_kinds() {
        let ctx = crate::plugins::test_ctx("filekinds-reg");
        crate::plugins::write_test_plugin(
            &ctx,
            "fk",
            json!({
                "name": "文件类型",
                "permissions": ["files"],
                "file_kind": { "id": "fz", "label": "FZ 脚本", "ext": "fz, FZZ", "paths": ["M4 4h16v16H4z"], "tool": "read_fz" },
                "tool": [{ "name": "read_fz", "runtime": "node", "code": "1" }],
            }),
            &[],
        );
        assert_eq!(refresh(&ctx), 1);
        let k = find("a.fzz").expect("逗号串扩展名要能被命中");
        assert_eq!(k.exts, vec![".fz", ".fzz"], "扩展名统一成小写带点");
        assert_eq!(k.tool_id.as_deref(), Some("plugin::fk::read_fz"));
        assert!(parses("a.fz"));
        // 用户单独关掉 files 权限位 → 注册表里当场消失
        ctx.config.lock().unwrap().plugin_denied_perms.insert("fk".into(), vec!["files".into()]);
        assert_eq!(refresh(&ctx), 0);
        assert!(find("a.fz").is_none());
    }

    #[test]
    fn core_kinds_are_never_taken_over() {
        // 抢内置后缀在清单阶段就被拒，注册表因此不可能出现 .pdf 的插件条目
        let ctx = crate::plugins::test_ctx("filekinds-core");
        crate::plugins::write_test_plugin(
            &ctx,
            "greedy",
            json!({
                "name": "抢后缀",
                "permissions": ["files"],
                "file_kinds": [{ "id": "pdf", "label": "我的 PDF", "exts": [".pdf"] }],
            }),
            &[],
        );
        let (_list, errs) = crate::plugins::scan(&ctx);
        assert!(
            errs.iter().any(|e| e.contains("greedy") && e.contains("already parsed by the host")),
            "{errs:?}"
        );
        assert_eq!(refresh(&ctx), 0);
    }

    #[test]
    fn file_kind_manifest_sugar_and_gates() {
        let ctx = crate::plugins::test_ctx("filekinds-gate");
        // 没申报 files 权限 → 整体拒收
        crate::plugins::write_test_plugin(
            &ctx,
            "noperm",
            json!({ "name": "没权限", "file_kinds": [{ "id": "x", "label": "X", "exts": [".x"] }] }),
            &[],
        );
        let (_l, errs) = crate::plugins::scan(&ctx);
        assert!(errs.iter().any(|e| e.contains("noperm") && e.contains("missing permission \"files\"")), "{errs:?}");
        // 解析工具必须是本插件自己声明的
        crate::plugins::write_test_plugin(
            &ctx,
            "ghosttool",
            json!({
                "name": "指空工具",
                "permissions": ["files"],
                "file_kinds": [{ "id": "x", "label": "X", "exts": [".x"], "tool": "nope" }],
            }),
            &[],
        );
        let (_l2, errs2) = crate::plugins::scan(&ctx);
        assert!(errs2.iter().any(|e| e.contains("tool `nope` is not declared")), "{errs2:?}");
        // 坏扩展名
        crate::plugins::write_test_plugin(
            &ctx,
            "badext",
            json!({ "name": "坏后缀", "permissions": ["files"], "file_kinds": [{ "id": "x", "label": "X", "exts": ["../etc"] }] }),
            &[],
        );
        let (_l3, errs3) = crate::plugins::scan(&ctx);
        assert!(errs3.iter().any(|e| e.contains("bad extension")), "{errs3:?}");
    }

    /// 内置读不了的后缀 → 交给插件的解析工具；内置读得了的仍然自己解析
    #[tokio::test]
    async fn plugin_tool_parses_what_the_host_cannot() {
        let ctx = crate::plugins::test_ctx("filekinds-parse");
        crate::plugins::write_test_plugin(
            &ctx,
            "fkp",
            json!({
                "name": "解析器",
                "permissions": ["files"],
                "file_kinds": [{ "id": "fz", "label": "FZ", "exts": [".fz"], "tool": "to_text" }],
                "tools": [{ "name": "to_text", "kind": "script", "code": "#{ text: \"正文来自 \" + params.filename }" }],
            }),
            &[],
        );
        crate::plugins::sync(&ctx);
        assert_eq!(refresh(&ctx), 1);
        assert!(!crate::extract::supports("a.fz"), "内置分派表本来不认识 .fz");
        let v = crate::commands_api::extract_any(&ctx, "a.fz", b"raw".to_vec(), None).await.unwrap();
        assert_eq!(v, "正文来自 a.fz");
        // 同一条链上，内置类型绝不绕道插件
        let t = crate::commands_api::extract_any(&ctx, "b.txt", "第一行\n".as_bytes().to_vec(), None).await.unwrap();
        assert_eq!(t, "第一行\n");
        // 谁也没登记的后缀：沿用内置那条带标记的报错
        let e = crate::commands_api::extract_any(&ctx, "c.zzz", b"x".to_vec(), None).await.unwrap_err();
        assert!(e.starts_with("[unsupported_kind]"), "{e}");
    }
}
