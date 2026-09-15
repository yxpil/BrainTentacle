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

#[cfg(test)]
mod tests {
    use super::decode_console;

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
}
