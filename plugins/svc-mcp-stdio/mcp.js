// stdio 型 MCP 服务器：stdout 只走换行分隔的 JSON-RPC，任何日志都必须进 stderr。
// 宿主（WorkWith）接管这条管道：initialize → tools/list → 导入为工具 → tools/call 打回来。
const readline = require("node:readline");

const ID = process.env.BIT_PLUGIN_ID || "svc-mcp-stdio";
const say = (m) => process.stderr.write(`${new Date().toISOString()} ${ID}/bridge ${m}\n`);

const DEVICES = [
  { name: "printer-1", kind: "printer", online: true },
  { name: "scale-2", kind: "scale", online: true },
  { name: "cam-3", kind: "camera", online: false },
];

const TOOLS = [
  {
    name: "device_list",
    description: "列出接入的设备及其在线状态",
    // 同 http 型那条：宿主工具表不收空 properties，给一个显式可选项而不是留空
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", description: "只看某类设备，如 printer / scale / camera" } },
    },
  },
  {
    name: "device_ping",
    description: "点名一台设备，返回是否可达",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "设备名" } },
      required: ["name"],
    },
  },
];

function result(id, res) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: res }) + "\n");
}

function error(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function call(name, args) {
  if (name === "device_list") {
    const kind = args && args.kind;
    const rows = kind ? DEVICES.filter((d) => d.kind === kind) : DEVICES;
    return { content: [{ type: "text", text: JSON.stringify(rows) }] };
  }
  if (name === "device_ping") {
    const d = DEVICES.find((x) => x.name === (args && args.name));
    if (!d) return { isError: true, content: [{ type: "text", text: "没有这台设备" }] };
    return { content: [{ type: "text", text: `${d.name} ${d.online ? "可达" : "离线"}（${d.kind}）` }] };
  }
  return { isError: true, content: [{ type: "text", text: `未知工具 ${name}` }] };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
say(`就绪：pid ${process.pid}，工具 ${TOOLS.length} 个`);

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    error(null, -32700, "parse error");
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: (params && params.protocolVersion) || "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `${ID} 设备桥`, version: "1.0.3" },
      });
      break;
    case "notifications/initialized":
      say("握手完成");
      break; // 通知没有 id，不该回包
    case "ping":
      result(id, {});
      break;
    case "tools/list":
      result(id, { tools: TOOLS });
      break;
    case "tools/call":
      say(`调用 ${params && params.name}`);
      result(id, call(params && params.name, params && params.arguments));
      break;
    default:
      if (id !== undefined && id !== null) error(id, -32601, `method not found: ${method}`);
  }
});

rl.on("close", () => {
  say("管道关闭，退出");
  process.exit(0);
});
