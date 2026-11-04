// yxpil · BIT
// 渲染层插件加载器：读取启用且通过安全校验的插件 UI 资源（get_plugin_ui），
// 注入 <style>（css 权限）并执行 JS 插件入口（js 权限）；
// 另把清单里声明的独立页面（pages）注册成沙箱 iframe、把设置注入（settings）
// 登记给设置中心、把状态面板（status_page）登记给插件详情页，并充当帧与主世界之间的桥。
//
// 插件 JS 以受限 API 执行（new Function，非 eval 全局）：
//   api.React                —— 宿主 React 实例（插件组件必须用它，hooks 才能工作）
//   api.plugin               —— { id, name, version }
//   api.registerPage({...})  —— 注册导航页（宿主渲染，插件提供 component）
//   api.removePage(id)       —— 移除自己注册的页
//   api.registerSettingsPage({...}) —— 注册设置中心页（同一套 component 机制）
//   api.cap(verb, payload)   —— 能力出口（settings/data/session/workwith/server/notify/exec/fs…）
//   api.invoke(cmd, args)    —— 后端命令（需插件声明 "invoke" 权限）
//   api.exec.run/program     —— 控制台命令与可执行程序（需 exec）
//   api.fs                   —— 任意路径读写/修改/删除（需 write）
//   api.openPage(page, section) / api.setTitle(id, label) —— 唤醒页面、改自己页面标题（需 pagectl）
//   api.onEvent(cb)          —— 订阅被放行的宿主事件（需 events）
//   api.storage              —— 按插件 id 命名空间隔离的 localStorage（需 storage）
//   api.log(...)             —— 带插件名前缀的 console.log
//
// 清单页面（iframe 内，非宿主 React）走 window.Bit：见 assets/plugin-sdk.js。
//
// 安全模型：后端出站前已过 清单 schema + 权限位 + 路径包含 + 全文件哈希基线四道闸；
// 渲染层只加载 backend 过滤后的文本，不在渲染层做二次信任判断。
// 桥的准入有三条，缺一不可：只认宿主自己创建过的 iframe（按 contentWindow 比对）、
// 按该插件声明的源校验 e.origin、每条消息带本插件的通讯令牌（#bit_token= 或注入全局）。
// 令牌由后端按插件现发（与服务器进程的 BIT_PLUGIN_TOKEN 同一枚），停用即收回；
// 权限位逐条把关，未声明即拒绝。
import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api.js";
import PluginFramePage from "./components/PluginFramePage.jsx";
import PluginGlyph from "./components/PluginGlyph.jsx";

// 插件页面登记表：key = "<插件id>:<页id>" -> { label, icon?, component }
let pages = {};
// 设置中心页登记表：key = "<插件id>:settings:<页id>" -> { label, plugin_id, page }
let settingsPages = {};
// 插件详情里的状态面板：plugin_id -> 帧信息（不注册左栏，只在详情页按需渲染）
let statusPages = {};
const statusListeners = new Set();
let loadSeq = 0;
const listeners = new Set();
const settingsListeners = new Set();
// 由清单 pages 注册的键（重放时只摘这些，保留 registerPage 注册的 React 页）
const frameKeys = new Set();
// 同上，但针对设置中心：清单型设置页的键 + 清单条目快照 + 给设置中心的合并视图
let settingsFrameKeys = new Set();
let settingsCards = [];
let settingsView = { cards: [], pages: {} };
// 插件登记到对话页图标排的入口快照（清单声明 + chaticon 权限，后端 bundle 已经把过关）
let chatIcons = [];
const chatIconListeners = new Set();
// 插件登记的文件类型快照：[{ key, plugin_id, plugin_name, label, label_en, exts, paths, parses }]
// 附件卡的图标与「这类文件谁来解析」都读这一份；后端 bundle 已经把 files 权限位关过。
let fileKinds = [];
const fileKindListeners = new Set();
// 插件接管的宿主内置入口快照：对话页隐藏被接管按钮，设置中心恢复面板列出归属。
// 设置槽位在后端目录里根本不存在，所以这里也拿不到"接管设置"这种声明。
let takeoverClaims = [];
const takeoverListeners = new Set();
// 插件显示名快照：plugin_id -> 清单里的 name。会话列表与搜索面板标「这轮对话是谁开的」
// 只读这一份——后端 bundle 本来就带着 plugin_name，不必每行再拉一次 list_plugins。
let pluginNames = {};
const nameListeners = new Set();
// 插件本机服务基址（get_plugin_pages 返回）
let apiBase = "";

