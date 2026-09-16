// 清理测试遗留目标（ROW-DEL-PROBE / PROBE-ERR / SQLITE-PROBE 开头的测试目标）
const http = require("http");
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
(async () => {
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  const ws = require("ws");
  const main = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { main.on("open", r); main.on("error", j); });
  main.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)[0](m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, [res]); main.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  const out = await evl(`window.__TAURI_INTERNALS__.invoke('list_goals').then(g => {
    const bad = (g.goals || []).filter(x => /^(ROW-DEL-PROBE|PROBE-ERR|SQLITE-PROBE)/.test(x.title || ""));
    return Promise.all(bad.map(x => window.__TAURI_INTERNALS__.invoke('remove_goal', { id: x.id }).catch(() => {})))
      .then(() => "removed:" + bad.length);
  }).catch(e => "ERR:" + e)`);
  console.log(out);
  main.close();
})();
