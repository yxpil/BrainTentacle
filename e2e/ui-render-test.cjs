// 前端 UI 渲染验证：输入框发消息（真实 React 受控路径）→ DOM 断言卡片/气泡/usage 渲染
const ws = require("ws");
const http = require("http");
(async () => {
  const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
  const page = targets.find(t => t.type === "page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const consoleEvts = [];
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", d => { const m = JSON.parse(d);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map(a => a.value !== undefined ? (typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)) : (a.description || "")).join(" | ");
      consoleEvts.push(text);
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  function send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }); }
  const evl = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  await send("Runtime.enable");
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + detail}`); cond ? pass++ : fail++; };

  // ── 前置检查：ChatPage 输入框可用（有活跃会话） ──
  console.log("========== 前置检查 ==========");
  const taReady = await evl(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return { found: false };
    return { found: true, disabled: ta.disabled, placeholder: ta.placeholder };
  })()`);
  ok("ChatPage 输入框存在", taReady?.found, JSON.stringify(taReady));
  ok("有活跃会话（可输入）", taReady?.found && !taReady?.disabled, JSON.stringify(taReady));
  if (!taReady?.found || taReady?.disabled) { console.log("无活跃会话，跳过"); client.close(); process.exit(2); }

  // ── 注入消息并发送（React 18 valueTracker 重置 + 精确定位发送按钮） ──
  console.log("\n========== UI 发送 E2E-CMD-SHELL ==========");
  const injected = await evl(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    // React 用 value tracker 判断 value 是否变化：必须先清空 tracker 再赋值，否则 onChange 不触发
    if (ta._valueTracker) ta._valueTracker.setValue('');
    setter.call(ta, 'E2E-CMD-SHELL');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 发送按钮：textarea 所在输入区容器内的 accent-solid 按钮
    const zone = ta.closest('div.relative.rounded-2xl')?.parentElement || ta.parentElement;
    const btn = [...(zone || document).querySelectorAll('button')].find(b => b.className.includes('accent-solid'));
    return { value: ta.value, btnFound: !!btn, btnDisabled: btn?.disabled };
  })()`);
  ok("textarea 注入成功", injected?.value === "E2E-CMD-SHELL", JSON.stringify(injected));
  ok("发送按钮在输入区内且可用", injected?.btnFound && !injected?.btnDisabled, JSON.stringify(injected));

  const sent = await evl(`(() => {
    const ta = document.querySelector('textarea');
    const zone = ta.closest('div.relative.rounded-2xl')?.parentElement || ta.parentElement;
    const btn = [...(zone || document).querySelectorAll('button')].find(b => b.className.includes('accent-solid'));
    if (!btn || btn.disabled) return { ok: false };
    btn.click();
    // 验证发送生效：input state 清空 + 用户气泡立即入列
    return new Promise(res => setTimeout(() => {
      const t = document.body.innerText;
      res({ ok: true, inputCleared: ta.value === "", bubbleNow: t.includes('E2E-CMD-SHELL'), taDisabled: ta.disabled });
    }, 800));
  })()`);
  ok("点击发送且输入框清空", sent?.ok && sent?.inputCleared, JSON.stringify(sent));
  ok("用户气泡立即入列", !!sent?.bubbleNow, JSON.stringify(sent));

  // ── 轮询 DOM 断言渲染产物 ──
  console.log("\n========== DOM 渲染断言（轮询 30s） ==========");
  const deadline = Date.now() + 30000;
  let dom = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    dom = await evl(`(() => {
      const t = document.body.innerText;
      return {
        userBubble: t.includes('E2E-CMD-SHELL'),
        toolCard: t.includes('echo e2e-shell-ok') || (t.includes('shell') && t.includes('e2e-shell-ok')),
        finalMsg: t.includes('E2E-FINAL-OK'),
        // 工具卡片特征：ToolCallCard 渲染 ok/exit code 字样
        cardDetail: t.includes('exit') || t.includes('stdout') || t.includes('成功') || t.includes('✓'),
      };
    })()`);
    if (dom?.finalMsg) break; // 流结束
  }
  console.log("  DOM 快照:", JSON.stringify(dom));
  ok("用户消息气泡渲染", !!dom?.userBubble);
  ok("工具执行卡片渲染（含命令/结果）", !!dom?.toolCard);
  ok("回灌 final 消息渲染", !!dom?.finalMsg);

  // 事件级证据（React callback 收到）
  const recvDelta = consoleEvts.some(t => t.includes('"type":"delta"'));
  const recvTools = consoleEvts.some(t => t.includes('"type":"tools"'));
  const recvFinal = consoleEvts.some(t => t.includes('"type":"final"'));
  const unhandled = consoleEvts.filter(t => t.includes("[BIT][chat] 未处理事件类型"));
  console.log(`\\n  React callback 证据: delta=${recvDelta} tools=${recvTools} final=${recvFinal} 未处理类型=${unhandled.length}`);
  ok("React 收到 delta 事件", recvDelta);
  ok("React 收到 tools 事件", recvTools);
  ok("React 收到 final 事件", recvFinal);
  ok("无未处理事件类型", unhandled.length === 0, unhandled[0]?.slice(0, 150));

  console.log(`\\n========== UI 渲染验证: ${pass} 通过 / ${fail} 失败 ==========`);
  client.close(); process.exit(fail ? 2 : 0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
