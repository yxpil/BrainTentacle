// 诊断子代理状态条实际渲染内容
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
  await send("Runtime.enable");
  const r = await send("Runtime.evaluate", { expression: `(() => {
    const t = document.body.innerText;
    const idx = t.indexOf('UI子代理验证');
    return JSON.stringify({ ctx: idx >= 0 ? t.slice(Math.max(0, idx - 60), idx + 200).replace(/\\n/g, '⏎') : '(未找到)', allCheck: (t.match(/✓/g) || []).length, allRun: (t.match(/⠋|思考中|运行中/g) || []).length });
  })()`, returnByValue: true });
  console.log(r.result.value);
  client.close(); process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
