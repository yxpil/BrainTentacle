// yxpil · BIT
//! 外部连接服务：插件清单 `connections[]`（权限位 `net`）声明的远端 MCP 服务器。
//!
//! 与 `services[]`（WorkWith 托管）的分工正好相反：
//!   services   —— BIT 拉起本机进程，端口就绪后接管它
//!   connections —— 进程在别处跑（SaaS 网关、公司内网、另一台机器），BIT 只连过去
//!
//! 密钥不进包：URL 与认证头都能写 `{setting:KEY}` 占位，连接当时从**本插件自己的设置**
//! 取值（`plugin_settings`，键名带 `<插件id>/` 前缀）。所以插件包里最多写着
//! `"Authorization": "Bearer {setting:token}"`，令牌本体由用户在设置中心填，
//! 卸载插件时随设置一起清；MCP 列表对外也只回头名，不回显值。
//!
//! 生命周期：
//!   scan/sync  → prune：插件停用、net 位关掉、清单里删了这条 → MCP 条目连同导入的工具一起收回
//!   启用/授权  → auto_connect_plugin：auto_connect 且设置齐了才连，缺值只在日志里点名要填哪几项
//!   手动连接   → connect：握手 → 登记 MCP 条目 → 导入工具（工具描述里带上服务器名）；
//!                 握手成功却拉不到工具 = 报出来并把条目置灰，不留一个"看着连着其实没工具"的空壳
//!   手动断开   → disconnect：条目置灰、清会话、导入的工具摘掉（清单声明还在，随时能再连）
//!
//! 作者拿得到的只有自己的连接（能力 verb 的 id 前缀闸门见 plugin_caps::target_id）。
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::plugins::{Plugin, PluginConnection};
use crate::state::Ctx;

/// 插件声明式 MCP 条目的 id 标记（`pmcp-<插件id>-<连接名>`，与 WorkWith 的 `ww-` 并列）
pub const CONN_ID_MARK: &str = "pmcp-";
/// 清单里声明的连接数上限：一个插件揽十几条外部服务，用户根本管不过来
const MAX_CONNECTIONS: usize = 8;
/// 单条连接的自定义头数上限
const MAX_HEADERS: usize = 8;

/// 插件侧的 MCP 条目 id（稳定：重启、重连都不换 id，导入的工具不会成对残留）
pub fn conn_id(plugin_id: &str, name: &str) -> String {
    format!("{CONN_ID_MARK}{}-{}", crate::plugins::sanitize(plugin_id), crate::plugins::sanitize(name))
}

/// 某插件全部连接条目的公共前缀（能力层的归属闸门用）
pub fn conn_prefix(plugin_id: &str) -> String {
    format!("{CONN_ID_MARK}{}-", crate::plugins::sanitize(plugin_id))
}

/// 这条 MCP 条目是不是插件声明出来的（是的话工具页不能手动暂停/移除，生命周期归插件）
pub fn is_declared(server: &crate::mcp::McpServer) -> bool {
    !server.plugin_id.is_empty()
}

// ── {setting:KEY} 模板 ──

