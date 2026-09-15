// yxpil · BIT
//! 控制台输出解码（console codec）：
//! 中文 Windows 的 cmd / PowerShell 5.x 管道输出默认是 GBK(936)，不是 UTF-8，
//! 直接 from_utf8_lossy 会得到乱码；个别 PowerShell 配置甚至输出 UTF-16LE。
//! 本模块提供统一的 `decode_console`：按字节流推断编码并解码为 UTF-8 字符串，
//! shell 前台/等待/后台日志等所有子进程输出读取路径共用。

/// 控制台输出解码：UTF-8 合法 → 原样（PowerShell 7 / chcp 65001 / git-bash）；
/// 否则 0x00 占比高 → UTF-16LE（个别 PowerShell 重定向配置）；
/// 否则按 GBK(936) 解码（中文 Windows cmd/PowerShell 5.x 管道输出的默认编码）。
/// 不可解码字节统一替换为 U+FFFD，绝不 panic。
pub fn decode_console(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let zeros = bytes.iter().filter(|b| **b == 0).count();
    if bytes.len() >= 2 && zeros * 4 > bytes.len() {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    let (cow, _, _) = ansi_encoding().decode(bytes);
    cow.into_owned()
}

/// 是否为 Windows 批处理脚本（cmd.exe 按 ANSI 代码页解析，编码需要特殊对待）
pub fn is_batch(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

/// 是否为 PowerShell 脚本：PS 5.1 无 BOM 按 ANSI(GBK) 解析、PS 7 无 BOM 按 UTF-8
/// 解析，两者都认 UTF-8 BOM —— BOM 是跨版本唯一可靠选择
pub fn is_powershell(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".ps1") || lower.ends_with(".psm1") || lower.ends_with(".psd1")
}

/// 写盘编码：
/// - .bat/.cmd 在 Windows 上转 GBK —— cmd.exe 按系统 ANSI 代码页（中文 Windows = GBK）
///   逐行解析批处理，UTF-8 中文会乱码甚至改变命令语义。内容含 GBK 无法表示的字符
///   （emoji 等）时回退为 UTF-8 并自动插入 `@chcp 65001 >nul`（无 BOM，防首行 BOM 报错）。
///   非 Windows 上 bat 无执行场景，保持 UTF-8（需要 GBK 时 AI 可显式 encoding="gbk"）。
/// - .ps1/.psm1/.psd1 加 UTF-8 BOM —— PS 5.1（ANSI 回退）与 PS 7 / PS Core（UTF-8 默认）
///   都认 BOM，跨平台且能无损保留全部 Unicode。
/// - 其他扩展名原样 UTF-8。
pub fn encode_script_write(path: &str, content: &str) -> Vec<u8> {
    if is_batch(path) {
        if !cfg!(windows) {
            return content.as_bytes().to_vec();
        }
        let (bytes, _, had_errors) = encoding_rs::GBK.encode(content);
        if !had_errors {
            return bytes.into_owned();
        }
        return prepend_chcp(content).into_bytes();
    }
    if is_powershell(path) {
        // 已有 BOM 字符则去重后统一补一个 BOM
        let body = content.strip_prefix('\u{feff}').unwrap_or(content);
        let mut out = Vec::with_capacity(body.len() + 3);
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        out.extend_from_slice(body.as_bytes());
        return out;
    }
    content.as_bytes().to_vec()
}

/// 在批处理内容里插入 chcp 65001：首行为 @echo off 时插在其后（保持回显抑制），
/// 已含 chcp 65001 的不重复插入
fn prepend_chcp(content: &str) -> String {
    if content.to_lowercase().contains("chcp 65001") {
        return content.to_string();
    }
    let chcp = "@chcp 65001 >nul\r\n";
    match content.find('\n') {
        Some(idx) if content[..idx].trim_end().trim_start_matches('@')
            .trim().eq_ignore_ascii_case("echo off") =>
        {
            // trim_end 去掉首行自带的 \r，避免拼接出 \r\r\n
            format!("{}\r\n{}{}", content[..idx].trim_end(), chcp, &content[idx + 1..])
        }
        _ => format!("{chcp}{content}"),
    }
}

/// 源文件编码检测结果（读时探测、写时保持）
/// Ansi = 系统 ANSI 代码页：中文 Windows 为 GBK(936)，macOS/Linux 为 Windows-1252
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FileEnc {
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Utf8,
    Ansi,
}

impl FileEnc {
    /// AI 显式指定的编码名 → 枚举（大小写/连字符不敏感）；auto 由调用方走探测
    pub fn from_name(name: &str) -> Option<FileEnc> {
        match name.to_lowercase().replace(['-', '_'], "").as_str() {
            "utf8" => Some(FileEnc::Utf8),
            "utf8bom" | "bom" => Some(FileEnc::Utf8Bom),
            "utf16le" | "utf16" => Some(FileEnc::Utf16Le),
            "utf16be" => Some(FileEnc::Utf16Be),
            "ansi" | "gbk" | "cp936" | "936" | "system" => Some(FileEnc::Ansi),
            _ => None,
        }
    }
}

/// 系统 ANSI 编码：兼顾跨平台 —— 中文 Windows = GBK，其他系统 = Windows-1252
fn ansi_encoding() -> &'static encoding_rs::Encoding {
    if cfg!(windows) {
        encoding_rs::GBK
    } else {
        encoding_rs::WINDOWS_1252
    }
}

