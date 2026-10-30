// yxpil · BIT core
//! 终端命令状态检测：原 `bit` 安装功能已整体移除（CLI 独立为 npm 包发布），
//! 这里只探测 npm 全局包 BrainTentacle_cli 是否已安装，供设置页自动展示状态。

use std::process::Command;

/// 独立 CLI 的 npm 包名（大小写不敏感匹配，npm 侧实际注册名以 lowercase 为准）
pub const CLI_PKG: &str = "BrainTentacle_cli";

/// npm 侧实际注册名：npm 禁止新包名含大写，安装/卸载一律用 lowercase
const CLI_PKG_NPM: &str = "braintentacle_cli";

/// 安装独立 CLI：`npm install -g braintentacle_cli`（耗时操作，调用方放阻塞线程池）
pub fn install_cli_impl() -> Result<serde_json::Value, String> {
    run_npm(&["install", "-g", CLI_PKG_NPM, "--loglevel=error"])
}

/// 卸载独立 CLI：`npm uninstall -g braintentacle_cli`
pub fn uninstall_cli_impl() -> Result<serde_json::Value, String> {
    run_npm(&["uninstall", "-g", CLI_PKG_NPM, "--loglevel=error"])
}

/// 执行 npm 子命令：找不到 npm 报 npm_not_found（前端转成安装 Node 提示）；
/// 非零退出把 stderr 原样带回界面展示（EACCES/404 等真实原因）
fn run_npm(args: &[&str]) -> Result<serde_json::Value, String> {
    let npm = crate::runtime::which("npm").ok_or_else(|| "npm_not_found".to_string())?;
    let lower = npm.to_ascii_lowercase();
    let mut c = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut c = Command::new("cmd");
        c.args(["/c", &npm]);
        c
    } else {
        Command::new(&npm)
    };
    c.args(args);
    crate::registry::no_window(&mut c);
    let out = c.output().map_err(|e| format!("npm_exec_failed: {e}"))?;
    if out.status.success() {
        return Ok(serde_json::json!({ "ok": true }));
    }
    let mut text = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if text.is_empty() {
        text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    Err(if text.is_empty() {
        format!("npm {} failed", args[0])
    } else {
        text
    })
}

/// 检测 npm 全局包 BrainTentacle_cli：`npm ls -g <pkg> --json` 解析版本；
/// 找不到 npm（GUI 进程 PATH 过干净）或 ls 失败时回退扫常见全局 node_modules 目录。
/// 返回 { installed, version, npm } —— version 未安装时为 null。
pub fn detect_cli_impl() -> Result<serde_json::Value, String> {
    let npm = crate::runtime::which("npm");
    let mut version = None;
    if let Some(npm) = &npm {
        if let Some(stdout) = npm_ls(npm) {
            version = version_from_ls(&stdout);
        }
    }
    if version.is_none() {
        version = dir_scan();
    }
    Ok(serde_json::json!({
        "installed": version.is_some(),
        "version": version,
        "npm": npm.is_some(),
    }))
}

/// 跑一次 npm ls -g --json（Windows 的 npm 是 .cmd，必须经 cmd /c 启动）
fn npm_ls(npm: &str) -> Option<String> {
    let lower = npm.to_ascii_lowercase();
    let mut c = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut c = Command::new("cmd");
        c.args(["/c", npm]);
        c
    } else {
        Command::new(npm)
    };
    c.args(["ls", "-g", CLI_PKG, "--depth=0", "--json"]);
    crate::registry::no_window(&mut c);
    let out = c.output().ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() { None } else { Some(stdout.into_owned()) }
}

/// 从 `npm ls --json` 输出里取包版本（包名大小写不敏感；包不存在时无 dependencies 键）
fn version_from_ls(stdout: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(stdout).ok()?;
    for (name, info) in v.get("dependencies")?.as_object()? {
        if name.eq_ignore_ascii_case(CLI_PKG) {
            return Some(
                info.get("version").and_then(|x| x.as_str()).unwrap_or("unknown").to_string(),
            );
        }
    }
    None
}

/// npm 缺席时的兜底：扫常见全局 node_modules 目录下的包 package.json
fn dir_scan() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let mut roots: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from("/usr/local/lib/node_modules"),
        std::path::PathBuf::from("/opt/homebrew/lib/node_modules"),
        std::path::PathBuf::from("/usr/lib/node_modules"),
        std::path::PathBuf::from(&home).join(".npm-global/lib/node_modules"),
        std::path::PathBuf::from(&home).join(".local/lib/node_modules"),
    ];
    #[cfg(target_os = "windows")]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(std::path::PathBuf::from(appdata).join("npm/node_modules"));
    }
    for root in roots {
        let entries = match std::fs::read_dir(&root) {
            Ok(e) => e,
            Err(_) => continue, // 单个目录不存在/不可读继续扫下一个
        };
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().eq_ignore_ascii_case(CLI_PKG) {
                continue;
            }
            let pkg = entry.path().join("package.json");
            let Ok(raw) = std::fs::read_to_string(&pkg) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
            return Some(v.get("version").and_then(|x| x.as_str()).unwrap_or("unknown").to_string());
        }
    }
    None
}
