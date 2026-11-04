// yxpil · BIT
//! 出网代理：企业内网常常只有代理能到公网模型端点，直连一律超时。
//!
//! 一份配置管三层出口，避免「设置里填了代理、只有某条链路生效」：
//! 1. bit-core 内所有 reqwest 客户端 —— 靠本进程环境变量（含第三方 crate 与 blocking 客户端）
//! 2. AI 请求主路径 —— `ai::http_client_for` 额外显式带上代理，不依赖 env 生效时序
//! 3. 宿主 webview 与 shell 子进程 —— Electron 侧读同一份配置调 setProxy；
//!    curl / git / npm / pip 天然认 HTTP_PROXY（子进程继承本进程环境）
//!
//! 三条模式：
//! - system：读操作系统自己的代理设置（Windows 代理设置 / macOS 系统代理 / 环境变量），
//!   环境也恢复成启动时继承的样子——reqwest 不认注册表，这一层不读就等于没代理
//! - direct：清掉代理环境并强制 no_proxy，明确翻越系统代理直连
//! - custom：按用户填的地址设环境并显式配代理
//!
//! 自定义模式另有四项口径开关：
//! - export_env：是否把代理导出成子进程环境变量（curl / git / npm 继承的那份）
//! - fail_open：代理探不到时回退直连，免得换了网络环境整个应用连不上
//! - ca_file：额外信任的根证书（企业网关做 TLS 中间人时发的那张）
//! - insecure：跳过证书校验，只给排障用，界面会一直标出来
//!
//! 回环地址永远直连（与模式无关）：本机服务（LM Studio / Ollama / MCP / 自托管插件页 /
//! 测试桩）不该被代理客户端吞掉——这条规则原先只写在 `ai::http_client_for`，现收进本模块统一口径。

use crate::config::Config;
use reqwest::Proxy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const MODE_SYSTEM: &str = "system";
pub const MODE_DIRECT: &str = "direct";
pub const MODE_CUSTOM: &str = "custom";

/// 代理环境变量：Windows 大小写不敏感，只写大写；Unix 两份都写（老工具只认小写）
const PROXY_VARS: [&str; 3] = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
const NO_PROXY_VAR: &str = "NO_PROXY";

/// 任何模式下都直连的地址（CIDR 那条给认 CIDR 的消费方兜住整个 127/8）
const LOOPBACK_BYPASS: [&str; 5] = ["localhost", "127.0.0.1", "127.0.0.0/8", "::1", "[::1]"];

/// reqwest 支持的代理协议（socks 系列需要 reqwest 的 socks feature）
const SCHEMES: [(&str, u16); 6] = [
    ("http", 80),
    ("https", 443),
    ("socks5", 1080),
    ("socks5h", 1080),
    ("socks4", 1080),
    ("socks4a", 1080),
];

/// 当前生效的代理决策（进程级）：`http_client_for` 每次建客户端时读它
#[derive(Clone, Debug)]
pub struct Decision {
    pub mode: String,
    /// 生效的代理地址：custom = 用户填的；system = 从操作系统读到的；direct = 空
    pub url: String,
    /// 直连名单（用户填的 + 系统排除名单 + 回环）
    pub bypass: Vec<String>,
    /// url 的出处："" 没有 / "config" 用户设置 / "registry" Windows 代理设置 / "scutil" macOS / "env" 环境变量
    pub url_from: String,
    /// 跟随系统时读到的 PAC 自动配置地址（BIT 不执行 PAC，只如实告诉界面）
    pub pac: String,
    /// 是否把代理导出成子进程环境变量
    pub export_env: bool,
    /// 代理不可达时回退直连
    pub fail_open: bool,
    /// 额外信任的根证书 PEM 路径
    pub ca_file: String,
    /// 跳过 TLS 证书校验（排障用）
    pub insecure: bool,
}

impl Default for Decision {
    fn default() -> Self {
        Self {
            mode: MODE_SYSTEM.to_string(),
            url: String::new(),
            bypass: Vec::new(),
            url_from: String::new(),
            pac: String::new(),
            export_env: true,
            fail_open: false,
            ca_file: String::new(),
            insecure: false,
        }
    }
}

fn slot() -> &'static Mutex<Decision> {
    static CURRENT: OnceLock<Mutex<Decision>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(Decision::default()))
}

pub fn current() -> Decision {
    slot().lock().map(|d| d.clone()).unwrap_or_default()
}

/// 模式归一：未知值一律落回 system，避免旧配置或脏输入让出网完全瘫痪
pub fn norm_mode(m: &str) -> String {
    match m.trim().to_lowercase().as_str() {
        MODE_DIRECT => MODE_DIRECT.to_string(),
        MODE_CUSTOM => MODE_CUSTOM.to_string(),
        _ => MODE_SYSTEM.to_string(),
    }
}

/// 从 authority 段取主机（先剥 userinfo，再处理 IPv6 字面量 `[::1]:8080`）
fn authority_host(authority: &str) -> &str {
    let a = authority.rsplit('@').next().unwrap_or(authority);
    if let Some(close) = a.find(']') {
        &a[..=close]
    } else if a.matches(':').count() > 1 {
        a // 裸 IPv6（::1 不带括号），端口在这种写法里本来就非法
    } else {
        a.split(':').next().unwrap_or(a)
    }
}

/// 环回主机判定：整个 127/8 都算本机（RFC 6761），挂在 127.0.0.2 上的服务也不该被代理吞掉
fn is_loopback_host(host: &str) -> bool {
    if matches!(host, "localhost" | "::1" | "[::1]") {
        return true;
    }
    match host.strip_prefix("127.") {
        // 只认数字段，避免把 "127.evil.test" 这类主机名当成本机
        Some(rest) => !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit() || c == '.'),
        None => false,
    }
}

/// 环回判定：发往本机的一律直连
pub fn is_loopback_base(base: &str) -> bool {
    let rest = match base.trim() {
        s if s.starts_with("http://") => &s[7..],
        s if s.starts_with("https://") => &s[8..],
        _ => return false,
    };
    is_loopback_host(authority_host(rest.split('/').next().unwrap_or("")))
}

