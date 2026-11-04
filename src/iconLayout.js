/**
 * 全站图标位的共用拖拽布局。
 *
 * 一个「组」= 一张布局表，组里可以有多个「区」，每个区就是一条有序 id 列表；
 * 用户拖动改的就是这个顺序，跨区拖动 = 把图标从一排挪到另一排；
 * 右键图标 = 摘下来进本组的图标库（存档里的 hidden），右键空白 = 从图标库里捞回来。
 * 存档一份一组：localStorage["bit.iconLayout.<组>"]。
 *
 * 全站现在只用一组（"space"）：左栏导航 / 页眉工具簇 / 输入框工具栏
 * 是三条区，图标可以拖到任何一条上，详见 iconSpace.jsx。
 * 组件本身只认「组」：别的调用方仍可以单独开一组，互不干扰。
 *
 * 只存 id 顺序，不存任何内容：图标本身长什么样、点了干什么，全由宿主自己决定，
 * 所以手写坏数据、版本升级增删图标、插件装卸带来的图标增减，都在这里统一自愈。
 *
 * 全站唯一：一个 id 在整张表里只占一格。载入时 repairLayout 去重，拖拽 / 从图标库捞回 /
 * 从「添加图标」菜单跨区添加都先把 id 从所有区摘掉再落位——在某一区添加，另一区必然消失。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// 全局开关：关掉之后所有图标排都不响应拖拽（设置中心那一张卡控制）
export const DRAG_KEY = "bit.iconDrag.v1";
const OLD_DRAG_KEY = "bit.chatToolsDrag.v1";
const OLD_CHAT_KEY = "bit.chatTools.v1";
const PREFIX = "bit.iconLayout.";

// 存档里的保留键：这一组被右键「移除」的图标。它们不占屏上位置，但仍是这一组的一员，
// 从空白处右键的图标库里可以再捞回来；「恢复默认」会连隐藏位一起清掉。
export const HIDDEN_ZONE = "hidden";

// defaults 里的保留键：图标们的默认先后（宿主自己那条顺序数组）。
// 右键摘掉再捞回来时按它复位——不然总落在这排末尾，导航项会被挤到最后一格。
export const DEFAULTS_ORDER = "__order";

// 区名对应的文案 key：右键菜单里要告诉用户「这个图标现在在哪一区」，
// 跨区添加后原处会消失。具体语言由各宿主用 t() 翻。
export const ZONE_LABEL_KEYS = {
  rail: "icon.zoneRail",
  title: "icon.zoneTitle",
  chatToolbar: "icon.zoneToolbar",
  chatFooter: "icon.zoneFooter",
};

// 跨组件广播：设置页改了开关 / 点了恢复默认，各处图标排都要跟着重算
export const EVT_DRAG = "bit-icon-drag";
export const EVT_RESET = "bit-icon-layout-reset";

const keyOf = (group) => PREFIX + group;

/** 拖拽总开关当前是否打开（默认开） */
export function dragEnabled() {
  const v = localStorage.getItem(DRAG_KEY);
  if (v !== null) return v !== "0";
  const old = localStorage.getItem(OLD_DRAG_KEY); // 旧键只叫"对话页图标可拖拽"，迁移一次
  return old === null ? true : old !== "0";
}

/** 设置拖拽总开关并广播（各处图标排订阅同一个事件） */
export function setDragEnabled(on) {
  localStorage.setItem(DRAG_KEY, on ? "1" : "0");
  localStorage.removeItem(OLD_DRAG_KEY);
  window.dispatchEvent(new CustomEvent(EVT_DRAG));
}

/** 所有图标排一起回到默认位置 */
export function resetAllIconLayouts() {
  window.dispatchEvent(new CustomEvent(EVT_RESET));
}

const same = (a, b) => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k] || [];
    const y = b[k] || [];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
};

/**
 * 按「当前已知 id 全集」修一份布局：
 * 重复的只留第一次，缺的补回它的默认区，返回的对象一定覆盖 zones 里的每一个区（外加 hidden）。
 *
 * 暂时不认识的 id 原样留在原位，不删——插件清单是异步水合的，启动第一帧拿到的必然是
 * 「半个全集」，这时候按未知剔除会把用户给插件图标排好的位置每次开机冲一遍。
 * 渲染走 order() 过滤，多留的几个根本不上屏，只有「恢复默认」会把它们清走。
 */
export function repairLayout(raw, zones, ids, defaults = {}) {
  const taken = new Set();
  const out = {};
  const keys = [...zones, HIDDEN_ZONE];
  for (const z of keys) out[z] = [];
  const put = (z, id) => {
    if (taken.has(id)) return;
    taken.add(id);
    (out[z] || (out[z] = [])).push(id);
  };
  for (const z of keys) {
    const arr = raw && Array.isArray(raw[z]) ? raw[z] : [];
    for (const id of arr) put(z, id);
  }
  for (const id of ids) {
    if (taken.has(id)) continue;
    const home = defaults[id] && zones.includes(defaults[id]) ? defaults[id] : zones[0];
    put(home, id);
  }
  return out;
}

