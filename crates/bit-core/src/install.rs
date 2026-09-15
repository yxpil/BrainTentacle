// yxpil · BIT core
//! `bit` 命令安装：把当前可执行文件以链接/启动器形式放进终端 PATH。
//! 桌面端设置页与 TUI `/install-cli` 共用。

use crate::state::Ctx;
use std::sync::Arc;

/// 安装 `bit` 命令到终端 PATH：macOS/Linux 优先 /usr/local/bin 符号链接（无权限回退 ~/.local/bin），
/// Windows 写 bit.cmd 到用户 PATH 自带的 %LOCALAPPDATA%\Microsoft\WindowsApps（start /wait 等待 GUI 进程）。
/// BIT_CLI_DIR 环境变量可覆盖安装目录（E2E 测试用）。
pub fn install_cli_impl(ctx: &Arc<Ctx>) -> Result<serde_json::Value, String> {
    // AppImage：current_exe() 指向 /tmp/.mount_xxx 临时挂载点（退出即失效），
    // 链接必须指向 $APPIMAGE（AppImage 运行时注入的 .AppImage 本体，参数会透传给内部二进制）
    let exe = std::env::var_os("APPIMAGE")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| std::env::current_exe().ok())
        .ok_or("无法定位可执行文件")?;
    let record_audit = |path: &str, hint: &str| {
        crate::audit::record(
            ctx,
            "local-user",
            "cli.install",
            path,
            serde_json::json!({ "hint": hint }),
            true,
        );
    };

    // 测试覆盖目录：直接在其中创建链接/启动器
    if let Ok(dir) = std::env::var("BIT_CLI_DIR") {
        if !dir.trim().is_empty() {
            let dir = std::path::PathBuf::from(dir.trim());
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
            let r = install_cli_into(&dir, &exe)?;
            record_audit(r["path"].as_str().unwrap_or_default(), r["hint"].as_str().unwrap_or_default());
            return Ok(r);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let dir = std::path::PathBuf::from(local).join("Microsoft").join("WindowsApps");
            let r = install_cli_into(&dir, &exe)?;
            record_audit(r["path"].as_str().unwrap_or_default(), r["hint"].as_str().unwrap_or_default());
            return Ok(r);
        }
        return Err("无法定位 %LOCALAPPDATA%".into());
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 优先系统级 /usr/local/bin（已在 PATH）；权限不足回退用户级 ~/.local/bin
        let system = std::path::PathBuf::from("/usr/local/bin");
        if let Ok(r) = install_cli_into(&system, &exe) {
            record_audit(r["path"].as_str().unwrap_or_default(), "");
            return Ok(r);
        }
        let home = std::env::var_os("HOME").ok_or("无法确定用户主目录")?;
        let user = std::path::PathBuf::from(home).join(".local").join("bin");
        let r = install_cli_into(&user, &exe)?;
        let hint = r["hint"].as_str().unwrap_or_default().to_string();
        record_audit(r["path"].as_str().unwrap_or_default(), &hint);
        Ok(r)
    }
}

/// 把可执行文件（符号链接 / Windows 启动脚本）放进指定目录，目录不存在则创建
fn install_cli_into(dir: &std::path::Path, exe: &std::path::Path) -> Result<serde_json::Value, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录 {} 失败: {e}", dir.display()))?;

    #[cfg(target_os = "windows")]
    {
        let launcher = dir.join("bit.cmd");
        let script = format!("@echo off\r\nstart \"\" /b /wait \"{}\" tui %*\r\n", exe.display());
        std::fs::write(&launcher, script).map_err(|e| format!("写入启动器失败: {e}"))?;
        Ok(serde_json::json!({ "path": launcher.display().to_string(), "hint": "重新打开终端后生效，运行 bit tui 进入终端模式" }))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let link = dir.join("bit");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(exe, &link).map_err(|e| format!("创建符号链接失败: {e}"))?;
        let hint = if dir.starts_with("/usr") {
            String::new()
        } else {
            format!("请确保 {} 在 PATH 中（写入 shell 配置后重开终端）", dir.display())
        };
        Ok(serde_json::json!({ "path": link.display().to_string(), "hint": hint }))
    }
}
