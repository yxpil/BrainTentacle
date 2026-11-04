// 插件验证套件安装器：把 plugins/ 下的套件包拷进某个「隔离验证实例」的 toolhomes/plugins。
//
// 为什么不给默认目录：用户真实数据目录（%APPDATA%\com.bit.hub）里的插件列表是用户自己的东西，
// 一次误装就会把十几个测试插件混进他的设置中心。这里强制显式 --dest，并且认出真实目录直接拒绝。
//
// 用法：
//   node scripts/install-plugin-suite.cjs --dest "<BIT_DATA_DIR>/toolhomes/plugins" [--with-invalid] [--clean] [--list]
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SUITE = path.join(ROOT, "plugins");
const INVALID_DIR = path.join(SUITE, "_invalid");
const STAMP = ".plugin-suite.json"; // 装过什么的账本，--clean 照着它回收

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function realUserDataDir() {
  const appdata = process.env.APPDATA || process.env.LocalAppData || "";
  return appdata ? path.resolve(appdata, "com.bit.hub") : "";
}

function listPackages(withInvalid) {
  const out = [];
  for (const name of fs.readdirSync(SUITE, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    if (name.name === "_invalid") continue;
    if (!fs.existsSync(path.join(SUITE, name.name, "plugin.json"))) continue;
    out.push({ id: name.name, dir: path.join(SUITE, name.name), invalid: false });
  }
  if (withInvalid && fs.existsSync(INVALID_DIR)) {
    for (const name of fs.readdirSync(INVALID_DIR, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      out.push({ id: name.name, dir: path.join(INVALID_DIR, name.name), invalid: true });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function main() {
  const destArg = opt("dest");
  if (flag("list")) {
    for (const p of listPackages(flag("with-invalid"))) console.log(`${p.invalid ? "夹具" : "套件"} ${p.id}`);
    return;
  }
  if (!destArg) {
    console.error("必须显式给出 --dest <目录>（只允许装隔离验证实例，见 plugins/README.md）");
    process.exit(2);
  }
  const dest = path.resolve(destArg);
  const real = realUserDataDir();
  if (real && (dest === real || dest.startsWith(real + path.sep))) {
    console.error(`拒绝写入用户真实数据目录：${dest}\n请改用 BIT_DATA_DIR 指向的临时目录。`);
    process.exit(2);
  }

  const stampFile = path.join(dest, STAMP);
  const stamp = fs.existsSync(stampFile) ? JSON.parse(fs.readFileSync(stampFile, "utf8")) : { installed: [] };

  if (flag("clean")) {
    for (const id of stamp.installed || []) {
      const p = path.join(dest, id);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`回收 ${id}`);
      }
    }
    fs.rmSync(stampFile, { force: true });
    console.log("套件已回收（WorkWith 里的残留条目要另走联动页清理）");
    return;
  }

  const pkgs = listPackages(flag("with-invalid"));
  fs.mkdirSync(dest, { recursive: true });
  const written = [];
  for (const p of pkgs) {
    const target = path.join(dest, p.id);
    fs.rmSync(target, { recursive: true, force: true }); // 重装修：旧文件（含被删掉的）不留
    copyTree(p.dir, target);
    written.push(p.id);
    console.log(`${p.invalid ? "夹具" : "套件"} ${p.id} → ${target}`);
  }
  fs.writeFileSync(stampFile, JSON.stringify({ installed: written, at: new Date().toISOString() }, null, 2), "utf8");
  console.log(`共 ${written.length} 个包写入 ${dest}`);
  console.log("下一步：在应用里点「插件」页的重新扫描，或直接让探针调 refresh_plugins。");
}

main();