/** 订阅插件显示名表变化 */
export function subscribePluginNames(cb) {
  nameListeners.add(cb);
  return () => nameListeners.delete(cb);
}
/** 当前 plugin_id -> 显示名 快照（引用稳定，给 useSyncExternalStore 用） */
export function getPluginNames() {
  return pluginNames;
}
/** 会话归属显示名：插件被停用/删掉后表里查不到，退回原始 id 而不是显示空白 */
export function pluginDisplayName(id) {
  return pluginNames[id] || id;
}

/** 后端各行（页面 / 状态面板 / 文件类型）都带 plugin_id + plugin_name，汇成一张名表 */
function mergePluginNames(rows) {
  const next = {};
  for (const row of rows || []) {
    if (row?.plugin_id && row.plugin_name) next[row.plugin_id] = row.plugin_name;
  }
  if (Object.keys(next).length === 0) return;
  pluginNames = { ...pluginNames, ...next };
  nameListeners.forEach((cb) => cb());
}

/** 名表的权威来源：整份插件清单。页面/状态面板那几份 bundle 只覆盖有界面的插件，
 *  纯后台服务（没有任何 pages）也能开会话，所以必须整体拉一次，否则它只能显示包名。 */
async function refreshPluginNames() {
  try {
    const r = await invoke("list_plugins", {});
    const next = {};
    for (const p of r?.plugins || []) {
      if (p?.id && p?.name) next[p.id] = p.name;
    }
    if (Object.keys(next).length === 0) return;
    pluginNames = next;
    nameListeners.forEach((cb) => cb());
  } catch (e) {
    console.warn("[插件] 读取插件名表失败:", e);
  }
}

