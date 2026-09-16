// 探查面板 goals 区渲染与主进程 trayState.goals
const http = require("http");
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
(async () => {
  const targets = await getTargets();
  console.log("targets:", targets.map(t => t.title).join(","));
  const panel = targets.find(t => t.title && t.title.includes("任务面板"));
  if (!panel) { console.log("面板未开"); return; }
  const ws = require("ws");
  const p = new ws(panel.webSocketDebuggerUrl);
  await new Promise((r, j) => { p.on("open", r); p.on("error", j); });
  let id = 0; const pend = new Map();
  p.on("message", d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)[0](m.result); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pend.set(n, [res]); p.send(JSON.stringify({ id: n, method, params })); });
  await send("Runtime.enable");
  const r = await send("Runtime.evaluate", { expression: `JSON.stringify({
    goalsSection: document.getElementById('goals') ? document.getElementById('goals').innerHTML.slice(0, 600) : '(no #goals)',
    bodyText: document.body.innerText.slice(0, 400)
  })`, returnByValue: true });
  console.log(r?.result?.value);
  p.close();
})();
