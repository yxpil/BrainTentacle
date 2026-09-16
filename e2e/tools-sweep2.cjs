// 补测：sub_agent（子代理派生）+ view_image（图片注入下一轮）
const ws = require("ws");
const http = require("http");
const fs = require("fs");
(async () => {
  // 1x1 蓝色 PNG（工作区根，view_image 沙箱内）
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync("c:\\Users\\yxpil\\Desktop\\杂项\\BIT0603\\bit\\.e2e-view.png", png);

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
  const invoke = async (cmd, args = {}) => {
    const r = await send("Runtime.evaluate", { expression: `window.__TAURI_INTERNALS__.invoke('${cmd}', ${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  await send("Runtime.enable");
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + detail}`); cond ? pass++ : fail++; };

  // ── sub_agent ──
  console.log("\n========== sub_agent 子代理 ==========");
  const before = events.length;
  const sess = await invoke("create_session", { title: "扫描-sub_agent" });
  const calls = [{ tool: "sub_agent", params: { task: "E2E 子任务：请直接回复 subagent-done", title: "E2E 子代理" } }];
  await invoke("chat_stream", { sessionId: sess?.id, message: "E2E-TOOLRUN:" + Buffer.from(JSON.stringify(calls)).toString("base64"), eventName: "sa-" + Date.now(), images: null });
  await new Promise(r => setTimeout(r, 6000)); // 子代理完整跑一轮
  const toolsE = events.slice(before).filter(e => e.p.includes('"type":"tools"'));
  const subCall = toolsE.flatMap(e => { try { return JSON.parse(e.p).calls || []; } catch { return []; } }).find(c => c.tool === "sub_agent");
  ok("sub_agent 执行成功", !!subCall?.ok, JSON.stringify(subCall)?.slice(0, 150));
  ok("返回子会话 id", !!subCall?.result?.session_id || JSON.stringify(subCall?.result || {}).includes("session"), JSON.stringify(subCall?.result)?.slice(0, 150));
  const subEv = events.slice(before).find(e => e.p.includes('"type":"subagent"') || e.p.includes("subagent"));
  ok("subagent 事件广播", !!subEv, subEv?.p?.slice(0, 120));

  // ── view_image ──
  console.log("\n========== view_image 图片注入 ==========");
  const before2 = events.length;
  const sess2 = await invoke("create_session", { title: "扫描-view_image" });
  // mock: 看到 E2E-CMD-VIEWIMG → 调 view_image；反馈轮请求带图（imgs>0）→ 回 IMAGE-SEEN
  const r2 = await invoke("chat_stream", { sessionId: sess2?.id, message: "E2E-CMD-VIEWIMG", eventName: "vi-" + Date.now(), images: null });
  await new Promise(r => setTimeout(r, 4000));
  const viCall = events.slice(before2).filter(e => e.p.includes('"type":"tools"'))
    .flatMap(e => { try { return JSON.parse(e.p).calls || []; } catch { return []; } }).find(c => c.tool === "view_image");
  ok("view_image 执行成功", !!viCall?.ok, JSON.stringify(viCall)?.slice(0, 150));
  const finalHasImg = JSON.stringify(r2 || {}).includes("IMAGE-SEEN");
  ok("下一轮请求注入图片(mock 确认 IMAGE-SEEN)", finalHasImg, JSON.stringify(r2)?.slice(0, 150));

  console.log(`\n========== 补测: ${pass} 通过 / ${fail} 失败 ==========`);
  client.close(); process.exit(fail ? 2 : 0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
