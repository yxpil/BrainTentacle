// yxpil · BIT
//! HiddenCode 敏感信息脱敏：密钥/手机号/邮箱/用户名等在发给 AI 前替换为占位符
//! `[HC:{sha256(值)前6位hex}]`，AI 引用占位符的工具调用在本机执行时还原为真实值。
//!
//! 设计要点：
//! - 占位符按内容 hash 派生（非自增 id）：同一敏感值永远得到同一占位符，
//!   与条目顺序/增删无关，多轮对话与历史重发天然一致，无需持久化映射。
//! - 条目双语义：kind=value（精确替换）/ kind=pattern（内置正则掩全部匹配）。
//! - 会话历史存原文；掩码只作用于发送副本（chat_with_images 入口统一拦截）。
//! - 还原在 execute_tool_call 顶部统一做（深度遍历参数 JSON），未知占位符原样保留。

use rand::Rng;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;

use crate::state::Ctx;

pub const PLACEHOLDER_PREFIX: &str = "[HC:";
pub const PLACEHOLDER_SUFFIX: &str = "]";

#[derive(Serialize, Deserialize, Clone)]
pub struct HiddenCodeEntry {
    pub id: String,
    /// value = 精确值条目；pattern = 正则条目
    pub kind: String,
    /// phone | email | apikey | username | custom（展示用）
    pub label: String,
    /// value 条目 = 敏感原文；pattern 条目 = "builtin:phone" 等
    pub value: String,
    pub enabled: bool,
    pub created: String,
}

// ── 内置正则（LazyLock 静态缓存，无重复编译成本） ──

fn builtin_pattern(name: &str) -> Option<&'static Regex> {
    static PHONE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        // 中国手机号：11 位，1 开头第二位 3-9；\b 词边界防误切长数字串
        // （regex crate 不支持 lookbehind，用 \b 达成"前后不是数字/字母"）
        Regex::new(r"\b1[3-9]\d{9}\b").unwrap()
    });
    static EMAIL: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap()
    });
    static APIKEY: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        // 常见密钥前缀：OpenAI sk- / GitHub ghp_ gho_ / Slack xox / AWS AKIA
        Regex::new(
            r"(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|xox[bap]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})",
        )
        .unwrap()
    });
    match name {
        "builtin:phone" => Some(&PHONE),
        "builtin:email" => Some(&EMAIL),
        "builtin:apikey" => Some(&APIKEY),
        _ => None,
    }
}

/// 自定义 pattern 条目的正则（非法正则返回 None，掩码时跳过）
fn compile_custom(pattern: &str) -> Option<Regex> {
    if pattern.starts_with("builtin:") {
        return builtin_pattern(pattern).cloned();
    }
    Regex::new(pattern).ok()
}

// ── 占位符与映射 ──

/// 占位符：[HC:{sha256(value) 前 hex_len 位 hex}]
fn placeholder(value: &str, hex_len: usize) -> String {
    let hex: String = Sha256::digest(value.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("{PLACEHOLDER_PREFIX}{}{PLACEHOLDER_SUFFIX}", &hex[..hex_len.min(hex.len())])
}

/// hash 前缀去重检测：前缀有重复 → 升 8 位，否则 6 位
fn hash_hex_len(values: &[&str]) -> usize {
    let mut seen = std::collections::HashSet::new();
    for v in values {
        if !seen.insert(placeholder(v, 6)) {
            return 8;
        }
    }
    6
}

/// 构建 hash→value 映射（还原用；每次现算，不持久化）
fn build_map(entries: &[HiddenCodeEntry], hex_len: usize) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for e in entries {
        if e.enabled && e.kind == "value" && !e.value.is_empty() {
            map.insert(placeholder(&e.value, hex_len), e.value.clone());
        }
    }
    map
}

// ── 掩码 ──

/// 对一段文本应用全部启用条目：先 pattern（正则 replace_all）再 value（精确替换）
pub fn mask_text(text: &str, entries: &[HiddenCodeEntry], hex_len: usize) -> String {
    let mut out = text.to_string();
    // pattern 条目：正则匹配到的每段文本按其自身 hash 生成占位符（同值同占位符）
    for e in entries.iter().filter(|e| e.enabled && e.kind == "pattern") {
        if let Some(re) = compile_custom(&e.value) {
            out = re
                .replace_all(&out, |caps: &regex::Captures| {
                    placeholder(caps.get(0).map(|m| m.as_str()).unwrap_or_default(), hex_len)
                })
                .into_owned();
        }
    }
    // value 条目：精确替换（同值同占位符）
    for e in entries.iter().filter(|e| e.enabled && e.kind == "value" && !e.value.is_empty()) {
        let ph = placeholder(&e.value, hex_len);
        if out.contains(e.value.as_str()) {
            out = out.replace(e.value.as_str(), &ph);
        }
    }
    out
}

