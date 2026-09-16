// 行级表删除链路：create_goal → remove_goal → list_goals 空 → （由外层脚本重启后再 verify 模式确认不复活）
const http = require("http");
const fs = require("fs");
const OUT = "e2e/goal-remove-result.txt";
const log = (...a) => { fs.appendFileSync(OUT, a.join(" ") + "\n"); };
try { fs.unlinkSync(OUT); } catch {}
const mode = process.argv[2] || "remove";
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
(async () => {
  setTimeout(() => { log("TIMEOUT 30s"); process.exit(3); }, 30000);
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  if (!page) { log("主窗口未找到"); process.exit(2); }
  const ws = require("ws");
  const main = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { main.on("open", r); main.on("error", j); });
  main.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); main.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r?.result?.value; };
  await send("Runtime.enable");
  const invoke = (cmd, args = "{}") => evl(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${args})`);
  const count = (goals) => (goals?.goals || []).filter(x => /ROW-DEL-PROBE/.test(x.title || "")).length;

  if (mode === "remove") {
    const g = await invoke("create_goal", JSON.stringify({ title: "ROW-DEL-PROBE-" + Date.now(), detail: "行级表删除验证" }));
    const gid = g?.goal?.id || g?.id;
    if (!gid) { log("✗ 创建失败: " + JSON.stringify(g)); process.exit(1); }
    const before = count(await invoke("list_goals"));
    await invoke("remove_goal", JSON.stringify({ id: gid }));
    const after = count(await invoke("list_goals"));
    log((before === 1 ? "✓" : "✗") + " 创建后计数: " + before);
    log((after === 0 ? "✓" : "✗") + " 删除后计数: " + after);
    log("VERIFY_AFTER_RESTART");
    main.close();
    process.exit(before === 1 && after === 0 ? 0 : 1);
  }
  if (mode === "verify") {
    const after = count(await invoke("list_goals"));
    log((after === 0 ? "✓" : "✗") + " 重启后计数（应为 0，不复活）: " + after);
    main.close();
    process.exit(after === 0 ? 0 : 1);
  }
})();
