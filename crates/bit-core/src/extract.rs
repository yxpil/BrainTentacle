// yxpil · BIT
//! 附件解析：Excel → Markdown 表格、Word(.docx) / PPT(.pptx) / PDF → 纯文本、
//! 文本与代码类（.txt/.md/.csv/.json/.html…）直接按字符读、网页 → 正文文字。
//! 均在后端完成，前端只负责把文件读成 base64 或把 URL 传进来。

use base64::Engine;
use std::io::Read;

/// 把前端传来的 base64（可含 data:URL 前缀）解码为字节
pub(crate) fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    let raw = match data.find(",") {
        // data:*/*;base64,XXXX → 取逗号后半段
        Some(pos) if data.starts_with("data:") => &data[pos + 1..],
        _ => data,
    };
    base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))
}

/// 根据文件名后缀分派解析；返回提取出的文本（Excel 为 Markdown 表格）
pub fn extract(filename: &str, base64_data: &str) -> Result<String, String> {
    let bytes = decode_base64(base64_data)?;
    extract_bytes(filename, &bytes)
}

/// 能解析的类别，分派表与「能不能解析」的判定共用这一处，避免两边漂移
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Excel,
    Docx,
    Pptx,
    Pdf,
    Text,
}

fn kind_of(lower: &str) -> Option<DocKind> {
    if [".xlsx", ".xls", ".xlsm", ".ods"].iter().any(|e| lower.ends_with(e)) {
        return Some(DocKind::Excel);
    }
    if lower.ends_with(".docx") {
        return Some(DocKind::Docx);
    }
    if lower.ends_with(".pptx") {
        return Some(DocKind::Pptx);
    }
    if lower.ends_with(".pdf") {
        return Some(DocKind::Pdf);
    }
    if is_text_like(lower) {
        return Some(DocKind::Text);
    }
    None
}

/// 这个文件能不能在这里解析出正文（右键「查看详情」要说这句话）。
/// 插件登记的文件类型不算在这里：那条口径见 `filekinds::parses`。
pub fn supports(filename: &str) -> bool {
    kind_of(&filename.to_ascii_lowercase()).is_some()
}

/// 按文件名后缀解析字节 → 正文：体积闸、分派、字数封顶都在这里。
/// 模型侧的 read_doc 走这条路（它拿到的是磁盘绝对路径，没有 base64）。
pub fn extract_bytes(filename: &str, bytes: &[u8]) -> Result<String, String> {
    let lower = filename.to_ascii_lowercase();
    // 解析入口是用户随手拖进来的文件：先按体积设一道闸，
    // 免得一个几百 MB 的包把阻塞线程和内存一起吃掉
    const MAX_INPUT_BYTES: usize = 60 * 1024 * 1024;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "文件过大（约 {} MB），不支持解析；需要内容时按绝对路径用 read_file 读取",
            bytes.len() / 1024 / 1024
        ));
    }
    let text = match kind_of(&lower) {
        Some(DocKind::Excel) => excel_to_markdown(bytes),
        Some(DocKind::Docx) => docx_to_text(bytes),
        Some(DocKind::Pptx) => pptx_to_text(bytes),
        Some(DocKind::Pdf) => pdf_to_text(bytes),
        Some(DocKind::Text) => bytes_to_text(bytes),
        // 方括号前缀是给界面认的稳定标记：英文界面按它换本地文案，认不出来时退回这段中文
        None => Err(format!(
            "[unsupported_kind] 暂不支持的文件类型：{filename}（支持 .xlsx/.xls/.docx/.pptx/.pdf 与 .txt/.md/.csv/.json/.html 等文本类）"
        )),
    }?;
    Ok(cap_text(&text))
}

/// 概览门槛：行数与字数都不到这两个数就整份给模型——三行的小抄做摘要反而更费字
const OVERVIEW_MIN_LINES: usize = 40;
const OVERVIEW_MIN_CHARS: usize = 1500;
/// 大纲条数上限，以及大纲每条 / 摘录每行留多少字
const OVERVIEW_MAX_MARKS: usize = 12;
const OVERVIEW_MARK_CHARS: usize = 60;
const OVERVIEW_HEAD_LINES: usize = 6;
const OVERVIEW_HEAD_CHARS: usize = 100;