/// 模板占位：`{setting:token}`、`https://host/{setting:region}/mcp` 都认。
/// 返回替换后的串与取不到值的键名列表（缺失不当即失败：调用方按 missing 报错，
/// 界面能指名道姓让用户去填哪几项设置）
pub fn expand(tpl: &str, settings: &HashMap<String, String>) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut missing: Vec<String> = Vec::new();
    // 全程按 char 走：URL 里出现中文（IDN 域名）时，按字节下标切串会直接 panic
    let chars: Vec<char> = tpl.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '{' {
            if let Some(end) = placeholder_end(&chars, i) {
                let key: String = chars[i + PREFIX_LEN..end].iter().collect();
                match settings.get(key.trim()) {
                    Some(v) if !v.trim().is_empty() => out.push_str(v.trim()),
                    _ => {
                        let k = key.trim().to_string();
                        if !missing.contains(&k) {
                            missing.push(k);
                        }
                        // 取不到值就留空位，别让相邻片段拼成一条看起来合法的地址
                    }
                }
                i = end + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    (out, missing)
}

/// 占位前缀：只认这一段，其余花括号不算模板
const PLACEHOLDER_PREFIX: &str = "{setting:";
const PREFIX_LEN: usize = 9; // "{setting:" 的字符数

/// 从 `{` 起是不是一个合法写法的占位，是则给出闭合 `}` 的下标
fn placeholder_end(chars: &[char], start: usize) -> Option<usize> {
    if chars.len() < start + PREFIX_LEN {
        return None;
    }
    let head: String = chars[start..start + PREFIX_LEN].iter().collect();
    if head != PLACEHOLDER_PREFIX {
        return None;
    }
    let close = (start + PREFIX_LEN..chars.len()).find(|&j| chars[j] == '}')?;
    let key: String = chars[start + PREFIX_LEN..close].iter().collect();
    let key = key.trim();
    if key.is_empty() || key.chars().count() > 64 {
        return None;
    }
    Some(close)
}

/// 占位写法是否合法：`{` 必须开成 `{setting:键}`——漏闭合、键名为空、
/// 想写占位却漏了 `setting:` 都算清单写坏，扫描期就拒收
pub fn template_ok(raw: &str) -> bool {
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '{' {
            let Some(end) = placeholder_end(&chars, i) else { return false };
            i = end + 1;
            continue;
        }
        i += 1;
    }
    true
}

/// 清单原文里出现的所有设置键（插件页提示「要先填这几项」）
pub fn template_keys(raw: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '{' {
            if let Some(end) = placeholder_end(&chars, i) {
                let key: String = chars[i + PREFIX_LEN..end].iter().collect();
                let k = key.trim().to_string();
                if !keys.contains(&k) {
                    keys.push(k);
                }
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    keys
}

/// 这条连接一共要看哪几项设置（URL 与每个头的占位并起来、去重）
fn template_deps(c: &PluginConnection) -> Vec<String> {
    let mut keys = template_keys(&c.url);
    for v in c.headers.values() {
        for k in template_keys(v) {
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
    }
    keys
}

/// 解析后的 URL 硬闸门：只收 http(s)、不许内嵌账号密码、长度有界。
/// 连接当时对**展开之后**的值判定——设置里被人填成 file:// 或带凭据的串也拦得住
pub fn url_ok(url: &str) -> Result<(), String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("url is empty".into());
    }
    if u.len() > 2048 {
        return Err("url too long (max 2048 chars)".into());
    }
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("url must be http(s) (got \"{}\")", scheme_of(u)));
    }
    // `http://user:pass@host/` 这种把令牌写进地址的写法：改用请求头传，
    // 否则凭据会跟着 URL 出现在界面、日志与审计里
    let after_scheme = &u[u.find("://").map(|i| i + 3).unwrap_or(0)..];
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err("url must not embed credentials (use headers for the token)".into());
    }
    Ok(())
}

fn scheme_of(url: &str) -> String {
    match url.find("://") {
        Some(i) => url[..i].to_string(),
        None => "no scheme".to_string(),
    }
}

// ── 生效连接的解析结果 ──

/// 一条当前合法（插件启用 + 未篡改 + net 位在）的连接，以及它展开后的实际参数
pub struct Resolved {
    pub plugin_id: String,
    pub plugin_name: String,
    pub id: String,
    pub conn: PluginConnection,
    pub url: String,
    pub headers: HashMap<String, String>,
    /// 取不到值的设置键（这些连接连不上，界面上要指名道姓提醒去填）
    pub missing: Vec<String>,
}

/// 展示名：清单 label 优先，回退连接名
pub fn display_label(c: &PluginConnection) -> String {
    if c.label.trim().is_empty() { c.name.trim().to_string() } else { c.label.trim().to_string() }
}

/// 展开清单里的 URL 与头（本插件设置取值）
fn resolve_one(ctx: &Arc<Ctx>, p: &Plugin, c: &PluginConnection) -> Resolved {
    let settings = crate::plugin_caps::settings_strings(ctx, &p.id);
    let (url, mut missing) = expand(&c.url, &settings);
    let mut headers = HashMap::new();
    for (k, v) in &c.headers {
        let (val, miss) = expand(v, &settings);
        for m in miss {
            if !missing.contains(&m) {
                missing.push(m);
            }
        }
        headers.insert(k.clone(), val);
    }
    Resolved {
        plugin_id: p.id.clone(),
        plugin_name: p.name.clone(),
        id: conn_id(&p.id, &c.name),
        conn: c.clone(),
        url: url.trim().trim_end_matches('/').to_string(),
        headers,
        missing,
    }
}

