import { useEffect, useRef, useState } from "react";

const KEY = "bit.theme.v1";
const ACCENT_KEY = "bit.accent.v1";
const LOOK_KEY = "bit.look.v1";

function apply(mode) {
  const isDark =
    mode === "dark" ||
    (mode === "auto" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  return isDark;
}

// 按亮度自动决定强调色上的前景色（深色字 / 白字）
function applyAccent(color) {
  const root = document.documentElement;
  if (!color) {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-fg");
    return;
  }
  root.style.setProperty("--accent", color);
  const m = color.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  root.style.setProperty("--accent-fg", lum > 0.6 ? "#171717" : "#ffffff");
}

// 图标栏圆片边长（px）：CSS 变量和 React 内联尺寸共用同一个取数口径。
// 主题导入是整包 JSON，navSize 写成 0 / 200 都会把侧栏挤没或撑出窗口，这里统一夹住。
export function railItemPx(look) {
  const raw = Number(look?.navSize);
  if (!Number.isFinite(raw)) return DEFAULT_LOOK.navSize;
  return Math.min(48, Math.max(20, Math.round(raw)));
}

// 外观配置：背景色/透明度/图片/圆角，统一走 CSS 变量
// look 结构：{ enabled, bgColorLight, bgColorDark, bgOpacity, cardOpacity, bgImage, borderOn, borderRadius,
//   cardRadius, shadowOn, fieldBgImage, fieldBgOpacity, chatBgImage, chatBgOpacity, navLabelOn, navSize }（cardOpacity 未设=跟随背景+15%）
function applyLook(input) {
  const root = document.documentElement;
  // 字体缩放：Tailwind 全 rem 布局，调根字号即全局等比缩放（窗口级属性，独立于外观开关）。
  // 夹在滑杆区间内：主题导入是整包 JSON，fontScale 写成 0 / 3 都会绕过滑杆直接把布局撑坏
  const raw = Number(input?.fontScale);
  const scale = Number.isFinite(raw) ? Math.min(1.2, Math.max(0.85, raw)) : 1;
  if (scale === 1) root.style.removeProperty("font-size");
  else root.style.fontSize = `${(16 * scale).toFixed(1)}px`;
  // 窗口外圆角：窗口级属性，独立于外观定制开关（透明窗体走 CSS 圆角，DWM 不给圆角）
  root.style.setProperty("--win-radius", (input?.winRadius ?? 0) + "px");
  // 图标栏圆片边长：同为布局属性，关闭外观定制时也要保持用户调好的大小
  //（导航项、指示圆片、整条栏宽都由这一个变量撑开）
  root.style.setProperty("--rail-item", railItemPx(input) + "px");
  // 关闭外观定制 ≠ 什么都不设：变量全清空后透明窗体就没有实色底，整窗看穿桌面
  //（卡片之外的侧栏/页眉/留白全废）。改套 OFF_LOOK 这套可读默认档，走同一条渲染路径。
  const look = input && input.enabled ? input : OFF_LOOK;
  // 背景色（light/dark 各自生效）
  if (look.bgColorLight) root.style.setProperty("--look-bg-color-light", look.bgColorLight);
  else root.style.removeProperty("--look-bg-color-light");
  if (look.bgColorDark) root.style.setProperty("--look-bg-color-dark", look.bgColorDark);
  else root.style.removeProperty("--look-bg-color-dark");

  // 透明度：背景 + 卡片/pill/chip 也跟着半透明（不透明度 = 背景透明度 + 15%，保证内容可读）
  const op = look.bgOpacity != null ? look.bgOpacity : 100;
  root.style.setProperty("--look-bg-opacity", op + "%");
  // 卡片/pill 的 alpha：默认跟随背景（背景+15% 保证可读），用户在外观页单独设置后独立固定
  const cardOp = look.cardOpacity != null ? look.cardOpacity : Math.min(100, Math.max(30, op + 15));
  root.style.setProperty("--look-card-alpha", (Math.min(100, Math.max(10, cardOp)) / 100).toFixed(2));
  if (look.bgImage) {
    root.style.setProperty("--app-bg-image", `url("${look.bgImage}")`);
    // 遮罩浓度（0-100 → 透明黑纱 alpha；默认 0 = 原图原色，无色差）
    root.style.setProperty("--look-bg-scrim", ((look.bgScrim ?? 0) / 100).toFixed(2));
    root.classList.add("has-bg-image");
  } else {
    root.style.removeProperty("--app-bg-image");
    root.style.removeProperty("--look-bg-scrim");
    root.classList.remove("has-bg-image");
  }

  // 输入框/聊天框专属背景：独立图片 + 独立透明度；无图且 100% 时不挂类（保持原样式零回归）
  const panelBg = (img, alpha, imgVar, alphaVar, cls) => {
    if (img) root.style.setProperty(imgVar, `url("${img}")`);
    else root.style.removeProperty(imgVar);
    const a = alpha != null ? alpha : 100;
    root.style.setProperty(alphaVar, a + "%");
    root.classList.toggle(cls, !!img || a < 100);
  };
  panelBg(look.fieldBgImage, look.fieldBgOpacity, "--panel-input-image", "--panel-input-alpha", "has-input-bg");
  panelBg(look.chatBgImage, look.chatBgOpacity, "--panel-chat-image", "--panel-chat-alpha", "has-chat-bg");

  // 圆角
  root.style.setProperty("--look-card-radius", (look.cardRadius ?? 24) + "px");
  // 输入框/对话圆角（独立调节）：0/未设 = 回退各元素原生圆角（胶囊/16/24）
  const uiRadius = look.uiRadius ?? 0;
  if (uiRadius > 0) root.style.setProperty("--look-ui-radius", uiRadius + "px");
  else root.style.removeProperty("--look-ui-radius");

  // 边框 & 阴影开关
  root.classList.toggle("no-border", !look.borderOn);
  root.classList.toggle("no-shadow", !look.shadowOn);
  // 搜索控件样式（侧栏搜索 / 悬浮搜索面板 / 页眉放大镜一起跟着）
  const searchStyle = look.searchStyle || "auto";
  root.classList.toggle("search-accent", searchStyle === "accent");
  root.classList.toggle("search-ghost", searchStyle === "ghost");
  // 透明度联动：背景 < 100% 或卡片单独调过透明度时，给卡片/按钮加半透明样式
  root.classList.toggle("has-transparency", op < 100 || cardOp < 100);
}

// 默认即「启用外观定制」：开箱即带主题色、背景色、透明度，不再回退到黑白胶囊风
const DEFAULT_LOOK = {
  enabled: true,
  bgColorLight: "#ffffff",
  bgColorDark: "#18181b",
  bgOpacity: 90,
  bgImage: "",
  borderOn: true,
  borderRadius: 0,
  cardRadius: 24,
  uiRadius: 0,
  winRadius: 16,
  fontScale: 1,
  shadowOn: true,
  // 输入框/聊天框专属背景（各自独立；默认无图且 100% = 原样式）
  fieldBgImage: "",
  fieldBgOpacity: 100,
  chatBgImage: "",
  chatBgOpacity: 100,
  // 搜索控件样式：auto=跟随输入框胶囊；accent=放大镜用主题色实心；ghost=无边框融入面板
  searchStyle: "auto",
  // 图标栏悬停是否浮出名称（title 提示）；关掉后圆片纯图标，不再弹系统 tooltip
  navLabelOn: true,
  // 图标栏圆片边长（px）：36 是旧版固定值，默认收到 28（约 -22%）把宽度让给内容区
  navSize: 28,
};

// 「关闭外观定制」时实际生效的那一档：即提示语说的「默认黑白胶囊风」。
// 与 DEFAULT_LOOK 的差别只在不透明白底 + 无图片（bgOpacity 90% 是开箱的定制观感，
// 关闭态要的是最稳的可读性），其余圆角/边框/阴影沿用默认，保证卡片层次还在。
const OFF_LOOK = {
  ...DEFAULT_LOOK,
  enabled: true,
  bgColorLight: "#ffffff",
  bgColorDark: "#18181b",
  bgOpacity: 100,
  cardOpacity: 100,
  bgImage: "",
  fieldBgImage: "",
  fieldBgOpacity: 100,
  chatBgImage: "",
  chatBgOpacity: 100,
  borderOn: true,
  shadowOn: true,
  searchStyle: "auto",
};

/// 从 localStorage 读当前外观配置（补齐默认值），供订阅 bit-look 的组件即时取最新值
export function readLook() {
  try {
    const raw = localStorage.getItem(LOOK_KEY);
    if (raw) return { ...DEFAULT_LOOK, ...JSON.parse(raw) };
  } catch {
    /* 坏 JSON 回退默认 */
  }
  return { ...DEFAULT_LOOK };
}

// 背景图转码压缩：Chromium 对 CSS 变量值有约 2MB 硬上限，超限时 setProperty
// 整体拒收、回读为空——表现为"has-bg-image 遮罩生效（背景变暗）但图片不显示"；
// localStorage 配额同样有限。上传与存量迁移统一压到 ≤1920px / ≤1.9MB，
// 背景图有 cover 缩放 + 35% 黑遮罩，肉眼无感差异。
const BG_LIMIT = 1.9 * 1024 * 1024;
export function compressBgImage(dataUrl, maxDim = 1920) {  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, c.width, c.height);
        // WEBP 更小且保透明；个别环境 canvas 不支持导出 webp → JPEG（铺白底防透明区发黑）
        let type = "image/webp";
        let out = c.toDataURL(type, 0.85);
        if (!out.startsWith("data:image/webp")) {
          type = "image/jpeg";
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          out = c.toDataURL(type, 0.85);
        }
        // 仍超限 → 逐档降质量
        for (let q = 0.7; out.length > BG_LIMIT && q >= 0.4; q -= 0.15) {
          out = c.toDataURL(type, q);
        }
        // 极端情况还超限 → 缩小画布再来
        while (out.length > BG_LIMIT && c.width > 640) {
          c.width = Math.max(1, Math.round(c.width * 0.7));
          c.height = Math.max(1, Math.round(c.height * 0.7));
          if (type === "image/jpeg") {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, c.width, c.height);
          }
          ctx.drawImage(img, 0, 0, c.width, c.height);
          out = c.toDataURL(type, 0.7);
        }
        resolve(out);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl); // 解码失败（如 HEIC）保持原样
    img.src = dataUrl;
  });
}

