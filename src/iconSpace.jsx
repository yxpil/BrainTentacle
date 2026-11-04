/**
 * 全站图标位：一张注册表 + 一份共享布局。
 *
 * 四处图标排（左栏导航 / 页眉工具簇 / 输入框工具栏 / 会话列表底部）原先是三份互不相干的
 * 布局，图标也只在自己那一排里画，于是拖不过去。现在：
 *
 * ① 图标节点登记到这里，id 带上表面前缀（rail: / title: / chat:）——settings 这种同名图标
 *    在左栏和对话页各有一份，不带前缀就会互相顶掉；
 * ② 布局在 App 顶层只建一份，四条区共用，拖拽的「正在拖谁」也只有一个，跨排拖动天然成立；
 * ③ 任何一排都能画出别人家的图标：别人登记的是整颗按钮节点（带着它自己的点击、弹层、状态），
 *    这里发一个订阅版本号，持节点的那一侧每渲染一次就抬一次，画别人家图标的排跟着重画。
 *
 * 版本号只在持有方提交后按帧抬一次：订阅方重画不会再触发发布，所以不会自激。
 */
import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useIconLayout, DEFAULTS_ORDER } from "./iconLayout.js";

// 四条区。顺序只决定「没登记默认区的 id」往哪儿落，真正的落位全看存档和登记方给的 homes
export const SPACE_ZONES = ["rail", "title", "chatToolbar", "chatFooter"];
const SPACE_AXIS = { rail: "y", title: "x", chatToolbar: "x", chatFooter: "x" };
const legacyKey = (group) => "bit.iconLayout." + group;
const OLD_CHAT_KEY = "bit.chatTools.v1";

// ── 注册表 ────────────────────────────────────────────────────────────────
// surface -> { ids, idKey, homes, nodes, labels }
const surfaces = new Map();
let nodeMap = {};
let labelMap = {};
let idRev = 0;
let iconRev = 0;
let iconQueued = false;
const idListeners = new Set();
const iconListeners = new Set();

const subscribeIds = (fn) => {
  idListeners.add(fn);
  return () => idListeners.delete(fn);
};
const subscribeIcons = (fn) => {
  iconListeners.add(fn);
  return () => iconListeners.delete(fn);
};
const getIdRev = () => idRev;
const getIconRev = () => iconRev;

// 节点每渲染都会换新（状态、弹层、徽标），按帧合并一次通知：一排图标里十几颗按钮，
// 各自 setState 不划算，也扛不住流式输出那种每帧都渲染的频率
function scheduleIcons() {
  if (iconQueued) return;
  iconQueued = true;
  requestAnimationFrame(() => {
    iconQueued = false;
    iconRev += 1;
    for (const fn of iconListeners) fn();
  });
}

function publishSurface(name, def) {
  const prev = surfaces.get(name);
  const entry = {
    ids: def.ids || [],
    idKey: (def.ids || []).join("|"),
    homes: def.homes || {},
    nodes: def.nodes || {},
    labels: def.labels || {},
  };
  surfaces.set(name, entry);
  nodeMap = {};
  labelMap = {};
  for (const s of surfaces.values()) {
    Object.assign(nodeMap, s.nodes);
    Object.assign(labelMap, s.labels);
  }
  if (!prev || prev.idKey !== entry.idKey) {
    idRev += 1;
    for (const fn of idListeners) fn();
  }
  scheduleIcons();
}

/** 某个 id 当前的节点 / 名称（跨表面查，注册方最后一帧渲染出来的那份） */
export function iconNode(id) {
  return nodeMap[id];
}
export function iconLabel(id) {
  return labelMap[id];
}

// 节点里第一颗带 title 的按钮：图标库 / 右键菜单要一句人话，
// 但很多图标是「包一层 div 再放按钮」的，外层的 props.title 是空的
function firstTitle(node) {
  if (!node || typeof node !== "object") return "";
  const p = node.props;
  if (!p) return "";
  if (typeof p.title === "string" && p.title) return p.title;
  const kids = p.children;
  if (Array.isArray(kids)) {
    for (const k of kids) {
      const v = firstTitle(k);
      if (v) return v;
    }
    return "";
  }
  return firstTitle(kids);
}

/** 图标名称：登记时给了就用，否则从节点的 title 里抠（去掉「· 当前值」这类后缀） */
export function iconText(id) {
  if (labelMap[id]) return labelMap[id];
  const title = firstTitle(nodeMap[id]);
  return title ? title.split(/[：·]/)[0].trim() : id;
}

function unionIds() {
  const out = [];
  for (const s of surfaces.values()) out.push(...s.ids);
  return out;
}
function unionHomes() {
  const out = {};
  for (const s of surfaces.values()) Object.assign(out, s.homes);
  return out;
}

