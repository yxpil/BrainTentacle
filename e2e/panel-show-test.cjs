// 任务面板「显示主界面」按钮验证：打开面板 → 点击 → 面板应收起（visibilityState=hidden）
const ws = require("ws");
const http = require("http");
const fs = require("fs");
const OUT = "e2e/panel-show-result.txt";
const log = (...a) => { fs.appendFileSync(OUT, a.join(" ") + "\n"); };
try { fs.unlinkSync(OUT); } catch {}
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const attach = async (url) => {
  const c = new ws(url);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { c.on("open", r); c.on("error", j); });
  c.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); c.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  return { send, evl, close: () => c.close() };
};
(async () => {
  setTimeout(() => { log("TIMEOUT 30s"); process.exit(3); }, 30000);
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => { log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + detail}`); cond ? pass++ : fail++; };

  // 主窗口打开面板
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  if (!page) { log("主窗口未找到"); process.exit(2); }
  const main = await attach(page.webSocketDebuggerUrl);
  await main.send("Runtime.enable");
  await main.evl(`window.__TAURI_INTERNALS__.invoke('plugin:window|open-status', {})`);
  await new Promise(r => setTimeout(r, 2000));

  // 连面板
  const targets2 = await getTargets();
  const panel = targets2.find(t => t.title && t.title.includes("任务面板"));
  if (!panel) { log("✗ 面板未创建"); process.exit(2); }
  const p = await attach(panel.webSocketDebuggerUrl);
  await p.send("Runtime.enable");

  // 按钮存在性
  const btns = await p.evl(`JSON.stringify({
    show: !!document.getElementById("btn-show"),
    showText: document.getElementById("btn-show")?.textContent,
    quit: !!document.getElementById("btn-quit"),
    quitText: document.getElementById("btn-quit")?.textContent,
    visible: document.visibilityState,
  })`);
  log("面板按钮:", btns);
  const b = JSON.parse(btns);
  ok("「显示主界面」按钮渲染", b.show && b.showText === "显示主界面");
  ok("「退出应用」按钮渲染", b.quit && b.quitText === "退出应用");
  ok("面板初始可见", b.visible === "visible");

  // 点击「显示主界面」→ 面板应收起
  await p.evl(`document.getElementById("btn-show").click()`);
  await new Promise(r => setTimeout(r, 800));
  const vis = await p.evl(`document.visibilityState`);
  log("点击后面板 visibility:", vis);
  ok("点击后面板自动收起", vis === "hidden");

  log(`\n========== 面板按钮: ${pass} 通过 / ${fail} 失败 ==========`);
  main.close(); p.close(); process.exit(fail ? 2 : 0);
})().catch(e => { log("FATAL: str=" + String(e)); process.exit(1); });
