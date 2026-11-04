// 增量同步器：一条不开端口的常驻服务（清单里 auto_start=true，启用插件即被拉起）。
// 演示三件事：读宿主注入的环境变量、按周期写日志（「插件」页的实时日志能看到）、
// 以及服务进程用 Bearer 令牌回连宿主能力入口读自己的设置。
const http = require("node:http");
const { URL } = require("node:url");

const ID = process.env.BIT_PLUGIN_ID;
const SERVICE = process.env.BIT_PLUGIN_SERVICE;
const TOKEN = process.env.BIT_PLUGIN_TOKEN;
const API = process.env.BIT_PLUGIN_API;
const MODE = process.env.MODE || "default";
const BATCH = Number(process.env.BATCH || 100);
const PERMS = (process.env.BIT_PLUGIN_PERMS || "").split(",").filter(Boolean);

const say = (m) => process.stderr.write(`${new Date().toISOString()} ${ID}/${SERVICE} ${m}\n`);

function cap(verb, payload) {
  return new Promise((resolve, reject) => {
    if (!API) return reject(new Error("BIT_PLUGIN_API 未就绪"));
    const u = new URL(API + "/cap");
    const body = JSON.stringify({ verb, payload: payload || {} });
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => (res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 160)}`)) : resolve(JSON.parse(text))));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

let seq = 0;
async function round() {
  seq += 1;
  try {
    const info = await cap("info", {});
    const s = await cap("settings.get", { key: "sync_mode" });
    say(`第 ${seq} 轮同步：批次 ${BATCH}，清单模式 ${MODE}，宿主认我为 ${info.plugin_name}，settings.sync_mode = ${s.value ?? "（未设置）"}`);
  } catch (e) {
    say(`第 ${seq} 轮回连失败：${e.message || e}`);
  }
}

say(`启动：pid ${process.pid}，权限 ${PERMS.join("/") || "（无）"}，API ${API || "（未就绪）"}`);
round();
setInterval(round, 15000);
// 保持进程活着：没有监听端口，也没有会自己退出的逻辑
setInterval(() => {}, 60000);
process.on("SIGTERM", () => {
  say("收到停止信号，退出");
  process.exit(0);
});
