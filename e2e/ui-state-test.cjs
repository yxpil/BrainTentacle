// 三项前端实时状态 UI 验证：后台任务面板 / 子代理委派 / 计划栏
// 全部走真实 React 输入路径 → DOM 断言
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
  const evl = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  await send("Runtime.enable");
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + detail}`); cond ? pass++ : fail++; };

  // UI 发送（React valueTracker 重置 + 输入区内发送按钮）
  // 前置等会话空闲：busy 时输入区内渲染红色停止按钮（L2144-2151），空闲时不渲染。
  // 注意不能用"发送按钮 enabled"判断——空闲时 input 为空，发送按钮本来就 disabled
  const uiSend = async (text) => {
    const idleDl = Date.now() + 90000;
    let idle = false;
    while (Date.now() < idleDl) {
      const busy = await evl(`(() => {
        const ta = document.querySelector('textarea');
        if (!ta) return { busy: true, why: 'no-textarea' };
        const zone = ta.closest('div.relative.rounded-2xl')?.parentElement || ta.parentElement;
        const stop = [...(zone || document).querySelectorAll('button')].find(b => b.title && (b.title.includes('停止') || b.title.includes('Stop')));
        return { busy: !!stop, why: stop ? 'stop-btn' : '' };
      })()`);
      if (!busy?.busy) { idle = true; break; }
      await new Promise(r2 => setTimeout(r2, 800));
    }
    if (!idle) return { ok: false, why: "会话 90s 未空闲（停止按钮仍在）" };
    const r = await evl(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      if (ta._valueTracker) ta._valueTracker.setValue('');
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const zone = ta.closest('div.relative.rounded-2xl')?.parentElement || ta.parentElement;
      const btn = [...(zone || document).querySelectorAll('button')].find(b => b.className.includes('accent-solid'));
      if (!btn || btn.disabled) return { ok: false, why: '发送按钮不可用（注入后仍空？）' };
      btn.click();
      return { ok: true };
    })()`);
    await new Promise(r2 => setTimeout(r2, 600));
    return r;
  };
  const bodyText = () => evl(`document.body.innerText`);
  const badge = () => evl(`(() => { const b = document.querySelector('span.bg-sky-500'); return b ? b.textContent : null; })()`);

  // ── 场景 A：后台任务面板 ──
  console.log("\n========== A. 后台任务状态（sleep 3 转后台） ==========");
  const a = await uiSend("E2E-CMD-BG");
  ok("UI 发送成功", !!a?.ok, JSON.stringify(a));
  // 等 3s 前台窗口 + 转后台 → 角标出现（角标窗口 ~1.5s：job 后台阶段 sleep 3 - 2s 前台 ≈ 1.4s，密集轮询）
  let badgeSeen = null;
  const dl1 = Date.now() + 10000;
  while (Date.now() < dl1) {
    await new Promise(r => setTimeout(r, 300));
    badgeSeen = await badge();
    if (badgeSeen) break;
  }
  ok("运行中角标出现（bg-sky-500）", !!badgeSeen, `badge=${JSON.stringify(badgeSeen)}`);
  // done 后角标消失（job 后台阶段 ~1.5s + 回灌轮）
  let badgeGone = false;
  const dl2 = Date.now() + 15000;
  while (Date.now() < dl2) {
    await new Promise(r => setTimeout(r, 1000));
    if (!(await badge())) { badgeGone = true; break; }
  }
  ok("完成后角标消失", badgeGone);
  const tA = await bodyText();
  ok("回灌 final 渲染（E2E-FINAL-OK）", tA.includes("E2E-FINAL-OK"));

  // ── 场景 B：子代理委派 ──
  console.log("\n========== B. 子代理自动委派 ==========");
  const bTitle = "UI子代理验证" + Date.now(); // 唯一化：避免侧栏旧会话标题造成假阳性
  const bCalls = [{ tool: "sub_agent", params: { task: "E2E 子任务：直接回复 done", title: bTitle } }];
  const b = await uiSend("E2E-TOOLRUN:" + Buffer.from(JSON.stringify(bCalls)).toString("base64"));
  ok("UI 发送成功", !!b?.ok, JSON.stringify(b));
  // 状态条常显（subList.length > 0）：注意「标题出现≥2次」才算状态条渲染
  // （侧栏子会话名也含该标题，indexOf 命中的是侧栏；状态条 27ms 内即 done 态、8s 后自动移除）
  let subSeen = false, subDone = false;
  const dl3 = Date.now() + 20000;
  while (Date.now() < dl3 && !subDone) {
    await new Promise(r => setTimeout(r, 700));
    const t = await bodyText();
    const occurrences = (t.match(new RegExp(bTitle, "g")) || []).length;
    if (occurrences >= 2) {
      subSeen = true;
      // 状态条 done 态渲染文案「子代理完成 · Ns」（✓ 只在 popover 列表）；spawn→done 仅 ~30ms，直接终态
      if (t.includes("子代理完成") || t.includes("Sub-agent done")) subDone = true;
    }
  }
  ok(`子代理状态条渲染（标题≥2次：侧栏+状态条）`, subSeen);
  ok("子代理完成态（子代理完成 · Ns）", subDone);

  // ── 场景 C：计划栏 ──
  console.log("\n========== C. 计划栏（goal + todos） ==========");
  const gName = "UI计划验证" + Date.now();
  const cCalls = [{ tool: "plan", params: { goal: gName, steps: ["设计", "实现", "验收"] } }];
  const c = await uiSend("E2E-TOOLRUN:" + Buffer.from(JSON.stringify(cCalls)).toString("base64"));
  ok("UI 发送成功", !!c?.ok, JSON.stringify(c));
  // 计划栏 3s 轮询 listGoals → 轮询等 goal 文本出现
  let planSeen = false;
  const dl5 = Date.now() + 15000;
  while (Date.now() < dl5) {
    await new Promise(r => setTimeout(r, 1500));
    const t = await bodyText();
    if (t.includes(gName)) { planSeen = true; break; }
  }
  ok(`计划栏渲染新 goal（含「${gName}」）`, planSeen);

  console.log(`\n========== 三项 UI 状态: ${pass} 通过 / ${fail} 失败 ==========`);
  client.close(); process.exit(fail ? 2 : 0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
