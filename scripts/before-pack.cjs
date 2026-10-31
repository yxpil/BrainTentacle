// yxpil · BIT electron-builder beforePack
//! 语音识别原生包按目标平台补齐。
//! sherpa-onnx-node 的平台二进制（sherpa-onnx-<os>-<arch>）是 optionalDependencies，
//! npm 只装「装它的那台机器」对应的一份：CI 在 arm64 runner 上出 x64 包、
//! 或在 x64 runner 上出 arm64 包时，包里的 voice-bridge/node_modules 缺目标架构的
//! .node，用户端语音识别会以「Could not find sherpa-onnx-node」失败。
//! 此钩子在打包前按 context 的目标平台/架构补装（npm 版本与被依赖的 sherpa-onnx-node 对齐）。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// electron-builder 的 Arch 枚举值 → Node os.arch() 口径名
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal', 5: 'mips64el' };
// electron-builder 平台名 → sherpa 平台包名的 os 段（win32→win，其余原样）
const OS_NAMES = { darwin: 'darwin', linux: 'linux', win32: 'win' };
// sherpa-onnx-node 实际发布的原生包（其余组合 registry 里没有，装了也白装）
const SUPPORTED = new Set([
  'sherpa-onnx-darwin-arm64',
  'sherpa-onnx-darwin-x64',
  'sherpa-onnx-linux-arm64',
  'sherpa-onnx-linux-x64',
  'sherpa-onnx-win-ia32',
  'sherpa-onnx-win-x64',
]);

function targetPkg(platformName, arch) {
  const os = OS_NAMES[platformName];
  const archName = typeof arch === 'string' ? arch : ARCH_NAMES[arch];
  if (!os || !archName) return { pkg: null, note: `目标 ${platformName}/${arch} 平台或架构未知` };
  const pkg = `sherpa-onnx-${os}-${archName}`;
  if (!SUPPORTED.has(pkg)) return { pkg: null, note: `${pkg} 不在 sherpa-onnx-node 发布范围内：该包的端侧语音识别不可用，请用在线引擎` };
  return { pkg };
}

function sherpaVersion(bridgeDir) {
  // 已安装的 sherpa-onnx-node 版本为准（保证 .node 与 JS 封装同版本）
  const installed = path.join(bridgeDir, 'node_modules', 'sherpa-onnx-node', 'package.json');
  if (fs.existsSync(installed)) {
    try {
      return JSON.parse(fs.readFileSync(installed, 'utf8')).version;
    } catch { /* 落到 lock 读取 */ }
  }
  const lock = path.join(bridgeDir, 'package-lock.json');
  const doc = JSON.parse(fs.readFileSync(lock, 'utf8'));
  const entry = doc.packages?.['node_modules/sherpa-onnx-node'];
  const v = entry?.version;
  if (!v) throw new Error('[beforePack] 无法确定 sherpa-onnx-node 版本');
  return v;
}

// npm 的启动方式在 Windows 上是个坑：npm 本体是 npm.cmd，而 Node 自 CVE-2024-27980 的修复后
// 不允许在无 shell 的情况下 spawn .cmd/.bat（EINVAL）。优先用 npm 注入的 npm_execpath
// （指向 npm-cli.js），拿当前 node 直接跑它——既绕开 .cmd，也不经 shell，没有参数转义问题。
function npmLaunch(args) {
  const cli = process.env.npm_execpath;
  if (cli && fs.existsSync(cli)) {
    // ELECTRON_RUN_AS_NODE：构建若由 Electron 进程发起，这一句才让 execPath 当 node 用
    return {
      file: process.execPath,
      args: [cli, ...args],
      opts: { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    };
  }
  if (process.platform === 'win32') return { file: 'npm.cmd', args, opts: { shell: true } };
  return { file: 'npm', args, opts: {} };
}

exports.default = async function beforePack(context) {
  const { pkg, note } = targetPkg(context.electronPlatformName, context.arch);
  if (!pkg) {
    console.log(`[beforePack] 跳过原生包补装：${note}`);
    return;
  }
  const root = path.resolve(__dirname, '..');
  const bridgeDir = path.join(root, 'voice-bridge');
  const dest = path.join(bridgeDir, 'node_modules', pkg, 'sherpa-onnx.node');
  if (fs.existsSync(dest)) {
    console.log(`[beforePack] 原生包已就位：${pkg}`);
    pruneForeign(bridgeDir, pkg);
    return;
  }
  const version = sherpaVersion(bridgeDir);
  console.log(`[beforePack] 补装目标平台原生包 ${pkg}@${version}（构建机 ${process.platform}/${process.arch}）`);
  try {
    // --force：跨平台安装 optional 原生包必须绕过 npm 的 os/cpu 校验（EBADPLATFORM）
    // --no-save / --no-package-lock：不改 package.json 与 lock，纯落位
    const launch = npmLaunch([
      'install',
      '--no-save',
      '--no-package-lock',
      '--ignore-scripts',
      '--force',
      `${pkg}@${version}`,
    ]);
    execFileSync(launch.file, launch.args, { cwd: bridgeDir, stdio: 'inherit', ...launch.opts });
  } catch {
    throw new Error(`[beforePack] ${pkg}@${version} 补装失败：语音识别在该架构将不可用（请检查网络/npm registry 可达）`);
  }
  if (!fs.existsSync(dest)) {
    throw new Error(`[beforePack] ${pkg} 装完仍缺 node_modules/${pkg}/sherpa-onnx.node`);
  }
  pruneForeign(bridgeDir, pkg);
  console.log(`[beforePack] OK → ${pkg}`);
};

// 打包机自己那一份（以及其它架构那份）对目标包纯属死重量：npm 只会装构建机平台的可选依赖，
// 跨架构出包时它跟着 voice-bridge/** 一起进 asar.unpacked，几十 MB 白占安装体积。
// 只在 CI 里清（本地开发树保留，免得把开发者自己机器的识别弄坏）。
function pruneForeign(bridgeDir, keepPkg) {
  if (!process.env.CI) return;
  const nm = path.join(bridgeDir, 'node_modules');
  if (!fs.existsSync(nm)) return;
  for (const name of fs.readdirSync(nm)) {
    if (!/^sherpa-onnx-(darwin|linux|win)-/.test(name) || name === keepPkg) continue;
    fs.rmSync(path.join(nm, name), { recursive: true, force: true });
    console.log(`[beforePack] CI 清理非目标原生包：${name}`);
  }
}