/**
 * 一处图标排把自己这一批图标登记进来。
 * def = { ids, homes, nodes, labels }：ids / homes 用带前缀的 id，nodes、labels 同键。
 * 每次渲染都提交一次（节点会随状态变），只有 id 集合变化才叫醒建布局的那一层。
 */
export function useIconSurface(name, def) {
  const ref = useRef(def);
  ref.current = def;
  useLayoutEffect(() => publishSurface(name, ref.current));
}

// ── 旧存档迁移 ────────────────────────────────────────────────────────────
function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

/**
 * 合并三份旧布局（rail / title / chat）成一张全站表：老图标 id 没有前缀，统一补上；
 * 三个 hidden 合成一份；对话页最早那个纯数组格式（bit.chatTools.v1）按工具栏一排读。
 */
function migrateLegacy() {
  const rail = readJSON(legacyKey("rail"));
  const title = readJSON(legacyKey("title"));
  const chat = readJSON(legacyKey("chat")) || readJSON(OLD_CHAT_KEY);
  const out = { rail: [], title: [], chatToolbar: [], chatFooter: [], hidden: [] };
  const seen = new Set();
  const take = (arr, prefix, zone) => {
    for (const id of Array.isArray(arr) ? arr : []) {
      const cid = prefix + id;
      if (seen.has(cid)) continue;
      seen.add(cid);
      out[zone].push(cid);
    }
  };
  take(rail?.nav, "rail:", "rail");
  take(title?.tools, "title:", "title");
  if (Array.isArray(chat)) take(chat, "chat:", "chatToolbar");
  else {
    take(chat?.toolbar, "chat:", "chatToolbar");
    take(chat?.footer, "chat:", "chatFooter");
  }
  take(rail?.hidden, "rail:", "hidden");
  take(title?.hidden, "title:", "hidden");
  take(chat?.hidden, "chat:", "hidden");
  return out;
}

/**
 * 一次性搬家：老存档里摆在会话列表底部那排（chatFooter）的对话页图标，默认抬到输入框那一排。
 * 底部那排仍然保留（想挪下去随时拖），只是出厂态不再分两排摆。
 * 只搬 chat: 前缀的——别家的图标是用户自己拖下去的，不动它。抬完打一次标记，
 * 之后用户再往下拖就是他的选择，不会再被自动收回。
 */
const FOOTER_UP_KEY = "bit.iconFooterUp.v1";
function liftFooterOnce() {
  if (localStorage.getItem(FOOTER_UP_KEY)) return;
  localStorage.setItem(FOOTER_UP_KEY, "1");
  const saved = readJSON(legacyKey("space"));
  const footer = Array.isArray(saved?.chatFooter) ? saved.chatFooter : [];
  const up = footer.filter((id) => String(id).startsWith("chat:"));
  if (!saved || up.length === 0) return;
  const toolbar = Array.isArray(saved.chatToolbar) ? [...saved.chatToolbar] : [];
  for (const id of up) if (!toolbar.includes(id)) toolbar.push(id);
  localStorage.setItem(
    legacyKey("space"),
    JSON.stringify({ ...saved, chatToolbar: toolbar, chatFooter: footer.filter((id) => !up.includes(id)) })
  );
}

// ── 布局与上下文 ──────────────────────────────────────────────────────────
const SpaceCtx = createContext(null);
export function IconSpaceProvider({ children }) {
  useSyncExternalStore(subscribeIds, getIdRev, getIdRev); // id 集合变了要重算全集
  const ids = unionIds();
  const defaults = { ...unionHomes(), [DEFAULTS_ORDER]: ids };
  liftFooterOnce(); // 必须在建布局之前：布局读的就是这份存档
  const space = useIconLayout("space", {
    zones: SPACE_ZONES,
    ids,
    defaults,
    axis: SPACE_AXIS,
    initial: migrateLegacy,
  });
  return <SpaceCtx.Provider value={space}>{children}</SpaceCtx.Provider>;
}

export function useIconSpace() {
  const space = useContext(SpaceCtx);
  if (!space) throw new Error("useIconSpace 必须在 IconSpaceProvider 内使用");
  return space;
}

/**
 * 画一颗图标：优先用注册表里的（别人家的图标也能在这儿画出来），
 * 注册表里没有才用宿主传进来的本地节点。订阅版本号，持有方一渲染就跟着换新。
 */
export function LiveIcon({ id, node }) {
  useSyncExternalStore(subscribeIcons, getIconRev, getIconRev);
  return iconNode(id) ?? node ?? null;
}