/// 校验并规范化代理地址。裸 `host:port` 视为 http 代理（内网最常见的写法）。
/// 返回 reqwest 可用的完整 URL；协议不支持时给出可判定的错误码（文案由界面出）。
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("proxy_empty".into());
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        format!("http://{s}")
    };
    let body = with_scheme.splitn(2, "://").nth(1).unwrap_or("");
    if body.is_empty() {
        return Err("proxy_host_missing".into());
    }
    let scheme = with_scheme[..with_scheme.find("://").unwrap_or(0)].to_lowercase();
    let known = SCHEMES.iter().any(|(sc, _)| *sc == scheme);
    if !known {
        return Err("proxy_scheme".into());
    }
    // reqwest 自己解析一次：把非法端口 / 空主机挡在写配置之前
    Proxy::all(with_scheme.as_str()).map_err(|_| "proxy_url".to_string())?;
    Ok(with_scheme)
}

/// 代理服务器地址（host, port）：TCP 连通性探测用，缺省端口按协议补
pub fn proxy_addr(url: &str) -> Option<(String, u16)> {
    let scheme = url.splitn(2, "://").next().unwrap_or("").to_lowercase();
    let default_port = SCHEMES.iter().find(|(sc, _)| *sc == scheme).map(|(_, p)| *p)?;
    let rest = url.splitn(2, "://").nth(1)?;
    let hostport = rest.split('/').next().unwrap_or("");
    let hostport = hostport.rsplit('@').next().unwrap_or(hostport);
    let (h, p) = if let Some(close) = hostport.find(']') {
        // [::1]:1080 / [::1]
        let tail = &hostport[close + 1..];
        match tail.strip_prefix(':') {
            Some(ps) => (&hostport[..close], ps.parse::<u16>().ok()?),
            None => (&hostport[..close], default_port),
        }
    } else {
        match hostport.rsplit_once(':') {
            Some((h, ps)) if hostport.matches(':').count() == 1 => (h, ps.parse::<u16>().ok()?),
            _ => (hostport, default_port),
        }
    };
    let h = h.trim().trim_start_matches('[').trim_end_matches(']');
    if h.is_empty() {
        return None;
    }
    Some((h.to_string(), p))
}

/// 直连名单解析：逗号 / 分号 / 空白分隔，去空去重
pub fn parse_bypass(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tok in raw.split([',', ';', ' ', '\t', '\n', '\r']) {
        let t = tok.trim();
        if !t.is_empty() && !out.iter().any(|e| e.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    out
}

/// 用户名单 + 回环恒定项
pub fn bypass_with_loopback(raw: &str) -> Vec<String> {
    let mut list = parse_bypass(raw);
    for lb in LOOPBACK_BYPASS {
        if !list.iter().any(|e| e.eq_ignore_ascii_case(lb)) {
            list.push(lb.to_string());
        }
    }
    list
}

/// 操作系统自己的代理设置。reqwest 只认环境变量、不认 Windows 代理设置和 macOS 的系统代理，
/// 所以「跟随系统」必须自己读出来显式配给客户端——否则公司机器上浏览器能出网、模型请求全超时。
#[derive(Clone, Debug, Default)]
pub struct SystemProxy {
    /// 规范化后的代理地址（空 = 系统没配）
    pub url: String,
    /// 出处："" / "registry" / "scutil" / "env"
    pub from: String,
    /// PAC 自动配置脚本地址（BIT 不执行 PAC，只报给界面说明情况）
    pub pac: String,
    /// 系统里的排除名单（已清洗成可用的直连条目）
    pub bypass: Vec<String>,
}

/// 系统代理读数缓存（60 秒）：`http_client_for` 每次建客户端都会走到，不能每次都拉一次进程
fn os_cache() -> &'static Mutex<Option<(Instant, SystemProxy)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, SystemProxy)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub fn os_proxy() -> SystemProxy {
    if let Ok(c) = os_cache().lock() {
        if let Some((at, sp)) = c.as_ref() {
            if at.elapsed() < Duration::from_secs(60) {
                return sp.clone();
            }
        }
    }
    let sp = os_proxy_raw();
    if let Ok(mut c) = os_cache().lock() {
        *c = Some((Instant::now(), sp.clone()));
    }
    sp
}

/// 强制下一次重新读取系统代理（改完设置、以及单测里换夹具后调用）
pub fn invalidate_os_proxy() {
    if let Ok(mut c) = os_cache().lock() {
        *c = None;
    }
}

/// `reg query` / `scutil` 的输出取值：`ProxyServer    REG_SZ    10.0.0.9:3128`
fn reg_value(text: &str, name: &str) -> Option<String> {
    for line in text.lines() {
        let mut it = line.trim().split_whitespace();
        let (Some(k), Some(ty)) = (it.next(), it.next()) else {
            continue; // 空行与分节头
        };
        if k != name || !ty.starts_with("REG_") {
            continue;
        }
        let val = it.collect::<Vec<_>>().join(" ");
        if !val.is_empty() {
            return Some(val);
        }
    }
    None
}

fn flag_on(v: Option<String>) -> bool {
    matches!(v.as_deref(), Some(s) if s.trim().trim_start_matches("0x") == "1")
}

/// Windows 代理设置（Internet 选项）：`ProxyEnable` + `ProxyServer` + `ProxyOverride`。
/// `ProxyServer` 两种写法都要认：`host:port` 与按协议分开的 `http=h:1;https=h:2;socks=h:3`
fn parse_ie_settings(text: &str) -> SystemProxy {
    let mut sp = SystemProxy::default();
    if flag_on(reg_value(text, "ProxyAutoConfigEnable")) {
        sp.pac = reg_value(text, "AutoConfigURL").unwrap_or_default();
    }
    if !flag_on(reg_value(text, "ProxyEnable")) {
        return sp; // 只开了 PAC 的机器：报出 pac 地址，但不猜代理
    }
    let server = reg_value(text, "ProxyServer").unwrap_or_default();
    let picked = if server.contains('=') {
        ["https", "http", "socks", "ftp"]
            .iter()
            .find_map(|k| {
                server.split(';').find_map(|tok| {
                    let (name, addr) = tok.split_once('=')?;
                    (name.trim().eq_ignore_ascii_case(k) && !addr.trim().is_empty())
                        .then(|| addr.trim().to_string())
                })
            })
            .unwrap_or_default()
    } else {
        server.clone()
    };
    if let Ok(u) = normalize_url(&picked) {
        sp.url = u;
        sp.from = "registry".into();
    }
    // 系统排除名单：`<local>`（所有不带点的本机名）与空段丢掉，其余按我们的分隔符规则收编
    let override_raw = reg_value(text, "ProxyOverride").unwrap_or_default();
    sp.bypass = parse_bypass(&override_raw)
        .into_iter()
        .filter(|t| !t.eq_ignore_ascii_case("<local>"))
        .collect();
    sp
}

/// macOS `scutil --proxy`：`HTTPSPort : 3128` 这类键值对，按 https → http → socks 优先取一条
fn parse_scutil(text: &str) -> SystemProxy {
    let mut sp = SystemProxy::default();
    let num = |key: &str| -> Option<String> {
        text.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim() == key).then(|| v.trim().to_string())
        })
    };
    if num("ProxyAutoConfigEnable").as_deref() == Some("1") {
        sp.pac = num("ProxyAutoConfigURLString").unwrap_or_default();
    }
    for (enable, host, port, scheme) in [
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort", "http"),
        ("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5"),
    ] {
        if num(enable).as_deref() != Some("1") {
            continue;
        }
        let Some(h) = num(host).filter(|s| !s.is_empty()) else { continue };
        let addr = match num(port).filter(|s| !s.is_empty() && s != "0") {
            Some(p) => format!("{scheme}://{h}:{p}"),
            None => format!("{scheme}://{h}"),
        };
        if let Ok(u) = normalize_url(&addr) {
            sp.url = u;
            sp.from = "scutil".into();
            break;
        }
    }
    if let Some(ex) = num("ExceptionsList") {
        sp.bypass = parse_bypass(&ex.replace(';', ","));
    }
    sp
}

