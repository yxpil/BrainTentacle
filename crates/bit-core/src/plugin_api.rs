// yxpil · BIT
//! 插件本机服务：给插件的独立页面和插件自带的服务器进程开放能力，
//! 与远程访问服务（http_api）完全分离。
//!
//! 为什么单独起一个监听：
//! - 远程访问可能是关着的（remote_enabled=false），但插件页面/插件服务器必须能用；
//! - 这个监听只绑 127.0.0.1，永不进中继、不进远程端口配置，攻击面不随远程开关变化；
//! - 对话凭据是每次启动现发的插件令牌，而不是把用户自己的 Client Key 交给插件。
//!
//! 路由：
//!   GET  /sdk.js                页面侧桥接 SDK（静态页自动注入；公开代码，无凭据）
//!   GET  /p/{插件id}/{文件}      托管插件目录内的静态文件（路径闸门 + 禁用即 404）
//!                               HTML 必须带本插件令牌（?bit_token= / Bearer），静态资源不带头
//!   POST /chat                  对话（Bearer 令牌鉴权 + 来源白名单，会话强制 plugin:<id> 前缀）
//!   GET  /history               读本插件会话消息（同上）
//!   POST /cap                   能力调用（设置/数据/会话/托管服务；Bearer 令牌 + 清单权限位 + 来源白名单）
//!   GET  /health                存活探测（免鉴权，无信息量）
//!
//! 来源白名单：无 Origin（本机进程/curl）、插件服务自身、该插件的服务器端口。
//! 外站页面即使拿到令牌也调不动；HTML 不返回通配 CORS，扫端口拿不到注入的令牌。