/// 全部生效连接（清单校验在 scan 期已挡下不合格的，这里只看启用与权限）
pub fn resolved_all(ctx: &Arc<Ctx>) -> Vec<Resolved> {
    let mut out = Vec::new();
    for p in crate::plugins::enabled_plugins(ctx) {
        if !crate::plugins::has_grant(ctx, &p, "net") {
            continue;
        }
        for c in &p.connections {
            out.push(resolve_one(ctx, &p, c));
        }
    }
    out
}

/// 某个插件的生效连接
pub fn resolved_of(ctx: &Arc<Ctx>, plugin_id: &str) -> Vec<Resolved> {
    let Some(p) = crate::plugins::enabled_plugin(ctx, plugin_id) else { return Vec::new() };
    if !crate::plugins::has_grant(ctx, &p, "net") {
        return Vec::new();
    }
    p.connections.iter().map(|c| resolve_one(ctx, &p, c)).collect()
}

/// 这条连接目前注册在案的工具数（不区分是这次导入的还是上次就在）
fn count_tools(ctx: &Arc<Ctx>, server_id: &str) -> usize {
    ctx.tools
        .lock()
        .unwrap()
        .iter()
        .filter(|t| matches!(&t.kind, crate::registry::ToolKind::Mcp { server_id: sid, .. } if sid == server_id))
        .count()
}

/// 给插件详情页与能力层的连接状态（不含任何密钥值）。
/// 入参是清单里的插件本体而不是「已启用的插件」：停用状态下用户照样要看得见
/// 它声明了哪些外部服务，只是连不上（granted=false）
pub fn status_for(ctx: &Arc<Ctx>, p: &Plugin, granted: bool) -> Vec<serde_json::Value> {
    let list = ctx.mcp.lock().unwrap().clone();
    let settings = crate::plugin_caps::settings_strings(ctx, &p.id);
    p.connections
        .iter()
        .map(|c| {
            // 缺值要把 URL 与每个头一起算：网关类连接十有八九是令牌写在头里，
            // 只看 URL 会报"什么都不缺"，用户对着一个连不上的按钮摸不着头脑
            let mut missing = expand(&c.url, &settings).1;
            for v in c.headers.values() {
                for k in expand(v, &settings).1 {
                    if !missing.contains(&k) {
                        missing.push(k);
                    }
                }
            }
            let url = expand(&c.url, &settings).0;
            let server = list.iter().find(|s| s.id == conn_id(&p.id, &c.name));
            let connected = granted && server.as_ref().map(|s| s.enabled).unwrap_or(false);
            let tools = count_tools(ctx, &conn_id(&p.id, &c.name));
            json!({
                "id": conn_id(&p.id, &c.name),
                "name": c.name,
                "label": display_label(c),
                // 清单原文：占位符不是密钥，可以原样摊给用户看
                "url_template": c.url,
                // 展开后的实际地址（设置值本身不外泄，缺值的位置留空）
                "url": url,
                "header_names": c.headers.keys().cloned().collect::<Vec<_>>(),
                "needs_settings": template_deps(c),
                "auto_connect": c.auto_connect,
                "missing_settings": missing,
                "granted": granted,
                "connected": connected,
                "server_name": server.as_ref().map(|s| s.name.clone()).unwrap_or_default(),
                "tools": tools,
                "connected_at": server.as_ref().map(|s| s.connected_at.clone()).unwrap_or_default(),
            })
        })
        .collect()
}

/// 已启用插件的连接状态（能力 verb 用：能调到这条能力的插件必然是启用且 net 位在的）
pub fn status(ctx: &Arc<Ctx>, plugin_id: &str) -> Vec<serde_json::Value> {
    match crate::plugins::enabled_plugin(ctx, plugin_id) {
        Some(p) => status_for(ctx, &p, crate::plugins::has_grant(ctx, &p, "net")),
        None => Vec::new(),
    }
}

// ── 连接 / 断开 ──

