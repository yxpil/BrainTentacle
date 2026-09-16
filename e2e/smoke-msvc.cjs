// 端到端冒烟：1) invoke 能跑 2) chat_stream 事件流
const ws = require("ws");
const http = require("http");

async function run() {
  const targets = await new Promise((res, rej) => {
    http.get("http://127.0.0.1:9222/json", (r) => {
      let b = ""; r.on("data", (d) => (b += d));
      r.on("end", () => res(JSON.parse(b)));
    }).on("error", rej);
  });
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0, pending = new Map();
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });

  const events = [];
  client.on("message", (data) => {
    const m = JSON.parse(data);
    if (m.method === "Runtime.consoleAPICalled") {
      const args = m.params.args || [];
      const text = args.map((a) => {
        if (a.value !== undefined) {
          if (typeof a.value === "object") { try { return JSON.stringify(a.value); } catch { return a.description || ""; } }
          return String(a.value);
        }
        return a.description || "";
      }).join(" | ");
      events.push({ level: m.params.type, text });
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); }
  });

  function send(method, params = {}) {
    return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); });
  }
  await send("Runtime.enable");

  // [1] invoke smoke
  console.log("[1] invoke smoke...");
  const tests = [
    ["get_overview", {}],
    ["list_tools", {}],
    ["list_sessions", {}],
    ["get_audit", { limit: 5 }],
  ];
  for (const [fn, args] of tests) {
    try {
      const r = await send("Runtime.evaluate", { expression: `window.__TAURI_INTERNALS__.invoke('${fn}', ${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
      const v = r?.result?.value;
      console.log(`  ✓ ${fn}: ${typeof v === "string" ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`);
    } catch (e) { console.log(`  ✗ ${fn}: ${e.message}`); }
  }

  // [2] chat_stream 事件链
  console.log("\n[2] chat_stream 事件链...");
  const chatEvts = await send("Runtime.evaluate", {
    expression: `(async () => {
      const sess = await window.__TAURI_INTERNALS__.invoke('create_session', { title: 'E2E-冒烟' });
      const sid = sess?.id;
      if (!sid) return JSON.stringify({ error: 'no sid' });
      const r = await window.__TAURI_INTERNALS__.invoke('chat_stream', {
        sessionId: sid,
        message: '你好，请只回复OK',
        eventName: 'smoke-' + Date.now(),
        images: null
      });
      return JSON.stringify({ session: sid, ok: true });
    })()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log("  RPC:", chatEvts?.result?.value);
  console.log("  等待 10s 让事件流到达...");
  await new Promise((r) => setTimeout(r, 10000));

  // 汇总
  const preload = events.filter((e) => e.text.includes("[BIT][event] ←") && !e.text.includes("smoke-"));
  const chatEvents = events.filter((e) => e.text.includes("[BIT][event] ← smoke-"));
  const warns = events.filter((e) => e.text.includes("[BIT][chat] 未处理"));

  console.log(`\n========== 事件汇总 ==========`);
  console.log(`  非 chat 事件: ${preload.length}`);
  console.log(`  chat 流事件:  ${chatEvents.length}`);
  console.log(`  ChatPage warn: ${warns.length}`);

  const byType = {};
  for (const e of chatEvents) {
    const m = e.text.match(/"type":"(\w+)"/);
    if (m) byType[m[1]] = (byType[m[1]] || 0) + 1;
  }
  console.log(`\n  payload.type 分布:`);
  for (const [t, c] of Object.entries(byType)) console.log(`    ${t.padEnd(20)} × ${c}`);
  console.log(`\n  完整 chat 事件:`);
  for (const e of chatEvents) console.log(`    ${e.text.slice(0, 200)}`);

  const ok = chatEvents.length >= 4 && !warns.length;
  console.log(`\n========== ${ok ? "✓ PASS" : "⚠ 有问题"} ==========`);
  client.close();
  process.exit(ok ? 0 : 2);
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
