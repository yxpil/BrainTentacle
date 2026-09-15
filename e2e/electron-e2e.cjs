// Electron 全链 E2E：bit.node（napi）宿主 + bootstrap_services（HTTP 远程服务）
// + mock 上游 AI → 复用 run.cjs 全量场景断言（58 项）。
// 链路：Electron main(bit.node) → http_api :18612 → run.cjs 驱动 → bit-cli worker 对话 → mock-ai :9901
// 用法：node e2e/electron-e2e.cjs
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 18612; // 被测实例远程访问端口（避开默认 8600）
const MOCK_PORT = 9901;
const TOKEN = "e2e-client-key-electron";

const dataDir = path.join(os.tmpdir(), `bit-e2e-electron-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

// 遗留明文 config.json（>3 键触发 legacy 导入；client_key 锚点继承）
fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({
    remote_enabled: true,
    host: "127.0.0.1",
    port: PORT,
    client_key: TOKEN,
    access_password: "",
    password_enabled: false,
    revision: 5,
    // view_image 默认闸门关闭：T18/T39 要驱动该工具，E2E 数据目录出厂即开
    tool_viewimage: true,
  })
);
// 遗留明文 ai_config（导入时应用双层加密）。提供方全集对齐 activate.cjs：
// run.cjs 会在 T60-64 切换 openai-native / claude / gemini / strict
fs.writeFileSync(
  path.join(dataDir, "ai_config.json"),
  JSON.stringify({
    providers: [
      { id: "e2e-mock-provider", name: "E2E-Mock", protocol: "openai", base_url: `http://127.0.0.1:${MOCK_PORT}/v1`, api_key: "sk-e2e-mock", model: "mock-1", active: true, temperature_mode: "default", reasoning_effort: "default" },
      { id: "e2e-mock-openai-native", name: "E2E-Mock-OpenAI-Native", protocol: "openai", base_url: `http://127.0.0.1:${MOCK_PORT}/v1`, api_key: "sk-e2e-mock", model: "mock-1", active: false, temperature_mode: "default", reasoning_effort: "default" },
      { id: "e2e-mock-claude", name: "E2E-Mock-Claude", protocol: "claude", base_url: `http://127.0.0.1:${MOCK_PORT}`, api_key: "sk-e2e-mock", model: "mock-1", active: false, temperature_mode: "default", reasoning_effort: "default" },
      { id: "e2e-mock-gemini", name: "E2E-Mock-Gemini", protocol: "gemini", base_url: `http://127.0.0.1:${MOCK_PORT}`, api_key: "sk-e2e-mock", model: "mock-1", active: false, temperature_mode: "default", reasoning_effort: "default" },
      { id: "e2e-mock-strict", name: "E2E-Mock-Strict", protocol: "openai", base_url: `http://127.0.0.1:${MOCK_PORT}/v1`, api_key: "sk-e2e-mock", model: "mock-1", active: false, temperature_mode: "default", reasoning_effort: "default" },
    ],
  })
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 1500 });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

async function waitPort(port, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(500);
  }
  throw new Error(`${what} 端口 ${port} 未就绪（${ms}ms 超时）`);
}

(async () => {
  // 1. mock 上游 AI
  const mock = spawn(process.execPath, [path.join(__dirname, "mock-ai.cjs")], { stdio: ["ignore", "pipe", "pipe"] });
  mock.stdout.on("data", () => {});
  mock.stderr.on("data", (d) => console.error(`[mock-ai] ${d}`));
  mock.on("exit", (c) => console.error(`[mock-ai] exited ${c}`));
  await waitPort(MOCK_PORT, 15000, "mock-ai");
  console.log(`(mock-ai ready :${MOCK_PORT})`);

  // 1.5 fake_relay（默认 9802）：T40-T56 云中继隧道用例的被测依赖（T57 自带 9805 实例）
  const relay = spawn(process.execPath, [path.join(__dirname, "fake_relay.cjs")], { stdio: ["ignore", "ignore", "pipe"] });
  relay.stderr.on("data", (d) => console.error(`[fake-relay] ${d}`));
  relay.on("exit", (c) => console.error(`[fake-relay] exited ${c}`));
  await waitPort(9802, 15000, "fake_relay");
  console.log("(fake_relay ready :9802)");

  // 2. Electron 实例（bit.node 宿主；BIT_HEADLESS=1 窗口不弹，BIT_ELECTRON_DIST=1 加载 dist 产物）
  // 普通 node 下 require('electron') 返回 electron.exe 路径（Windows spawn npx 有 ENOENT 问题）
  const electronExe = require("electron");
  const electron = spawn(electronExe, ["electron/main.cjs"], {
    cwd: ROOT,
    env: { ...process.env, BIT_DATA_DIR: dataDir, BIT_HEADLESS: "1", BIT_ELECTRON_DIST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = (tag) => (d) => process.stdout.write(`[${tag}] ${d}`);
  electron.stdout.on("data", log("electron"));
  electron.stderr.on("data", log("electron:err"));
  electron.on("exit", (c) => console.error(`[electron] exited ${c}`));

  let failed = false;
  try {
    await waitPort(PORT, 60000, "被测实例");
    console.log(`(被测实例 ready :${PORT}, data_dir: ${dataDir})`);

    // 3. 全量场景断言（run.cjs 自带隔离预检：data_dir 须含 e2e）
    const r = spawn(process.execPath, [path.join(__dirname, "run.cjs")], {
      env: { ...process.env, E2E_PORT: String(PORT), E2E_KEY: TOKEN, E2E_PASSWORD: "" },
      stdio: "inherit",
    });
    const code = await new Promise((res) => r.on("exit", res));
    failed = code !== 0;
  } catch (e) {
    console.error(`[e2e] FAIL: ${e.message}`);
    failed = true;
  } finally {
    // T58 复活出的实例 ≠ spawn 的子进程：先走 /api/debug/quit 优雅退出链
    // （expect_exit 通知守护进程别接力），再兜底强杀
    try {
      await new Promise((res) => {
        const q = http.request({ host: "127.0.0.1", port: PORT, path: "/api/debug/quit", method: "POST", timeout: 3000 }, res);
        q.on("error", () => {});
        q.on("close", res);
        q.end();
      });
    } catch {}
    await sleep(1500);
    try { electron.kill(); } catch {}
    try { mock.kill(); } catch {}
    try { relay.kill(); } catch {}
    await sleep(1000);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`==== electron-e2e ${failed ? "FAIL" : "PASS"} ====`);
  process.exit(failed ? 1 : 0);
})();
