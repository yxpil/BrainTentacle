// yxpil · BIT MCP 接入 e2e：拉起独立实例，走真实后端链路测试 3 个第三方 stdio MCP
//!   1) mcp-server-fetch（Python）→ 调用 fetch 工具抓取网页
//!   2) @modelcontextprotocol/server-everything（npm 官方测试服）→ echo / add
//!   3) server-sequential-thinking（npm）→ 结构化思考工具
//! 链路：渲染层 invoke → preload shim → napi bridge → mcp.rs spawn/initialize/list_tools/call。
//! 用法：node scripts/mcp-e2e.cjs
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 9500 + (process.pid % 400);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}
async function getMainPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${PORT}/json`);
      const t = list.find((x) => x.type === 'page' && !/tray-status/.test(x.url));
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('没找到主窗口调试目标');
}
function evaluate(ws, expr) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== id) return;
      ws.off('message', onMsg);
      if (m.error) return reject(new Error(m.error.message));
      const r = m.result?.result || {};
      if (r.subtype === 'error') return reject(new Error(r.description || 'evaluate error'));
      resolve(r.value);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}

// 每个服务器一段场景：在渲染进程里跑完整链路（接入→导入→调用）
const SCENARIO = `(async () => {
  const inv = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const servers = [
    { name: "fetch", command: "python", args: ["-m", "mcp_server_fetch"],
      calls: [{ tool: "fetch", params: { url: "https://example.com", max_length: 2000 }, ok: (r) => /Example Domain/i.test(JSON.stringify(r)) }] },
    { name: "everything", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"],
      calls: [
        { tool: "echo", params: { message: "bit-mcp-e2e" }, ok: (r) => JSON.stringify(r).includes("bit-mcp-e2e") },
        { tool: "get-sum", params: { a: 40, b: 2 }, ok: (r) => JSON.stringify(r).includes("42") },
      ] },
    { name: "memory", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"],
      calls: [{ tool: "create_entities", params: { entities: [{ name: "bit-e2e-" + Date.now(), entityType: "test", observations: ["mcp-e2e"] }] }, ok: (r) => JSON.stringify(r).includes("entities") }] },
  ];
  const out = [];
  for (const s of servers) {
    try {
      const add = await inv("mcp_add_stdio", { name: s.name, command: s.command, args: s.args, env: {} });
      out.push([s.name, "接入", "OK id=" + (add.id || "?")]);
      await inv("mcp_import", { id: add.id });
      await sleep(300);
      const toolsRaw = await inv("list_tools");
      const tools = Array.isArray(toolsRaw) ? toolsRaw : (toolsRaw?.tools || []);
      const names = tools.map((t) => t.name || t.id);
      for (const c of s.calls) {
        // 精确匹配工具名，避免误中 BIT 内置工具（如 add_tool）
        const t = tools.find((x) => x.name === c.tool) || tools.find((x) => (x.name || "").endsWith("/" + c.tool));
        if (!t) { out.push([s.name, "调用 " + c.tool, "FAIL 未导入（列表: " + names.slice(0, 6).join(",") + "…）"]); continue; }
        try {
          const r = await inv("invoke_tool", { id: t.id, params: c.params });
          out.push([s.name, "调用 " + c.tool, c.ok(r) ? "OK" : "FAIL 结果异常: " + JSON.stringify(r).slice(0, 120)]);
        } catch (e) { out.push([s.name, "调用 " + c.tool, "FAIL " + String(e).slice(0, 120)]); }
      }
    } catch (e) {
      out.push([s.name, "接入", "FAIL " + String(e).slice(0, 160)]);
    }
  }
  return JSON.stringify(out);
})()`;

(async () => {
  const electron = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', '.bin', 'electron');
  const child = spawn(electron, [`--remote-debugging-port=${PORT}`, path.join(ROOT, 'electron', 'main.cjs')], {
    cwd: ROOT,
    env: { ...process.env, BIT_ELECTRON_DIST: '1', BIT_DATA_DIR: path.join(require('os').tmpdir(), `bit-mcp-e2e-${process.pid}`) },
    stdio: 'ignore',
  });
  let code = 0;
  try {
    const target = await getMainPageTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    await new Promise((r) => setTimeout(r, 2500));
    const rows = JSON.parse(await evaluate(ws, SCENARIO));
    console.log('\n══ BIT MCP 接入测试 ══');
    let fail = 0;
    for (const [srv, step, verdict] of rows) {
      const bad = verdict.startsWith('FAIL');
      if (bad) fail++;
      console.log(`${bad ? '✗' : '✓'} ${srv.padEnd(20)} ${step.padEnd(10)} ${verdict}`);
    }
    console.log(`══ ${rows.length - fail}/${rows.length} 通过 ══\n`);
    code = fail ? 1 : 0;
    ws.close();
  } catch (e) {
    console.error('e2e 执行失败:', e.message);
    code = 2;
  } finally {
    try { child.kill(); } catch {}
    setTimeout(() => process.exit(code), 500);
  }
})();
