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
    let (cow, _, _) = encoding_rs::GBK.decode(bytes);
    cow.into_owned()
}

/// 是否为 Windows 批处理脚本（cmd.exe 按 ANSI 代码页解析，编码需要特殊对待）
pub fn is_batch(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

/// 写盘编码：.bat/.cmd 转为 GBK —— cmd.exe 按系统 ANSI 代码页（中文 Windows = GBK）
/// 逐行解析批处理文件，UTF-8 中文会乱码甚至改变命令语义。
/// 内容含 GBK 无法表示的字符（emoji 等）时回退为 UTF-8 并自动插入
/// `@chcp 65001 >nul`（无 BOM，防首行 BOM 报错），让 cmd 切到 UTF-8 代码页解析。
/// 其他扩展名一律原样 UTF-8。
pub fn encode_script_write(path: &str, content: &str) -> Vec<u8> {
    if !is_batch(path) {
        return content.as_bytes().to_vec();
    }
    let (bytes, _, had_errors) = encoding_rs::GBK.encode(content);
    if !had_errors {
        return bytes.into_owned();
    }
    prepend_chcp(content).into_bytes()
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

/// 读盘解码：.bat/.cmd 用 decode_console（UTF-8 直通 / GBK 兜底），
/// 保证 write 写成 GBK 的批处理再次被 read_file / edit 读回时不乱码；
/// 其他文件保持 UTF-8 lossy 行为不变。
pub fn decode_script_read(path: &str, raw: &[u8]) -> String {
    if is_batch(path) {
        decode_console(raw)
    } else {
        String::from_utf8_lossy(raw).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_console, decode_script_read, encode_script_write, prepend_chcp};

    #[test]
    fn utf8_passthrough() {
        // 合法 UTF-8（含中文）原样返回，不绕道 GBK
        assert_eq!(decode_console("中文 hello".as_bytes()), "中文 hello");
        assert_eq!(decode_console(b"plain ascii\n"), "plain ascii\n");
    }

    #[test]
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
    fn bat_write_gbk_read_roundtrip() {
        let content = "@echo off\r\necho 你好世界\r\n";
        let bytes = encode_script_write("test.bat", content);
        assert!(bytes.starts_with(b"@echo off")); // 无 BOM、无需插入 chcp
        assert_ne!(bytes, content.as_bytes()); // 确实转成了 GBK
        assert_eq!(decode_script_read("test.bat", &bytes), content);
        assert_ne!(decode_script_read("test.txt", &bytes), content); // 对照：非 bat 路径不解 GBK
        // 非 bat/cmd 文件原样 UTF-8
        assert_eq!(encode_script_write("test.txt", content), content.as_bytes());
    }

    #[test]
    fn bat_unrepresentable_falls_back_to_chcp_utf8() {
        let content = "@echo off\r\necho 🙂done\r\n";
        let bytes = encode_script_write("run.cmd", content);
        let text = String::from_utf8(bytes).unwrap();
        // chcp 插在 @echo off 之后，emoji 保留（UTF-8 代码页解析）
        assert!(text.starts_with("@echo off\r\n@chcp 65001 >nul\r\n"));
        assert!(text.contains("🙂"));
    }

    #[test]
    fn prepend_chcp_no_duplicate() {
        let c = "@echo off\r\nchcp 65001 >nul\r\necho hi\r\n";
        assert_eq!(prepend_chcp(c), c);
        // 无 @echo off 首行：chcp 前置
        assert!(prepend_chcp("echo hi").starts_with("@chcp 65001 >nul\r\n"));
    }
}
