// 控制台面板链路测试：shell-job 事件 / list_running_shells / get_shell_detail / cancel_shell
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
      if (em) events.push({ t: Date.now(), event: em[1], p: em[2] });
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  function send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }); }
  const invoke = async (cmd, args = {}) => {
    const r = await send("Runtime.evaluate", { expression: `window.__TAURI_INTERNALS__.invoke('${cmd}', ${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  await send("Runtime.enable");
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`); cond ? pass++ : fail++; };

  // ── 场景 1：后台命令（sleep 3 → 转后台） ──
  console.log("\n========== 场景1: 后台命令自动转后台 ==========");
  const before1 = events.length;
  const sess1 = await invoke("create_session", { title: "控制台-BG" });
  const chat1 = await invoke("chat_stream", { sessionId: sess1?.id, message: "E2E-CMD-BG", eventName: "bg-" + Date.now(), images: null });
  // chat_stream 会用当前活跃会话？需要 session id —— create_session 返回值检查
  // chat RPC 返回 = 第一轮结束（shell 已转后台，回执 "still running"）；job 剩余 ~1s，立即查
  console.log("  chat RPC:", JSON.stringify(chat1)?.slice(0, 120));
  const started = events.filter(e => e.event === "shell-job" && e.p.includes('"phase":"started"'));
  ok("shell-job started 事件", started.length > 0, started[0]?.p?.slice(0, 150));
  let jobId = null;
  try { jobId = JSON.parse(started[started.length - 1]?.p)?.job_id; } catch {}
  ok("job_id 可解析", !!jobId, jobId || "");

  const list = await invoke("list_running_shells");
  const inList = Array.isArray(list) && list.some(j => j.job_id === jobId);
  ok("list_running_shells 含该 job", inList, JSON.stringify(list)?.slice(0, 160));

  const detail = await invoke("get_shell_detail", { jobId });
  ok("get_shell_detail 可查", !!detail && !!detail.job_id, JSON.stringify(detail)?.slice(0, 160));

  // 等 done（job 后台阶段 ~1.4s）
  const deadline = Date.now() + 20000;
  let doneEv = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 800));
    doneEv = events.find(e => e.event === "shell-job" && e.p.includes('"phase":"done"') && e.p.includes(jobId));
    if (doneEv) break;
  }
  ok("shell-job done 事件", !!doneEv, doneEv?.p?.slice(0, 150));
  const listAfter = await invoke("list_running_shells");
  ok("完成后 list 为空", Array.isArray(listAfter) && !listAfter.some(j => j.job_id === jobId), JSON.stringify(listAfter)?.slice(0, 100));

  // 回灌：AI 反馈轮 final 应含 bg-done-ok
  const finalOk = events.slice(before1).some(e => e.p.includes('"type":"final"') && e.p.includes("bg-done-ok"));
  ok("回灌后 final 含 bg-done-ok", finalOk);
  const toolsEv = events.slice(before1).find(e => e.p.includes('"type":"tools"'));
  ok("tools 事件含后台回执", !!toolsEv && toolsEv.p.includes("bg"), toolsEv?.p?.slice(0, 130));

  // ── 场景 2：取消（sleep 10 → cancel） ──
  console.log("\n========== 场景2: cancel_shell 取消 ==========");
  const before2 = events.length;
  const sess2 = await invoke("create_session", { title: "控制台-CANCEL" });
  await invoke("chat_stream", { sessionId: sess2?.id, message: "E2E-CMD-CANCEL", eventName: "cx-" + Date.now(), images: null });
  await new Promise(r => setTimeout(r, 3500));
  const started2 = events.slice(before2).filter(e => e.event === "shell-job" && e.p.includes('"phase":"started"'));
  let jobId2 = null;
  try { jobId2 = JSON.parse(started2[started2.length - 1]?.p)?.job_id; } catch {}
  ok("第二个 job started", !!jobId2, jobId2 || "");

  if (jobId2) {
    const cancelRes = await invoke("cancel_shell", { jobId: jobId2 });
    ok("cancel_shell 调用成功", !!cancelRes?.cancelled, JSON.stringify(cancelRes));
    const deadline2 = Date.now() + 10000;
    let killedEv = null;
    while (Date.now() < deadline2) {
      await new Promise(r => setTimeout(r, 500));
      killedEv = events.slice(before2).find(e => e.event === "shell-job" && e.p.includes('"phase":"killed"') && e.p.includes(jobId2));
      if (killedEv) break;
    }
    ok("shell-job killed 事件", !!killedEv, killedEv?.p?.slice(0, 150));
    const list2 = await invoke("list_running_shells");
    ok("取消后 list 为空", Array.isArray(list2) && list2.length === 0, JSON.stringify(list2)?.slice(0, 100));
  }

  console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 ==========`);
  client.close(); process.exit(fail ? 2 : 0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
