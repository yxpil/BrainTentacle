//! 插件体检 / 冲突检测（只读，不改任何东西）
//!
//! 单个插件合不合法由 `plugins::validate` 在 scan 阶段卡死（不过的插件整体不加载）。
//! 这里管的是另一类问题：**每个插件单看都没错，凑在一起或放到当前机器上就不工作**——
//! 两个插件抢同一个固定端口、工具名 sanitize 之后撞车、清单要用的运行时本机没装、
//! url 页面配了个不会自启的服务器（点开就是死页）等等。
//!
//! 结论只带结构化字段（level/code/plugins/item/value），文案在前端按 code 走 i18n，
//! 这样后端加检测项不用碰词典，词典也不会出现没人用的死键。

use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::plugins::{parse_schedule, sanitize, Plugin, Sched};

/// error = 会真的坏事（起不来 / 注册被覆盖 / 页面打不开）
/// warn  = 能跑但大概率不是作者想要的结果
/// info  = 提示，不打扰（折叠显示）
#[derive(Serialize, Clone, Debug)]
pub struct Finding {
    pub level: &'static str,
    pub code: &'static str,
    /// 涉及的插件 id（冲突项通常 2 个，环境问题 1 个）
    pub plugins: Vec<String>,
    /// 冲突对象本身：端口号 / 注册后的工具名 / 页面 id / 运行时 id
    pub item: String,
    /// 补充值：占了端口的服务名、被谁覆盖、重复文本片段
    pub value: String,
}

fn f(level: &'static str, code: &'static str, plugins: Vec<String>, item: impl Into<String>, value: impl Into<String>) -> Finding {
    Finding { level, code, plugins, item: item.into(), value: value.into() }
}

/// 一份体检输入。全部由 `diagnose` 从 Ctx 现取，纯数据结构便于单测。
pub struct Env<'a> {
    pub plugins: &'a [Plugin],
    /// scan 阶段被拒的目录（"<id>: <原因>"）
    pub scan_errs: &'a [String],
    pub disabled: &'a [String],
    pub tampered: &'a [String],
    /// 本机已启用运行时的 id 列表
    pub runtimes: &'a [String],
    /// 非插件来源的技能名（插件技能撞它会静默混在一起）
    pub host_skills: &'a [String],
    /// 用户自建服务（非插件）的名字+端口：插件固定端口撞它算被占用
    pub host_ports: &'a [(String, u16)],
    /// 当前有托管进程在跑的插件 id
    pub running: &'a [String],
    /// 端口连通性探测（单测里换成假实现，避免测试依赖网络栈）
    pub probe: fn(u16) -> bool,
}

/// 启用且未被判篡改 = 真的会往注册表里注入能力，只有它们参与冲突判定。
/// 停用的插件不占端口不注册工具，报它的冲突纯属噪音。
fn is_live(p: &Plugin, env: &Env) -> bool {
    !env.disabled.iter().any(|d| d == &p.id) && !env.tampered.iter().any(|t| t == &p.id)
}

fn dedup(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v.dedup();
    v
}

fn has_perm(p: &Plugin, perm: &str) -> bool {
    crate::plugins::has_perm(p, perm)
}

