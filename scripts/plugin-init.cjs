#!/usr/bin/env node
// yxpil · 插件脚手架：一条命令生成一个能直接跑起来的插件包
//
//   node scripts/plugin-init.cjs --name 我的插件 --kind page
//   npm run plugin:new -- --name hello --kind full --dest ../drafts
//
// 生成的清单刻意用简写形式（preset / 单数 page / 字符串 server），和
// plugins/sdk-sugar 一起当"语法糖怎么写都行"的活文档；装进数据目录后
// 在「设置 → 插件」点重新扫描即可看到，不需要重启应用。
//
// 默认落在当前目录下的 <name>/，拒绝直接写用户真实数据目录（%APPDATA%\com.bit.hub）。
"use strict";

const fs = require("fs");
const path = require("path");

const KINDS = ["page", "service", "tool", "filekind", "net", "full"];

function parseArgs(argv) {
  const a = { dest: process.cwd(), force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === "--name" || k === "-n") a.name = argv[++i];
    else if (k === "--kind" || k === "-k") a.kind = argv[++i];
    else if (k === "--dest" || k === "-d") a.dest = argv[++i];
    else if (k === "--force") a.force = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else {
      console.error(`未知参数：${k}`);
      process.exit(2);
    }
  }
  return a;
}

const HELP = `插件脚手架

用法：node scripts/plugin-init.cjs --name <目录名> [--kind page|service|tool|filekind|net|full] [--dest <目录>] [--force]

  --name   插件目录名（= 插件 id，只留字母数字与连字符）
  --kind   形态，默认 page
           page     静态页 + 宿主代管存储（preset: page）
           service  常驻 node 服务，进程里 require("bit") 回连能力
           tool     解释器工具，stdin 收 JSON、stdout 出 JSON
           filekind 认领一种宿主读不了的文件：图标 + 解析工具（需 files 权限）
           full     自带服务器(ESM import "bit") + 页面 + 工具，全套语法糖示范
  --dest   生成到哪个目录下（默认当前目录）
  --force  目标已存在时覆盖

装好之后：把生成的目录放进 数据目录/toolhomes/plugins/，在「设置 → 插件」点重新扫描。`;

