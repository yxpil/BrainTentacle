// yxpil · 插件进程侧 SDK（宿主物化在 toolhomes/node_modules/bit）
//
// 为什么要有这一份：插件的 node 进程（清单里的 server / services，以及解释器工具）
// 原本要自己拼 `http.request` + Bearer 才能回连宿主，一个 /cap 客户端抄了十几遍，
// 每人抄一次就多一种漂移方式。这里把它收成一个包：
//   const bit = require("bit");          // CommonJS
//   import bit, { cap } from "bit";      // ESM（同一份实现，index.mjs 只是转出口）
// 页面侧用的是 window.Bit（crates/bit-core/assets/plugin-sdk.js），两边的方法名与
// 命名空间刻意保持一致——插件作者只需要学一套词汇。
//
// 凭据从环境来：宿主拉起进程时注入 BIT_PLUGIN_API / BIT_PLUGIN_TOKEN / BIT_PLUGIN_ID /
// BIT_PLUGIN_PERMS（工具进程同样给）。没有这些环境说明不是宿主托管的进程，
// 直接抛错而不是静默重试——凭据缺失时任何"看起来能跑"的行为都是在骗插件作者。
//
// 权限仍然逐条把关：这个包不放宽任何能力，未申报的 verb 由宿主拒绝，
// 错误以 BitError 抛出，status=403 表示"去清单里申报权限"，400 表示"改参数"。
"use strict";

const http = require("http");

const VERSION = "1.0.0";

// 宿主注入的运行环境（进程自己的身份，不需要问宿主）
const env = {
  id: process.env.BIT_PLUGIN_ID || "",
  service: process.env.BIT_PLUGIN_SERVICE || "",
  api: String(process.env.BIT_PLUGIN_API || "").replace(/\/+$/, ""),
  port: Number(process.env.BIT_PLUGIN_PORT || 0),
  dir: process.env.BIT_PLUGIN_DIR || "",
  token: process.env.BIT_PLUGIN_TOKEN || "",
  perms: String(process.env.BIT_PLUGIN_PERMS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

class BitError extends Error {
  constructor(message, status, verb) {
    super(message);
    this.name = "BitError";
    this.status = status || 0;
    this.verb = verb || "";
  }
}

const missingCreds = () =>
  new BitError(
    "缺少 BIT_PLUGIN_API / BIT_PLUGIN_TOKEN：只有宿主托管的插件进程（清单 server、services，以及插件的解释器工具）才带凭据",
    0,
    ""
  );

function once(req, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(e instanceof Error ? e : new BitError(String(e), 0, ""));
    };
    const ok = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on("error", fail);
    req.setTimeout(timeoutMs, () => fail(new BitError(`宿主响应超时（${timeoutMs}ms）`, 0, "")));
    let text = "";
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => {
        text += c;
        // 宿主返回异常巨大时（读文件类能力）也要有个上限，别把插件进程内存吃掉
        if (text.length > 64 * 1024 * 1024) fail(new BitError("宿主返回过大（>64MB）", 0, ""));
      });
      res.on("end", () => ok({ status: res.statusCode || 0, text }));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function post(pathname, obj, timeoutMs) {
  if (!env.api) return Promise.reject(missingCreds());
  let u;
  try {
    u = new URL(env.api + pathname);
  } catch (e) {
    return Promise.reject(new BitError(`BIT_PLUGIN_API 不是合法地址：${env.api}`, 0, ""));
  }
  const body = JSON.stringify(obj);
  const req = http.request({
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      authorization: env.token ? `Bearer ${env.token}` : "",
    },
  });
  return once(req, body, timeoutMs);
}

function get(pathname, query, timeoutMs) {
  if (!env.api) return Promise.reject(missingCreds());
  const u = new URL(env.api + pathname);
  Object.keys(query || {}).forEach((k) => u.searchParams.set(k, String(query[k])));
  const req = http.request({
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    method: "GET",
    headers: { authorization: env.token ? `Bearer ${env.token}` : "" },
  });
  return once(req, undefined, timeoutMs);
}