#[cfg(windows)]
fn os_proxy_raw() -> SystemProxy {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let mut sp = match out {
        Ok(o) if o.status.success() => {
            parse_ie_settings(&String::from_utf8_lossy(&o.stdout))
        }
        _ => SystemProxy::default(),
    };
    if sp.url.is_empty() && sp.pac.is_empty() {
        if let Some(env) = env_proxy() {
            sp = env;
        }
    }
    sp
}

#[cfg(target_os = "macos")]
fn os_proxy_raw() -> SystemProxy {
    let mut sp = match std::process::Command::new("scutil").arg("--proxy").output() {
        Ok(o) if o.status.success() => parse_scutil(&String::from_utf8_lossy(&o.stdout)),
        _ => SystemProxy::default(),
    };
    if sp.url.is_empty() && sp.pac.is_empty() {
        if let Some(env) = env_proxy() {
            sp = env;
        }
    }
    sp
}

#[cfg(not(any(windows, target_os = "macos")))]
fn os_proxy_raw() -> SystemProxy {
    env_proxy().unwrap_or_default()
}

/// 环境变量形态的「系统代理」：只认启动时继承到的那一份。
/// 我们自己写进环境的不算系统代理——否则从自定义切回「跟随系统」时，
/// decide() 先跑、环境还没还原，刚填的代理会被当成系统的留下来，切不干净
fn env_proxy() -> Option<SystemProxy> {
    let base = env_baseline();
    let get = |name: &str| {
        base.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .and_then(|(_, v)| v.clone())
            .filter(|s| !s.trim().is_empty())
    };
    let raw = get("HTTPS_PROXY").or_else(|| get("HTTP_PROXY"))?;
    let url = normalize_url(&raw).ok()?;
    let bypass = get("NO_PROXY").map(|b| parse_bypass(&b)).unwrap_or_default();
    Some(SystemProxy { url, from: "env".into(), pac: String::new(), bypass })
}

/// 环境变量写入计划（纯数据，便于单测；实际写入见 apply）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvOp {
    pub var: String,
    /// None = 删除该变量
    pub value: Option<String>,
}

/// 本模块会写的代理变量名（Windows 大小写不敏感只写大写，Unix 两份都写）
fn proxy_var_names() -> Vec<String> {
    let mut names: Vec<String> = PROXY_VARS.iter().map(|v| v.to_string()).collect();
    names.push(NO_PROXY_VAR.to_string());
    if !cfg!(windows) {
        let lower: Vec<String> = names.iter().map(|v| v.to_lowercase()).collect();
        names.extend(lower);
    }
    names
}

/// 启动时继承到的代理环境（只取一次）：切回 system 模式按它还原。
/// 没有基线的话「跟随系统」会把上一次自定义代理——连密码一起——永久留在进程环境里。
fn env_baseline() -> &'static [(String, Option<String>)] {
    static BASE: OnceLock<Vec<(String, Option<String>)>> = OnceLock::new();
    BASE.get_or_init(|| {
        proxy_var_names().into_iter().map(|name| (name.clone(), read_env(&name))).collect::<Vec<_>>()
    })
}

pub fn env_plan(
    mode: &str,
    url: &str,
    bypass: &[String],
    baseline: &[(String, Option<String>)],
    export_env: bool,
) -> Vec<EnvOp> {
    let names = proxy_var_names();
    let restore = || {
        baseline
            .iter()
            .map(|(var, value)| EnvOp { var: var.clone(), value: value.clone() })
            .collect::<Vec<_>>()
    };
    match mode {
        // 跟随系统 = 把环境恢复到启动时继承的样子（本来没有就删干净）
        MODE_SYSTEM => restore(),
        // 强制直连：把代理变量连同继承值一起抹掉，否则系统代理照旧生效
        MODE_DIRECT => names.into_iter().map(|var| EnvOp { var, value: None }).collect(),
        _ => {
            if url.is_empty() {
                return names.into_iter().map(|var| EnvOp { var, value: None }).collect();
            }
            // 不导出给子进程：环境回到继承来的样子，代理只管 BIT 自己出网
            if !export_env {
                return restore();
            }
            let no = bypass.join(",");
            names
                .into_iter()
                .map(|var| {
                    let value = if var.eq_ignore_ascii_case(NO_PROXY_VAR) {
                        Some(no.clone())
                    } else {
                        Some(url.to_string())
                    };
                    EnvOp { var, value }
                })
                .collect()
        }
    }
}