/// 按字符截断（中文一个字都不许切坏），超了就补省略号
fn clip_chars(s: &str, n: usize) -> String {
    let taken: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        format!("{taken}…")
    } else {
        taken
    }
}

/// 附件正文 → 给模型的概览：规模 + 结构大纲 + 带行号的开头摘录 + 按需取细节的指引。
/// 只在「正文够大」且「模型自己还能再读到」（有本地绝对路径）时才摘要；
/// 粘贴进来的件没有路径，摘要了正文就真丢了，所以那种情况原样返回全文。
pub fn overview(filename: &str, text: &str, path: Option<&str>) -> String {
    let Some(file) = path.map(str::trim).filter(|p| !p.is_empty() && !p.starts_with("http://") && !p.starts_with("https://")) else {
        return text.to_string();
    };
    let lines: Vec<&str> = text.lines().collect();
    let n_lines = lines.len();
    let n_chars = text.chars().count();
    if n_lines <= OVERVIEW_MIN_LINES && n_chars <= OVERVIEW_MIN_CHARS {
        return text.to_string();
    }

    let lower = filename.to_ascii_lowercase();
    let mut marks: Vec<String> = Vec::new();
    if lower.ends_with(".csv") || lower.ends_with(".tsv") {
        if let Some(head) = lines.iter().map(|l| l.trim()).find(|l| !l.is_empty()) {
            marks.push(format!("列：{}", clip_chars(head, OVERVIEW_MARK_CHARS)));
            marks.push(format!("数据 {} 行", n_lines.saturating_sub(1)));
        }
    }
    for (i, raw) in lines.iter().enumerate() {
        if marks.len() >= OVERVIEW_MAX_MARKS {
            break;
        }
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("【第 ") && t.contains('】') {
            // 「【第 3 页】」这一行本身就是页标记，取括号里的「第 3 页」当条目
            let page = t.trim_start_matches('【').split('】').next().unwrap_or("页");
            // 页标题就是这一页后面第一行非空文字（PPT 每页的标题在最上面）
            let title = lines[i + 1..].iter().map(|s| s.trim()).find(|s| !s.is_empty() && !s.starts_with('【'));
            marks.push(match title {
                Some(x) => format!("{page}：{}", clip_chars(x, OVERVIEW_MARK_CHARS)),
                None => page.to_string(),
            });
        } else if let Some(name) = t.strip_prefix("## 工作表：") {
            marks.push(format!("工作表：{name}"));
        } else if t.starts_with("# ") || t.starts_with("## ") || t.starts_with("### ") {
            marks.push(clip_chars(t, OVERVIEW_MARK_CHARS));
        }
    }

    let mut out = String::new();
    out.push_str(&format!("【附件概览 · {filename}】\n正文约 {n_lines} 行 / {n_chars} 字，没有整份贴进来。\n"));
    if !marks.is_empty() {
        out.push_str("结构：\n");
        for m in marks.iter().take(OVERVIEW_MAX_MARKS) {
            out.push_str(&format!("  {m}\n"));
        }
    }
    out.push_str("开头：\n");
    // 行号排版与 read_doc 完全一致（右对齐 + 「→」紧贴正文），模型两边不用换算法
    let width = n_lines.to_string().len();
    let mut shown = 0usize;
    for (i, raw) in lines.iter().enumerate() {
        if shown >= OVERVIEW_HEAD_LINES {
            break;
        }
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        shown += 1;
        out.push_str(&format!("{:>width$}→{}\n", i + 1, clip_chars(t, OVERVIEW_HEAD_CHARS), width = width));
    }
    if text.contains("正文过长，已截断") {
        out.push_str("（抽取时按上限截断，后半段没读出来）\n");
    }
    out.push_str(&format!(
        "要看细节用 read_doc：{{\"path\":\"{file}\",\"offset\":1,\"limit\":200}}；行号与上面「开头」的编号一致\n"
    ));
    out
}

