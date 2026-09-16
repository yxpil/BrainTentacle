// 全工具扫描：通用 TOOLRUN 协议驱动，逐工具断言执行结果
// 跳过：mouse/keyboard/screen（会动用户输入设备）、网络扫描族（需管理员/防火墙弹窗）、shell_log（console-test 已覆盖）
const ws = require("ws");
const http = require("http");

// [用例名, 工具调用数组, 断言 fn(calls) => string|true]
const CASES = [
  ["write_file", [{ tool: "write_file", params: { path: "./.e2e-sweep.txt", content: "line-A\nline-B\nline-C" } }],
    (c) => c[0]?.ok ? true : `ok=${c[0]?.ok}`],
  ["read_file", [{ tool: "read_file", params: { path: "./.e2e-sweep.txt" } }],
    (c) => JSON.stringify(c[0]?.result || {}).includes("line-B") ? true : "内容缺 line-B"],
  ["edit", [{ tool: "edit", params: { path: "./.e2e-sweep.txt", old_string: "line-B", new_string: "line-B-edited" } }],
    (c) => c[0]?.ok ? true : JSON.stringify(c[0])?.slice(0, 120)],
  ["edit(create-拒绝)", [{ tool: "edit", params: { path: "./.e2e-sweep-new.txt", old_string: "", new_string: "brand-new-content" } }],
    (c) => c[0]?.ok === false && String(c[0]?.result || "").includes("old_string cannot be empty") ? true : "edit 空old_string应拒绝创建: " + JSON.stringify(c[0]).slice(0, 100)],
  ["plan", [{ tool: "plan", params: { goal: "E2E 扫描计划", steps: ["第一步", "第二步", "第三步"] } }],
    (c) => c[0]?.result?.goal_id && c[0]?.result?.todos === 3 ? true : JSON.stringify(c[0])?.slice(0, 120)],
  ["plan_update", "DYNAMIC_PLAN_UPDATE",
    (c, cap2) => c[0]?.ok && c[1]?.ok ? true : JSON.stringify([cap2.goalId, c])?.slice(0, 160)],
  ["skill save+search", [{ tool: "skill", params: { action: "save", name: "e2e-sweep-skill", summary: "E2E 技能:如何把数字翻倍" } }, { tool: "skill", params: { action: "search", query: "翻倍" } }],
    (c) => c[0]?.ok ? (JSON.stringify(c[1]?.result || {}).includes("e2e-sweep-skill") ? true : "search 未命中: " + JSON.stringify(c[1]?.result).slice(0, 120)) : "save失败: " + JSON.stringify(c[0]).slice(0, 100)],
  ["add_tool+invoke+del", [{ tool: "add_tool", params: { name: "e2e-sweep-tool", description: "乘二", runtime: "node", code: "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d||'{}');console.log(JSON.stringify({r:(p.x||0)*2}))});" } }, { tool: "e2e-sweep-tool", params: { x: 21 } }, { tool: "delete_tool", params: { name: "e2e-sweep-tool" } }],
    (c) => {
      if (!c[0]?.ok) return "add_tool 失败: " + JSON.stringify(c[0]).slice(0, 100);
      if (!JSON.stringify(c[1]?.result || {}).includes("42")) return "自建工具结果错: " + JSON.stringify(c[1]).slice(0, 100);
      if (!c[2]?.ok) return "delete_tool 失败: " + JSON.stringify(c[2]).slice(0, 100);
      return true;
    }],
  ["delete_tool(内置拒绝)", [{ tool: "delete_tool", params: { name: "shell" } }],
    (c) => c[0]?.ok === false ? true : "内置工具删除未被拒绝: " + JSON.stringify(c[0]).slice(0, 100)],
  ["truncate_history", [{ tool: "truncate_history", params: { keep: 2 } }],
    (c) => c[0]?.ok ? true : JSON.stringify(c[0])?.slice(0, 120)],
  ["compact_history", [{ tool: "compact_history", params: { summary: "E2E 摘要：工具扫描会话" } }],
    (c) => c[0]?.ok ? true : JSON.stringify(c[0])?.slice(0, 120)],
  ["draw_diagram", [{ tool: "draw_diagram", params: { title: "E2E 流程图", code: "graph TD; A-->B; B-->C" } }],
    (c) => c[0]?.ok ? true : JSON.stringify(c[0])?.slice(0, 120)],
  ["send_file", [{ tool: "write_file", params: { path: "./.e2e-sf.txt", content: "sf-content" } }, { tool: "send_file", params: { path: "./.e2e-sf.txt" } }],
    (c) => c[1]?.ok ? true : JSON.stringify(c[1])?.slice(0, 120)],
];

