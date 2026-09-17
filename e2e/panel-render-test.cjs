// 面板渲染验证（不依赖 AI）：注入合成快照 → 断言中文/英文渲染与条目内容
const ws = require("ws");
const http = require("http");
const fs = require("fs");
const OUT = "e2e/panel-render-result.txt";
const log = (...a) => { fs.appendFileSync(OUT, a.join(" ") + "\n"); };
try { fs.unlinkSync(OUT); } catch {}
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const connect = async (url) => {
  const c = new ws(url);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { c.on("open", r); c.on("error", j); });
  c.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  return {
    send: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); c.send(JSON.stringify({ id: n, method, params })); }),
    evl: async (expression) => { const r = await this?.send?.(); return null; },
    close: () => c.close(),
  };
};
(async () => {
  setTimeout(() => { log("TIMEOUT 30s"); process.exit(3); }, 30000);
  // 1. 主窗口 → 打开面板
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  if (!page) { log("主窗口未找到: " + JSON.stringify(targets.map(t => [t.type, t.title]))); process.exit(2); }
  const main = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { main.on("open", r); main.on("error", j); });
  main.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); main.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");
  await evl(`window.__TAURI_INTERNALS__.invoke('plugin:window|open-status', {})`);
  await new Promise(r => setTimeout(r, 1500));

  // 2. 连面板
  const targets2 = await getTargets();
  const panel = targets2.find(t => t.title && t.title.includes("任务面板"));
  if (!panel) { log("✗ 任务面板窗口未创建"); main.close(); process.exit(2); }
  const p = new ws(panel.webSocketDebuggerUrl);
  let pid = 0; const ppending = new Map();
  await new Promise((r, j) => { p.on("open", r); p.on("error", j); });
  p.on("message", d => { const m = JSON.parse(d); if (m.id && ppending.has(m.id)) { const [res, rej] = ppending.get(m.id); ppending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  const psend = (method, params = {}) => new Promise((res, rej) => { const n = ++pid; ppending.set(n, [res, rej]); p.send(JSON.stringify({ id: n, method, params })); });
  const pevl = async (expression) => { const r = await psend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await psend("Runtime.enable");

  let pass = 0, fail = 0;
  const ok = (name, cond, detail = "") => { log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  " + detail}`); cond ? pass++ : fail++; };

  // 3. 注入合成快照（zh）
  await pevl(`(() => {
    snap = { chats: [{ label: '会话回合', since: Date.now() - 5000 }], jobs: [{ id: 'sh1', label: 'sleep 12', since: Date.now() - 3000 }], subs: [], goals: [{ id: 'g1', text: '测试计划', pending: 2 }], theme: 'light', look: { light: '#ffffff', dark: '#18181b' }, lang: 'zh', ts: Date.now() };
    lastSigs._ov = null; render();
    const t = document.body.innerText;
    return JSON.stringify({ running: t.includes("任务进行中"), chatItem: t.includes("会话回合"), jobItem: t.includes("sleep 12"), secs: /\\d+s/.test(t), show: document.getElementById('btn-show').textContent, goalItem: t.includes("测试计划") && t.includes("待办 2") });
  })()`).then(v => { const s = JSON.parse(v); ok("zh 总览「任务进行中」", s.running); ok("zh 会话条目+耗时", s.chatItem && s.secs); ok("zh 后台命令条目", s.jobItem); ok("zh 计划条目+待办数", s.goalItem); ok("zh 显示主界面按钮", s.show === "显示主界面"); });

  // 4. 切英文快照
  await pevl(`(() => {
    snap = { ...snap, lang: 'en' }; lastSigs._ov = null; render();
    const t = document.body.innerText;
    return JSON.stringify({ running: t.includes("task(s) running"), show: document.getElementById('btn-show').textContent, quit: document.getElementById('btn-quit').textContent, chats: t.includes("Running chats"), empty: t.includes("Idle") || t.includes("task(s) running"), secsEn: /\\d+s/.test(t) });
  })()`).then(v => { const s = JSON.parse(v); ok("en 总览「task(s) running」", s.running); ok("en 按钮双语", s.show === "Show main window" && s.quit === "Quit app"); ok("en 区块标题", s.chats); });

  // 5. 还原空快照（zh，真实链路会用真实数据覆盖）
  await pevl(`(() => { snap = { chats: [], jobs: [], subs: [], goals: [], theme: 'light', look: { light: '#ffffff', dark: '#18181b' }, lang: 'zh', ts: Date.now() }; lastSigs._ov = null; render(); return document.body.innerText.includes("空闲"); })()`).then(v => ok("还原空态「空闲」", v === true));

  log(`\n========== 面板渲染: ${pass} 通过 / ${fail} 失败 ==========`);
  main.close(); p.close(); process.exit(fail ? 2 : 0);
})().catch(e => { log("FATAL: " + String(e)); process.exit(1); });
