// 纯文本出口清洗：系统通知、托盘这类"只认字，不认格式"的地方。
//! AI 回复与插件正文都是 markdown，直接塞进 Windows 吐司就变成
//! `## **结论**：见下表 |---|` 这种没人看得懂的乱码串。这里把标记剥干净，
//! 压成一行适合吐司的短句——只做"去掉格式"，不改写内容本身。

/// 通知正文上限（字节）：与旧口径一致，80 字节日约 26 个汉字，够看清一句结论。
const TOAST_MAX: usize = 80;

/// 主入口：markdown/HTML → 一行纯文本，末尾按字节上限截断（带省略号）。
pub fn for_toast(raw: &str) -> String {
    let flat = collapse(&strip_inline(&strip_blocks(raw)));
    if flat.trim().is_empty() {
        // 整条回复只有代码块/表格线时，别丢给系统通知一个空气泡
        return "（内容以代码或表格为主，请打开会话查看）".to_string();
    }
    crate::registry::safe_trunc(flat.trim(), TOAST_MAX)
}

/// 插件正文走同一条清洗，但上限保持原来的 400 字（插件作者写的正文比 AI 回复长）。
pub fn for_plugin_notify(raw: &str) -> String {
    let flat = collapse(&strip_inline(&strip_blocks(raw)));
    let trimmed = flat.trim();
    if trimmed.is_empty() {
        return "（内容以代码或表格为主）".to_string();
    }
    trimmed.chars().take(400).collect::<String>()
}

/// 块级清洗：逐行去掉围栏代码、标题井号、引用竖线、分隔线、表格对齐行，
/// 并把列表符号统一成一种、把多行表格压成一行。
fn strip_blocks(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_fence = false;
    for line in raw.lines() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || t.is_empty() {
            continue;
        }
        // 表格分隔行（|---|:--:|）整行没有信息，直接丢
        if is_table_rule(t) {
            continue;
        }
        let mut s = t.to_string();
        // 标题：# / ## / ###### 一律去掉井号
        if s.starts_with('#') {
            s = s.trim_start_matches('#').trim_start().to_string();
        }
        // 有序与无序列表：统一成 "· "，读起来像一句话的枚举而不是缩进游戏
        s = strip_list_marker(&s);
        // 引用块
        while s.starts_with('>') {
            s = s[1..].trim_start().to_string();
        }
        // 分割线（--- / *** / ___）
        if s.chars().all(|c| matches!(c, '-' | '*' | '_')) && s.chars().count() >= 3 {
            continue;
        }
        // 表格行：竖线换成可读的分隔
        if s.contains('|') {
            s = s
                .split('|')
                .map(|c| c.trim())
                .filter(|c| !c.is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
            if s.trim_matches('·').trim().is_empty() {
                continue;
            }
        }
        out.push_str(&s);
        out.push(' ');
    }
    out
}

fn is_table_rule(t: &str) -> bool {
    t.contains('|')
        && !t.is_empty()
        && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

fn strip_list_marker(s: &str) -> String {
    let rest = s.trim_start_matches(['-', '*', '+', '•']).trim_start();
    if rest.len() < s.len() && !rest.is_empty() {
        return format!("· {rest}");
    }
    // "1. xxx" / "2) xxx" 这类有序号
    if let Some(i) = s.find(|c: char| c == '.' || c == ')') {
        let head = &s[..i];
        if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
            return format!("· {}", s[i + 1..].trim_start());
        }
    }
    s.to_string()
}