async function run() {
  const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
  const page = targets.find(t => t.type === "page");
  const client = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const toolsEvts = []; // { ev, payload }
  await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
  client.on("message", d => { const m = JSON.parse(d);
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map(a => a.value !== undefined ? (typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value)) : (a.description || "")).join(" | ");
      const em = text.match(/\[BIT\]\[event\] ← (\S+) \| (.*)/s);
      if (em && em[2].includes('"type":"tools"')) {
        try { toolsEvts.push(JSON.parse(em[2])); } catch {}
      }
    }
    if (m.id && pending.has(m.id)) { const [res, rej] = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } });
  function send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, [res, rej]); client.send(JSON.stringify({ id: n, method, params })); }); }
  const invoke = async (cmd, args = {}) => {
    const r = await send("Runtime.evaluate", { expression: `window.__TAURI_INTERNALS__.invoke('${cmd}', ${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };
  await send("Runtime.enable");

  let pass = 0, fail = 0;
  const cap = { goalId: null };
  const mark = Date.now();
  for (const [name, callsOrDyn, assert] of CASES) {
    let calls = callsOrDyn;
    if (calls === "DYNAMIC_PLAN_UPDATE") {
      if (!cap.goalId) { console.log(`✗ ${name.padEnd(22)} 前置 plan 用例未产出 goal_id`); fail++; continue; }
      calls = [
        { tool: "plan", params: { goal: "E2E PU 目标", steps: ["甲", "乙"] } },
        // abandoned 允许带未完成待办直接结束（防抢跑保护只拦 achieved）
        { tool: "plan_update", params: { goal_id: cap.goalId, goal_status: "abandoned", todos: [] } },
      ];
    }
    const before = toolsEvts.length;
    const sess = await invoke("create_session", { title: `扫描-${name}` });
    const msg = "E2E-TOOLRUN:" + Buffer.from(JSON.stringify(calls), "utf8").toString("base64");
    let rpcErr = null;
    try { await invoke("chat_stream", { sessionId: sess?.id, message: msg, eventName: `tw-${mark}-${pass + fail}`, images: null }); } catch (e) { rpcErr = e.message; }
    await new Promise(r => setTimeout(r, 2500)); // 收尾事件
    const mine = toolsEvts.slice(before);
    const allCalls = mine.flatMap(e => e.calls || []);
    // 捕获 plan 产出的 goal_id 供动态用例
    for (const c of allCalls) if (c.tool === "plan" && c.result?.goal_id) cap.goalId = c.result.goal_id;
    let verdict;
    if (rpcErr) verdict = "RPC 错误: " + rpcErr;
    else if (!allCalls.length) verdict = "无 tools 事件（调用未执行？）";
    else { const v = assert(allCalls, cap); verdict = v === true ? true : v; }
    const okFlag = verdict === true;
    console.log(`${okFlag ? "✓" : "✗"} ${name.padEnd(22)} ${okFlag ? "" : verdict}`);
    okFlag ? pass++ : fail++;
    // 附加：显示执行的工具名序列
    if (!okFlag && allCalls.length) console.log(`   实际调用: [${allCalls.map(c => c.tool + (c.ok ? "" : "(fail)")).join(", ")}]`);
  }

  console.log(`\n========== 工具扫描: ${pass} 通过 / ${fail} 失败 ==========`);
  client.close(); process.exit(fail ? 2 : 0);
}
run().catch(e => { console.error("FATAL:", e); process.exit(1); });
