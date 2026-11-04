// 全文索引服务：端口就绪后由宿主按 Streamable HTTP 接入为 MCP 服务器（清单 mcp_mode:"http"）。
// 这里只实现握手与工具发现所需的最小 JSON-RPC：initialize / notifications/initialized /
// tools/list / tools/call，外加一个便于排障的 GET /health。
const http = require("node:http");

const ID = process.env.BIT_PLUGIN_ID || "svc-sync";
const SERVICE = process.env.BIT_PLUGIN_SERVICE || "indexer";
const PORT = Number(process.env.BIT_PLUGIN_PORT || 0);
const say = (m) => process.stderr.write(`${new Date().toISOString()} ${ID}/${SERVICE} ${m}\n`);

const DOCS = [
  { id: "d-01", title: "同步作业手册", tags: ["sync", "ops"] },
  { id: "d-02", title: "索引分片说明", tags: ["index", "arch"] },
  { id: "d-03", title: "夜班巡检清单", tags: ["ops", "check"] },
];

const TOOLS = [
  {
    name: "index_stats",
    description: "看索引服务当前收录了多少文档",
    // 宿主的工具表拒绝空 properties 的 schema（模型会瞎猜参数名），所以留一个显式可选项
    inputSchema: {
      type: "object",
      properties: { detail: { type: "boolean", description: "是否连分片明细一起返回，默认否" } },
    },
  },
  {
    name: "search_docs",
    description: "按关键字在标题与标签里找文档",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", description: "关键字" } },
      required: ["q"],
    },
  },
];

function reply(res, id, result) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function callTool(name, args) {
  if (name === "index_stats") {
    return { content: [{ type: "text", text: JSON.stringify({ docs: DOCS.length, service: SERVICE, pid: process.pid }) }] };
  }
  if (name === "search_docs") {
    const q = String((args && args.q) || "").toLowerCase();
    const hits = DOCS.filter((d) => !q || d.title.toLowerCase().includes(q) || d.tags.some((t) => t.includes(q)));
    return { content: [{ type: "text", text: JSON.stringify(hits) }] };
  }
  return { isError: true, content: [{ type: "text", text: `未知工具 ${name}` }] };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: SERVICE, tools: TOOLS.length }));
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" });
    return res.end("POST only");
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
    }
    const { id, method, params } = msg;
    say(`RPC ${method}`);
    if (method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "Mcp-Session-Id": `s-${process.pid}` });
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: (params && params.protocolVersion) || "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `${ID} 索引服务`, version: "1.1.0" },
          },
        })
      );
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      res.writeHead(202, { "content-type": "application/json" });
      return res.end("");
    }
    if (method === "ping") return reply(res, id, {});
    if (method === "tools/list") return reply(res, id, { tools: TOOLS });
    if (method === "tools/call") return reply(res, id, callTool(params && params.name, params && params.arguments));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } }));
  });
});

if (!PORT) {
  say("缺少 BIT_PLUGIN_PORT，索引服务不监听");
  process.exit(2);
}
server.listen(PORT, "127.0.0.1", () => say(`MCP 索引服务监听 127.0.0.1:${PORT}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
