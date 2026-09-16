// 清场：停止跑动中的会话回合 + 放弃全部目标（防止 auto_drive 无限续跑占住会话）
const ws = require("ws");
const http = require("http");
(async () => {
  const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
  const page = targets.find(t => t.type === "page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  function send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }); }
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");

  // 1. 若在跑，点停止按钮（红色 IconStop）
  await evl(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const stop = btns.find(b => b.title && (b.title.includes('停止') || b.title.includes('Stop')));
    if (stop) { stop.click(); return 'clicked'; }
    return 'no-running';
  })()`);
  await new Promise(r => setTimeout(r, 2000));

  // 2. 放弃全部目标
  const goals = await evl(`window.__TAURI_INTERNALS__.invoke('list_goals')`);
  const list = goals?.goals || [];
  let n = 0;
  for (const g of list) {
    if (g.status !== "abandoned") {
      await evl(`window.__TAURI_INTERNALS__.invoke('update_goal_status', { id: ${JSON.stringify(g.id)}, status: 'abandoned' })`);
      n++;
    }
  }
  console.log(`清场完成：停止按钮 ${n >= 0 ? "已处理" : ""}，放弃目标 ${n}/${list.length}`);
  client.close(); process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
