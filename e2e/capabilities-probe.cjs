// yxpil · 真机能力探针（CI 三端各跑一次，本机也可手跑：node e2e/capabilities-probe.cjs）
//! 断言的是「本机确实探得到东西」，而不是模拟交互：
//! - 截图后端：三端都该有非空结果（macOS screencapture / Windows ms-screenclip / Linux 靠已装工具）
//! - 粘贴通道：Windows 走系统 API、Linux 靠 xdotool/wtype，都该非空；
//!   macOS 的信任状态只有 Electron 的 systemPreferences 能查，纯 node 里不作为失败。
const caps = require('../electron/desktop-capabilities.cjs');

const backend = caps.screenshotBackend();
const isMac = process.platform === 'darwin';
const paste = caps.pickPasteTool({
  platform: process.platform,
  env: process.env,
  hasCmd: caps.realHasCmd,
  trustedAccessibility: isMac, // macOS 的权限这里查不到，按已信任走，只为打印工具名
});

console.log(
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      wayland: caps.isWayland(process.platform, process.env),
      screenshot_backend: backend || '(无)',
      paste_tool: paste || '(无)',
      macos_note: isMac ? '辅助功能信任状态需 Electron 进程查询，此处不代表权限已授予' : undefined,
    },
    null,
    2,
  ),
);

if (!backend) {
  console.error('本机应能探测到截图后端，实际为空：' + caps.shotMissingHint({ platform: process.platform, env: process.env }));
  process.exit(1);
}
if (!isMac && !paste) {
  console.error('本机应能探测到粘贴通道（Windows 用系统 API；Linux 需 xdotool 或 wtype），实际为空');
  process.exit(1);
}
console.log('能力探针 OK');
