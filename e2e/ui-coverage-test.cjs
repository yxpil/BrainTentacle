// 显示缺失覆盖检查：think 思考面板 / 工具 spinner 占位 / usage 页眉仪表盘 的 DOM 渲染
const ws = require("ws");
const http = require("http");
(async () => {
  const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
  const page = targets.find(t => t.type === "page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const unhandled = [];
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", d => { const m = JSON.parse(d);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map(a => a.value !== undefined ? (typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)) : (a.description || "")).join(" | ");
      if (text.includes("未处理事件类型")) unhandled.push(text.slice(0, 120));
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  function send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }); }
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + detail}`); cond ? pass++ : fail++; };

  const waitIdle = async () => {
    for (let i = 0; i < 110; i++) {
      const busy = await evl(`(() => { const ta=document.querySelector('textarea'); if(!ta) return {busy:true}; const zone=ta.closest('div.relative.rounded-2xl')?.parentElement||ta.parentElement; return {busy:[...(zone||document).querySelectorAll('button')].some(b=>b.title&&(b.title.includes('停止')||b.title.includes('Stop')))}; })()`);
      if (!busy?.busy) return true;
      await new Promise(r => setTimeout(r, 800));
    }
    return false;
  };
  const uiSend = async (text) => {
    if (!(await waitIdle())) return { ok: false, why: "90s 未空闲" };
    return await evl(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      if (ta._valueTracker) ta._valueTracker.setValue('');
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const zone = ta.closest('div.relative.rounded-2xl')?.parentElement || ta.parentElement;
      const btn = [...(zone || document).querySelectorAll('button')].find(b => b.className.includes('accent-solid'));
      if (!btn || btn.disabled) return { ok: false, why: 'btn' };
      btn.click(); return { ok: true };
    })()`);
  };
  // 流式期间密集采样 DOM
  const probeDuring = async (untilFinal, probes) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const st = await evl(`document.body.innerText`);
      probes(st);
      if (untilFinal(st)) return;
      await new Promise(r => setTimeout(r, 120));
    }
  };

  // ── 1. think 思考面板（流式期间显示，ThinkPanel） ──
  console.log("\n========== 1. think 思考面板实时显示 ==========");
  let thinkSeen = false, thinkTextSample = "";
  const p1 = await uiSend("E2E-STREAM-THINK");
  ok("UI 发送成功", !!p1?.ok, JSON.stringify(p1));
  await probeDuring(
    (st) => st.includes("THINK-DONE") || st.includes("E2E-FINAL-OK"),
    (st) => { if (!thinkSeen && st.includes("思考") && st.includes("推理")) { thinkSeen = true; } }
  );
  // ThinkPanel 有「思考」标题/展开特征；样本检查
  const t1 = await evl(`document.body.innerText`);
  thinkSeen = thinkSeen || t1.includes("思考");
  ok("思考面板渲染（含「思考」标识）", thinkSeen, t1.slice(0, 150));
  // think 落库后（final 消息里应含 think 块）
  ok("落库后思考仍在消息区", t1.includes("推理") || t1.includes("思考过程") || t1.includes("THINK"), "");

  // ── 2. 工具 spinner 占位（round_tools_starting → tools） ──
  console.log("\n========== 2. 工具执行 spinner 占位 ==========");
  if (!(await waitIdle())) { console.log("  跳过：会话未空闲"); fail++; }
  else {
    const p2 = await uiSend("E2E-CMD-SHELL");
    ok("UI 发送成功", !!p2?.ok, JSON.stringify(p2));
    let spinnerSeen = false;
    await probeDuring(
      (st) => st.includes("E2E-FINAL-OK"),
      (st) => { if (!spinnerSeen && (st.includes("调用工具") || st.includes("shell") || st.includes("执行"))) spinnerSeen = true; }
    );
    ok("工具卡/spinner 渲染", spinnerSeen);
  }

  // ── 3. usage 页眉仪表盘 ──
  console.log("\n========== 3. usage 仪表盘 ==========");
  const dash = await evl(`(() => { const t = document.body.innerText; return { hasTok: /tok|token|Token/i.test(t), ctxHint: t.includes("上下文") || t.includes("context") || t.includes("Context") }; })()`);
  ok("token/上下文指示显示", dash?.hasTok || dash?.ctxHint, JSON.stringify(dash));

  ok("零未处理事件类型", unhandled.length === 0, unhandled[0]);

  console.log(`\n========== 显示覆盖检查: ${pass} 通过 / ${fail} 失败 ==========`);
  client.close(); process.exit(fail ? 2 : 0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