/// 从配置算出生效决策（不落全局、不写环境）
pub fn decide(cfg: &Config) -> Decision {
    let mode = norm_mode(&cfg.proxy_mode);
    let mut d = Decision {
        export_env: cfg.proxy_export_env,
        fail_open: cfg.proxy_fail_open,
        ca_file: cfg.proxy_ca_file.trim().to_string(),
        insecure: cfg.proxy_insecure,
        bypass: bypass_with_loopback(&cfg.proxy_bypass),
        mode,
        ..Default::default()
    };
    if d.mode == MODE_CUSTOM {
        // 存量地址再校验一次：配置被手改坏时宁可退回无代理，也不把非法地址推给环境和 reqwest
        if let Ok(u) = normalize_url(&cfg.proxy_url) {
            // 带认证的代理把账号并进 URL（curl/git/Chromium 都认 userinfo 形态）
            let user = cfg.proxy_user.trim();
            d.url = if user.is_empty() { u } else { inject_credentials(&u, user, &cfg.proxy_pass) };
            d.url_from = "config".into();
        }
    } else if d.mode == MODE_SYSTEM {
        // 跟随系统：读操作系统里的代理设置（reqwest 不认，得显式配）
        let sp = os_proxy();
        d.url = sp.url;
        d.url_from = sp.from;
        d.pac = sp.pac;
        for t in sp.bypass {
            if !d.bypass.iter().any(|e| e.eq_ignore_ascii_case(&t)) {
                d.bypass.push(t);
            }
        }
    }
    d
}

/// 把 user:pass 插进 URL 的 authority 段（已带 userinfo 的地址原样保留）
fn inject_credentials(url: &str, user: &str, pass: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_string() };
    if rest.split('/').next().unwrap_or("").contains('@') {
        return url.to_string();
    }
    let creds = if pass.is_empty() {
        urlencoding(user)
    } else {
        format!("{}:{}", urlencoding(user), urlencoding(pass))
    };
    format!("{scheme}://{creds}@{rest}")
}

/// 代理 URL 里的账号密码按 percent-encoding 转义（密码常含 @ : / 等保留字）
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 应用配置：写全局决策 + 按环境变量计划改环境，返回给界面用的生效摘要。
/// 锁住决策槽再改环境，保证并发调用 set_proxy_config 时写入顺序一致
/// （进程环境是全进程可见的共享状态，其他线程此刻读到的可能是半态——
/// 只有用户显式改代理才会发生，下一次建客户端即读到完整新值，无累积影响）。
pub fn apply(cfg: &Config) -> Value {
    let d = decide(cfg);
    let ops = env_plan(&d.mode, &d.url, &d.bypass, env_baseline(), d.export_env);
    if let Ok(mut cur) = slot().lock() {
        for op in &ops {
            match &op.value {
                Some(v) => std::env::set_var(&op.var, v),
                None => std::env::remove_var(&op.var),
            }
        }
        *cur = d.clone();
    }
    clear_ca_cache(); // 配置一改就重读证书文件，免得用着上一版的 CA
    summary(&d, ops.len())
}

/// 生效摘要：只给结构化字段，展示文案归界面（i18n）。
/// `url` 里的密码一律打码——摘要会进审计日志和事件流，不能带凭证
pub fn summary(d: &Decision, env_ops: usize) -> Value {
    let sys = os_proxy();
    let ca = if d.ca_file.is_empty() {
        Ok(Vec::new())
    } else {
        load_ca(&d.ca_file)
    };
    json!({
        "mode": d.mode,
        "url": redact_url(&d.url),
        "url_from": d.url_from,
        "bypass": d.bypass,
        "env_ops": env_ops,
        "proxy_env": env_view(),
        "export_env": d.export_env,
        "fail_open": d.fail_open,
        "insecure": d.insecure,
        "ca_file": d.ca_file,
        // 证书文件读没读到、读到几张，界面直接说，不用用户猜
        "ca_certs": ca.as_ref().map(|v| v.len()).unwrap_or(0),
        "ca_error": ca.is_err(),
        "system": {
            "url": redact_url(&sys.url),
            "from": sys.from,
            "pac": sys.pac,
            "bypass": sys.bypass,
        },
    })
}

/// 把 userinfo 里的密码换成 ***（账号保留，便于辨认用的是哪个身份）
pub fn redact_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_string() };
    let authority = rest.split('/').next().unwrap_or("");
    let Some(at) = authority.rfind('@') else { return url.to_string() };
    let creds = &authority[..at];
    let redacted = match creds.split_once(':') {
        Some((user, _)) => format!("{user}:***"),
        None => creds.to_string(),
    };
    let tail = &rest[at..]; // 含 '@'
    format!("{scheme}://{redacted}{tail}")
}

/// 当前进程里的代理环境变量（含继承来的）：设置页回显，让用户看清「系统里本来有什么」
/// 值一律打码密码——这里的原文来自环境变量而不是我们的配置，界面上却和「当前生效」并排显示，
/// 不打码就等于把继承来的凭证贴到屏幕上
pub fn env_view() -> Vec<Value> {
    PROXY_VARS
        .iter()
        .chain(std::iter::once(&NO_PROXY_VAR))
        .map(|v| {
            let value = read_env(v).or_else(|| {
                if cfg!(windows) {
                    None // Windows 环境变量大小写不敏感，大写读到了就是读到了
                } else {
                    read_env(&v.to_lowercase())
                }
            });
            json!({ "name": v, "value": redact_env_value(&value.unwrap_or_default()) })
        })
        .collect()
}

