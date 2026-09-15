// yxpil · 打包物料暂存（M4）
// 把构建产物复制到 packaging/native/，供 electron-builder extraResources 注入 resources 根：
//   bit.node          napi 核心（cdylib：Windows=bit_napi.dll / Linux=libbit_napi.so / macOS=libbit_napi.dylib）
//   bit-cli(.exe)     worker / guardian sidecar
//   icon.ico          托盘/通知图标（Windows；mac/linux 打包用 yml 里的 icns/png）
// 候选路径按优先级探测：--target 三元组目录 → 默认 target/release → 现存 bit_napi.node。
// CI 的 napi 矩阵走 artifact 下载后同样落位 packaging/native/（文件名已归一）。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'packaging', 'native');
fs.mkdirSync(OUT, { recursive: true });

const EXE = process.platform === 'win32' ? 'bit-cli.exe' : 'bit-cli';
const TRIPLE =
  process.env.BIT_TRIPLE ||
  (process.platform === 'win32'
    ? 'x86_64-pc-windows-msvc'
    : process.platform === 'darwin'
      ? 'aarch64-apple-darwin'
      : 'x86_64-unknown-linux-gnu');
const NODE_LIB = { win32: 'bit_napi.dll', darwin: 'libbit_napi.dylib', linux: 'libbit_napi.so' }[process.platform];

// 在候选目录里找第一个存在的文件
function find(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const nodeSrc = find([
  process.env.BIT_STAGE_NODE,
  path.join(ROOT, 'target', TRIPLE, 'release', NODE_LIB),
  path.join(ROOT, 'target', 'release', NODE_LIB),
  path.join(ROOT, 'crates', 'bit-napi', 'bit_napi.node'),
]);
const cliSrc = find([
  process.env.BIT_STAGE_CLI,
  path.join(ROOT, 'target', TRIPLE, 'release', EXE),
  path.join(ROOT, 'target', 'release', EXE),
  path.join(ROOT, 'src-tauri', 'target', 'release', EXE),
]);
const iconSrc = find([path.join(ROOT, 'src-tauri', 'icons', 'icon.ico')]);

if (!nodeSrc) {
  console.error(`stage-pack: 找不到 napi 核心产物（${NODE_LIB}）——先跑 cargo build --release -p bit-napi`);
  process.exit(1);
}
if (!cliSrc) {
  console.error('stage-pack: 找不到 bit-cli sidecar——先跑 cargo build --release -p bit-core');
  process.exit(1);
}
if (!iconSrc) {
  console.error('stage-pack: 找不到 src-tauri/icons/icon.ico');
  process.exit(1);
}

fs.copyFileSync(nodeSrc, path.join(OUT, 'bit.node'));
fs.copyFileSync(cliSrc, path.join(OUT, EXE));
fs.copyFileSync(iconSrc, path.join(OUT, 'icon.ico'));

const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`stage-pack OK → packaging/native/`);
console.log(`  bit.node  ← ${nodeSrc} (${mb(nodeSrc)} MB)`);
console.log(`  ${EXE} ← ${cliSrc} (${mb(cliSrc)} MB)`);
console.log(`  icon.ico  ← ${iconSrc}`);
