// yxpil · BIT core
//! 终端命令状态检测：原 `bit` 安装功能已整体移除（CLI 独立为 npm 包发布），
//! 这里探测 npm 全局包 BrainTentacle_cli 是否已安装、以及安装出的可执行文件能否真的运行。
//! 只查包存在是不够的：postinstall 被跳过或中断时，npm 仍会留下一个报错的占位 exe。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 独立 CLI 的 npm 包名（大小写不敏感匹配，npm 侧实际注册名以 lowercase 为准）
pub const CLI_PKG: &str = "BrainTentacle_cli";

/// npm 侧实际注册名：npm 禁止新包名含大写，安装/卸载一律用 lowercase
const CLI_PKG_NPM: &str = "braintentacle_cli";

/// 安装后真正的入口命令（npm bin 同时注册 bt / braintentacle）
const CLI_CMD: &str = "bt";

/// 安装独立 CLI：`npm install -g braintentacle_cli`（耗时操作，调用方放阻塞线程池）。
/// 已装同版本时 npm 会跳过 install 脚本，所以装完仍不可用就再 rebuild 一次补跑 postinstall。
pub fn install_cli_impl() -> Result<serde_json::Value, String> {
    let install = run_npm(&[
        "install",
        "-g",
        CLI_PKG_NPM,
        "--ignore-scripts=false",
        "--loglevel=error",
    ]);
    if let Some(dir) = pkg_dir() {
        if cli_working(&dir) {
            return Ok(serde_json::json!({ "ok": true, "working": true }));
        }
    }
    let rebuild = run_npm(&[
        "rebuild",
        "-g",
        CLI_PKG_NPM,
        "--ignore-scripts=false",
        "--loglevel=error",
    ]);
    let working = pkg_dir().map(|d| cli_working(&d)).unwrap_or(false);
    if working {
        return Ok(serde_json::json!({ "ok": true, "working": true }));
    }
    // 两次都失败：优先回传 install 的真实报错，其次 rebuild，最后给一句兜底
    Err(install
        .err()
        .or(rebuild.err())
        .unwrap_or_else(|| format!("npm 安装完成但 {CLI_CMD} 仍不可用，请重试或在终端运行 npm rebuild -g {CLI_PKG_NPM}")))
}

/// 卸载独立 CLI：`npm uninstall -g braintentacle_cli`
pub fn uninstall_cli_impl() -> Result<serde_json::Value, String> {
    run_npm(&["uninstall", "-g", CLI_PKG_NPM, "--loglevel=error"])
}