use axum::extract::{Path as AxPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::sync::Arc;

use crate::state::Ctx;

const SDK_JS: &str = include_str!("../assets/plugin-sdk.js");

/// 本服务基址（http://127.0.0.1:<分配端口>），监听就绪后由派生任务写入
static BASE: OnceLock<String> = OnceLock::new();
/// 只起一次（bootstrap 可能被重复调用）
static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 启动插件服务（幂等）。
/// 监听在派生任务里用 tokio 自己的 TcpListener 绑定——与远程服务同一条已验证路径；
/// 先 std bind 再把套接字 from_std 转交过一版，结果端口在听、accept 循环不转（连接
/// 只进 backlog，请求全部超时），故不再走那条路。
pub fn start(ctx: Arc<Ctx>) {
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    crate::task::spawn(async move {
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(e) => {
                crate::trace::event("plugin_api", &format!("bind failed: {e}"));
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(_) => return,
        };
        let app = Router::new()
            .route("/sdk.js", get(sdk_route))
            .route("/health", get(health))
            .route("/p/{plugin_id}/{*path}", get(static_route))
            .route("/chat", axum::routing::post(chat_route))
            .route("/history", get(history_route))
            .route("/cap", axum::routing::post(cap_route))
            .with_state(ctx);
        let _ = BASE.set(format!("http://127.0.0.1:{port}"));
        crate::trace::event("plugin_api", &format!("listening on 127.0.0.1:{port}"));
        if let Err(e) = axum::serve(listener, app).await {
            crate::trace::event("plugin_api", &format!("serve stopped: {e}"));
        }
    });
}

/// 基址（未就绪返回空串）
pub fn base_url() -> String {
    BASE.get().cloned().unwrap_or_default()
}

/// 等基址就绪（异步版：给 async 调用方用，避免在 runtime 线程上睡）
pub async fn base_url_ready(max_ms: u64) -> String {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(max_ms);
    loop {
        let u = base_url();
        if !u.is_empty() || std::time::Instant::now() >= deadline {
            return u;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}
/// 等基址就绪（同步版）：渲染层挂载就来要页面清单，那一刻端口可能还没报出来。
/// 只在启动早期真等一次，之后都是首查即中。
pub fn base_url_wait(max_ms: u64) -> String {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(max_ms);
    loop {
        let u = base_url();
        if !u.is_empty() || std::time::Instant::now() >= deadline {
            return u;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// 令牌表：token → 插件 id；同时保留 id → token（重启服务器即换发）
fn tokens() -> &'static Mutex<HashMap<String, String>> {
    static T: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 为插件现发一个对话令牌（同 id 重复申请 = 换发，旧令牌立即失效）
pub fn mint_token(plugin_id: &str) -> String {
    let t = format!("plt_{}", uuid::Uuid::new_v4().simple());
    let mut m = tokens().lock().unwrap();
    if let Some(old) = m.iter().find(|(_, v)| **v == plugin_id).map(|(k, _)| k.clone()) {
        m.remove(&old);
    }
    m.insert(t.clone(), plugin_id.to_string());
    t
}

/// 取该插件现行令牌；没有就现发一枚（同一应用会话内保持稳定）。
/// 服务器进程的环境变量与页面帧地址必须拿到同一个值，否则页面刷新一次就把
/// 服务器进程的凭据换掉了——所以这里只"取或建"，换发留给显式的收回动作。
pub fn token_for(plugin_id: &str) -> String {
    {
        let m = tokens().lock().unwrap();
        if let Some(t) = m.iter().find(|(_, v)| **v == plugin_id).map(|(k, _)| k.clone()) {
            return t;
        }
    }
    mint_token(plugin_id)
}

pub fn revoke_token(plugin_id: &str) {
    let mut m = tokens().lock().unwrap();
    let dead: Vec<String> = m.iter().filter(|(_, v)| *v == plugin_id).map(|(k, _)| k.clone()).collect();
    for k in dead {
        m.remove(&k);
    }
}

fn plugin_of(token: &str) -> Option<String> {
    tokens().lock().unwrap().get(token).cloned()
}

// ── 页面 SDK 与健康探测 ──

fn cors() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    h
}

async fn sdk_route() -> Response {
    (
        cors(),
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        SDK_JS,
    )
        .into_response()
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "service": "bit-plugin-api" }))
}

// ── 静态插件页 ──

/// 按扩展名给 MIME：只覆盖前端页面会用到的类型，其余按 octet-stream 下载语义处理
fn content_type(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// 在 </head> 前注入令牌与 SDK；没有 head（片段式页面）就前置。
/// 让静态页零配置拿到 window.Bit：页面作者不必知道端口号，也不必自己拼脚本地址。
/// 令牌先于 SDK 落进全局，SDK 起来就能读到它（另一条路是帧地址的 #bit_token=，
/// 动态页拿不到这里的注入，只能靠那个）。
fn inject_sdk(body: &str, token: &str) -> String {
    // serde_json 负责转义：令牌本身是我们生成的 plt_ 十六进制，但拼接 HTML 不该赌这一点
    let lit = serde_json::Value::String(token.to_string()).to_string();
    let tag = format!("<script>window.__BIT_PLUGIN_TOKEN__={lit};</script><script src=\"/sdk.js\"></script>");
    let lower = body.to_ascii_lowercase();
    match lower.rfind("</head>") {
        Some(pos) => format!("{}{}{}", &body[..pos], tag, &body[pos..]),
        None => format!("{tag}\n{body}"),
    }
}

async fn static_route(
    State(ctx): State<Arc<Ctx>>,
    AxPath((plugin_id, rel)): AxPath<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    // 只服务"启用且未被判篡改"的插件：停用后其页面立即不可达，不必等渲染层重放。
    // 页面/设置页的权限位被用户单独关掉后同样不再发放 HTML（含注入的令牌）。
    let Some(plugin) = crate::plugins::enabled_plugin(&ctx, &plugin_id) else {
        return (StatusCode::NOT_FOUND, "plugin not enabled").into_response();
    };
    if !crate::plugins::has_grant(&ctx, &plugin, "page")
        && !crate::plugins::has_grant(&ctx, &plugin, "settings")
    {
        return (StatusCode::NOT_FOUND, "plugin page permission disabled").into_response();
    }
    // 路径闸门：拒绝对路径、`..`、以 . 开头的段（清单校验之外的运行时二道闸）
    let raw = rel.replace('\\', "/");
    if raw.is_empty()
        || raw.split('/').any(|seg| seg.is_empty() || seg == ".." || seg.starts_with('.'))
        || std::path::Path::new(&raw).is_absolute()
    {
        return (StatusCode::FORBIDDEN, "path not allowed").into_response();
    }
    let root = crate::plugins::dir(&ctx).join(&plugin_id);
    let file = root.join(&raw);
    // 符号链接逃逸防线：canonical 后必须仍在插件目录内
    let canon = match file.canonicalize() {
        Ok(c) => c,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let canon_root = match root.canonicalize() {
        Ok(c) => c,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    if !canon.starts_with(&canon_root) || !canon.is_file() {
        return (StatusCode::FORBIDDEN, "outside plugin dir").into_response();
    }
    let bytes = match std::fs::read(&canon) {
        Ok(b) => b,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "read failed").into_response(),
    };
    // 单文件上限 4MB：防页面把一个巨型资源塞进插件目录当下载器用
    if bytes.len() > 4 * 1024 * 1024 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "file too large").into_response();
    }
    let ext = canon.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm") {
        // HTML 带着注入的令牌，必须先验证本插件令牌才发：
        // 否则任何本机应用（甚至允许 CORS 时的外站页面）扫到端口就能把令牌抄走。
        let expected = token_for(&plugin_id);
        let from_query = q.get("bit_token").map(String::as_str).unwrap_or("");
        if !token_eq(&expected, from_query) && !token_eq(&expected, bearer_token(&headers)) {
            crate::trace::event("plugin_api", &format!("static html denied: plugin={plugin_id} path={raw}"));
            return (StatusCode::UNAUTHORIZED, "plugin token required").into_response();
        }
        let text = String::from_utf8_lossy(&bytes);
        let mut out = HeaderMap::new();
        out.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        // 页面里带查询参数令牌：禁止缓存与跨站 Referer 外泄；类型固定，别让内容嗅探改判
        out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        out.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
        out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        return (out, Html(inject_sdk(&text, &expected))).into_response();
    }
    // 静态资源不含令牌，保持同源加载即可；不再给通配 CORS，外站读不到插件文件
    let mut out = HeaderMap::new();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type(ext)).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    (out, bytes).into_response()
}

