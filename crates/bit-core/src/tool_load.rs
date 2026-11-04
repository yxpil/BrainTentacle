// yxpil · BIT
// 工具按需加载（lazy_tools）：默认只把 skill 一个工具的完整 schema 下发给模型，
// 其余工具在系统提示词里只留「名字 + 一句摘要」的索引；模型真要用时先调
// skill(action=load_tool, name=X)，下一轮起该工具的 JSON Schema 才进 tools 参数。
//
// 为什么要这一层：内置 23 个工具的 schema 序列化后就有十几 KB，接上 MCP/插件工具后
// 每轮对话都要重付一遍（工具数组在请求最前面，历史再短也省不掉）。索引里内置工具只留
// 名字（名字已说明用途），插件/远程工具才附 40 字摘要，同样清单不到 1KB。
//
// 三条边界：
// 1) 只影响「下发给模型看到什么」，不影响能不能调用——执行链照旧查 ctx.tools，
//    审批闸门、tool_gate（screen/mouse…）、暂停态全部不变；
// 2) 已调取集合按会话隔离，存在 Ctx.tool_loaded（内存态）：重启即回到只有 skill 的起点；
// 3) skill 自己永不被压缩，否则就成了「要开门先得有钥匙」的死循环。
use std::collections::HashSet;
use std::sync::Arc;

/// 永不压缩的基础工具：它就是那把钥匙
pub const ALWAYS: &[&str] = &["skill"];

/// 本会话的桶：无会话（自动化/小圆片）统一落到空串这一桶
fn bucket(session: Option<&str>) -> String {
    session.unwrap_or("").to_string()
}

/// 索引里一条摘要的长度上限（字符）：插件/远程/MCP 工具的名字不可预测，摘要只需帮
/// 模型认领；参数细节等调取后从 schema 看。内置工具连摘要都省，只留名字
const GIST_CHARS: usize = 40;

/// 本会话的调取快照：调用方（ai.rs 的清单组装）先取一次再逐项判定，
/// 避免持着 ctx.tools 锁回调本模块形成 config↔tools 的反向锁序
pub fn loaded_set(ctx: &Arc<crate::state::Ctx>, session: Option<&str>) -> HashSet<String> {
    let map = ctx.tool_loaded.lock().unwrap();
    map.get(&bucket(session)).cloned().unwrap_or_default()
}

/// 该工具现在该不该下发：没开按需加载 / 是基础工具 / 本会话已调取，三者任一即可
pub fn wants(lazy: bool, loaded: &HashSet<String>, name: &str) -> bool {
    if !lazy {
        return true;
    }
    ALWAYS.iter().any(|a| a.eq_ignore_ascii_case(name))
        || loaded.iter().any(|a| a.as_str().eq_ignore_ascii_case(name))
}

/// 本会话是否已调取过该工具（未开启按需加载时恒为 true）
pub fn is_loaded(ctx: &Arc<crate::state::Ctx>, session: Option<&str>, name: &str) -> bool {
    if !ctx.config.lock().unwrap().lazy_tools {
        return true;
    }
    wants(true, &loaded_set(ctx, session), name)
}

/// 本会话已调取的工具名（排序后返回，给设置页与调试用）
pub fn loaded(ctx: &Arc<crate::state::Ctx>, session: Option<&str>) -> Vec<String> {
    let map = ctx.tool_loaded.lock().unwrap();
    let mut v: Vec<String> = map
        .get(&bucket(session))
        .map(|set| set.iter().cloned().collect())
        .unwrap_or_default();
    v.sort();
    v
}

/// 清空本会话的调取记录（会话删除时调用；设置页的「收起全部」也走这里）
pub fn reset(ctx: &Arc<crate::state::Ctx>, session: Option<&str>) {
    ctx.tool_loaded.lock().unwrap().remove(&bucket(session));
}

/// 注册表外的常驻能力（execute_tool_call 直接处理，不在 ctx.tools 里）：
/// 按需加载时同样要能被调取，所以清单在这里收口，ai.rs 下发与这里查表共用一份。
pub fn extra_tools() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    vec![
        (
            "run_script",
            "用本机解释器临时执行一段代码（不落地成常驻工具）。代码从 stdin 读 params JSON，结果打印到 stdout",
            serde_json::json!({"type":"object","properties":{"runtime":{"type":"string","description":"本机可用解释器 id"},"code":{"type":"string","description":"完整代码"},"params":{"type":"object","description":"传给代码的参数"}},"required":["runtime","code"]}),
        ),
        (
            "add_memory",
            "沉淀一条长期记忆",
            serde_json::json!({"type":"object","properties":{"content":{"type":"string"},"kind":{"type":"string","description":"如 preference/fact"}},"required":["content"]}),
        ),
        (
            "memory",
            "按 id 取回一条长期记忆全文（id 见提示词 Memories 主题索引）",
            serde_json::json!({"type":"object","properties":{"id":{"type":"string","description":"记忆 id"}},"required":["id"]}),
        ),
    ]
}

