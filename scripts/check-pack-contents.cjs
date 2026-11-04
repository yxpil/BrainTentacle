// yxpil · BIT electron-builder 打包内容闸门
//! 出包后校验「夹具与测试不许进包」：
//! - 仓库自己的测试资产（e2e/、plugins/ 验证套件、scripts/ 探针、src/ 源码等）
//!   由 electron-builder.yml 的 files 白名单挡在门外，此处做二次确认；
//! - 依赖自带的 test/、examples/、*.test.js 由 files 的负向模式清掉，此处同样确认；
//! - 顺手钉住两条同源保证：产物 package.json 不带 scripts / devDependencies
//!   （仓库里的 lint、test:capabilities 之类的命令不该跟着装到用户机上），
//!   以及 LICENSE 仍在（MIT 要求随包附许可，清理规则不能把它们一起删掉）。
//!
//! 用法：
//!   node scripts/check-pack-contents.cjs <appOutDir>        # 校验产物目录
//! 作为模块：check(files, packedPackage) → 违规说明数组（空即通过）
const fs = require('fs');
const path = require('path');

// 仓库级测试与夹具目录：出现在产物里就是打包配置漏了口子
const REPO_TEST_ROOTS = ['e2e', 'plugins', 'scripts', 'src', 'crates', 'target', 'installer', 'docs', 'tests'];
// 三方依赖自带的测试/示例目录（与 electron-builder.yml 的负向模式保持同一份口径）
const DEP_TEST_DIRS = ['test', 'tests', '__tests__', 'example', 'examples', 'spec', 'fixture', 'fixtures'];
// 三方依赖自带的测试文件：只认「.test./.spec. + js/ts 后缀」，避免误伤 *testing* 之类的运行期工具
const DEP_TEST_FILE = /\.(test|spec)\.(js|mjs|cjs|ts)$/;
const SOURCE_MAP = /\.map$/;

function segments(p) {
  return p.split(/[\\/]/).filter(Boolean);
}

// files：产物内的相对路径数组（app.asar 成员 + app.asar.unpacked 磁盘文件）
function check(files, packedPackage) {
  const bad = [];
  const lower = (s) => s.toLowerCase();

  for (const raw of files) {
    const parts = segments(raw).map(lower);
    const name = lower(parts[parts.length - 1] || '');

    const root = parts[0];
    if (REPO_TEST_ROOTS.includes(root)) bad.push(`仓库测试/夹具目录进包：${raw}`);

    const inDeps = parts.includes('node_modules');
    if (inDeps && parts.some((s) => DEP_TEST_DIRS.includes(s))) bad.push(`依赖自带测试/示例目录进包：${raw}`);
    if (inDeps && DEP_TEST_FILE.test(name)) bad.push(`依赖自带测试文件进包：${raw}`);

    if (SOURCE_MAP.test(name)) bad.push(`source map 进包：${raw}`);
  }

  if (packedPackage && (packedPackage.scripts || packedPackage.devDependencies)) {
    bad.push('产物 package.json 仍带 scripts/devDependencies（仓库测试命令会跟着装到用户机上）');
  }

  const licenses = files.filter((f) => /licen[cs]e$/i.test(f));
  if (licenses.length === 0) bad.push('产物里没有任何 LICENSE：MIT 依赖必须随包附许可文本');

  return bad;
}

function listAsar(asarPath) {
  try {
    // @electron/asar 是 electron-builder 的依赖，打包链里必然可用
    const asar = require('@electron/asar');
    return asar.listPackage(asarPath).map((p) => p.replace(/^[\\/]+/, ''));
  } catch (e) {
    console.error(`[pack-check] 读取 asar 失败：${e.message}`);
    return [];
  }
}

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs));
  }
  return out;
}

function readPackedPackage(asarPath) {
  try {
    const asar = require('@electron/asar');
    return JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  } catch {
    return null;
  }
}

if (require.main === module) {
  const appOutDir = process.argv[2];
  if (!appOutDir) {
    console.error('用法：node scripts/check-pack-contents.cjs <appOutDir>');
    process.exit(2);
  }
  const resources = path.join(appOutDir, 'resources');
  const asarPath = path.join(resources, 'app.asar');
  const unpacked = path.join(resources, 'app.asar.unpacked');

  const files = [];
  if (fs.existsSync(asarPath)) files.push(...listAsar(asarPath));
  if (fs.existsSync(unpacked)) files.push(...walk(unpacked, resources, []));
  if (files.length === 0) {
    console.error('[pack-check] 产物里没有 app.asar，也没有 app.asar.unpacked——无从校验');
    process.exit(2);
  }

  const violations = check(files, fs.existsSync(asarPath) ? readPackedPackage(asarPath) : null);
  console.log(`[pack-check] 校验 ${files.length} 个产物条目`);
  if (violations.length) {
    for (const v of violations.slice(0, 40)) console.error('[pack-check] ✗ ' + v);
    if (violations.length > 40) console.error(`[pack-check] …另有 ${violations.length - 40} 条`);
    console.error(`[pack-check] FAIL：${violations.length} 条违规`);
    process.exit(1);
  }
  console.log('[pack-check] PASS：夹具与测试未进包，LICENSE 齐备');
}

module.exports = { check, listAsar };
