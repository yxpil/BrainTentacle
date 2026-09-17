// WorkWith 端到端验证：CRUD / 启停 / 实时日志 / MCP 联动与解绑 / 页面渲染
// 前置：electron 已带 --remote-debugging-port=9222 启动
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

function cdpTargets() {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 9222, path: "/json", method: "GET" }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(JSON.parse(b)));
    });
    req.on("error", reject);
    req.end();
  });
}

let wsId = 1;
function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = wsId++;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === id) {
        ws.off("message", onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function invoke(ws, cmd, args) {
  const r = await send(ws, "Runtime.evaluate", {
    expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error("invoke " + cmd + " 异常: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 极简 MCP 服务器（Streamable HTTP / JSON 响应）：initialize + tools/list + tools/call
// 端口取 argv[2]，缺省 MCP_PORT —— 供会话联动测试用不同端口拉起第二实例
const MCP_PORT = 39517;
const serverSrc = `
const http = require("http");
const PORT = Number(process.argv[2]) || ${MCP_PORT};
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    console.log("MCP-SRV request", req.url);
    let body = {};
    try { body = JSON.parse(b || "{}"); } catch {}
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    if (body.method === "initialize") {
      reply({ protocolVersion: body.params?.protocolVersion || "2024-11-05",
        serverInfo: { name: "e2e-mcp", version: "1.0.0" }, capabilities: {} });
    } else if (body.method === "tools/list") {
      reply({ tools: [{ name: "echo_tool", description: "回声测试工具",
        inputSchema: { type: "object", properties: { msg: { type: "string" } } } }] });
    } else if (body.method === "tools/call") {
      reply({ content: [{ type: "text", text: "echo:" + (body.params?.arguments?.msg || "") }] });
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log("MCP-SRV ready on", PORT));
`;

(async () => {
  const targets = await cdpTargets();
  const page = targets.find((t) => t.type === "page" && (t.url || "").includes("dist/index.html"));
  if (!page) throw new Error("主窗口 target 未找到");
  const WebSocket = (await import("ws")).default;
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on("open", r));

  const results = [];
  const check = (name, ok) => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  };

  // 0) 确认 node 运行环境可用（刷新探测一次）
  await invoke(ws, "refresh_runtimes");
  const rts = await invoke(ws, "list_runtimes");
  const node = (rts.runtimes || []).find((r) => r.id === "node");
  check("node-runtime", !!node);

  // 1) 测试用 MCP 服务器文件
  const srvPath = path.join(os.tmpdir(), "bit-ww-e2e-mcp-server.js");
  fs.writeFileSync(srvPath, serverSrc);

  // 2) 初始列表（先清理上次运行的残留条目，保证幂等）
  const l0 = await invoke(ws, "list_workwith");
  check("list-empty", Array.isArray(l0.entries));
  for (const old of l0.entries || []) {
    if (old.name === "e2e-mcp") {
      try { await invoke(ws, "stop_workwith", { id: old.id }); } catch {}
      try { await invoke(ws, "remove_workwith", { id: old.id }); } catch {}
    }
  }

  // 3) 保存条目
  const s1 = await invoke(ws, "save_workwith", {
    entry: { name: "e2e-mcp", runtime_id: "node", program: srvPath, args: [], cwd: "", env: {}, port: MCP_PORT, auto_with_session: true },
  });
  const wid = s1.entry.id;
  check("save-entry", !!wid);

  // 4) 启动
  const st = await invoke(ws, "start_workwith", { id: wid });
  check("start", st.status === "running" && st.pid > 0);

  // 5) 轮询 MCP 联动（端口就绪 → 自动注册）
  let linked = false;
  for (let i = 0; i < 60 && !linked; i++) {
    await sleep(1000);
    const ml = await invoke(ws, "mcp_list");
    linked = (ml.servers || []).some((s) => s.id === `ww-${wid}` && s.enabled);
  }
  check("mcp-linked", linked);

  // 6) 工具已导入注册中心
  let toolIn = false;
  if (linked) {
    const tl = await invoke(ws, "list_tools");
    toolIn = (tl.tools || []).some((t) => t.name === "echo_tool");
  }
  check("tool-imported", toolIn);

  // 7) 实时日志
  let hasLog = false;
  for (let i = 0; i < 10 && !hasLog; i++) {
    await sleep(1000);
    const lg = await invoke(ws, "workwith_logs", { id: wid, tail: 50 });
    hasLog = (lg.logs || []).some((l) => l.text.includes("MCP-SRV"));
  }
  check("logs", hasLog);

  // 8) 停止 → MCP 禁用 + 工具移除
  await invoke(ws, "stop_workwith", { id: wid });
  await sleep(1500);
  const ml2 = await invoke(ws, "mcp_list");
  const srv2 = (ml2.servers || []).find((s) => s.id === `ww-${wid}`);
  check("mcp-disabled", srv2 && srv2.enabled === false);
  const tl2 = await invoke(ws, "list_tools");
  check("tools-removed", !(tl2.tools || []).some((t) => t.name === "echo_tool"));

  // 9) 重启 → 联动恢复
  await invoke(ws, "start_workwith", { id: wid });
  let relinked = false;
  for (let i = 0; i < 60 && !relinked; i++) {
    await sleep(1000);
    const ml3 = await invoke(ws, "mcp_list");
    relinked = (ml3.servers || []).some((s) => s.id === `ww-${wid}` && s.enabled);
  }
  check("relink", relinked);

  // 10) 删除条目 → MCP 条目整条移除 + 进程停止
  await invoke(ws, "remove_workwith", { id: wid });
  await sleep(1500);
  const l1 = await invoke(ws, "list_workwith");
  check("entry-removed", !(l1.entries || []).some((e) => e.id === wid));
  const ml4 = await invoke(ws, "mcp_list");
  check("mcp-entry-gone", !(ml4.servers || []).some((s) => s.id === `ww-${wid}`));

  // 11) 会话联动：auto_with_session 条目在新会话首回合自动拉起（回合内 AI 调用失败不影响联动）
  const s2 = await invoke(ws, "save_workwith", {
    entry: { name: "e2e-auto", runtime_id: "node", program: srvPath, args: [String(MCP_PORT + 1)], cwd: "", env: {}, port: MCP_PORT + 1, auto_with_session: true },
  });
  const aid = s2.entry.id;
  const sess = await invoke(ws, "create_session", { title: "ww-e2e" });
  const sid = sess.id;
  try { await invoke(ws, "chat", { session_id: sid, message: "hi" }); } catch {}
  let autolinked = false;
  for (let i = 0; i < 30 && !autolinked; i++) {
    await sleep(1000);
    const ml5 = await invoke(ws, "mcp_list");
    autolinked = (ml5.servers || []).some((s) => s.id === `ww-${aid}` && s.enabled);
  }
  check("auto-link", autolinked);

  // 12) UI：左侧导航出现「服务」入口，点击后页面渲染
  const ui = await send(ws, "Runtime.evaluate", {
    expression: `(() => {
      const btn = [...document.querySelectorAll("button,[role=button],a")].find((b) => (b.title === "服务" || b.title === "Services"));
      if (!btn) return "no-nav-btn";
      btn.click();
      return "clicked";
    })()`,
    returnByValue: true,
  });
  await sleep(800);
  const pageText = await send(ws, "Runtime.evaluate", {
    expression: `document.body.innerText.includes("WorkWith") || document.body.innerText.includes("本地服务")`,
    returnByValue: true,
  });
  check("ui-nav+render", ui.result.value === "clicked" && pageText.result.value === true);

  // 清理：删除联动测试条目与会话
  try { await invoke(ws, "remove_workwith", { id: aid }); } catch {}
  try { await invoke(ws, "delete_session", { session_id: sid }); } catch {}
  const l3 = await invoke(ws, "list_workwith");
  check("cleanup", !(l3.entries || []).some((e) => e.id === aid || e.name === "e2e-mcp"));

  const okAll = results.every((r) => r.ok);
  console.log(okAll ? `ALL PASS ${results.length}/${results.length}` : `SOME FAILED: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
  ws.close();
  process.exit(okAll ? 0 : 1);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
