// 诊断：会话为什么 90s 不空闲
const ws = require("ws");
const http = require("http");
(async () => {
  const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
  const page = targets.find(t => t.type === "page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const recent = [];
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", d => { const m = JSON.parse(d);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map(a => a.value !== undefined ? (typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)) : (a.description || "")).join(" | ");
      recent.push({ t: Date.now(), text: text.slice(0, 150) });
      if (recent.length > 400) recent.shift();
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  function send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }); }
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");
  await new Promise(r => setTimeout(r, 5000)); // 观察 5 秒事件流
  const state = await evl(`(() => {
    const ta = document.querySelector('textarea');
    const zone = ta?.closest('div.relative.rounded-2xl')?.parentElement;
    const btns = [...(zone || document).querySelectorAll('button')];
    const accent = btns.find(b => b.className.includes('accent-solid'));
    const red = btns.find(b => b.className.includes('red-500'));
    const t = document.body.innerText;
    return JSON.stringify({
      hasAccentSend: !!accent, hasRedStop: !!red,
      busyText: t.includes('生成中') || t.includes('busy') || t.includes('思考'),
      queueHint: (t.match(/等待|队列/g) || []).length,
      last200: t.replace(/\\n/g, '|').slice(-200),
    });
  })()`);
  console.log("UI 状态:", state);
  console.log("\n最近 5 秒事件（每 500ms 汇总）:");
  const now = Date.now();
  const win = recent.filter(e => e.t > now - 5200);
  for (const e of win.slice(-20)) console.log(`  +${e.t - (now - 5200)}ms ${e.text}`);
  client.close(); process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
