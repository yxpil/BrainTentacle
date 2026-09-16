// 目标持久化验证（bit.db 唯一持久层）：
// 阶段1 create → 记录 id → 重启后由外部再跑本脚本 --verify-create <id>
// 阶段2 remove <id> → 重启后 --verify-removed <id>
const http = require("http");
const fs = require("fs");
const OUT = "e2e/goal-persist-result.txt";
const log = (...a) => { fs.appendFileSync(OUT, a.join(" ") + "\n"); };
try { fs.unlinkSync(OUT); } catch {}
const [, , mode, argId] = process.argv;
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
(async () => {
  setTimeout(() => { log("TIMEOUT 40s"); process.exit(3); }, 40000);
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

  const findGoal = async (gid) => {
    const r = await invoke("list_goals");
    return (r?.goals || []).find(g => g.id === gid) || null;
  };

  if (mode === "create") {
    const r = await invoke("create_goal", JSON.stringify({ title: "PERSIST-PROBE-" + Date.now(), detail: "持久化验证" }));
    const gid = r?.goal?.id;
    if (!gid) { log("✗ create 失败 " + JSON.stringify(r)); process.exit(2); }
    log("created:", gid);
    console.log(gid);
    main.close();
    process.exit(0);
  }
  if (mode === "remove") {
    await invoke("remove_goal", JSON.stringify({ id: argId }));
    const g = await findGoal(argId);
    log("removed:", argId, g ? "✗ 仍在" : "✓ 已删");
    main.close();
    process.exit(g ? 1 : 0);
  }
  if (mode === "verify-create") {
    const g = await findGoal(argId);
    log(g ? `✓ 目标 ${argId} 创建后重启仍存在（persist 走 bit.db）` : `✗ 目标 ${argId} 重启后丢失！`);
    // 顺带检查数据目录不应再有 goals.json/todos.json（旧分裂持久层）
    const dd = process.env.BIT_DATA_DIR || "";
    for (const f of ["goals.json", "todos.json"]) {
      const exists = dd && fs.existsSync(require("path").join(dd, f));
      log(exists ? `⚠ ${f} 仍存在（不应再生成）` : `✓ 数据目录无 ${f}`);
    }
    main.close();
    process.exit(g ? 0 : 1);
  }
  if (mode === "verify-removed") {
    const g = await findGoal(argId);
    log(g ? `✗ 目标 ${argId} 删除后重启复活（删除未落库）！` : `✓ 目标 ${argId} 删除后重启未复活（删除已落 bit.db）`);
    main.close();
    process.exit(g ? 1 : 0);
  }
  log("未知模式: " + mode);
  process.exit(2);
})().catch(e => { log("ERROR:", e.message); process.exit(2); });