/// 连上一条声明式外部 MCP：握手 → 登记条目 → 导入工具。
/// 已经连着且配置没变的直接复用（幂等：启动、启用插件、手动点按钮都走这里）
pub async fn connect(ctx: &Arc<Ctx>, plugin_id: &str, name: &str) -> Result<serde_json::Value, String> {
    let p = crate::plugins::enabled_plugin(ctx, plugin_id).ok_or("插件未启用或安全校验未通过")?;
    if !crate::plugins::has_grant(ctx, &p, "net") {
        return Err("外部连接权限已被单独关闭：在插件详情里重新打开后再连接".into());
    }
    let want = crate::plugins::sanitize(name);
    let c = p
        .connections
        .iter()
        .find(|c| c.name == name || crate::plugins::sanitize(&c.name) == want)
        .ok_or_else(|| format!("插件未声明外部连接 {name}"))?;
    let r = resolve_one(ctx, &p, c);
    if !r.missing.is_empty() {
        return Err(format!(
            "先在本插件的设置里填好这几项：{}（密钥只留在设置里，不进插件包）",
            r.missing.join(", ")
        ));
    }
    url_ok(&r.url).map_err(|e| format!("连接 {} 的地址不可用: {e}", c.name))?;

    let http = crate::mcp::http_client(&r.url)?;
    let (srv_name, version, protocol, session) =
        crate::mcp::initialize(&http, &r.url, &r.headers).await.map_err(|e| {
            let hint = if e.contains("401") || e.contains("Unauthorized") { "（认证被拒：检查令牌设置）" } else { "" };
            format!("握手 {0} 失败: {e}{hint}", r.url)
        })?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    {
        let mut list = ctx.mcp.lock().unwrap();
        match list.iter_mut().find(|s| s.id == r.id) {
            Some(s) => {
                s.name = srv_name.clone();
                s.url = r.url.clone();
                s.transport = crate::mcp::McpTransport::Http;
                s.version = version;
                s.protocol = protocol;
                s.session = session;
                s.headers = r.headers.clone();
                s.plugin_id = p.id.clone();
                s.enabled = true;
                s.connected_at = now;
            }
            None => list.push(crate::mcp::McpServer {
                id: r.id.clone(),
                name: srv_name.clone(),
                url: r.url.clone(),
                transport: crate::mcp::McpTransport::Http,
                command: Default::default(),
                args: Default::default(),
                env: Default::default(),
                headers: r.headers.clone(),
                plugin_id: p.id.clone(),
                version,
                protocol,
                session,
                enabled: true,
                connected_at: now,
            }),
        }
    }
    ctx.save_mcp();
    // 握手成功却拉不到工具 = 这条服务实际用不了（多半是认证在 tools/list 这一跳被拒）。
    // 不能留着 enabled=true 的空条目：AI 侧看不到工具，用户以为连着，谁都不知道自己没连上
    // 重连/换令牌后再点一次连接是常见动作，工具那时通常已经在注册中心里。
    // 所以报「当前可用工具数」而不是「这次新登记了几条」，否则会出现
    // 「明明连着、界面说导入了 0 个」这种自相矛盾的话
    let imported = match crate::mcp::import_server_tools(ctx, &r.id).await {
        Ok(_) => count_tools(ctx, &r.id),
        Err(err) => {
            if let Some(s) = ctx.mcp.lock().unwrap().iter_mut().find(|s| s.id == r.id) {
                s.enabled = false;
                s.session.clear();
            }
            ctx.save_mcp();
            crate::audit::record(
                ctx,
                "local-app",
                "plugin.net-failed",
                &format!("{} · {}", p.name, display_label(c)),
                json!({ "url": crate::netproxy::redact_url(&r.url), "error": err }),
                false,
            );
            return Err(format!("握手成功但取不到工具清单: {err}"));
        }
    };
    ctx.emit("tools-updated", json!({ "server_id": r.id }));
    ctx.emit("plugin-net", json!({ "phase": "connected", "plugin_id": plugin_id, "id": r.id, "imported": imported }));
    crate::audit::record(
        ctx,
        "local-app",
        "plugin.net-connect",
        &format!("{} · {}", p.name, display_label(c)),
        json!({ "url": crate::netproxy::redact_url(&r.url), "headers": r.headers.keys().collect::<Vec<_>>(), "imported": imported }),
        true,
    );
    Ok(json!({ "id": r.id, "server": srv_name, "connected": true, "imported": imported }))
}