function loadLayout(group, zones, ids, defaults, initial) {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(keyOf(group)) || "null");
    // 对话页那两排最早叫 bit.chatTools.v1，读一次旧键把顺序接上（新键写入后即失效）
    if (!raw && group === "chat") raw = JSON.parse(localStorage.getItem(OLD_CHAT_KEY) || "null");
  } catch {
    raw = null; // 坏 JSON 视同没有存档，直接吃默认布局
  }
  // initial：这一组第一次出现时从别处接过来的旧布局（见 iconSpace.jsx 的三组合并）
  if (!raw && initial) {
    try {
      raw = initial();
    } catch {
      raw = null;
    }
  }
  return repairLayout(raw, zones, ids, defaults);
}

/**
 * 把几条区在屏上并成一排看（侧栏折叠时 footer 并回输入框工具栏就是这种用法）。
 * 返回一个和布局对象同形的壳：order 把几条区首尾相接，拖动写回时摊平进第一条区。
 * 只影响「怎么看、怎么落」，存档格式不变。
 */
export function mergeView(layout, zones) {
  if (!zones || zones.length < 2) return layout;
  const head = zones[0];
  const flat = () => zones.reduce((acc, z) => acc.concat(layout.order(z)), []);
  return {
    ...layout,
    order: (z) => (z === head ? flat() : []),
    slotProps: (z, id) => layout.slotProps(z, id, zones),
    zoneProps: (z) => layout.zoneProps(z, zones),
    show: (id) => layout.show(id, head),
    // 并排后 footer 的图标也画在头一条区上：别再把它们算成「在别处」
    elsewhere: () => {
      const here = new Set(flat());
      return layout.elsewhere(head).filter((id) => !here.has(id));
    },
    zoneOf: (id) => (flat().includes(id) ? head : layout.zoneOf(id)),
  };
}

/**
 * 一组可拖拽图标位的布局。
 *
 * @param group    组名，决定存档键
 * @param zones    区名列表（顺序 = 新图标兜底时的优先落位）
 * @param ids      当前已知的全部图标 id（会随插件装卸 / 版本升级变化）
 * @param defaults id -> 默认所在区；没登记的落 zones[0]；另用 DEFAULTS_ORDER 键给出默认先后（捞回来时照它复位）
 * @param axis     "x" | "y"，或 区 -> 轴向；决定拖拽时按左右半区还是上下半区算插入位
 * @param initial  没有存档时用来接旧布局的函数（返回和存档同形的对象）
 */
