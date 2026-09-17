// 主题入库统一读取验证：set_theme 落库 → get_theme 读回；html.dark 变化 → 面板实时跟随
const ws = require("ws");
const http = require("http");
const fs = require("fs");
const OUT = "e2e/theme-db-result.txt";
const log = (...a) => { fs.appendFileSync(OUT, a.join(" ") + "\n"); console.log(...a); };
try { fs.unlinkSync(OUT); } catch {}
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const connectPage = async (match) => {
  const targets = await getTargets();
  const t = targets.find(match);
  if (!t) return null;
  const c = new ws(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { c.on("open", r); c.on("error", j); });
  c.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); c.send(JSON.stringify({ id: n, method, params })); });
  return { send, evl: async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; }, close: () => c.close() };
};
(async () => {
  setTimeout(() => { log("TIMEOUT 45s"); process.exit(3); }, 45000);
  const main = await connectPage(t => t.type === "page" && decodeURIComponent(t.url).includes("index.html"));
  if (!main) { log("主窗口未找到"); process.exit(2); }
  await main.send("Runtime.enable");

  // 1. set_theme 落库 + 读回
  const set1 = await main.evl(`window.__TAURI_INTERNALS__.invoke('set_theme', { theme: 'dark' })`);
  log("SET_DARK:", JSON.stringify(set1));
  const db1 = await main.evl(`window.__TAURI_INTERNALS__.invoke('get_theme', {})`);
  log("DB_AFTER_SET_DARK:", JSON.stringify(db1));
  const setBad = await main.evl(`window.__TAURI_INTERNALS__.invoke('set_theme', { theme: 'blue' }).then(() => 'no-error').catch(e => 'rejected: ' + e)`);
  log("SET_INVALID:", setBad);

  // 2. 打开面板
  await main.evl(`window.__TAURI_INTERNALS__.invoke('plugin:window|open-status', {})`);
  await new Promise(r => setTimeout(r, 1500));
  const panel = await connectPage(t => t.title && t.title.includes("任务面板"));
  if (!panel) { log("面板未创建"); main.close(); process.exit(2); }
  await panel.send("Runtime.enable");
  const readPanel = async () => JSON.parse(await panel.evl(`JSON.stringify({ theme: snap.theme, dark: document.body.classList.contains('dark') })`));

  // 3. 主界面 html.dark 变化 → preload observer → 主进程 → 面板实时跟随
  await main.evl(`document.documentElement.classList.add('dark')`);
  await new Promise(r => setTimeout(r, 1500));
  const p1 = await readPanel();
  log("PANEL_AFTER_DARK:", JSON.stringify(p1));

  // 4. 还原 light
  await main.evl(`document.documentElement.classList.remove('dark')`);
  await new Promise(r => setTimeout(r, 1500));
  const p2 = await readPanel();
  log("PANEL_AFTER_LIGHT:", JSON.stringify(p2));
  // 库还原 light（供后续重启验证前端 sync 链路时状态干净）
  const set2 = await main.evl(`window.__TAURI_INTERNALS__.invoke('set_theme', { theme: 'light' })`);
  log("SET_RESTORE:", JSON.stringify(set2));

  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => { log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + detail}`); cond ? pass++ : fail++; };
  ok("set_theme 落库读回 dark", db1?.theme === "dark");
  ok("非法 theme 被拒绝", String(setBad).startsWith("rejected"));
  ok("面板跟随 dark", p1.theme === "dark" && p1.dark === true, JSON.stringify(p1));
  ok("面板跟随 light", p2.theme === "light" && p2.dark === false, JSON.stringify(p2));
  log(`\n========== 主题入库: ${pass} 通过 / ${fail} 失败 ==========`);
  main.close(); panel.close(); process.exit(fail ? 2 : 0);
})().catch(e => { log("FATAL: " + String(e)); process.exit(1); });