pub fn check(env: &Env) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();
    let live: Vec<&Plugin> = env.plugins.iter().filter(|p| is_live(p, env)).collect();

    // ---------- 清单本身不合格 / 内容被改 ----------
    for e in env.scan_errs {
        let (pid, msg) = match e.split_once(": ") {
            Some((a, b)) => (a.to_string(), b.to_string()),
            None => (String::new(), e.clone()),
        };
        let plugins = if pid.is_empty() { vec![] } else { vec![pid] };
        out.push(f("error", "scanError", plugins, "", msg));
    }
    for id in env.tampered {
        out.push(f("error", "tampered", vec![id.clone()], id.clone(), ""));
    }

    // ---------- 端口 ----------
    let mut by_port: HashMap<u16, Vec<String>> = HashMap::new();
    for p in &live {
        if let Some(sv) = &p.server {
            if sv.port != 0 {
                by_port.entry(sv.port).or_default().push(p.id.clone());
            }
        }
    }
    let mut ports: Vec<u16> = by_port.keys().copied().collect();
    ports.sort_unstable();
    for port in ports {
        let ids = by_port[&port].clone();
        if port < 1024 {
            out.push(f("warn", "portPrivileged", ids.clone(), port.to_string(), ""));
        }
        if ids.len() > 1 {
            let who = ids.join(" / ");
            out.push(f("error", "portConflict", ids, port.to_string(), who));
            continue;
        }
        // 单插件独占端口：先看是不是已经被别人占了（外部进程 / 用户自建服务）
        if (env.probe)(port) {
            out.push(f("error", "portTaken", ids, port.to_string(), ""));
        } else if let Some((who, _)) = env.host_ports.iter().find(|(_, wp)| *wp == port) {
            out.push(f("error", "portTaken", ids, port.to_string(), who.clone()));
        }
    }

    // ---------- 注册名撞车 ----------
    // 工具进注册表的名字是 p_<插件id>_<工具名>（都过 sanitize），
    // 所以 "a-b" 与 "a_b" 两个目录下的同名工具会塌成一个，后注册的被静默盖掉。
    let mut by_tool: HashMap<String, Vec<String>> = HashMap::new();
    for p in &live {
        for t in &p.tools {
            by_tool
                .entry(format!("p_{}_{}", sanitize(&p.id), sanitize(&t.name)))
                .or_default()
                .push(p.id.clone());
        }
    }
    let mut tool_keys: Vec<String> = by_tool.keys().cloned().collect();
    tool_keys.sort();
    for name in tool_keys {
        let ids = dedup(by_tool[&name].clone());
        if ids.len() > 1 || by_tool[&name].len() > 1 {
            out.push(f("error", "toolClash", ids, name, ""));
        }
    }

    // 技能名不命名空间化，直接进技能列表：撞了别的插件 = 两条同名，撞了本机已有 = 混在一起
    let mut by_skill: HashMap<String, Vec<String>> = HashMap::new();
    for p in &live {
        for sk in &p.skills {
            by_skill.entry(sk.name.trim().to_lowercase()).or_default().push(p.id.clone());
        }
    }
    let mut skill_keys: Vec<String> = by_skill.keys().cloned().collect();
    skill_keys.sort();
    for key in skill_keys {
        let ids = dedup(by_skill[&key].clone());
        if ids.len() > 1 {
            out.push(f("warn", "skillClash", ids, key, ""));
        } else if env.host_skills.iter().any(|s| s.trim().to_lowercase() == key) {
            out.push(f("warn", "skillClash", ids, key, "host"));
        }
    }

    // 页面：同一插件内 page id 重复 → 导航 key <pid>:<pageId> 撞车，第二条永远进不去
    let mut by_label: HashMap<String, Vec<String>> = HashMap::new();
    for p in &live {
        let mut seen: HashMap<&str, u32> = HashMap::new();
        for pg in &p.pages {
            *seen.entry(pg.id.as_str()).or_default() += 1;
            by_label.entry(pg.label.trim().to_lowercase()).or_default().push(p.id.clone());
            // url 型页面依赖插件服务器；服务器不自启 = 用户点开就是"服务器未运行"
            let uses_url = pg.url.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
            if uses_url && p.server.as_ref().map(|s| !s.auto_start).unwrap_or(false) {
                out.push(f("warn", "pageNoServer", vec![p.id.clone()], pg.id.clone(), ""));
            }
        }
        for (pid, n) in seen {
            if n > 1 {
                out.push(f("error", "pageIdDup", vec![p.id.clone()], pid.to_string(), ""));
            }
        }
    }
    let mut labels: Vec<String> = by_label.keys().cloned().collect();
    labels.sort();
    for lb in labels {
        let ids = dedup(by_label[&lb].clone());
        if ids.len() > 1 {
            out.push(f("info", "pageLabelDup", ids, lb, ""));
        }
    }

    // ---------- 环境依赖 ----------
    let runtime_ok = |r: &str| env.runtimes.iter().any(|x| x == r);
    let mut missing: HashMap<String, Vec<String>> = HashMap::new();
    for p in &live {
        for t in &p.tools {
            if t.kind != "script" && !t.runtime.trim().is_empty() && !runtime_ok(t.runtime.trim()) {
                missing.entry(t.runtime.trim().to_string()).or_default().push(p.id.clone());
            }
        }
        for j in &p.jobs {
            let r = j.runtime.trim();
            if !r.is_empty() && !runtime_ok(r) {
                missing.entry(r.to_string()).or_default().push(p.id.clone());
            }
        }
        if let Some(sv) = &p.server {
            let r = sv.runtime.trim();
            if !r.is_empty() && r != "custom" && !runtime_ok(r) {
                missing.entry(r.to_string()).or_default().push(p.id.clone());
            }
        }
    }
    let mut rts: Vec<String> = missing.keys().cloned().collect();
    rts.sort();
    for rt in rts {
        out.push(f("error", "runtimeMissing", dedup(missing[&rt].clone()), rt, ""));
    }

    // ---------- 跑得动但不对劲 ----------
    for p in &live {
        for j in &p.jobs {
            if let Some(Sched::Every(d)) = parse_schedule(&j.schedule) {
                if d < Duration::from_secs(30) {
                    out.push(f("warn", "jobTooFast", vec![p.id.clone()], format!("{} · {}", j.name, j.schedule), ""));
                }
            }
        }
        let nothing = p.tools.is_empty()
            && p.prompts.is_empty()
            && p.skills.is_empty()
            && p.memories.is_empty()
            && p.jobs.is_empty()
            && p.pages.is_empty()
            && p.server.is_none()
            && p.ui.is_none();
        if nothing {
            out.push(f("info", "emptyPlugin", vec![p.id.clone()], p.name.clone(), ""));
        }
        for perm in &["js", "invoke", "chat", "server", "exec", "write"] {
            if has_perm(p, perm) {
                out.push(f("info", "permNote", vec![p.id.clone()], (*perm).to_string(), ""));
            }
        }
    }

    // 插件目录已停用/已删除，托管进程还在跑
    for id in env.running {
        let known_live = env.plugins.iter().any(|p| &p.id == id && is_live(p, env));
        if !known_live {
            out.push(f("warn", "orphanServer", vec![id.clone()], id.clone(), ""));
        }
    }

    // ---------- 重名与重复注入 ----------
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    for p in &live {
        by_name.entry(p.name.trim().to_lowercase()).or_default().push(p.id.clone());
    }
    let mut names: Vec<String> = by_name.keys().cloned().collect();
    names.sort();
    for nm in names {
        let ids = dedup(by_name[&nm].clone());
        if ids.len() > 1 {
            out.push(f("info", "nameDup", ids, nm, ""));
        }
    }
    dup_text(&mut out, "promptDup", &live, |p| &p.prompts);
    dup_text(&mut out, "memoryDup", &live, |p| &p.memories);

    // error 在前、warn 居中、info 沉底，同级按 code 再按插件名，保证顺序稳定可断言
    let rank = |l: &str| match l {
        "error" => 0u8,
        "warn" => 1,
        _ => 2,
    };
    out.sort_by(|a, b| {
        rank(a.level)
            .cmp(&rank(b.level))
            .then_with(|| a.code.cmp(b.code))
            .then_with(|| a.item.cmp(&b.item))
            .then_with(|| a.plugins.join(",").cmp(&b.plugins.join(",")))
    });
    out
}