/// 按名字找工具定义（注册表 + 注册表外能力），大小写不敏感
fn find_tool(ctx: &Arc<crate::state::Ctx>, name: &str) -> Option<(String, String, serde_json::Value)> {
    if let Some(t) = ctx
        .tools
        .lock()
        .unwrap()
        .iter()
        .find(|t| t.name.eq_ignore_ascii_case(name))
        .cloned()
    {
        return Some((t.name, t.description, t.parameters));
    }
    extra_tools()
        .into_iter()
        .find(|(n, _, _)| n.eq_ignore_ascii_case(name))
        .map(|(n, d, p)| (n.to_string(), d.to_string(), p))
}

/// 调取一个工具：登记进本会话，并把完整 schema 直接回给模型（下一轮才进 tools 参数，
/// 但模型这一轮就能看到参数结构，不用瞎猜）
pub fn load(
    ctx: &Arc<crate::state::Ctx>,
    session: Option<&str>,
    name: &str,
) -> Result<serde_json::Value, String> {
    let want = name.trim();
    if want.is_empty() {
        return Err("load_tool 需要 name（要调取的工具名）".into());
    }
    if ALWAYS.iter().any(|a| a.eq_ignore_ascii_case(want)) {
        return Ok(serde_json::json!({ "already_loaded": want, "note": "skill 是基础工具，始终已加载" }));
    }
    let (real, desc, params) = find_tool(ctx, want).ok_or_else(|| {
        format!("没有名为 `{want}` 的工具。可先查提示词里的 Tool index，或用 list_tools 看全量清单")
    })?;
    // 锁序纪律：config 与 tools 各自短锁，绝不套着拿（与 ai.rs 的清单组装同一套规矩）
    let gate_ok = ctx.config.lock().unwrap().tool_gate(&real);
    let paused = ctx
        .tools
        .lock()
        .unwrap()
        .iter()
        .any(|t| t.name.eq_ignore_ascii_case(&real) && !t.enabled);
    if paused {
        return Err(format!("工具 `{real}` 已暂停，请到工具页启用后再调取"));
    }
    if !gate_ok {
        return Err(format!("工具 `{real}` 需要在「设置 · 本机操控」里打开后才可用"));
    }
    ctx.tool_loaded
        .lock()
        .unwrap()
        .entry(bucket(session))
        .or_insert_with(HashSet::new)
        .insert(real.clone());
    crate::audit::record(
        ctx,
        "agent",
        "tool.load",
        &real,
        serde_json::json!({ "session": session.unwrap_or("") }),
        true,
    );
    Ok(serde_json::json!({
        "loaded": real,
        "description": desc,
        "parameters": params,
        "next_turn": "该工具从下一轮起出现在 tools 参数里，可以直接调用",
    }))
}