/** 订阅插件页面变化（App.jsx 用 useSyncExternalStore 挂上） */
export function subscribePluginPages(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 当前插件页面登记表快照（引用仅在变更时换新，满足 useSyncExternalStore 语义） */
export function getPluginPages() {
  return pages;
}

/** 订阅设置中心插件页变化（SettingsPage 用） */
export function subscribePluginSettings(cb) {
  settingsListeners.add(cb);
  return () => settingsListeners.delete(cb);
}

/** 订阅对话页图标排的插件入口变化（ChatPage 用） */
export function subscribePluginChatIcons(cb) {
  chatIconListeners.add(cb);
  return () => chatIconListeners.delete(cb);
}

/** 订阅插件接管清单变化（ChatPage / 设置中心恢复面板用） */
export function subscribePluginTakeovers(cb) {
  takeoverListeners.add(cb);
  return () => takeoverListeners.delete(cb);
}

/** 订阅插件登记的文件类型变化（附件卡与侧栏预览用） */
export function subscribePluginFileKinds(cb) {
  fileKindListeners.add(cb);
  return () => fileKindListeners.delete(cb);
}

/** 当前文件类型登记快照：引用仅在变更时换新 */
export function getPluginFileKinds() {
  return fileKinds;
}

/** 按文件名取插件登记的类型（后缀匹配，大小写不敏感）；没登记返回 null */
export function pluginFileKind(name) {
  const lower = String(name || "").toLowerCase();
  return fileKinds.find((k) => (k.exts || []).some((e) => lower.endsWith(String(e).toLowerCase()))) || null;
}

/** 当前接管清单快照：[{ slot, plugin_id, plugin_name, effective }] */
export function getPluginTakeoverClaims() {
  return takeoverClaims;
}

/** 订阅插件详情里的状态面板变化（PluginsPage 用） */
export function subscribePluginStatus(cb) {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

/** 当前状态面板快照：{ [插件id]: 帧信息 }；引用仅在变更时换新 */
export function getPluginStatusPages() {
  return statusPages;
}

/** 当前快照：[{ key, plugin_id, plugin_name, id, label, label_en, paths, action, page_key, text }] */
export function getPluginChatIcons() {
  return chatIcons;
}

function emitChatIcons() {
  // 引用换新才通知：useSyncExternalStore 靠引用比较判变更
  chatIcons = [...chatIcons];
  chatIconListeners.forEach((cb) => cb());
}

function emitTakeovers() {
  takeoverClaims = [...takeoverClaims];
  takeoverListeners.forEach((cb) => cb());
}

function emit() {
  pages = { ...pages };
  listeners.forEach((cb) => cb());
}

function emitSettings() {
  settingsPages = { ...settingsPages };
  // 卡片快照与页面登记表一起换新引用：设置中心用 useSyncExternalStore 订阅，
  // 两份数据分开取会读到"有条目却没页"的中间态
  const used = new Set();
  const cards = [];
  for (const c of settingsCards) {
    if (c.pageKey) used.add(c.pageKey);
    cards.push(c);
  }
  for (const [key, pg] of Object.entries(settingsPages)) {
    if (used.has(key)) continue;
    cards.push({
      key,
      plugin_id: pg.plugin_id,
      label: pg.label,
      description: pg.description || "",
      kw: pg.kw || "",
      pageKey: key,
    });
  }
  settingsView = { cards, pages: settingsPages };
  settingsListeners.forEach((cb) => cb());
}

function clearInjected() {
  document.querySelectorAll("style[data-bit-plugin]").forEach((el) => el.remove());
  pages = {};
  frameKeys.clear();
  emit();
  statusPages = {};
  statusListeners.forEach((cb) => cb());
  // 设置中心同理整体重建：清单页下面会重放，JS 插件页随插件脚本重跑再登记一次。
  // 留着旧的会让停用/删掉的插件继续在设置中心占一张卡。
  settingsPages = {};
  settingsFrameKeys = new Set();
  settingsCards = [];
  emitSettings();
  // 对话页图标同理整体作废：停用/删掉的插件不能继续在图标排上留一个按钮
  chatIcons = [];
  emitChatIcons();
  // 接管也整体作废：插件停用/删除后内置按钮必须立刻回来
  takeoverClaims = [];
  emitTakeovers();
}

/**
 * 能力调用：页面桥与 JS 插件共用同一条后端入口。
 * 渲染层这里先按登记信息拦一道（错误是人话），后端 plugin_caps 再按清单拦一道——
 * 两道依据相同，任何一道漏了都不会放开未申报的能力。
 * 设置中心的宿主键值面板也走这里：和插件自己读写的是同一条闸口。
 */
export function capCall(pluginId, verb, payload) {
  return invoke("plugin_cap_call", { id: pluginId, verb, payload: payload || {} }).catch((e) => {
    throw new Error(cleanError(e));
  });
}

/**
 * Electron 的 ipcRenderer.invoke 会把主进程的拒绝包成
 * "Error invoking remote method 'bit:invoke': Error: xxx"；
 * 这段壳直接进了插件页面日志与设置中心，把宿主自己写的中文错误埋在最底下，剥掉。
 */
function cleanError(e) {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const m = raw.match(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s);
  return (m ? m[1] : raw).trim() || "调用失败";
}

/** 唤醒/切换宿主页面：内置页 id、"<插件id>:<页id>"、"settings" 都走同一条宿主事件 */
function openHostPage(pluginId, page, section) {
  window.dispatchEvent(
    new CustomEvent("bit-open-page", { detail: { page: String(page || ""), section: String(section || ""), by: pluginId } })
  );
  return { ok: true };
}

/** 改标题：只允许改自己插件名下的页（导航页与设置页都算） */
function setOwnPageTitle(pluginId, pageId, label) {
  const name = String(label || "").trim();
  if (!name) throw new Error("label 不能为空");
  for (const key of [`${pluginId}:${pageId}`, `${pluginId}:settings:${pageId}`]) {
    if (pages[key]) {
      pages[key] = { ...pages[key], label: name };
      emit();
      return { ok: true, key };
    }
    if (settingsPages[key]) {
      settingsPages[key] = { ...settingsPages[key], label: name };
      emitSettings();
      return { ok: true, key };
    }
  }
  throw new Error("只能改自己页面（插件内注册的页）的标题");
}

// 放行给申报了 events 的插件的宿主事件。白名单而不是全量转发：
// 流式打字事件这类高频内部信号转进帧里只会拖慢渲染，也可能带出用户别处的上下文。
const HOST_EVENTS = [
  "sessions-updated",
  "workwith",
  "plugin-server",
  "tools-updated",
  "runtimes-updated",
  "notify-done",
  "chat-usage",
  "autopilot-changed",
];

/** 为一个帧订阅宿主事件（幂等；摘除时随 detach 一起解订） */
async function watchHostEvents(ctx) {
  if (ctx.unwatch) return { events: HOST_EVENTS };
  const unsubs = [];
  for (const name of HOST_EVENTS) {
    const un = await listen(name, (e) => ctx.push({ event: "host", payload: { name, data: e.payload } }));
    unsubs.push(un);
  }
  ctx.unwatch = () => unsubs.forEach((f) => { try { f && f(); } catch { /* 已解订 */ } });
  return { events: HOST_EVENTS };
}

function makeApi(plugin, perms) {
  const can = (perm) => perms.has(perm);
  const ns = (k) => `bit.plugin.${plugin.id}.${k}`;
  const need = (perm) => {
    if (!can(perm)) throw new Error(`插件 ${plugin.id} 未开启 ${perm} 权限`);
  };
  // verb 前缀 → 权限位：渲染层这一道只是提前给一句人话错误，
  // 真正的判定在后端 plugin_caps（两条链路共用那份表，这里漏了也不会放开）
  const VERB_PERM = { settings: "settings", data: "data", session: "session", workwith: "workwith", server: "server", net: "net", notify: "notify", exec: "exec", fs: "write", files: "files" };
  const cap = (verb, payload) => {
    const perm = VERB_PERM[String(verb || "").split(".")[0]];
    if (perm) need(perm);
    return Promise.resolve(capCall(plugin.id, verb, payload));
  };
  return {
    React,
    plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
    registerPage({ id, label, icon, component }) {
      if (!id || typeof label !== "string" || typeof component !== "function") {
        throw new Error("registerPage 需要 { id: string, label: string, component: function }");
      }
      pages[`${plugin.id}:${id}`] = { label, icon, component };
      emit();
    },
    removePage(id) {
      delete pages[`${plugin.id}:${id}`];
      emit();
    },
    /** 设置中心的一页（JS 插件用 React 组件；清单插件走 iframe，见 settings.page） */
    registerSettingsPage({ id, label, description, kw, component }) {
      need("settings");
      if (!id || typeof label !== "string" || typeof component !== "function") {
        throw new Error("registerSettingsPage 需要 { id, label, component }");
      }
      settingsPages[`${plugin.id}:${id}`] = {
        label,
        description: description || "",
        kw: kw || "",
        plugin_id: plugin.id,
        component,
      };
      emitSettings();
    },
    removeSettingsPage(id) {
      need("settings");
      delete settingsPages[`${plugin.id}:${id}`];
      emitSettings();
    },
    invoke(cmd, args) {
      need("invoke");
      return invoke(cmd, args || {});
    },
    cap,
    settings: {
      all: () => cap("settings.all").then((r) => r.values),
      get: (key) => cap("settings.get", { key }).then((r) => r.value),
      set: (key, value) => cap("settings.set", { key, value }),
    },
    data: {
      list: () => cap("data.list"),
      read: (path) => cap("data.read", { path }).then((r) => r.text),
      write: (path, text) => cap("data.write", { path, text }),
      remove: (path) => cap("data.remove", { path }),
    },
    sessions: {
      list: () => cap("session.list"),
      read: (sessionId) => cap("session.read", { session_id: sessionId || "" }),
      append: (role, content, sessionId) => cap("session.append", { role, content, session_id: sessionId || "" }),
      wake: (sessionId, text) => cap("session.wake", { session_id: sessionId, text }),
    },
    services: {
      list: () => cap("workwith.list"),
      save: (entry) => cap("workwith.save", entry),
      start: (name) => cap("workwith.start", { name }),
      stop: (name) => cap("workwith.stop", { name }),
      remove: (name) => cap("workwith.remove", { name }),
    },
    server: {
      status: () => cap("server.status"),
      start: () => cap("server.start"),
      stop: () => cap("server.stop"),
    },
    /** 外部 MCP 连接（需 net）：只看/管本插件清单 connections[] 声明的那几条 */
    net: {
      connections: () => cap("net.connections").then((r) => r.connections || []),
      connect: (name) => cap("net.connect", { name }),
      disconnect: (name) => cap("net.disconnect", { name }),
    },
    /** 控制台执行（需 exec） */
    exec: {
      run: (command, opts) => cap("exec.run", { command, ...(opts || {}) }),
      program: (program, args, opts) => cap("exec.run", { program, args: args || [], ...(opts || {}) }),
    },
    /** 文件与程序修改（需 write）；相对路径以插件目录为基准 */
    fs: {
      list: (path) => cap("fs.list", { path: path || "" }),
      stat: (path) => cap("fs.stat", { path }),
      read: (path, opts) => cap("fs.read", { path, ...(opts || {}) }).then((r) => (r.encoding === "base64" ? r.base64 : r.text)),
      write: (path, text, opts) => cap("fs.write", { path, text, ...(opts || {}) }),
      append: (path, text) => cap("fs.append", { path, text }),
      remove: (path, recursive) => cap("fs.remove", { path, recursive: !!recursive }),
      mkdir: (path) => cap("fs.mkdir", { path }),
      move: (from, to) => cap("fs.move", { from, to }),
    },
    openPage(page, section) {
      need("pagectl");
      return Promise.resolve(openHostPage(plugin.id, page, section));
    },
    setTitle(pageId, label) {
      need("pagectl");
      return Promise.resolve(setOwnPageTitle(plugin.id, pageId, label));
    },
    notify(title, body) {
      return cap("notify", { title, body });
    },
    /** 订阅宿主事件（申报 events 才有内容）；返回取消订阅函数 */
    onEvent(cb) {
      need("events");
      if (!apiEventSubs.has(cb)) {
        apiEventSubs.add(cb);
        ensureEventPump();
      }
      return () => apiEventSubs.delete(cb);
    },
    storage: {
      get: (k) => {
        need("storage");
        return localStorage.getItem(ns(k));
      },
      set: (k, v) => {
        need("storage");
        localStorage.setItem(ns(k), v);
      },
      remove: (k) => {
        need("storage");
        localStorage.removeItem(ns(k));
      },
    },
    log: (...a) => console.log(`[插件 ${plugin.name}]`, ...a),
  };
}

// JS 插件侧的事件订阅者与宿主事件泵（只装一次，多个插件共享）
const apiEventSubs = new Set();
let eventPump = null;
function ensureEventPump() {
  if (eventPump) return;
  eventPump = Promise.all(
    HOST_EVENTS.map((name) => listen(name, (e) => apiEventSubs.forEach((cb) => { try { cb(name, e.payload); } catch (err) { console.warn("[插件事件]", err); } })))
  ).catch(() => {});
}

/**
 * 清单声明的独立页面 → 导航登记表；设置页 → 设置中心登记表。
 * 服务器没跑时动态页拿不到地址（frame 为空），容器会显示"先启动服务器"。
 */
async function refreshFramePages() {
  let r = null;
  try {
    r = await invoke("get_plugin_pages");
  } catch (e) {
    console.warn("[插件] 读取页面清单失败:", e);
  }
  apiBase = r?.api || "";
  mergePluginNames(r?.pages);
  mergePluginNames(r?.status);
  refreshPluginNames();
  // 状态面板随同一份清单下发：按插件 id 建表，详情页按选中项取用
  statusPages = Object.fromEntries((r?.status || []).map((st) => [st.plugin_id, { ...st, api: apiBase }]));
  statusListeners.forEach((cb) => cb());
  // 只重放清单页：先摘掉上一轮的键，registerPage 注册的 React 页不动
  for (const k of frameKeys) delete pages[k];
  frameKeys.clear();
  for (const pg of r?.pages || []) {
    const key = `${pg.plugin_id}:${pg.id}`;
    frameKeys.add(key);
    // 清单没配 paths 时 icon 留空：App 侧回退到内置图标，不会因为没字形就不显示
    const paths = Array.isArray(pg.paths) ? pg.paths.filter((d) => typeof d === "string" && d) : [];
    pages[key] = {
      label: pg.label,
      icon: paths.length ? (props) => React.createElement(PluginGlyph, { paths, ...props }) : undefined,
      component: () =>
        React.createElement(PluginFramePage, {
          page: { ...pg, api: apiBase },
          onOpenPlugins: () => window.dispatchEvent(new CustomEvent("bit-open-page", { detail: { page: "plugins" } })),
        }),
    };
  }
  emit();
  await refreshSettingsPages();
  await refreshChatIcons();
  await refreshTakeovers();
  await refreshFileKinds();
}

/** 清单里的文件类型登记 → 附件卡图标与侧栏预览的分派表（后端只发 granted 的条目） */
async function refreshFileKinds() {
  let r = null;
  try {
    r = await invoke("plugin_file_kinds");
  } catch (e) {
    console.warn("[插件] 读取文件类型登记失败:", e);
    return;
  }
  fileKinds = (r?.kinds || []).filter((k) => k?.key && Array.isArray(k.exts) && k.exts.length);
  fileKindListeners.forEach((cb) => cb());
}

/** 清单里的对话页图标声明 → 对话页快照（后端 bundle 只放行申报 chaticon 的插件） */
async function refreshChatIcons() {
  let r = null;
  try {
    r = await invoke("get_plugin_chat_icons");
  } catch (e) {
    console.warn("[插件] 读取对话页图标失败:", e);
    return;
  }
  chatIcons = (r?.icons || []).filter((ic) => ic?.key && Array.isArray(ic.paths) && ic.paths.length);
  emitChatIcons();
}

/** 清单里的接管声明 → 宿主内置入口占用表（后端只发启用且 granted 的声明） */
async function refreshTakeovers() {
  let r = null;
  try {
    r = await invoke("get_plugin_takeovers");
  } catch (e) {
    console.warn("[插件] 读取接管清单失败:", e);
    return;
  }
  takeoverClaims = (r?.claims || []).filter((c) => c?.slot && c?.plugin_id);
  emitTakeovers();
}

/** 恢复内置（granted=false）或重新交给插件接管：逐槽位生效，立即刷新界面 */
export async function setPluginTakeover(pluginId, slot, granted) {
  await invoke("set_plugin_takeover", { id: pluginId, slot, granted: !!granted });
  await refreshTakeovers();
}

/** 清单里的设置注入（条目 + 独立设置页）→ 设置中心登记表 */
async function refreshSettingsPages() {
  let r = null;
  try {
    r = await invoke("get_plugin_settings");
  } catch (e) {
    console.warn("[插件] 读取设置注入失败:", e);
    return;
  }
  // 同样只重放清单型设置页：JS 插件 registerSettingsPage 的登记不动
  for (const k of settingsFrameKeys) delete settingsPages[k];
  settingsFrameKeys.clear();
  const hostCards = [];
  for (const pl of r?.plugins || []) {
    const framePage = pl.page
      ? {
          ...pl.page,
          component: () =>
            React.createElement(PluginFramePage, {
              page: { ...pl.page, api: apiBase },
              onOpenPlugins: () => window.dispatchEvent(new CustomEvent("bit-open-page", { detail: { page: "plugins" } })),
            }),
        }
      : null;
    for (const en of pl.entries || []) {
      const key = `${pl.plugin_id}:${en.id}`;
      hostCards.push({
        key,
        plugin_id: pl.plugin_id,
        plugin_name: pl.plugin_name,
        label: en.label,
        description: en.description || "",
        kw: en.kw || "",
        // 条目点开就是本插件的设置页；没有设置页时由设置中心退回键值面板
        pageKey: pl.page ? pl.page.key : "",
      });
    }
    if (pl.page) {
      settingsFrameKeys.add(pl.page.key);
      settingsPages[pl.page.key] = {
        label: pl.page.label,
        plugin_id: pl.plugin_id,
        page: { ...pl.page, api: apiBase },
        component: framePage.component,
      };
    }
  }
  settingsCards = hostCards;
  emitSettings();
}

export function getPluginSettingsView() {
  return settingsView;
}

// ── iframe ↔ 主世界的桥（按插件权限位 + 通讯令牌放行）──

// contentWindow → { pluginId, pluginName, perms, token, origin, source, push, unwatch? }
const frames = new Map();
let bridgeInstalled = false;
let callSeq = 0;

/** 本插件的会话命名空间：只允许 plugin:<id> 及其子会话，避免投进用户正在用的会话 */
function ownSession(pluginId, want) {
  const own = `plugin:${pluginId}`;
  const sid = String(want || "").trim();
  if (!sid || (sid !== own && !sid.startsWith(`${own}:`))) return own;
  return sid;
}

async function handleCall(ctx, msg) {
  const p = msg.payload || {};
  const need = (perm) => {
    if (!ctx.perms.has(perm)) throw new Error(`插件 ${ctx.pluginId} 未开启 ${perm} 权限`);
  };
  switch (msg.bit) {
    case "ready":
      return {
        plugin_id: ctx.pluginId,
        plugin_name: ctx.pluginName,
        permissions: [...ctx.perms],
        api: apiBase,
      };
    case "storage": {
      need("storage");
      const k = `bit.plugin.${ctx.pluginId}.${p.key}`;
      if (p.op === "get") return { value: localStorage.getItem(k) };
      if (p.op === "set") localStorage.setItem(k, String(p.value ?? ""));
      else if (p.op === "remove") localStorage.removeItem(k);
      else throw new Error(`未知 storage op: ${p.op}`);
      return { ok: true };
    }
    case "invoke":
      need("invoke");
      return invoke(String(p.cmd || ""), p.args || {});
    // 能力调用：verb 决定要什么权限位，判定交给后端（与插件服务器的 HTTP /cap 同一条实现、同一种包法）
    case "cap": {
      const verb = String(p.verb || "");
      if (!verb) throw new Error("缺少 verb");
      return capCall(ctx.pluginId, verb, p.payload || {});
    }
    case "watch":
      need("events");
      return watchHostEvents(ctx);
    case "page": {
      need("pagectl");
      if (p.op === "open") return openHostPage(ctx.pluginId, p.page, p.section);
      if (p.op === "title") return setOwnPageTitle(ctx.pluginId, p.page, p.label);
      throw new Error(`未知 page op: ${p.op}`);
    }
    case "chat": {
      need("chat");
      const message = String(p.message || "");
      if (!message.trim()) throw new Error("缺少 message");
      const sid = ownSession(ctx.pluginId, p.session_id);
      const ev = `bit-plugin-chat-${++callSeq}`;
      // 流式增量原样转发给帧（Bit.on），chat_stream 返回 {messages:[...]}
      const res = await api.chatStream(sid, message, ev, (payload) => ctx.push({ event: "chat", payload }));
      const last = [...(res?.messages || [])].reverse().find((m) => m.role === "assistant");
      return { reply: last?.content || "", session_id: sid };
    }
    case "history": {
      need("chat");
      return api.getSession(ownSession(ctx.pluginId, p.session_id));
    }
    default:
      throw new Error(`未知请求：${msg.bit}`);
  }
}

function installBridge() {
  if (bridgeInstalled) return;
  bridgeInstalled = true;
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d.bit !== "string" || !d.id) return;
    const ctx = frames.get(e.source);
    if (!ctx) return; // 不是宿主自己创建的帧
    if (ctx.origin && e.origin !== ctx.origin) return; // 冒用别的插件身份/外部页面
    // 令牌：每条消息都要带本插件那枚，且与宿主登记时的一致。
    // 光认 contentWindow + origin 不够——同一台机器上别的东西也可能拿到这个源。
    if (!ctx.token || d.token !== ctx.token) {
      console.warn(`[插件 ${ctx.pluginId}] 通讯令牌缺失或不符，请求已丢弃`);
      ctx.push({ error: "缺少或错误的通讯令牌（bit_token）" }, d.id);
      return;
    }
    ctx.source = e.source;
    const send = (payload, error) => ctx.push(error ? { error } : { payload }, d.id);
    handleCall(ctx, d).then((r) => send(r, null), (err) => send(null, String(err?.message || err)));
  });
  // 插件服务器起停会改变动态页地址；清单/权限变化由 reloadPluginUi 负责
  listen("plugin-pages", () => refreshFramePages()).catch(() => {});
  listen("plugin-server", () => refreshFramePages()).catch(() => {});
}

