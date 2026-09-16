// SSE 压测：事件流完整性 + 及时性（mock 上游逐场景驱动）
const ws = require("ws");
const http = require("http");

const SCENARIOS = [
  { mark: "E2E-STREAM-MANY", label: "200-chunk连发", expectDeltas: 200 },
  { mark: "E2E-CMD-SHELL", label: "工具调用链", expectTools: true },
  { mark: "E2E-STREAM-MULTIBYTE", label: "多字节跨chunk" },
  { mark: "E2E-STREAM-THINK", label: "思考流reasoning" },
];

async function run() {
  const targets = await new Promise((res, rej) => {
    http.get("http://127.0.0.1:9222/json", (r) => {
      let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(JSON.parse(b)));
    }).on("error", rej);
  });
  const page = targets.find((t) => t.type === "page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const events = []; // 全局事件 { t, event, payloadStr }

  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", (data) => {
    const m = JSON.parse(data);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map((a) => {
        if (a.value !== undefined) return typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value);
        return a.description || "";
      }).join(" | ");
      const em = text.match(/\[BIT\]\[event\] ← (\S+) \| (.*)/s);
      if (em) events.push({ t: Date.now(), event: em[1], payloadStr: em[2] });
    }
    if (m.id && pending.has(m.id)) {
      const [res, rej] = pending.get(m.id); pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message)); else res(m.result);
    }
  });
  function send(method, params = {}) {
    return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); });
  }
  await send("Runtime.enable");

  for (const sc of SCENARIOS) {
    console.log(`\n========== ${sc.label} (${sc.mark}) ==========`);
    const before = events.length;
    const r = await send("Runtime.evaluate", {
      expression: `(async () => {
        const sess = await window.__TAURI_INTERNALS__.invoke('create_session', { title: 'SSE-${sc.label}' });
        const sid = sess?.id;
        if (!sid) return JSON.stringify({ error: 'no sid' });
        const rr = await window.__TAURI_INTERNALS__.invoke('chat_stream', {
          sessionId: sid, message: '${sc.mark}', eventName: 'sse-' + Date.now(), images: null });
        return JSON.stringify({ sid, last: rr?.messages?.[rr.messages.length-1]?.content?.slice(0,60) });
      })()`,
      returnByValue: true, awaitPromise: true,
    });
    console.log("  RPC:", r?.result?.value);
    await new Promise((r2) => setTimeout(r2, 12000)); // RPC 返回后等 12s 收尾事件

    const chatEvs = events.slice(before).filter((e) => e.event.startsWith("sse-") || e.event === "tools-updated" || e.event === "notify-done");

    const deltas = chatEvs.filter((e) => e.payloadStr.includes('"type":"delta"'));
    const toolEvs = chatEvs.filter((e) => e.payloadStr.includes('"type":"tools"') || e.payloadStr.includes('"type":"round_tools_starting"'));
    const usage = chatEvs.filter((e) => e.payloadStr.includes('"type":"usage"'));
    const final = chatEvs.filter((e) => e.payloadStr.includes('"type":"final"'));
    const think = chatEvs.filter((e) => e.payloadStr.includes('"type":"think"'));
    const done = chatEvs.filter((e) => e.event === "notify-done");

    console.log(`  事件总数: ${chatEvs.length}  delta: ${deltas.length}  tools类: ${toolEvs.length}  usage: ${usage.length}  final: ${final.length}  think: ${think.length}  done: ${done.length}`);

    if (deltas.length > 2) {
      const ts = deltas.map((e) => e.t);
      const span = ts[ts.length - 1] - ts[0];
      const gaps = [];
      for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
      gaps.sort((a, b) => a - b);
      console.log(`  delta 时间: 跨度 ${span}ms  p50 ${gaps[Math.floor(gaps.length*0.5)]}ms  p95 ${gaps[Math.floor(gaps.length*0.95)]}ms  max ${gaps[gaps.length-1]}ms`);
    }

    if (sc.expectDeltas) {
      let full = "";
      for (const e of deltas) {
        try { const p = JSON.parse(e.payloadStr); full += p.text || ""; } catch {}
      }
      const okN = deltas.length >= sc.expectDeltas;
      const tailOk = full.includes("c199;") && full.includes("c0;");
      console.log(`  delta计数: ${deltas.length}/${sc.expectDeltas} ${okN ? "✓" : "✗丢" + (sc.expectDeltas - deltas.length)}`);
      console.log(`  内容: head=${JSON.stringify(full.slice(0, 12))} tail=${JSON.stringify(full.slice(-12))} ${tailOk ? "✓" : "✗"}`);
      if (!tailOk) console.log(`  ⚠ 前200: ${JSON.stringify(full.slice(0,200))} 后200: ${JSON.stringify(full.slice(-200))}`);
    }

    if (sc.expectTools) {
      console.log(`  工具事件: ${toolEvs.length ? "✓" : "✗ 无 tools/round_tools_starting"}`);
      for (const e of toolEvs) console.log(`    ${e.payloadStr.slice(0, 160)}`);
    }

    console.log(`  事件样本(前8):`);
    for (const e of chatEvs.slice(0, 8)) console.log(`    [${e.event.slice(0,22)}] ${e.payloadStr.slice(0,130)}`);
    if (chatEvs.length > 8) console.log(`    …共 ${chatEvs.length}`);
  }

  client.close();
  console.log("\n========== 测试结束 ==========");
  process.exit(0);
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