/// 一句话摘要：截到第一个句读或固定长度，压掉换行（索引必须一行一条）
pub fn gist(desc: &str) -> String {
    let flat = desc.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut = flat
        .find(['.', '。', ';', '；'])
        .unwrap_or(flat.len());
    let head = flat[..cut].trim();
    let total = head.chars().count();
    if total <= GIST_CHARS {
        return head.to_string();
    }
    format!("{}…", head.chars().take(GIST_CHARS).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx_with(lazy: bool) -> Arc<crate::state::Ctx> {
        let ctx = crate::plugins::test_ctx("tool-load");
        ctx.config.lock().unwrap().lazy_tools = lazy;
        ctx
    }

    /// 关掉按需加载：一切照旧，全部工具都算「可见」
    #[test]
    fn disabled_lazy_loads_everything() {
        let ctx = ctx_with(false);
        assert!(is_loaded(&ctx, Some("s1"), "shell"));
        assert!(loaded(&ctx, Some("s1")).is_empty(), "未开启时不该有调取记录");
    }

    /// 开启后只有基础工具在架，调取一个才多一个，且按会话隔离
    #[test]
    fn lazy_loads_only_the_base_tool_per_session() {
        let ctx = ctx_with(true);
        assert!(is_loaded(&ctx, Some("s1"), "skill"), "skill 必须永远在架");
        assert!(!is_loaded(&ctx, Some("s1"), "shell"));
        load(&ctx, Some("s1"), "shell").unwrap();
        assert!(is_loaded(&ctx, Some("s1"), "shell"));
        assert!(!is_loaded(&ctx, Some("s2"), "shell"), "另一个会话没调取过");
        assert_eq!(loaded(&ctx, Some("s1")), vec!["shell".to_string()]);
        reset(&ctx, Some("s1"));
        assert!(!is_loaded(&ctx, Some("s1"), "shell"));
    }

    /// 调取返回完整 schema，让模型这一轮就知道怎么传参
    #[test]
    fn load_returns_the_full_schema() {
        let ctx = ctx_with(true);
        let r = load(&ctx, Some("s1"), "write_file").unwrap();
        assert_eq!(r["loaded"], "write_file");
        assert_eq!(r["parameters"]["required"], json!(["path", "content"]));
        // 注册表外的常驻能力同样能被调取
        assert_eq!(load(&ctx, Some("s1"), "memory").unwrap()["loaded"], "memory");
    }

    /// 不存在的名字、暂停的工具、闸门关闭的工具：都拒绝，且不留登记
    #[test]
    fn unknown_paused_and_gated_tools_are_refused() {
        let ctx = ctx_with(true);
        assert!(load(&ctx, Some("s1"), "nope_tool").unwrap_err().contains("nope_tool"));
        assert!(!is_loaded(&ctx, Some("s1"), "nope_tool"));
        ctx.tools.lock().unwrap().iter_mut().for_each(|t| {
            if t.name == "edit" {
                t.enabled = false;
            }
        });
        assert!(load(&ctx, Some("s1"), "edit").unwrap_err().contains("暂停"));
        // screen 受 tool_screen 闸门管（默认关）
        assert!(load(&ctx, Some("s1"), "screen").unwrap_err().contains("本机操控"));
    }

    /// 摘要必须压成一行且限长：索引是每轮都发的 token，不能把描述整段搬进去
    #[test]
    fn gist_stays_one_short_line() {
        let long = "Read live output of a background shell job while it runs. Pass the job_id returned by shell()";
        let g = gist(long);
        assert!(g.chars().count() <= GIST_CHARS + 1, "{g}");
        assert!(!g.contains('\n'));
        assert_eq!(gist("第一句。第二句不该出现"), "第一句");
    }

    /// 下发链路：开启后 tools 参数只剩 skill；调取一个才多一个
    #[test]
    fn tools_array_grows_only_after_loading() {
        let ctx = ctx_with(true);
        let names = |s: Option<&str>| {
            let mut v: Vec<String> = crate::ai::native_tool_defs(&ctx, s)
                .iter()
                .map(|d| d["name"].as_str().unwrap_or("").to_string())
                .collect();
            v.sort();
            v
        };
        assert_eq!(names(Some("s1")), vec!["skill".to_string()]);
        load(&ctx, Some("s1"), "shell").unwrap();
        assert_eq!(names(Some("s1")), vec!["shell".to_string(), "skill".to_string()]);
        assert_eq!(names(Some("s2")), vec!["skill".to_string()], "另一个会话不受影响");

        let off = ctx_with(false);
        assert!(
            crate::ai::native_tool_defs(&off, Some("s1")).len() > names(Some("s1")).len(),
            "关掉按需加载时应下发全部工具"
        );
    }

    /// 提示词：默认模板与「没留占位符的自定义模板」两条路都要能看到未调取索引
    #[test]
    fn prompt_shows_the_index_with_or_without_placeholder() {
        let ctx = ctx_with(true);
        let default_prompt = crate::ai::system_prompt(&ctx, Some("s1"));
        assert!(default_prompt.contains("NOT LOADED"), "默认模板应带索引");
        assert!(default_prompt.contains("load_tool"), "手册应说明怎么调取");

        // 自定义模板不含占位符（线上常见的兜底场景）
        ctx.config.lock().unwrap().system_prompt = "You are BIT. Be concise.".to_string();
        let custom = crate::ai::system_prompt(&ctx, Some("s1"));
        assert!(custom.contains("You are BIT. Be concise."), "{custom}");
        assert!(custom.contains("NOT LOADED"), "自定义模板也得补上索引段");

        // 关掉按需加载：索引段消失，全部工具回到完整一览
        ctx.config.lock().unwrap().lazy_tools = false;
        let off = crate::ai::system_prompt(&ctx, Some("s1"));
        assert!(!off.contains("NOT LOADED"), "关闭后不该再有索引段");
        assert!(off.contains("## Tool calls (text protocol)"), "关闭后提示词主体不变");
    }
}