/// 可以直接按字符读出来的常见文本/代码/标记格式
fn is_text_like(lower: &str) -> bool {
    const TEXT_EXT: &[&str] = &[
        ".csv", ".tsv", ".txt", ".md", ".markdown", ".log", ".json", ".jsonl", ".ndjson", ".xml", ".html", ".htm",
        ".yml", ".yaml", ".toml", ".ini", ".conf", ".env", ".css", ".scss", ".less", ".js", ".mjs", ".cjs", ".ts",
        ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php",
        ".swift", ".sh", ".bash", ".bat", ".cmd", ".ps1", ".sql", ".srt", ".vtt", ".gitignore", ".editorconfig",
    ];
    TEXT_EXT.iter().any(|e| lower.ends_with(e))
}

/// 提取结果统一封顶：解析出来的正文是要进模型上下文的，
/// 不封顶的话一个长 PDF 就能把整轮对话挤没（插件解析出的正文同样过这里）
pub fn cap_text(text: &str) -> String {
    const MAX_CHARS: usize = 120_000;
    let mut count = 0usize;
    for (i, _) in text.char_indices() {
        count += 1;
        if count > MAX_CHARS {
            return format!("{}\n…（正文过长，已截断到约 {MAX_CHARS} 字）", &text[..i]);
        }
    }
    text.to_string()
}

/// 文本类字节 → 字符串：UTF-8 直通，失败再按中文 Windows 常见的 GBK 兜一层
fn bytes_to_text(bytes: &[u8]) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => {
            let (cow, _, _) = encoding_rs::GBK.decode(bytes);
            if cow.chars().any(|c| c == '\u{fffd}') {
                return Err("文件不是 UTF-8/GBK 文本，无法按文本解析".into());
            }
            Ok(cow.to_string())
        }
    }
}

/// quick-xml 0.42 不反转义：正文里的 `&amp;` 会作为 GeneralRef 事件单独抛出来。
/// 这里必须把它还原成字符，否则 Word/PPT 里的 & < > 引号会静默丢掉（正文缺字）。
fn resolve_general_ref(name: &str) -> String {
    match name {
        "amp" => return "&".into(),
        "lt" => return "<".into(),
        "gt" => return ">".into(),
        "quot" => return "\"".into(),
        "apos" => return "'".into(),
        "nbsp" => return "\u{a0}".into(),
        _ => {}
    }
    let hex = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X"));
    let dec = name.strip_prefix('#').filter(|s| !s.starts_with(['x', 'X']));
    let num = hex
        .and_then(|s| u32::from_str_radix(s, 16).ok())
        .or_else(|| dec.and_then(|s| s.parse::<u32>().ok()));
    match num.and_then(char::from_u32) {
        Some(c) => c.to_string(),
        // 认不出的具名实体（&mdash; 之类）原样留着，别把正文吃掉
        None => format!("&{name};"),
    }
}