function slug(s) {
  return String(s || "")
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

// 真实数据目录里放的是用户自己的插件：脚手架不许往里写
function guardDest(dest) {
  const appData = process.env.APPDATA || "";
  const real = appData ? path.resolve(appData, "com.bit.hub") : "";
  const abs = path.resolve(dest);
  if (real && (abs === real || abs.startsWith(real + path.sep)) && !process.argv.includes("--force")) {
    console.error(`拒绝写入用户真实数据目录：${abs}\n（确实要往那里放就加 --force，或先生成到别处再拷）`);
    process.exit(2);
  }
  return abs;
}

function manifest(name, kind) {
  const base = {
    name,
    version: "0.1.0",
    description: `${kind} 型插件（plugin-init 生成）`,
  };
  if (kind === "page") {
    return {
      ...base,
      preset: "page",
      bridge: { token: "required" },
      page: { id: "main", label: name, src: "web/index.html", paths: ["M5 5h14v14H5z"] },
    };
  }
  if (kind === "service") {
    return {
      ...base,
      preset: "service",
      service: { name: "worker", runtime: "node", program: "svc/worker.js", auto_start: true },
    };
  }
  if (kind === "tool") {
    return {
      ...base,
      permission: "data",
      tool: {
        name: "hello",
        description: "回显参数并回报本插件身份（示范解释器工具怎么回连宿主）",
        runtime: "node",
        file: "tools/hello.js",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    };
  }
  if (kind === "filekind") {
    // preset 里不含 files：认领文件类型是新权限，必须自己写出来（和 bridge 令牌同理，
    // 不许预设代填），这样"这个插件会碰用户文件"在清单上一眼可见
    return {
      ...base,
      preset: "page",
      permission: "files",
      bridge: { token: "required" },
      page: { id: "main", label: name, src: "web/index.html", paths: ["M6 4h9l3 3v13H6z", "M9 10h6"] },
      tool: {
        name: "parse_x",
        description: "把 .x 文件解析成 markdown（示范 files 权限下宿主怎么调本插件的工具）",
        runtime: "node",
        file: "tools/parse_x.js",
        parameters: { type: "object", properties: { filename: { type: "string" } } },
      },
      file_kind: {
        id: "x",
        label: "X 文件",
        ext: "x",
        paths: ["M6 4h9l3 3v13H6z", "M9 10h6"],
        tool: "parse_x",
      },
    };
  }
  if (kind === "net") {
    // preset 里不含 net：接外部服务是新权限，必须自己写出来（与 files 同一口径），
    // 这样"这个插件要往外连"在清单上一眼可见。令牌走 {setting:token}：包里不带密钥
    return {
      ...base,
      preset: "page",
      permission: "net",
      bridge: { token: "required" },
      page: { id: "main", label: name, src: "web/index.html", paths: ["M4 12h6", "M14 12h6", "M10 8h4v8h-4z"] },
      settings: {
        entries: [
          {
            id: "creds",
            label: "网关凭据",
            description: "外部 MCP 的访问令牌；连接里的 {setting:token} 取的就是这个键",
            kw: "令牌 token 网关 gateway 外部连接",
          },
        ],
      },
      connection: {
        name: "gateway",
        label: "外部 MCP 网关",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer {setting:token}" },
        auto_connect: true,
      },
    };
  }
  return {
    ...base,
    preset: "server",
    permission: "exec, workwith, storage",
    bridge: { token: "required" },
    server: "node server.js",
    page: { id: "main", label: name, src: "web/index.html", paths: ["M5 5h14v14H5z"] },
    interpreters: "node",
    tool: {
      name: "hello",
      description: "回显参数并回报本插件身份",
      runtime: "node",
      file: "tools/hello.js",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    },
  };
}

const PAGE_HTML = `<!DOCTYPE html>
<!-- SDK 由宿主自动注入（含本插件令牌），页面里直接用 window.Bit -->
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <title>插件页</title>
    <style>
      body { font: 14px/1.7 system-ui, sans-serif; margin: 20px; }
      .row { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid #eee; }
      .k { width: 120px; color: #888; flex: none; }
    </style>
  </head>
  <body>
    <h3>新插件</h3>
    <div id="out"></div>
    <script>
      const out = document.getElementById("out");
      const put = (k, v) => {
        const d = document.createElement("div");
        d.className = "row";
        d.innerHTML = '<span class="k"></span><span></span>';
        d.children[0].textContent = k;
        d.children[1].textContent = typeof v === "string" ? v : JSON.stringify(v);
        out.appendChild(d);
      };
      // Bit.boot：等握手落地再开工，页面开局读身份不会拿到 null
      Bit.boot(async (info) => {
        put("身份", info ? info.plugin_id : "未连上宿主");
        put("生效权限", (info && info.permissions) || []);
        put("能跑 exec 吗", Bit.can("exec"));
        const rs = await Bit.runtime.list();
        put("本机解释器", rs.map((r) => r.id).slice(0, 8));
        await Bit.data.writeJSON("page.json", { at: Date.now() });
        put("写自己的数据目录", "page.json 已写入");
      });
    </script>
  </body>
</html>
`;

const WORKER_JS = `// 常驻服务：require("bit") 由宿主物化在 toolhomes/node_modules/bit，
// 插件包在它下面一层，Node 沿目录往上找就能命中——不需要配任何路径。
const bit = require("bit");

async function tick() {
  const info = await bit.info();
  await bit.data.writeJSON("last-tick.json", { at: new Date().toISOString(), plugin: info.plugin_id });
  bit.log("已写 last-tick.json");
}

tick().catch((e) => bit.error("首次执行失败:", e.message));
setInterval(() => tick().catch((e) => bit.warn(e.message)), 60000);
`;

const TOOL_JS = `// 解释器工具：stdin 收 JSON 参数，stdout 出 JSON 结果，日志走 stderr。
// 工具的源码会被宿主写进临时文件执行，所以这里用 require（ESM 不认 NODE_PATH）。
const bit = require("bit");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  const params = (() => {
    try {
      return JSON.parse(raw || "{}");
    } catch (e) {
      return {};
    }
  })();
  const info = await bit.info();
  process.stdout.write(
    JSON.stringify({
      echo: params.text || "",
      plugin: info.plugin_id,
      perms: info.permissions,
      runtimes: (await bit.runtime.list()).map((r) => r.id).slice(0, 8),
    })
  );
});
`;

const SERVER_JS = `// 自带服务器（ESM）：import bit from "bit" 与 require 同一份实现
import http from "http";
import bit from "bit";

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (req.url === "/health") return res.end(JSON.stringify({ ok: true, plugin: bit.env.id }));
  const info = await bit.info();
  res.end(JSON.stringify({ info, can_exec: bit.can("exec") }));
});

server.listen(bit.env.port || Number(process.env.BIT_PLUGIN_PORT || 0), "127.0.0.1", () => bit.log("在听", bit.env.port));
`;

const KIND_PAGE_HTML = `<!DOCTYPE html>
<!-- SDK 由宿主自动注入（含本插件令牌），页面里直接用 window.Bit -->
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <title>文件类型页</title>
    <style>
      body { font: 14px/1.7 system-ui, sans-serif; margin: 20px; }
      table { border-collapse: collapse; }
      th, td { border-bottom: 1px solid #eee; padding: 4px 10px; text-align: left; }
      .muted { color: #888; }
    </style>
  </head>
  <body>
    <h3>本插件认领的文件类型</h3>
    <p class="muted">核心已能读的类型（pdf/xlsx/docx…）插件抢不到，只允许补宿主不会读的新类型。</p>
    <div id="out">读取中…</div>
    <script>
      const out = document.getElementById("out");
      Bit.boot(async () => {
        const kinds = await Bit.files.kinds();
        if (!kinds.length) {
          out.textContent = "没有认领任何文件类型（权限没开，或清单没写 file_kinds）";
          return;
        }
        const t = document.createElement("table");
        t.innerHTML = "<tr><th>id</th><th>扩展名</th><th>解析工具</th></tr>";
        for (const k of kinds) {
          const tr = document.createElement("tr");
          tr.innerHTML = "<td></td><td></td><td></td>";
          tr.children[0].textContent = k.id;
          tr.children[1].textContent = k.exts.join(" ");
          tr.children[2].textContent = k.tool || "只换图标，不解析";
          t.appendChild(tr);
        }
        out.replaceChildren(t);
        await Bit.data.writeJSON("kinds.json", { at: Date.now(), kinds });
      });
    </script>
  </body>
</html>
`;

const PARSE_X_JS = `// 解析工具：宿主把文件交给本插件声明的这个工具，参数走 stdin，结果走 stdout。
// 小文件给 base64，大文件给 path（绝对路径，读它、别写它）。
// 返回二选一：{"text": "…"} 直接当正文，{"file": "相对插件目录的路径"} 让宿主读回大正文。
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const p = (() => {
    try {
      return JSON.parse(raw || "{}");
    } catch (e) {
      return {};
    }
  })();
  const body = p.path
    ? require("fs").readFileSync(p.path, "utf8")
    : Buffer.from(p.base64 || "", "base64").toString("utf8");
  const lines = body.split(/\\r?\\n/).filter((s) => s.trim());
  const head = lines.filter((s) => s.startsWith("#"));
  process.stdout.write(
    JSON.stringify({
      text: [
        (p.filename || "unknown.x") + " · " + lines.length + " 行",
        ...head.map((s) => \`- \${s.replace(/^#+ */, "")}\`),
      ].join("\\n"),
    })
  );
});
`;

const SAMPLE_X = `# 这是 .x 文件的标题
# 第二个小节
正文随便写几行，解析工具会把它收成 markdown 列表。
`;

const NET_PAGE_HTML = `<!DOCTYPE html>
<!-- SDK 由宿主自动注入（含本插件令牌），页面里直接用 window.Bit -->
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <title>连接台</title>
    <style>
      body { font: 14px/1.7 system-ui, sans-serif; margin: 20px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; font-size: 13px; }
      code { font-family: ui-monospace, Consolas, monospace; }
      #status { color: #6b7280; }
    </style>
  </head>
  <body>
    <h3>本插件声明的外部 MCP 连接</h3>
    <p id="status">正在与宿主握手…</p>
    <table>
      <thead><tr><th>名称</th><th>地址</th><th>请求头</th><th>状态</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <script>
      (async function () {
        const info = await window.Bit.ready();
        const status = document.getElementById("status");
        const rows = document.getElementById("rows");
        status.textContent = info ? "已连上宿主：" + info.plugin_id : "未连上宿主";
        const draw = async () => {
          let list = [];
          try {
            list = await window.Bit.net.connections();
          } catch (e) {
            status.textContent = "读取连接失败：" + (e && e.message ? e.message : e);
            return;
          }
          rows.textContent = "";
          for (const c of list) {
            const tr = document.createElement("tr");
            const btn = document.createElement("button");
            btn.textContent = c.connected ? "断开" : "连接";
            btn.disabled = !c.granted;
            btn.onclick = async () => {
              try {
                if (c.connected) await window.Bit.net.disconnect(c.name);
                else await window.Bit.net.connect(c.name);
              } catch (e) {
                status.textContent = c.name + " 失败：" + (e && e.message ? e.message : e);
              }
              await draw();
            };
            const state =
              c.connected ? "已连接 · " + c.tools + " 个工具"
              : (c.missing_settings || []).length ? "待填设置：" + c.missing_settings.join(", ")
              : "未连接";
            tr.innerHTML =
              "<td>" + c.label + "</td><td><code></code></td><td>" + ((c.header_names || []).join(", ") || "—") + "</td>";
            tr.querySelector("code").textContent = c.url_template;
            const st = document.createElement("td");
            st.textContent = state;
            const act = document.createElement("td");
            act.appendChild(btn);
            tr.append(st, act);
            rows.appendChild(tr);
          }
        };
        await draw();
      })();
    </script>
  </body>
</html>
`;

function filesFor(kind, name) {
  const f = { "plugin.json": JSON.stringify(manifest(name, kind), null, 2) + "\n" };
  if (kind === "page" || kind === "full") f["web/index.html"] = PAGE_HTML;
  if (kind === "net") f["web/index.html"] = NET_PAGE_HTML;
  if (kind === "filekind") {
    f["web/index.html"] = KIND_PAGE_HTML;
    f["tools/parse_x.js"] = PARSE_X_JS;
    f["samples/demo.x"] = SAMPLE_X;
  }
  if (kind === "service") f["svc/worker.js"] = WORKER_JS;
  if (kind === "tool" || kind === "full") f["tools/hello.js"] = TOOL_JS;
  if (kind === "full") f["server.js"] = SERVER_JS;
  f["README.md"] = `# ${kind} 型插件（plugin-init 生成）

装法：把本目录放进 \`<数据目录>/toolhomes/plugins/\`，在「设置 → 插件」点重新扫描。
验法：\`invoke("list_plugins")\` 里应出现本插件且 \`verify:"verified"\`。

进程侧（服务/工具）用 \`require("bit")\` / \`import bit from "bit"\` 回连宿主能力，
页面侧用注入的 \`window.Bit\`；两边同一套方法名。能力清单：\`await Bit.caps()\`。
权限位与简写口径见仓库里的 \`plugins/README.md\`。
`;
  return f;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    return;
  }
  const name = slug(a.name);
  if (!name) {
    console.log(HELP);
    console.error("\n缺少 --name");
    process.exit(2);
  }
  const kind = a.kind || "page";
  if (!KINDS.includes(kind)) {
    console.error(`--kind 只认 ${KINDS.join(" / ")}`);
    process.exit(2);
  }
  const root = guardDest(path.join(a.dest, name));
  if (fs.existsSync(root) && fs.readdirSync(root).length && !a.force) {
    console.error(`目标已存在且非空：${root}\n（要覆盖加 --force）`);
    process.exit(2);
  }
  const files = filesFor(kind, name);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  console.log(`已生成 ${kind} 型插件：${root}`);
  for (const rel of Object.keys(files)) console.log(`  ${rel}`);
  console.log(`\n装起来看：把该目录拷进 <数据目录>/toolhomes/plugins/ 后在「设置 → 插件」点重新扫描。`);
}

main();
