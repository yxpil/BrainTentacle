// 插件自带服务器：宿主（WorkWith 引擎）负责拉起、分配端口与令牌，
// 环境变量里给齐 BIT_PLUGIN_ID / BIT_PLUGIN_PORT / BIT_PLUGIN_TOKEN / BIT_PLUGIN_API / BIT_PLUGIN_DIR / BIT_PLUGIN_PERMS。
// 这里演示两件事：
//   1) 动态页面（清单里 pages.url）由本进程提供，页面用 SDK 反向调用宿主；
//   2) 进程自己也用 HTTP POST {BIT_PLUGIN_API}/cap + Bearer 令牌回连宿主，取自己的能力和数据清单。
const http = require("node:http");
const { URL } = require("node:url");

const ID = process.env.BIT_PLUGIN_ID || "srv-dashboard";
const PORT = Number(process.env.BIT_PLUGIN_PORT || 0);
const TOKEN = process.env.BIT_PLUGIN_TOKEN || "";
const API = process.env.BIT_PLUGIN_API || "";
const PERMS = (process.env.BIT_PLUGIN_PERMS || "").split(",").filter(Boolean);
const VERBOSE = process.argv.includes("--verbose");

// 日志进 stderr：宿主把 stderr 收进环形缓冲，「插件」页的实时日志读的就是它
const log = (...a) => process.stderr.write(`[${ID}] ${a.join(" ")}\n`);

let ticks = 0;
const startedAt = Date.now();

// 回连宿主能力入口：verb + payload 的包法与页面 SDK 完全一致
function cap(verb, payload) {
  return new Promise((resolve, reject) => {
    if (!API) return reject(new Error("BIT_PLUGIN_API 还没就绪"));
    const u = new URL(API + "/cap");
    const body = JSON.stringify({ verb, payload: payload || {} });
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error("宿主返回不是 JSON：" + text.slice(0, 120)));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function metrics() {
  return {
    plugin: ID,
    pid: process.pid,
    port: PORT,
    node: process.version,
    perms: PERMS,
    api: API,
    ticks,
    uptime_ms: Date.now() - startedAt,
    env_keys: Object.keys(process.env).filter((k) => k.startsWith("BIT_PLUGIN_")).sort(),
  };
}

const PAGE_CSS = `
:root{--bg:#fafafa;--fg:#171717;--muted:#6b7280;--line:#e5e5e5;--card:#fff;--accent:#ea580c}
@media (prefers-color-scheme:dark){:root{--bg:#171717;--fg:#f5f5f5;--muted:#a3a3a3;--line:#333;--card:#1f1f1f;--accent:#fb923c}}
*{box-sizing:border-box}body{margin:0;padding:18px;background:var(--bg);color:var(--fg);font:13px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}
h1{margin:0 0 2px;font-size:16px}h2{margin:0 0 8px;font-size:13px}.sub{color:var(--muted);margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
pre{margin:0;white-space:pre-wrap;word-break:break-all;color:var(--muted);font-size:12px}
button{margin-top:8px;padding:6px 12px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;cursor:pointer;font:inherit}
`;

// 动态页要自己把宿主下发的 SDK 拉进来：SDK 在宿主插件 API 服务上（端口与本服务器不同），
// 令牌从帧地址的 #bit_token= 片段里取，这活儿是 SDK 自己做的。
const BOARD_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>经营看板</title><style>${PAGE_CSS}</style>
<script src="${API}/sdk.js"></script></head>
<body>
<h1>经营看板</h1>
<div class="sub">这一页由插件自己的 Node 进程提供；帧与宿主之间的凭据走地址片段里的 bit_token。</div>
<div class="grid">
  <div class="card"><h2>进程指标（本服务器直接给出）</h2><pre id="m">…</pre></div>
  <div class="card"><h2>宿主回连（进程侧 HTTP /cap）</h2><pre id="c">…</pre></div>
  <div class="card"><h2>帧侧通道（页面 SDK）</h2><pre id="f">…</pre><button id="ping">用帧的通道问一次宿主</button></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let ticks = 0;
async function json(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
}
async function refresh() {
  ticks += 1;
  $("m").textContent = JSON.stringify(await json("/api/metrics"), null, 2);
  $("c").textContent = JSON.stringify(await json("/api/cap-self"), null, 2);
}
$("ping").addEventListener("click", async () => {
  if (!window.Bit) { $("f").textContent = "SDK 没载入：BIT_PLUGIN_API = " + ${JSON.stringify(API)}; return; }
  try {
    const caps = await Bit.caps();
    const info = Bit.info();
    const files = await Bit.data.list();
    $("f").textContent = JSON.stringify({ handshake: info && info.plugin_name, caps: caps.caps.length, data: (files.files || []).length }, null, 2);
  } catch (e) { $("f").textContent = "帧通道失败：" + (e.message || e); }
});
refresh();
setInterval(refresh, 4000);
</script></body></html>`;

const STATUS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>服务健康</title><style>${PAGE_CSS}</style></head>
<body><h1>服务健康</h1><div class="sub">插件详情页右侧的状态面板：进程活着就有数据。</div>
<div class="card"><pre id="s">…</pre></div>
<script>
async function tick(){ try { const r = await fetch("/health"); document.getElementById("s").textContent = JSON.stringify(await r.json(), null, 2); } catch(e){ document.getElementById("s").textContent = "进程已不在：" + (e.message||e); } }
tick(); setInterval(tick, 3000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  ticks += 1;
  if (VERBOSE) log(req.method, u.pathname);
  const send = (code, type, body) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") return send(200, "text/html; charset=utf-8", BOARD_HTML);
    if (u.pathname === "/status") return send(200, "text/html; charset=utf-8", STATUS_HTML);
    if (u.pathname === "/health") return send(200, "application/json", JSON.stringify({ ok: true, ...metrics() }));
    if (u.pathname === "/api/metrics") return send(200, "application/json", JSON.stringify(metrics(), null, 2));
    if (u.pathname === "/api/cap-self") {
      // 进程侧回连：证明 Bearer 令牌 + 权限位这条路真能走通
      const out = {};
      for (const verb of ["info", "caps", "settings.all", "data.list"]) {
        try {
          out[verb] = await cap(verb, {});
        } catch (e) {
          out[verb] = { error: String(e.message || e) };
        }
      }
      return send(200, "application/json", JSON.stringify(out, null, 2));
    }
    if (u.pathname === "/api/write" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { path: p, text } = JSON.parse(body || "{}");
          const r = await cap("data.write", { path: p, text });
          send(200, "application/json", JSON.stringify(r));
        } catch (e) {
          send(400, "application/json", JSON.stringify({ error: String(e.message || e) }));
        }
      });
      return;
    }
    return send(404, "text/plain; charset=utf-8", "not found");
  } catch (e) {
    return send(500, "text/plain; charset=utf-8", "内部错误：" + (e.message || e));
  }
});

if (!PORT) {
  log("没有 BIT_PLUGIN_PORT，无法监听");
  process.exit(2);
}
server.listen(PORT, "127.0.0.1", () => {
  log(`监听 127.0.0.1:${PORT}，宿主 API = ${API || "（未就绪）"}，权限 ${PERMS.join("/")}`);
});
process.on("SIGTERM", () => { log("收到 SIGTERM，收摊"); server.close(() => process.exit(0)); });
