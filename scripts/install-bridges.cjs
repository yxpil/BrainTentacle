// 根 postinstall：两个 bridge 各有独立 package-lock，要各自在自己的目录里装。
// 不用 `npm --prefix <dir>`：在 Windows 的 cmd.exe 里，嵌套 npm 会继承根 npm 的
// lifecycle 环境（npm_config_local_prefix 指向根工程），于是子 npm 又把根工程装一遍、
// 再跑一次 postinstall——表现为无限递归 + 最终 EPERM 清理失败。改用 spawn + cwd，
// 并剥掉这些 lifecycle 变量，三端行为一致。
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^npm_(config_local_prefix|config_prefix|config_global|lifecycle_)/i.test(k)) continue;
  env[k] = v;
}

for (const dir of ["dsh-bridge", "voice-bridge"]) {
  const cwd = path.join(__dirname, "..", dir);
  const r = spawnSync(npm, ["install", "--no-audit", "--no-fund"], {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32", // Node 18.20+ 起 .cmd 必须经 shell 启动
  });
  if (r.error) {
    console.error(`[install-bridges] ${dir} 启动失败：${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status || 1);
}