/// 断开一条连接：条目置灰 + 清会话 + 摘掉导入的工具，清单声明原样留着（随时能再连）
pub fn disconnect(ctx: &Arc<Ctx>, plugin_id: &str, name: &str) -> Result<serde_json::Value, String> {
    let id = conn_id(plugin_id, name);
    let found = {
        let mut list = ctx.mcp.lock().unwrap();
        match list.iter_mut().find(|s| s.id == id) {
            Some(s) => {
                s.enabled = false;
                s.session.clear();
                Some(s.name.clone())
            }
            None => None,
        }
    };
    // 从未连过：没什么可收的，直接报成功（幂等，停用插件时的清理也走这里）
    let Some(server_name) = found else {
        return Ok(json!({ "id": id, "connected": false }));
    };
    drop_tools(ctx, &[id.clone()]);
    ctx.save_mcp();
    ctx.emit("tools-updated", json!({ "server_id": id }));
    ctx.emit("plugin-net", json!({ "phase": "disconnected", "plugin_id": plugin_id, "id": id }));
    crate::audit::record(ctx, "local-app", "plugin.net-disconnect", &server_name, json!({ "id": id }), true);
    Ok(json!({ "id": id, "connected": false }))
}

/// 按 id 前缀找插件的某条连接（能力层只给 name/id 两种写法时的兜底）
pub fn find_in_plugin(ctx: &Arc<Ctx>, plugin_id: &str, name: &str) -> Option<PluginConnection> {
    crate::plugins::enabled_plugin(ctx, plugin_id)?
        .connections
        .iter()
        .find(|c| c.name == name || conn_id(plugin_id, &c.name) == name)
        .cloned()
}

/// 摘掉这些服务器导入的工具并广播（工具页与模型侧同时看不到它们）
fn drop_tools(ctx: &Arc<Ctx>, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    {
        let mut tools = ctx.tools.lock().unwrap();
        tools.retain(|t| match &t.kind {
            crate::registry::ToolKind::Mcp { server_id, .. } => !ids.contains(server_id),
            _ => true,
        });
    }
    ctx.save_tools();
}

/// 对账（scan/sync 尾调用，同步函数）：清单里已删除、插件停用、net 位关掉、
/// 基线校验失败的连接——MCP 条目整条抹掉，导入的工具一起收回。
/// 与 disconnect 的区别：这里连声明都没了，条目留着只会是一条谁也删不掉的僵尸服务。
pub fn prune(ctx: &Arc<Ctx>) -> usize {
    let allowed: HashSet<String> = resolved_all(ctx).iter().map(|r| r.id.clone()).collect();
    let removed: Vec<String> = {
        let mut list = ctx.mcp.lock().unwrap();
        let gone: Vec<String> = list
            .iter()
            .filter(|s| is_declared(s) && !allowed.contains(&s.id))
            .map(|s| s.id.clone())
            .collect();
        list.retain(|s| !is_declared(s) || allowed.contains(&s.id));
        gone
    };
    if removed.is_empty() {
        return 0;
    }
    ctx.save_mcp();
    drop_tools(ctx, &removed);
    ctx.emit("tools-updated", json!({ "removed_servers": removed }));
    ctx.emit("plugin-net", json!({ "phase": "pruned", "ids": removed }));
    crate::audit::record(ctx, "system", "plugin.net-prune", &removed.join(","), json!({ "count": removed.len() }), true);
    removed.len()
}

/// 启用插件 / 应用启动：auto_connect 且设置齐了的连接逐个连上。
/// 缺设置值的跳过并记一条日志——启动路径不该因为用户没填令牌就弹窗报错
pub async fn auto_connect_plugin(ctx: &Arc<Ctx>, plugin_id: &str) {
    let rows = resolved_of(ctx, plugin_id);
    // 只在插件确实声明了连接时留一行痕：排查"重开权限后为什么没连"全靠它
    if !rows.is_empty() {
        crate::trace::event(
            "plugins",
            &format!("net auto-connect {plugin_id}: {} 条可连", rows.iter().filter(|r| r.conn.auto_connect).count()),
        );
    }
    for r in rows {
        if !r.conn.auto_connect {
            continue;
        }
        // 已经连上的不重复握手（重扫一次把每条都重连一遍会刷出成堆审计）
        if ctx.mcp.lock().unwrap().iter().any(|s| s.id == r.id && s.enabled) {
            continue;
        }
        if !r.missing.is_empty() {
            crate::trace::event(
                "plugins",
                &format!("net {}:{} 等待用户填设置: {}", plugin_id, r.conn.name, r.missing.join(", ")),
            );
            continue;
        }
        if let Err(e) = connect(ctx, plugin_id, &r.conn.name).await {
            crate::trace::event("plugins", &format!("net auto-connect {plugin_id}:{} failed: {e}", r.conn.name));
        }
    }
}

