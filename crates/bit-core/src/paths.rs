// yxpil · BIT core
//! 路径清洗工具：AI/用户给的路径 → 可安全传给系统调用的形式。
//! （自 src-tauri/commands.rs 下沉：send_file / open_path / Tauri 壳与 bit-core 共用）

/// 清理 AI/用户给的路径：去首尾空白、去成对引号、展开 ~。send_file 与 open_path 共用。
pub fn normalize_user_path(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if s.len() >= 2 {
        let bytes = s.as_bytes();
        let first = bytes[0];
        let last = bytes[s.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            s = s[1..s.len() - 1].trim().to_string();
        }
    }
    if let Some(rest) = s.strip_prefix('~') {
        if rest.is_empty() || rest.starts_with('/') {
            if let Some(home) = std::env::var_os("HOME") {
                s = format!("{}{}", home.to_string_lossy(), rest);
            }
        }
    }
    s
}

/// canonicalize 后转成可传给系统调用的展示路径：Windows 的 std::fs::canonicalize 返回
/// `\\?\` verbatim 前缀（且可能混入正斜杠），explorer `/select,` 解析不了会静默退回
/// 打开默认文件夹（文档）——必须剥前缀、统一反斜杠；`\\?\UNC\` 还原为 `\\`。
/// 非 Windows 平台原样返回字符串。
pub fn clean_display_path(p: &std::path::Path) -> String {
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy().replace('/', "\\");
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            s
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        p.to_string_lossy().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_paired_quotes_and_spaces() {
        assert_eq!(normalize_user_path("  \"C:\\a b.txt\"  "), r"C:\a b.txt");
        assert_eq!(normalize_user_path("'D:\\notes'"), r"D:\notes");
    }

    #[test]
    fn expands_home() {
        std::env::set_var("HOME", "/home/tester");
        assert_eq!(normalize_user_path("~/x"), "/home/tester/x");
    }

    #[test]
    fn cleans_windows_verbatim_prefix() {
        assert_eq!(clean_display_path(std::path::Path::new(r"\\?\C:\a\b")), r"C:\a\b");
        assert_eq!(clean_display_path(std::path::Path::new(r"\\?\UNC\srv\share")), r"\\srv\share");
    }
}
