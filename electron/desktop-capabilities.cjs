// yxpil · 桌面能力探测（从 main.cjs 抽出）
//! 截图后端与「粘回原应用」工具的可用性只取决于平台 + 环境 + PATH 里有什么，
//! 但真实交互（框选、抢焦点粘贴）在任何 CI 里都跑不了。把决策部分抽成纯函数、
//! 把 execFileSync/which 做成可注入依赖，选择矩阵就能在 macOS/Linux/Windows
//! 任一 runner 上单测（e2e/capabilities-test.cjs），不必真起桌面。
const cp = require('child_process');

// 依赖注入用的默认实现：查 PATH 里有没有某个可执行文件
function realHasCmd(name) {
  try {
    cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const isWayland = (platform, env) =>
  platform === 'linux' &&
  (!!env.WAYLAND_DISPLAY || String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland');

// Linux 各桌面套件的优先级：先协议匹配（Wayland 下 X11 工具基本截不到），
// 再按「桌面自带 → 通用」排。顺序即产品行为，改动要有单测兜着。
const LINUX_X11_ORDER = ['gnome-screenshot', 'spectacle', 'flameshot', 'scrot', 'import'];
const LINUX_WAYLAND_ORDER = [['grim+slurp', ['grim', 'slurp']], ['spectacle', ['spectacle']]];

// 纯决策：返回后端 id（''=本机没有可用后端）
function pickScreenshotBackend({ platform, env, hasCmd }) {
  if (platform === 'darwin') return 'screencapture';
  if (platform === 'win32') return 'ms-screenclip';
  if (platform !== 'linux') return '';
  if (isWayland(platform, env)) {
    for (const [id, need] of LINUX_WAYLAND_ORDER) {
      if (need.every(hasCmd)) return id;
    }
    return '';
  }
  for (const bin of LINUX_X11_ORDER) {
    if (hasCmd(bin)) return bin === 'import' ? 'imagemagick' : bin;
  }
  return '';
}

// 缺工具时的可执行指引（Linux 各桌面套件名不同，笼统提示等于没提示）
function shotMissingHint({ platform, env }) {
  if (platform === 'linux') {
    return isWayland(platform, env)
      ? '缺少 Wayland 截图工具：请安装 grim + slurp（KDE 可用 spectacle）'
      : '缺少截图工具：GNOME 装 gnome-screenshot、KDE 装 spectacle，或安装 flameshot / scrot / imagemagick';
  }
  return `当前系统（${platform}）暂不支持截图提问`;
}

// 转写粘回原前台应用所需工具（macOS 靠辅助功能权限，Windows 走系统 API，Linux 靠 X11/Wayland 工具）
// trustedAccessibility：macOS 的辅助功能信任状态，由调用方（Electron systemPreferences）传入
function pickPasteTool({ platform, env, hasCmd, trustedAccessibility = false }) {
  if (platform === 'darwin') return trustedAccessibility ? 'osascript' : '';
  if (platform === 'win32') return 'keybd_event';
  if (platform === 'linux') return hasCmd('xdotool') ? 'xdotool' : hasCmd('wtype') ? 'wtype' : '';
  return '';
}

// ── 绑定真实环境的便捷封装 ────────────────────────────────────────
let _shotBackend = null;
function screenshotBackend() {
  if (_shotBackend !== null) return _shotBackend; // which 要起子进程，按进程缓存一次
  _shotBackend = pickScreenshotBackend({
    platform: process.platform,
    env: process.env,
    hasCmd: realHasCmd,
  });
  return _shotBackend;
}

module.exports = {
  realHasCmd,
  isWayland,
  pickScreenshotBackend,
  pickPasteTool,
  shotMissingHint,
  screenshotBackend,
};