/// PowerPoint .pptx → 纯文本：zip 包里每张幻灯片是 ppt/slides/slideN.xml，
/// 文本在 <a:t> 里；按 slide1、slide2… 的数字顺序读，页与页之间空行分隔。
fn pptx_to_text(bytes: &[u8]) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("打开 pptx 失败: {e}"))?;
    // 只收 ppt/slides/slideN.xml：slideMaster / notesSlide / layout 里全是模板占位文字
    // zip 9 的 file_names() 是 ZipResult<Cow<str>>，读不出名字的条目直接跳过
    let mut names: Vec<String> = zip
        .file_names()
        .filter_map(|n| n.ok().map(|s| s.into_owned()))
        .filter(|n| {
            let Some(rest) = n.strip_prefix("ppt/slides/slide") else {
                return false;
            };
            rest.chars().next().is_some_and(|c| c.is_ascii_digit()) && rest.ends_with(".xml")
        })
        .collect();
    if names.is_empty() {
        return Err("pptx 中找不到 ppt/slides/slideN.xml".into());
    }
    // 按文件名里的页码数字排序，避免 slide10 排在 slide2 前面
    names.sort_by_key(|n| {
        n.trim_start_matches("ppt/slides/slide")
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .unwrap_or(0)
    });
    let mut slides: Vec<String> = Vec::new();
    for name in names.iter() {
        let mut xml = String::new();
        zip.by_name(name)
            .map_err(|e| format!("读取 {name} 失败: {e}"))?
            .read_to_string(&mut xml)
            .map_err(|e| format!("读取 {name} 失败: {e}"))?;
        let mut reader = Reader::from_str(&xml);
        reader.config_mut().trim_text(false);
        let mut buf = Vec::new();
        let mut in_text = false;
        // 一个段落里的多个 <a:t> 是排版上被拆开的连续文字，拼成一行；
        // 段落结束（</a:p>）与软换行（<a:br/>）才断行
        let mut para = String::new();
        let mut body = String::new();
        let flush = |para: &mut String, body: &mut String| {
            let t = para.trim();
            if !t.is_empty() {
                body.push_str(t);
                body.push('\n');
            }
            para.clear();
        };
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) => {
                    if e.name().as_ref() == "a:t" {
                        in_text = true;
                    }
                }
                Ok(Event::End(e)) => match e.name().as_ref() {
                    "a:t" => in_text = false,
                    "a:p" | "a:br" => flush(&mut para, &mut body),
                    _ => {}
                },
                Ok(Event::Empty(e)) if e.name().as_ref() == "a:br" => flush(&mut para, &mut body),
                Ok(Event::Text(t)) if in_text => {
                    para.push_str(&t.xml_content(quick_xml::XmlVersion::Implicit1_0));
                }
                Ok(Event::GeneralRef(r)) if in_text => {
                    para.push_str(&resolve_general_ref(&r.into_inner()));
                }
                Ok(Event::Eof) => break,
                Err(e) => return Err(format!("解析 {name} 失败: {e}")),
                _ => {}
            }
            buf.clear();
        }
        flush(&mut para, &mut body);
        slides.push(body.trim().to_string());
    }
    let out = slides
        .iter()
        .enumerate()
        .map(|(i, s)| format!("【第 {} 页】\n{s}", i + 1))
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(out)
}

/// PDF → 正文：lopdf（MIT）自带逐页抽取，限制解压体积防解压炸弹。
/// 说明：CID 编码字体（不少中文排版 PDF）抽出来可能是乱码，那时按引用附上即可，
/// 模型仍能拿绝对路径用 read_file 或外部工具再试。
fn pdf_to_text(bytes: &[u8]) -> Result<String, String> {
    const MAX_PAGES: usize = 200;
    const MAX_DECOMPRESSED: usize = 64 * 1024 * 1024;
    let doc = lopdf::Document::load_mem(bytes).map_err(|e| format!("打开 PDF 失败: {e}"))?;
    if doc.is_encrypted() {
        return Err("PDF 已加密，无法解析正文".into());
    }
    let mut pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    let total = pages.len();
    let truncated = total > MAX_PAGES;
    if truncated {
        pages.truncate(MAX_PAGES);
    }
    let text = doc
        .extract_text_with_limit(&pages, MAX_DECOMPRESSED)
        .map_err(|e| format!("PDF 正文抽取失败: {e}"))?;
    Ok(if truncated {
        format!("{text}\n…（共 {total} 页，只抽取了前 {MAX_PAGES} 页）")
    } else {
        text
    })
}

/// Excel 全部工作表 → Markdown 表格（每表一个 ## 标题）
fn excel_to_markdown(bytes: &[u8]) -> Result<String, String> {
    use calamine::{Data, Reader, Xlsx};
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut wb: Xlsx<_> = Xlsx::new(cursor).map_err(|e| format!("打开 Excel 失败: {e}"))?;
    let names = wb.sheet_names().to_vec();
    if names.is_empty() {
        return Err("Excel 中没有工作表".into());
    }
    let mut out = String::new();
    for name in names {
        let range = match wb.worksheet_range(&name) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if range.is_empty() {
            continue;
        }
        out.push_str(&format!("## 工作表：{name}\n\n"));
        let cell_str = |c: &Data| -> String {
            match c {
                Data::Empty => String::new(),
                Data::String(s) => s.replace('|', "\\|").replace('\n', " "),
                Data::Float(f) => {
                    if f.fract() == 0.0 { format!("{}", *f as i64) } else { format!("{f}") }
                }
                Data::Int(i) => i.to_string(),
                Data::Bool(b) => b.to_string(),
                Data::DateTime(d) => d.to_string(),
                other => other.to_string(),
            }
        };
        let rows: Vec<Vec<String>> = range.rows().map(|r| r.iter().map(cell_str).collect()).collect();
        let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        if cols == 0 {
            continue;
        }
        // 首行作表头，没有则用列号
        let header = &rows[0];
        let head_cells: Vec<String> = (0..cols)
            .map(|i| header.get(i).cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("列{}", i + 1)))
            .collect();
        out.push_str(&format!("| {} |\n", head_cells.join(" | ")));
        out.push_str(&format!("| {} |\n", vec!["---"; cols].join(" | ")));
        for row in rows.iter().skip(1) {
            let cells: Vec<String> = (0..cols).map(|i| row.get(i).cloned().unwrap_or_default()).collect();
            out.push_str(&format!("| {} |\n", cells.join(" | ")));
        }
        out.push('\n');
    }
    if out.trim().is_empty() {
        return Err("Excel 内容为空".into());
    }
    Ok(out)
}

