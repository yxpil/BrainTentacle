// SQLite 全迁移验证：运行期制造数据（goal/记忆/审计）→ 重启 → 验证全存活 + 无 legacy JSON 再生成
const http = require("http");
const fs = require("fs");
const OUT = "e2e/sqlite-migrate-result.txt";
const log = (...a) => { fs.appendFileSync(OUT, a.join(" ") + "\n"); };
try { fs.unlinkSync(OUT); } catch {}
const mode = process.argv[2] || "create";
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

  if (mode === "create") {
    await invoke("create_goal", JSON.stringify({ title: "SQLITE-PROBE-" + Date.now(), detail: "全迁移验证" }));
    await invoke("add_memory", JSON.stringify({ content: "SQLITE-MEM-PROBE-" + Date.now() }));
    const audit = await invoke("list_audit");
    log("audit_entries_runtime:", (audit?.entries || audit || []).length);
    const dd = process.env.BIT_DATA_DIR || "";
    const jsons = dd ? fs.readdirSync(dd).filter(f => f.endsWith(".json") && !f.endsWith(".migrated")) : [];
    log("data_dir_json_files:", JSON.stringify(jsons));
    main.close();
    process.exit(0);
  }
  if (mode === "verify") {
    const goals = await invoke("list_goals");
    const mem = await invoke("list_memories");
    const audit = await invoke("list_audit");
    const g = (goals?.goals || []).filter(x => /SQLITE-PROBE/.test(x.title || ""));
    const m = (mem?.memories || mem || []);
    const mArr = Array.isArray(m) ? m : [];
    const mm = mArr.filter(x => /SQLITE-MEM-PROBE/.test(x.content || ""));
    log((g.length ? "✓" : "✗") + " 目标重启后存活: " + g.length + " 条");
    log((mm.length ? "✓" : "✗") + " 记忆重启后存活: " + mm.length + " 条");
    const aN = (audit?.entries || audit || []).length;
    log((aN > 0 ? "✓" : "✗") + " 审计重启后存活: " + aN + " 条");
    const dd = process.env.BIT_DATA_DIR || "";
    const jsons = dd ? fs.readdirSync(dd).filter(f => f.endsWith(".json") && !f.endsWith(".migrated")) : [];
    const bad = jsons.filter(f => !["config.json", "guardian.json"].includes(f));
    log((bad.length === 0 ? "✓" : "✗") + " 数据目录无 legacy JSON 再生成: " + JSON.stringify(jsons));
    main.close();
    process.exit(g.length && mm.length && aN > 0 && bad.length === 0 ? 0 : 1);
  }
  log("未知模式");
  process.exit(2);
})().catch(e => { log("ERROR:", e.message); process.exit(2); });