/// 执行 npm 子命令：找不到 npm 报 npm_not_found（前端转成安装 Node 提示）；
/// 非零退出把 stderr 原样带回界面展示（EACCES/404 等真实原因）
fn run_npm(args: &[&str]) -> Result<serde_json::Value, String> {
    let npm = crate::runtime::which("npm").ok_or_else(|| "npm_not_found".to_string())?;
    let out = npm_command(&npm)
        .args(args)
        .output()
        .map_err(|e| format!("npm_exec_failed: {e}"))?;
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

/// npm 可执行文件包装：Windows 的 npm 是 .cmd，必须经 cmd /c 启动。
/// 注意 `where npm` 首行常是无扩展名的 shell 脚本，直接 spawn 会报 os error 193，
/// 所以无扩展名时优先改用同目录 npm.cmd。
fn npm_command(npm: &str) -> Command {
    let lower = npm.to_ascii_lowercase();
    let is_batch = lower.ends_with(".cmd") || lower.ends_with(".bat");
    let is_exe = lower.ends_with(".exe");
    let mut c = if is_batch {
        let mut c = Command::new("cmd");
        c.args(["/c", npm]);
        c
    } else if cfg!(windows) && !is_exe {
        let cmd = Path::new(npm).with_extension("cmd");
        let target = if cmd.is_file() {
            cmd.to_string_lossy().into_owned()
        } else {
            npm.to_string()
        };
        let mut c = Command::new("cmd");
        c.args(["/c", &target]);
        c
    } else {
        Command::new(npm)
    };
    crate::registry::no_window(&mut c);
    c
}

/// 检测 CLI：包版本从 package.json 读取，`working` 额外验证可执行文件能跑起来。
/// 返回 { installed, working, version, npm, command } —— installed 只代表包在磁盘上。
pub fn detect_cli_impl() -> Result<serde_json::Value, String> {
    let npm = crate::runtime::which("npm");
    let dir = pkg_dir();
    let version = dir.as_deref().and_then(pkg_version);
    let working = dir.as_deref().map(cli_working).unwrap_or(false);
    Ok(serde_json::json!({
        "installed": version.is_some(),
        "working": working,
        "version": version,
        "npm": npm.is_some(),
        "command": CLI_CMD,
    }))
}

/// 全局包目录：优先问 npm（`npm root -g`，GUI 的 PATH 经常缺全局 bin，但 npm 能找到），
/// 问不到再扫常见路径。只认带 package.json 的目录。
fn pkg_dir() -> Option<PathBuf> {
    if let Some(npm) = crate::runtime::which("npm") {
        if let Ok(out) = npm_command(&npm).args(["root", "-g"]).output() {
            if out.status.success() {
                let root = String::from_utf8_lossy(&out.stdout);
                if let Some(line) = root.lines().next() {
                    let dir = PathBuf::from(line.trim()).join(CLI_PKG_NPM);
                    if dir.join("package.json").is_file() {
                        return Some(dir);
                    }
                }
            }
        }
    }
    dir_scan()
}

/// npm 缺席时的兜底：扫常见全局 node_modules 目录下带 package.json 的包目录
fn dir_scan() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut roots: Vec<PathBuf> = vec![
        PathBuf::from("/usr/local/lib/node_modules"),
        PathBuf::from("/opt/homebrew/lib/node_modules"),
        PathBuf::from("/usr/lib/node_modules"),
        PathBuf::from(&home).join(".npm-global/lib/node_modules"),
        PathBuf::from(&home).join(".local/lib/node_modules"),
    ];
    #[cfg(target_os = "windows")]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("npm/node_modules"));
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
            let dir = entry.path();
            if dir.join("package.json").is_file() {
                return Some(dir);
            }
        }
    }
    None
}

/// 读包版本；package.json 缺失或损坏视为未安装
fn pkg_version(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(v.get("version").and_then(|x| x.as_str()).unwrap_or("unknown").to_string())
}

/// 真正的可用性判定：按 package.json 的 bin 找到可执行文件并跑一次 --version。
/// postinstall 没跑时 npm 留下的是 233 字节占位 exe，退出码非 0。
fn cli_working(dir: &Path) -> bool {
    let Some(bin) = cli_bin(dir) else { return false };
    if !bin.is_file() {
        return false;
    }
    let mut c = Command::new(&bin);
    c.arg("--version");
    crate::registry::no_window(&mut c);
    match c.output() {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// 从 package.json 的 bin 字段解析可执行文件路径（npm 允许对象或字符串两种写法）
fn cli_bin(dir: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let rel = bin_entry(&raw)?;
    Some(dir.join(rel))
}

fn bin_entry(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    match v.get("bin")? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(m) => m.values().next()?.as_str().map(str::to_string),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_entry_reads_object_value() {
        let raw = r#"{"bin":{"braintentacle":"./bin/braintentacle.exe","bt":"./bin/braintentacle.exe"}}"#;
        assert_eq!(bin_entry(raw).as_deref(), Some("./bin/braintentacle.exe"));
    }

    #[test]
    fn bin_entry_reads_string() {
        let raw = r#"{"bin":"./cli.js"}"#;
        assert_eq!(bin_entry(raw).as_deref(), Some("./cli.js"));
    }

    #[test]
    fn bin_entry_missing_is_none() {
        assert_eq!(bin_entry(r#"{"version":"1.0.0"}"#), None);
    }
}