/**
 * 把一个已挂载的 iframe 登记为该插件页面的桥端点。返回摘除函数（组件卸载时调用）。
 * 帧的源从页面地址推出：static 页 = 插件服务端口，server 页 = 插件自己服务器的端口。
 */
export function attachFrame(el, page) {
  installBridge();
  let origin = "";
  try {
    origin = new URL(page.frame).origin;
  } catch {
    origin = "";
  }
  const ctx = {
    pluginId: page.plugin_id,
    pluginName: page.plugin_name,
    perms: new Set(page.permissions || []),
    token: String(page.token || ""),
    origin,
    source: el.contentWindow,
    push(obj, id) {
      try {
        ctx.source?.postMessage({ bitPlugin: "bit", id: id ?? null, ...obj }, origin || "*");
      } catch {
        /* 帧已卸载 */
      }
    },
  };
  frames.set(el.contentWindow, ctx);
  // 申报了 events 就在挂载这一刻订上宿主事件：等帧里 SDK 握手后再发 watch 会慢一拍，
  // 页面开局就调 Bit.notify 时 notify-done 已经过去了（具名订阅收不到，只能靠运气）
  if (ctx.perms.has("events")) watchHostEvents(ctx).catch(() => {});
  return () => {
    ctx.unwatch && ctx.unwatch();
    frames.delete(el.contentWindow);
  };
}

