// 插件套件真机验收：把 plugins/ 里的每一个扩展面在跑起来的 Electron 上踩一遍。
//
// 用法：node e2e/plugin-suite-probe.cjs [http://127.0.0.1:<CDP端口>] [--data <BIT_DATA_DIR>] [--shots <目录>]
//   --data 给了才做「定时任务落盘」这类磁盘侧断言（只读，不写）
//   --shots 截图目录，默认 Temp/bit-shots-plugin
//
// 断言分八组：闸门拒收 / 工具链 / 定时任务 / 页面与图标注入 / 接管 / 服务器与托管服务 / 能力与令牌 / 界面实据。
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const argAt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const CDP = argv[0] && !argv[0].startsWith("--") ? argv[0] : "http://127.0.0.1:9333";
const DATA = argAt("data", "");
const SHOTS = argAt("shots", "C:/Users/User/AppData/Local/Temp/bit-shots-plugin");
const WATCHDOG_MS = Number(argAt("budget", 420)) * 1000;

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => {
  console.log("WATCHDOG 超时，探针自杀");
  process.exit(3);
}, WATCHDOG_MS).unref();

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : " :: " + String(detail).slice(0, 300)}`);
};

// ── 套件预期（与 plugins/ 下的清单一一对应；改清单必须同步这里）──
const VALID = [
  "biz-alerts", "biz-caps-exec", "biz-crm", "biz-filekind", "biz-heavy-tools", "biz-inventory", "biz-net", "biz-notes", "biz-price-watcher",
  "biz-sessions", "biz-takeover-voice", "biz-takeover-zip", "dash-kanban", "neton-lan", "sdk-sugar", "srv-dashboard", "svc-crash",
  "svc-mcp-stdio", "svc-sync", "ui-terminal", "ui-theme",
];
const INVALID = {
  "bad-bridge": 'requires "bridge"',
  "bad-bridge-value": 'bridge.token must be "required"',
  "bad-filekind-core": "is already parsed by the host",
  "bad-filekind-perm": 'file_kinds declared but missing permission "files"',
  "bad-icon-action": "unknown action",
  "bad-icons": "too many chat_icons: 5 (max 4)",
  "bad-job": "bad schedule",
  "bad-json": "bad-json:",
  "bad-mcp-mode": "mcp_mode only supports http / stdio",
  "bad-net-dup": "connection name duplicated",
  "bad-net-header": "bad header name",
  "bad-net-perm": 'connections declared but missing permission "net"',
  "bad-net-scheme": "url must be http(s)",
  "bad-net-template": "bad {setting:KEY} placeholder",
  "bad-no-manifest": "plugin.json missing or unreadable",
  "bad-page-path": "path escapes plugin dir",
  "bad-page-perm": 'pages declared but missing permission "page"',
  "bad-perm": "unknown permission: root",
  "bad-preset": 'unknown preset "magic"',
  "bad-interpreters": 'interpreters declared but missing permission "exec"',
  "bad-server-perm": 'server declared but missing permission "server"',
  "bad-service": "program not found",
  "bad-takeover": "unknown takeover slot",
  "bad-takeover-settings": "cannot be taken over",
  "bad-tool-noruntime": "interpreter kind requires runtime",
  "bad-ui-file": "ui file not found: ui/missing.js",
  "bad-ui-perm": 'ui.js declared but missing permission "js"',
};
const EXPECT_TOOLS = {
  "biz-price-watcher": ["price_stats", "quote_digest", "last_snapshot"],
  "biz-inventory": ["stock_check", "reorder_advice"],
  "biz-crm": ["next_action"],
  "biz-notes": ["note_stats"],
  "biz-caps-exec": ["env_probe"],
  "biz-filekind": ["parse_fz"],
  "sdk-sugar": ["sdk_probe"],
  "biz-heavy-tools": ["ticker_normalize", "weighted_price", "risk_score", "calendar_days", "fx_convert", "pipeline_health"],
};
const EXPECT_ICONS = 9; // 清单里申报 chaticon 的图标总数（与 plugins/ 各包一致）
// 托管服务条目 id = psvc-<sanitize(插件id)>-<sanitize(服务名)>，sanitize 把连字符换成下划线
const SVC_IDS = ["psvc-svc_sync-replicator", "psvc-svc_sync-indexer", "psvc-svc_mcp_stdio-bridge", "psvc-svc_crash-watchdog"];

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => /index\.html/.test(p.url()));
    if (!page) await sleep(300);
  }
  if (!page) throw new Error("找不到渲染进程，实例起来了吗？");
  await page.setViewportSize({ width: 1440, height: 920 });

  // 所有调用都从渲染进程走同一条桥（window.__TAURI_INTERNALS__.invoke），
  // 这样验的是「应用里真能调通」，不是探针自己另开一条后门。
  const rpc = async (cmd, args) =>
    page.evaluate(
      async ([c, a]) => {
        try {
          return { ok: true, data: await window.__TAURI_INTERNALS__.invoke(c, a || {}) };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      [cmd, args || {}]
    );
  const call = async (cmd, args) => {
    const r = await rpc(cmd, args);
    if (!r.ok) throw new Error(`${cmd} 调用失败：${r.error}`);
    return r.data;
  };

  console.log("== 0. 预备 ==");
  await call("set_tool_approval", { mode: "allow_all" }); // 驱动里要跑工具，先把审批放开
  const scan = await call("refresh_plugins", {});
  check("refresh_plugins 认到插件", scan && scan.count >= VALID.length, `count=${scan && scan.count}`);
  // 解释器工具靠注册表里的 runtime id 起进程；空数据目录从没点过「工具」页，注册表是空的，
  // 这里先跑一次和工具页同一个探测命令，否则套件会假报「Runtime not registered」。
  const rt = await call("refresh_runtimes", {});
  const rtList = rt.runtimes || [];
  const rtIds = rtList.map((r) => `${r.id}:${r.enabled === false ? "off" : "on"}`);
  const missingRt = [
    ["node", (r) => r.id === "node" || r.lang === "js"],
    ["python", (r) => r.lang === "py"],
  ].filter(([, hit]) => !rtList.some(hit)).map(([name]) => name);
  check("探测到解释器（node + python）", missingRt.length === 0, missingRt.join(",") || rtIds.join(","));

  console.log("== 1. 闸门：负面夹具必须整体拒收 ==");
  let lp = await call("list_plugins", {});
  const errs = (lp.errors || []).join("\n");
  for (const [id, needle] of Object.entries(INVALID)) {
    const line = (lp.errors || []).find((x) => x.startsWith(`${id}:`));
    check(`夹具 ${id} 被拒`, line && line.includes(needle), line || "没出现在错误列表里");
  }
  const byId = Object.fromEntries((lp.plugins || []).map((p) => [p.id, p]));
  const missing = VALID.filter((id) => !byId[id]);
  check(`${VALID.length} 个正例插件全部加载`, missing.length === 0, missing.join(",") || "齐");
  const notVerified = VALID.filter((id) => byId[id] && byId[id].verify !== "verified");
  check("正例插件都通过安全校验", notVerified.length === 0, notVerified.map((i) => `${i}:${byId[i].verify}`).join(",") || "全 verified");
  check("清单目录在 toolhomes 下", String(lp.dir || "").replace(/\\/g, "/").endsWith("/toolhomes/plugins"), lp.dir);
  // 套件踩出来的宿主缺陷：只写 all 的插件曾被 ui/server/pages 三道清单闸门当成"缺权限"整体拒载
  const wide = byId["biz-heavy-tools"];
  check("all 通配位过得了全部清单闸门", !!wide && wide.verify === "verified" && (wide.pages || []).length === 1 && (wide.tools || []).length === 6, JSON.stringify(wide && { verify: wide.verify, pages: (wide.pages || []).length, tools: (wide.tools || []).length }));
  check("all 在判定侧展开成逐项权限", !!wide && (wide.permissions || []).includes("css") && (wide.permissions || []).includes("exec") && (wide.declared_permissions || []).join() === "all", JSON.stringify({ granted: (wide && wide.permissions || []).length, declared: wide && wide.declared_permissions }));

  console.log("== 2. 工具执行链（三种解释器 + Rhai 沙盒）==");
  const tools = await call("list_tools", {});
  const toolList = Array.isArray(tools) ? tools : tools.tools || [];
  const pluginToolIds = toolList.filter((t) => String(t.id || "").startsWith("plugin:"));
  let expectCount = 0;
  for (const names of Object.values(EXPECT_TOOLS)) expectCount += names.length;
  check("插件工具都进了工具表", pluginToolIds.length >= expectCount, `${pluginToolIds.length} / 期望≥${expectCount}`);
  for (const [pid, names] of Object.entries(EXPECT_TOOLS)) {
    const absent = names.filter((n) => !pluginToolIds.some((t) => t.id === `plugin::${pid}::${n}`));
    check(`工具登记 ${pid}`, absent.length === 0, absent.join(",") || names.join(","));
  }

  const invoke = async (pid, tool, params) => {
    const r = await rpc("invoke_tool", { id: `plugin::${pid}::${tool}`, params: params || {} });
    return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
  };
  const price = await invoke("biz-price-watcher", "price_stats", {
    items: [{ sku: "A1", price: 10 }, { sku: "A2", price: 12 }, { sku: "A3", price: 88 }],
    volatility_threshold: 0.15,
  });
  check("python 工具 price_stats", price.ok && price.data.ok && price.data.count === 3, JSON.stringify(price.data || price.error));
  check("python 中文输出没乱码", price.ok && /复核项/.test(price.data.verdict || ""), (price.data && price.data.verdict) || "");

  const apiBase = (await call("get_plugin_pages", {})).api || "";
  check("宿主插件 API 基址就绪", /^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase), apiBase);
  const digest = await invoke("biz-price-watcher", "quote_digest", { items: [{ sku: "A1", price: 1 }], limit: 2, health_url: `${apiBase}/health` });
  check("Rhai 工具 quote_digest", digest.ok && digest.data.count === 1 && /"status":200/.test(String(digest.data.probe)), JSON.stringify(digest.data || digest.error).slice(0, 220));
  const crm = await invoke("biz-crm", "next_action", { note: "客户急着要签约，明天回报价" });
  check("Rhai 分级 next_action", crm.ok && crm.data.grade === "A" && crm.data.signals.length >= 2, JSON.stringify(crm.data || crm.error));

  const stock = await invoke("biz-inventory", "stock_check", { system: [{ sku: "K-01", qty: 10 }], counted: [{ sku: "K-01", qty: 7 }] });
  check("node 工具 stock_check", stock.ok && stock.data.mismatched === 1 && stock.data.top[0].diff === 3, JSON.stringify(stock.data || stock.error));
  const reorder = await invoke("biz-inventory", "reorder_advice", { items: [{ sku: "K-01", stock: 2, safety: 5, daily_sales: 1 }], lead_days: 3 });
  check("python 工具 reorder_advice", reorder.ok && reorder.data.count === 1 && reorder.data.orders[0].order_qty >= 6, JSON.stringify(reorder.data || reorder.error));

  const heavy = {
    ticker_normalize: { codes: ["600519", "000858"] },
    weighted_price: { rows: [{ price: 100, weight: 0.5 }, { price: 60, weight: 0.5 }] },
    risk_score: { volatility: 0.2, drawdown: 0.1 },
    calendar_days: { from: "2026-11-02", to: "2026-11-13" },
    fx_convert: { amount: 8, rate: 7.1 },
    pipeline_health: {},
  };
  for (const [tool, params] of Object.entries(heavy)) {
    const r = await invoke("biz-heavy-tools", tool, params);
    check(`all 通配插件的工具 ${tool}`, r.ok && r.data && r.data.ok !== false, JSON.stringify(r.data || r.error).slice(0, 180));
  }
  const env = await invoke("biz-caps-exec", "env_probe", {});
  check("解释器工作目录是 toolhomes", env.ok && /toolhomes/.test(env.data.cwd || ""), env.data && env.data.cwd);

  console.log("== 3. 定时任务（every 30s 的心跳必须真的跑起来）==");
  let beat = null;
  for (let i = 0; i < 24 && !beat; i++) {
    const audit = await call("list_audit", {}).catch(() => ({ entries: [] }));
    const rows = Array.isArray(audit) ? audit : audit.entries || [];
    beat = rows.find((a) => String(a.action || "").includes("plugin.job") && String(a.target || "").includes("biz-price-watcher/heartbeat"));
    if (!beat) await sleep(5000);
  }
  check("心跳任务跑过并留审计", !!beat, beat ? `${beat.target} @ ${beat.ts || ""}` : "90 秒内没等到 plugin.job");
  if (DATA) {
    const file = path.join(DATA, "toolhomes", "biz_pricewatch_heartbeat.json");
    const exists = fs.existsSync(file);
    const parsed = exists ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    check("心跳产物落到 toolhomes", exists && Number(parsed.runs) >= 1, exists ? `runs=${parsed.runs}` : file);
    const snap = await invoke("biz-price-watcher", "last_snapshot", {});
    const hb = (snap.data || {}).heartbeat || {};
    // 心跳任务 every 30s，装完目录就会跑；日快照任务 daily 09:00，未到点时工具必须给出干净的回落文案。
    check("工具读得到心跳任务产物（接力成立）", Number(hb.runs) >= 1 && /toolhomes/.test(String(hb.cwd || "")), JSON.stringify(hb).slice(0, 160));
    const dailyDue = new Date().getHours() >= 9;
    if (dailyDue) {
      check("工具读得到日快照产物", snap.ok && snap.data && snap.data.ok && (snap.data.snapshot || {}).count === 5, JSON.stringify(snap.data || snap.error).slice(0, 160));
    } else {
      const fallback = !snap.ok || snap.data.ok === false;
      check("日快照未到点时工具干净回落", fallback && /还没有快照/.test(String((snap.data || {}).error || snap.error)), JSON.stringify(snap.data || snap.error).slice(0, 160));
    }
  } else {
    console.log("SKIP 磁盘侧断言（没给 --data）");
  }

  console.log("== 4. 页面 / 对话页图标 / 设置注入 ==");
  const pages = await call("get_plugin_pages", {});
  const pkeys = (pages.pages || []).map((p) => p.key);
  const wantKeys = ["biz-price-watcher:board", "biz-inventory:stock", "biz-crm:followup", "dash-kanban:board", "dash-kanban:timeline", "biz-alerts:alerts", "biz-notes:notes", "biz-caps-exec:ops", "biz-sessions:tickets", "biz-takeover-voice:voice", "biz-takeover-zip:dock", "biz-takeover-zip:preview", "biz-heavy-tools:flow"];
  const absentKeys = wantKeys.filter((k) => !pkeys.includes(k));
  check("清单页面全部注册", absentKeys.length === 0, absentKeys.join(",") || `${pkeys.length} 个`);
  const withGlyph = (pages.pages || []).filter((p) => Array.isArray(p.paths) && p.paths.length);
  check("自定义字形随页面下发", withGlyph.length >= wantKeys.length, `${withGlyph.length}/${(pages.pages || []).length}`);
  const tokened = (pages.pages || []).every((p) => p.frame && /bit_token=/.test(p.frame) && p.token);
  check("每个帧地址都带令牌", tokened, (pages.pages || [])[0] && (pages.pages || [])[0].frame);
  check("状态面板单独下发", (pages.status || []).length >= 2, JSON.stringify((pages.status || []).map((s) => s.key)));
  const dyn = (pages.pages || []).find((p) => p.plugin_id === "srv-dashboard");
  check("动态页指向插件服务器端口", !!dyn && /127\.0\.0\.1/.test(dyn.frame || "") && dyn.kind === "server", dyn && dyn.frame);

  const icons = await call("get_plugin_chat_icons", {});
  check(`对话页图标登记 ${EXPECT_ICONS} 颗`, (icons.icons || []).length === EXPECT_ICONS, `${(icons.icons || []).length} 颗：${(icons.icons || []).map((i) => i.key).join(",")}`);
  const settingsView = await call("get_plugin_settings", {});
  const cards = (settingsView.plugins || []).flatMap((p) => p.entries || []);
  check("设置中心条目注入", cards.length >= 6, `${cards.length} 条：${cards.map((c) => c.label).join("/")}`);
  const ownSettingsPage = (settingsView.plugins || []).find((p) => p.page);
  check("独立设置页注入（iframe 型）", !!ownSettingsPage, ownSettingsPage && ownSettingsPage.page.key);

  const ui = await call("get_plugin_ui", {});
  const uiIds = (ui.plugins || []).map((p) => p.id);
  check("UI 资源包只发给申报了 css/js 的插件", ["ui-theme", "ui-terminal", "biz-heavy-tools"].every((i) => uiIds.includes(i)) && !uiIds.includes("biz-notes"), uiIds.join(","));

  console.log("== 5. 接管：同槽位按 id 字典序，设置类永不可接管 ==");
  const to = await call("get_plugin_takeovers", {});
  const claims = to.claims || [];
  const owner = claims.find((c) => c.slot === "chat.voice" && c.effective);
  const loser = claims.find((c) => c.slot === "chat.voice" && c.effective === false);
  check("语音槽位归属 biz-takeover-voice", owner && owner.plugin_id === "biz-takeover-voice", JSON.stringify(owner));
  check("冲突方如实标记 ineffective", loser && loser.plugin_id === "biz-takeover-zip", JSON.stringify(loser));
  for (const slot of ["chat.preview", "chat.attach"]) {
    const c = claims.find((x) => x.slot === slot && x.effective);
    check(`${slot} 由附件坞接管`, c && c.plugin_id === "biz-takeover-zip", JSON.stringify(c));
  }
  check("接管槽位目录含 7 项", (to.slots || []).length === 7, (to.slots || []).map((s) => s.id).join(","));
  check("目录里没有设置槽位", !(to.slots || []).some((s) => /settings/.test(s.id)), "");

  console.log("== 6. 服务器与托管服务（含 MCP 接入与实时日志）==");
  lp = await call("list_plugins", {});
  const byId2 = Object.fromEntries((lp.plugins || []).map((p) => [p.id, p]));
  const srv = byId2["srv-dashboard"].server || {};
  check("srv-dashboard 服务器已就绪", srv.running === true && srv.port > 0, JSON.stringify(srv).slice(0, 200));
  let health = null;
  for (let i = 0; i < 20 && !health; i++) {
    try {
      health = await (await fetch(`http://127.0.0.1:${srv.port}/health`)).json();
    } catch {
      await sleep(700);
    }
  }
  check("插件服务器 /health 应答", !!health && health.ok === true, JSON.stringify(health || {}).slice(0, 200));
  let capSelf = null;
  for (let i = 0; i < 20 && !capSelf; i++) {
    try {
      capSelf = await (await fetch(`http://127.0.0.1:${srv.port}/api/cap-self`)).json();
      if (capSelf.info && capSelf.info.error) capSelf = null;
    } catch {
      await sleep(700);
    }
  }
  check("进程侧 HTTP /cap 回连宿主", !!capSelf && capSelf.info && capSelf.info.plugin_id === "srv-dashboard", JSON.stringify(capSelf || {}).slice(0, 240));
  check("进程侧能读到自己的能力与数据", !!capSelf && Array.isArray(capSelf.caps && capSelf.caps.caps) && capSelf.caps.caps.length > 0 && !capSelf["data.list"].error, JSON.stringify((capSelf || {}).caps || {}).slice(0, 160));
  const logs = await call("plugin_server_logs", { id: "srv-dashboard", tail: 40 });
  // 缓冲是定长的环形表：实例跑久了，开机的「监听」行会被后面的请求行挤出去，
  // 所以判据是「拿到本服务自己的行」，开机行只在还留着的时候顺带认一下
  const logText = JSON.stringify(logs);
  check("服务器实时日志可读", /\[srv-dashboard\]/.test(logText) && (logs.logs || []).length > 0, logText.slice(0, 200));

  const svcRows = (byId2["svc-sync"].services || []).concat(byId2["svc-mcp-stdio"].services || [], byId2["svc-crash"].services || []);
  check("清单服务登记进 WorkWith", svcRows.length === 4, svcRows.map((s) => `${s.id}:${s.running ? "run" : "off"}`).join(","));
  check("服务条目 id 走 sanitize 规则", SVC_IDS.every((id) => svcRows.some((s) => s.id === id)), svcRows.map((s) => s.id).join(","));
  const ww = await call("list_workwith", {});
  const wwList = Array.isArray(ww) ? ww : ww.entries || ww.list || [];
  const declared = wwList.filter((e) => String(e.id || "").startsWith("psvc-"));
  check("声明式条目带令牌与端口环境", declared.length >= 4 && declared.every((e) => e.env && e.env.BIT_PLUGIN_TOKEN && e.env.BIT_PLUGIN_ID), `${declared.length} 条`);
  const started = svcRows.filter((s) => s.running).map((s) => s.id);
  check("replicator / indexer / bridge 自启", ["psvc-svc_sync-replicator", "psvc-svc_sync-indexer", "psvc-svc_mcp_stdio-bridge"].every((id) => started.includes(id)), started.join(","));
  let mcpTools = [];
  for (let i = 0; i < 10 && mcpTools.length < 4; i++) {
    const t = await call("list_tools", {});
    const list = Array.isArray(t) ? t : t.tools || [];
    mcpTools = list.filter((x) => /index_stats|search_docs|device_list|device_ping/.test(String(x.name || "")));
    if (mcpTools.length < 4) await sleep(2000);
  }
  check("MCP 服务被接入并导入工具", mcpTools.length >= 4, mcpTools.map((t) => t.name).join(","));
  const crash = byId2["svc-crash"];
  check("崩溃服务被登记为异常（页眉异常灯）", crash.health && /crash|exit|退出/.test(JSON.stringify(crash.health)), JSON.stringify(crash.health || {}));
  const ph = await call("plugin_health", {});
  check("plugin_health 里有 svc-crash", JSON.stringify(ph).includes("svc-crash"), String(JSON.stringify(ph)).slice(0, 200));

  console.log("== 7. 能力闸门与令牌 ==");
  const capCall = (id, verb, payload) => rpc("plugin_cap_call", { id, verb, payload: payload || {} });
  const dw = await capCall("biz-notes", "data.write", { path: "probe/hello.md", text: "# 探针写入\n" });
  check("data.write 放行", dw.ok, dw.error);
  const dr = await capCall("biz-notes", "data.read", { path: "probe/hello.md" });
  check("data.read 读回（含子目录）", dr.ok && /探针写入/.test(dr.data.text || ""), dr.error || (dr.data || {}).text);
  const dl = await capCall("biz-notes", "data.list", {});
  check("data.list 递归列到子目录", dl.ok && (dl.data.files || []).some((f) => f.path.replace(/\\/g, "/") === "probe/hello.md"), JSON.stringify((dl.data || {}).files || []));
  const deniedExec = await capCall("biz-notes", "exec.run", { command: "echo nope" });
  check("未申报 exec 被拒", !deniedExec.ok && /exec/.test(deniedExec.error || ""), deniedExec.error);
  const deniedWrite = await capCall("biz-crm", "fs.write", { path: "x.txt", text: "1" });
  check("未申报 write 被拒", !deniedWrite.ok && /write/.test(deniedWrite.error || ""), deniedWrite.error);
  const deniedVerb = await capCall("biz-notes", "made.up", {});
  check("未知能力动词被拒", !deniedVerb.ok && /未知能力/.test(deniedVerb.error || ""), deniedVerb.error);
  const ex = await capCall("biz-caps-exec", "exec.run", { program: "node", args: ["-v"] });
  check("exec.run 用 program 起进程", ex.ok && (ex.data.code === 0 || /v\d+/.test(String(ex.data.stdout))), JSON.stringify(ex.data || ex.error).slice(0, 180));
  const exBad = await capCall("biz-caps-exec", "exec.run", { command: "echo a", program: "node" });
  check("exec.run 二选一约束", !exBad.ok && /只能提供一个/.test(exBad.error || ""), exBad.error);
  const fw = await capCall("biz-caps-exec", "fs.write", { path: "probe/fs.txt", text: "fs-ok" });
  const fr = await capCall("biz-caps-exec", "fs.read", { path: "probe/fs.txt" });
  check("fs.write/fs.read 成对可用", fw.ok && fr.ok && fr.data.text === "fs-ok", fr.error || (fr.data || {}).text);
  const mv = await capCall("biz-caps-exec", "fs.move", { from: "probe/fs.txt", to: "probe/fs2.txt" });
  const rm = await capCall("biz-caps-exec", "fs.remove", { path: "probe/fs2.txt", recursive: false });
  check("fs.move / fs.remove 可用", mv.ok && rm.ok, `${mv.error || ""} ${rm.error || ""}`);
  const sappend = await capCall("biz-sessions", "session.append", { role: "user", content: "探针：工单 P2 - 验收写入" });
  check("session.append 写进插件命名空间", sappend.ok && /^plugin:biz-sessions/.test(sappend.data.session_id || ""), JSON.stringify(sappend.data || sappend.error));
  const slist = await capCall("biz-sessions", "session.list", {});
  check("session.list 只看得到自己的", slist.ok && (slist.data.sessions || []).length >= 1 && (slist.data.sessions || []).every((s) => s.session_id.startsWith("plugin:biz-sessions")), JSON.stringify((slist.data || {}).sessions || []).slice(0, 200));
  const cross = await capCall("biz-crm", "session.append", { role: "user", content: "越界", session_id: "plugin:biz-sessions" });
  check("跨插件写入被宿主拒绝", !cross.ok && /归属本插件/.test(cross.error || ""), JSON.stringify(cross.data || cross.error));
  const own2 = await capCall("biz-crm", "session.append", { role: "user", content: "探针：客户回访 - 自己的命名空间" });
  check("另一枚插件写进自己的命名空间", own2.ok && /^plugin:biz-crm/.test(own2.data.session_id || ""), JSON.stringify(own2.data || own2.error));

  // 静态页 HTTP 闸门：没令牌不给发，带令牌才发且注入 SDK
  const tokFor = (pages.pages || []).find((p) => p.key === "biz-notes:notes");
  const rel = "web/notes.html";
  const noTok = await fetch(`${apiBase}/p/biz-notes/${rel}`).catch((e) => ({ error: String(e) }));
  check("静态页无令牌被拒", noTok.status === 401 || noTok.status === 403, `status=${noTok.status}`);
  const withTok = await fetch(`${apiBase}/p/biz-notes/${rel}?bit_token=${encodeURIComponent(tokFor.token)}`).catch((e) => ({ error: String(e) }));
  const body = withTok.text ? await withTok.text() : "";
  check("静态页带令牌可读且注入 SDK", withTok.status === 200 && body.includes('src="/sdk.js"'), `status=${withTok.status} len=${body.length}`);
  const badTok = await fetch(`${apiBase}/p/biz-notes/${rel}?bit_token=nope`).catch(() => null);
  check("静态页假令牌被拒", badTok && (badTok.status === 401 || badTok.status === 403), `status=${badTok && badTok.status}`);
  const traverse = await fetch(`${apiBase}/p/biz-notes/..%2f..%2fplugin.json?bit_token=${encodeURIComponent(tokFor.token)}`).catch(() => null);
  check("静态页路径穿越被挡", !traverse || traverse.status >= 400, `status=${traverse && traverse.status}`);
  const noAuth = await fetch(`${apiBase}/cap`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"verb":"info","payload":{}}' }).catch(() => null);
  check("HTTP /cap 无令牌被拒", noAuth && (noAuth.status === 401 || noAuth.status === 403), `status=${noAuth && noAuth.status}`);

  console.log("== 8. 界面实据（样式注入 / JS 页 / 图标上屏 / 接管后内置按钮消失）==");
  const dom = await page.evaluate(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const root = document.getElementById("root");
    return {
      styles: q("style[data-bit-plugin]"),
      tint: root ? getComputedStyle(root).getPropertyValue("--bit-ui-theme-tint").trim() : "",
      heavy: document.documentElement.getAttribute("data-bit-plugin-heavy-tools") || "",
      navPlugin: [...document.querySelectorAll("nav [data-bit-icon-id], [data-bit-icon-id]")]
        .map((e) => e.getAttribute("data-bit-icon-id"))
        .filter(Boolean),
    };
  });
  check("css 注入标记存在", dom.styles >= 3, `style[data-bit-plugin]=${dom.styles}`);
  check("ui-theme 变量落到 #root", dom.tint === "1", `--bit-ui-theme-tint=${dom.tint}`);
  check("all 通配插件的 JS 入口跑过", dom.heavy === "loaded", dom.heavy);
  await page.screenshot({ path: path.join(SHOTS, "01-chat-icons.png") });

  // 打开插件页：清单静态页、JS 注册的 React 页各一张，截图留证
  const openTab = async (key) => {
    await page.evaluate((k) => window.dispatchEvent(new CustomEvent("bit-open-page", { detail: { page: k } })), key);
    await sleep(2200);
  };
  await openTab("biz-price-watcher:board");
  let frame = page.frames().find((f) => /\/p\/biz-price-watcher\/web\/board\.html/.test(f.url()));
  check("清单静态页 iframe 挂载", !!frame, page.frames().map((f) => f.url()).filter((u) => u.includes("/p/")).join(","));
  if (frame) {
    await frame.waitForTimeout(1500);
    const who = await frame.locator("#who").textContent().catch(() => "");
    check("页面 SDK 握手成功", /令牌已就绪/.test(who || ""), who);
    await frame.locator("#scan").click();
    await frame.waitForTimeout(900);
    const msg = await frame.locator("#msg").textContent();
    check("页面写数据目录并算出复核项", /复核 \d+ 个/.test(msg || ""), msg);
    await page.screenshot({ path: path.join(SHOTS, "02-page-board.png") });
  }
  await openTab("biz-caps-exec:ops");
  frame = page.frames().find((f) => /\/p\/biz-caps-exec\/web\/ops\.html/.test(f.url()));
  if (frame) {
    await frame.waitForTimeout(1200);
    await frame.locator("#no-session").click();
    await frame.waitForTimeout(900);
    const gate = await frame.locator("#out-gate").textContent();
    check("页内越权调用当场被拒", /被拒/.test(gate || ""), gate);
    await frame.locator("#ver").click();
    await frame.waitForTimeout(2500);
    const outExec = await frame.locator("#out-exec").textContent();
    check("页内 exec 跑得通", /"stdout"|v\d+\./.test(outExec || ""), outExec);
    await page.screenshot({ path: path.join(SHOTS, "03-page-exec.png") });
  } else {
    check("运维脚本台 iframe 挂载", false, "找不到帧");
  }
  await openTab("ui-terminal:ops");
  let jsPage = await page.evaluate(() => {
    const el = document.querySelector("[data-bit-term-status]");
    return el ? el.textContent : document.body.innerText.includes("运维速记台") ? "标题在" : "";
  });
  check("JS 插件的 React 页渲染", /已读|读取失败|准备中/.test(jsPage || ""), jsPage);
  await page.screenshot({ path: path.join(SHOTS, "04-page-js-terminal.png") });

  await openTab("chat");
  const iconDom = await page.evaluate(() =>
    [...document.querySelectorAll("[data-bit-icon-id]")].map((e) => ({ id: e.getAttribute("data-bit-icon-id"), zone: e.getAttribute("data-bit-icon-zone") }))
  );
  const onScreen = iconDom.filter((i) => /:ask-price|:go-board|:sync-now|:open-live/.test(i.id)).map((i) => i.id);
  check("插件图标真的画在图标排上", onScreen.length >= 3, onScreen.join(","));
  const builtinGone = ["chat:voice", "chat:preview", "chat:attach"].filter((id) => iconDom.some((i) => i.id === id));
  check("被接管的内置按钮已从界面消失", builtinGone.length === 0, `还在：${builtinGone.join(",")}`);
  await page.screenshot({ path: path.join(SHOTS, "05-chat-after-takeover.png") });

  // 会话列表应能看到插件命名空间的会话（带拼图图标）
  const sess = await call("list_sessions", {}).catch(() => null);
  const list = Array.isArray(sess) ? sess : (sess && (sess.sessions || sess.list)) || [];
  const pluginSess = list.filter((s) => String(s.id || "").startsWith("plugin:"));
  check("插件会话进了会话列表", pluginSess.length >= 2, pluginSess.map((s) => s.id).join(","));
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find((x) => x.childElementCount === 0 && /工单 P2/.test(x.textContent || ""));
    if (el) el.scrollIntoView();
  });
  await page.screenshot({ path: path.join(SHOTS, "06-session-list-plugin.png") });

  // 插件页与设置中心：把错误列表和注入条目拍下来给人看
  await openTab("plugins");
  await page.screenshot({ path: path.join(SHOTS, "07-plugins-page.png") });
  const pluginsText = await page.evaluate(() => document.body.innerText);
  check("插件页展示了夹具错误", /unknown permission|plugin.json missing/.test(pluginsText), "");
  check("插件页列出套件插件", /商品价格盯盘|投研流水线|附件坞/.test(pluginsText), "");

  await openTab("settings");
  await sleep(1200);
  const settingsText = await page.evaluate(() => document.body.innerText);
  check("设置中心出现插件注入条目", /波动阈值|补货提前期|在制品上限|风险分档/.test(settingsText), "");
  await page.screenshot({ path: path.join(SHOTS, "08-settings-plugin-cards.png") });

  // 逐权限撤回：关掉 biz-caps-exec 的 exec 后，同一动词应当立刻不可用
  const off = await rpc("set_plugin_permission", { id: "biz-caps-exec", perm: "exec", granted: false });
  const afterOff = await capCall("biz-caps-exec", "exec.run", { program: "node", args: ["-v"] });
  check("逐项关掉权限后立即失效", off.ok && !afterOff.ok && /exec/.test(afterOff.error || ""), afterOff.error);
  await capCall("biz-caps-exec", "exec.run", { program: "node", args: ["-v"] });
  const on2 = await rpc("set_plugin_permission", { id: "biz-caps-exec", perm: "exec", granted: true });
  const afterOn = await capCall("biz-caps-exec", "exec.run", { program: "node", args: ["-v"] });
  check("重新打开后能力回来", on2.ok && afterOn.ok, afterOn.error || "ok");

  // 停用插件：图标与工具必须整体收回
  const tog = await rpc("toggle_plugin", { id: "dash-kanban", enabled: false });
  await sleep(1500);
  const iconsOff = await call("get_plugin_chat_icons", {});
  check("停用插件后图标收回", tog.ok && !(iconsOff.icons || []).some((i) => i.key.startsWith("dash-kanban:")), (iconsOff.icons || []).map((i) => i.key).join(","));
  await rpc("toggle_plugin", { id: "dash-kanban", enabled: true });
  await sleep(1500);
  const iconsBack = await call("get_plugin_chat_icons", {});
  check("重新启用后图标回来", (iconsBack.icons || []).filter((i) => i.key.startsWith("dash-kanban:")).length === 2, "");

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 结果：${pass}/${results.length} 通过 =====`);
  for (const r of results.filter((x) => !x.ok)) console.log(`FAIL ${r.name} :: ${String(r.detail).slice(0, 240)}`);
  fs.writeFileSync(path.join(SHOTS, "report.json"), JSON.stringify({ pass, total: results.length, results }, null, 2), "utf8");
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("探针崩了：", e && e.stack ? e.stack : e);
  process.exit(2);
});
