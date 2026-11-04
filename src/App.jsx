import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api.js";
import { loadPluginUi, subscribePluginPages, getPluginPages } from "./pluginHost.js";
import { loadNotifySetting, playCompletion } from "./sound.js";
import { useIconSpace, useIconSurface, IconSpaceProvider, LiveIcon, iconText, iconNode } from "./iconSpace.jsx";
import { IconMenu } from "./components/IconRow.jsx";
import { ZONE_LABEL_KEYS } from "./iconLayout.js";
import { InkGlyph, GLYPH_INK } from "./components/InkGlyph.jsx";
import { useTheme, readLook, railItemPx } from "./useTheme.js";
import { useLang, nextLang } from "./i18n.js";
import { langLabel } from "./i18nExt.js";
import TitleBar from "./components/TitleBar.jsx";
import ConfirmHost from "./components/ConfirmHost.jsx";
import SearchPalette, { searchHotkey } from "./components/SearchPalette.jsx";
import ChatPage from "./pages/ChatPage.jsx";
import ToolsPage from "./pages/ToolsPage.jsx";
import MemorySkillsPage from "./pages/MemorySkillsPage.jsx";
import PluginsPage from "./pages/PluginsPage.jsx";
import AuditPage from "./pages/AuditPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import AutomationPage from "./pages/AutomationPage.jsx";
import {
  IconChat,
  IconTool,
  IconMemory,
  IconSkill,
  IconAudit,
  IconPuzzle,
  IconSettings,
  IconSun,
  IconMoon,
  IconInfo,
  IconEdit,
  IconCheck,
  IconChevronLeft,
  IconClock,
  IconSearch,
  IconMore,
} from "./components/Icons.jsx";

// 调色盘预设：null = 恢复默认黑白
// 页面登记表：key -> { label, icon, page }（label 为 i18n key，渲染处 t(label)）
const PAGES = {
  chat: { label: "nav.chat", icon: IconChat, page: ChatPage },
  tools: { label: "nav.tools", icon: IconTool, page: ToolsPage },
  plugins: { label: "nav.plugins", icon: IconPuzzle, page: PluginsPage },
  memory: { label: "nav.memorySkills", icon: IconMemory, page: MemorySkillsPage },
  automation: { label: "nav.automation", icon: IconClock, page: AutomationPage },
  audit: { label: "nav.system", icon: IconAudit, page: AuditPage },
  // AI 设置 / 外观 / 安全 / 远程 收进设置中心的四个分区，不再各占左栏一个图标
  settings: { label: "nav.settings", icon: IconSettings, page: SettingsPage },
};

// 主功能：对话（AI 助手本体）单独置顶
const PRIMARY = "chat";
// 窄窗阈值：低于这个宽度，会话侧栏自动收起、右侧预览面板自动关闭（ChatPage 用同一口径）
const NARROW_PX = 900;
// 次级功能：分组列在下方（系统状态走页眉 ⓘ 入口，不占左栏：页眉仪表盘已经露着版本/会话/tok/内存）
const SECONDARY = ["tools", "plugins", "memory", "automation", "settings"];
// 需要吃满整窗高度的页：设置中心、插件页、自动化/工具/记忆与技能都自带左右分栏，
// 系统状态页的审计表自带内部滚动，都不该再套一层内边距或让整页跟着日志一起滚
const FULL_HEIGHT = new Set(["settings", "audit", "plugins", "tools", "automation", "memory"]);
const isPluginPage = (k) => k.includes(":");
// 全站图标位共用一份布局和一张注册表（见 iconSpace.jsx）：
// 左栏导航 / 页眉工具簇 / 对话页两排的图标可以互相拖，id 带表面前缀防同名顶掉
const RAIL_PREFIX = "rail:";

// 体积/速度友好格式化：B / KB / MB / GB

export default function App() {
  return (
    <IconSpaceProvider>
      <AppShell />
    </IconSpaceProvider>
  );
}