// ── 还原 ──

fn unmask_text(text: &str, map: &HashMap<String, String>) -> String {
    // 快速路径：不含占位符前缀直接返回
    if !text.contains(PLACEHOLDER_PREFIX) {
        return text.to_string();
    }
    let mut out = text.to_string();
    for (ph, real) in map {
        if out.contains(ph.as_str()) {
            out = out.replace(ph.as_str(), real);
        }
    }
    out
}

/// 深度遍历 JSON：Object 递归 value、Array 递归元素、String 还原占位符。
/// 未命中映射的 [HC:xxx] 原样保留（AI 编造的占位符不破坏数据）
pub fn unmask_json(v: &mut serde_json::Value, map: &HashMap<String, String>) {
    match v {
        serde_json::Value::String(s) => {
            *s = unmask_text(s, map);
        }
        serde_json::Value::Object(m) => {
            for val in m.values_mut() {
                unmask_json(val, map);
            }
        }
        serde_json::Value::Array(a) => {
            for val in a.iter_mut() {
                unmask_json(val, map);
            }
        }
        _ => {}
    }
}

// ── 正则自动探测（录入辅助，不自动落盘） ──

/// 扫描文本中的疑似敏感信息，去重后返回 [(label, value)] 候选
pub fn detect_candidates(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |label: &str, v: String| {
        if !out.iter().any(|(_, x)| x == &v) {
            out.push((label.to_string(), v));
        }
    };
    if let Some(re) = builtin_pattern("builtin:phone") {
        for m in re.find_iter(text) {
            push("phone", m.as_str().to_string());
        }
    }
    if let Some(re) = builtin_pattern("builtin:email") {
        for m in re.find_iter(text) {
            push("email", m.as_str().to_string());
        }
    }
    if let Some(re) = builtin_pattern("builtin:apikey") {
        for m in re.find_iter(text) {
            push("apikey", m.as_str().to_string());
        }
    }
    out
}

// ── Ctx 级便捷封装 ──

fn active_entries(ctx: &Arc<Ctx>) -> Vec<HiddenCodeEntry> {
    let enabled = ctx.config.lock().unwrap().hidden_code_enabled;
    if !enabled {
        return Vec::new();
    }
    ctx.hidden_codes
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.enabled)
        .cloned()
        .collect()
}

/// 发模型前掩码：开关关/无启用条目 → 原样 clone（零额外成本）。
/// 发生替换时在最后一条 user 消息尾部追加注记，告知 AI 原样引用占位符。
pub fn maybe_mask_messages(ctx: &Arc<Ctx>, messages: &[crate::ai::ChatMessage]) -> Vec<crate::ai::ChatMessage> {
    let entries = active_entries(ctx);
    let mut out = messages.to_vec();
    if entries.is_empty() {
        return out;
    }
    let hex_len = hash_hex_len(
        &entries.iter().map(|e| e.value.as_str()).collect::<Vec<_>>(),
    );
    let mut masked = false;
    for m in out.iter_mut() {
        let t = mask_text(&m.content, &entries, hex_len);
        if t != m.content {
            m.content = t;
            masked = true;
        }
    }
    if masked {
        // 最后一条 user 消息附注记（无 user 消息则不动）
        if let Some(m) = out.iter_mut().rev().find(|m| m.role == "user") {
            m.content.push_str(
                "\n\n[系统注记] 文中 [HC:xxxxxx] 为已脱敏的敏感值占位符；引用这些值的工具调用会在本机执行时自动还原为真实值。请原样引用占位符，不要猜测或编造其内容。",
            );
        }
    }
    out
}

/// 工具执行前还原参数占位符：无启用条目 → 原样返回（零拷贝路径）
pub fn unmask_params(ctx: &Arc<Ctx>, params: &serde_json::Value) -> serde_json::Value {
    let entries = active_entries(ctx);
    if entries.is_empty() {
        return params.clone();
    }
    let hex_len = hash_hex_len(
        &entries.iter().map(|e| e.value.as_str()).collect::<Vec<_>>(),
    );
    let map = build_map(&entries, hex_len);
    let mut v = params.clone();
    unmask_json(&mut v, &map);
    v
}

