// 活跃计划删除链路验证：create_goal → 面板 .gdel 点击 → remove_goal 落 bit.db → 重启不复活
// 参数：--create-only（只创建，供重启后第二阶段验证）；--check-only（只查列表）
const http = require("http");
const fs = require("fs");
const OUT = "e2e/goal-del-result.txt";
const log = (...a) => { fs.appendFileSync(OUT, a.join(" ") + "\n"); };
try { fs.unlinkSync(OUT); } catch {}
const mode = process.argv[2] || "full";
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
(async () => {
  setTimeout(() => { log("TIMEOUT 60s"); process.exit(3); }, 60000);
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

  if (mode === "--create-only") {
    const r = await invoke("create_goal", JSON.stringify({ title: "E2E-DEL-GOAL-" + Date.now(), detail: "删除链路验证" }));
    log("created:", JSON.stringify(r?.goal?.id || r));
    main.close();
    return;
  }
  if (mode === "--check-only") {
    const r = await invoke("list_goals");
    const ids = (r?.goals || []).map(g => g.id);
    log("goals_after_restart:", JSON.stringify(ids));
    const left = ids.filter(gid => String(gid).includes("E2E") || (r.goals || []).find(g => g.id === gid && /E2E-DEL/.test(g.title || "")));
    log(left.length === 0 ? "✓ 重启后无 E2E 目标残留（删除已落库，不复活）" : "✗ E2E 目标重启后复活: " + JSON.stringify(left));
    main.close();
    process.exit(left.length === 0 ? 0 : 1);
  }

  // full：创建 → 打开面板 → 点 .gdel → 验证列表清空
  const r = await invoke("create_goal", JSON.stringify({ title: "E2E-DEL-GOAL-" + Date.now(), detail: "删除链路验证" }));
  const gid = r?.goal?.id;
  if (!gid) { log("✗ create_goal 失败: " + JSON.stringify(r)); process.exit(2); }
  log("created goal:", gid);
  await invoke("plugin:window|open-status", "{}");
  await new Promise(res => setTimeout(res, 2500));
  const targets2 = await getTargets();
  const panel = targets2.find(t => t.title && t.title.includes("任务面板"));
  if (!panel) { log("✗ 面板窗口未创建"); process.exit(2); }
  const p = new ws(panel.webSocketDebuggerUrl);
  let pid = 0; const pp = new Map();
  await new Promise((res, j) => { p.on("open", res); p.on("error", j); });
  p.on("message", d => { const m = JSON.parse(d); if (m.id && pp.has(m.id)) { const [res, rej] = pp.get(m.id); pp.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  const psend = (method, params = {}) => new Promise((res, rej) => { const n = ++pid; pp.set(n, [res, rej]); p.send(JSON.stringify({ id: n, method, params })); });
  const pevl = async (expression) => { const r2 = await psend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r2?.result?.value; };
  await psend("Runtime.enable");
  let gidShown = null;
  for (let i = 0; i < 14 && !gidShown; i++) { // goals 轮询间隔 10s：最多等 ~14s 让本目标刷入（页面可能残留旧目标的按钮，须按 data-gid 精确匹配）
    await new Promise(res => setTimeout(res, 1000));
    gidShown = await pevl(`(() => { const b = document.querySelector('.gdel[data-gid="${gid}"]'); return b ? b.dataset.gid : null; })()`);
  }
  log("面板渲染的删除按钮 goal:", gidShown || "(无按钮)");
  if (!gidShown) { log("✗ 面板未渲染 .gdel 删除按钮"); process.exit(1); }
  await pevl(`document.querySelector('.gdel[data-gid="${gid}"]').click()`);
  await new Promise(res => setTimeout(res, 2000));
  const after = await invoke("list_goals");
  const still = (after?.goals || []).find(g => g.id === gid);
  log(still ? "✗ 点击删除后目标仍在" : "✓ 面板点击删除成功（list_goals 已不含该目标）");
  main.close(); p.close();
  process.exit(still ? 1 : 0);
})().catch(e => { log("ERROR:", e.message); process.exit(2); });