/// 行内清洗：强调符号、行内代码、链接与图片、HTML 标签。
fn strip_inline(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        // 链接与图片：[文本](url) / ![alt](url) → 只留标题文字
        if c == '[' || (c == '!' && i + 1 < chars.len() && chars[i + 1] == '[') {
            if let Some((text, next)) = take_link(&chars, i) {
                out.push_str(&text);
                i = next;
                continue;
            }
        }
        // 自动链接 <https://…>：URL 在吐司里点不动，留着只会占字数
        if c == '<' {
            if let Some((end, inner)) = angle_span(&chars, i) {
                if !inner.starts_with(char::is_alphabetic) && !inner.starts_with('/') {
                    // 不是标签（多半是 "3<4" 这种比较号），原样保留
                    out.push(c);
                    i += 1;
                    continue;
                }
                if is_autolink(&inner) {
                    i = end + 1;
                    continue;
                }
                i = end + 1; // HTML 标签整体丢掉
                continue;
            }
        }
        // 成对强调：先吃双字符标记（** / __），再吃删除线，单字符兜底
        if (c == '*' || c == '_') && chars.get(i + 1) == Some(&c) {
            i += 2;
            continue;
        }
        if c == '~' && chars.get(i + 1) == Some(&'~') {
            i += 2;
            continue;
        }
        if matches!(c, '*' | '_' | '`') {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 取一段 [文本](url) / ![alt](url)，返回（要留下的文字, 下一个下标）。
fn take_link(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut i = start;
    if chars.get(i) == Some(&'!') {
        i += 1;
    }
    if chars.get(i) != Some(&'[') {
        return None;
    }
    let close = i + 1;
    let mut j = close;
    while j < chars.len() && chars[j] != ']' {
        j += 1;
    }
    if j >= chars.len() {
        return None;
    }
    let text: String = chars[close..j].iter().collect();
    // 后面没有 (url) 就是普通方括号，原样给出（保留方括号本身更诚实）
    if chars.get(j + 1) != Some(&'(') {
        return None;
    }
    let mut k = j + 2;
    while k < chars.len() && chars[k] != ')' {
        k += 1;
    }
    if k >= chars.len() {
        return None;
    }
    Some((text, k + 1))
}

/// < 之后到最近 > 的片段；要求中间没有换行，避免把 "3<4 且 5>2" 吞掉一整段。
fn angle_span(chars: &[char], start: usize) -> Option<(usize, String)> {
    let mut end = start + 1;
    while end < chars.len() && chars[end] != '>' && chars[end] != '\n' {
        end += 1;
    }
    if end >= chars.len() || chars[end] != '>' {
        return None;
    }
    Some((end, chars[start + 1..end].iter().collect()))
}

fn is_autolink(inner: &str) -> bool {
    inner.starts_with("http://") || inner.starts_with("https://") || inner.starts_with("mailto:")
}

/// 空白收敛：多个空格并一个，行分隔统一成 " · "（列表项之间读得开）。
fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heading_bold_and_table_markers_are_gone() {
        let got = for_toast("## **结论**：这批**已完成**\n|名称|状态|\n|---|:--:|\n|网关|ok|");
        assert!(!got.contains('#') && !got.contains('*') && !got.contains('|'), "{got}");
        assert!(got.contains("结论") && got.contains("网关"), "{got}");
    }

    #[test]
    fn code_fence_dropped_but_a_note_remains() {
        assert_eq!(for_toast("```python\nprint(1)\n```"), "（内容以代码或表格为主，请打开会话查看）");
        let got = for_toast("先看 `a.py`：\n```py\nx=1\n```\n然后跑起来。");
        assert!(!got.contains('`') && !got.contains("x=1"), "{got}");
        assert!(got.contains("a.py") && got.contains("然后跑起来"), "{got}");
    }

    #[test]
    fn links_keep_text_and_auto_links_vanish() {
        assert_eq!(for_toast("[外部网关](https://x.example/mcp) 已连通").trim(), "外部网关 已连通");
        let bare = for_toast("参考 <https://example.com/a> 这一页");
        assert!(!bare.contains("https://example.com"), "{bare}");
    }

    #[test]
    fn comparison_signs_are_not_treated_as_tags() {
        let got = for_toast("如果 3<4 且 5>2 就成立");
        assert!(got.contains("3<4"), "{got}");
    }

    #[test]
    fn html_tags_never_reach_the_toast() {
        let got = for_toast("<div class=\"x\">已同步 <b>12</b> 条</div>");
        assert!(!got.contains('<') && !got.contains('"'), "{got}");
        assert!(got.contains("已同步 12 条"), "{got}");
    }

    #[test]
    fn lists_collapse_to_one_readable_line() {
        let got = for_toast("- 建好\n* 验完\n3. 收工");
        assert_eq!(got.trim(), "· 建好 · 验完 · 收工", "{got}");
    }

    #[test]
    fn long_text_truncates_at_char_boundary() {
        let long = "结".repeat(120);
        let got = for_toast(&long);
        assert!(got.chars().count() <= 40 && got.ends_with('…'), "{} chars", got.chars().count());
    }
}
