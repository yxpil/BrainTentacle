// stdout 恢复验证：E2E-CMD-SHELL 工具执行后 stdout 应含 e2e-shell-ok
const ws = require("ws");
const http = require("http");
(async () => {
  const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
  const page = targets.find(t => t.type === "page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const events = [];
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", d => { const m = JSON.parse(d);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map(a => a.value !== undefined ? (typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)) : (a.description || "")).join(" | ");
      const em = text.match(/\[BIT\]\[event\] ← (\S+) \| (.*)/s);
      if (em) events.push({ event: em[1], p: em[2] });
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  function send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }); }
  await send("Runtime.enable");
  const before = events.length;
  const r = await send("Runtime.evaluate", { expression: `(async () => {
    const sess = await window.__TAURI_INTERNALS__.invoke('create_session', { title: 'stdout验证' });
    const rr = await window.__TAURI_INTERNALS__.invoke('chat_stream', { sessionId: sess.id, message: 'E2E-CMD-SHELL', eventName: 'so-' + Date.now(), images: null });
    return JSON.stringify({ last: rr?.messages?.[rr.messages.length - 1]?.content });
  })()`, returnByValue: true, awaitPromise: true });
  console.log("RPC:", r?.result?.value);
  await new Promise(r2 => setTimeout(r2, 12000));
  const tool = events.slice(before).find(e => e.p.includes('"type":"tools"'));
  if (tool) {
    const p = JSON.parse(tool.p);
    const c = p.calls[0];
    console.log("工具执行:", c.tool, "ok:", c.ok, "code:", c.result.code, "stdout:", JSON.stringify(c.result.stdout));
    console.log(c.ok && String(c.result.stdout).includes("e2e-shell-ok") ? "✓ stdout 恢复正常" : "✗ stdout 仍有问题");
  } else console.log("✗ 无 tools 事件");
  client.close(); process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