/// Word .docx → 纯文本：.docx 本质是 zip，正文在 word/document.xml，取所有 <w:t> 文本
fn docx_to_text(bytes: &[u8]) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("打开 docx 失败: {e}"))?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|_| "docx 中找不到 word/document.xml".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| format!("读取 document.xml 失败: {e}"))?;

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut out = String::new();
    let mut in_text = false;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            // quick-xml 0.42：str reader 的 QName::as_ref() 返回 &str，直接匹配字符串
            Ok(Event::Start(e)) => {
                if e.name().as_ref() == "w:t" {
                    in_text = true;
                }
            }
            Ok(Event::End(e)) => {
                match e.name().as_ref() {
                    "w:t" => in_text = false,
                    // 段落 / 换行结束 → 换行
                    "w:p" => out.push('\n'),
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                // <w:br/> 软换行、<w:tab/> 制表
                match e.name().as_ref() {
                    "w:br" => out.push('\n'),
                    "w:tab" => out.push('\t'),
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_text => {
                // xml_content 只做 EOL 归一，实体在 GeneralRef 事件里单独还原
                out.push_str(&t.xml_content(quick_xml::XmlVersion::Implicit1_0));
            }
            Ok(Event::GeneralRef(r)) if in_text => {
                out.push_str(&resolve_general_ref(&r.into_inner()));
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("解析 docx 失败: {e}")),
            _ => {}
        }
        buf.clear();
    }
    // 折叠多余空行
    let cleaned: Vec<&str> = out.lines().map(|l| l.trim_end()).collect();
    let mut result = String::new();
    let mut blank = 0;
    for line in cleaned {
        if line.is_empty() {
            blank += 1;
            if blank <= 1 {
                result.push('\n');
            }
        } else {
            blank = 0;
            result.push_str(line);
            result.push('\n');
        }
    }
    let result = result.trim().to_string();
    if result.is_empty() {
        return Err("Word 文档内容为空".into());
    }
    Ok(result)
}

/// 抓取网页并提取正文文字（去掉 script/style/nav 等），返回标题 + 正文
pub async fn fetch_webpage(url: &str) -> Result<(String, String), String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("请输入以 http:// 或 https:// 开头的网址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (compatible; BIT/1.0; +https://github.com/yxpil/bit)")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let html = resp.text().await.map_err(|e| format!("读取网页失败: {e}"))?;
    Ok(html_to_text(&html))
}