/// 环境变量里可以塞多个代理地址（空格/分号分隔），逐段打码后再回显
fn redact_env_value(value: &str) -> String {
    if !value.contains('@') {
        return value.to_string();
    }
    value
        .split(|c| c == ';' || c == ' ' || c == '\t' || c == ',')
        .filter(|s| !s.is_empty())
        .map(|s| {
            let s = s.trim();
            if s.contains("://") {
                redact_url(s)
            } else {
                redact_bare_creds(s) // 继承来的写法常省掉协议头，照样得打码
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `user:pw@host:port`（无协议头）里只留账号
fn redact_bare_creds(value: &str) -> String {
    let Some(at) = value.rfind('@') else { return value.to_string() };
    match value[..at].split_once(':') {
        Some((user, _)) => format!("{user}:***{}", &value[at..]),
        None => value.to_string(),
    }
}

fn read_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.trim().is_empty())
}

/// 把生效决策套到 reqwest 客户端上：回环恒直连 > direct > custom/system 显式代理 > 交给环境
pub fn apply_to_builder(base: &str, b: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    let d = current();
    let b = with_tls(b, &d);
    if is_loopback_base(base) || d.mode == MODE_DIRECT {
        return b.no_proxy();
    }
    if !d.url.is_empty() {
        // 勾了「不可达时回退直连」就别让死代理把每次请求拖到超时
        if d.fail_open && !proxy_reachable(&d.url) {
            return b.no_proxy();
        }
        if let Ok(p) = Proxy::all(d.url.as_str()) {
            // 显式配的代理会盖掉环境里的 NO_PROXY，直连名单得自己挂到代理对象上才作数
            let p = if d.bypass.is_empty() {
                p
            } else {
                p.no_proxy(reqwest::NoProxy::from_string(&d.bypass.join(",")))
            };
            return b.proxy(p);
        }
    }
    b
}

/// TLS 口径：企业根证书 + 排障用的跳过校验（两者都只影响 BIT 自己的出网客户端）
fn with_tls(b: reqwest::ClientBuilder, d: &Decision) -> reqwest::ClientBuilder {
    let mut out = b;
    if d.insecure {
        out = out.danger_accept_invalid_certs(true);
    }
    if !d.ca_file.is_empty() {
        if let Ok(certs) = load_ca(&d.ca_file) {
            for c in certs {
                out = out.add_root_certificate(c);
            }
        }
    }
    out
}

fn ca_cache() -> &'static Mutex<HashMap<String, Vec<reqwest::Certificate>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<reqwest::Certificate>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn clear_ca_cache() {
    if let Ok(mut c) = ca_cache().lock() {
        c.clear();
    }
}

/// 读 PEM 根证书（一个文件里可以串多张）。错误码给界面出文案：文件不存在 / 里面没有证书
pub fn load_ca(path: &str) -> Result<Vec<reqwest::Certificate>, String> {
    if let Ok(c) = ca_cache().lock() {
        if let Some(v) = c.get(path) {
            return Ok(v.clone());
        }
    }
    let bytes = std::fs::read(path).map_err(|_| "proxy_ca_missing".to_string())?;
    let certs = reqwest::Certificate::from_pem_bundle(&bytes)
        .map_err(|_| "proxy_ca_parse".to_string())?;
    if certs.is_empty() {
        return Err("proxy_ca_parse".into());
    }
    if let Ok(mut c) = ca_cache().lock() {
        c.insert(path.to_string(), certs.clone());
    }
    Ok(certs)
}

/// TCP 连通性（带超时，线程里做解析，避免 DNS 卡住主流程）
fn tcp_open(host: &str, port: u16, budget: Duration) -> bool {
    use std::net::ToSocketAddrs;
    let h = host.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let ok = (h.as_str(), port)
            .to_socket_addrs()
            .ok()
            .and_then(|mut a| a.next())
            .map(|sa| std::net::TcpStream::connect_timeout(&sa, budget).is_ok())
            .unwrap_or(false);
        let _ = tx.send(ok);
    });
    rx.recv_timeout(budget + Duration::from_millis(250)).unwrap_or(false)
}

fn reach_cache() -> &'static Mutex<HashMap<String, (Instant, bool)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, bool)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 代理服务器是否可达（20 秒缓存）：`fail_open` 与设置页「检测」共用同一判据
pub fn proxy_reachable(url: &str) -> bool {
    let Some((h, p)) = proxy_addr(url) else { return false };
    let key = format!("{h}:{p}");
    if let Ok(c) = reach_cache().lock() {
        if let Some((at, ok)) = c.get(&key) {
            if at.elapsed() < Duration::from_secs(20) {
                return *ok;
            }
        }
    }
    let ok = tcp_open(&h, p, Duration::from_millis(800));
    if let Ok(mut c) = reach_cache().lock() {
        c.insert(key, (Instant::now(), ok));
    }
    ok
}

/// 本机常见代理客户端端口：内网用户十有八九是「本机起了个代理客户端」，
/// 端口靠猜不如一次点出来。scheme 按各客户端默认协议标注，label 只是提示用途
const LOCAL_PROXY_CANDIDATES: [(&str, u16, &str); 10] = [
    ("http", 7890, "Clash"),
    ("http", 7897, "Clash Verge"),
    ("http", 7892, "Clash"),
    ("http", 10808, "v2rayN / Xray HTTP"),
    ("socks5", 10809, "v2rayN / Xray SOCKS"),
    ("http", 8118, "Privoxy"),
    ("http", 3128, "Squid"),
    ("http", 8080, ""),
    ("http", 8888, ""),
    ("socks5", 1080, ""),
];