/**
 * 加载（或重载）插件 UI。幂等：先清掉上一轮注入的样式与页面登记再重放。
 * 单插件失败只影响自己（捕获到 console），不阻断其余插件与应用启动。
 */
export async function loadPluginUi() {
  const seq = ++loadSeq;
  clearInjected();
  // 桥与页面刷新监听在安装期就要就位：插件服务器启动事件可能在任何 iframe 挂载前到达
  installBridge();
  // 清单页与 css/js 是两条独立链路：UI 资源包读失败不该让插件页面一起消失
  await refreshFramePages();
  if (seq !== loadSeq) return;
  let bundle = null;
  try {
    bundle = await invoke("get_plugin_ui");
  } catch (e) {
    console.warn("[插件] 读取 UI 资源失败:", e);
    return;
  }
  if (seq !== loadSeq) return; // 期间又触发了重载，本轮作废
  for (const p of bundle?.plugins || []) {
    const perms = new Set(p.permissions || []);
    // ── css：注入 <style data-bit-plugin>（重载时按标记整体清除）──
    if (perms.has("css")) {
      for (const c of p.css || []) {
        try {
          const el = document.createElement("style");
          el.dataset.bitPlugin = p.id;
          el.textContent = c.text;
          document.head.appendChild(el);
        } catch (e) {
          console.warn(`[插件 ${p.id}] css 注入失败:`, e);
        }
      }
    }
    // ── js：按序执行入口，单文件 try/catch 隔离 ──
    if (perms.has("js")) {
      for (const j of p.js || []) {
        try {
          // 插件 JS 的既定执行方式（后端哈希基线 + 权限声明背书）；no-new-func 未启用无需豁免
          const runner = new Function("api", `"use strict";\n${j.text}`);
          runner(makeApi(p, perms));
        } catch (e) {
          console.warn(`[插件 ${p.id}] JS 执行失败(${j.path}):`, e);
        }
      }
    }
  }
}

/** 插件开关/重扫后重放 UI（样式与页面登记整体重建；已注册事件监听待应用重启彻底清理） */
export function reloadPluginUi() {
  return loadPluginUi();
}