export function useIconLayout(group, { zones, ids, defaults = {}, axis = {}, initial = null }) {
  const idKey = ids.join("|");
  const zoneKey = zones.join("|");
  const defaultKey = JSON.stringify(defaults);
  const axisOf = typeof axis === "string" ? Object.fromEntries(zones.map((z) => [z, axis])) : axis;

  const [layout, setLayout] = useState(() => loadLayout(group, zones, idKey.split("|").filter(Boolean), defaults, initial));
  const [enabled, setEnabled] = useState(dragEnabled);
  const dragIdRef = useRef(null); // 正在拖的 id（同步读，不等 state）
  const dragZoneRef = useRef(null); // 拖起来时所在区
  const dragPinnedRef = useRef(false); // 源不跟着悬停落位（浮层里拖出来的那类）
  const [draggingId, setDraggingId] = useState("");

  // 已知 id 全集变了（插件装卸、页面增减）：缺的补回默认区，认不出的留原位，用户排好的顺序不动
  useEffect(() => {
    setLayout((prev) => {
      const next = repairLayout(prev, zoneKey.split("|"), idKey.split("|").filter(Boolean), JSON.parse(defaultKey || "{}"));
      return same(next, prev) ? prev : next;
    });
  }, [idKey, zoneKey, defaultKey]);

  // 落盘：拖完这一次布局就是新的，立刻写，别等被动副作用——
  // 拖完手一快就刷新页面的话，被动副作用可能还没轮到执行。
  useLayoutEffect(() => {
    try {
      localStorage.setItem(keyOf(group), JSON.stringify(layout));
    } catch {
      /* 隐私模式 / 配额满：拖拽照样能用，只是下次启动回到默认位 */
    }
  }, [group, layout]);

  // 开关与"恢复默认"都是跨组件事件：设置页发，各处图标排收
  useEffect(() => {
    const sync = () => setEnabled(dragEnabled());
    const reset = () => setLayout(repairLayout(null, zoneKey.split("|"), idKey.split("|").filter(Boolean), JSON.parse(defaultKey || "{}")));
    window.addEventListener(EVT_DRAG, sync);
    window.addEventListener("storage", sync);
    window.addEventListener(EVT_RESET, reset);
    return () => {
      window.removeEventListener(EVT_DRAG, sync);
      window.removeEventListener("storage", sync);
      window.removeEventListener(EVT_RESET, reset);
    };
  }, [idKey, zoneKey, defaultKey]);

  const move = useCallback(
    (id, zone, index) =>
      setLayout((prev) => {
        const clamp = (arr, i) => Math.max(0, Math.min(i, arr.length));
        const next = {};
        for (const z of zones) next[z] = (prev[z] || []).filter((x) => x !== id);
        const arr = next[zone] || (next[zone] = []);
        arr.splice(clamp(arr, index), 0, id);
        next[HIDDEN_ZONE] = prev[HIDDEN_ZONE] || [];
        return same(next, prev) ? prev : next;
      }),
    // zones 只随组定义变，用 zoneKey 当依赖避免每次渲染换函数
    [zoneKey],
  );

  /** 右键「从这一排移除」：从所在区摘掉，进本组的图标库（hidden），顺序记在末尾 */
  const hide = useCallback(
    (id) =>
      setLayout((prev) => {
        const next = {};
        for (const z of [...zones, HIDDEN_ZONE]) next[z] = (prev[z] || []).filter((x) => x !== id);
        next[HIDDEN_ZONE].push(id);
        return same(next, prev) ? prev : next;
      }),
    [zoneKey],
  );

  /**
   * 从图标库捞回来：插回它本来该在的位置。
   * 区没指定或指定得不合法就回它的默认区；
   * 下标按 defaults.__order 里排在它前面、且此刻还在这排上的图标数现算——
   * 这样「摘掉→加回来」落回原位，而不是每次都堆到队尾。
   */
  const show = useCallback(
    (id, zone) =>
      setLayout((prev) => {
        const home = defaults[id] && zones.includes(defaults[id]) ? defaults[id] : zones[0];
        const target = zones.includes(zone) ? zone : home;
        const order = defaults[DEFAULTS_ORDER] || [];
        const before = order.slice(0, Math.max(0, order.indexOf(id))).filter((x) => x !== id && (prev[target] || []).includes(x));
        const next = {};
        for (const z of [...zones, HIDDEN_ZONE]) next[z] = (prev[z] || []).filter((x) => x !== id);
        const arr = next[target];
        arr.splice(before.length, 0, id);
        return same(next, prev) ? prev : next;
      }),
    [zoneKey, defaultKey],
  );

  const endDrag = useCallback(() => {
    dragIdRef.current = null;
    dragZoneRef.current = null;
    dragPinnedRef.current = false;
    setDraggingId("");
  }, []);

  /**
   * 该区屏上实际渲染的 id 顺序。
   * 读的是「当前已知 id 全集」投影后的结果：存档里失效的 id 直接不显示，
   * 还没来得及落盘的 newcomers 追在末尾——省得每个宿主自己防「刚装卸就崩」那一帧。
   */
  const order = (zone) => {
    const shown = (layout[zone] || []).filter((id) => ids.includes(id));
    // 「新人」只认整组都没出现过的 id：兄弟区里已经排好的、以及被右键摘进图标库的都不是新人，
    // 前者不然每一排会把别人的图标再抄一遍，后者不然摘掉的图标又自己冒回来
    const parked = layout[HIDDEN_ZONE] || [];
    const seen = zones.reduce((acc, z) => acc.concat(layout[z] || []), []).concat(parked);
    // 补位只补到它自己的默认区：三条区共用一张表时，每个新人同时出现在三排上会闪一帧
    const homeOf = (id) => (defaults[id] && zones.includes(defaults[id]) ? defaults[id] : zones[0]);
    const extra = ids.filter((id) => !seen.includes(id) && homeOf(id) === zone);
    return extra.length ? shown.concat(extra) : shown;
  };

  /** 图标库：本组已知但没在任何一排上露面的 id（右键摘掉的那些），空白处右键可捞回来 */
  const library = () => ids.filter((id) => !zones.some((z) => order(z).includes(id)));

  /** 当前落在哪条区：隐藏 / 存档里认不出的归 hidden */
  const zoneOf = (id) => {
    for (const z of zones) if (order(z).includes(id)) return z;
    return HIDDEN_ZONE;
  };

  /**
   * 别区正在显示的图标：可以从「添加图标」菜单直接挪过来。
   * 只看屏上顺序（order）；hidden 的归图标库，不走这一份。
   */
  const elsewhere = (zone) => {
    const here = new Set(order(zone));
    return ids.filter((id) => !here.has(id) && zones.some((z) => order(z).includes(id)));
  };

  /**
   * 几条区并成一排时的「摊平写回」：落点下标是并排后的下标，
   * 存的时候全塞进第一条区、其余区清空。
   */
  const moveFlat = useCallback(
    (flatZones, id, index) =>
      setLayout((prev) => {
        const all = [];
        for (const z of flatZones) for (const x of prev[z] || []) if (x !== id) all.push(x);
        all.splice(Math.max(0, Math.min(index, all.length)), 0, id);
        const next = {};
        for (const z of zones) next[z] = flatZones.includes(z) ? [] : prev[z] || [];
        next[flatZones[0]] = all;
        next[HIDDEN_ZONE] = prev[HIDDEN_ZONE] || [];
        return same(next, prev) ? prev : next;
      }),
    [zoneKey],
  );

  /**
   * 单个图标外层容器的 props：draggable + 落在谁身上就插到它前/后（插哪一格现算，调用方不用管下标）。
   * pin=true：悬停时不跟着落位，松手才搬（⋯ 浮层里的图标用）。
   * 跨区拖拽同样不在悬停时落位——图标一旦从源排里摘走，浏览器就把这个拖拽源丢了，
   * 松手时既没有 drop 也没有 dragend，界面会卡在「正在拖」的半透明态。
   */
  const slotProps = (zone, id, flatZones = null, pin = false) => ({
    draggable: enabled,
    onDragStart: (e) => {
      dragIdRef.current = id;
      dragZoneRef.current = zone;
      dragPinnedRef.current = pin;
      setDraggingId(id);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    },
    onDragOver: (e) => {
      const src = dragIdRef.current;
      if (!enabled || !src) return;
      e.preventDefault(); // 就算不落位也要接住，drop 才会来
      if (dragPinnedRef.current || zone !== dragZoneRef.current) return;
      if (src === id) return;
      const r = e.currentTarget.getBoundingClientRect();
      const after = axisOf[zone] === "y" ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
      // 落点按「屏上现在的顺序」现算，不吃调用方传进来的 index：
      // 实时改序时同一坐标下面已经换了图标，用旧下标会来回换位（拖一次抖一整排）。
      const list = flatZones ? flatZones.reduce((acc, z) => acc.concat(order(z)), []) : order(zone);
      const hov = list.indexOf(id);
      if (hov < 0) return;
      const cur = list.indexOf(src);
      let target = after ? hov + 1 : hov;
      if (cur >= 0 && cur < target) target -= 1; // 自己让位时后面整体前移一格
      if (cur >= 0 && cur === target) return; // 已经在这一格，别再写一遍
      if (flatZones) moveFlat(flatZones, src, target);
      else move(src, zone, target);
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const src = dragIdRef.current;
      if (!enabled || !src || src === id) {
        endDrag();
        return;
      }
      // 松手统一按落点定最终位置：悬停时已经落好的（cur === target）不再重复写
      const list = flatZones ? flatZones.reduce((acc, z) => acc.concat(order(z)), []) : order(zone);
      const hov = list.indexOf(id);
      if (hov >= 0) {
        const r = e.currentTarget.getBoundingClientRect();
        const after = axisOf[zone] === "y" ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
        const cur = list.indexOf(src);
        let target = after ? hov + 1 : hov;
        if (cur >= 0 && cur < target) target -= 1;
        if (cur !== target) {
          if (flatZones) moveFlat(flatZones, src, target);
          else move(src, zone, target);
        }
      }
      endDrag();
    },
    onDragEnd: endDrag,
    "data-bit-icon-id": id,
    className: `flex shrink-0 justify-center ${enabled ? "cursor-grab active:cursor-grabbing" : ""} ${draggingId === id ? "opacity-40" : ""}`,
  });

  /** 整条区的 props：拖到空白处 = 追加到该区末尾（区被拖空后也还能再拖回来） */
  const zoneProps = (zone, flatZones = null) => ({
    "data-bit-icon-zone": zone,
    onDragOver: (e) => {
      if (enabled && dragIdRef.current) e.preventDefault();
    },
    onDrop: (e) => {
      // 只认本组自己发起的拖拽。不能回退读 dataTransfer：Electron 预加载为了接住系统
      // 文件拖入，在 document 上无条件 preventDefault 了 dragover，于是每个元素都是合法
      // 落点——回退读会把别的组的图标 id 也记进本组存档（拖一次对话页图标，左栏多一枚）。
      const src = dragIdRef.current;
      if (!enabled || !src) return;
      e.preventDefault();
      if (flatZones) moveFlat(flatZones, src, flatZones.reduce((n, z) => n + order(z).length, 0));
      else move(src, zone, order(zone).length);
      endDrag();
    },
  });

  return { layout, setLayout, move, hide, show, library, elsewhere, zoneOf, enabled, draggingId, slotProps, zoneProps, order };
}