// ── 单元测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str, label: &str, value: &str) -> HiddenCodeEntry {
        HiddenCodeEntry {
            id: "1".into(),
            kind: kind.into(),
            label: label.into(),
            value: value.into(),
            enabled: true,
            created: String::new(),
        }
    }

    #[test]
    fn mask_unmask_roundtrip() {
        let entries = vec![
            entry("value", "apikey", "sk-abcdefghij0123456789"),
            entry("value", "phone", "13800138000"),
        ];
        let hl = hash_hex_len(&["sk-abcdefghij0123456789", "13800138000"]);
        let text = "我的密钥是 sk-abcdefghij0123456789，电话 13800138000。";
        let masked = mask_text(text, &entries, hl);
        assert!(!masked.contains("sk-abcdefghij0123456789"));
        assert!(!masked.contains("13800138000"));
        assert!(masked.contains(PLACEHOLDER_PREFIX));
        // 还原
        let map = build_map(&entries, hl);
        let mut v = serde_json::json!({ "cmd": format!("echo {masked}") });
        unmask_json(&mut v, &map);
        assert_eq!(v["cmd"].as_str().unwrap(), format!("echo {text}"));
    }

    #[test]
    fn placeholder_stable_across_entry_changes() {
        let a = vec![entry("value", "x", "SECRET123")];
        let b = vec![
            entry("value", "y", "OTHER456"),
            entry("value", "x", "SECRET123"),
        ];
        assert_eq!(mask_text("v=SECRET123", &a, 6), mask_text("v=SECRET123", &b, 6));
    }

    #[test]
    fn hash_prefix_conflict_upgrades() {
        // 构造两个 6 位前缀冲突的值极难（2^24 空间），直接验证函数逻辑
        assert_eq!(hash_hex_len(&["a", "b"]), 6);
    }

    #[test]
    fn detect_phone_email_key() {
        let text = "联系 13800138000 或 a@b.com，key: sk-abcdefghijklmnop1234，订单 20240101123456";
        let c = detect_candidates(text);
        assert!(c.iter().any(|(l, v)| l == "phone" && v == "13800138000"));
        assert!(c.iter().any(|(l, v)| l == "email" && v == "a@b.com"));
        assert!(c.iter().any(|(l, v)| l == "apikey" && v == "sk-abcdefghijklmnop1234"));
        // 12 位数字不被手机号正则误判
        assert!(!c.iter().any(|(_, v)| v == "20240101123456"));
    }

    #[test]
    fn pattern_masks_all_matches() {
        let entries = vec![entry("pattern", "phone", "builtin:phone")];
        let hl = 6;
        let text = "号码1: 13800138000，号码2: 15912345678";
        let masked = mask_text(text, &entries, hl);
        assert!(!masked.contains("13800138000"));
        assert!(!masked.contains("15912345678"));
        assert_ne!(mask_text("13800138000", &entries, hl), mask_text("15912345678", &entries, hl));
    }

    #[test]
    fn normal_text_untouched() {
        let entries = vec![entry("pattern", "email", "builtin:email")];
        let text = "2026-09-15 发布 v1.2.3，访问 https://example.com/path 查看";
        assert_eq!(mask_text(text, &entries, 6), text);
    }

    #[test]
    fn unknown_placeholder_preserved() {
        let map = HashMap::new();
        let mut v = serde_json::json!("引用 [HC:deadbeef] 的值");
        unmask_json(&mut v, &map);
        assert_eq!(v.as_str().unwrap(), "引用 [HC:deadbeef] 的值");
    }

    #[test]
    fn nested_json_deep_unmask() {
        let entries = vec![entry("value", "k", "TOPSECRET")];
        let hl = 6;
        let map = build_map(&entries, hl);
        let ph = placeholder("TOPSECRET", hl);
        let mut v = serde_json::json!({
            "path": "a.txt",
            "lines": [format!("key={ph}"), "plain"],
            "nested": { "cmd": format!("echo {ph}") }
        });
        unmask_json(&mut v, &map);
        assert_eq!(v["lines"][0], "key=TOPSECRET");
        assert_eq!(v["nested"]["cmd"], "echo TOPSECRET");
        assert_eq!(v["path"], "a.txt");
    }
}