function AppShell() {
  const [tab, setTab] = useState("chat");
  // 外部请求直达设置中心的某个分区（ai / theme / security / remote）。
  // 带自增序号：同一张卡被再次命中时引用也会变，设置页才能重新落位
  const [settingsFocus, setSettingsFocus] = useState({ v: "", n: 0 });
  const [stats, setStats] = useState(null);
  const { isDark, toggle, look, setLook } = useTheme();
  // 外观页改的 look 不会自动流到本组件（useTheme 是各自持有的副本）：订阅写盘事件取最新值。
  // 值没变就返回原对象引用，避免「刷新 → 写盘 → 再广播」自激循环。
  useEffect(() => {
    const on = () =>
      setLook((prev) => {
        const next = readLook();
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    window.addEventListener("bit-look", on);
    return () => window.removeEventListener("bit-look", on);
  }, [setLook]);
  const { t, lang, toggleLang } = useLang();
  // 插件页面登记表（pluginHost 维护，useSyncExternalStore 订阅变更）
  const pluginPages = useSyncExternalStore(subscribePluginPages, getPluginPages);
  // 导航登记表 = 内置页 + 插件页（插件 label 为原文，t() 缺 key 时回退原文展示）
  const pages = { ...PAGES };
  for (const [k, v] of Object.entries(pluginPages)) {
    pages[k] = {
      label: v.label,
      icon: typeof v.icon === "function" ? v.icon : IconSkill,
      page: v.component,
    };
  }
  // 插件页自动占左栏：清单里声明了 paths 的用自己的字形，没配的才回退内置图标。
  // 页面本身仍可从插件页 / 设置中心的入口打开，左栏这颗只是把独立页面当成正经导航项。
  const secondaryKeys = [...SECONDARY, ...Object.keys(pluginPages)];
  // 左栏次级导航的自定义顺序（上下拖拽改序；导航项增减后自动补位，见 iconLayout.js）
  // 跨排拖动也走同一份布局：这里的 id 带 rail: 前缀，和页眉 / 对话页的图标同桌
  const railNav = useIconSpace();
  // 插件重载后当前页可能已消失：回落到对话页（否则主区空白）
  useEffect(() => {
    if (!pages[tab]) setTab(PRIMARY);
  }, [pluginPages, tab]);
  // 启动时加载插件 UI（css 注入 + js 执行）；失败不影响应用本体
  useEffect(() => {
    loadPluginUi().catch((e) => console.warn("[插件] UI 加载失败:", e));
  }, []);
  // 插件页面容器请求跳转（如"去插件页启动服务器"）：与 bit-new-session 同一跨组件事件套路
  // 依赖 pluginPages：插件页是运行期登记的，监听器里要读到最新登记表（唤醒页面的能力走这里）
  useEffect(() => {
    const on = (e) => {
      const p = e?.detail?.page;
      // 本地服务已并入插件页：旧深链（含插件 Bit.openPage("workwith")）落到服务分段
      if (p === "workwith" || p === "plugins") {
        setTab("plugins");
        window.dispatchEvent(
          new CustomEvent("bit-plugins-tab", {
            detail: { tab: p === "workwith" ? "services" : "packages", plugin: e?.detail?.plugin || "" },
          })
        );
      } else if (p === "memory" || p === "skills") {
        // 记忆与技能二合一：旧的两条深链都落到同一页，并切到对应分段
        setTab("memory");
        window.dispatchEvent(new CustomEvent("bit-memsec", { detail: { sec: p } }));
      } else if (p && (PAGES[p] || pluginPages[p])) {
        setTab(p);
      }
      if (e?.detail?.section) setSettingsFocus((prev) => ({ v: e.detail.section, n: prev.n + 1 }));
    };
    window.addEventListener("bit-open-page", on);
    return () => window.removeEventListener("bit-open-page", on);
  }, [pluginPages]);
  useEffect(() => {
    // 前端挂载信号：供 CI 冒烟检测「渲染期异常导致黑屏」（v0.5.14 elevErr 事故的回归闸门）。
    // 树挂载成功才会执行本 effect；任何页面渲染崩溃都会让它缺席，Windows 冒烟据此判失败
    invoke("ui_mounted").catch(() => {});
  }, []);


  // 远程服务端口被占用自动切换：事件实时推送；启动时事件可能早于 JS 监听丢失，
  // 故挂载时再查一次 get_remote_status 兜底（switched_from 有值即展示提示条）
  const [portSwitched, setPortSwitched] = useState(null); // { from, to }
  useEffect(() => {
    invoke("get_remote_status")
      .then((s) => {
        if (s?.switched_from) setPortSwitched({ from: s.switched_from, to: s.addr });
      })
      .catch(() => {});
    const un = listen("remote-port-switched", (e) => {
      const p = e.payload || {};
      if (p.from && p.to) setPortSwitched({ from: p.from, to: p.addr || `:${p.to}` });
    });
    return () => un.then((f) => f()).catch(() => {});
  }, []);

  // 任务完成提示音：core 发 notify-done（成功与失败都发）时按档位出声；
  // 用户在设置里换档时 core 发 notify-settings，这里重读一次让新档位当场生效。
  useEffect(() => {
    loadNotifySetting();
    const un = listen("notify-done", (e) => playCompletion(e?.payload?.ok !== false));
    const un2 = listen("notify-settings", () => loadNotifySetting());
    return () => {
      un.then((f) => f()).catch(() => {});
      un2.then((f) => f()).catch(() => {});
    };
  }, []);

  // 全局捕获右键：屏蔽 WebView 默认菜单；输入框保留原生气泡（复制/粘贴仍可用）
  useEffect(() => {
    const onCtx = (e) => {
      const el = e.target;
      const editable =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el?.isContentEditable;
      if (!editable) e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx, true);
    return () => window.removeEventListener("contextmenu", onCtx, true);
  }, []);

  // 隐藏彩蛋菜单：键入 ↑↓↑↓←→←→BABA（或经典魂斗罗序列 ↑↑↓↓←→←→BA）打开 yxpil.com
  useEffect(() => {
    const seqUser = [
      "ArrowUp", "ArrowDown", "ArrowUp", "ArrowDown",
      "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a", "b", "a",
    ];
    const seqKonami = [
      "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
      "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a",
    ];
    const buf = [];
    const matches = (seq) =>
      seq.length <= buf.length && buf.slice(-seq.length).every((k, i) => k === seq[i]);
    const onKey = (e) => {
      // Cmd+Q / Ctrl+Q：走正常退出链路（notify guardian + silent update）
      // macOS Tauri RunEvent::ExitRequested 不触发 Cmd+Q（issue #9198），
      // 必须前端拦截手动调 quit_app，否则 guardian 以为主进程意外死亡会拉起来
      if ((e.metaKey || e.ctrlKey) && (e.key === "q" || e.key === "Q")) {
        e.preventDefault();
        api.quitApp();
        return;
      }
      buf.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
      if (buf.length > seqUser.length) buf.shift();
      if (matches(seqUser) || matches(seqKonami)) {
        buf.length = 0;
        invoke("open_external", { url: "https://yxpil.com" }).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const refresh = () => api.overview().then(setStats).catch(() => {});

  // 会话侧栏折叠状态（提升到这里：折叠按钮需要随状态切换图标方向）
  const [chatSidebar, setChatSidebar] = useState(() => localStorage.getItem("bit.chatSidebar") !== "0");
  // 窄窗自动收起会话侧栏：窗口拖到阈值以下时把宽度让给正文，用户存下的偏好不覆盖，
  // 拖宽回来按原偏好恢复。窄窗里手动点折叠 = 临时展开（不写 localStorage），
  // 进出窄窗都会清掉这份临时态，避免把"临时展开"记成用户的长期选择。
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_PX);
  const [narrowExpand, setNarrowExpand] = useState(false);
  const narrowRef = useRef(narrow);
  useEffect(() => {
    const onResize = () => {
      const n = window.innerWidth < NARROW_PX;
      if (n === narrowRef.current) return;
      narrowRef.current = n;
      setNarrow(n);
      setNarrowExpand(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const chatSidebarShown = narrow ? narrowExpand : chatSidebar;
  const toggleChatSidebar = () => {
    if (narrow) {
      setNarrowExpand((v) => !v);
      return;
    }
    setChatSidebar((v) => {
      localStorage.setItem("bit.chatSidebar", v ? "0" : "1");
      return !v;
    });
  };
  useEffect(() => {
    refresh();
  }, [tab]);

  // ── 左栏自动折叠：次级项（内置页）多到放不下时，多余的收进底部「⋯」──
  // 高度从 DOM 量而不是拍脑袋写死：字号、缩放、对话页那两个临时按钮都会改变可用空间
  const railListRef = useRef(null);
  const dotsRef = useRef(null);
  const [railBox, setRailBox] = useState({ avail: 0, item: 38 });
  const railBoxRef = useRef({ avail: 0, item: 38 }); // 真实测量值：尺寸没变就别 setState
  const [railPop, setRailPop] = useState(null); // { left, bottom }：「⋯」浮层位置，null=收起
  const railOrder = railNav.order("rail");
  const railOrderKey = railOrder.join("|");
  const measureRail = () => {
    const box = railListRef.current;
    if (!box) return;
    const first = box.firstElementChild;
    const item = (first ? first.getBoundingClientRect().height : 36) + 2; // + gap-0.5
    const avail = box.clientHeight;
    // 窗口缩放时布局会连着提交好几轮，尺寸没变还调 setState 会被 React 当成嵌套更新刷屏
    // （超过 50 次直接 #185 整页卸载），所以先拿 ref 比一次，变了才写状态
    const prev = railBoxRef.current;
    if (prev.avail === avail && Math.abs(prev.item - item) < 0.5) return;
    railBoxRef.current = { avail, item };
    setRailBox({ avail, item });
  };
  useLayoutEffect(measureRail);
  useEffect(() => {
    const box = railListRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      measureRail();
      setRailPop(null); // 浮层锚点会随重排失效，直接收起
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!railPop) return;
    const onKey = (e) => {
      if (e.key === "Escape") setRailPop(null);
    };
    // 浮层里的图标拖到别处后源节点会随列表重排先被摘掉，dragend 落不到它身上；
    // 在 window 上补一次，拖完落在哪都把浮层收掉。
    const close = () => setRailPop(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("drop", close);
    window.addEventListener("dragend", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("drop", close);
      window.removeEventListener("dragend", close);
    };
  }, [railPop]);

  // ── 粘液导航指示：唯一的实心圆片悬浮在侧栏里，切换导航时从旧位置"流"到新位置 ──
  // 位置用 CSS 变量注入（--y0 旧位 / --y 新位），动画在 styles.css 的 nav-slime
  const asideRef = useRef(null);
  const navRefs = useRef({}); // 各导航按钮 DOM，用于测量位置
  const blobRef = useRef(null);
  const blobPrevY = useRef(null);
  const syncBlob = (animate) => {
    const el = blobRef.current;
    const aside = asideRef.current;
    if (!el || !aside) return;
    const item = navRefs.current[tab];
    // 导航项被拖到页眉 / 对话页去了：圆片没有落点，淡出，别在侧栏里凭空停一格
    if (!item || !aside.contains(item)) {
      // 页眉入口的页（系统状态）左栏没有按钮：圆片淡出，别停在上一项上假装选中
      el.style.opacity = "0";
      blobPrevY.current = null;
      return;
    }
    el.style.opacity = "";
    const y = item.getBoundingClientRect().top - aside.getBoundingClientRect().top;
    const y0 = blobPrevY.current;
    blobPrevY.current = y;
    el.style.setProperty("--y0", `${y0 ?? y}px`);
    el.style.setProperty("--y", `${y}px`);
    if (animate && y0 != null && Math.abs(y0 - y) > 0.5) {
      el.classList.remove("slime");
      void el.offsetWidth; // 强制 reflow 重启动画
      el.classList.add("slime");
    }
  };
  useLayoutEffect(() => {
    syncBlob(true); // tab / 侧栏按钮增减 / 导航顺序都会改变导航项位置，重播流动
  }, [tab, chatSidebarShown, pluginPages, railOrderKey]);
  useLayoutEffect(() => {
    syncBlob(false); // 折叠/展开让整列重排：静默归位，别播一段乱飞的动画
  }, [railBox]);
  useEffect(() => {
    const onResize = () => syncBlob(false); // 窗口缩放：静默校正，不播动画
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 图标导航项：圆形小圆片（悬停显示名称），把宽度留给内容区
  // 名称提示是外观开关（look.navLabelOn）：关掉后整条图标栏不再弹 tooltip
  const railTitle = (label) => (look.navLabelOn === false ? undefined : label);
  // 圆片边长由外观页滑杆统一给（--rail-item 同源）。字形尺寸不跟圆片走：
  // 页眉 / 左栏 / 对话页两排的图标墨迹统一在 GLYPH_INK（13.5px），滑杆只改圆片和栏宽。
  const navPx = railItemPx(look);
  const iconPx = Math.max(12, Math.round(navPx * 0.56));
  const miniPx = Math.max(11, Math.round(navPx * 0.5));
  const inkPx = GLYPH_INK;
  const railBtnStyle = { width: navPx, height: navPx };
  // 选中态的实心圆片由共享的 nav-blob 提供（点击时从旧位置流过来），按钮本身只负责图标颜色
  const NavItem = ({ k }) => {
    const { label, icon: Icon } = pages[k];
    const active = tab === k;
    return (
      <button
        ref={(el) => {
          navRefs.current[k] = el;
        }}
        onClick={() => setTab(k)}
        title={railTitle(t(label))}
        style={railBtnStyle}
        className={`relative mx-auto flex items-center justify-center rounded-full transition-all duration-200 hover:scale-105 active:scale-95 ${
          active
            ? "text-[var(--accent-fg)]"
            : "text-neutral-500 hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-white"
        }`}
      >
        <InkGlyph icon={Icon} size={iconPx} ink={inkPx} />
      </button>
    );
  };

  // 新对话小加号：位于图标栏顶部对话按钮下方，点击切到对话页并新建
  const NewChatBtn = () => (
    <button
      onClick={() => {
        setTab(PRIMARY);
        window.dispatchEvent(new CustomEvent("bit-new-session"));
      }}
      title={railTitle(t("chat.newChat"))}
      style={railBtnStyle}
      className="mx-auto flex items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-white"
    >
      {/* 新对话用铅笔（写一条新的），不用加号：输入框的「添加附件」也是加号，
          两排同时出现就成了跨区重复字形 */}
      <InkGlyph icon={IconEdit} size={iconPx} ink={inkPx} />
    </button>
  );

  // 图标栏小按钮：向 ChatPage 派发跨组件事件（会话侧栏收起 / 会话多选），仅对话页显示
  const RailMiniBtn = ({ onClick, title, children }) => (
    <button
      onClick={onClick}
      title={railTitle(title)}
      style={railBtnStyle}
      className="mx-auto flex items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-white"
    >
      {children}
    </button>
  );

  // 左栏图标登记：带 rail: 前缀进全站注册表，别的排（页眉 / 对话页）也能画出导航项、也能拖走
  const railIds = secondaryKeys.map((k) => RAIL_PREFIX + k);
  const railNodes = {};
  const railLabels = {};
  for (const k of secondaryKeys) {
    railNodes[RAIL_PREFIX + k] = <NavItem k={k} />;
    railLabels[RAIL_PREFIX + k] = t(pages[k].label);
  }
  useIconSurface("rail", {
    ids: railIds,
    homes: Object.fromEntries(railIds.map((id) => [id, "rail"])),
    nodes: railNodes,
    labels: railLabels,
  });

  // 栏底圆形小按钮（主题 / 语言 / 关于）：与上方导航项同款圆片
  // 折叠口径：放得下就全显示；放不下留一格给「⋯」，其余收进浮层。
  // 当前页始终钉在栏里——不然圆片找不到落点，用户也看不出自己在哪一页。
  // 折叠按「用户拖出来的顺序」从头往下数，所以把图标拖到前面就等于让它永远留在栏里。
  const activeRailId = RAIL_PREFIX + tab;
  const fits = railBox.avail > 0 ? Math.floor(railBox.avail / railBox.item) : railOrder.length;
  const keep = railOrder.length > fits ? Math.max(1, fits - 1) : railOrder.length;
  const railShown = new Set(railOrder.slice(0, keep));
  if (railOrder.length > fits && railOrder.includes(activeRailId)) railShown.add(activeRailId);
  const railVisible = railOrder.filter((id) => railShown.has(id));
  const railHidden = railOrder.filter((id) => !railShown.has(id));

  // 右键左栏图标 = 把它从栏里摘掉（进图标库，不再占位置）；右键栏里空白 = 从库里挑回来。
  // 摘掉的正好是当前页时顺手回对话页，否则圆片会停在一个已经不存在的按钮上。
  const [railMenu, setRailMenu] = useState(null);
  // 名称一律走全站注册表：导航项在「外观关掉悬停名称」时没有 title，登记时补了文本
  const railLabelOf = (id) => iconText(id);
  const railHideMenu = (e, id) => {
    if (!railNav.enabled) return; // 总开关关掉 = 左栏只读
    e.preventDefault();
    e.stopPropagation();
    setRailMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: "hide",
          label: t("icon.hide"),
          hint: railLabelOf(id),
          onSelect: () => {
            railNav.hide(id);
            if (id === activeRailId) setTab(PRIMARY);
          },
        },
      ],
    });
  };
  const railAddMenu = (e) => {
    if (!railNav.enabled) return;
    if (e.target.closest("[data-bit-icon-id]")) return; // 图标自己的右键菜单优先
    e.preventDefault();
    // 从别区挪进来的图标，添加后原处会消失；图标库里只放被右键摘掉的。
    const moves = railNav.elsewhere("rail").filter((id) => iconNode(id));
    const lib = railNav.library().filter((id) => iconNode(id));
    const items = [];
    if (moves.length) {
      items.push({ key: "move-head", label: t("icon.moveTitle"), disabled: true });
      for (const id of moves) {
        const zk = ZONE_LABEL_KEYS[railNav.zoneOf(id)];
        items.push({
          key: "move:" + id,
          label: railLabelOf(id),
          hint: zk ? t(zk) : undefined,
          onSelect: () => railNav.show(id, "rail"),
        });
      }
    }
    if (lib.length) {
      items.push({ key: "lib-head", label: t("icon.addTitle"), disabled: true });
      for (const id of lib) items.push({ key: "lib:" + id, label: railLabelOf(id), onSelect: () => railNav.show(id, "rail") });
    }
    if (!items.length) items.push({ key: "none", label: t("icon.addEmpty"), disabled: true });
    setRailMenu({ x: e.clientX, y: e.clientY, items });
  };

  const toggleRailPop = () => {
    if (railPop) {
      setRailPop(null);
      return;
    }
    const r = dotsRef.current?.getBoundingClientRect();
    const a = asideRef.current?.getBoundingClientRect();
    if (!r || !a) return;
    // 贴「⋯」右侧弹出，底边与「⋯」对齐往上长（入口在栏底，往上才是安全方向）
    setRailPop({ left: Math.round(r.right - a.left + 6), bottom: Math.round(a.bottom - r.bottom) });
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden text-neutral-900 dark:text-neutral-100">
      <TitleBar
        onOpenAutomation={() => setTab("automation")}
        extras={{
          search: (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("bit-open-search"))}
              title={`${t("search.title")} · ${searchHotkey}`}
              className="flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <InkGlyph icon={IconSearch} size={15} ink={inkPx} />
            </button>
          ),
          theme: (
            <button
              type="button"
              onClick={toggle}
              title={t(isDark ? "app.switchLight" : "app.switchDark")}
              className="flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <InkGlyph icon={isDark ? IconSun : IconMoon} size={15} ink={inkPx} />
            </button>
          ),
          lang: (
            <button
              type="button"
              onClick={toggleLang}
              title={`${t("app.langToggle")} · ${langLabel(nextLang())}`}
              className="flex h-6 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              {lang.slice(0, 2).toUpperCase()}
            </button>
          ),
          info: (
            <button
              type="button"
              onClick={() => setTab("audit")}
              title={t("nav.system")}
              className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                tab === "audit"
                  ? "accent-solid text-[var(--accent-fg)]"
                  : "text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              }`}
            >
              <InkGlyph icon={IconInfo} size={15} ink={inkPx} />
            </button>
          ),
        }}
      />
      {/* 全局确认弹窗宿主：confirmDialog() 的统一渲染点（挂在根组件，全站共用） */}
      <ConfirmHost />

      {/* 全局悬浮搜索：Ctrl/Cmd+K 或页眉放大镜唤起，会话进对话页、设置项直接落到那张卡 */}
      <SearchPalette
        onPick={() => setTab(PRIMARY)}
        onOpenSettings={(section) => {
          setTab("settings");
          setSettingsFocus((prev) => ({ v: section, n: prev.n + 1 }));
        }}
      />

      {/* 端口切换提示条：远程端口被占用已自动切换（可关闭，纯色不透明） */}
      {portSwitched && (
        <div className="flex shrink-0 items-center justify-center gap-3 bg-neutral-900 px-4 py-1.5 text-xs text-white">
          <span>
            {t("remote.portSwitched")}
            <span className="font-mono font-semibold">{portSwitched.to}</span>
          </span>
          <button
            onClick={() => setPortSwitched(null)}
            title={t("common.close")}
            className="rounded px-1 text-neutral-400 transition-colors hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 图标侧栏：无分隔线，与窗口背景融为一体 */}
        <aside
          ref={asideRef}
          style={{ width: navPx + 12 }}
          className="relative flex shrink-0 flex-col items-center gap-1 px-1.5 py-2"
        >
          {/* 粘液导航指示圆片：选中态的唯一实心圆片，点击导航时流动到新位置 */}
          <div ref={blobRef} aria-hidden="true" className="nav-blob accent-solid rounded-full" />
          {/* 导航：对话主功能置顶（固定不折叠），其余分组；次级项放不下时自动收进「⋯」 */}
          <nav className="flex min-h-0 w-full flex-1 flex-col pt-1">
            <div className="flex shrink-0 flex-col gap-0.5">
              <NavItem k={PRIMARY} />
              <NewChatBtn />
              {tab === PRIMARY && (
                <>
                  {/* 折叠/展开：图标随侧栏状态翻转（180° 旋转过渡），展开时朝左=收起，收起时朝右=展开 */}
                  <RailMiniBtn
                    onClick={toggleChatSidebar}
                    title={chatSidebarShown ? t("chat.collapseSidebar") : t("chat.expandSidebar")}
                  >
                    <InkGlyph
                      icon={IconChevronLeft}
                      size={miniPx}
                      ink={inkPx}
                      className={`transition-transform duration-300 ${chatSidebarShown ? "" : "rotate-180"}`}
                    />
                  </RailMiniBtn>
                  {/* 多选入口只在会话侧栏展开时显示（先展开才能操作会话列表） */}
                  {chatSidebarShown && (
                    <RailMiniBtn
                      onClick={() => window.dispatchEvent(new CustomEvent("bit-toggle-multi"))}
                      title={t("chat.multi")}
                    >
                      <InkGlyph icon={IconCheck} size={miniPx} ink={inkPx} />
                    </RailMiniBtn>
                  )}
                </>
              )}
              <div
                style={{ width: Math.max(16, navPx - 8) }}
                className="mx-auto my-2 h-px bg-neutral-200 dark:bg-neutral-800"
              />
            </div>
            <div
              ref={railListRef}
              className="flex min-h-0 flex-1 flex-col gap-0.5"
              onContextMenu={railAddMenu}
              {...railNav.zoneProps("rail")}
            >
              {railVisible.map((id) => {
                const sp = railNav.slotProps("rail", id);
                // 别区拖来的图标按左栏的圆片尺寸收拢，不然一排里高矮不齐
                const foreign = !railNodes[id];
                return (
                  <div
                    key={id}
                    {...sp}
                    onContextMenu={(e) => railHideMenu(e, id)}
                    style={foreign ? { width: navPx, height: navPx } : undefined}
                    className={
                      foreign
                        ? `${sp.className} items-center [&>*]:h-full [&>*]:w-full [&>button]:h-full [&>button]:w-full [&>div>button]:h-full [&>div>button]:w-full`
                        : sp.className
                    }
                  >
                    <LiveIcon id={id} node={railNodes[id]} />
                  </div>
                );
              })}
              {railHidden.length > 0 && (
                <button
                  ref={dotsRef}
                  type="button"
                  onClick={toggleRailPop}
                  title={railTitle(t("nav.moreHint", { n: railHidden.length }))}
                  aria-label={t("nav.more")}
                  aria-expanded={!!railPop}
                  style={railBtnStyle}
                  className={`mx-auto flex items-center justify-center rounded-full transition-colors ${
                    railPop
                      ? "bg-neutral-900/10 text-neutral-900 dark:bg-white/10 dark:text-white"
                      : "text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-white"
                  }`}
                >
                  <InkGlyph icon={IconMore} size={miniPx} ink={inkPx} />
                </button>
              )}
            </div>
          </nav>
          {/* 「⋯」浮层：挂在 aside 上（列表容器是 overflow-hidden，挂里面会被裁掉） */}
          {railPop && railHidden.length > 0 && (
            <>
              {/* 拖拽时让开点击背板，浮层里的图标也能拖到页眉 / 对话页 */}
              <div className={`fixed inset-0 z-20 ${railNav.draggingId ? "pointer-events-none" : ""}`} onClick={() => setRailPop(null)} />
              <div
                className="card anim-pop absolute z-30 flex flex-col gap-0.5 overflow-y-auto p-1.5"
                style={{ left: railPop.left, bottom: railPop.bottom, maxHeight: railBox.avail + 40 }}
              >
                {railHidden.map((id) => {
                  const k = id.startsWith(RAIL_PREFIX) ? id.slice(RAIL_PREFIX.length) : null;
                  const label = railLabelOf(id);
                  const sp = railNav.slotProps("rail", id, null, true);
                  const rowCls = `flex w-full min-w-[9rem] items-center gap-2 rounded-xl px-2 text-xs text-neutral-600 dark:text-neutral-300 ${
                    railNav.draggingId === id ? "opacity-40" : "cursor-grab active:cursor-grabbing"
                  }`;
                  const rowDrag = (e) => {
                    sp.onDragEnd(e);
                    setRailPop(null);
                  };
                  // 导航项进画面就是原来的行按钮；从别排拖来的图标是自带点击的整颗节点，
                  // 不能再套一层 button（会变成按钮套按钮），改成一行「图标 + 名称」
                  if (!k) {
                    return (
                      <div key={id} {...sp} className={`${rowCls} py-1`} onDragEnd={rowDrag} onContextMenu={(e) => railHideMenu(e, id)}>
                        <LiveIcon id={id} node={railNodes[id]} />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                      </div>
                    );
                  }
                  const { icon: Icon } = pages[k];
                  return (
                    <div key={id} {...sp} className={rowCls} onDragEnd={rowDrag} onContextMenu={(e) => railHideMenu(e, id)}>
                      <button
                        type="button"
                        onClick={() => {
                          setTab(k);
                          setRailPop(null);
                        }}
                        className="flex w-full items-center gap-2 py-1.5 text-left transition-colors hover:text-neutral-900 dark:hover:text-white"
                      >
                        <InkGlyph
                          icon={Icon}
                          size={16}
                          ink={inkPx}
                          className="shrink-0 text-neutral-500 dark:text-neutral-400"
                        />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* 明暗 / 语言 / 关于已上移到页眉右侧：左栏只留导航 */}
          {railMenu && <IconMenu x={railMenu.x} y={railMenu.y} items={railMenu.items} onClose={() => setRailMenu(null)} />}
        </aside>

        {/* 主内容：所有页面常驻挂载（display 切换），保证对话页的
            执行状态 / 等待队列 / 审批监听在切换页面后不丢失 */}
        <main className="min-h-0 flex-1 overflow-hidden">
          {Object.entries(pages).map(([k, { page: Page }]) => (
            <div
              key={k}
              className={`h-full ${
                k === PRIMARY
                  ? "overflow-hidden px-2 pb-3 pt-2"
                  : FULL_HEIGHT.has(k) || isPluginPage(k)
                    ? "overflow-hidden p-2"
                    : "overflow-auto p-6"
              }`}
              style={{ display: tab === k ? "block" : "none" }}
            >
              <Page
                onStats={refresh}
                stats={stats}
                visible={tab === k}
                sidebarOpen={chatSidebarShown}
                focus={k === "settings" ? settingsFocus : undefined}
              />
            </div>
          ))}
        </main>
      </div>

      {/* 关于弹窗：版本信息 + 主动更新（检查 / 下载进度 / 重启更新） */}
    </div>
  );
}
