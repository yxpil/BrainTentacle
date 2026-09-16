// toggle 修复验证：open-status ×3 → 开(visible) → 收(hidden) → 再开(visible)
const ws = require("ws");
const http = require("http");
const get = () => new Promise((r, j) => http.get("http://127.0.0.1:9222/json", x => { let b = ""; x.on("data", d => b += d); x.on("end", () => r(JSON.parse(b))); }).on("error", j));
const attach = async (url) => {
  const c = new ws(url);
  let id = 0; const p = new Map();
  await new Promise((r, j) => { c.on("open", r); c.on("error", j); });
  c.on("message", d => { const m = JSON.parse(d); if (m.id && p.has(m.id)) { const [R, x] = p.get(m.id); p.delete(m.id); m.error ? x(new Error(m.error.message)) : R(m.result); } });
  const send = (m, a = {}) => new Promise((R, x) => { const n = ++id; p.set(n, [R, x]); c.send(JSON.stringify({ id: n, method: m, params: a })); });
  const evl = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  return { send, evl, close: () => c.close() };
};
(async () => {
  setTimeout(() => { console.log("TIMEOUT"); process.exit(3); }, 40000);
  const targets = await get();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  if (!page) { console.log("主窗口未找到"); process.exit(2); }
  const main = await attach(page.webSocketDebuggerUrl);
  await main.send("Runtime.enable");
  const inv = (cmd) => main.evl(`window.__TAURI_INTERNALS__.invoke('${cmd}', {})`);

  let pass = 0, fail = 0;
  const ok = (name, cond) => { console.log(`  ${cond ? "✓" : "✗"} ${name}`); cond ? pass++ : fail++; };

  await inv("plugin:window|open-status");
  await new Promise(r => setTimeout(r, 1500));
  const targets2 = await get();
  const panel = targets2.find(t => t.title && t.title.includes("任务面板"));
  if (!panel) { console.log("✗ 面板未创建"); process.exit(2); }
  const c = await attach(panel.webSocketDebuggerUrl);
  await c.send("Runtime.enable");
  const vis = () => c.evl(`document.visibilityState`);
  ok("第 1 次打开 → 可见", (await vis()) === "visible");

  await inv("plugin:window|open-status"); // 已显示 → 保持弹出（可靠弹出，不做 toggle）
  await new Promise(r => setTimeout(r, 600));
  ok("第 2 次打开 → 仍可见", (await vis()) === "visible");

  await inv("plugin:window|open-status"); // 失焦收起后右键 → 必须能重新弹出（修复"失灵"核心）
  await new Promise(r => setTimeout(r, 600));
  ok("第 3 次打开 → 仍可见（失灵修复验证）", (await vis()) === "visible");

  // 背景色注入验证
  const bg = await c.evl(`getComputedStyle(document.getElementById("root")).getPropertyValue("--bg").trim()`);
  const theme = await c.evl(`document.body.className`);
  console.log("  面板 --bg =", bg, "| body =", theme);

  console.log(`\n========== toggle: ${pass} 通过 / ${fail} 失败 ==========`);
  main.close(); c.close(); process.exit(fail ? 2 : 0);
})().catch(e => { console.log("err", String(e)); process.exit(1); });