/// 带文本 BOM 的文件（含 UTF-16）即使含 NUL 字节也是文本，不应按二进制拒绝
pub fn has_text_bom(raw: &[u8]) -> bool {
    raw.starts_with(&[0xEF, 0xBB, 0xBF])
        || raw.starts_with(&[0xFF, 0xFE])
        || raw.starts_with(&[0xFE, 0xFF])
}

/// 探测文件编码：BOM 优先 → 合法 UTF-8 → 0x00 占比启发式 UTF-16LE → GBK 兜底
pub fn detect_file_enc(raw: &[u8]) -> FileEnc {
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return FileEnc::Utf8Bom;
    }
    if raw.starts_with(&[0xFF, 0xFE]) {
        return FileEnc::Utf16Le;
    }
    if raw.starts_with(&[0xFE, 0xFF]) {
        return FileEnc::Utf16Be;
    }
    if std::str::from_utf8(raw).is_ok() {
        return FileEnc::Utf8;
    }
    let zeros = raw.iter().filter(|b| **b == 0).count();
    if raw.len() >= 2 && zeros * 4 > raw.len() {
        return FileEnc::Utf16Le;
    }
    FileEnc::Ansi
}

/// 按指定编码解码文件内容为 UTF-8 字符串（自动剥 BOM；read_file 显式 encoding 参数用）
pub fn decode_with_enc(enc: FileEnc, raw: &[u8]) -> String {
    match enc {
        // 显式 utf-8 读取时也剥 BOM：避免 \u{feff} 污染首行匹配
        FileEnc::Utf8 => {
            let body = raw.strip_prefix(&[0xEF_u8, 0xBB, 0xBF][..]).unwrap_or(raw);
            String::from_utf8_lossy(body).into_owned()
        }
        _ => decode_file_with_enc_raw(enc, raw),
    }
}

fn decode_file_with_enc_raw(enc: FileEnc, raw: &[u8]) -> String {
    match enc {
        FileEnc::Utf8Bom => String::from_utf8_lossy(&raw[3..]).into_owned(),
        FileEnc::Utf16Le => {
            let start = if raw.starts_with(&[0xFF, 0xFE]) { 2 } else { 0 };
            String::from_utf16_lossy(
                &raw[start..]
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>(),
            )
        }
        FileEnc::Utf16Be => {
            let start = if raw.starts_with(&[0xFE, 0xFF]) { 2 } else { 0 };
            String::from_utf16_lossy(
                &raw[start..]
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>(),
            )
        }
        FileEnc::Utf8 => String::from_utf8_lossy(raw).into_owned(),
        FileEnc::Ansi => {
            let (cow, _, _) = ansi_encoding().decode(raw);
            cow.into_owned()
        }
    }
}

/// 按探测到的编码解码文件内容为 UTF-8 字符串（自动剥 BOM）
pub fn decode_file(raw: &[u8]) -> String {
    decode_file_with_enc_raw(detect_file_enc(raw), raw)
}

/// 按编码把内容编码为字节（写回保持源编码用）
pub fn encode_file(enc: FileEnc, content: &str) -> Vec<u8> {
    match enc {
        FileEnc::Utf8Bom => {
            let mut out = Vec::with_capacity(content.len() + 3);
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(content.as_bytes());
            out
        }
        FileEnc::Utf16Le => content.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        FileEnc::Utf16Be => content.encode_utf16().flat_map(u16::to_be_bytes).collect(),
        FileEnc::Utf8 => content.as_bytes().to_vec(),
        FileEnc::Ansi => {
            let (bytes, _, had_errors) = ansi_encoding().encode(content);
            if had_errors {
                // 内容含该编码无法表示的字符：宁可在编码上升级为 UTF-8，
                // 也不能让 NCR 实体（&#xxxxx;）污染文件内容
                content.as_bytes().to_vec()
            } else {
                bytes.into_owned()
            }
        }
    }
}