/// 同一段文本被两个插件重复注入：不报错，但白占上下文
/// 文本按"先注册的那份"报（大小写归一只用于判重），这样同一个包组合每次体检输出同一条文案
fn dup_text(out: &mut Vec<Finding>, code: &'static str, live: &[&Plugin], pick: fn(&Plugin) -> &Vec<String>) {
    let mut seen: HashMap<String, (String, String)> = HashMap::new();
    for p in live {
        for it in pick(p) {
            let key = it.trim().to_lowercase();
            if key.is_empty() {
                continue;
            }
            match seen.get(&key) {
                Some((first, prev_id)) if prev_id != &p.id => {
                    out.push(f("info", code, vec![prev_id.clone(), p.id.clone()], snippet(first), ""))
                }
                Some(_) => {}
                None => {
                    seen.insert(key, (it.trim().to_string(), p.id.clone()));
                }
            }
        }
    }
}

/// 重复文本只露个头，面板里看得懂是谁和谁重了就行
fn snippet(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() > 36 {
        format!("{}…", t.chars().take(36).collect::<String>())
    } else {
        t.to_string()
    }
}

/// 127.0.0.1 上有没有人在听这个端口：连得上就算被占
fn port_listening(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok()
}

/// 从 Ctx 现场取输入并跑一遍体检。返回 findings + 分级计数，供插件页直接渲染。
pub fn diagnose(ctx: &Arc<crate::state::Ctx>) -> serde_json::Value {
    let (plugins, errs) = crate::plugins::scan(ctx);
    let disabled = ctx.config.lock().unwrap().disabled_plugins.clone();
    let enabled_refs: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
    let tampered = crate::plugins::tampered_ids(ctx, &enabled_refs);
    let runtimes: Vec<String> = ctx
        .runtimes
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.enabled)
        .map(|r| r.id.clone())
        .collect();
    let host_skills: Vec<String> = ctx
        .skills
        .lock()
        .unwrap()
        .iter()
        .filter(|s| !s.source.starts_with("plugin:"))
        .map(|s| s.name.clone())
        .collect();
    let host_ports: Vec<(String, u16)> = crate::workwith::load_entries(ctx)
        .into_iter()
        .filter(|e| !e.id.starts_with("plugin:") && e.port > 0)
        .map(|e| (e.name.clone(), e.port))
        .collect();
    let running: Vec<String> = crate::workwith::running_ids_with_prefix("plugin:")
        .into_iter()
        .map(|k| k.trim_start_matches("plugin:").to_string())
        .collect();
    let env = Env {
        plugins: &plugins,
        scan_errs: &errs,
        disabled: &disabled,
        tampered: &tampered,
        runtimes: &runtimes,
        host_skills: &host_skills,
        host_ports: &host_ports,
        running: &running,
        probe: port_listening,
    };
    let findings = check(&env);
    let n = |lvl: &str| findings.iter().filter(|x| x.level == lvl).count();
    serde_json::json!({
        "findings": findings,
        "error": n("error"),
        "warn": n("warn"),
        "info": n("info"),
        "plugins": plugins.len(),
        "live": plugins.iter().filter(|p| is_live(p, &env)).count(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全空默认输入，每个用例只填自己关心的那几项
    #[derive(Default)]
    struct Case {
        plugins: Vec<Plugin>,
        errs: Vec<String>,
        disabled: Vec<String>,
        tampered: Vec<String>,
        runtimes: Vec<String>,
        host_skills: Vec<String>,
        host_ports: Vec<(String, u16)>,
        running: Vec<String>,
    }

    impl Case {
        fn env(&self) -> Env<'_> {
            Env {
                plugins: &self.plugins,
                scan_errs: &self.errs,
                disabled: &self.disabled,
                tampered: &self.tampered,
                runtimes: &self.runtimes,
                host_skills: &self.host_skills,
                host_ports: &self.host_ports,
                running: &self.running,
                probe: |_| false,
            }
        }
        fn out(&self) -> Vec<Finding> {
            check(&self.env())
        }
        fn codes(&self) -> Vec<&'static str> {
            self.out().iter().map(|x| x.code).collect()
        }
    }

    fn p(raw: &str) -> Plugin {
        serde_json::from_str(raw).unwrap()
    }

    fn srv(id: &str, port: u16) -> Plugin {
        p(&format!(
            r#"{{"id":"{id}","name":"{id}","permissions":["server"],"server":{{"runtime":"node","program":"s.js","port":{port}}}}}"#
        ))
    }

    #[test]
    fn two_plugins_on_one_fixed_port_names_both() {
        let c = Case {
            plugins: vec![srv("alpha", 3050), srv("beta", 3050)],
            runtimes: vec!["node".into()],
            ..Default::default()
        };
        let hit = c.out().into_iter().find(|x| x.code == "portConflict").expect("portConflict");
        assert_eq!(hit.level, "error");
        assert_eq!(hit.item, "3050");
        assert_eq!(hit.plugins, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn port_taken_by_host_service_or_by_a_live_listener() {
        let c = Case {
            plugins: vec![srv("alpha", 8080)],
            runtimes: vec!["node".into()],
            host_ports: vec![("local nginx".into(), 8080)],
            ..Default::default()
        };
        let hit = c.out().into_iter().find(|x| x.code == "portTaken").expect("host service");
        assert_eq!(hit.value, "local nginx");
        // 清单外的进程在听同一个端口，也要报出来
        let none: Vec<(String, u16)> = vec![];
        let mut e = c.env();
        e.host_ports = &none;
        e.probe = |_| true;
        assert!(check(&e).iter().any(|x| x.code == "portTaken"));
    }

    #[test]
    fn disabled_plugins_do_not_claim_the_port_and_low_ports_warn() {
        let c = Case {
            plugins: vec![srv("alpha", 80), srv("beta", 80)],
            disabled: vec!["beta".into()],
            runtimes: vec!["node".into()],
            ..Default::default()
        };
        let got = c.codes();
        assert!(!got.contains(&"portConflict"), "停用的不该参与撞车: {got:?}");
        assert!(got.contains(&"portPrivileged"), "1024 以下要提示: {got:?}");
    }

    #[test]
    fn tool_names_collapse_after_sanitize_across_dirs() {
        // 目录 a-b 与 a_b sanitize 后同为 a_b，两边同名工具会塌成一条
        let c = Case {
            plugins: vec![
                p(r#"{"id":"a-b","name":"A B","tools":[{"name":"look","runtime":"node","code":"1"}]}"#),
                p(r#"{"id":"a_b","name":"A Und","tools":[{"name":"look","runtime":"node","code":"1"}]}"#),
            ],
            runtimes: vec!["node".into()],
            ..Default::default()
        };
        let hit = c.out().into_iter().find(|x| x.code == "toolClash").expect("toolClash");
        assert_eq!(hit.item, "p_a_b_look");
        assert_eq!(hit.plugins.len(), 2);
    }

    #[test]
    fn duplicate_tool_name_inside_one_plugin_also_clashes() {
        let c = Case {
            plugins: vec![p(
                r#"{"id":"alpha","name":"Alpha","tools":[{"name":"look","runtime":"node","code":"1"},{"name":"look","runtime":"node","code":"2"}]}"#,
            )],
            runtimes: vec!["node".into()],
            ..Default::default()
        };
        let hit = c.out().into_iter().find(|x| x.code == "toolClash").expect("toolClash");
        assert_eq!(hit.plugins, vec!["alpha".to_string()]);
    }

    #[test]
    fn missing_runtime_dead_page_and_too_fast_job() {
        let c = Case {
            plugins: vec![p(r#"{"id":"alpha","name":"Alpha","permissions":["page","server"],
                "tools":[{"name":"t","runtime":"deno","code":"1"}],
                "jobs":[{"name":"tick","schedule":"every 5s","runtime":"node","code":"1"}],
                "server":{"runtime":"node","program":"s.js","auto_start":false},
                "pages":[{"id":"ui","label":"UI","url":"/x"}]}"#)],
            runtimes: vec!["node".into()],
            ..Default::default()
        };
        let got = c.codes();
        assert!(got.contains(&"runtimeMissing"), "工具要 deno，本机没有: {got:?}");
        assert!(got.contains(&"jobTooFast"), "5 秒一轮要提醒: {got:?}");
        assert!(got.contains(&"pageNoServer"), "url 页配不自启服务器 = 死页: {got:?}");
        assert!(!got.contains(&"emptyPlugin"), "有内容的不算空插件: {got:?}");
    }

    #[test]
    fn scan_errors_and_tamper_lead_the_list() {
        let c = Case {
            plugins: vec![p(r#"{"id":"alpha","name":"Alpha","skills":[{"name":"Grep files"}]}"#)],
            errs: vec!["broken: unknown permission: root".into()],
            tampered: vec!["alpha".into()],
            host_skills: vec!["grep files".into()],
            ..Default::default()
        };
        let out = c.out();
        assert_eq!(out[0].code, "scanError");
        assert_eq!(out[0].level, "error");
        assert_eq!(out[0].plugins, vec!["broken".to_string()]);
        assert!(out.iter().any(|x| x.code == "tampered"));
        // alpha 被判篡改 → 按停用处理，它的技能不参与撞车判定
        assert!(!out.iter().any(|x| x.code == "skillClash"));
    }

    #[test]
    fn skill_page_label_and_orphan_findings() {
        let c = Case {
            plugins: vec![
                p(r#"{"id":"alpha","name":"Alpha","skills":[{"name":"Daily note"}],
                   "pages":[{"id":"ui","label":"panel","src":"a.html"},{"id":"ui","label":"panel2","src":"b.html"}]}"#),
                p(r#"{"id":"beta","name":"Alpha","skills":[{"name":"daily NOTE"}],
                   "pages":[{"id":"x","label":"panel","src":"c.html"}]}"#),
            ],
            running: vec!["ghost".into()],
            ..Default::default()
        };
        let out = c.out();
        let got: Vec<&str> = out.iter().map(|x| x.code).collect();
        assert!(got.contains(&"skillClash"), "{got:?}");
        assert!(got.contains(&"pageIdDup"), "{got:?}");
        assert!(got.contains(&"pageLabelDup"), "{got:?}");
        assert!(got.contains(&"nameDup"), "{got:?}");
        let orphan = out.iter().find(|x| x.code == "orphanServer").expect("orphan");
        assert_eq!(orphan.level, "warn");
        assert_eq!(orphan.plugins, vec!["ghost".to_string()]);
        let pid = out.iter().find(|x| x.code == "pageIdDup").unwrap();
        assert_eq!(pid.item, "ui");
    }

    #[test]
    fn empty_plugin_and_perm_notes_stay_info() {
        let c = Case {
            plugins: vec![p(r#"{"id":"alpha","name":"Alpha","permissions":["js","invoke","chat","css"]}"#)],
            ..Default::default()
        };
        let out = c.out();
        assert!(out.iter().any(|x| x.code == "emptyPlugin" && x.level == "info"));
        let perms: Vec<&str> = out.iter().filter(|x| x.code == "permNote").map(|x| x.item.as_str()).collect();
        assert_eq!(perms, vec!["chat", "invoke", "js"]); // css/page 不算风险，不提示
        assert!(out.iter().all(|x| x.level != "error"));
    }

    #[test]
    fn duplicated_prompt_text_between_plugins() {
        let c = Case {
            plugins: vec![
                p(r#"{"id":"alpha","name":"Alpha","prompts":["Always answer in haiku."]}"#),
                p(r#"{"id":"beta","name":"Beta","prompts":["always answer in haiku.","unique line"]}"#),
            ],
            ..Default::default()
        };
        let hit = c.out().into_iter().find(|x| x.code == "promptDup").expect("promptDup");
        assert_eq!(hit.plugins, vec!["alpha".to_string(), "beta".to_string()]);
        assert_eq!(hit.item, "Always answer in haiku.");
    }

    #[test]
    fn no_plugins_yields_no_findings() {
        assert!(Case::default().out().is_empty());
    }
}