const DEFAULT_TIMEOUT = 120000;

function unwrap(res, verb) {
  let data = null;
  try {
    data = JSON.parse(res.text);
  } catch (e) {
    throw new BitError(`宿主返回不是 JSON：${String(res.text).slice(0, 200)}`, res.status, verb);
  }
  if (res.status >= 400) {
    throw new BitError((data && data.error) || `HTTP ${res.status}`, res.status, verb);
  }
  return data;
}

/**
 * 能力调用：与页面 SDK 的 Bit.cap 同一种包法。
 * @param {string} verb 能力名，如 "data.write"
 * @param {object} [payload] 参数
 * @param {{timeoutMs?: number}} [opts]
 */
async function cap(verb, payload, opts) {
  if (!env.token) throw missingCreds();
  const t = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT;
  return unwrap(await post("/cap", { verb, payload: payload || {} }, t), verb);
}

// 申报权限的判断走环境里的生效权限串（用户单独关掉的项不会出现）；
// "all" 是清单里的通配写法，宿主展开后下发，所以这里只认具体权限名
function can(perm) {
  return env.perms.includes(perm) || env.perms.includes("all");
}

const pick = (key) => (r) => (r && r[key] !== undefined ? r[key] : r);

/** 对话：POST /chat，会话强制落在 plugin:<插件id> 命名空间下（需 chat 权限） */
async function chat(message, opts) {
  if (!env.token) throw missingCreds();
  const p = { message };
  if (opts) {
    if (opts.session_id) p.session_id = opts.session_id;
    if (opts.images) p.images = opts.images;
  }
  const t = (opts && opts.timeoutMs) || 300000;
  return unwrap(await post("/chat", p, t), "chat");
}

/** 读本插件会话的历史消息（需 chat 权限） */
async function history(sessionId) {
  if (!env.token) throw missingCreds();
  return unwrap(await get("/history", { session_id: sessionId || "" }, DEFAULT_TIMEOUT), "history");
}