/// 写盘统一入口：脚本扩展名维持专用规则（bat/cmd → GBK、ps1 族 → UTF-8 BOM）；
/// 其他文件提供源字节时保持源编码（编辑已有文件不改编码），否则 UTF-8
pub fn encode_for_write(path: &str, content: &str, source: Option<&[u8]>) -> Vec<u8> {
    if is_batch(path) || is_powershell(path) {
        return encode_script_write(path, content);
    }
    match source {
        Some(raw) => encode_file(detect_file_enc(raw), content),
        None => content.as_bytes().to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ansi_encoding, decode_console, decode_file, detect_file_enc, encode_file,
        encode_for_write, encode_script_write, has_text_bom, prepend_chcp, FileEnc,
    };

    #[test]
    fn utf8_passthrough() {
        // 合法 UTF-8（含中文）原样返回，不绕道 GBK
        assert_eq!(decode_console("中文 hello".as_bytes()), "中文 hello");
        assert_eq!(decode_console(b"plain ascii\n"), "plain ascii\n");
    }

    #[test]
    #[cfg(windows)]
    fn gbk_fallback() {
        // 中文 Windows cmd 输出的 GBK 编码（"中文" = CA D6 CE C4）
        let gbk = encoding_rs::GBK.encode("中文输出").0.into_owned();
        assert_eq!(decode_console(&gbk), "中文输出");
        // UTF-8 与 GBK 混合的非法序列也按 GBK 解出可读文本
        let mut mixed = b"error: ".to_vec();
        mixed.extend_from_slice(&encoding_rs::GBK.encode("操作成功").0.into_owned());
        assert_eq!(decode_console(&mixed), "error: 操作成功");
    }

    #[test]
    #[cfg(not(windows))]
    fn ansi_fallback_non_windows() {
        // 非 Windows：系统 ANSI = Windows-1252，é = 0xE9 单独出现是非法 UTF-8
        assert_eq!(decode_console(b"caf\xe9!"), "café!");
    }

    #[test]
    fn utf16le_heuristic() {
        // UTF-16LE 编码的 "ok" = 6F 00 6B 00：0x00 占比高触发启发式
        let utf16 = "中文ok\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<u8>>();
        assert_eq!(decode_console(&utf16), "中文ok\n");
    }

    #[test]
    fn garbage_never_panics() {
        let _ = decode_console(&[0xFF, 0xFE, 0x81, 0x7F, 0x00, 0xC3, 0x28]);
        assert_eq!(decode_console(b""), "");
    }

    #[test]
    #[cfg(windows)]
    fn bat_write_gbk_read_roundtrip() {
        let content = "@echo off\r\necho 你好世界\r\n";
        let bytes = encode_script_write("test.bat", content);
        assert!(bytes.starts_with(b"@echo off")); // 无 BOM、无需插入 chcp
        assert_ne!(bytes, content.as_bytes()); // 确实转成了 GBK
        assert_eq!(decode_file(&bytes), content);
        // 非 bat/cmd 文件原样 UTF-8
        assert_eq!(encode_script_write("test.txt", content), content.as_bytes());
    }

    #[test]
    #[cfg(not(windows))]
    fn bat_stays_utf8_on_non_windows() {
        let content = "@echo off\r\necho hi\r\n";
        assert_eq!(encode_script_write("test.bat", content), content.as_bytes());
    }

    #[test]
    #[cfg(windows)]
    fn bat_unrepresentable_falls_back_to_chcp_utf8() {
        let content = "@echo off\r\necho 🙂done\r\n";
        let bytes = encode_script_write("run.cmd", content);
        let text = String::from_utf8(bytes).unwrap();
        // chcp 插在 @echo off 之后，emoji 保留（UTF-8 代码页解析）
        assert!(text.starts_with("@echo off\r\n@chcp 65001 >nul\r\n"));
        assert!(text.contains("🙂"));
    }

    #[test]
    fn ps1_write_utf8_bom_roundtrip() {
        let content = "Write-Host \"你好 🎉\"\r\n";
        let bytes = encode_script_write("run.ps1", content);
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF])); // UTF-8 BOM
        // BOM 后是原样 UTF-8，Unicode 无损（不转 GBK，emoji 保留）
        assert_eq!(&bytes[3..], content.as_bytes());
        // 已含 BOM 字符的内容不重复加
        let bommed = format!("\u{feff}{content}");
        assert_eq!(encode_script_write("run.ps1", &bommed), bytes);
        // 读回剥 BOM，内容一致
        assert_eq!(decode_file(&bytes), content);
        // .psm1 / .psd1 同样处理
        assert!(encode_script_write("m.psm1", "x").starts_with(&[0xEF, 0xBB, 0xBF]));
        assert!(encode_script_write("d.psd1", "x").starts_with(&[0xEF, 0xBB, 0xBF]));
        // 非 PowerShell 文件不加 BOM
        assert_eq!(encode_script_write("x.txt", content), content.as_bytes());
    }

    #[test]
    fn prepend_chcp_no_duplicate() {
        let c = "@echo off\r\nchcp 65001 >nul\r\necho hi\r\n";
        assert_eq!(prepend_chcp(c), c);
        // 无 @echo off 首行：chcp 前置
        assert!(prepend_chcp("echo hi").starts_with("@chcp 65001 >nul\r\n"));
    }

    #[test]
    fn detect_and_roundtrip_file_encodings() {
        // BOM 识别
        assert_eq!(detect_file_enc(&[0xEF, 0xBB, 0xBF]), FileEnc::Utf8Bom);
        assert_eq!(detect_file_enc(&[0xFF, 0xFE, 0x41, 0x00]), FileEnc::Utf16Le);
        assert_eq!(detect_file_enc(&[0xFE, 0xFF, 0x00, 0x41]), FileEnc::Utf16Be);
        // 合法 UTF-8 / 系统 ANSI / 无 BOM UTF-16 启发式
        assert_eq!(detect_file_enc("中文".as_bytes()), FileEnc::Utf8);
        // 系统 ANSI：Windows=GBK 用中文验证，其他平台=1252 用重音字母验证
        let (ansi_text, ansi_raw) = if cfg!(windows) {
            ("中文内容".to_string(), ansi_encoding().encode("中文内容").0.into_owned())
        } else {
            ("café naïve".to_string(), ansi_encoding().encode("café naïve").0.into_owned())
        };
        assert_eq!(detect_file_enc(&ansi_raw), FileEnc::Ansi);
        // 无 BOM UTF-16LE 启发式：0x00 占比 > 25% 且不是合法 UTF-8
        // （纯 ASCII 的 UTF-16LE 字节含 NUL 但合法 UTF-8，会被 UTF-8 检查截住，属可接受退化）
        let u16le = "okok中文".encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>();
        assert_eq!(detect_file_enc(&u16le), FileEnc::Utf16Le);
        // 解码/回编往返一致
        assert_eq!(encode_file(FileEnc::Ansi, &decode_file(&ansi_raw)), ansi_raw);
        assert_eq!(decode_file(&ansi_raw), ansi_text);
        assert_eq!(encode_file(FileEnc::Utf16Le, &decode_file(&u16le)), u16le);
        let bom_utf8: Vec<u8> = [[0xEF, 0xBB, 0xBF].as_slice(), "中文".as_bytes()].concat();
        assert_eq!(encode_file(FileEnc::Utf8Bom, &decode_file(&bom_utf8)), bom_utf8);
        // UTF-16LE 带 BOM 的文件也是文本（不被二进制守卫拒绝）
        let u16le_bom: Vec<u8> = [[0xFF, 0xFE].as_slice(), u16le.as_slice()].concat();
        assert!(has_text_bom(&u16le_bom));
        assert!(!has_text_bom(&u16le));
        assert_eq!(decode_file(&u16le_bom), "okok中文");
        // 显式指定编码读取（from_name 大小写/连字符不敏感）
        assert_eq!(FileEnc::from_name("GBK"), Some(FileEnc::Ansi));
        assert_eq!(FileEnc::from_name("utf-8-bom"), Some(FileEnc::Utf8Bom));
        assert_eq!(FileEnc::from_name("UTF16-LE"), Some(FileEnc::Utf16Le));
        assert_eq!(FileEnc::from_name("nonsense"), None);
    }

    #[test]
    fn write_preserves_source_encoding() {
        let ansi_src = ansi_encoding()
            .encode(if cfg!(windows) { "旧内容中文" } else { "old caf\u{e9}" })
            .0
            .into_owned();
        // 覆盖已有 ANSI 文件 → 保持系统 ANSI
        let new_text = if cfg!(windows) { "新内容中文" } else { "new caf\u{e9}" };
        let out = encode_for_write("note.txt", new_text, Some(&ansi_src));
        assert_eq!(out, ansi_encoding().encode(new_text).0.into_owned());
        // 新文件（无源字节）→ UTF-8
        assert_eq!(encode_for_write("note.txt", "新", None), "新".as_bytes());
        // 新内容含 ANSI 外字符 → 升级 UTF-8，不出 NCR 实体
        let out2 = encode_for_write("note.txt", "emoji🙂", Some(&ansi_src));
        assert_eq!(out2, "emoji🙂".as_bytes());
        // 脚本扩展名规则优先于源编码保持
        assert!(encode_for_write("run.ps1", "x", Some(&ansi_src)).starts_with(&[0xEF, 0xBB, 0xBF]));
    }

    #[test]
    #[cfg(windows)]
    fn bat_gbk_explicit_on_windows() {
        // 显式 encoding="gbk" 与 bat 专用规则结果一致
        let content = "@echo off\r\necho 中文\r\n";
        let via_rule = encode_script_write("a.bat", content);
        let via_param = encode_file(FileEnc::Ansi, content);
        assert_eq!(via_rule, via_param);
    }
}
