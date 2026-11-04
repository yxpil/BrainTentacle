// yxpil · BIT electron-builder afterPack
//! 打包收尾：删除 Electron 自带的 default_app（「默认应用」）。
//! 它是 electron.exe 不带应用时的回退壳——能把可执行文件直接变成素面 Chromium
//! 浏览器 / REPL（node_modules 里的 `electron.exe <url>` 就是走的它）。
//! 正式包里 app.asar 永远存在，default_app 纯属死重量 + 露馅口子：
//! 删掉 app.asar 即可让 BIT.exe 回退成浏览器。此钩子把这条路焊死。
const fs = require('fs');
const path = require('path');
const { check, listAsar } = require('./check-pack-contents.cjs');

exports.default = async function afterPack(context) {
  const resourcesDir = findResourcesDir(context.appOutDir);
  for (const name of ['default_app.asar', 'default_app.asar.unpacked']) {
    const p = path.join(resourcesDir, name);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`[afterPack] 已移除 ${name}（防回退裸 Chromium）`);
    }
  }
  checkPackContents(resourcesDir);
};

// mac 的 --dir 出包时 electron-builder 传的 appOutDir 是 .app 的父目录
// （release/mac），真身是 <productName>.app/Contents/Resources（universal 同理：
// 两架构先各自打进 <appOutDir>-<arch>-temp，合并回父目录下的 BIT.app）。
// win/linux 是 <out>/resources，直接拼。
function findResourcesDir(appOutDir) {
  const direct = path.join(appOutDir, 'Contents', 'Resources');
  if (fs.existsSync(direct)) return direct;
  let entries = [];
  try { entries = fs.readdirSync(appOutDir); } catch {}
  for (const name of entries) {
    if (!name.endsWith('.app')) continue;
    const r = path.join(appOutDir, name, 'Contents', 'Resources');
    if (fs.existsSync(r)) return r;
  }
  return path.join(appOutDir, 'resources');
}

// 内容闸门：夹具/测试只要漏进产物就让打包失败，别等用户装完才发现
function checkPackContents(resourcesDir) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
  const files = [];
  if (fs.existsSync(asarPath)) files.push(...listAsar(asarPath));
  if (fs.existsSync(unpacked)) files.push(...walk(unpacked, resourcesDir, []));
  if (files.length === 0) {
    throw new Error(`[afterPack] 找不到产物条目：${resourcesDir} 下既无 app.asar 也无 app.asar.unpacked（resources 定位可能错了）`);
  }
  let packed = null;
  try {
    packed = JSON.parse(require('@electron/asar').extractFile(asarPath, 'package.json').toString('utf8'));
  } catch { /* 读不到就跳过该项断言，其余检查照常 */ }

  const violations = check(files, packed);
  if (violations.length) {
    for (const v of violations.slice(0, 40)) console.error(`[afterPack] ✗ ${v}`);
    throw new Error(`[afterPack] 产物含 ${violations.length} 条夹具/测试残留（详见上面列表）`);
  }
  console.log(`[afterPack] 内容闸门通过：${files.length} 个条目，无夹具与测试`);
}

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs));
  }
  return out;
}