const bit = {
  VERSION,
  BitError,
  env,
  cap,
  can,
  chat,
  history,
  /** 本插件的申报与身份：{plugin_id, plugin_name, version, permissions, has_settings} */
  info: () => cap("info"),
  /** 当前申报下实际可用的能力动词 */
  caps: () => cap("caps").then(pick("caps")),
  settings: {
    all: () => cap("settings.all").then(pick("values")),
    get: (key) => cap("settings.get", { key }).then(pick("value")),
    set: (key, value) => cap("settings.set", { key, value }),
    getJSON: async (key, fallback) => {
      const v = await cap("settings.get", { key }).then(pick("value"));
      if (v === null || v === undefined || v === "") return fallback === undefined ? null : fallback;
      if (typeof v === "object") return v;
      try {
        return JSON.parse(String(v));
      } catch (e) {
        return fallback === undefined ? null : fallback;
      }
    },
    setJSON: (key, value) => cap("settings.set", { key, value }),
  },
  data: {
    list: () => cap("data.list"),
    read: (path) => cap("data.read", { path }).then(pick("text")),
    write: (path, text) => cap("data.write", { path, text }),
    remove: (path) => cap("data.remove", { path }),
    readJSON: async (path, fallback) => {
      const t = await cap("data.read", { path }).then(pick("text"));
      try {
        return JSON.parse(t);
      } catch (e) {
        return fallback === undefined ? null : fallback;
      }
    },
    writeJSON: (path, value) => cap("data.write", { path, text: JSON.stringify(value, null, 2) }),
  },
  fs: {
    list: (path) => cap("fs.list", { path: path || "" }),
    stat: (path) => cap("fs.stat", { path }),
    exists: async (path) => !!(await cap("fs.stat", { path })).exists,
    read: (path, opts) =>
      cap("fs.read", Object.assign({ path }, opts || {})).then((r) => (r.encoding === "base64" ? r.base64 : r.text)),
    readJSON: async (path, opts) => {
      const t = await bit.fs.read(path, opts);
      try {
        return JSON.parse(t);
      } catch (e) {
        return null;
      }
    },
    write: (path, text, opts) => cap("fs.write", Object.assign({ path, text }, opts || {})),
    writeJSON: (path, value, opts) => bit.fs.write(path, JSON.stringify(value, null, 2), opts),
    append: (path, text) => cap("fs.append", { path, text }),
    remove: (path, recursive) => cap("fs.remove", { path, recursive: !!recursive }),
    mkdir: (path) => cap("fs.mkdir", { path }),
    move: (from, to) => cap("fs.move", { from, to }),
  },
  sessions: {
    list: () => cap("session.list").then(pick("sessions")),
    read: (sessionId) => cap("session.read", { session_id: sessionId || "" }),
    append: (role, content, sessionId) => cap("session.append", { role, content, session_id: sessionId || "" }),
    /** 把一段话作为后台产物送回本插件的会话，让那边的 AI 下一轮看到它 */
    wake: (sessionId, text) => cap("session.wake", { session_id: sessionId, text }),
  },
  services: {
    list: () => cap("workwith.list"),
    save: (entry) => cap("workwith.save", entry || {}),
    start: (name) => cap("workwith.start", { name }),
    stop: (name) => cap("workwith.stop", { name }),
    remove: (name) => cap("workwith.remove", { name }),
  },
  server: {
    status: () => cap("server.status"),
    start: () => cap("server.start"),
    stop: () => cap("server.stop"),
  },
  net: {
    /** 本插件清单 connections[] 声明的外部 MCP 连接与实时状态（需 net 权限）。
     *  只回声明与本插件自己的连接状态，看不到别的插件，也拿不到密钥值 */
    connections: () => cap("net.connections").then(pick("connections")),
    connect: (name) => cap("net.connect", { name }),
    disconnect: (name) => cap("net.disconnect", { name }),
  },
  exec: {
    /** 交给默认 shell 的一条命令：{code, stdout, stderr, timed_out, ...} */
    run: (command, opts) => cap("exec.run", Object.assign({ command }, opts || {}), opts),
    /** 直接启动可执行文件（裸名走系统 PATH，带目录按插件目录展开） */
    program: (program, args, opts) =>
      cap("exec.run", Object.assign({ program, args: args || [] }, opts || {}), opts),
    node: (args, opts) => bit.exec.program("node", args, opts),
    python: (args, opts) => bit.exec.program("python", args, opts),
    powershell: (args, opts) => bit.exec.program("powershell", args, opts),
    /** 跑一段 node 代码并拿 JSON 结果（语法糖，等价于 node -e） */
    nodeEval: (code, opts) => bit.exec.program("node", ["-e", code], opts),
  },
  runtime: {
    /** 本机可用解释器（id/名称/版本/语言），不需要任何权限 */
    list: () => cap("runtime.list").then(pick("runtimes")),
    has: async (id) => (await bit.runtime.list()).some((r) => r.id === id),
  },
  files: {
    /** 本插件登记且当前生效的文件类型：[{ id, label, exts, paths, tool }]（需 files 权限） */
    kinds: () => cap("files.kinds").then(pick("kinds")),
  },
  notify: (title, body) => cap("notify", { title, body: body || "" }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  /** 带插件前缀的日志：宿主的服务日志面板原样收下来 */
  log: (...a) => console.log(`[${env.service || env.id || "bit"}]`, ...a),
  warn: (...a) => console.warn(`[${env.service || env.id || "bit"}]`, ...a),
  error: (...a) => console.error(`[${env.service || env.id || "bit"}]`, ...a),
};

module.exports = bit;
module.exports.default = bit;