// ── 对话 API ──

/// 取 Authorization: Bearer 后面的令牌（没有就空串）
fn bearer_token(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .strip_prefix("Bearer ")
        .unwrap_or("")
        .trim()
}

/// 从请求头取 Bearer 令牌并换成插件 id
fn auth_plugin(headers: &HeaderMap) -> Option<String> {
    plugin_of(bearer_token(headers))
}

/// 常量时间比较：令牌校验不按字节提前返回，别让本机进程靠计时逐位猜
fn token_eq(expected: &str, got: &str) -> bool {
    let (a, b) = (expected.as_bytes(), got.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// 来源白名单：本机进程（无 Origin）、插件服务自身、该插件的服务器端口。
/// 外站页面即使拿到令牌也会被这一步挡掉；`Origin: null`（file:// / sandbox）同样拒绝。
fn origin_is_allowed(origin: Option<&str>, api_base: &str, server_port: Option<u16>) -> bool {
    let Some(o) = origin.map(str::trim).filter(|s| !s.is_empty()) else {
        // 本机进程/curl 不带 Origin：令牌仍是唯一凭据
        return true;
    };
    if !api_base.is_empty() && o == api_base {
        return true;
    }
    if let Some(port) = server_port {
        if o == format!("http://127.0.0.1:{port}") {
            return true;
        }
    }
    false
}

fn request_origin_allowed(plugin_id: &str, headers: &HeaderMap) -> bool {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    origin_is_allowed(origin, &base_url(), crate::plugins::server_port(plugin_id))
}

fn forbidden_origin(plugin_id: &str) -> Response {
    crate::trace::event("plugin_api", &format!("origin denied: plugin={plugin_id}"));
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "请求来源不被允许：插件接口只接受本插件页面与本机进程" })),
    )
        .into_response()
}

/// 本插件的会话命名空间：默认 plugin:<id>，允许其下的任意后缀，别的会话一律拒绝。
/// 与远程对话同理——绝不能让一个插件把消息投进用户正在用的会话里。
/// pub：plugin_caps 的会话类能力共用同一道闸，避免两处写法漂移。
pub fn scoped_session(plugin_id: &str, want: &str) -> Result<String, String> {
    let own = format!("plugin:{plugin_id}");
    let sid = want.trim();
    if sid.is_empty() {
        return Ok(own);
    }
    if sid == own || sid.starts_with(&format!("{own}:")) {
        Ok(sid.to_string())
    } else {
        Err(format!("会话必须归属本插件（前缀 {own}: 或 {own}）"))
    }
}