/** 主题：light / dark / auto + 自定义强调色（--accent）。
 * 主题标记存 bit.db（config.theme）统一读取——托盘/任务面板共用（localStorage 仅作首帧缓存） */
function pushTheme(mode) {
  try {
    const inv = window.__TAURI_INTERNALS__?.invoke;
    if (inv) inv("set_theme", { theme: mode }).catch?.(() => {});
  } catch { /* best-effort */ }
}

export function useTheme() {
  // 首帧默认深色：新装没有缓存时直接落到推荐外观的深色档（库里有值时下面再同步覆盖）
  const [mode, setMode] = useState(() => localStorage.getItem(KEY) || "dark");
  const [isDark, setIsDark] = useState(() => apply(localStorage.getItem(KEY) || "dark"));
  // 默认主题色：橙色 #ea580c（与外观定制页推荐配置一致，避免开箱是彩虹无主题态）
  const [accent, setAccentState] = useState(() => localStorage.getItem(ACCENT_KEY) || "#ea580c");
  const [look, setLookState] = useState(() => {
    try {
      const raw = localStorage.getItem(LOOK_KEY);
      if (raw) return { ...DEFAULT_LOOK, ...JSON.parse(raw) };
    } catch { /* ignore bad JSON */ }
    return { ...DEFAULT_LOOK };
  });

  // 首帧只写本地缓存，不回写数据库：localStorage 仅作缓存，数据库才是权威。
  // 若挂载时把缓存里的旧值 push 回库，会抢在 get_theme 之前把别的宿主刚改的主题覆盖掉。
  const pushReady = useRef(false);
  useEffect(() => {
    localStorage.setItem(KEY, mode);
    if (pushReady.current) pushTheme(mode);
    else pushReady.current = true;
    setIsDark(apply(mode));
    if (mode !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setIsDark(apply("auto"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  // 启动同步：以数据库为准（其他宿主改主题时保持一致）。best-effort，仅在值不同时切换
  useEffect(() => {
    let alive = true;
    try {
      const inv = window.__TAURI_INTERNALS__?.invoke;
      if (inv) {
        inv("get_theme", {})
          .then((r) => {
            const t =
              r?.theme === "dark" || r?.theme === "light" || r?.theme === "auto" ? r.theme : "dark";
            if (alive && t !== mode) setMode(t);
          })
          .catch?.(() => {});
      }
    } catch { /* ignore */ }
    return () => { alive = false; };
  }, []);
  // 仅挂载时同步一次（闭包里的 mode 为首帧值；值相同时 setMode 不触发写库，无循环风险）

  // 强调色变化立即生效（首次启动也恢复上次选择）。
  // 关闭外观定制时不注入自定义强调色：内联 --accent 撤掉后回落到 styles.css 的内置黑白，
  // 与开关提示的「默认黑白胶囊风格」一致（外观页关闭时主题色控件本身也已禁用）。
  useEffect(() => {
    localStorage.setItem(ACCENT_KEY, accent);
    applyAccent(look.enabled ? accent : null);
  }, [accent, look.enabled]);

  // 外观配置变化立即生效
  useEffect(() => {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
    applyLook(look);
    // look 是每个 useTheme() 各自持有的副本：CSS 类走 applyLook 天然全局生效，
    // 但读 look 具体值的 React 组件（如图标栏悬停名称开关）得靠这个事件才即时刷新
    window.dispatchEvent(new CustomEvent("bit-look"));
  }, [look]);

  // 存量迁移：早期版本把原图 data URL 直写 CSS 变量，超过 ~2MB 会被 Chromium
  // 整体拒收（背景变暗但看不到图）——打开时自动转码到限内，一次性修复坏配置
  useEffect(() => {
    const bi = look.bgImage;
    if (bi && bi.startsWith("data:") && bi.length > BG_LIMIT) {
      compressBgImage(bi).then((small) => {
        if (small !== bi) {
          setLookState((l) => (l.bgImage === bi ? { ...l, bgImage: small } : l));
        }
      });
    }
  }, [look.bgImage]);

  // 最大化/全屏时窗口外圆角归零（贴边不留缝），还原后恢复
  useEffect(() => {
    const onResize = () => {
      const maxed =
        window.innerWidth >= window.screen.availWidth - 1 &&
        window.innerHeight >= window.screen.availHeight - 1;
      document.documentElement.style.setProperty(
        "--win-radius",
        maxed ? "0px" : (look.winRadius ?? 0) + "px"
      );
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [look.winRadius]);

  // 亮 → 暗 → 亮，简单二态切换（长按/右键可扩展 auto）
  const toggle = () => setMode((m) => (isDark ? "light" : "dark"));

  return { mode, isDark, setMode, toggle, accent, setAccent: setAccentState, look, setLook: setLookState };
}

export { DEFAULT_LOOK };