// ── 清单校验（plugins::validate 调用，错误文案保持英文与其它声明一致）──

/// 连接声明的校验：返回第一个问题的描述，Ok = 整组可用
pub fn validate(plugin: &Plugin, conns: &[PluginConnection]) -> Result<(), String> {
    if conns.len() > MAX_CONNECTIONS {
        return Err(format!("too many connections: {} (max {MAX_CONNECTIONS})", conns.len()));
    }
    let mut seen: Vec<String> = Vec::new();
    for c in conns {
        let name = c.name.trim();
        if name.is_empty() {
            return Err("connection requires non-empty name".into());
        }
        let sid = crate::plugins::sanitize(name);
        if sid.is_empty() {
            return Err(format!("connection `{name}`: name has no usable characters"));
        }
        if seen.contains(&sid) {
            return Err(format!("connection name duplicated: {name}"));
        }
        seen.push(sid);
        let url = c.url.trim();
        if url.is_empty() {
            return Err(format!("connection `{name}`: url is required"));
        }
        if !template_ok(url) {
            return Err(format!("connection `{name}`: bad {{setting:KEY}} placeholder in url"));
        }
        // 纯字面量 URL 才能静态判 scheme；含占位的留给连接当时按展开结果判
        if !url.contains("{setting:") {
            url_ok(url).map_err(|e| format!("connection `{name}`: {e}"))?;
        }
        if c.headers.len() > MAX_HEADERS {
            return Err(format!("connection `{name}`: too many headers (max {MAX_HEADERS})"));
        }
        for (k, v) in &c.headers {
            if !crate::mcp::header_name_ok(k.trim()) {
                return Err(format!("connection `{name}`: bad header name `{k}`"));
            }
            let val = v.trim();
            if val.is_empty() || val.len() > 512 {
                return Err(format!("connection `{name}`: header `{k}` value must be 1-512 chars"));
            }
            if !crate::mcp::header_value_ok(val) {
                return Err(format!("connection `{name}`: header `{k}` value has control characters"));
            }
            if !template_ok(val) {
                return Err(format!("connection `{name}`: bad {{setting:KEY}} placeholder in header `{k}`"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn expand_replaces_placeholders_and_reports_missing() {
        let s = map(&[("token", "abc123"), ("region", "sh")]);
        let (url, miss) = expand("https://{setting:region}.example.com/mcp", &s);
        assert_eq!(url, "https://sh.example.com/mcp");
        assert!(miss.is_empty());
        let (val, miss2) = expand("Bearer {setting:token}", &s);
        assert_eq!(val, "Bearer abc123");
        assert!(miss2.is_empty());
        let (val, miss3) = expand("Bearer {setting:apikey}", &s);
        assert_eq!(val, "Bearer ");
        assert_eq!(miss3, vec!["apikey".to_string()]);
        // 空串也算没填：填了个空令牌的连接连不上，得当场点名
        let s2 = map(&[("token", "   ")]);
        let (_, miss4) = expand("{setting:token}", &s2);
        assert_eq!(miss4, vec!["token".to_string()]);
    }

    #[test]
    fn template_keys_lists_every_setting_needed() {
        let keys = template_keys("https://{setting:host}:{setting:port}/mcp?k={setting: token }");
        assert_eq!(keys, vec!["host", "port", "token"]);
        assert!(template_keys("https://example.com/mcp").is_empty());
    }

    #[test]
    fn template_ok_rejects_broken_placeholders() {
        assert!(template_ok("https://example.com/{setting:token}/mcp"));
        assert!(!template_ok("https://example.com/{setting:token/mcp"));
        assert!(!template_ok("https://example.com/{setting:}/mcp"));
        assert!(!template_ok("https://example.com/{oops}/mcp"));
    }

    #[test]
    fn url_gate_requires_https_and_no_credentials() {
        assert!(url_ok("https://example.com/mcp").is_ok());
        assert!(url_ok("http://127.0.0.1:9902/mcp").is_ok());
        assert_eq!(url_ok("").unwrap_err(), "url is empty");
        assert!(url_ok("ftp://example.com/mcp").is_err());
        assert!(url_ok("file:///C:/secrets").is_err());
        assert!(url_ok("https://user:pass@example.com/mcp").is_err());
        // 路径里的 @ 不算凭据，别误伤正常的编码端点
        assert!(url_ok("https://example.com/inbox%40me/mcp").is_ok());
    }

    #[test]
    fn ids_are_stable_and_scoped_to_the_plugin() {
        // sanitize 把非字母数字一律换成下划线：id 里不会出现第二个 '-'，
        // 归属判定靠条目上的 plugin_id 字段，不靠前缀反解
        assert_eq!(conn_id("biz-net", "Corp Gateway"), "pmcp-biz_net-Corp_Gateway");
        assert_eq!(conn_prefix("biz-net"), "pmcp-biz_net-");
        let s = crate::mcp::McpServer {
            id: conn_id("biz-net", "x"),
            name: "x".into(),
            url: String::new(),
            transport: crate::mcp::McpTransport::Http,
            command: String::new(),
            args: vec![],
            env: HashMap::new(),
            headers: HashMap::new(),
            plugin_id: "biz-net".into(),
            version: String::new(),
            protocol: String::new(),
            session: String::new(),
            enabled: true,
            connected_at: String::new(),
        };
        assert!(is_declared(&s));
    }

    fn conn(name: &str, url: &str, headers: &[(&str, &str)]) -> PluginConnection {
        PluginConnection {
            name: name.into(),
            label: String::new(),
            url: url.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            auto_connect: true,
        }
    }

    #[test]
    fn validate_accepts_sane_declarations() {
        let p = Plugin { id: "biz-net".into(), ..empty_plugin() };
        let ok = vec![conn("main", "https://example.com/mcp", &[("Authorization", "Bearer {setting:token}")])];
        assert!(validate(&p, &ok).is_ok(), "{:?}", validate(&p, &ok));
        // 整段地址来自设置：静态判不了 scheme，留给连接当时判
        let from_setting = vec![conn("dyn", "{setting:endpoint}", &[])];
        assert!(validate(&p, &from_setting).is_ok());
    }

    #[test]
    fn validate_rejects_each_misuse() {
        let p = Plugin { id: "biz-net".into(), ..empty_plugin() };
        assert!(validate(&p, &[conn("", "https://a.com", &[])]).is_err());
        assert!(validate(&p, &[conn("a", "ftp://a.com", &[])]).is_err());
        assert!(validate(&p, &[conn("a", "https://a.com", &[]), conn("a", "https://b.com", &[])]).is_err());
        assert!(validate(&p, &[conn("a", "https://a.com", &[("Bad Name", "x")])]).is_err());
        assert!(validate(&p, &[conn("a", "https://a.com", &[("Authorization", "")])]).is_err());
        assert!(validate(&p, &[conn("a", "https://{setting:a", &[])]).is_err());
        let many: Vec<PluginConnection> = (0..9).map(|i| conn(&format!("c{i}"), "https://a.com", &[])).collect();
        assert!(validate(&p, &many).is_err(), "超出条数上限应拒收");
    }

    fn empty_plugin() -> Plugin {
        Plugin {
            id: String::new(),
            name: String::new(),
            version: String::new(),
            description: String::new(),
            tools: vec![],
            prompts: vec![],
            skills: vec![],
            memories: vec![],
            jobs: vec![],
            permissions: vec![],
            ui: None,
            bridge: None,
            server: None,
            services: vec![],
            connections: vec![],
            pages: vec![],
            status_page: None,
            settings: None,
            chat_icons: vec![],
            takeover: vec![],
            preset: String::new(),
            interpreters: vec![],
            file_kinds: vec![],
        }
    }
}