async fn chat_route(
    State(ctx): State<Arc<Ctx>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let plugin_id = match auth_plugin(&headers) {
        Some(p) => p,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "缺少或无效的 BIT_PLUGIN_TOKEN" })),
            )
                .into_response()
        }
    };
    // 令牌只在服务器存活期间有效：插件被停用/篡改后进程已被收回，令牌一并作废。
    // chat 权限被用户单独关掉时同样不再接受这个入口。
    if crate::plugins::enabled_granted(&ctx, &plugin_id, "chat").is_none() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "插件未启用或 chat 权限未开启" }))).into_response();
    }
    if !request_origin_allowed(&plugin_id, &headers) {
        return forbidden_origin(&plugin_id);
    }
    let message = body.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if message.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "缺少 message" }))).into_response();
    }
    let sid = match scoped_session(&plugin_id, body.get("session_id").and_then(|v| v.as_str()).unwrap_or("")) {
        Ok(s) => s,
        Err(e) => return (StatusCode::FORBIDDEN, Json(json!({ "error": e }))).into_response(),
    };
    let actor = format!("plugin:{plugin_id}");
    // 限速与远程对话同一口径（chat_rpm_max），按插件 id 分桶而非按 IP——所有插件都来自 127.0.0.1
    if let Some(wait) = crate::http_api::chat_rate_check(&ctx, &plugin_id, "plugin") {
        return crate::http_api::rate_limited_response(wait);
    }
    if let Some(resp) = crate::http_api::moderation_input_check(&ctx, &message, &actor, "plugin.chat") {
        return resp;
    }
    let images: Vec<String> = body
        .get("images")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    // 会话先落盘再执行：worker 分进程架构下 host 只占位，与 http_api::remote_chat 同序
    crate::session::refresh_from_disk(&ctx);
    {
        let mut store = ctx.sessions.lock().unwrap();
        let s = store.get_or_create_mut(&sid);
        s.updated = String::new();
    }
    crate::session::persist(&ctx);

    match crate::engine::chat_auto(&ctx, &sid, &message, images).await {
        Ok(messages) => {
            let last = messages
                .iter()
                .rev()
                .find(|m| m.role == "assistant")
                .map(|m| m.content.clone())
                .unwrap_or_default();
            let last = crate::http_api::moderation_output_check(&ctx, &last, &actor, "plugin.chat");
            crate::audit::record(
                &ctx,
                &actor,
                "plugin.chat",
                &sid,
                json!({ "reply_len": last.len(), "turns": messages.len() }),
                true,
            );
            Json(json!({ "reply": last, "session_id": sid })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

async fn history_route(
    State(ctx): State<Arc<Ctx>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let plugin_id = match auth_plugin(&headers) {
        Some(p) => p,
        None => return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response(),
    };
    if !request_origin_allowed(&plugin_id, &headers) {
        return forbidden_origin(&plugin_id);
    }
    if crate::plugins::enabled_granted(&ctx, &plugin_id, "chat").is_none() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "插件未启用或 chat 权限未开启" }))).into_response();
    }
    let sid = match scoped_session(&plugin_id, q.get("session_id").map(|s| s.as_str()).unwrap_or("")) {
        Ok(s) => s,
        Err(e) => return (StatusCode::FORBIDDEN, Json(json!({ "error": e }))).into_response(),
    };
    crate::session::refresh_from_disk(&ctx);
    let msgs = {
        let store = ctx.sessions.lock().unwrap();
        store
            .sessions
            .iter()
            .find(|s| s.id == sid)
            .map(|s| s.messages.clone())
            .unwrap_or_default()
    };
    Json(json!({ "session_id": sid, "messages": msgs })).into_response()
}