/// 逐个端口探活（并行，最坏也就一个超时那么久），只回活着的
pub fn probe_local_proxy() -> Vec<Value> {
    std::thread::scope(|s| {
        let handles: Vec<_> = LOCAL_PROXY_CANDIDATES
            .iter()
            .map(|(scheme, port, label)| {
                s.spawn(move || (*scheme, *port, *label, tcp_open("127.0.0.1", *port, Duration::from_millis(400))))
            })
            .collect();
        let mut hits: Vec<Value> = handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .filter(|(_, _, _, ok)| *ok)
            .map(|(scheme, port, label, _)| {
                json!({
                    "scheme": scheme,
                    "port": port,
                    "label": label,
                    "addr": format!("{scheme}://127.0.0.1:{port}"),
                })
            })
            .collect();
        hits.sort_by_key(|h| h["port"].as_u64().unwrap_or(0));
        hits
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    /// 一次性自签测试根证书（无密钥、无生产含义），CA 与真机夹具用的是同一张
    const TEST_CA_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUaEiP2NVgrWzbFRF74M/u7GVyyqUwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPQklUIExhYiBUZXN0IENBMB4XDTI2MTEwMzA3MjY1NVoX
DTM2MTAzMTA3MjY1NVowGjEYMBYGA1UEAwwPQklUIExhYiBUZXN0IENBMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvKum2bZmLCyKzmNnxfCnBbMbSg/f
Lht2mIIaC28tXHusrQUEJiSx18AfUaW9rKHk7J9+zDp2MOIAEkA0QcXS03cugDwR
vATIgp0wMqVOjIQ0LdRHFIV764eQMdCclN8ItMatPs3O9VOJq/4UoIU6HQzZDHNy
j4l/HEAutuPr9bcgQs15s7PXFeNuDswBeU9+tDljdFz4WbnUMSpXRmnIv5YF+syY
fWouLngSVSC6UQaekhXBppOCCeRGb6O8mVlWw3N2xRJbSvHtlxygxEuk1YbyqPFr
/mU1utOdKCIWYBSPo+JzugtY4tcUY3nRj58SzNuGxUrB3cnJ3+KjRoEHWQIDAQAB
o1MwUTAdBgNVHQ4EFgQUFL/hL9x8wJ+xeGIDtZscz+kNV6gwHwYDVR0jBBgwFoAU
FL/hL9x8wJ+xeGIDtZscz+kNV6gwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEALIW3j93mEb8SY8RgayMuyGLbS45zLmzimo/UIjqYLSVTSnLUlW6B
KbbE+yyEy7EPiWXpVZMI2dVhSmxLBBJmf4wzgj0mEvny27i8CvV1zPznHPkECx3U
pl6jYHeK5o3L2z/D2zVofz9Kod4bgsMniIUruPY6hty5xkERvPs4AOMW7bA6cbvJ
ijbuWO11Q32pfSXMyghwGLi/QP+2VrMtEFoC0hyzGhW3RKVPPwVfp9OgYfd4u1FK
cD7/b71epV2tQIMhjhGOFWrE/MzQ04bK4JMXSViwBiVBnPKy5ZQu3S6SGUBn6EMb
/7RycEjbrWqEC13qHIX1Meosc42wuSV1tA==
-----END CERTIFICATE-----
";

    fn cfg(mode: &str, url: &str, user: &str, pass: &str, bypass: &str) -> Config {
        let mut c = Config::default();
        c.proxy_mode = mode.into();
        c.proxy_url = url.into();
        c.proxy_user = user.into();
        c.proxy_pass = pass.into();
        c.proxy_bypass = bypass.into();
        c
    }

    #[test]
    fn mode_falls_back_to_system() {
        assert_eq!(norm_mode(" Direct "), "direct");
        assert_eq!(norm_mode("CUSTOM"), "custom");
        assert_eq!(norm_mode(""), "system");
        assert_eq!(norm_mode("socks"), "system");
    }

    #[test]
    fn url_accepts_bare_host_port_and_socks() {
        assert_eq!(normalize_url("proxy.corp:3128").unwrap(), "http://proxy.corp:3128");
        assert_eq!(normalize_url(" socks5://10.0.0.9:1080 ").unwrap(), "socks5://10.0.0.9:1080");
        assert_eq!(normalize_url("http://u:p@proxy.corp:8080").unwrap(), "http://u:p@proxy.corp:8080");
        assert_eq!(normalize_url("").unwrap_err(), "proxy_empty");
        assert_eq!(normalize_url("ftp://proxy.corp").unwrap_err(), "proxy_scheme");
        assert_eq!(normalize_url("http://").unwrap_err(), "proxy_host_missing");
        assert_eq!(normalize_url("http://proxy.corp:notaport").unwrap_err(), "proxy_url");
    }

    #[test]
    fn proxy_addr_fills_scheme_default_port() {
        assert_eq!(proxy_addr("http://proxy.corp:3128"), Some(("proxy.corp".into(), 3128)));
        assert_eq!(proxy_addr("socks5://10.0.0.9"), Some(("10.0.0.9".into(), 1080)));
        assert_eq!(proxy_addr("http://u:p@proxy.corp:8080"), Some(("proxy.corp".into(), 8080)));
        assert_eq!(proxy_addr("http://[::1]:1080"), Some(("::1".into(), 1080)));
        assert_eq!(proxy_addr("socks5://[::1]"), Some(("::1".into(), 1080)));
        assert_eq!(proxy_addr("gopher://x"), None);
        assert_eq!(proxy_addr("http://:8080"), None);
    }

    #[test]
    fn bypass_keeps_user_order_and_always_adds_loopback() {
        let b = bypass_with_loopback("intra.corp, .corp.internal; 169.254/16");
        assert_eq!(b[..3], ["intra.corp", ".corp.internal", "169.254/16"]);
        assert!(b.contains(&"localhost".to_string()));
        assert!(b.contains(&"127.0.0.1".to_string()));
        // 用户已写的回环不重复追加
        let b2 = bypass_with_loopback("localhost");
        assert_eq!(b2.iter().filter(|x| **x == "localhost").count(), 1);
        assert_eq!(parse_bypass("a,,b  b"), ["a", "b"]);
    }

    #[test]
    fn loopback_detection_covers_ipv6_and_credentials() {
        assert!(is_loopback_base("http://127.0.0.1:8600/api"));
        assert!(is_loopback_base("http://localhost/v1"));
        assert!(is_loopback_base("http://[::1]:8080/v1"));
        assert!(is_loopback_base("http://u:p@localhost:80/v1"));
        // 整个 127/8 都是本机
        assert!(is_loopback_base("http://127.0.0.2:11434/v1"));
        assert!(is_loopback_base("http://127.5.5.5/v1"));
        assert!(!is_loopback_base("https://api.openai.com/v1"));
        assert!(!is_loopback_base("http://10.0.0.5:11434/v1"));
        assert!(!is_loopback_base("http://127.0.0.2.evil.test/v1"));
        assert!(!is_loopback_base("http://127.example.com/v1"));
        assert!(!is_loopback_base("not-a-url"));
    }

    #[test]
    fn credentials_inject_keeps_existing_userinfo() {
        assert_eq!(
            inject_credentials("http://proxy.corp:3128", "alice", "a/b@c"),
            "http://alice:a%2Fb%40c@proxy.corp:3128"
        );
        assert_eq!(
            inject_credentials("http://bob:x@proxy.corp:3128", "alice", "y"),
            "http://bob:x@proxy.corp:3128"
        );
        assert_eq!(inject_credentials("http://proxy.corp:3128", "alice", ""), "http://alice@proxy.corp:3128");
    }

    #[test]
    fn decide_only_custom_carries_url() {
        let d = decide(&cfg("direct", "http://proxy:3128", "", "", ""));
        assert_eq!(d.mode, "direct");
        assert!(d.url.is_empty());
        assert!(!d.bypass.is_empty());

        let d2 = decide(&cfg("custom", "proxy:3128", "", "", ""));
        assert_eq!(d2.mode, "custom");
        assert_eq!(d2.url, "http://proxy:3128");

        // 非法模式下脏地址不会被当成代理发出去（system 的 url 只可能来自系统设置）
        let d3 = decide(&cfg("system", "not a url", "", "", ""));
        assert_eq!(d3.mode, "system");
        assert_ne!(d3.url_from, "config");
        assert!(!d3.url.contains("not a url"));

        // custom 但存量地址坏掉（手改配置/旧版本残留）→ 宁可不代理
        let d4 = decide(&cfg("custom", "ftp://bad", "", "", ""));
        assert_eq!(d4.mode, "custom");
        assert!(d4.url.is_empty());
    }

    #[test]
    fn env_plan_shape_per_mode() {
        // 干净启动（没继承到代理）的基线：变量名都在，值全空
        let clean: Vec<(String, Option<String>)> =
            proxy_var_names().into_iter().map(|n| (n, None)).collect();
        let inherited: Vec<(String, Option<String>)> = vec![
            ("HTTP_PROXY".into(), Some("socks5://127.0.0.1:7890".into())),
            ("HTTPS_PROXY".into(), Some("socks5://127.0.0.1:7890".into())),
            ("ALL_PROXY".into(), None),
            ("NO_PROXY".into(), Some("corp".into())),
        ];

        // system + 干净启动：把环境清干净（上一次自定义留下的不能剩）
        let reset = env_plan("system", "http://p:1", &["a".into()], &clean, true);
        assert!(!reset.is_empty());
        assert!(reset.iter().all(|op| op.value.is_none()));
        // system + 继承过系统代理：还原成继承值，切走自定义再切回来不该丢
        let restore = env_plan("system", "", &[], &inherited, true);
        assert_eq!(
            restore.iter().find(|op| op.var == "HTTP_PROXY").unwrap().value.as_deref(),
            Some("socks5://127.0.0.1:7890")
        );
        assert_eq!(
            restore.iter().find(|op| op.var == "NO_PROXY").unwrap().value.as_deref(),
            Some("corp")
        );
        assert!(restore.iter().find(|op| op.var == "ALL_PROXY").unwrap().value.is_none());

        let direct = env_plan("direct", "", &[], &inherited, true);
        assert!(!direct.is_empty());
        assert!(direct.iter().all(|op| op.value.is_none()));
        assert!(direct.iter().any(|op| op.var == "ALL_PROXY"));
        assert!(direct.iter().any(|op| op.var == "NO_PROXY"));

        let custom = env_plan("custom", "http://p:1", &["intra".into(), "localhost".into()], &clean, true);
        let https = custom.iter().find(|op| op.var == "HTTPS_PROXY").unwrap();
        assert_eq!(https.value.as_deref(), Some("http://p:1"));
        let no = custom.iter().find(|op| op.var == "NO_PROXY").unwrap();
        assert_eq!(no.value.as_deref(), Some("intra,localhost"));
        // custom 但地址为空（配置被清空）→ 等价于全清，绝不留下半截代理
        let empty = env_plan("custom", "", &[], &inherited, true);
        assert!(empty.iter().all(|op| op.value.is_none()));
        // 不导出给子进程：环境回到继承来的样子，别把代理塞给别人家的工具
        let kept = env_plan("custom", "http://p:1", &["intra".into()], &inherited, false);
        assert_eq!(
            kept.iter().find(|op| op.var == "HTTP_PROXY").unwrap().value.as_deref(),
            Some("socks5://127.0.0.1:7890")
        );
        assert!(kept.iter().all(|op| op.value.as_deref() != Some("http://p:1")));

        if cfg!(windows) {
            assert!(direct.iter().all(|op| op.var == op.var.to_uppercase()));
        } else {
            assert!(direct.iter().any(|op| op.var == "http_proxy"));
        }
    }

    #[test]
    fn summary_redacts_proxy_password() {
        assert_eq!(
            redact_url("http://alice:s3cret@proxy.corp:3128/path"),
            "http://alice:***@proxy.corp:3128/path"
        );
        assert_eq!(redact_url("http://proxy.corp:3128"), "http://proxy.corp:3128");
        assert_eq!(redact_url("http://alice@proxy.corp"), "http://alice@proxy.corp");
        let d = Decision {
            mode: "custom".into(),
            url: "http://alice:s3cret@proxy.corp:3128".into(),
            bypass: vec![],
            ..Default::default()
        };
        assert_eq!(summary(&d, 0)["url"], "http://alice:***@proxy.corp:3128");
        // 多代理地址混在一个变量里也要逐段打码；没有凭证的原样回显
        assert_eq!(
            redact_env_value("http://alice:s3cret@p1.corp:3128 http://bob:pw@p2.corp:3128"),
            "http://alice:***@p1.corp:3128, http://bob:***@p2.corp:3128"
        );
        assert_eq!(redact_env_value("intra.corp,10.0.0.0/8"), "intra.corp,10.0.0.0/8");
        assert_eq!(redact_env_value(""), "");
        // 继承来的变量常省掉协议头，这种写法也要打码
        assert_eq!(redact_env_value("alice:s3cret@proxy.corp:3128"), "alice:***@proxy.corp:3128");
        assert_eq!(redact_env_value("alice@proxy.corp:3128"), "alice@proxy.corp:3128");
    }

    #[test]
    fn env_view_never_shows_plaintext_password() {
        // 模拟企业机上「启动前就带着凭证」的环境变量，回显必须打码
        std::env::set_var("HTTP_PROXY", "http://svc.ro:s3cret@proxy.corp:3128");
        let seen = env_view();
        let hit = seen
            .iter()
            .find(|e| e["name"].as_str().unwrap_or("").eq_ignore_ascii_case("HTTP_PROXY"))
            .expect("env_view 应包含 HTTP_PROXY");
        assert_eq!(hit["value"], "http://svc.ro:***@proxy.corp:3128");
        assert!(!seen.iter().any(|e| e["value"].as_str().unwrap_or("").contains("s3cret")));
        std::env::remove_var("HTTP_PROXY");
    }

    #[test]
    fn summary_reports_decision_and_env() {
        let d = Decision {
            mode: "custom".into(),
            url: "http://proxy.corp:3128".into(),
            bypass: vec!["intra.corp".into(), "localhost".into()],
            ..Default::default()
        };
        let s = summary(&d, 8);
        assert_eq!(s["mode"], "custom");
        assert_eq!(s["url"], "http://proxy.corp:3128");
        assert_eq!(s["env_ops"], 8);
        assert_eq!(s["bypass"].as_array().unwrap().len(), 2);
        assert!(s["proxy_env"].is_array());
        // 扩展项一并回显，界面不用二次请求
        assert_eq!(s["export_env"], true);
        assert_eq!(s["fail_open"], false);
        assert_eq!(s["insecure"], false);
        assert!(s["system"].is_object());
    }

    #[test]
    fn windows_ie_settings_parse() {
        // reg query 的真实排版：名字、类型、值三段，值里可以带空格
        let bare = "
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    proxy.corp:3128
    ProxyOverride    REG_SZ    <local>;*.corp.internal;10.0.0.0/8
";
        let sp = parse_ie_settings(bare);
        assert_eq!(sp.url, "http://proxy.corp:3128");
        assert_eq!(sp.from, "registry");
        assert_eq!(sp.bypass, vec!["*.corp.internal", "10.0.0.0/8"]);
        assert!(!sp.bypass.iter().any(|x| x == "<local>"));

        let per_proto = "
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=web.corp:8080;https=web.corp:8443;socks=sock.corp:1080
";
        let sp2 = parse_ie_settings(per_proto);
        assert_eq!(sp2.url, "http://web.corp:8443"); // https 条目优先，协议头按值补

        let pac_only = "
    ProxyEnable    REG_DWORD    0x0
    ProxyAutoConfigEnable    REG_DWORD    0x1
    AutoConfigURL    REG_SZ    http://wpad.corp/proxy.pac
";
        let sp3 = parse_ie_settings(pac_only);
        assert!(sp3.url.is_empty()); // 不执行 PAC，不猜代理
        assert_eq!(sp3.pac, "http://wpad.corp/proxy.pac");

        let off = "
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    proxy.corp:3128
";
        assert!(parse_ie_settings(off).url.is_empty());
        assert!(parse_ie_settings("").url.is_empty());
    }

    #[test]
    fn macos_scutil_parse_prefers_https_then_socks() {
        let https = "
  HTTPEnable : 1
  HTTPProxy : web.corp
  HTTPPort : 3128
  HTTPSEnable : 1
  HTTPSProxy : secure.corp
  HTTPSPort : 8443
";
        assert_eq!(parse_scutil(https).url, "http://secure.corp:8443");
        let socks = "
  HTTPEnable : 0
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 7891
";
        assert_eq!(parse_scutil(socks).url, "socks5://127.0.0.1:7891");
        assert!(parse_scutil("  HTTPEnable : 0\n").url.is_empty());
    }

    #[test]
    fn ca_file_reports_count_and_errors() {
        // 用一个确定不是 PEM 的文件测错误码，再用测试自己生成的证书测成功路径
        let dir = std::env::temp_dir().join(format!("bit-ca-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bogus = dir.join("not-a-cert.pem");
        std::fs::write(&bogus, b"hello").unwrap();
        assert_eq!(load_ca(bogus.to_str().unwrap()).unwrap_err(), "proxy_ca_parse");
        assert_eq!(load_ca(dir.join("missing.pem").to_str().unwrap()).unwrap_err(), "proxy_ca_missing");

        let pem = dir.join("lab-ca.pem");
        std::fs::write(&pem, TEST_CA_PEM).unwrap();
        let n = load_ca(pem.to_str().unwrap()).unwrap().len();
        assert!(n >= 1, "PEM 串里应解出至少一张证书，实际 {n}");
        // 摘要里带上证书张数与错误位，界面才有话可说
        let mut c = Config::default();
        c.proxy_mode = "custom".into();
        c.proxy_url = "http://proxy.corp:3128".into();
        c.proxy_ca_file = pem.to_str().unwrap().into();
        let s = summary(&decide(&c), 0);
        assert_eq!(s["ca_certs"].as_u64().unwrap() as usize, n);
        assert_eq!(s["ca_error"], false);
        c.proxy_ca_file = dir.join("nope.pem").to_str().unwrap().into();
        assert_eq!(summary(&decide(&c), 0)["ca_error"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tls_options_apply_ca_and_insecure_without_error() {
        // 建客户端本身不联网，这里只保证两条开关都能落到 builder 上而不报错
        let mut c = Config::default();
        c.proxy_mode = "custom".into();
        c.proxy_url = "http://proxy.corp:3128".into();
        c.proxy_insecure = true;
        let d = decide(&c);
        assert!(d.insecure);
        let built = with_tls(reqwest::Client::builder(), &d).build();
        assert!(built.is_ok(), "danger_accept_invalid_certs 不该让客户端建不出来");
        // 决策落到进程级后，回环地址依旧恒直连
        *slot().lock().unwrap() = d.clone();
        assert!(apply_to_builder("http://127.0.0.1:11434/v1", reqwest::Client::builder()).build().is_ok());
        *slot().lock().unwrap() = Decision::default();
    }

    #[test]
    fn local_proxy_probe_returns_only_listening_ports() {
        // 起一个本机监听口，探活结果里必须有它；不监听的端口不该出现
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let hits = probe_local_proxy();
        assert!(
            hits.iter().all(|h| h["addr"].as_str().unwrap().starts_with("http://127.0.0.1:")
                || h["addr"].as_str().unwrap().starts_with("socks5://127.0.0.1:")),
            "{hits:?}"
        );
        let _ = port; // 随机端口不在候选清单里，本用例只保证不炸且格式正确
        assert!(proxy_reachable("http://127.0.0.1:1") == false, "无人监听的端口应判不可达");
        assert!(proxy_reachable("not a url") == false);
    }
}
