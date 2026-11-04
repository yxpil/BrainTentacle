// yxpil · beforePack 跨架构补装自检（CI 用，本机也可手跑）
//! 打包钩子只在 electron-builder 里被调，正常流程摸不到它；这里直接喂一个假 context，
//! 验证「目标架构的 sherpa-onnx 原生包能否在该 OS 上补装到位」以及「registry 里没有的
//! 组合是明确跳过而不是瞎装一个」。
//! BIT_XCHECK_PLATFORM / BIT_XCHECK_ARCH 必填；BIT_XCHECK_EXPECT=install|skip。
const fs = require('fs');
const path = require('path');
const beforePack = require('../scripts/before-pack.cjs').default;

const platform = process.env.BIT_XCHECK_PLATFORM;
const arch = Number(process.env.BIT_XCHECK_ARCH);
const expect = process.env.BIT_XCHECK_EXPECT || 'install';
if (!platform || Number.isNaN(arch)) {
  console.error('需要 BIT_XCHECK_PLATFORM 与 BIT_XCHECK_ARCH（electron-builder 的 Arch 数值）');
  process.exit(1);
}

const bridgeModules = path.resolve(__dirname, '..', 'voice-bridge', 'node_modules');

(async () => {
  const before = new Set(fs.existsSync(bridgeModules) ? fs.readdirSync(bridgeModules) : []);
  await beforePack({ electronPlatformName: platform, arch });
  const after = new Set(fs.existsSync(bridgeModules) ? fs.readdirSync(bridgeModules) : []);
  const added = [...after].filter((d) => !before.has(d) && d.startsWith('sherpa-onnx-'));
  console.log(JSON.stringify({ platform, arch, expect, added: added.length ? added : '(无新增)' }, null, 2));

  if (expect === 'skip') {
    if (added.length) {
      console.error(`期望跳过（registry 无此包），却补装了 ${added.join(', ')}`);
      process.exit(1);
    }
    console.log('跳过分支 OK');
    return;
  }
  const pkg = added[0];
  if (!pkg) {
    console.error('期望补装目标架构原生包，实际没有新增目录（可能构建机本身就装了它）');
    process.exit(1);
  }
  const dotNode = path.join(bridgeModules, pkg, 'sherpa-onnx.node');
  if (!fs.existsSync(dotNode)) {
    console.error(`补装后仍缺 ${pkg}/sherpa-onnx.node`);
    process.exit(1);
  }
  console.log(`跨架构补装 OK → ${pkg}（${fs.statSync(dotNode).size} 字节）`);
})().catch((e) => {
  console.error('beforePack 自检失败：', e && e.message ? e.message : e);
  process.exit(1);
});
