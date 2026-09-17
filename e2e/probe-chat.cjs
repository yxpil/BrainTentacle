// 诊断：chat_stream 是否正常出事件（面板回归 1/4 的根因排查）
const ws = require("ws");
const http = require("http");
const fs = require("fs");
const OUT = "e2e/probe-chat.txt";
const log = (...a) => { fs.appendFileSync(OUT, a.join(" ") + "\n"); console.log(...a); };
try { fs.unlinkSync(OUT); } catch {}
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
(async () => {
  setTimeout(() => { log("TIMEOUT 60s"); process.exit(3); }, 60000);
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  if (!page) { log("主窗口未找到"); process.exit(2); }
  const main = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { main.on("open", r); main.on("error", j); });
  main.on("message", d => {
    const m = JSON.parse(d);
    if (m.method === "Runtime.consoleAPICalled") {
      const txt = (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" ");
      if (txt.includes("[BIT][event]")) log("EV:", txt.slice(0, 200));
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); main.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");

  const provs = await evl(`window.__TAURI_INTERNALS__.invoke('list_providers', {})`);
  const act = (provs?.providers || []).filter(p => p.active);
  log("ACTIVE:", JSON.stringify(act.map(p => ({ name: p.name, model: p.model, base_url: p.base_url, key_tail: p.api_key?.slice(-6) }))));

  const sess = await evl(`window.__TAURI_INTERNALS__.invoke('create_session', { title: '诊断-chat' })`);
  log("SESS:", JSON.stringify(sess));
  const p = evl(`window.__TAURI_INTERNALS__.invoke('chat_stream', { sessionId: ${JSON.stringify(sess?.id)}, message: 'E2E-STREAM-SLOW', eventName: 'chat-stream-probe', images: null })`);
  p.then(r => log("STREAM_DONE:", JSON.stringify(r)?.slice(0, 300))).catch(e => log("STREAM_ERR:", String(e)));
  await new Promise(r => setTimeout(r, 15000));
  log("DONE");
  main.close(); process.exit(0);
})().catch(e => { log("FATAL:", String(e)); process.exit(1); });
