// 量化 UI 渲染滞后：200-chunk 流式期间 DOM 文本增长 vs 事件到达
const ws = require("ws");
const http = require("http");
(async () => {
  const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
  const page = targets.find(t => t.type === "page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const timeline = []; // { t, domChunks, evtChunks }
  const evtTimes = []; // 每次 delta 事件到达时间
  let evtChunkCount = 0;
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", d => { const m = JSON.parse(d);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map(a => a.value !== undefined ? (typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)) : (a.description || "")).join(" | ");
      if (text.includes('"type":"delta"')) { evtChunkCount++; evtTimes.push(Date.now()); }
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  function send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }); }
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");

  // 等会话空闲
  let idle = false;
  for (let i = 0; i < 100; i++) {
    const busy = await evl(`(() => { const ta=document.querySelector('textarea'); if(!ta) return {busy:true}; const zone=ta.closest('div.relative.rounded-2xl')?.parentElement||ta.parentElement; return {busy:[...(zone||document).querySelectorAll('button')].some(b=>b.title&&(b.title.includes('停止')||b.title.includes('Stop')))}; })()`);
    if (!busy?.busy) { idle = true; break; }
    await new Promise(r => setTimeout(r, 800));
  }
  if (!idle) { console.log("会话不空闲"); client.close(); process.exit(2); }

  // UI 发送 200-chunk 流式场景
  const t0 = Date.now();
  await evl(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    if (ta._valueTracker) ta._valueTracker.setValue('');
    setter.call(ta, 'E2E-STREAM-MANY');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const zone = ta.closest('div.relative.rounded-2xl')?.parentElement || ta.parentElement;
    const btn = [...(zone || document).querySelectorAll('button')].find(b => b.className.includes('accent-solid'));
    btn?.click();
  })()`);

  // DOM 轮询 50ms：统计 live 文本里的 chunk 标记数
  const countChunks = `(() => {
    const t = document.body.innerText;
    let n = 0;
    for (let i = 0; i < 200; i++) { if (t.includes('c' + i + ';')) n++; }
    return { domChunks: n, hasFinal: t.includes('STREAM-MANY-DONE') };
  })()`;
  const deadline = Date.now() + 60000;
  let lastDom = -1, domDoneAt = null, firstChunkAt = null;
  while (Date.now() < deadline) {
    const st = await evl(countChunks);
    const now = Date.now();
    timeline.push({ t: now - t0, ...st });
    if (st.domChunks > 0 && firstChunkAt === null) firstChunkAt = now - t0;
    if (st.domChunks === 200 && domDoneAt === null) domDoneAt = now - t0;
    if (st.hasFinal) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const lastEvtAt = evtTimes.length ? evtTimes[evtTimes.length - 1] - t0 : null;
  const firstEvtAt = evtTimes.length ? evtTimes[0] - t0 : null;

  // 分析：事件到达率 vs DOM 增长率，尾部滞后
  console.log("=== 事件到达（preload） ===");
  console.log(`首个 delta 到达: ${firstEvtAt}ms, 最后 delta 到达: ${lastEvtAt}ms, 共 ${evtTimes.length} 个`);
  console.log("=== DOM 渲染 ===");
  console.log(`DOM 首见 chunk: ${firstChunkAt}ms, DOM 全部 200 chunks: ${domDoneAt}ms`);
  if (lastEvtAt !== null && domDoneAt !== null) {
    const lag = domDoneAt - lastEvtAt;
    console.log(`尾部滞后（DOM 追平 - 最后事件到达）: ${lag}ms ${lag > 500 ? "⚠ 滞后明显" : "✓ 及时"}`);
  }
  // 中段滞后采样：找出 DOM 增长明显停顿的区间
  let stalls = [];
  for (let i = 1; i < timeline.length; i++) {
    const gap = timeline[i].t - timeline[i - 1].t;
    if (gap >= 300 && timeline[i].domChunks === timeline[i - 1].domChunks && timeline[i - 1].domChunks < 200)
      stalls.push(`${timeline[i - 1].t}ms→${timeline[i].t}ms 停在 chunk ${timeline[i].domChunks}`);
  }
  console.log(`\n中段停顿（≥300ms 无 DOM 增长且未完成）: ${stalls.length} 处`);
  for (const s of stalls.slice(0, 10)) console.log("  ", s);
  // 采样点分布
  const pts = [0.25, 0.5, 0.75].map(p => timeline[Math.floor(timeline.length * p)]).filter(Boolean);
  console.log("\n采样点:", pts.map(p => `${p.t}ms: ${p.domChunks}/200`).join("  "));
  client.close(); process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
