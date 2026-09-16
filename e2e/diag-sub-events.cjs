// 诊断：sub_agent 全事件日志抓取
const ws = require("ws");
const http = require("http");
(async () => {
  const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
  const page = targets.find(t => t.type === "page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const evts = [];
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", d => { const m = JSON.parse(d);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map(a => a.value !== undefined ? (typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)) : (a.description || "")).join(" | ");
      if (text.includes("[BIT]")) evts.push(text.slice(0, 200));
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  function send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }); }
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");
  const sess = await evl(`window.__TAURI_INTERNALS__.invoke('create_session', { title: '诊断-子代理事件' })`);
  await evl(`window.__TAURI_INTERNALS__.invoke('chat_stream', { sessionId: ${JSON.stringify(sess?.id)}, message: ${JSON.stringify("E2E-TOOLRUN:" + Buffer.from(JSON.stringify([{ tool: "sub_agent", params: { task: "直接回复 ok", title: "诊断子代理" } }])).toString("base64"))}, eventName: 'dg-' + Date.now(), images: null })`);
  await new Promise(r => setTimeout(r, 8000));
  const sub = evts.filter(t => t.includes("subagent") || t.includes("spawn") || t.includes("子代理"));
  console.log("subagent 相关事件:", sub.length);
  for (const s of sub) console.log("  ", s);
  console.log("\n全部事件类型统计:");
  const types = {};
  for (const e of evts) { const m = e.match(/event\] ← (\S+)/); if (m) types[m[1]] = (types[m[1]] || 0) + 1; }
  console.log(JSON.stringify(types, null, 1));
  client.close(); process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
