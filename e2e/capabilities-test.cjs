// yxpil · 桌面能力探测单测（node:test，三端 runner 都能跑）
//! 截图后端与粘贴工具的选择矩阵在 CI 里没法靠「真按快捷键」验证，
//! 所以决策逻辑做成纯函数（electron/desktop-capabilities.cjs），这里按平台/环境/PATH 组合穷举。
//! 附带一次真实 which/where 探活——Windows 的 `where` 分支此前只能靠肉眼。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const caps = require('../electron/desktop-capabilities.cjs');

// 有 PATH 里存在哪些命令的假实现
const has = (...names) => {
  const set = new Set(names);
  return (n) => set.has(n);
};
const linux = (available, env = {}) =>
  caps.pickScreenshotBackend({ platform: 'linux', env: { ...env }, hasCmd: has(...available) });

test('macOS / Windows 用系统自带通道，不看 PATH', () => {
  assert.equal(caps.pickScreenshotBackend({ platform: 'darwin', env: {}, hasCmd: has() }), 'screencapture');
  assert.equal(caps.pickScreenshotBackend({ platform: 'win32', env: {}, hasCmd: has() }), 'ms-screenclip');
});

test('未知平台判为不支持而不是硬猜一个后端', () => {
  assert.equal(caps.pickScreenshotBackend({ platform: 'freebsd', env: {}, hasCmd: has('scrot') }), '');
});

test('X11 按桌面套件优先级挑后端', () => {
  assert.equal(linux([]), '', '一个都没有时应判不支持');
  assert.equal(linux(['scrot']), 'scrot');
  assert.equal(linux(['import']), 'imagemagick', 'ImageMagick import 要归一成后端名');
  assert.equal(linux(['flameshot', 'scrot']), 'flameshot', 'flameshot 优先于 scrot');
  assert.equal(linux(['gnome-screenshot', 'flameshot', 'scrot', 'import']), 'gnome-screenshot');
  assert.equal(linux(['spectacle', 'gnome-screenshot']), 'gnome-screenshot', 'GNOME 排第一位');
  assert.equal(linux(['spectacle', 'flameshot']), 'spectacle', '没有 GNOME 时 KDE 优先');
});

test('Wayland 不选 X11 专属工具', () => {
  const env = { WAYLAND_DISPLAY: 'wayland-0' };
  assert.equal(linux(['gnome-screenshot', 'scrot'], env), '', 'X11 工具在 Wayland 下不可用');
  assert.equal(linux(['grim'], env), '', 'grim 单独不够，选区要靠 slurp');
  assert.equal(linux(['slurp'], env), '');
  assert.equal(linux(['grim', 'slurp'], env), 'grim+slurp');
  assert.equal(linux(['spectacle', 'grim', 'slurp'], env), 'grim+slurp', '两者都有时先通用组合');
  assert.equal(linux(['spectacle'], env), 'spectacle');
});

test('会话类型大小写与 XDG_SESSION_TYPE 都能识别成 Wayland', () => {
  assert.equal(linux(['grim', 'slurp'], { XDG_SESSION_TYPE: 'Wayland' }), 'grim+slurp');
  assert.equal(linux(['grim', 'slurp'], { XDG_SESSION_TYPE: 'x11' }), '', 'x11 会话不走 grim 分支');
  assert.equal(caps.isWayland('linux', { WAYLAND_DISPLAY: 'wayland-1' }), true);
  assert.equal(caps.isWayland('linux', { XDG_SESSION_TYPE: 'wayland' }), true);
  assert.equal(caps.isWayland('linux', { XDG_SESSION_TYPE: 'tty' }), false);
  assert.equal(caps.isWayland('darwin', { WAYLAND_DISPLAY: 'wayland-1' }), false, '非 Linux 不算 Wayland');
});

test('缺工具提示必须给出该平台真正能装的套件名', () => {
  const wl = caps.shotMissingHint({ platform: 'linux', env: { WAYLAND_DISPLAY: 'w' } });
  assert.match(wl, /grim/, 'Wayland 提示要提到 grim');
  assert.doesNotMatch(wl, /gnome-screenshot/, 'Wayland 下别让用户去装 X11 工具');
  const x11 = caps.shotMissingHint({ platform: 'linux', env: {} });
  assert.match(x11, /gnome-screenshot/);
  assert.match(caps.shotMissingHint({ platform: 'freebsd', env: {} }), /freebsd/, '其它平台报清系统名');
});

test('粘贴通道按平台给工具，macOS 未授权即判不可用', () => {
  const p = (platform, opts = {}) =>
    caps.pickPasteTool({ platform, env: {}, hasCmd: has(...(opts.available || [])), trustedAccessibility: !!opts.trusted });
  assert.equal(p('win32'), 'keybd_event', 'Windows 走系统 API，不依赖第三方');
  assert.equal(p('darwin'), '', 'macOS 没拿到辅助功能信任时不能假装可用');
  assert.equal(p('darwin', { trusted: true }), 'osascript');
  assert.equal(p('linux'), '');
  assert.equal(p('linux', { available: ['xdotool'] }), 'xdotool');
  assert.equal(p('linux', { available: ['wtype'] }), 'wtype', '没有 xdotool 才回落 wtype');
  assert.equal(p('linux', { available: ['xdotool', 'wtype'] }), 'xdotool');
  assert.equal(p('freebsd'), '');
});

test('真实 which/where 探活（三端各自跑自己的实现）', () => {
  assert.equal(caps.realHasCmd(process.platform === 'win32' ? 'where' : 'node'), true);
  assert.equal(caps.realHasCmd('bit-definitely-not-on-path-9f3a2b'), false);
});

test('本机后端探测与纯决策一致且只探测一次', () => {
  const first = caps.screenshotBackend();
  assert.equal(first, caps.pickScreenshotBackend({ platform: process.platform, env: process.env, hasCmd: caps.realHasCmd }));
  assert.equal(caps.screenshotBackend(), first, '结果应被缓存（which 起子进程）');
});
