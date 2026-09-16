// 任务面板验证：制造运行中任务 → 打开面板 → 检查 DOM 渲染与主题联动
const ws = require("ws");
const http = require("http");
const fs = require("fs");
const OUT = "e2e/panel-result.txt";
const log = (...a) => { fs.appendFileSync(OUT, a.join(" ") + "\n"); };
try { fs.unlinkSync(OUT); } catch {}
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const connect = async (url) => {
  const client = new ws(url);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  return {
    client,
    send: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }),
    evl: async (expression) => { const r = await (await { async get() { return this; } }).send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then?.(() => {}) ?? null; },
    close: () => client.close(),
  };
};
(async () => {
  setTimeout(() => { log("TIMEOUT 45s"); process.exit(3); }, 45000);
  // 连主窗口
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  if (!page) { log("主窗口未找到: " + JSON.stringify(targets.map(t => [t.type, t.title]))); process.exit(2); }
  log("主窗口: " + page.title);
  const main = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { main.on("open", r); main.on("error", j); });
  main.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); main.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");

  // 1. 制造状态：慢流式会话（回合 ~7.5s 运行中）+ 12s 长后台命令（job ~12s 运行中）。
  //    不 await promise（等回合结束才 resolve）。两个回合用不同事件名——
  //    trayState.chats 以事件名为键，同名会互相覆盖/提前清除。
  const sessA = await evl(`window.__TAURI_INTERNALS__.invoke('create_session', { title: '面板验证-慢流' })`);
  const sessB = await evl(`window.__TAURI_INTERNALS__.invoke('create_session', { title: '面板验证-后台命令' })`);
  evl(`window.__TAURI_INTERNALS__.invoke('chat_stream', { sessionId: ${JSON.stringify(sessA?.id)}, message: 'E2E-STREAM-SLOW', eventName: 'chat-stream-e2e1', images: null })`).catch(() => {});
  evl(`window.__TAURI_INTERNALS__.invoke('chat_stream', { sessionId: ${JSON.stringify(sessB?.id)}, message: 'E2E-CMD-BG-LONG', eventName: 'chat-stream-e2e2', images: null })`).catch(() => {});
  await new Promise(r => setTimeout(r, 2400)); // 2s 转后台后、job ~12s 结束前 → 此时面板应有 2 会话 + 1 后台命令

  // 2. 打开任务面板
  await evl(`window.__TAURI_INTERNALS__.invoke('plugin:window|open-status', {})`);
  await new Promise(r => setTimeout(r, 2000));

  // 3. 连面板查 DOM
  const targets2 = await getTargets();
  const panel = targets2.find(t => t.title && t.title.includes("任务面板"));
  if (!panel) { log("✗ 任务面板窗口未创建"); main.close(); process.exit(2); }
  const p = new ws(panel.webSocketDebuggerUrl);
  let pid = 0; const ppending = new Map();
  await new Promise((r, j) => { p.on("open", r); p.on("error", j); });
  p.on("message", d => { const m = JSON.parse(d); if (m.id && ppending.has(m.id)) { const [res, rej] = ppending.get(m.id); ppending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  const psend = (method, params = {}) => new Promise((res, rej) => { const n = ++pid; ppending.set(n, [res, rej]); p.send(JSON.stringify({ id: n, method, params })); });
  const pevl = async (expression) => { const r = await psend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await psend("Runtime.enable");

  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => { log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + detail}`); cond ? pass++ : fail++; };

  const st1 = await pevl(`(() => {
    const t = document.body.innerText;
    return JSON.stringify({
      running: t.includes("任务进行中"),
      chatItem: t.includes("运行中会话") && /会话回合|会话 \\S+/.test(t),
      jobItem: t.includes("后台命令") && /sleep 12/.test(t),
      secs: /\\d+s/.test(t),
      theme: document.body.className,
      darkVars: getComputedStyle(document.body).getPropertyValue("--bg").trim(),
    });
  })()`);
  log("运行中快照:", st1);
  const s1 = JSON.parse(st1);
  ok("总览显示「任务进行中」", s1.running);
  ok("运行中会话条目渲染（含耗时）", s1.chatItem && s1.secs);
  ok("后台命令条目渲染（含命令文本）", s1.jobItem);

  // 4. 等任务结束后查清零
  await new Promise(r => setTimeout(r, 12000));
  const st2 = await pevl(`(() => {
    const t = document.body.innerText;
    return JSON.stringify({ idle: t.includes("空闲"), noChat: t.includes("没有运行中的会话回合") });
  })()`);
  log("结束后快照:", st2);
  const s2 = JSON.parse(st2);
  ok("任务结束后显示「空闲」", s2.idle && s2.noChat);

  log(`\n========== 任务面板: ${pass} 通过 / ${fail} 失败 ==========`);
  main.close(); p.close(); process.exit(fail ? 2 : 0);
})().catch(e => { log("FATAL: type=" + typeof e + " name=" + (e?.constructor?.name) + " json=" + JSON.stringify(e) + " str=" + String(e)); process.exit(1); });