/// HTML → (标题, 正文文字)。剔除脚本/样式等噪声标签，压缩空白。
fn html_to_text(html: &str) -> (String, String) {
    use scraper::{Html, Selector};
    let doc = Html::parse_document(html);

    let title = Selector::parse("title")
        .ok()
        .and_then(|sel| doc.select(&sel).next())
        .map(|e| e.text().collect::<String>().trim().to_string())
        .unwrap_or_default();

    // 优先正文容器，退回 body
    let body_sel = ["article", "main", "body"]
        .iter()
        .find_map(|s| Selector::parse(s).ok().filter(|sel| doc.select(sel).next().is_some()))
        .or_else(|| Selector::parse("body").ok());

    let mut text = String::new();
    if let Some(sel) = body_sel {
        if let Some(root) = doc.select(&sel).next() {
            // 收集文本，跳过 script/style/noscript 的内容
            for node in root.text() {
                let t = node.trim();
                if !t.is_empty() {
                    text.push_str(t);
                    text.push('\n');
                }
            }
        }
    }
    // scraper 的 .text() 已不含 script/style（它们的文本节点仍会出现，故这里再做一次朴素过滤）
    let cleaned: Vec<&str> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    let mut body = cleaned.join("\n");
    // 限制长度，避免超大页面撑爆上下文
    const MAX: usize = 20_000;
    if body.chars().count() > MAX {
        body = body.chars().take(MAX).collect::<String>() + "\n…（正文过长已截断）";
    }
    (title, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    /// 测试自己造附件，不依赖仓库里的二进制样例文件
    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// 用 zip 造一个最小 Office Open XML 包（Stored 不依赖压缩特性）
    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        use zip::write::ZipWriter;
        let mut w = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::FileOptions::<()>::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, content) in files {
            w.start_file(name.to_string(), opts).unwrap();
            std::io::Write::write_all(&mut w, content.as_bytes()).unwrap();
        }
        w.finish().map(|z| z.into_inner()).unwrap()
    }

    #[test]
    fn text_like_reads_as_is() {
        let r = extract("notes.txt", &b64("第一行\n第二行".as_bytes())).unwrap();
        assert_eq!(r, "第一行\n第二行");
    }

    #[test]
    fn data_url_prefix_is_stripped() {
        let body = b64("hello".as_bytes());
        let r = extract("a.md", &format!("data:text/markdown;base64,{body}")).unwrap();
        assert_eq!(r, "hello");
    }

    #[test]
    fn non_utf8_text_falls_back_to_gbk() {
        let (gbk, _, _) = encoding_rs::GBK.encode("中文报告");
        // 构造一段非法 UTF-8：GBK 的「中」= 0xD6 0xD0，单独看不是合法 UTF-8
        assert!(std::str::from_utf8(&gbk).is_err());
        let r = extract("报告.txt", &b64(&gbk)).unwrap();
        assert_eq!(r, "中文报告");
    }

    #[test]
    fn binary_text_is_rejected() {
        let r = extract("blob.txt", &b64(&[0xff, 0xfe, 0x00, 0x01, 0x02]));
        assert!(r.is_err(), "应为错误: {r:?}");
    }

    #[test]
    fn unknown_type_lists_supported() {
        let e = extract("movie.mp4", &b64(b"whatever")).unwrap_err();
        assert!(e.starts_with("[unsupported_kind] "), "界面靠这个标记换文案: {e}");
        assert!(e.contains("暂不支持"), "{e}");
        assert!(e.contains(".pptx") && e.contains(".pdf"), "提示里要列出支持的范围: {e}");
    }

    #[test]
    fn long_text_is_capped() {
        let long = "字".repeat(130_000);
        let r = extract("long.txt", &b64(long.as_bytes())).unwrap();
        assert!(r.contains("正文过长，已截断"), "应带截断说明");
        assert!(r.chars().count() < 130_000);
    }

    #[test]
    fn pptx_orders_pages_and_skips_layouts() {
        let slide = |t: &str| format!("<p:sld><p:cSld><p:sp><a:p><a:t>{t}</a:t></a:p></p:sp></p:cSld></p:sld>");
        // 故意乱序写入，并且混进 layout / notesSlide / media
        let bytes = zip_of(&[
            ("ppt/slides/slide10.xml", &slide("第十页")),
            ("ppt/slides/slide2.xml", &slide("第二页&amp;继续")),
            ("ppt/slides/slide1.xml", &slide("第一页")),
            ("ppt/slideLayouts/slideLayout1.xml", &slide("版式占位")),
            ("ppt/notesSlides/notesSlide1.xml", &slide("演讲者备注")),
        ]);
        let text = pptx_to_text(&bytes).unwrap();
        assert!(text.find("【第 1 页】").unwrap() < text.find("【第 2 页】").unwrap());
        assert_eq!(
            text, "【第 1 页】\n第一页\n\n【第 2 页】\n第二页&继续\n\n【第 3 页】\n第十页",
            "顺序、分段与反转义"
        );
        assert!(!text.contains("版式占位"), "不该读版式");
        assert!(!text.contains("演讲者备注"), "不该读备注");
        // 实体在 quick-xml 里是独立事件，漏掉就会吞字：A&amp;B 必须是 A&B
        let refs = zip_of(&[(
            "ppt/slides/slide1.xml",
            &slide("A&amp;B &lt;C&gt; &#65;&#66; &nbsp; &mdash;"),
        )]);
        assert_eq!(
            pptx_to_text(&refs).unwrap(),
            "【第 1 页】\nA&B <C> AB \u{a0} &mdash;",
            "标准实体与字符引用要还原，认不出的原样保留"
        );
    }

    #[test]
    fn pptx_without_slides_errors() {
        let bytes = zip_of(&[("[Content_Types].xml", "<Types/>")]);
        assert!(pptx_to_text(&bytes).unwrap_err().contains("slideN.xml"));
    }

    #[test]
    fn docx_paragraphs_fold_blank_lines() {
        let doc = "<w:document><w:body>\
            <w:p><w:r><w:t>标题</w:t></w:r></w:p>\
            <w:p><w:r><w:t>正文一</w:t><w:tab/><w:t>正文二</w:t><w:br/><w:t>换行后</w:t></w:r></w:p>\
            </w:body></w:document>";
        let text = docx_to_text(&zip_of(&[("word/document.xml", doc)])).unwrap();
        assert_eq!(text, "标题\n正文一\t正文二\n换行后");
        assert!(extract("a.docx", &b64(&zip_of(&[("word/document.xml", doc)])))
            .unwrap()
            .contains("标题"));
    }

    /// 手写一份结构完整（含交叉引用表）的单页 PDF，避免测试依赖外部样例
    fn minimal_pdf(lines: &[&str]) -> Vec<u8> {
        let mut content = String::from("BT /F1 24 Tf 72 700 Td ");
        for line in lines {
            let esc = line.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)");
            content.push_str(&format!("({esc}) Tj 0 -30 Td "));
        }
        content.push_str("ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
             /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
                .to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        ];

        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
        }
        let xref_at = out.len();
        out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
        out.push_str("0000000000 65535 f \n");
        for off in offsets {
            out.push_str(&format!("{off:010} 00000 n \n"));
        }
        out.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
            objects.len() + 1
        ));
        out.into_bytes()
    }

    #[test]
    fn pdf_text_extracted() {
        let pdf = minimal_pdf(&["Hello from BIT", "second line"]);
        let text = pdf_to_text(&pdf).unwrap();
        assert!(text.contains("Hello from BIT"), "{text}");
        assert!(text.contains("second line"), "{text}");
        // 走完整分派链路（含体积闸与封顶）
        assert!(extract("report.pdf", &b64(&pdf)).unwrap().contains("Hello from BIT"));
    }

    #[test]
    fn broken_pdf_errors_not_panics() {
        assert!(extract("broken.pdf", &b64(b"%PDF-1.4 not really a pdf")).is_err());
    }

    #[test]
    fn excel_to_markdown_table() {
        // sharedStrings + sheet1，最小可用工作簿
        let sst = "<sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><si><t>名称</t></si><si><t>金额</t></si><si><t>房租</t></si></sst>";
        let sheet = "<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\
            <sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row>\
            <row r=\"2\"><c r=\"A2\" t=\"s\"><v>2</v></c><c r=\"B2\"><v>1200.5</v></c></row>\
            </sheetData></worksheet>";
        let wb = zip_of(&[
            (
                "_rels/.rels",
                "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>",
            ),
            ("xl/sharedStrings.xml", sst),
            ("xl/worksheets/sheet1.xml", sheet),
            (
                "xl/workbook.xml",
                "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\
                 <sheets><sheet name=\"一月\" sheetId=\"1\" r:id=\"rId1\" xmlns:r=\
                 \"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"/></sheets></workbook>",
            ),
            (
                "xl/_rels/workbook.xml.rels",
                "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
                 <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/\
                 relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>",
            ),
            (
                "[Content_Types].xml",
                "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>",
            ),
        ]);
        let md = excel_to_markdown(&wb).unwrap();
        assert!(md.contains("## 工作表：一月"), "{md}");
        assert!(md.contains("| 名称 | 金额 |"), "{md}");
        assert!(md.contains("| 房租 | 1200.5 |"), "{md}");
    }

    /// 够长（>40 行且 >1500 字）的正文，用来触发摘要
    fn long_body(prefix: &str) -> String {
        let mut s = String::new();
        for i in 0..60 {
            s.push_str(&format!("{prefix} 第 {i} 段：这一段的正文足够长，用来把整份字数抬过摘要门槛，避免走小文件直通分支。\n"));
        }
        s
    }

    #[test]
    fn small_body_is_passed_through() {
        let text = "一\n二\n三";
        assert_eq!(overview("a.txt", text, Some("C:/tmp/a.txt")), text, "三行小抄没必要摘要");
    }

    #[test]
    fn overview_needs_a_local_path() {
        let text = long_body("段落");
        // 没有路径（粘贴件）或路径是网页地址时，正文一旦摘要就再也捞不回来
        assert_eq!(overview("a.txt", &text, None), text);
        assert_eq!(overview("a.txt", &text, Some("")), text);
        assert_eq!(overview("a.txt", &text, Some("https://yxpil.com/post")), text);
        assert_ne!(overview("a.txt", &text, Some("C:/tmp/a.txt")), text);
    }

    #[test]
    fn overview_counts_lines_and_points_to_read_doc() {
        let ov = overview("memo.docx", &long_body("段落"), Some("C:/tmp/memo.docx"));
        assert!(ov.contains("【附件概览 · memo.docx】"), "{ov}");
        assert!(ov.contains("正文约 60 行"), "{ov}");
        assert!(ov.contains("read_doc"), "要告诉模型怎么把细节读回来");
        assert!(ov.contains("C:/tmp/memo.docx"), "{ov}");
        assert!(!ov.contains("第 59 段"), "摘要不该把整份正文带上");
    }

    #[test]
    fn overview_outlines_slides() {
        let mut text = String::new();
        for i in 1..=50 {
            text.push_str(&format!("【第 {i} 页】\n第 {i} 页的标题行\n正文补长一点正文补长一点正文补长一点正文补长一点正文补长一点正文补长一点\n\n"));
        }
        let ov = overview("deck.pptx", &text, Some("C:/tmp/deck.pptx"));
        assert!(ov.contains("结构："), "{ov}");
        assert!(ov.contains("第 1 页：第 1 页的标题行"), "页码后面要跟标题");
        assert!(ov.contains("第 12 页"), "大纲最多列 12 条");
        assert!(!ov.contains("第 13 页："), "{ov}");
    }

    #[test]
    fn overview_lists_csv_columns() {
        let mut text = "名称,金额,备注\n".to_string();
        for i in 0..60 {
            text.push_str(&format!("物品{i},{},说明说明说明说明说明说明\n", i * 7));
        }
        let ov = overview("sales.csv", &text, Some("C:/tmp/sales.csv"));
        assert!(ov.contains("列：名称,金额,备注"), "{ov}");
        assert!(ov.contains("数据 60 行"), "{ov}");
    }

    #[test]
    fn overview_excerpt_keeps_real_line_numbers() {
        let text = "\n第一行内容\n\n第二行内容\n第三行内容\n".repeat(30);
        let ov = overview("a.txt", &text, Some("C:/tmp/a.txt"));
        // 空行占行号，且排版要和 read_doc 一模一样
        assert!(ov.contains("  2→第一行内容"), "摘录编号要和 read_doc 对得上: {ov}");
        assert!(ov.contains("  5→第三行内容"), "{ov}");
    }

    #[test]
    fn clip_chars_cuts_by_char_not_byte() {
        assert_eq!(clip_chars("中文测试", 2), "中文…");
        assert_eq!(clip_chars("中文", 5), "中文");
    }

    /// 「能不能解析」与分派表必须同一出处（右键详情就靠这句回答）
    #[test]
    fn supports_matches_the_dispatch_table() {
        for n in ["a.xlsx", "a.XLS", "a.ods", "a.docx", "a.pptx", "a.pdf", "a.txt", "a.csv", "a.rs", "a.html"] {
            assert!(supports(n), "{n} 应可解析");
        }
        for n in ["a.bin", "a.zip", "a.mp4", "a.doc", "a.ppt", "Makefile", ""] {
            assert!(!supports(n), "{n} 不该宣称可解析");
        }
    }
}
