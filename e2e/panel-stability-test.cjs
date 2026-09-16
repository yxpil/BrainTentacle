// 防闪烁验证：制造运行中会话 → 打开面板 → 给条目打标记 → 3 秒后标记仍在 = DOM 未被每秒重建
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
  // 制造 12s 运行中会话，打开面板
  const sess = await main.evl(`window.__TAURI_INTERNALS__.invoke('create_session', { title: '防闪烁验证' })`);
  main.evl(`window.__TAURI_INTERNALS__.invoke('chat_stream', { sessionId: ${JSON.stringify(sess?.id)}, message: 'E2E-CMD-BG-LONG', eventName: 'chat-stream-stab', images: null })`).catch(() => {});
  await new Promise(r => setTimeout(r, 2400));
  await main.evl(`window.__TAURI_INTERNALS__.invoke('plugin:window|open-status', {})`);
  await new Promise(r => setTimeout(r, 2000));

  const targets2 = await get();
  const panel = targets2.find(t => t.title && t.title.includes("任务面板"));
  if (!panel) { console.log("面板未创建"); process.exit(2); }
  const c = await attach(panel.webSocketDebuggerUrl);
  await c.send("Runtime.enable");
  await c.evl(`(() => { const el = document.querySelector(".item"); if (el) el.dataset.testId = "tag1"; })()`);
  const r1 = await c.evl(`!!document.querySelector("[data-test-id=tag1]")`);
  await new Promise(r => setTimeout(r, 3000));
  const r2 = await c.evl(`!!document.querySelector("[data-test-id=tag1]")`);
  const secs = await c.evl(`(document.querySelector(".secs")||{}).textContent || "(无条目)"`);
  console.log("标记前:", r1, "| 3秒后:", r2, "| 耗时文本:", secs);
  console.log(r2 ? "✓ DOM 稳定（无每秒重建）" : "✗ DOM 仍被重建");
  main.close(); c.close();
  process.exit(r2 ? 0 : 1);
})().catch(e => { console.log("err", String(e)); process.exit(1); });