/// POST /cap {verb, payload}：能力调用（设置 / 数据 / 会话 / 托管服务）。
/// 插件 id 只由 Bearer 令牌反查得到，请求体里自报的 id 一律不看；
/// 每个 verb 需要什么权限位由 plugin_caps 判定，清单里没申报就直接拒绝。
async fn cap_route(
    State(ctx): State<Arc<Ctx>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let plugin_id = match auth_plugin(&headers) {
        Some(p) => p,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "缺少或无效的 BIT_PLUGIN_TOKEN" })),
            )
                .into_response()
        }
    };
    if !request_origin_allowed(&plugin_id, &headers) {
        return forbidden_origin(&plugin_id);
    }
    let verb = body.get("verb").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if verb.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "缺少 verb" }))).into_response();
    }
    let payload = body.get("payload").cloned().unwrap_or_else(|| json!({}));
    match crate::plugin_caps::call(&ctx, &plugin_id, &verb, payload).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            // 权限/启用问题回 403，参数问题回 400：插件进程据此区分"该去申报权限"和"该改参数"
            let code = if e.contains("未开启权限") || e.contains("未启用") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::BAD_REQUEST
            };
            (code, Json(json!({ "error": e }))).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_session_allows_only_own_namespace() {
        assert_eq!(scoped_session("x", "").unwrap(), "plugin:x");
        assert_eq!(scoped_session("x", "plugin:x").unwrap(), "plugin:x");
        assert_eq!(scoped_session("x", "plugin:x:sub").unwrap(), "plugin:x:sub");
        assert!(scoped_session("x", "plugin:y").is_err());
        assert!(scoped_session("x", "chat-12").is_err());
        assert!(scoped_session("x", "plugin:x2").is_err());
    }

    #[test]
    fn token_mint_rotates_and_revokes() {
        let a = mint_token("tok-demo");
        assert!(plugin_of(&a).as_deref() == Some("tok-demo"));
        let b = mint_token("tok-demo");
        assert_ne!(a, b);
        assert!(plugin_of(&a).is_none(), "换发后旧令牌必须失效");
        revoke_token("tok-demo");
        assert!(plugin_of(&b).is_none());
    }

    #[test]
    fn token_for_is_stable_within_a_session() {
        let a = token_for("tok-stable");
        assert_eq!(a, token_for("tok-stable"), "同一插件重复取号必须拿到同一枚");
        revoke_token("tok-stable");
        assert_ne!(a, token_for("tok-stable"), "收回后要换发新的");
    }

    #[test]
    fn tokens_compare_exactly_and_never_accept_empty() {
        assert!(token_eq("plt_abc", "plt_abc"));
        assert!(!token_eq("plt_abc", "plt_abd"));
        assert!(!token_eq("plt_abc", "plt_ab"));
        assert!(!token_eq("", ""), "空令牌永远不算通过");
        assert!(!token_eq("plt_abc", ""));
    }

    #[test]
    fn origins_are_scoped_to_this_machine_and_plugin() {
        let api = "http://127.0.0.1:5000";
        assert!(origin_is_allowed(None, api, None), "本机进程没有 Origin");
        assert!(origin_is_allowed(Some(""), api, None));
        assert!(origin_is_allowed(Some(api), api, None), "插件页面自身");
        assert!(origin_is_allowed(Some("http://127.0.0.1:5001"), api, Some(5001)), "插件服务器端口");
        assert!(!origin_is_allowed(Some("https://evil.example"), api, Some(5001)));
        assert!(!origin_is_allowed(Some("http://127.0.0.1:5002"), api, Some(5001)));
        assert!(!origin_is_allowed(Some("null"), api, None), "file:// / 沙箱来源不认");
    }

    #[test]
    fn sdk_injection_keeps_head_intact() {
        let html = "<html><head><title>t</title></head><body>hi</body></html>";
        let out = inject_sdk(html, "plt_demo");
        assert!(out.contains("<script src=\"/sdk.js\"></script>"));
        assert!(out.contains("window.__BIT_PLUGIN_TOKEN__=\"plt_demo\""));
        assert!(out.find("<title>").unwrap() < out.find("sdk.js").unwrap());
        assert!(out.ends_with("</html>"));
        // 片段页（无 head）：前置即可
        assert!(inject_sdk("<p>x</p>", "plt_demo").starts_with("<script"));
    }
}
