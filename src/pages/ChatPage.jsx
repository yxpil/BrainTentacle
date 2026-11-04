import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../api.js";
import { useLang, t } from "../i18n.js";
import { applyTtsVolume } from "../ttsVolume.js";
import { mergeView } from "../iconLayout.js";
import { readTplHotkey, parseTplHotkey, matchTplSequence, formatTplHotkey } from "../templateHotkey.js";
import { useIconSpace, useIconSurface, iconNode } from "../iconSpace.jsx";
import IconRow from "../components/IconRow.jsx";
import Popup from "../components/Popup.jsx";
import {
  subscribePluginChatIcons,
  getPluginChatIcons,
  subscribePluginPages,
  getPluginPages,
  subscribePluginSettings,
  getPluginSettingsView,
  subscribePluginTakeovers,
  getPluginTakeoverClaims,
  subscribePluginFileKinds,
  getPluginFileKinds,
  pluginFileKind,
  subscribePluginNames,
  getPluginNames,
} from "../pluginHost.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import {
  IconSend,
  IconTrash,
  IconPlus,
  IconEdit,
  IconRefresh,
  IconBranch,
  IconUndo,
  IconCamera,
  IconChat,
  IconFile,
  IconLink,
  IconX,
  IconStop,
  IconEye,
  IconShield,
  IconQueue,
  IconCopy,
  IconCheck,
  IconTarget,
  IconStar,
  IconStarSolid,
  IconTerminal,
  IconClock,
  IconMic,
  IconSpeaker,
  IconSpeakerOff,
  IconGlobe,
  IconImage,
  IconFolder,
  IconChevronRight,
  IconChevronDown,
  IconDroplet,
  IconPuzzle,
} from "../components/Icons.jsx";
import SearchBox from "../components/SearchBox.jsx";
import WebPane, { normalizeWebUrl } from "../components/WebPane.jsx";
import DocPane from "../components/DocPane.jsx";
import PillSwitch from "../components/PillSwitch.jsx";
import ToolCallCard from "../components/ToolCallCard.jsx";
import PendingToolCard from "../components/PendingToolCard.jsx";
import FileCard from "../components/FileCard.jsx";
import { useFileMenu, fileFromPath } from "../components/FileMenu.jsx";
import { FileChip, fileKind, fileBlockMarker, parseFileBlocks } from "../components/FileRef.jsx";
import Markdown, { Mermaid } from "../components/Markdown.jsx";
import { useShellJobs } from "../hooks/useShellJobs.js";
import { useSubagents, useAutoSpeak } from "../automationStore.js";
import ShellLogModal from "../components/ShellLogModal.jsx";

// 对话彩色标签调色板（十六进制色值）
const TAG_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
  "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#d946ef", "#ec4899", "#78716c",
];
// 右滑最多露出的宽度（px）：再拖就锁住，行跟着手指走但不飞出侧栏
const SWIPE_REVEAL = 56;
// 会话回退窗口：只允许回退最近 10 条消息（与核心 ROLLBACK_WINDOW 保持一致）
const ROLLBACK_WINDOW = 10;
// 右侧预览面板的窄窗阈值：面板按窗口 45% 宽算，窗口再窄正文就只剩一条缝，
// 跨过这条线时自动收起（用户手动再开仍然允许）
const PANE_NARROW_PX = 1024;

// 插件会话 id 形如 plugin:<插件id>[:子会话]：插件聊天与唤回注入的回复都落在这里。
// 这些会话必须进左侧列表——否则通知里有回复、列表里却找不到对话本体。
const isPluginSession = (id) => String(id || "").startsWith("plugin:");
const pluginIdOf = (id) => String(id || "").slice("plugin:".length).split(":")[0];

// 待办计划时间展示：scheduled_at（YYYY-MM-DD HH:MM 本地时间）取 HH:MM 部分
const todoHM = (s) => String(s).match(/\d{1,2}:\d{2}/)?.[0] || String(s);
// 到点判定：本地时间已过 scheduled_at 且未完成 → 标红（完成项不再标红）
const isTodoOverdue = (td) => {
  if (!td.scheduled_at || td.status === "completed") return false;
  const at = new Date(String(td.scheduled_at).replace(" ", "T"));
  return !Number.isNaN(at.getTime()) && Date.now() >= at.getTime();
};

// ── 语音输入：Float32 PCM → 16kHz 单声道 PCM16 WAV（纯 JS 编码，不引第三方库）──
const VOICE_RATE = 16000;

// 线性插值重采样：AudioContext 不支持指定采样率时，用默认采样率采集后在此转 16kHz
const resampleLinear = (data, from, to) => {
  if (from === to || !data.length) return data;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, data.length - 1);
    const f = pos - i0;
    out[i] = data[i0] * (1 - f) + data[i1] * f;
  }
  return out;
};

// 手写 WAV 头（RIFF/WAVE/fmt /data）+ 16k 单声道 PCM16 数据
const encodeWav16k = (samples) => {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt 块长度
  v.setUint16(20, 1, true); // PCM 格式
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, VOICE_RATE, true); // 采样率
  v.setUint32(28, VOICE_RATE * 2, true); // 字节率
  v.setUint16(32, 2, true); // 块对齐
  v.setUint16(34, 16, true); // 位深
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
};

// 字节 → base64：分块转，避免一次性 apply 超出调用栈参数上限
const bytesToBase64 = (bytes) => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

// 宿主系统判定（Electron UA 一定带平台串）：麦克风失败的成因和补救路径按系统不同，
// 只报"检查系统权限"在三端都只是猜测
const hostOs = () => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/Windows NT/i.test(ua)) return "win";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "linux";
};

// 麦克风错误 → 该平台可执行的下一步（DOMException.name 是唯一可靠的分类依据）
const micErrText = (err, tt) => {
  const name = String(err?.name || "");
  const os = hostOs();
  if (/NotAllowedError|PermissionDenied|SecurityError/i.test(name)) {
    return tt(os === "mac" ? "chat.micDeniedMac" : os === "win" ? "chat.micDeniedWin" : "chat.micDeniedLinux");
  }
  if (/NotFoundError|DevicesNotFoundError/i.test(name)) return tt("chat.micNotFound");
  if (/NotReadableError|TrackStartError|AbortError/i.test(name)) {
    return tt(os === "linux" ? "chat.micBusyLinux" : os === "win" ? "chat.micBusyWin" : "chat.micBusyMac");
  }
  if (/OverconstrainedError/i.test(name)) return tt("chat.micOverconstrained");
  const raw = err?.message || name || String(err);
  return `${tt("chat.voiceMicError")}：${raw}`;
};

// ---------- 消息朗读（TTS 进聊天）----------
// 模块级音频句柄：手动朗读与自动朗读共用，任何新朗读先停掉上一次
let ttsAudio = null;
let ttsCancel = null; // 被新朗读打断时通知旧调用方复位（否则旧按钮会卡在播放态）
// 朗读状态广播：免手对话 / 朗读打断（barge-in）需要知道当前是否在出声
let ttsPlaying = false;
const ttsStateSubs = new Set();
function setTtsPlaying(v) {
  if (ttsPlaying === v) return;
  ttsPlaying = v;
  for (const fn of ttsStateSubs) {
    try { fn(v); } catch { /* 订阅者异常不影响其他 */ }
  }
}

/// 朗读文本：走当前 TTS 引擎合成（后端 tts_speak 按已配置引擎出声）并播放
async function speakText(text) {
  stopTts();
  if (!text || !text.trim()) return;
  const r = await api.ttsSpeak(text);
  const audio = new Audio(`data:audio/${r.format || "wav"};base64,${r.audioBase64}`);
  applyTtsVolume(audio);
  ttsAudio = audio;
  return new Promise((resolve, reject) => {
    ttsCancel = () => {
      if (ttsAudio === audio) ttsAudio = null;
      setTtsPlaying(false);
      resolve();
    };
    const finish = () => {
      if (ttsAudio === audio) ttsAudio = null;
      setTtsPlaying(false);
      resolve();
    };
    audio.onended = finish;
    audio.onerror = () => {
      if (ttsAudio === audio) ttsAudio = null;
      setTtsPlaying(false);
      reject(new Error("audio play error"));
    };
    audio.play().then(() => setTtsPlaying(true)).catch((e) => {
      if (ttsAudio === audio) ttsAudio = null;
      setTtsPlaying(false);
      reject(e);
    });
  });
}

/// 停止当前朗读
function stopTts() {
  setTtsPlaying(false);
  if (ttsCancel) {
    const c = ttsCancel;
    ttsCancel = null;
    c();
  }
  if (ttsAudio) {
    ttsAudio.pause();
    ttsAudio = null;
  }
}

// ===== 周边图标布局（可拖拽换位 / 排序）=====
// 拖拽机制全站共用一份布局（iconSpace.jsx：左栏导航、页眉工具簇也在同一张表上），
// 对话页这一组有两个落位区：输入框左下角工具栏 chatToolbar、会话列表底部 chatFooter。
// id 带 chat: 前缀——settings 这种名字在左栏也有一份，不带前缀会互相顶掉。
// 这里只声明「有哪些图标、各自默认在哪一排」，顺序与落位由用户拖出来、存 localStorage。
const CHAT_PREFIX = "chat:";
// 子代理归页眉的状态簇（title:subs）、设置归左栏导航（rail:settings），
// 这里不再各留一颗同名同字形的按钮，否则屏上和图标库里都会出现两份。
// 话筒不在这张表里：它和发送按钮是一组，固定在右下角（见输入区的右侧按钮簇）。
const TOOL_IDS = ["preview", "attach", "plan", "template", "web", "bgjobs"];
// 默认全摆在输入框那一排：会话列表底下那排仍然能接住拖拽，只是出厂态不再分两排。
// 弹层方向不再看宿主在哪一排——Popup 自己按视口翻上翻下（见 components/Popup.jsx）。
const TOOL_HOME_ZONE = "chatToolbar";

// 工具栏 / 底栏 / 发送旁的话筒共用同一颗圆钮，但字形在 24 格 viewBox 里占位差很多：
// 加号只吃 14 格、眼睛和话筒吃满 20 格，挨在一起就一大一小。这里按实测墨迹给每个图标
// 一个光学系数，把最长边统一归到 13.5px；描边按反比补偿，线条粗细才不会跟邻居脱节。
const ICON_INK = { attach: 14, plan: 18, voice: 20, template: 16.8, preview: 20, web: 18, bgjobs: 18 };
const toolIcon = (id) => {
  const k = 18 / ICON_INK[id];
  return { size: Math.round(18 * k * 2) / 2, strokeWidth: +(1.8 / k).toFixed(2) };
};
// 圆钮写死 34px：原来靠 p-2 撑，图标一改尺寸按钮就跟着胖一圈瘦一圈，一排又不齐了
const TOOL_BTN = "grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full";
const TOOL_PX = 34;

// 插件图标的墨迹归一：第三方给的 path 数据在 24 格里占多大完全没人管，照原样画必然有大有小。
// 挂载后量一次 getBBox（返回的是路径自身用户坐标，与 viewBox 无关，所以一遍就够），
// 把 viewBox 收成「墨迹最长边 = 18 格」的窗口并居中，描边按同比例换算——
// 于是任何插件图标都和内置图标一般大、一样粗。量不到（空路径/异常）就按原样画。
function PluginChatGlyph({ paths }) {
  const ref = useRef(null);
  const [fit, setFit] = useState(null);
  const key = paths.join("|");
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    try {
      const shapes = [...svg.querySelectorAll("path")];
      if (!shapes.length) return;
      const u = shapes.reduce(
        (a, s) => {
          const b = s.getBBox();
          return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x2: Math.max(a.x2, b.x + b.width), y2: Math.max(a.y2, b.y + b.height) };
        },
        { x: 1e9, y: 1e9, x2: -1e9, y2: -1e9 },
      );
      const w = u.x2 - u.x;
      const h = u.y2 - u.y;
      const m = Math.max(w, h);
      // 只挡量不到/退化成点的情况：窗口取墨迹最长边的 4/3，缩放比例完全由它决定，
      // 再套一层上下限反而会让极端大小的图标归一不到 13.5px，和邻居差出一截
      if (!(m >= 0.01)) return;
      const size = (m * 4) / 3;
      setFit({
        vb: `${(u.x + w / 2 - size / 2).toFixed(2)} ${(u.y + h / 2 - size / 2).toFixed(2)} ${size.toFixed(2)} ${size.toFixed(2)}`,
        sw: +(size * 0.075).toFixed(3),
      });
    } catch {
      /* 浏览器量不到就不归一，宁可大小不齐也别不画 */
    }
  }, [key]);
  return (
    <svg
      ref={ref}
      width={18}
      height={18}
      viewBox={fit ? fit.vb : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={fit ? fit.sw : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

// 插件图标的落点解析：page_key 既可能指本插件的独立页面，也可能指它注入设置中心的条目；
// 留空则在该插件只有一个入口时自动选中。都找不到就返回 null（按钮置灰，标题说明原因）。
function resolvePluginIconTarget(ic, framePages, settingsCards) {
  const pid = ic.plugin_id || "";
  const raw = (ic.page_key || "").trim();
  const cands = raw ? [raw.includes(":") ? raw : `${pid}:${raw}`] : [];
  if (!cands.length) {
    cands.push(...Object.keys(framePages).filter((k) => k.startsWith(`${pid}:`)));
    cands.push(...settingsCards.filter((c) => c.plugin_id === pid).map((c) => c.key));
  }
  for (const k of cands) {
    if (framePages[k]) return { page: k };
  }
  for (const k of cands) {
    if (settingsCards.some((c) => c.key === k)) return { page: "settings", section: k };
  }
  return null;
}

// AI 对话：多会话分组 + 工具调用可视化
export default function ChatPage({ onStats, visible, sidebarOpen }) {
  const { t, lang } = useLang();
  const [sessions, setSessions] = useState([]);
  const [sessQuery, setSessQuery] = useState(""); // 会话列表过滤（标题 + 正文）
  const [sessHits, setSessHits] = useState(null); // core 侧正文命中：{ id: { snippet, role } }
  // 正文搜索走 core（消息在内存 SessionStore 里，前端逐会话拉全量历史不划算）。
  // 输入停顿 250ms 再发，避免每敲一个字扫一遍全部会话
  useEffect(() => {
    const term = sessQuery.trim().toLowerCase();
    if (!term) {
      setSessHits(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchSessions(term)
        .then((r) => setSessHits((r && r.hits) || {}))
        .catch(() => setSessHits(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [sessQuery]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [renaming, setRenaming] = useState(null); // {id, title}
  // 工具栏 / 侧栏底部：后台任务 popover 的展开态
  const [bgJobsOpen, setBgJobsOpen] = useState(false);
  // 周边图标布局：四条区共用全站那一张表，拖拽实时改序、落盘 localStorage
  // 插件登记的图标（chat_icons + chaticon 权限）和内置图标共用同一套布局：
  // 它的 id 就是 bundle 里的 key（"<插件id>:<图标id>"），和内置图标一样默认落输入框那一排，
  // 拖拽 / 落盘 / 折叠并入 / 装卸自愈全部复用，插件不需要知道自己不是内置的。
  const pluginIcons = useSyncExternalStore(subscribePluginChatIcons, getPluginChatIcons);
  const pluginPagesReg = useSyncExternalStore(subscribePluginPages, getPluginPages);
  const pluginSettings = useSyncExternalStore(subscribePluginSettings, getPluginSettingsView);
  // 插件接管：生效中的槽位从界面摘掉对应内置按钮，插件用自己的 chat_icons / pages 顶上。
  // 冲突声明（effective=false）不参与，后端已按字典序选出唯一赢家。
  const takeoverClaims = useSyncExternalStore(subscribePluginTakeovers, getPluginTakeoverClaims);
  // 插件登记的文件类型：附件卡图标与预览分派都读这份快照，登记变了这一页重渲染
  useSyncExternalStore(subscribePluginFileKinds, getPluginFileKinds);
  // 插件显示名表：左侧列表里「插件会话」那行标的就是它，名表更新时整页跟着重渲染
  const pluginNames = useSyncExternalStore(subscribePluginNames, getPluginNames);
  const takenSlots = useMemo(
    () => new Set((takeoverClaims || []).filter((c) => c.effective !== false).map((c) => c.slot)),
    [takeoverClaims]
  );
  const micTaken = takenSlots.has("chat.voice");
  const visibleToolIds = useMemo(() => TOOL_IDS.filter((id) => !takenSlots.has(`chat.${id}`)), [takenSlots]);
  const toolIds = useMemo(() => [...visibleToolIds, ...pluginIcons.map((ic) => ic.key)], [visibleToolIds, pluginIcons]);
  const space = useIconSpace();
  // 折叠侧栏时没有 footer 这一排：footer 的图标并进工具栏尾部（原兜底规则）
  const tools = useMemo(
    () => (sidebarOpen ? space : mergeView(space, ["chatToolbar", "chatFooter"])),
    [space, sidebarOpen],
  );
  const [shellLogJob, setShellLogJob] = useState(null); // 抽屉里点 job → 打开日志弹窗
  // 后台长命令状态（集中 hook：拉取 + 事件订阅 + 停止）
  const shellJobs = useShellJobs();
  // 会话收藏 / 多选批量删除 / 彩色标签（右滑调出调色板）
  const [multiMode, setMultiMode] = useState(false); // 是否处于多选删除模式
  const [selSet, setSelSet] = useState(() => new Set()); // 多选模式下勾选的会话 id
  const [colorFor, setColorFor] = useState(null); // 正在打彩色标签的会话 id（null=无）
  // 会话分组：组名只存在每条会话的 group 字段里，由会话归并出分组；折叠只是界面状态
  const [groupFor, setGroupFor] = useState(null); // 正在选择分组的会话 id（null=无）
  const [newGroupName, setNewGroupName] = useState(""); // 新建分组输入
  const [groupRenaming, setGroupRenaming] = useState(null); // { name, value }
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try {
      const arr = JSON.parse(localStorage.getItem("bit.sessionGroups.collapsed") || "[]");
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  });
  // 分组颜色：只是本机界面的标记，和折叠态一样存 localStorage（按组名归档，改名时跟着搬）
  const [groupColors, setGroupColors] = useState(() => {
    try {
      const j = JSON.parse(localStorage.getItem("bit.sessionGroups.colors") || "{}");
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch {
      return {};
    }
  });
  const [groupColorFor, setGroupColorFor] = useState(null); // 正在选颜色的分组名（null=无）
  // 右滑过程中的实时位移：{ id, x }。行跟着手指走，露出的底色区就是标签色
  const [swipe, setSwipe] = useState({ id: "", x: 0 });
  const [batchHint, setBatchHint] = useState(""); // 多选/删除的临时反馈文字
  // 折叠状态随时落 localStorage：分组本身由会话上的组名归并，刷新后靠这份存档恢复折叠
  useEffect(() => {
    try {
      localStorage.setItem("bit.sessionGroups.collapsed", JSON.stringify([...collapsedGroups]));
    } catch {
      /* 存储满了也不影响当前界面 */
    }
  }, [collapsedGroups]);
  useEffect(() => {
    try {
      localStorage.setItem("bit.sessionGroups.colors", JSON.stringify(groupColors));
    } catch {
      /* 存储满了也不影响当前界面 */
    }
  }, [groupColors]);
  // 分组消失（改名/解散/最后一条会话被删）后清掉陈旧键，避免同名新建分组继承旧折叠态/颜色
  useEffect(() => {
    if (sessions.length === 0) return; // 首帧列表还没拉回来，别把存档清空
    const names = new Set(sessions.map((s) => (s.group || "").trim()).filter(Boolean));
    setCollapsedGroups((prev) => {
      if (![...prev].some((n) => !names.has(n))) return prev;
      return new Set([...prev].filter((n) => names.has(n)));
    });
    setGroupColors((prev) => {
      if (Object.keys(prev).every((n) => names.has(n))) return prev;
      const next = {};
      for (const name of Object.keys(prev)) if (names.has(name)) next[name] = prev[name];
      return next;
    });
  }, [sessions]);
  // 会话侧栏折叠状态与切换由 App（最左侧功能栏按钮）持有，经 props 下发
  const dragRef = useRef(null); // {x, y, id, armed} 右滑手势起点
  const swipedRef = useRef(null); // 刚完成右滑的会话 id（抑制随后的 click）
  const hintTimer = useRef(null);
  // 多会话并发：busyMap/liveMap 以会话 id 为键，A 会话流式时仍可切到 B 会话继续聊
  const [busyMap, setBusyMap] = useState({}); // { sessionId: true }
  const [liveMap, setLiveMap] = useState({}); // { sessionId: { text, cards } }
  // 缓存命中率统计（会话累计，由后端 usage/chat-usage 事件推送）
  const [usageMap, setUsageMap] = useState({}); // { sessionId: { requests, prompt_tokens, cache_read_tokens, completion_tokens, hit_rate } }
  // 生成速度（tok/s）：流式期间由 delta/think 增量实时估算，回合结束即清空
  const [speedMap, setSpeedMap] = useState({}); // { sessionId: tokensPerSecond }
  const speedRef = useRef({}); // { sessionId: { start, tokens } }
  const bottom = useRef(null);
  const activeRef = useRef(""); // 事件回调里判断用户当前正在看哪个会话
  const sessionsRef = useRef([]); // 跨组件事件里的 selectSession 闭包很旧，用它读最新分组
  sessionsRef.current = sessions;

  // 附件：图片（多模态）/ 文档（Excel/Word/CSV 转文本）/ 网址
  const [images, setImages] = useState([]); // [{ name, dataUrl }]
  const [docs, setDocs] = useState([]); // [{ name, text, brief }]
  const fileMenu = useFileMenu(); // 附件卡右键：预览 / 打开 / 所在位置 / 详情 / 复制路径
  const [attaching, setAttaching] = useState(false);
  const [attachErr, setAttachErr] = useState("");
  // 一次拖入可能坏多个文件：名字攒在一起报，别只留下最后一个
  const failRef = useRef([]);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlText, setUrlText] = useState("");
  const [urlParse, setUrlParse] = useState(true); // true=解析网址抓正文；false=仅作为文本插入
  const imgInput = useRef(null);
  const docInput = useRef(null);
  const inputRef = useRef(null); // 输入框自动增高用
  const [attachMenu, setAttachMenu] = useState(false); // 附件 + 菜单（图片/文档/网址）
  // 星标右键 / 长按 / 快捷键共用：把输入框当前内容存成提示词模板。
  // 用 ref 持动作，全局键盘监听只注册一次也能拿到最新的 input 闭包
  const tplAddRef = useRef(() => {});
  const tplPress = useRef({ timer: 0, x: 0, y: 0, fired: false });
  const tplBusy = useRef(false); // 触屏长按会同时触发 contextmenu：同一时刻只跑一次收藏
  const [tplHotkeySpec, setTplHotkeySpec] = useState(() => readTplHotkey().spec);

  // 右侧预览/编辑面板：tabs 每项 { path, kind, text, base }
  // text=null 表示还没拉到内容；base 是上次落盘的内容，text!==base 即"有未保存修改"
  const [tabs, setTabs] = useState([]);
  const [activePath, setActivePath] = useState("");
  const [paneOpen, setPaneOpen] = useState(false);
  const [paneW, setPaneW] = useState(480); // 面板宽度，左边缘可拖
  // 窗口拖窄跨过阈值时自动收起面板；标签与草稿都保留，点预览按钮或拖宽后还能再开。
  // 只认"跨过阈值"这一下：窄窗里用户手动打开后，后续改尺寸不该又把它关掉。
  const paneNarrowRef = useRef(window.innerWidth < PANE_NARROW_PX);
  useEffect(() => {
    const onResize = () => {
      const n = window.innerWidth < PANE_NARROW_PX;
      if (n && !paneNarrowRef.current) setPaneOpen(false);
      paneNarrowRef.current = n;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [webDraft, setWebDraft] = useState(null); // 地址输入（null=未展开）；回车开网页标签
  const [paneMode, setPaneMode] = useState("view"); // view=渲染预览 / edit=文本编辑
  const [paneMsg, setPaneMsg] = useState(""); // 保存结果/错误提示
  const activeTab = tabs.find((x) => x.path === activePath) || null;

  // 输入框自动增高：随内容增长，超过 160px 后内部滚动
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  // 等待发送队列：会话执行中提交的新消息先排队，任务结束后自动按顺序发送
  const [queues, setQueues] = useState({}); // {sid: [{bubble, composed, imgData}]}
  const [dragIdx, setDragIdx] = useState(null); // 正在拖拽的队列项索引
  const [queuePaused, setQueuePaused] = useState({}); // 中断后暂停自动续发
  const pausedRef = useRef({});
  const queuesRef = useRef({}); // 队列同步 ref：pumpQueue 读取用，避免在 setState updater 里产生副作用
  const runningRef = useRef(new Set()); // runTask 重入保护
  const busyHoldRef = useRef({}); // sid -> 时间戳：核心回绝"该会话还在跑"后，隔几秒才再试续发
  // 工具审批：ask = 每次询问 / auto = 自动审批 / l2pass = 全部先过 L2 模型审核 / allow_all = 完全放行
  const [approvals, setApprovals] = useState([]); // 待审批 [{id, tool, params}]
  // ask_user 提问卡片：AI 主动提问（选项 + 补充输入），用户应答后回流给模型
  const [asks, setAsks] = useState([]); // 待应答 [{id, question, options, allow_multiple}]
  const [askPicks, setAskPicks] = useState({}); // ask_id → 已选选项下标数组
  const [askText, setAskText] = useState({}); // ask_id → 补充文本
  // 工具审批模式已上移到标题栏常驻（TitleBar.jsx 持有并读写 get/set_tool_approval）
  const [planMenu, setPlanMenu] = useState(false); // 计划/待办 popover（无进行中内容时不显示按钮）
  // AI 接收内容预览（system / 消息 / 工具清单）
  const [preview, setPreview] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [contextMeta, setContextMeta] = useState({ est_tokens: 0 });
  // 核心模型上下文缓存刷新计数：接口异步回报后立刻重拉 metrics，
  // 页眉上限不必等用户发下一条消息才从回退值切到接口真实值
  const [ctxMetaTick, setCtxMetaTick] = useState(0);

  // 子代理（宿主调度）：实时表由 automationStore 统一订阅 subagent-lifecycle，
  // 页眉弹层、自动化页和这里的内联卡片读同一份数据
  const subList = useSubagents();

  // 停止单个在跑的子代理（委派面板「停止」按钮；只停该子会话，保留其进度）
  const stopSubagent = async (sid) => {
    try {
      await api.stopSubagent(sid);
    } catch (e) {
      console.warn("stop subagent failed:", e);
    }
  };

  // 全局审批请求监听 + 非流式对话的用量统计监听（审批模式本身已上移到页眉，由 TitleBar 读写）
  useEffect(() => {
    const un = listen("tool-approval", (e) => {
      setApprovals((arr) => [...arr, e.payload]);
    });
    // ask_user 提问请求：追加提问卡片（仅当前会话显示）
    const unAsk = listen("chat-ask", (e) => {
      const p = e.payload || {};
      if (p.session && p.session === activeRef.current && p.id) {
        setAsks((arr) => [...arr, p]);
      }
    });
    // 非流式对话路径通过全局 chat-usage 事件上报缓存命中率
    const unUsage = listen("chat-usage", (e) => {
      const p = e.payload || {};
      if (p.session && p.usage) setUsageMap((m) => ({ ...m, [p.session]: { ...p.usage, type: "usage" } }));
    });
    // 工具返回的图片（自定义工具输出 image 字段）：作为 assistant 图片气泡插入当前对话
    const unImage = listen("chat-image", (e) => {
      const p = e.payload || {};
      if (p.session && p.session === activeRef.current && p.data_url) {
        setMessages((msgs) => [...msgs, { role: "assistant", content: "", image: p.data_url, image_path: p.path || "" }]);
      }
    });
    // 模型生成的视频（体积大不传 data URL）：用落盘路径经 asset 协议加载播放
    const unVideo = listen("chat-video", (e) => {
      const p = e.payload || {};
      if (p.session && p.session === activeRef.current && p.path) {
        setMessages((msgs) => [...msgs, { role: "assistant", content: "", video: p.path }]);
      }
    });
    // draw_diagram 工具的图：独立结构化图卡片（diagram 字段），不走 markdown 围栏/文本流。
    // 服务端同步落历史同款字段——事件气泡与回合结束的历史覆盖内容一致，不会闪没
    const unMermaid = listen("chat-mermaid", (e) => {
      const p = e.payload || {};
      if (p.session && p.session === activeRef.current && p.code) {
        setMessages((msgs) => [...msgs, { role: "assistant", content: "", diagram: { code: p.code, title: p.title, path: p.path } }]);
      }
    });
    // AI 写出可预览文件（html/md/svg）：追加"点击预览"卡片气泡
    const unPreview = listen("file-preview", (e) => {
      const p = e.payload || {};
      if (p.session && p.session === activeRef.current && p.path) {
        setMessages((msgs) => [...msgs, { role: "assistant", content: "", preview: { path: p.path, kind: p.kind } }]);
        // AI 改完文件 → 右侧面板自动打开并定位到该文件。
        // 已开的标签只在"无未保存修改"时置空 text 让 effect 重新拉取；
        // 用户正在编辑的内容不动，否则一次自动保存就把他写的东西冲掉了。
        // 窄窗下不自动弹面板：正文本来就紧，预览卡片仍在对话里，点它再开。
        if (window.innerWidth >= PANE_NARROW_PX) {
          setPaneOpen(true);
          setActivePath(p.path);
          setTabs((prev) => {
            const hit = prev.find((x) => x.path === p.path);
            if (!hit) return [...prev, { path: p.path, kind: p.kind || "text", text: null, base: "" }];
            return hit.text !== hit.base ? prev : prev.map((x) => (x.path === p.path ? { ...x, text: null, base: "" } : x));
          });
        }
      }
    });
    // 写文件后的语法检查警告：AI 刚写的代码文件有语法错误时提醒用户（模型同时收到提醒去修复）
    const unSyntax = listen("syntax-warning", (e) => {
      const p = e.payload || {};
      if (p.session && p.session === activeRef.current && p.path) {
        const name = p.path.replace(/^.*[\\/]/, "");
        setMessages((msgs) => [...msgs, { role: "assistant", content: `⚠️ ${t("chat.syntaxWarning")} ${name}\n\`\`\`\n${(p.error || "").slice(0, 600)}\n\`\`\``, warning: true }]);
      }
    });
    // 核心按提供方接口刷新了模型上下文：重拉 metrics 让页眉上限立即采用接口值
    const unCtx = listen("model-context", () => setCtxMetaTick((n) => n + 1));
    return () => {
      un.then((f) => f());
      unAsk.then((f) => f());
      unUsage.then((f) => f());
      unImage.then((f) => f());
      unVideo.then((f) => f());
      unMermaid.then((f) => f());
      unPreview.then((f) => f());
      unSyntax.then((f) => f());
      unCtx.then((f) => f());
    };
  }, []);

  // 文件后缀 → 预览类型（卡片事件没带 kind 时兜底）
  // doc = 要核心解析才能看的办公文档：界面自己读字节只会得到乱码，必须走 extract_path
  const guessKind = (p) => {
    const e = (String(p).split(/[\\/]/).pop().split(".").pop() || "").toLowerCase();
    // 插件登记并负责解析的类型同样只能走 extract_path：界面按文本读它只会得到乱码
    const fk = pluginFileKind(String(p));
    if (fk?.parses) return "doc";
    if (e === "md" || e === "markdown") return "md";
    if (e === "html" || e === "htm") return "html";
    if (e === "svg") return "svg";
    if (["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp"].includes(e)) return "img";
    // 办公文档 + 明显的二进制（压缩包/可执行/音视频）都交核心解析：
    // 按文本读它们只会得到乱码，走 doc 至少能说清楚「解析不出正文」
    if (
      [
        "pdf", "docx", "pptx", "xlsx", "xls", "xlsm", "ods",
        "zip", "rar", "7z", "gz", "exe", "dll", "msi", "iso", "bin", "class", "jar",
        "mp4", "mov", "avi", "mkv", "mp3", "wav", "flac", "pdb", "dmg",
      ].includes(e)
    )
      return "doc";
    return "text";
  };

  // 打开/聚焦一个预览标签：对话里的文件卡片、AI 写完文件后的卡片都走这里
  const openTab = (file) => {
    const p = typeof file === "string" ? file : file?.path;
    if (!p) return;
    const kind = (typeof file === "object" && file?.kind) || guessKind(p);
    setPaneOpen(true);
    setPaneMsg("");
    setActivePath(p);
    setTabs((prev) =>
      prev.some((x) => x.path === p)
        ? prev
        : [...prev, { path: p, kind, text: null, base: "", meta: null, err: "", view: null }]
    );
  };

  // 附件卡与 AI 发来的文件卡点开的就是这条：本地文件进侧栏，网址交系统浏览器
  const openFileTab = (p) => {
    if (!p) return;
    if (/^https?:/i.test(p)) {
      window.open(p, "_blank", "noopener");
      return;
    }
    openTab(p);
  };

  // 打开网页标签：和文件预览共用同一套标签栏（path 就是网址，kind=web）
  const openWebTab = (raw) => {
    const url = normalizeWebUrl(raw);
    if (!url) return;
    setPaneOpen(true);
    setPaneMsg("");
    setActivePath(url);
    setWebDraft(null);
    setTabs((prev) =>
      prev.some((x) => x.path === url) ? prev : [...prev, { path: url, kind: "web", text: null, base: "", title: "" }]
    );
  };

  // 网页里 window.open / target=_blank → 主进程转成事件，这里开新标签（子页面）
  useEffect(() => {
    const un = listen("web-open-tab", (e) => {
      const url = e.payload?.url;
      if (url) openWebTab(url);
    });
    return () => {
      un.then((f) => f());
    };
    // openWebTab 只改 state，首渲闭包足够用
  }, []);

  // 附件卡 / AI 发来的文件卡点击 → 侧栏开对应类型的标签
  useEffect(() => {
    const onTab = (e) => openFileTab(e.detail?.path);
    window.addEventListener("bit-open-file-tab", onTab);
    return () => window.removeEventListener("bit-open-file-tab", onTab);
    // openFileTab 只改 state，首渲闭包足够用
  }, []);

  const closeTab = (p) => {
    const next = tabs.filter((x) => x.path !== p);
    setTabs(next);
    if (p === activePath) setActivePath(next.length ? next[next.length - 1].path : "");
  };

  const reloadTab = (p) => setTabs((prev) => prev.map((x) => (x.path === p ? { ...x, text: null, base: "", meta: null, err: "" } : x)));

  // 保存回原路径（宿主命令 fs_write_text，见 electron/main.cjs）
  const saveTab = async (p) => {
    const tab = tabs.find((x) => x.path === p);
    if (!tab || tab.text === null) return;
    try {
      await api.fsWriteText(p, tab.text);
      setTabs((prev) => prev.map((x) => (x.path === p ? { ...x, base: x.text } : x)));
      setPaneMsg(t("chat.paneSaved"));
    } catch (err) {
      setPaneMsg(String(err?.message || err));
    }
  };

  // 面板左边缘拖拽调宽
  const startPaneResize = (e) => {
    e.preventDefault();
    const sx = e.clientX;
    const sw = paneW;
    const move = (ev) => setPaneW(Math.min(Math.max(sw - (ev.clientX - sx), 300), Math.max(360, window.innerWidth - 480)));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // 标签内容拉取：经 bit-asset 取文本。md/text 渲染与编辑都要；html/svg 预览走 iframe，
  // 但进编辑态同样需要文本，所以除图片外一律拉。
  // 网页标签的内容在 webview 里，path 是 http 地址，拿去走 bit-asset 只会 400，排除。
  useEffect(() => {
    const tab = tabs.find((x) => x.path === activePath);
    if (!tab || tab.kind === "img" || tab.kind === "web" || tab.text !== null) return;
    let alive = true;
    const patch = (fn) => setTabs((prev) => prev.map((x) => (x.path === tab.path ? fn(x) : x)));
    // 办公文档不能按文本读（读出来是乱码），交核心解析并带规模信息回来
    if (tab.kind === "doc") {
      api
        .extractPath(tab.path)
        .then((r) => alive && patch((x) => ({ ...x, text: r.text ?? "", base: "", meta: { lines: r.lines, chars: r.chars, bytes: r.bytes } })))
        .catch((e) => alive && patch((x) => ({ ...x, text: "", base: "", err: cleanErr(e) })));
      return () => {
        alive = false;
      };
    }
    fetch(convertFileSrc(tab.path))
      .then((r) => r.text())
      .then((txt) => alive && patch((x) => ({ ...x, text: txt, base: txt })))
      .catch(() => alive && patch((x) => ({ ...x, text: "(unreadable)", base: "(unreadable)" })));
    return () => {
      alive = false;
    };
  }, [tabs, activePath]);

  // 截图能力位与剪刀按钮已上移到标题栏（TitleBar.jsx 自己问主进程）

  // 子代理生命周期：实时表归 automationStore 维护，这里只跟着刷新会话列表
  // （子会话会新出现在左侧列表，标题/状态由后端事件驱动）
  useEffect(() => {
    const un = listen("subagent-lifecycle", () => loadSessions());
    return () => un.then((f) => f());
  }, []);

  // 从系统拖文件进窗口：能拿到 File 的一律走真附件链路（图片进图片、文档交核心解析正文），
  // 只有文件夹这类拿不到 File 对象的才退回「往输入框插一条链接」。
  // 原来所有拖入都只插一行 [名字](file:///…)，PDF/PPT/TXT 拖进来长得一模一样，也不像接住了。
  // 绝对路径由 preload 用 webUtils 随 tauri://drag-drop 发来（比 DOM drop 晚一拍，所以取路径要等一小下）。
  const [dragOver, setDragOver] = useState(false);
  const dropPaths = useRef([]);
  const domDropAt = useRef(0);
  useEffect(() => {
    const baseName = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
    const waitPaths = () =>
      new Promise((res) => {
        if (dropPaths.current.length) return res(dropPaths.current);
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (dropPaths.current.length || Date.now() - t0 > 600) {
            clearInterval(iv);
            res(dropPaths.current);
          }
        }, 40);
      });
    const onDomDragOver = (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
        e.preventDefault(); // 不拦就是浏览器自己把文件导航走，整个页面没了
        setDragOver(true);
      }
    };
    const onDomDrop = async (e) => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return; // 文件夹：让下面的路径兜底继续插链接
      e.preventDefault();
      domDropAt.current = Date.now();
      setDragOver(false);
      resetAttachErr(); // 上一批的失败提示别串到这里来
      const known = await waitPaths();
      dropPaths.current = [];
      const pathOf = (name) => (known.find((p) => p.name === name) || {}).path || "";
      setAttaching(true);
      try {
        for (const f of files) {
          if (String(f.type || "").startsWith("image/")) await pushImageFile(f);
          // 宿主事件给的绝对路径优先；拿不到时兜 File 自己带的 path（部分入口只有它）
          else await pushDocFile(f, pathOf(f.name) || String(f.path || ""));
        }
      } finally {
        setAttaching(false);
      }
    };
    const onDropPaths = (e) => {
      const paths = (e.payload && e.payload.paths) || [];
      dropPaths.current = paths.map((p) => ({ path: p, name: baseName(p) }));
      setDragOver(false);
      // DOM 那边已经按 File 处理过了就别再补一遍链接
      if (Date.now() - domDropAt.current < 1500) return;
      const links = paths
        .filter((p) => /[\\/]$/.test(p) || !p.includes(".")) // 只留像文件夹的：没扩展名也没法解析
        .map((path) => {
          const clean = path.replace(/[\\/]+$/, "");
          // 尖括号包裹：路径含空格也不会破坏 markdown 链接
          return `[${baseName(clean)}](<file:///${clean.replace(/\\/g, "/")}>)`;
        });
      if (links.length) setInput((v) => (v ? `${v}\n` : "") + links.join("\n"));
    };
    window.addEventListener("dragover", onDomDragOver);
    window.addEventListener("drop", onDomDrop);
    const uns = [
      listen("tauri://drag-enter", () => setDragOver(true)),
      listen("tauri://drag-over", () => setDragOver(true)),
      listen("tauri://drag-leave", () => setDragOver(false)),
      listen("tauri://drag-drop", onDropPaths),
    ];
    return () => {
      window.removeEventListener("dragover", onDomDragOver);
      window.removeEventListener("drop", onDomDrop);
      uns.forEach((u) => u.then((f) => f()));
    };
  }, []);

  // ── 计划栏：输入框上方展示目标与待办 ──
  // 完成项绿色圆点+绿字，未完成白色圆点；小箭头折叠/展开（localStorage 记忆展开状态）
  const [planGoals, setPlanGoals] = useState([]);
  const [planTodos, setPlanTodos] = useState([]);
  const loadPlans = () => {
    api.listGoals().then((r) => setPlanGoals(r.goals || [])).catch(() => {});
    api.listTodos().then((r) => setPlanTodos(r.todos || [])).catch(() => {});
  };
  useEffect(() => {
    loadPlans();
    const timer = setInterval(loadPlans, 3000); // AI 执行 plan 工具后自动刷新
    const unFocus = listen("tauri://focus", loadPlans);
    return () => {
      clearInterval(timer);
      unFocus.then((f) => f());
    };
  }, []);

  // 待办时钟开关（localStorage bit.todoClock，默认开）：只控制待办面板的计划时间展示。
  // 设置页与对话页同窗口渲染，改后广播自定义事件即时同步；跨窗口（远程 Web 端）靠 storage 事件同步
  const [todoClock, setTodoClock] = useState(() => localStorage.getItem("bit.todoClock") !== "0");
  useEffect(() => {
    const sync = () => setTodoClock(localStorage.getItem("bit.todoClock") !== "0");
    window.addEventListener("bit-todo-clock", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("bit-todo-clock", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // ── 语音输入：麦克风录音 → 本地离线转写（SenseVoice）→ 文字追加到输入框草稿 ──
  // 转写结果绝不自动发送，也不进模型上下文；开关 localStorage bit.voiceInput（默认开）
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem("bit.voiceInput") !== "0");
  const [recording, setRecording] = useState(false); // 正在录音
  const [transcribing, setTranscribing] = useState(false); // 转写中（按钮转圈）
  const [voiceDl, setVoiceDl] = useState(null); // 模型下载进度 {done,total}|null
  const [voicePicker, setVoicePicker] = useState(null); // 识别模型选择弹窗 {variants,currentId,resolve}|null
  // 自动朗读：开关位在页眉，值走 automationStore（localStorage bit.autoSpeak，默认关）
  const [autoSpeak] = useAutoSpeak();
  // 朗读中（ttsPlaying 镜像）：朗读打断（barge-in）与 KWS 保持监听的状态依据
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    const fn = (v) => setSpeaking(v);
    ttsStateSubs.add(fn);
    return () => ttsStateSubs.delete(fn);
  }, []);
  // 免手对话：转写完成自动发送（localStorage bit.freehand，默认关；配合语音唤醒使用）
  const [freehand, setFreehand] = useState(() => localStorage.getItem("bit.freehand") === "1");
  const freehandRef = useRef(freehand);
  freehandRef.current = freehand;
  useEffect(() => {
    const sync = () => setFreehand(localStorage.getItem("bit.freehand") === "1");
    window.addEventListener("bit-freehand", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("bit-freehand", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  // 全局语音听写目标（global-voice 事件写入）：转写完成后粘贴回原前台应用而非进对话
  const pasteTargetRef = useRef(null); // { bundleId, hwnd } | null
  // 提示词模板浮层（输入框工具栏）：懒加载列表，点选插入输入框
  const [tplOpen, setTplOpen] = useState(false);
  const [templates, setTemplates] = useState([]); // [{id,title,text}]
  // 编辑重发：{ text } 编辑最后一条 user 消息；确认后走 regenerate_last
  const [editResend, setEditResend] = useState(null);
  const [voiceHint, setVoiceHint] = useState(null); // 输入区上方临时提示 {msg, kind}
  const voiceHintTimer = useRef(null);
  const streamRef = useRef(null); // 麦克风 MediaStream
  const ctxRef = useRef(null); // AudioContext
  const procRef = useRef(null); // ScriptProcessorNode
  const chunksRef = useRef([]); // 录音分片（Float32，onaudioprocess 里拷贝）
  const rateRef = useRef(VOICE_RATE); // 实际采集采样率（停录时重采样到 16k）

  // 语音提示（自动消失）：错误红色 4s，普通 3s
  const flashVoiceHint = (msg, kind = "ok") => {
    setVoiceHint({ msg, kind });
    clearTimeout(voiceHintTimer.current);
    voiceHintTimer.current = setTimeout(() => setVoiceHint(null), kind === "err" ? 4000 : 3000);
  };

  // 设置页开关广播（bit-voice-input）即时同步；跨窗口（远程 Web 端）靠 storage 事件兜底
  useEffect(() => {
    const sync = () => setVoiceOn(localStorage.getItem("bit.voiceInput") !== "0");
    window.addEventListener("bit-voice-input", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("bit-voice-input", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // 模型下载进度：后端 ctx.emit("voice-progress") 推送
  useEffect(() => {
    const un = listen("voice-progress", (e) => {
      const p = e.payload || {};
      if (typeof p.done === "number" && typeof p.total === "number")
        setVoiceDl({ done: p.done, total: p.total });
    });
    return () => un.then((f) => f());
  }, []);

  // 下载期间轮询 voiceStatus 兜底（事件可能丢）：ready/失败以状态查询为准
  const downloading = !!voiceDl;
  useEffect(() => {
    if (!downloading) return;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await api.voiceStatus();
        if (stopped) return;
        if (s?.progress?.total) setVoiceDl({ done: s.progress.done, total: s.progress.total });
        if (s?.ready) {
          setVoiceDl(null);
          flashVoiceHint(t("chat.voiceReady"), "ok");
        } else if (!s?.downloading) {
          setVoiceDl(null);
          flashVoiceHint(
            s?.error ? `${t("voice.downloadFailed")}：${s.error}` : t("voice.downloadFailed"),
            "err"
          );
        }
      } catch { /* 后端暂不可用：保持当前进度显示 */ }
    };
    const timer = setInterval(tick, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [downloading]);

  // 卸载兜底：释放麦克风与 AudioContext
  useEffect(
    () => () => {
      const stream = streamRef.current;
      const ctx = ctxRef.current;
      streamRef.current = null;
      ctxRef.current = null;
      stream?.getTracks().forEach((tr) => tr.stop());
      if (ctx) ctx.close().catch(() => {});
    },
    []
  );

  // 开始录音：拿麦克风流 + Web Audio 收集 Float32 PCM（优先 16k 采集）
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      let ctx;
      try {
        ctx = new Ctx({ sampleRate: VOICE_RATE });
      } catch {
        ctx = new Ctx(); // 不支持指定采样率：默认采样率采集，停录时线性插值重采样
      }
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      chunksRef.current = [];
      rateRef.current = ctx.sampleRate;
      proc.onaudioprocess = (e) => {
        // inputBuffer 会被复用，必须拷贝后再存
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      // ScriptProcessor 需接到 destination 才会被拉动；中间插零增益，避免麦克风回放到扬声器
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      streamRef.current = stream;
      ctxRef.current = ctx;
      procRef.current = proc;
      setVoiceHint(null);
      setRecording(true);
    } catch (e) {
      flashVoiceHint(micErrText(e, t), "err");
    }
  };

  // 停止录音并转写：Float32 → 重采样 16k → PCM16 WAV → voiceTranscribe → 追加到草稿
  const stopRecording = async () => {
    const stream = streamRef.current;
    const ctx = ctxRef.current;
    const proc = procRef.current;
    streamRef.current = null;
    ctxRef.current = null;
    procRef.current = null;
    try {
      proc?.disconnect();
    } catch { /* 已断开 */ }
    stream?.getTracks().forEach((tr) => tr.stop()); // 无论转写成败都先释放麦克风
    const chunks = chunksRef.current || [];
    chunksRef.current = [];
    setRecording(false);
    // 拼接分片 → 需要时重采样到 16k
    let total = 0;
    for (const c of chunks) total += c.length;
    let pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    if (rateRef.current !== VOICE_RATE) pcm = resampleLinear(pcm, rateRef.current, VOICE_RATE);
    // 采到多长的音频决定了后面是「没声」还是「没转出字」，出问题时这行是唯一线索
    console.debug(
      `[BIT][voice] 录音结束 ${(pcm.length / VOICE_RATE).toFixed(2)}s（${chunks.length} 块，原生 ${rateRef.current}Hz）`
    );
    if (ctx) {
      try {
        await ctx.close();
      } catch { /* 已关闭 */ }
    }
    if (!pcm.length) {
      flashVoiceHint(t("chat.voiceEmptyResult"), "err");
      return;
    }
    setTranscribing(true);
    try {
      const r = await api.voiceTranscribe(bytesToBase64(encodeWav16k(pcm)), "auto");
      const text = String(r?.text || "").trim();
      console.debug(`[BIT][voice] 转写完成 ${text.length} 字符：${text.slice(0, 80)}`);
      if (!text) {
        flashVoiceHint(t("chat.voiceEmptyResult"), "err");
      } else if (pasteTargetRef.current) {
        // 全局语音听写：转写结果粘贴回原前台应用（不进对话）
        const target = pasteTargetRef.current;
        pasteTargetRef.current = null;
        try {
          await api.pasteTextToForeground(text, target.bundleId, target.hwnd);
          flashVoiceHint(t("chat.voicePasted"), "ok");
        } catch (e) {
          const emsg = typeof e === "string" ? e : e?.message || String(e);
          flashVoiceHint(`${t("chat.voicePasteFail")}${emsg ? `：${emsg}` : ""}`, "err");
          // 粘贴失败兜底：结果回对话草稿，不丢内容
          setInput((v) => (v ? v + (/\s$/.test(v) ? "" : " ") + text : text));
          inputRef.current?.focus();
        }
      } else if (freehandRef.current) {
        // 免手对话：转写文本直接发送（会话忙时自动进等待队列）
        sendVoiceMessage(text);
        flashVoiceHint(t("chat.freehandSent"), "ok");
      } else {
        // 只追加到草稿末尾（非空补一个空格），焦点回输入框；绝不自动发送
        setInput((v) => (v ? v + (/\s$/.test(v) ? "" : " ") + text : text));
        inputRef.current?.focus();
      }
    } catch (e) {
      const emsg = typeof e === "string" ? e : e?.message || String(e);
      flashVoiceHint(`${t("chat.voiceFailed")}${emsg ? `：${emsg}` : ""}`, "err");
    } finally {
      setTranscribing(false);
    }
  };

  // ── 语音唤醒：麦克风常驻 → worker /kws/feed，命中唤醒词自动开录 ──
  const wakeRef = useRef({ on: false, http: null, stream: null, ctx: null, proc: null });
  const [wakeOn, setWakeOn] = useState(false);

  // 停止唤醒监听：释放麦克风 + 通知 worker 重置唤醒流（worker 可能已重启，错误忽略）
  const stopWake = async () => {
    const k = wakeRef.current;
    if (!k.on && !k.stream) return;
    wakeRef.current = { on: false, http: null, stream: null, ctx: null, proc: null };
    try {
      k.proc?.disconnect();
    } catch { /* 已断开 */ }
    k.stream?.getTracks().forEach((tr) => tr.stop());
    try {
      await k.ctx?.close();
    } catch { /* 已关闭 */ }
    if (k.http) {
      try {
        await fetch(`http://127.0.0.1:${k.http.port}/kws/stop`, {
          method: "POST",
          headers: { authorization: `Bearer ${k.http.token}` },
        });
      } catch { /* worker 不在跑，忽略 */ }
    }
    setWakeOn(false);
  };

  // 唤醒命中：停监听 → 提示 → 直接开录（录音结束转写完，wakeTick effect 自动恢复监听）。
  // 朗读打断（barge-in）：出声期间命中唤醒词只停声不开新麦（防误触），唤醒监听保持
  const onWakeHit = async () => {
    if (ttsPlaying) {
      stopTts();
      flashVoiceHint(t("chat.bargeIn"));
      return;
    }
    await stopWake();
    flashVoiceHint(t("chat.wakeHit"));
    await startRecording();
  };

  // 开始唤醒监听：16k 采集 → PCM16 块喂 /kws/feed；命中即回调 onWakeHit
  const startWake = async (http) => {
    if (wakeRef.current.on) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      flashVoiceHint(micErrText(e, t), "err");
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try {
      ctx = new Ctx({ sampleRate: VOICE_RATE });
    } catch {
      ctx = new Ctx(); // 不支持 16k：onaudioprocess 里线性插值重采样
    }
    const nativeRate = ctx.sampleRate;
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0; // 零增益防回放
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    proc.onaudioprocess = (e) => {
      const k = wakeRef.current;
      if (!k.on) return;
      let f = e.inputBuffer.getChannelData(0);
      if (nativeRate !== VOICE_RATE) f = resampleLinear(f, nativeRate, VOICE_RATE);
      const i16 = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) {
        const s = Math.max(-1, Math.min(1, f[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      fetch(`http://127.0.0.1:${k.http.port}/kws/feed`, {
        method: "POST",
        headers: { authorization: `Bearer ${k.http.token}`, "content-type": "application/octet-stream" },
        body: i16.buffer,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j?.hit && wakeRef.current.on) void onWakeHit();
        })
        .catch(() => { /* worker 重启间隙，忽略本轮 */ });
    };
    wakeRef.current = { on: true, http, stream, ctx, proc };
    setWakeOn(true);
    try {
      await fetch(`http://127.0.0.1:${http.port}/kws/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${http.token}` },
      });
    } catch { /* start 失败不影响 feed 建流重试 */ }
  };

  // 唤醒状态评估：录音/转写/下载忙时停监听；空闲时按后端 kws 配置起/停。
  // 设置页改开关会 dispatch bit-kws-changed 事件触发这里重新评估。
  const wakeApiRef = useRef({});
  wakeApiRef.current = { startWake, stopWake };
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (recording || transcribing || downloading) {
        await wakeApiRef.current.stopWake();
        return;
      }
      try {
        const st = await api.voiceStatus();
        if (cancelled) return;
        const k = st?.kws;
        if (k?.enabled && k?.ready) {
          if (!st?.worker_http) {
            // worker 未跑（唤醒开启后还没起过）：拉起带 kws 的识别进程再重新评估
            await api.voiceKwsSet(true, k.score).catch(() => {});
            return;
          }
          if (wakeRef.current.on) {
            wakeRef.current.http = st.worker_http; // worker 重启后端口/令牌跟随
          } else {
            await wakeApiRef.current.startWake(st.worker_http);
          }
        } else {
          await wakeApiRef.current.stopWake();
        }
      } catch { /* 后端忙，忽略本轮 */ }
    };
    void tick();
    const onChange = () => { void tick(); };
    window.addEventListener("bit-kws-changed", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("bit-kws-changed", onChange);
    };
  }, [recording, transcribing, downloading]);

  // 麦克风按钮总入口：录音中→停止；模型就绪→开录；
  // 未下载→弹模型选择（多模型选一），确认后下载所选并自动切换
  const toggleVoice = async () => {
    if (recording) return stopRecording();
    if (transcribing || downloading) return; // 转写/下载中不重复触发（下载中只显示进度）
    let st = null;
    try {
      st = await api.voiceStatus();
    } catch { /* 后端暂不可用：按未就绪处理，确认后由 voicePrepare 报错 */ }
    if (st?.ready) return startRecording();
    if (st?.downloading) {
      setVoiceDl(
        st.progress?.total ? { done: st.progress.done, total: st.progress.total } : { done: 0, total: 0 }
      );
      return;
    }
    // 未就绪：弹「识别模型选择」，列出全部变体（体积/语言/已就绪标记），默认选当前 variant
    const variants = st?.variants || [];
    const cur = st?.variant || "sense-voice";
    let picked = null;
    if (variants.length) {
      picked = await selectVoiceModel(variants, cur);
      if (!picked) return;
      if (picked !== cur) {
        try { await api.voiceSelect(picked); } catch { /* 选择失败不阻断下载，prepare 仍按当前变体 */ }
      }
    }
    const ok = await confirmDialog({
      title: t("voice.downloadConfirmTitle"),
      message: t("voice.downloadConfirmBody"),
      confirmText: t("voice.downloadBtn"),
    });
    if (!ok) return;
    setVoiceDl({ done: 0, total: 0 });
    try {
      await api.voicePrepare();
    } catch (e) {
      setVoiceDl(null);
      const emsg = typeof e === "string" ? e : e?.message || String(e);
      flashVoiceHint(`${t("voice.downloadFailed")}${emsg ? `：${emsg}` : ""}`, "err");
    }
  };

  // 麦克风入口 ref：全局语音快捷键事件在 effect 里调用，避免闭包过期
  const voiceEntryRef = useRef(() => {});
  voiceEntryRef.current = toggleVoice;

  // Electron 宿主全局事件：全局语音听写（开录，转写后粘贴回原应用）+ 截图提问（挂图片附件）
  useEffect(() => {
    const unVoice = listen("global-voice", (e) => {
      pasteTargetRef.current = { bundleId: e.payload?.bundleId || "", hwnd: e.payload?.hwnd || "" };
      void voiceEntryRef.current();
    });
    const unShot = listen("screenshot-capture", (e) => {
      const url = e.payload?.dataUrl;
      if (!url) return;
      setImages((arr) => [...arr, { name: `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`, dataUrl: url }]);
      flashVoiceHint(t("chat.shotAttached"));
      inputRef.current?.focus();
    });
    const unShotErr = listen("screenshot-capture-error", (e) => {
      const msg = e.payload?.message;
      if (msg) flashVoiceHint(msg, "err");
    });
    return () => {
      unVoice.then((f) => f());
      unShot.then((f) => f());
      unShotErr.then((f) => f());
    };
  }, []);

  // 识别模型选择弹窗：variants=[{id,label,languages,bytes,ready}]；返回所选 id 或 null 取消
  const selectVoiceModel = (variants, currentId) =>
    new Promise((resolve) => {
      const fmtMB = (b) => `${Math.round(b / 1024 / 1024)}MB`;
      setVoicePicker({
        variants: variants.map((v) => ({
          ...v,
          sizeText: fmtMB(v.bytes || 0),
          langText: (v.languages || []).filter((l) => l !== "auto").slice(0, 5).join("/"),
        })),
        currentId,
        resolve,
      });
    });

  // 后台会话变动（如子智能体新建会话 / 完成任务）：自动刷新侧栏与当前会话内容
  useEffect(() => {
    const un = listen("sessions-updated", (e) => {
      loadSessions();
      if (typeof e.payload === "string" && e.payload && e.payload === activeId) {
        loadMessages(activeId);
      }
    });
    return () => un.then((f) => f());
    // 仅随 activeId 重挂监听；loadSessions/loadMessages 闭包引用刻意冻结
  }, [activeId]);

  // 派生：当前会话状态与全局运行数
  const busy = !!busyMap[activeId]; // 当前会话是否执行中
  const live = liveMap[activeId] || null;
  const runningCount = Object.keys(busyMap).length;

  // 自动朗读：busy 由真变假（回复完成）时，朗读最后一条 AI 消息的文字
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (wasBusyRef.current && !busy && autoSpeak) {
      const last = [...messages].reverse().find((m) => m.role !== "user" && m.content && m.content.trim());
      if (last) {
        speakText(last.content).catch(() => { /* 朗读失败静默：不打断聊天 */ });
      }
    }
    wasBusyRef.current = busy;
    // messages 依赖刻意省略：只在 busy 边沿触发，避免流式更新反复朗读
  }, [busy, autoSpeak]);

  // 页眉把自动朗读关掉时，正在播的那条要立刻停（开关本身写在 automationStore）
  useEffect(() => {
    if (!autoSpeak) stopTts();
  }, [autoSpeak]);

  // 计划栏派生：非放弃目标 + 归属待办；无目标待办的独立待办单独成组
  // 按会话隔离：带 session_id 的计划只在其归属会话显示，无归属（用户手建/旧数据）视为全局
  const planVisibleGoals = planGoals.filter(
    (g) => g.status !== "abandoned" && (!g.session_id || g.session_id === activeId)
  );
  const planGoalIds = new Set(planVisibleGoals.map((g) => g.id));
  const planVisibleTodos = planTodos.filter(
    (td) => (!td.session_id || td.session_id === activeId) && (!td.goal_id || planGoalIds.has(td.goal_id))
  );
  const planLooseTodos = planVisibleTodos.filter((td) => !td.goal_id);
  const planGroups = [
    ...planVisibleGoals.map((g) => ({ goal: g, todos: planVisibleTodos.filter((td) => td.goal_id === g.id) })),
    ...(planLooseTodos.length ? [{ goal: null, todos: planLooseTodos }] : []),
  ];
  const planTodoDone = planVisibleTodos.filter((td) => td.status === "completed").length;
  const planAllDone =
    planVisibleTodos.length > 0 &&
    planTodoDone === planVisibleTodos.length &&
    planVisibleGoals.every((g) => g.status === "achieved");

  // 上下文用量估算：优先使用后端按真实上下文构造得到的统一口径，
  // 前端仅在结果返回前用消息长度做兜底估算。
  // 阈值优先取后端从模型 API 拉到的最大上下文（model_context 缓存），
  // 拿不到时退回手动设置（默认 128K，localStorage 持久化）
  // 上下文上限：模型上报值优先；用户在页眉点数字改过后（bit.ctxLimitOverride + 强制标记），
  // 临时上限覆盖模型与回退值，直到在页眉编辑态点「恢复自动」。
  // 页眉改值不动设置里的回退值（bit.ctxLimitK），恢复自动能回到原来的数。
  const [ctxLimitK, setCtxLimitK] = useState(() => {
    const v = parseInt(localStorage.getItem("bit.ctxLimitK"));
    return Number.isFinite(v) && v >= 4 && v <= 2000 ? v : 128;
  });
  const [ctxForce, setCtxForce] = useState(() => localStorage.getItem("bit.ctxLimitForce") === "1");
  const [ctxOverride, setCtxOverride] = useState(() => {
    const v = parseInt(localStorage.getItem("bit.ctxLimitOverride"));
    return Number.isFinite(v) && v >= 4 && v <= 2000 ? v : 0;
  });
  const [limitEdit, setLimitEdit] = useState(false);
  const [limitInput, setLimitInput] = useState("");
  const ctxLimitKnown = Number.isFinite(contextMeta?.max_context) && contextMeta.max_context > 0;
  // 上限来源：api=提供方接口上报；claude=接口不提供时按家族默认；空=用设置回退值
  const ctxLimitSource = ctxLimitKnown ? contextMeta?.max_context_source || "api" : "";
  const overrideK = ctxForce && ctxOverride > 0 ? ctxOverride : 0;
  const CONTEXT_LIMIT = overrideK
    ? overrideK * 1024
    : ctxLimitKnown
      ? contextMeta.max_context
      : ctxLimitK * 1024;
  const [compressing, setCompressing] = useState(false);
  const estimateTokens = (text) => Math.ceil((text || "").length / 2);
  const localContextTokens = (() => {
    let n = 4; // system prompt 基数
    for (const m of messages) n += estimateTokens(m.content) + 4;
    return n;
  })();
  const contextTokens = Math.max(contextMeta.est_tokens || 0, localContextTokens) + (live ? estimateTokens(live.text) : 0);
  const ctxPct = contextTokens / CONTEXT_LIMIT;
  const saveLimit = () => {
    setLimitEdit(false);
    const v = parseInt(limitInput);
    if (Number.isFinite(v) && v >= 4 && v <= 2000 && v !== ctxLimitK) {
      setCtxLimitK(v);
      localStorage.setItem("bit.ctxLimitK", String(v));
      // 通知设置中心的「上下文上限」卡片同步（两个页面常驻挂载）
      window.dispatchEvent(new Event("bit-ctx-limit"));
    }
  };
  // 设置中心 / 页眉改上限时即时回灌；跨窗口（远程 Web 端）靠 storage 事件兜底
  useEffect(() => {
    const sync = () => {
      const v = parseInt(localStorage.getItem("bit.ctxLimitK"));
      if (Number.isFinite(v) && v >= 4 && v <= 2000) setCtxLimitK(v);
      const o = parseInt(localStorage.getItem("bit.ctxLimitOverride"));
      setCtxOverride(Number.isFinite(o) && o >= 4 && o <= 2000 ? o : 0);
      setCtxForce(localStorage.getItem("bit.ctxLimitForce") === "1");
    };
    window.addEventListener("bit-ctx-limit", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("bit-ctx-limit", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const usage = usageMap[activeId] || null;
  const speed = speedMap[activeId] || null; // 本会话流式生成速度（tok/s），非流式期间为 null
  const usageKnown = !!usage?.prompt_tokens;

  useEffect(() => {
    let cancelled = false;
    if (!activeId) {
      setContextMeta({ est_tokens: 0 });
      return;
    }
    setContextMeta((prev) => (prev.est_tokens ? { est_tokens: 0 } : prev));
    const timer = setTimeout(async () => {
      try {
        const r = await api.contextMetrics(activeId);
        if (!cancelled) setContextMeta(r || { est_tokens: 0 });
      } catch {
        if (!cancelled) setContextMeta({ est_tokens: 0 });
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeId, messages, ctxMetaTick]);

  const visibleMessages = messages.filter((m) => m.role !== "system");

  // 对话钩子统计：本对话到目前为止每次工具调用的次数 + 最近几条。
  // 历史来自消息里的 tool_calls，执行中的轮次来自 live.cards（两者短暂重叠也无妨）。
  // 这份统计随 bit-dash 一起广播给页眉指示灯，点开指示灯就是它，对话页不再单挂一块面板。
  const hookStats = useMemo(() => {
    const counts = new Map();
    const recent = [];
    let ok = 0;
    let fail = 0;
    const push = (call, ts) => {
      const tool = String(call?.tool || "");
      if (!tool) return;
      counts.set(tool, (counts.get(tool) || 0) + 1);
      if (call.ok === false) fail++;
      else ok++;
      recent.push({
        tool,
        ok: call.ok !== false,
        summary: String(call?.params?.command || call?.params?.path || call?.params?.query || call?.params?.url || ""),
        ts,
      });
    };
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const c of m.tool_calls || []) push(c, m.ts);
    }
    for (const card of live?.cards || []) {
      for (const c of card.calls || []) push(c, null);
    }
    return {
      total: ok + fail,
      ok,
      fail,
      kinds: counts.size,
      list: [...counts.entries()].sort((a, b) => b[1] - a[1]),
      recent: recent.slice(-8).reverse(),
    };
  }, [messages, live]);

  // 页眉仪表盘数据广播（版本/内存由页眉自取）
  // 上下文上限取生效值：页眉是唯一的用量展示处，报手动值会在自动取到模型上限时骗人
  // thinking：在跑、但当前这段还没有可见回复文字、也没派生工具卡片——
  // 也就是模型在想（reasoning 流）或在等首字，页眉指示灯用蓝色表达这一段
  const runningSids = Object.keys(busyMap).filter((sid) => busyMap[sid]);
  const producing = runningSids.some((sid) => {
    const l = liveMap[sid];
    return !!l && ((l.text || "").trim() !== "" || (l.cards || []).length > 0);
  });
  const dashThinking = runningSids.length > 0 && !producing;
  // 工具执行中：实时卡片还有 pending（工具已发起、结果未回）——页眉指示灯用紫色区分「在调工具」
  const dashTool = runningSids.some((sid) => {
    const cards = liveMap[sid]?.cards || [];
    return cards.some((c) => c.pending && (!c.calls || c.calls.length === 0));
  });
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("bit-dash", {
        detail: {
          sessions: sessions.length,
          tokens: contextTokens,
          limitK: Math.round(CONTEXT_LIMIT / 1024),
          limitAuto: ctxLimitKnown && !ctxForce,
          limitSource: ctxLimitKnown ? ctxLimitSource : "",
          limitForce: ctxForce,
          running: runningCount > 0,
          thinking: dashThinking,
          tool: dashTool,
          cacheHitRate: usage?.cache_known ? usage?.hit_rate || 0 : null,
          cacheKnown: !!usage?.cache_known,
          showCache: usageKnown,
          hooks: hookStats,
        },
      }),
    );
  }, [sessions.length, contextTokens, CONTEXT_LIMIT, ctxLimitKnown, ctxLimitSource, ctxForce, runningCount, dashThinking, dashTool, usage?.hit_rate, usageKnown, usage?.cache_known, hookStats]);

  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  // 读文件为 dataURL
  const readAsDataURL = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  // 一个文件进附件的两条路：图片直接读成 dataURL，其余交给核心解析正文。
  // 三处入口（附件菜单 / 粘贴 / 从系统拖进来）都走这两个函数，行为与提示保持一致。
  // 桥接层错误带 “Error invoking remote method 'bit:invoke': Error:” 前缀，界面只留人话
  const cleanErr = (e) => {
    const raw = String((e && e.message) || e || "");
    const m = /Error invoking remote method '[^']+':\s*([\s\S]*)$/.exec(raw);
    const msg = (m ? m[1] : raw).replace(/^Error:\s*/, "").trim() || raw;
    // 核心给带标记的错误时按当前语言换文案；没登记的标记就照原文显示
    const tag = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(msg);
    return tag ? t(`chat.extractErr.${tag[1]}`, tag[2]) : msg;
  };
  const resetAttachErr = () => {
    failRef.current = [];
    setAttachErr("");
  };

  const pushImageFile = async (f) => {
    try {
      const dataUrl = await readAsDataURL(f);
      setImages((arr) => [...arr, { name: f.name, dataUrl }]);
    } catch {
      setAttachErr(t("chat.imageReadFailed") + (f.name || ""));
    }
  };

  const pushDocFile = async (f, path) => {
    const base = { name: f.name, size: f.size || 0, path: path || "", kind: fileKind(f.name, f.type).key };
    try {
      const dataUrl = await readAsDataURL(f);
      // 带上绝对路径：正文够大时核心返回的是概览（行数/字数/大纲 + read_doc 指引），
      // 发给模型的是概览而不是整份正文，细节让模型自己按行号取回
      const r = await api.extractFile(f.name, dataUrl, base.path);
      if (r?.text) {
        setDocs((arr) => [...arr, { ...base, text: r.text, brief: r.overview || r.text }]);
        return;
      }
    } catch (err) {
      failRef.current.push(f.name);
      setAttachErr(t("chat.parseFailed") + `${failRef.current.join(lang.startsWith("zh") ? "、" : ", ")} — ${cleanErr(err)}`);
    }
    // 解析不出正文也不把文件丢掉：按「引用」附上（名字/大小/绝对路径），
    // 正文位置留给模型一句提示，它能拿路径去 read_file 自己读。
    setDocs((arr) => [...arr, { ...base, text: "", meta: t("chat.attachRefOnly") }]);
  };

  const onPickImages = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // 允许重复选同一文件
    resetAttachErr();
    for (const f of files) {
      try {
        const dataUrl = await readAsDataURL(f);
        setImages((arr) => [...arr, { name: f.name, dataUrl }]);
      } catch {
        setAttachErr(t("chat.imageReadFailed") + f.name);
      }
    }
  };

  // 输入框粘贴：支持剪贴板里的截图/图片 与 资源管理器复制的任意文件
  //   image/* → 图片附件（多模态）；其余文件 → 走文档解析链路（与 📄 菜单上传同链路）
  const onPasteInput = async (e) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!files.length) return; // 纯文本粘贴走默认行为
    e.preventDefault(); // 阻止把文件名当文本插入
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    const docs = files.filter((f) => !f.type.startsWith("image/"));
    resetAttachErr();
    for (const f of imgs) {
      try {
        const dataUrl = await readAsDataURL(f);
        const name = f.name && f.name !== "image.png" ? f.name : t("chat.pastedImage") + `_${Date.now()}.png`;
        setImages((arr) => [...arr, { name, dataUrl }]);
      } catch {
        setAttachErr(t("chat.imageReadFailed") + (f.name || "clipboard"));
      }
    }
    if (docs.length) {
      setAttaching(true);
      try {
        for (const f of docs) await pushDocFile(f, "");
      } finally {
        setAttaching(false);
      }
    }
  };

  const onPickDocs = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    resetAttachErr();
    setAttaching(true);
    try {
      for (const f of files) await pushDocFile(f, "");
    } finally {
      setAttaching(false);
    }
  };

  const addUrl = async () => {
    const u = urlText.trim();
    if (!u) return;
    resetAttachErr();
    if (!urlParse) {
      // 仅作为文本插入
      setDocs((arr) => [...arr, { name: u, text: u, kind: "url", path: u }]);
      setUrlText("");
      setUrlOpen(false);
      return;
    }
    setAttaching(true);
    try {
      const r = await api.fetchWebpage(u);
      const title = r?.title ? `# ${r.title}\n\n` : "";
      setDocs((arr) => [...arr, { name: r?.title || u, text: `${t("chat.webSourceLabel", { url: u })}\n\n${title}${r?.text || ""}`, kind: "url", path: u }]);
      setUrlText("");
      setUrlOpen(false);
    } catch (err) {
      setAttachErr(t("chat.webFetchFailed") + cleanErr(err));
    } finally {
      setAttaching(false);
    }
  };

  const removeImage = (i) => setImages((arr) => arr.filter((_, j) => j !== i));
  const removeDoc = (i) => setDocs((arr) => arr.filter((_, j) => j !== i));
  const clearAttachments = () => {
    setImages([]);
    setDocs([]);
  };
  const hasAttachments = images.length > 0 || docs.length > 0;

  const loadSessions = async () => {
    const r = await api.listSessions().catch(() => null);
    if (!r) return;
    // 插件会话（plugin:<id>）照常进左侧列表：插件聊天与唤回注入的回复都落在这里，
    // 只留在插件页和系统通知里，用户看到通知却找不到那条对话。空会话（还没产生
    // 任何消息，插件建完没用上）不占位；行首拼图图标标明来源。
    setSessions((r.sessions || []).filter((s) => !isPluginSession(s.id) || s.count > 0));
    setActiveId((cur) => cur || r.active || "");
    return r;
  };

  const loadMessages = async (id) => {
    const r = await api.getSession(id).catch(() => null);
    setMessages(r?.messages || []);
  };

  useEffect(() => {
    loadSessions();
    // bit 命令行等外部进程创建的会话也要出现：定期重拉列表（后端按 mtime 合并磁盘变更，代价极低）
    const timer = setInterval(loadSessions, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (activeId) loadMessages(activeId);
  }, [activeId]);

  // 滚动跟随：页面隐藏时 display:none，scrollIntoView 静默失败，故隐藏期间用瞬时模式；
  // 切回对话页时立即校正一次滚动位置，恢复流式动画区的可见性
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: visible ? "smooth" : "auto" });
  }, [messages, busy, live]);
  useEffect(() => {
    if (visible) requestAnimationFrame(() => bottom.current?.scrollIntoView());
  }, [visible]);

  const selectSession = async (id) => {
    // 多会话并发：切换不受执行状态限制
    if (id === activeId) return;
    setActiveId(id);
    // 切到折叠分组里的会话时把组展开：手动点开的目标不该还藏在组里
    const g = (sessionsRef.current.find((s) => s.id === id)?.group || "").trim();
    if (g) setCollapsedGroups((prev) => (prev.has(g) ? new Set([...prev].filter((n) => n !== g)) : prev));
    await api.setActiveSession(id).catch(() => {});
  };

  const newSession = async () => {
    const r = await api.createSession("").catch(() => null);
    if (r?.id) {
      await loadSessions();
      setActiveId(r.id);
      setMessages([]);
    }
  };

  // 从某条消息分叉：后端复制截至该条的历史到新会话并激活，这里切过去继续聊
  const branchSession = async (index) => {
    if (!activeId) return;
    const r = await api.forkSession(activeId, index).catch(() => null);
    if (!r?.id) return;
    await loadSessions();
    setActiveId(r.id);
    flashHint(t("chat.branched"));
  };

  // 从此处回退：删掉这条之后的消息，并恢复这些步骤改过的文件（核心只允许最近 10 条）
  const rollbackSession = async (index) => {
    if (!activeId) return;
    if (
      !(await confirmDialog({
        title: t("chat.rollbackTitle"),
        message: t("chat.rollbackConfirm"),
        danger: true,
      }))
    )
      return;
    let r = null;
    try {
      r = await api.rollbackSession(activeId, index);
    } catch (e) {
      flashHint(String(e?.message || e));
      return;
    }
    await loadMessages(activeId);
    await loadSessions();
    const n = (r?.files?.restored?.length || 0) + (r?.files?.deleted?.length || 0);
    flashHint(n > 0 ? t("chat.rolledBackFiles", { n }) : t("chat.rolledBack"));
  };

  // 图标栏「+」小加号 → 新建会话（跨组件事件）
  useEffect(() => {
    const h = () => newSession();
    window.addEventListener("bit-new-session", h);
    return () => window.removeEventListener("bit-new-session", h);
  }, []);

  // 图标栏「多选」按钮 → 切换会话多选模式（跨组件事件；侧栏折叠已改为 props 直连）
  useEffect(() => {
    const hMulti = () => (multiMode ? exitMulti() : enterMulti());
    window.addEventListener("bit-toggle-multi", hMulti);
    return () => window.removeEventListener("bit-toggle-multi", hMulti);
  });

  // 后台 shell / 子代理等面板、悬浮搜索面板请求：打开指定会话
  useEffect(() => {
    const h = (e) => {
      const id = e.detail?.id;
      if (!id) return;
      setSessQuery(""); // 搜索面板跳转时列表可能正被关键词过滤，不清掉目标行看不见
      selectSession(id);
    };
    window.addEventListener("bit-open-session", h);
    return () => window.removeEventListener("bit-open-session", h);
    // selectSession 只依赖稳定 api 与 setState，空依赖即可
  }, []);

  const deleteSession = async (id, e) => {
    e?.stopPropagation();
    if (busyMap[id]) return; // 执行中的会话不能删除，避免流式结果写入已删会话
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("chat.confirmDeleteSession"),
        danger: true,
      }))
    )
      return;
    const r = await api.deleteSession(id).catch(() => null);
    if (r) {
      await loadSessions();
      setActiveId(r.active || "");
    }
  };

  const submitRename = async () => {
    if (!renaming) return;
    await api.renameSession(renaming.id, renaming.title).catch(() => {});
    setRenaming(null);
    loadSessions();
  };

  // 临时提示（自动消失）
  const flashHint = (msg) => {
    setBatchHint(msg);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setBatchHint(""), 3000);
  };

  const toggleFavorite = async (id) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    await api.setSessionFavorite(id, !s.favorite).catch(() => {});
    loadSessions();
  };

  const setTagColor = async (id, color) => {
    setColorFor(null);
    await api.setSessionColor(id, color || "").catch(() => {});
    loadSessions();
  };

  // ===== 会话分组 =====
  // 组只是会话上的一个名字：把会话挪进/挪出分组就是改它的 group，改完重拉列表即可
  const moveSessionToGroup = async (id, name) => {
    const g = (name || "").trim();
    setGroupFor(null);
    setNewGroupName("");
    await api.setSessionGroup(id, g).catch(() => {});
    if (g) {
      // 挪进去就展开，让人看见它真的进组了
      setCollapsedGroups((prev) => (prev.has(g) ? new Set([...prev].filter((n) => n !== g)) : prev));
    }
    loadSessions();
  };

  const createGroupWith = (id) => {
    if (!newGroupName.trim()) return;
    moveSessionToGroup(id, newGroupName);
  };

  const toggleGroup = (name) => {
    setGroupColorFor(null);
    setCollapsedGroups((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  };

  // 分组颜色只影响本机界面：空色=清除标记；不写核心，改完立即生效
  const setGroupColor = (name, color) => {
    setGroupColorFor(null);
    setGroupColors((prev) => {
      if (!color) {
        if (!(name in prev)) return prev;
        const n = { ...prev };
        delete n[name];
        return n;
      }
      if (prev[name] === color) return prev;
      return { ...prev, [name]: color };
    });
  };

  // 分组改名：后端把所有属于旧名的会话一起改过来，折叠态与颜色跟着换键
  const submitGroupRename = async () => {
    const r = groupRenaming;
    setGroupRenaming(null);
    setGroupColorFor(null);
    if (!r) return;
    const from = r.name;
    const to = r.value.trim();
    if (!to || to === from) return;
    await api.renameSessionGroup(from, to).catch(() => {});
    setCollapsedGroups((prev) => {
      if (!prev.has(from)) return prev;
      const n = new Set(prev);
      n.delete(from);
      n.add(to);
      return n;
    });
    setGroupColors((prev) => {
      if (!(from in prev)) return prev;
      const n = { ...prev, [to]: prev[from] };
      delete n[from];
      return n;
    });
    loadSessions();
  };

  // 解散 = 组名改成空串，会话全部回到未分组，组自然消失
  const dissolveGroup = async (name) => {
    setGroupColorFor(null);
    await api.renameSessionGroup(name, "").catch(() => {});
    setCollapsedGroups((prev) => (prev.has(name) ? new Set([...prev].filter((n) => n !== name)) : prev));
    setGroupColors((prev) => {
      if (!(name in prev)) return prev;
      const n = { ...prev };
      delete n[name];
      return n;
    });
    loadSessions();
  };

  // 向右拖动（按住右移超过阈值）→ 召唤该会话的彩色调色板
  // 拖动过程中行就跟着位移，左侧露出的区域填标签色：手势有实时反馈，露出来的东西也带信息
  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      const horiz = Math.abs(dx) > Math.abs(dy) * 1.3;
      if (!d.armed && dx > 26 && horiz) d.armed = true;
      if (horiz && dx > 6) {
        if (d.shownId !== d.id) d.shownId = d.id;
        const x = Math.min(dx, SWIPE_REVEAL);
        if (d.shown !== x) {
          d.shown = x;
          setSwipe({ id: d.id, x });
        }
        e.preventDefault();
      }
    };
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.shownId) setSwipe({ id: "", x: 0 }); // 行弹回原位（transition 接手）
      if (d?.armed) {
        swipedRef.current = d.id;
        setGroupFor(null);
        setGroupColorFor(null);
        setColorFor(d.id);
        setTimeout(() => (swipedRef.current = null), 0);
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, []);

  const startRowDrag = (e, id) => {
    if (e.button !== 0 || multiMode) return; // 多选模式下不做右滑手势
    if (busyMap[id]) return;
    dragRef.current = { x: e.clientX, y: e.clientY, id, armed: false };
  };

  // 会话行点击：多选=勾选；普通=切换；刚右滑完的这一次点击被抑制
  const onRowClick = (id) => {
    if (swipedRef.current === id) {
      swipedRef.current = null;
      return;
    }
    if (multiMode) {
      if (busyMap[id]) return;
      setSelSet((prev) => {
        const n = new Set(prev);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
      return;
    }
    if (colorFor) setColorFor(null);
    if (groupFor) setGroupFor(null);
    if (groupColorFor) setGroupColorFor(null);
    selectSession(id);
  };

  const enterMulti = () => {
    setMultiMode(true);
    setSelSet(new Set());
    setColorFor(null);
    setGroupFor(null);
    setGroupColorFor(null);
  };
  const exitMulti = () => {
    setMultiMode(false);
    setSelSet(new Set());
    setColorFor(null);
    setGroupFor(null);
    setGroupColorFor(null);
    setBatchHint("");
  };

  const allSelectableIds = sessions.filter((s) => !busyMap[s.id]).map((s) => s.id);
  const allSelected = allSelectableIds.length > 0 && allSelectableIds.every((id) => selSet.has(id));
  const toggleSelectAll = () => {
    setSelSet(allSelected ? new Set() : new Set(allSelectableIds));
  };

  // 批量删除：收藏与执行中的对话自动跳过；有跳过时留在多选态并给出反馈
  const batchDelete = async () => {
    if (selSet.size === 0) return;
    const picked = sessions.filter((s) => selSet.has(s.id));
    const favIds = picked.filter((s) => s.favorite).map((s) => s.id);
    const busyPicked = picked.filter((s) => busyMap[s.id]);
    const ids = picked.filter((s) => !s.favorite && !busyMap[s.id]).map((s) => s.id);
    if (ids.length === 0) {
      flashHint(favIds.length ? t("chat.favOnly") : t("chat.skipBusy"));
      return;
    }
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("chat.confirmDeleteSessions", { n: ids.length }),
        danger: true,
      }))
    )
      return;
    const r = await api.deleteSessions(ids).catch(() => null);
    if (!r) return;
    await loadSessions();
    if (ids.includes(activeId)) setActiveId(r.active || "");
    // 保留未被删除的勾选项（收藏 / 执行中），供用户继续处理
    setSelSet(new Set(picked.filter((s) => !ids.includes(s.id)).map((s) => s.id)));
    const notes = [];
    if (favIds.length) notes.push(t("chat.favProtected"));
    if (busyPicked.length) notes.push(t("chat.skipBusy"));
    if (notes.length) flashHint(notes.join(" · "));
    else exitMulti();
  };

  const send = async () => {
    if (recording) return; // 录音期间禁止发送（先停止录音）
    const text = input.trim();
    // 「停止 <job_id>」：直接取消对应后台长命令，不再发给 AI（AI 提示用户时可这么用）
    const stopM = text.match(/^(?:停止|stop)\s+(sh\d+)\s*$/i);
    if (stopM) {
      const jid = stopM[1];
      setInput("");
      try {
        await api.cancelShell(jid);
        if (activeRef.current)
          setMessages((msgs) => [...msgs, { role: "assistant", content: t("chat.stopRequested", { jid }) }]);
      } catch (e) {
        const emsg = typeof e === "string" ? e : e?.message || String(e);
        if (activeRef.current)
          setMessages((msgs) => [...msgs, { role: "assistant", content: emsg }]);
      }
      return;
    }
    // 允许只带附件（图片/文档）而无文字时也可发送
    if ((!text && !hasAttachments) || !activeId) return;
    const sid = activeId; // 锁定目标会话：之后用户切换页面不影响本次执行

    // 文档正文（Excel/Word/CSV/网页）拼到消息前当上下文；每块开头带一行机器可读标记，
    // 前端据此把正文折回成附件卡（见 components/FileRef.jsx 的 parseFileBlocks）。
    // brief 是核心给的概览（拖进来的大正文文件才有）：发概览不发整份正文，
    // 模型要细节按里面的 read_doc 指引自己取，整轮上下文压力就下来了。
    const docBlocks = docs
      .map(
        (d) =>
          `${fileBlockMarker({ name: d.name, size: d.size, path: d.path, kind: d.kind || fileKind(d.name).key })}\n${
            d.brief || d.text || t("chat.attachmentUnparsed", { name: d.name, path: d.path || "—" })
          }`
      )
      .join("\n\n---\n\n");
    const composed = docBlocks
      ? `${docBlocks}${text ? `\n\n---\n\n${text}` : ""}`
      : text || t("chat.seeAttachedImages");

    // 图片以 dataURL base64 传给多模态模型
    const imgData = images.map((im) => im.dataUrl);

    // 气泡直接按 composed 回显：核心存的就是 composed，本地再拼一个「[文档 ×N]」标记
    // 只会造成「发出去看得见、切回来凭空消失」的前后不一致。现在附件卡从 composed
    // 里解析出来，live 与重载同一条路。
    const item = { composed, bubble: composed, imgData };

    setInput("");
    setImages([]);
    setDocs([]);
    resetAttachErr();

    // 会话执行中：加入等待队列，当前任务结束后自动按顺序发送。
    // 队列项不写进 messages——对话流里那条"排队中"的气泡由队列派生（见下方 pending 渲染），
    // 所以摘掉 pill、拖拽改序、切会话再切回来，界面永远和真正要发的东西一致。
    if (busyMap[sid] || runningRef.current.has(sid)) {
      const next = { ...queuesRef.current, [sid]: [...(queuesRef.current[sid] || []), item] };
      queuesRef.current = next;
      setQueues(next);
      return;
    }

    if (activeRef.current === sid) {
      setMessages((msgs) => [...msgs, { role: "user", content: item.bubble, images: item.imgData }]);
    }
    // 用户主动发消息 = 想继续对话：解除此前中断造成的队列暂停
    setPausedFor(sid, false);
    runTask(sid, item);
  };

  // 免手对话：语音转写文本直接作为消息发送（绕过输入框草稿；会话忙时进等待队列，
  // 与打字发送同一条派生渲染口径）
  const sendVoiceMessage = (text) => {
    const sid = activeRef.current;
    if (!sid) return;
    const item = { composed: text, bubble: text, imgData: [] };
    if (busyMap[sid] || runningRef.current.has(sid)) {
      const next = { ...queuesRef.current, [sid]: [...(queuesRef.current[sid] || []), item] };
      queuesRef.current = next;
      setQueues(next);
      return;
    }
    if (activeRef.current === sid) {
      setMessages((msgs) => [...msgs, { role: "user", content: item.bubble, images: item.imgData }]);
    }
    setPausedFor(sid, false);
    runTask(sid, item);
  };

  // 速度估算：CJK 字符 ≈1 token，其余每 4 字符 ≈1 token；每收到增量就刷新一次 tok/s
  const bumpSpeed = (sid, text) => {
    const t = speedRef.current[sid];
    if (!t || !text) return;
    for (const ch of text) t.tokens += ch.codePointAt(0) > 0x2e7f ? 1 : 0.25;
    const secs = (performance.now() - t.start) / 1000;
    if (secs > 0.2) setSpeedMap((m) => ({ ...m, [sid]: t.tokens / secs }));
  };

  // 实际执行一次对话任务（流式），结束时自动续发该会话的等待队列。
  // busy 标记统一在此设置：无论是直接发送还是队列续发，执行期间新消息都会正确排队
  // 流式事件处理（chat_stream 与 regenerate_last 共用）：增量文本/思考/工具卡/用量/最终消息
  const handleStreamEvent = (sid, endLive) => (ev) => {
        if (!ev || typeof ev !== "object") return;
        switch (ev.type) {
          case "round_start":
            // 新一轮开始：清空本轮实时文本，保留此前已完成轮次的工具卡片；
            // 思考过程跨轮累积（落库的是整个回合的思考，实时面板保持一致）
            speedRef.current[sid] = { start: performance.now(), tokens: 0 }; // 速度表重新计时
            setLiveMap((m) => ({ ...m, [sid]: { text: "", think: m[sid]?.think || "", cards: m[sid]?.cards || [] } }));
            break;
          case "think":
            // 思考过程增量（reasoning/thinking）：实时展示（同时计入速度估算——思考也是输出 token）
            bumpSpeed(sid, ev.text);
            setLiveMap((m) => ({
              ...m,
              [sid]: { text: m[sid]?.text || "", think: (m[sid]?.think || "") + (ev.text || ""), cards: m[sid]?.cards || [] },
            }));
            break;
          case "delta":
            bumpSpeed(sid, ev.text);
            setLiveMap((m) => ({
              ...m,
              [sid]: { text: (m[sid]?.text || "") + (ev.text || ""), think: m[sid]?.think || "", cards: m[sid]?.cards || [] },
            }));
            break;
          case "round_tools_starting":
            // 工具轮开始：先渲染灰色 spinner 占位（tools 事件到达后会覆盖同一张卡）
            setLiveMap((m) => ({
              ...m,
              [sid]: {
                text: "",
                think: m[sid]?.think || "",
                cards: [...(m[sid]?.cards || []), { pending: ev.pending || [], visible: "", calls: [] }],
              },
            }));
            break;
          case "tools":
            // 本轮是工具调用：丢弃流式文本，沉淀为卡片（含可选的说明文字）；
            // 思考跨轮保留（落库的是整个回合的思考，实时面板保持一致，调工具不清空）
            // 同时把前面的 pending spinner 卡替换成完整结果卡
            setLiveMap((m) => {
              const oldCards = m[sid]?.cards || [];
              // 找到最后一张 pending 卡（没有 calls 只有 pending），替换成结果卡
              const newCards = oldCards.slice();
              const pendingIdx = newCards.findLastIndex((c) => c.pending && (!c.calls || c.calls.length === 0));
              const resultCard = { visible: ev.visible || "", calls: ev.calls || [] };
              if (pendingIdx >= 0) {
                newCards[pendingIdx] = resultCard;
              } else {
                newCards.push(resultCard);
              }
              return {
                ...m,
                [sid]: { text: "", think: m[sid]?.think || "", cards: newCards },
              };
            });
            break;
          case "continue":
            // 后端检测到回复被截断，自动续发「继续」：用清洗后的片段替换原始流式文本
            setLiveMap((m) => ({ ...m, [sid]: { text: ev.visible || "", think: m[sid]?.think || "", cards: m[sid]?.cards || [] } }));
            break;
          case "net_retry":
            // 网络瞬断自动重试：本轮半截内容重新生成（历史未落库），清空实时文本与思考避免重复；
            // 已完成轮次的工具卡片保留
            setLiveMap((m) => ({ ...m, [sid]: { text: "", think: "", cards: m[sid]?.cards || [] } }));
            break;
          case "usage":
            // 本轮 token 用量与缓存命中率（会话累计）
            setUsageMap((m) => ({ ...m, [sid]: ev }));
            break;
          case "final":
            // 仅当用户还停留在这个会话时刷新消息列表；后台会话结果已落库
            if (activeRef.current === sid && ev.messages) setMessages(ev.messages);
            endLive();
            break;
          case "error":
            if (ev.interrupted) {
              // 中断：中间过程（工具调用等）已逐轮落库，重新加载完整历史而非清空现场
              setPausedFor(sid, true); // 队列暂停，不自动续发
              if (activeRef.current === sid) loadMessages(sid);
              endLive();
            } else {
              if (activeRef.current === sid) {
                setMessages(() => [
                  // 上游断流前已流出的部分回复先入列（后端已落库），避免已显示的内容消失
                  ...(ev.partial ? [{ role: "assistant", content: ev.partial }] : []),
                  { role: "assistant", content: t("chat.callFailed") + ev.error },
                ]);
              }
              endLive();
            }
            break;
          default:
            console.warn("[BIT][chat] 未处理事件类型:", ev?.type || "(无 type)", ev);
            break;
        }
  };

  const runTask = async (sid, item) => {
    if (runningRef.current.has(sid)) return; // 重入保护：同一会话绝不并发两个任务
    runningRef.current.add(sid);
    setBusyMap((m) => ({ ...m, [sid]: true }));
    setLiveMap((m) => ({ ...m, [sid]: m[sid] || { text: "", think: "", cards: [] } }));
    // 结束时移除该会话的运行/流式状态
    const endLive = () =>
      setLiveMap((m) => {
        const n = { ...m };
        delete n[sid];
        return n;
      });
    try {
      const res = await api.chatStream(sid, item.composed, null, handleStreamEvent(sid, endLive), item.imgData);
      if (activeRef.current === sid && res?.messages) setMessages(res.messages);
      endLive();
      loadSessions();
      onStats?.();
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 核心说这个会话还在跑（多半是本地忙表失真）：这条退回队列等当前回合结束续发，
      // 并把刚才的回显气泡撤掉——它会由队列以「排队中」的样子重新出现，不重复也不丢。
      if (/正在执行的回合/.test(msg)) {
        busyHoldRef.current[sid] = Date.now() + 4000; // 冷却几秒，避免"回绝→续发→再回绝"打转
        const back = { ...queuesRef.current, [sid]: [...(queuesRef.current[sid] || []), item] };
        queuesRef.current = back;
        setQueues(back);
        if (activeRef.current === sid) {
          setMessages((msgs) => {
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "user" && msgs[i].content === item.bubble) {
                const n = msgs.slice();
                n.splice(i, 1);
                return n;
              }
            }
            return msgs;
          });
        }
        syncTruthRef.current?.(); // 忙表按核心真相回填，队列条与"排队中"气泡随即出现
        endLive();
        return;
      }
      // 错误已通过 error 事件推送给用户，这里只兜底清理（避免双重错误消息）
      console.error("chat task failed:", e);
      endLive();
    } finally {
      runningRef.current.delete(sid);
      delete speedRef.current[sid]; // 速度表随任务结束清零（页眉不再显示 tok/s）
      setSpeedMap((m) => {
        const n = { ...m };
        delete n[sid];
        return n;
      });
      setBusyMap((m) => {
        const n = { ...m };
        delete n[sid];
        return n;
      });
      pumpQueue(sid);
    }
  };

  // 重新生成 / 编辑重发：后端删尾 assistant（可选改写最后一条 user）后只跑模型回合。
  // 本地同步移除尾部 assistant 气泡（编辑时改写最后一条 user 气泡），流式区接棒
  const startRegenerate = async (editText) => {
    const sid = activeRef.current;
    if (!sid || runningRef.current.has(sid) || busyMap[sid]) return;
    setEditResend(null);
    setMessages((msgs) => {
      const n = [...msgs];
      while (n.length && n[n.length - 1].role === "assistant") n.pop();
      if (editText != null) {
        const u = n.map((m) => m.role).lastIndexOf("user");
        if (u >= 0) n[u] = { ...n[u], content: editText };
      }
      return n;
    });
    runningRef.current.add(sid);
    setBusyMap((m) => ({ ...m, [sid]: true }));
    setLiveMap((m) => ({ ...m, [sid]: m[sid] || { text: "", think: "", cards: [] } }));
    const endLive = () =>
      setLiveMap((m) => {
        const n = { ...m };
        delete n[sid];
        return n;
      });
    try {
      const res = await api.regenerateStream(sid, null, handleStreamEvent(sid, endLive), editText ?? null);
      if (activeRef.current === sid && res?.messages) setMessages(res.messages);
      endLive();
      loadSessions();
      onStats?.();
    } catch (e) {
      console.error("regenerate failed:", e);
      endLive();
      loadMessages(sid); // 手术已提交而回合失败：以后端实际历史为准
    } finally {
      runningRef.current.delete(sid);
      delete speedRef.current[sid];
      setSpeedMap((m) => {
        const n = { ...m };
        delete n[sid];
        return n;
      });
      setBusyMap((m) => {
        const n = { ...m };
        delete n[sid];
        return n;
      });
      pumpQueue(sid);
    }
  };

  // ── 等待发送队列 ──
  const setPausedFor = (sid, v) => {
    pausedRef.current = { ...pausedRef.current, [sid]: v };
    setQueuePaused(pausedRef.current);
  };

  const clearQueue = (sid) => {
    const next = { ...queuesRef.current };
    delete next[sid];
    queuesRef.current = next;
    setQueues(next);
  };

  const removeQueueItem = (sid, i) => {
    const next = { ...queuesRef.current, [sid]: (queuesRef.current[sid] || []).filter((_, j) => j !== i) };
    queuesRef.current = next;
    setQueues(next);
  };

  // ── 队列拖拽排序（自实现 mouse 拖拽，兼容 WKWebView）──
  const queueBoxRef = useRef(null);
  useEffect(() => {
    if (dragIdx == null) return;
    const move = (e) => {
      if (!queueBoxRef.current) return;
      const arr = queuesRef.current[activeRef.current] || [];
      // 找到第一个「中点在鼠标右侧」的剩余 pill → 插到它前面；都没有则插到末尾
      let k = arr.length - 1;
      for (const p of queueBoxRef.current.querySelectorAll("[data-qidx]")) {
        const i = Number(p.dataset.qidx);
        if (i === dragIdx) continue;
        const r = p.getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) {
          k = i > dragIdx ? i - 1 : i;
          break;
        }
      }
      // 以移除后的数组为基准：from 移除后插入到 k
      if (k !== dragIdx) {
        const item = arr[dragIdx];
        if (!item) return;
        const next = [...arr];
        next.splice(dragIdx, 1);
        next.splice(k, 0, item);
        const qnext = { ...queuesRef.current, [activeRef.current]: next };
        queuesRef.current = qnext;
        setQueues(qnext);
        setDragIdx(k);
      }
    };
    const up = () => setDragIdx(null);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [dragIdx]);

  // 任务结束后按顺序续发；被中断的会话暂停续发，需手动「继续」。
  // 副作用（setTimeout 启动 runTask）在 updater 外执行，避免 StrictMode 下 updater 双调用导致重复发送
  const pumpQueue = (sid) => {
    if (pausedRef.current[sid]) return;
    if (runningRef.current.has(sid)) return; // 这个会话确有回合在跑：让它结束时再来续发
    if (Date.now() < (busyHoldRef.current[sid] || 0)) return; // 刚被核心回绝过，稍等再试
    const arr = queuesRef.current[sid] || [];
    if (arr.length === 0) return;
    const [next, ...rest] = arr;
    const updated = { ...queuesRef.current, [sid]: rest };
    queuesRef.current = updated;
    setQueues(updated);
    // 这一刻它才真的发出去：从队列派生的"排队中"气泡交给对话流，视觉上不断档
    if (activeRef.current === sid) {
      setMessages((msgs) => [...msgs, { role: "user", content: next.bubble, images: next.imgData }]);
    }
    setTimeout(() => runTask(sid, next), 50);
  };

  const resumeQueue = (sid) => {
    setPausedFor(sid, false);
    pumpQueue(sid);
  };

  // ── 回合真相纠偏 ─────────────────────────────────────────────────────
  // 「哪个会话正在跑」渲染层是自己记的：整页重载、崩溃恢复、事件漏播都会让它和核心失真。
  // 失真的下场最难看——本地以为空闲就直接发，核心一口回绝「该会话已有正在执行的回合」，
  // 而那条回绝只进了 console：用户看见自己的气泡挂在对话里，实际什么都没发出去，也没有提示。
  // 核心那边回合锁（turn_locks）才是这件事的权威出处，这里按它回填忙表，并接力续发队列。
  const syncTurnTruth = async () => {
    const r = await api.getRunningTurns().catch(() => null);
    const ids = r?.ids || [];
    setBusyMap((m) => {
      let changed = false;
      const n = { ...m };
      for (const id of Object.keys(n)) {
        // 只清"本地以为在跑、核心却说没有"的；自己正在 await 的那次以 promise 为准
        if (!ids.includes(id) && !runningRef.current.has(id)) {
          delete n[id];
          changed = true;
        }
      }
      for (const id of ids) {
        if (!n[id]) {
          n[id] = true;
          changed = true;
        }
      }
      return changed ? n : m;
    });
    // 本地和核心都说没在跑、队列里却还压着东西：立刻续发，别让它们烂在队列里
    for (const sid of Object.keys(queuesRef.current)) {
      if ((queuesRef.current[sid] || []).length && !runningRef.current.has(sid) && !ids.includes(sid)) {
        pumpQueue(sid);
      }
    }
    return ids;
  };
  const syncTruthRef = useRef(null);
  syncTruthRef.current = syncTurnTruth;
  // 挂载先对一次账：重载后本地忙表是空的，核心那边可能还跑着上一轮的尾巴
  useEffect(() => {
    syncTruthRef.current?.();
  }, []);
  // 只在"有事要对账"时轮询（本地以为在跑，或队列里还压着没发的），平时一次都不问
  const needTruthSync =
    Object.keys(busyMap).some((k) => busyMap[k]) || Object.keys(queues).some((k) => (queues[k] || []).length > 0);
  useEffect(() => {
    if (!needTruthSync) return undefined;
    const h = setInterval(() => {
      syncTruthRef.current?.();
    }, 2500);
    return () => clearInterval(h);
  }, [needTruthSync]);

  // 立即中断当前会话任务；队列保留并暂停
  const interrupt = async () => {
    if (!activeId) return;
    setPausedFor(activeId, true);
    await api.chatInterrupt(activeId).catch(() => {});
  };

  // ── 工具审批 ──
  const answerApproval = async (id, allow) => {
    setApprovals((arr) => arr.filter((a) => a.id !== id));
    await api.toolApprove(id, allow).catch(() => {});
  };

  // ── ask_user 提问应答：所选选项 + 补充文本回喂模型；同时把回答落入对话气泡 ──
  const submitAsk = async (a) => {
    const picks = askPicks[a.id] || [];
    const text = (askText[a.id] || "").trim();
    if (picks.length === 0 && !text) return; // 没选也没填：不提交
    setAsks((arr) => arr.filter((x) => x.id !== a.id));
    setAskPicks(({ [a.id]: _, ...rest }) => rest);
    setAskText(({ [a.id]: _, ...rest }) => rest);
    const choiceText = picks.map((i) => a.options?.[i]).filter(Boolean).join("、");
    setMessages((msgs) => [
      ...msgs,
      { role: "user", content: [choiceText, text].filter(Boolean).join("\n") },
    ]);
    await api.askAnswer(a.id, picks.map((i) => a.options?.[i]).filter(Boolean), text).catch(() => {});
  };

  const toggleAskPick = (a, idx) => {
    setAskPicks((m) => {
      const cur = m[a.id] || [];
      if (a.allow_multiple) {
        return { ...m, [a.id]: cur.includes(idx) ? cur.filter((i) => i !== idx) : [...cur, idx] };
      }
      return { ...m, [a.id]: cur[0] === idx ? [] : [idx] };
    });
  };

  // ── AI 接收内容预览 ──
  const openPreview = async () => {
    const r = await api.contextPreview(activeId).catch(() => null);
    if (r) {
      setPreview(r);
      setPreviewOpen(true);
    }
  };

  // 手动压缩：AI 把全部历史总结为摘要，释放上下文空间（不阻断会话本身）
  const compress = async () => {
    if (!activeId || compressing || busyMap[activeId]) return;
    setCompressing(true);
    try {
      const r = await api.compressSession(activeId);
      if (activeRef.current === activeId && r?.messages) setMessages(r.messages);
      loadSessions();
      onStats?.();
    } catch (e) {
      // Electron 会把主进程拒绝包成 "Error invoking remote method 'bit:invoke': Error: xxx"，
      // 只把宿主写的中文原因显示给用户
      const raw = String(e?.message || e);
      const clean = raw.match(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s);
      setAttachErr(t("chat.compressFailed") + (clean ? clean[1] : raw));
    } finally {
      setCompressing(false);
    }
  };

  // 会话过滤：标题/id 在前端即时命中，正文命中由 core 回填（sessHits）
  const q = sessQuery.trim().toLowerCase();
  const shownSessions = q
    ? sessions.filter(
        (s) =>
          (s.title || "").toLowerCase().includes(q) ||
          (s.id || "").toLowerCase().includes(q) ||
          !!(sessHits && sessHits[s.id]),
      )
    : sessions;

  // 已有分组名一览：新建/移动时直接点名字复用，不用重复敲
  const allGroupNames = useMemo(
    () =>
      [...new Set(sessions.map((s) => (s.group || "").trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "zh"),
      ),
    [sessions],
  );

  // 侧栏条目：搜索与多选保持平铺（找东西/批量勾选时不能被折叠挡住）；
  // 平时先列未分组会话，再按分组出现顺序列出「组头 + 组内会话」，收起时只留组头
  const sessionEntries = useMemo(() => {
    if (q || multiMode) return shownSessions.map((s) => ({ kind: "s", s }));
    const out = [];
    const groups = new Map();
    for (const s of shownSessions) {
      const g = (s.group || "").trim();
      if (!g) {
        out.push({ kind: "s", s });
        continue;
      }
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    for (const [name, list] of groups) {
      out.push({ kind: "g", name, count: list.length });
      if (!collapsedGroups.has(name)) for (const s of list) out.push({ kind: "s", s });
    }
    return out;
  }, [shownSessions, q, multiMode, collapsedGroups]);

  // 立即搜索（跳过防抖）：搜索按钮与 Enter 走这条
  const runSearch = () => {
    const term = sessQuery.trim().toLowerCase();
    if (!term) {
      setSessHits(null);
      return;
    }
    api.searchSessions(term).then((r) => setSessHits((r && r.hits) || {})).catch(() => {});
  };

  // ===== 对话页这几颗图标按钮 =====
  // 这些节点整颗登记进全站图标空间，所以哪一排（左栏 / 页眉 / 输入框工具栏 / 会话列表底部）画它
  // 都是同一个按钮：点击、弹层、徽标全跟着节点走。浮层用 Popup，自己按视口翻上翻下、左右夹住，
  // 因此拖到贴着窗口下沿的那一排也点得到（见 components/Popup.jsx）。
  // 子代理与设置不在这里各放一颗——页眉状态簇和左栏导航已经有同字形入口了。

  const previewBtn = (
    <button
      onClick={openPreview}
      disabled={!activeId}
      title={t("chat.preview")}
      className={`${TOOL_BTN} text-neutral-500 transition-colors hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-white`}
    >
      <IconEye {...toolIcon("preview")} />
    </button>
  );

  // 网页标签：打开右侧面板并落到地址栏；已有网页标签时直接切回去
  const webBtn = (
    <button
      onClick={() => {
        setPaneOpen(true);
        const webTab = tabs.find((x) => x.kind === "web");
        if (webTab) setActivePath(webTab.path);
        else setWebDraft("");
      }}
      title={t("chat.webNewTab")}
      className={`${TOOL_BTN} text-neutral-500 transition-colors hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white`}
    >
      <IconGlobe {...toolIcon("web")} />
    </button>
  );

  const bgJobsBtn = (    <div className="relative shrink-0">
      <button
        onClick={() => setBgJobsOpen((v) => !v)}
        title={t("chat.bgJobs")}
        className={`relative ${TOOL_BTN} transition-colors ${
          bgJobsOpen
            ? "accent-solid"
            : shellJobs.jobs.length > 0
              ? "bg-sky-500/15 text-sky-600 hover:bg-sky-500/25 dark:text-sky-400"
              : "text-neutral-500 hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
        }`}
      >
        <IconTerminal {...toolIcon("bgjobs")} />
        {shellJobs.jobs.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-sky-500 px-1 text-[9px] font-bold leading-4 text-white">
            {shellJobs.jobs.length}
          </span>
        )}
      </button>
      {bgJobsOpen && (
        <Popup className="card w-80 p-2.5" onDismiss={() => setBgJobsOpen(false)}>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <IconTerminal size={12} />
              {t("chat.bgJobs")}
            </p>
            <span className="text-[10px] text-neutral-400">
              {t("chat.bgJobsCount", { n: shellJobs.jobs.length })}
            </span>
            <button
              onClick={() => setBgJobsOpen(false)}
              title={t("common.close")}
              className="icon-btn h-6 w-6 shrink-0"
            >
              <IconX size={11} />
            </button>
          </div>
          <p className="mb-1.5 text-[11px] leading-relaxed text-neutral-500">{t("chat.bgJobsHint")}</p>
          {shellJobs.jobs.length === 0 ? (
            <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-neutral-400">{t("chat.bgJobsEmpty")}</p>
          ) : (
            <ul className="space-y-1">
              {shellJobs.jobs.map((j) => {
                const s = Math.max(0, Math.floor((shellJobs.now - j.startedAt) / 1000));
                const mm = Math.floor(s / 60);
                const ss = s % 60;
                const dur = mm > 0 ? `${mm}m${ss}s` : `${ss}s`;
                return (
                  <li
                    key={j.job_id}
                    onClick={() => setShellLogJob(j)}
                    className="group flex cursor-pointer items-center gap-1.5 rounded-md bg-neutral-100 px-2 py-1 text-[11px] ring-1 ring-transparent hover:ring-sky-400 dark:bg-neutral-800 dark:hover:ring-sky-600"
                  >
                    <IconTerminal size={11} className="shrink-0 animate-pulse text-sky-500" />
                    <code className="min-w-0 flex-1 truncate font-mono" title={j.command}>
                      {j.command}
                    </code>
                    <span className="shrink-0 tabular-nums text-neutral-400">{dur}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        shellJobs.stopJob(j.job_id);
                      }}
                      disabled={shellJobs.stopping.includes(j.job_id)}
                      title={`${t("chat.stop")} ${j.job_id}`}
                      className="shrink-0 rounded p-0.5 text-neutral-400 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                    >
                      {shellJobs.stopping.includes(j.job_id) ? "…" : <IconStop size={10} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Popup>
      )}
    </div>
  );

  // 附件：图片 / 文档 / 网址 收进一个 + 菜单，减少一排重复图标
  const attachBtn = (
    <div className="relative shrink-0">
      <button
        onClick={() => setAttachMenu((v) => !v)}
        disabled={busy || !activeId}
        title={t("chat.attach")}
        className={`${TOOL_BTN} transition-colors disabled:opacity-40 ${
          attachMenu
            ? "accent-solid"
            : "text-neutral-500 hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
        }`}
      >
        <IconPlus {...toolIcon("attach")} />
      </button>
      {attachMenu && (
        <Popup className="card w-44 p-1" onDismiss={() => setAttachMenu(false)}>
          <button
            onClick={() => {
              setAttachMenu(false);
              imgInput.current?.click();
            }}
            className="w-full rounded-lg px-3 py-1.5 text-left text-xs hover:bg-neutral-900/5 dark:hover:bg-white/10"
          >
            {t("chat.uploadImages")}
          </button>
          <button
            onClick={() => {
              setAttachMenu(false);
              docInput.current?.click();
            }}
            className="w-full rounded-lg px-3 py-1.5 text-left text-xs hover:bg-neutral-900/5 dark:hover:bg-white/10"
          >
            {t("chat.uploadDocs")}
          </button>
          <button
            onClick={() => {
              setAttachMenu(false);
              setUrlOpen(true);
            }}
            className="w-full rounded-lg px-3 py-1.5 text-left text-xs hover:bg-neutral-900/5 dark:hover:bg-white/10"
          >
            {t("chat.addUrl")}
          </button>
        </Popup>
      )}
    </div>
  );

  // 计划/待办：始终显示靶标按钮，点开 popover 查看/管理
  const planBtn = (
    <div className="relative shrink-0">
      <button
        onClick={() => setPlanMenu((v) => !v)}
        title={planVisibleTodos.length > 0 ? `${t("chat.plan")} ${planTodoDone}/${planVisibleTodos.length}` : t("chat.plan")}
        className={`${TOOL_BTN} transition-colors ${
          planMenu
            ? "accent-solid"
            : planAllDone && planVisibleTodos.length > 0
            ? "text-emerald-500 hover:bg-neutral-900/5 dark:hover:bg-white/10"
            : "text-neutral-500 hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
        }`}
      >
        <IconTarget {...toolIcon("plan")} />
      </button>
      {planMenu && (
        <Popup className="card w-72 p-3" onDismiss={() => setPlanMenu(false)}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium">{t("chat.plan")}</span>
            {planVisibleTodos.length > 0 && (
              <span className={`font-mono text-xs ${planAllDone ? "text-emerald-500" : "text-neutral-400"}`}>
                {planTodoDone}/{planVisibleTodos.length}
              </span>
            )}
          </div>
          {planVisibleTodos.length === 0 && planVisibleGoals.length === 0 ? (
            <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-neutral-400">{t("chat.noGoalsTodos")}</p>
          ) : (
            planGroups.map((grp, gi) => {
              const goalDone = grp.goal && grp.goal.status === "achieved";
              return (
                <div key={grp.goal ? grp.goal.id : `loose-${gi}`} className="mb-2 last:mb-0">
                  {grp.goal && (
                    <div
                      className={`flex items-center gap-2 text-[13px] ${
                        goalDone
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-neutral-900 dark:text-neutral-100"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          goalDone
                            ? "bg-emerald-500"
                            : "border border-neutral-400 bg-white dark:border-neutral-400"
                        }`}
                      />
                      <span className="min-w-0 truncate font-medium" title={grp.goal.title}>
                        {grp.goal.title}
                      </span>
                    </div>
                  )}
                  <div className={`space-y-1 ${grp.goal ? "mt-1 pl-4" : ""}`}>
                    {grp.todos.map((td) => {
                      const done = td.status === "completed";
                      const overdue = todoClock && isTodoOverdue(td);
                      return (
                        <div
                          key={td.id}
                          className={`flex items-center gap-2 text-xs ${
                            done
                              ? "text-emerald-600/80 dark:text-emerald-400/80"
                              : "text-neutral-600 dark:text-neutral-300"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              done
                                ? "bg-emerald-500"
                                : "border border-neutral-400 bg-white dark:border-neutral-400"
                            }`}
                          />
                          {/* 待办时钟：计划执行时间（到点未完成标红，沿用行文字中性色系） */}
                          {todoClock && td.scheduled_at && (
                            <span
                              className={`flex shrink-0 items-center gap-1 ${
                                overdue ? "text-red-500" : ""
                              }`}
                              title={
                                overdue
                                  ? `${t("chat.todoOverdue")} · ${td.scheduled_at}`
                                  : td.scheduled_at
                              }
                            >
                              <IconClock size={12} />
                              {todoHM(td.scheduled_at)}
                            </span>
                          )}
                          <span className="min-w-0 truncate" title={td.content}>
                            {td.content}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </Popup>
      )}
    </div>
  );

  // 语音输入：本地离线转写；是否显示由 localStorage bit.voiceInput 控制（设置页切换）。
  // 被插件接管时整颗话筒让位：插件用 chat_icons 放自己的语音入口。
  const micVisible = voiceOn && !micTaken;
  const voiceBtn = micVisible ? (
    <button
      onClick={toggleVoice}
      disabled={!activeId || transcribing || downloading}
      title={
        recording
          ? t("chat.voiceStop")
          : transcribing
          ? t("chat.voiceTranscribing")
          : downloading
          ? voiceDl.total
            ? t("voice.downloading", { p: Math.round((voiceDl.done / voiceDl.total) * 100) })
            : t("voice.downloadStart")
          : t("chat.voiceStart")
      }
      className={`relative ${TOOL_BTN} transition-colors disabled:opacity-40 ${
        recording
          ? "bg-red-500/15 text-red-500 ring-1 ring-red-500/60"
          : "text-neutral-500 hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
      }`}
    >
      {transcribing ? (
        <span className="block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <IconMic {...toolIcon("voice")} />
      )}
      {recording && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500" />}
    </button>
  ) : null;

  // ===== 把当前输入收藏为提示词模板 =====
  // 三个入口共用：星标右键、星标长按、快捷键（默认 Ctrl+A+S）。
  // 模板列表以落库为准每次重读，避免设置页刚改过、这里的 state 还是旧的
  const addInputAsTemplate = async () => {
    if (tplBusy.current) return;
    tplBusy.current = true;
    try {
      const raw = input;
      const text = raw.trim();
      if (!text) {
        flashVoiceHint(t("chat.tplEmpty"), "err");
        return;
      }
      let list = [];
      try {
        const r = await api.promptTemplatesGet();
        list = Array.isArray(r?.templates) ? r.templates : [];
      } catch (e) {
        flashVoiceHint(t("chat.tplFail", { msg: String(e?.message || e) }), "err");
        return;
      }
      if (list.some((x) => String(x?.text || "").trim() === text)) {
        flashVoiceHint(t("chat.tplDup"), "err");
        return;
      }
      const firstLine = (text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || t("chat.tplUntitled")).replace(/\s+/g, " ");
      const title = firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
      const id = `tpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const next = [{ id, title, text: raw }, ...list];
      try {
        const r = await api.promptTemplatesSet(next);
        setTemplates(Array.isArray(r?.templates) ? r.templates : next);
        flashVoiceHint(t("chat.tplSaved", { title }));
      } catch (e) {
        flashVoiceHint(t("chat.tplFail", { msg: String(e?.message || e) }), "err");
      }
    } finally {
      tplBusy.current = false;
    }
  };
  tplAddRef.current = addInputAsTemplate;

  // 快捷键：设置页改完广播 bit-tpl-hotkey，这里即时换掉解析结果，不用重启
  useEffect(() => {
    const sync = () => setTplHotkeySpec(readTplHotkey().spec);
    window.addEventListener("bit-tpl-hotkey", sync);
    return () => window.removeEventListener("bit-tpl-hotkey", sync);
  }, []);

  // 序列快捷键监听：拿当前生效写法，跨 keydown 记录按到第几键。
  // 焦点在别的输入框 / 设置项里时不抢（只认对话输入框和页面空白处）
  useEffect(() => {
    const seq = { n: 0, at: 0 };
    let parsed = parseTplHotkey(readTplHotkey().spec);
    const sync = () => {
      parsed = parseTplHotkey(readTplHotkey().spec);
      seq.n = 0;
    };
    window.addEventListener("bit-tpl-hotkey", sync);
    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const el = e.target;
      const editable = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (editable && el !== inputRef.current) return;
      if (matchTplSequence(e, parsed, seq)) {
        e.preventDefault();
        tplAddRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("bit-tpl-hotkey", sync);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => () => clearTimeout(tplPress.current.timer), []);

  // 长按星标：550ms 内不松手即收藏；按住后挪动超过 6px 或开始拖拽就取消，别和换位拖拽打架
  const cancelTplPress = () => clearTimeout(tplPress.current.timer);
  const startTplPress = (e) => {
    if (e.button !== 0) return;
    tplPress.current.x = e.clientX;
    tplPress.current.y = e.clientY;
    tplPress.current.fired = false;
    cancelTplPress();
    tplPress.current.timer = setTimeout(() => {
      tplPress.current.fired = true;
      addInputAsTemplate();
    }, 550);
  };
  const moveTplPress = (e) => {
    if (Math.abs(e.clientX - tplPress.current.x) > 6 || Math.abs(e.clientY - tplPress.current.y) > 6) cancelTplPress();
  };

  // 提示词模板：点选一键插入输入框（列表在 AI 设置维护）
  const templateBtn = (
    <div className="relative shrink-0">
      <button
        onClick={() => {
          // 长按已经收藏过了，松手带来的这次 click 只负责收尾，不再弹层
          if (tplPress.current.fired) {
            tplPress.current.fired = false;
            return;
          }
          if (!tplOpen) api.promptTemplatesGet().then((r) => setTemplates(r?.templates || [])).catch(() => {});
          setTplOpen((v) => !v);
        }}
        onContextMenu={(e) => {
          // 右键收藏：拦在图标排之前，否则会弹出「把这个图标摘掉」菜单
          e.preventDefault();
          e.stopPropagation();
          cancelTplPress();
          addInputAsTemplate();
        }}
        onPointerDown={startTplPress}
        onPointerMove={moveTplPress}
        onPointerUp={cancelTplPress}
        onPointerLeave={cancelTplPress}
        onPointerCancel={cancelTplPress}
        onDragStart={cancelTplPress}
        disabled={!activeId}
        title={t("chat.templatesHint")}
        className={`${TOOL_BTN} transition-colors disabled:opacity-40 ${
          tplOpen
            ? "accent-solid"
            : "text-neutral-500 hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
        }`}
      >
        <IconStar {...toolIcon("template")} />
      </button>
      {tplOpen && (
        <Popup className="card w-72 p-1.5" onDismiss={() => setTplOpen(false)}>
          <p className="mb-1 border-b border-neutral-200 px-2 pb-1.5 pt-0.5 text-[10px] leading-relaxed text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
            {t("chat.tplFoot", { key: formatTplHotkey(tplHotkeySpec) })}
          </p>
          {templates.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-neutral-400">{t("chat.templatesEmpty")}</p>
          ) : (
            templates.map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => {
                  setInput((v) => (v ? v + (/\s$/.test(v) ? "" : " ") + tpl.text : tpl.text));
                  setTplOpen(false);
                  inputRef.current?.focus();
                }}
                className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-neutral-900/5 dark:hover:bg-white/10"
              >
                <span className="block truncate font-medium">{tpl.title}</span>
                {tpl.text && <span className="mt-0.5 block truncate text-neutral-400 dark:text-neutral-500">{tpl.text}</span>}
              </button>
            ))
          )}
        </Popup>
      )}
    </div>
  );

  // 插件登记的图标（清单 chat_icons + chaticon 权限）：和内置图标同桌、同规则。
  // action=page → 跳该插件的独立页或设置中心条目；解析不到落点就点不动（标题说明原因）。
  // action=prompt → 把预设文字追加进输入框并聚焦，不离开对话页。
  // 不用 disabled：置灰靠样式，按钮仍可点——真 disabled 会把整个节点变成拖不动的死块。
  const pluginIconBtns = {};
  for (const ic of pluginIcons) {
    const isPrompt = ic.action === "prompt";
    const target = isPrompt ? null : resolvePluginIconTarget(ic, pluginPagesReg, pluginSettings.cards);
    const dead = !isPrompt && !target;
    const label = lang === "en" && ic.label_en ? ic.label_en : ic.label;
    pluginIconBtns[ic.key] = (
      <button
        aria-disabled={dead || undefined}
        title={dead ? t("chat.pluginIconNoPage", { name: ic.plugin_name }) : `${ic.plugin_name} · ${label}`}
        onClick={() => {
          if (dead) return;
          if (isPrompt) {
            setInput((v) => (v ? v + (/\s$/.test(v) ? "" : " ") + ic.text : ic.text));
            inputRef.current?.focus();
            return;
          }
          window.dispatchEvent(new CustomEvent("bit-open-page", { detail: target }));
        }}
        className={`${TOOL_BTN} transition-colors ${
          dead
            ? "cursor-not-allowed text-neutral-300 dark:text-neutral-600"
            : "text-neutral-500 hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
        }`}
      >
        <PluginChatGlyph paths={ic.paths} />
      </button>
    );
  }

  // ===== 布局渲染与拖拽 =====
  const toolNodes = {
    preview: previewBtn,
    attach: attachBtn,
    plan: planBtn,
    voice: voiceBtn,
    template: templateBtn,
    web: webBtn,
    bgjobs: bgJobsBtn,
    ...pluginIconBtns,
  };
  // 带前缀的 id -> 节点 / 默认区，登记进全站图标空间：左栏、页眉也能画出对话页这些图标
  const chatIds = toolIds.map((id) => CHAT_PREFIX + id);
  const chatNodes = {};
  const chatHomes = {};
  for (const id of toolIds) {
    const cid = CHAT_PREFIX + id;
    chatNodes[cid] = toolNodes[id];
    chatHomes[cid] = TOOL_HOME_ZONE;
  }
  useIconSurface("chat", { ids: chatIds, homes: chatHomes, nodes: chatNodes, labels: {} });
  const ftIds = tools.order("chatFooter");

  // 消息气泡动作走 ref 间接调用：回调引用保持稳定，memo 气泡不会因为输入框每次敲字
  // 产生的父组件重渲染而整体重绘（长会话下这是输入卡顿的主因）
  const bubbleActions = useRef({});
  bubbleActions.current = { openTab, startRegenerate, branchSession, rollbackSession, setEditResend, fileMenu };
  const bubbleCb = useMemo(
    () => ({
      onPreview: (p) => bubbleActions.current.openTab(p),
      onFileMenu: (f) => bubbleActions.current.fileMenu.open(f),
      onRegenerate: () => bubbleActions.current.startRegenerate(null),
      onEdit: (text) => bubbleActions.current.setEditResend({ text }),
      onBranch: (index) => bubbleActions.current.branchSession(index),
      onRollback: (index) => bubbleActions.current.rollbackSession(index),
    }),
    []
  );
  // 主题切换由 AppShell 重渲染带动本页，把它显式传给气泡：memo 后 DiagramCard/Mermaid 不会漏更新
  const darkMode = typeof document !== "undefined" && document.documentElement.classList.contains("dark");

  return (
    <div className="relative flex h-full gap-2">
      {/* 拖拽文件 / 文件夹提示遮罩 */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-400 bg-neutral-500/10 dark:border-neutral-500">
          <div className="card px-6 py-4 text-sm font-medium">{t("chat.dropHint")}</div>
        </div>
      )}
      {/* 文件右键菜单与详情弹窗挂在这一层的末尾：菜单是 fixed 定位，
          放进输入区里会被带 transform/遮罩的祖先影响坐标，放在根上最稳 */}
      {fileMenu.node()}
      {fileMenu.detailNode()}
      {/* 会话侧栏：纯文字列表，可折叠（收起/展开入口在最左侧功能栏） */}
      {sidebarOpen && (
      <div className="anim-rise flex w-52 shrink-0 flex-col gap-1.5">
        {/* 会话操作条：收起/多选入口已移至最左侧功能栏；这里仅多选态下显示 全选 / 批量删除 / 完成 */}
        {multiMode && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 px-1">
            <button
              onClick={toggleSelectAll}
              className="rounded-full px-2 py-1 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
            >
              {allSelected ? t("chat.unselectAll") : t("common.selectAll")}
            </button>
            <button
              onClick={batchDelete}
              disabled={selSet.size === 0}
              title={t("common.deleteSelected")}
              className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconTrash size={11} />
              {t("common.deleteSelected")}
              {selSet.size > 0 && `(${selSet.size})`}
            </button>
            <button
              onClick={exitMulti}
              className="ml-auto rounded-full px-2 py-1 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-900/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
            >
              {t("chat.multiDone")}
            </button>
          </div>
        )}
        {multiMode && (
          <p
            className={`px-1 text-[10px] leading-snug ${
              batchHint ? "text-amber-500" : "text-neutral-400 dark:text-neutral-500"
            }`}
          >
            {batchHint || t("chat.multiHint")}
          </p>
        )}

        {/* 会话搜索：列表一长就只能滚动找，这里按标题/ id / 正文过滤。
            与设置中心左栏同一套无框行：图标 + 透明输入，不再套一层圆角输入框和独立按钮 */}
        {sessions.length > 0 && (
          <SearchBox
            className="shrink-0 px-2 py-1.5"
            value={sessQuery}
            onChange={(v) => {
              // 搜索时列表拍平、分组头消失，挂着的配色面板就无处可挂
              setGroupColorFor(null);
              setSessQuery(v);
            }}
            onEnter={runSearch}
            onClear={() => {
              setGroupColorFor(null);
              setSessQuery("");
            }}
            placeholder={t("chat.searchSessions")}
            clearTitle={t("chat.clearSearch")}
          />
        )}
        {q && (
          <p className="shrink-0 px-1 text-[10px] text-neutral-400 dark:text-neutral-500">
            {shownSessions.length} / {sessions.length}
          </p>
        )}

        <div className="flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden">
          {sessions.length === 0 && (
            <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-neutral-400">{t("chat.noSessions")}</div>
          )}
          {q && shownSessions.length === 0 && (
            <div className="px-2 py-4 text-center text-xs text-neutral-400 dark:text-neutral-500">{t("chat.noMatch")}</div>
          )}
          {sessionEntries.map((entry) => {
            // 分组头：整行点击折叠/展开，悬停露出配色、改名与解散
            if (entry.kind === "g") {
              const name = entry.name;
              const collapsed = collapsedGroups.has(name);
              const gcolor = (groupColors[name] || "").trim();
              return (
                <div key={`g:${name}`} className="group relative px-0.5 pt-1">
                  <div className="relative flex items-center gap-1 rounded-xl px-1.5 py-1 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-900/5 dark:text-neutral-400 dark:hover:bg-white/5">
                    {/* 分组色的左侧小色条：圆角行里用 inset 阴影会只剩一道月牙，改成独立竖条更干净 */}
                    {gcolor && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0 top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-full"
                        style={{ background: gcolor }}
                      />
                    )}
                    {groupRenaming?.name === name ? (
                      <input
                        autoFocus
                        value={groupRenaming.value}
                        maxLength={40}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setGroupRenaming({ name, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitGroupRename();
                          if (e.key === "Escape") setGroupRenaming(null);
                        }}
                        onBlur={submitGroupRename}
                        className="min-w-0 flex-1 rounded bg-white/60 px-1 text-[12px] text-neutral-800 outline-none select-text dark:bg-black/40 dark:text-neutral-100"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleGroup(name)}
                        title={collapsed ? t("chat.groupExpand") : t("chat.groupCollapse")}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                      >
                        <IconChevronRight
                          size={11}
                          className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
                        />
                        <IconFolder
                          size={12}
                          className={`shrink-0 ${gcolor ? "" : "text-amber-500/80 dark:text-amber-400/80"}`}
                          style={gcolor ? { color: gcolor } : undefined}
                        />
                        <span className="truncate">{name}</span>
                        <span
                          className="shrink-0 text-[10px] font-normal text-neutral-400 dark:text-neutral-500"
                          title={t("chat.groupCount", { n: entry.count })}
                        >
                          {entry.count}
                        </span>
                      </button>
                    )}
                    {groupRenaming?.name !== name && (
                      // 透明时让出指针事件，避免点到看不见的按钮把分组改乱
                      <div className="pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                        <button
                          title={t("chat.groupColor")}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (groupColorFor === name) {
                              setGroupColorFor(null);
                              return;
                            }
                            setGroupFor(null);
                            setColorFor(null);
                            setGroupColorFor(name);
                          }}
                          className="rounded p-0.5 hover:bg-neutral-900/10 dark:hover:bg-white/10"
                        >
                          <IconDroplet
                            size={11}
                            className={gcolor ? "" : "text-neutral-400 dark:text-neutral-500"}
                            style={gcolor ? { color: gcolor } : undefined}
                          />
                        </button>
                        <button
                          title={t("chat.groupRename")}
                          onClick={(e) => {
                            e.stopPropagation();
                            setGroupRenaming({ name, value: name });
                          }}
                          className="rounded p-0.5 hover:bg-neutral-900/10 dark:hover:bg-white/10"
                        >
                          <IconEdit size={11} />
                        </button>
                        <button
                          title={t("chat.groupDissolve")}
                          onClick={(e) => {
                            e.stopPropagation();
                            dissolveGroup(name);
                          }}
                          className="rounded p-0.5 hover:bg-neutral-900/10 dark:hover:bg-white/10"
                        >
                          <IconX size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                  {/* 分组配色：与会话右滑出来的标签共用一套色板 */}
                  {groupColorFor === name && groupRenaming?.name !== name && (
                    <div
                      onMouseDown={(e) => e.stopPropagation()}
                      style={gcolor ? { borderColor: gcolor } : undefined}
                      className="swatch-in mx-0.5 mb-1 mt-0.5 rounded-2xl border border-neutral-200 bg-white p-2 shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[10px] font-medium text-neutral-500 dark:text-neutral-300">
                          {t("chat.groupColor")}
                        </span>
                        <div className="flex items-center gap-2">
                          {gcolor && (
                            <button
                              onClick={() => setGroupColor(name, "")}
                              className="text-[10px] text-neutral-400 hover:text-red-500"
                            >
                              {t("chat.colorClear")}
                            </button>
                          )}
                          <button
                            onClick={() => setGroupColorFor(null)}
                            title={t("common.close")}
                            className="icon-btn h-6 w-6 shrink-0"
                          >
                            <IconX size={11} />
                          </button>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {TAG_COLORS.map((c) => (
                          <button
                            key={c}
                            onClick={() => setGroupColor(name, c)}
                            title={c}
                            className={`h-[18px] w-[18px] rounded-full ${
                              gcolor === c ? "ring-2 ring-neutral-900/40 ring-offset-1 dark:ring-white/50" : ""
                            }`}
                            style={{ background: c }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            }
            const s = entry.s;
            const pluginRow = isPluginSession(s.id);
            // 谁开的这轮对话：显示名来自插件名表，查不到（插件已删/停用且表里没留档）退回包名
            const pluginBy = pluginRow ? pluginNames[pluginIdOf(s.id)] || pluginIdOf(s.id) : "";
            const grouped = !q && !multiMode && !!(s.group || "").trim(); // 组内行缩进，和组头分层
            const rowGroupColor = grouped ? (groupColors[(s.group || "").trim()] || "") : "";
            const active = s.id === activeId;
            const selected = selSet.has(s.id);
            const colored = !!s.color && !multiMode;
            const swiping = swipe.id === s.id; // 正在被右滑的这行：跟手位移 + 露出底色
            const hit = sessHits ? sessHits[s.id] : null;
            return (
              <div key={s.id} className={`relative ${grouped ? "ml-2" : ""}`}>
                {/* 右滑露出的底色区：填这个会话的标签色；没打过色就用主色示意"这里能滑出颜色" */}
                {swiping && (
                  <div
                    className="absolute inset-0 flex items-center rounded-xl pl-3"
                    style={{ background: s.color || "var(--accent)" }}
                  >
                    <span className="h-2.5 w-2.5 rounded-full bg-white/85" />
                  </div>
                )}
                <div
                  onClick={() => onRowClick(s.id)}
                  onMouseDown={(e) => startRowDrag(e, s.id)}
                  style={
                    swiping
                      ? { transform: `translateX(${swipe.x}px)`, transitionProperty: "none", boxShadow: "0 3px 12px rgba(0,0,0,.14)" }
                      : colored
                        ? { boxShadow: `inset 3px 0 0 ${s.color}` }
                        : undefined
                  }
                  className={`anim-rise group flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 transition-all duration-200 select-none hover:translate-x-0.5 ${
                    swiping ? "bg-white dark:bg-neutral-900" : ""
                  } ${
                    multiMode
                      ? selected
                        ? "accent-solid"
                        : busyMap[s.id]
                          ? "cursor-default text-neutral-400 opacity-60"
                          : "text-neutral-600 hover:bg-neutral-900/5 dark:text-neutral-300 dark:hover:bg-white/5"
                      : active
                        ? "accent-solid"
                        : "text-neutral-600 hover:bg-neutral-900/5 dark:text-neutral-300 dark:hover:bg-white/5"
                  }`}
                >
                  {multiMode ? (
                    busyMap[s.id] ? (
                      <span
                        title={t("chat.skipBusy")}
                        className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-emerald-500 ring-2 ring-emerald-500/30"
                      />
                    ) : (
                      <span className="flex shrink-0 items-center gap-1">
                        {s.favorite && <IconStarSolid size={10} className="text-amber-400" />}
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded-md border ${
                            selected
                              ? "border-transparent bg-amber-400 text-white"
                              : "border-neutral-300 dark:border-neutral-600"
                          }`}
                        >
                          {selected && <IconCheck size={10} strokeWidth={3} />}
                        </span>
                      </span>
                    )
                  ) : (
                    <>
                      {pluginRow ? (
                        <IconPuzzle
                          size={14}
                          title={t("chat.pluginSession", { id: pluginIdOf(s.id) })}
                          className={`shrink-0 ${busyMap[s.id] ? "hidden" : ""} ${
                            colored ? "opacity-100" : "opacity-70"
                          }`}
                          style={colored ? { color: s.color } : undefined}
                        />
                      ) : (
                        <IconChat
                          size={14}
                          className={`shrink-0 ${busyMap[s.id] ? "hidden" : ""} ${
                            colored ? "opacity-100" : "opacity-70"
                          }`}
                          style={colored ? { color: s.color } : undefined}
                        />
                      )}
                      {busyMap[s.id] && (
                        <span
                          title={t("chat.running")}
                          className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-emerald-500 ring-2 ring-emerald-500/30"
                        />
                      )}
                      {s.favorite && (
                        <IconStarSolid
                          size={10}
                          className={`shrink-0 text-amber-400 ${active ? "dark:text-amber-300" : ""}`}
                        />
                      )}
                    </>
                  )}
                  {renaming?.id === s.id ? (
                    <input
                      autoFocus
                      value={renaming.title}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={submitRename}
                      className="min-w-0 flex-1 rounded bg-white/20 px-1 text-[13px] outline-none select-text dark:bg-black/20"
                    />
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-[13px] font-medium"
                        title={pluginRow ? `${s.title} · ${t("chat.pluginSession", { id: pluginIdOf(s.id) })}` : s.preview || s.title}
                      >
                        {s.title || t("chat.newChat")}
                      </div>
                      {/* 正文命中时补一行片段，说明"这条为什么被搜出来" */}
                      {hit && hit.snippet && (
                        <div
                          className="truncate text-[10px] leading-tight text-neutral-400 dark:text-neutral-500"
                          title={hit.snippet}
                        >
                          …{hit.snippet}
                        </div>
                      )}
                    </div>
                  )}
                  {!multiMode && renaming?.id !== s.id && (
                    // 未悬停时按钮虽透明仍在布局里，必须让出指针事件，否则点行中间会误触看不见的按钮
                    <div className="pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                      <button
                        title={t("chat.groupMove")}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (groupFor === s.id) {
                            setGroupFor(null);
                            return;
                          }
                          setColorFor(null);
                          setGroupColorFor(null);
                          setNewGroupName("");
                          setGroupFor(s.id);
                        }}
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                          grouped
                            ? rowGroupColor
                              ? ""
                              : "text-amber-500"
                            : active
                              ? "hover:bg-white/20 dark:hover:bg-black/20"
                              : "hover:bg-neutral-900/10 dark:hover:bg-white/10"
                        }`}
                        style={rowGroupColor ? { color: rowGroupColor } : undefined}
                      >
                        <IconFolder size={12} />
                      </button>
                      <button
                        title={s.favorite ? t("chat.favRemove") : t("chat.favAdd")}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(s.id);
                        }}
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                          s.favorite
                            ? "text-amber-400"
                            : active
                              ? "hover:bg-white/20 dark:hover:bg-black/20"
                              : "text-neutral-300 hover:text-amber-400 dark:text-neutral-600 dark:hover:text-amber-400"
                        }`}
                      >
                        {s.favorite ? <IconStarSolid size={12} /> : <IconStar size={12} />}
                      </button>
                      <button
                        title={t("chat.rename")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ id: s.id, title: s.title || "" });
                        }}
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${active ? "hover:bg-white/20 dark:hover:bg-black/20" : "hover:bg-neutral-900/10 dark:hover:bg-white/10"}`}
                      >
                        <IconEdit size={12} />
                      </button>
                      <button
                        title={t("common.delete")}
                        onClick={(e) => deleteSession(s.id, e)}
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${active ? "hover:bg-white/20 dark:hover:bg-black/20" : "hover:bg-neutral-900/10 dark:hover:bg-white/10"}`}
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                  )}
                </div>
                {/* 右滑对话召出的彩色标签调色板 */}
                {colorFor === s.id && (
                  <div
                    onMouseDown={(e) => e.stopPropagation()}
                    style={
                      s.color
                        ? { borderColor: s.color, boxShadow: `inset 3px 0 0 ${s.color}` }
                        : undefined
                    }
                    className="swatch-in mt-0.5 rounded-2xl border border-neutral-200 bg-white p-2 shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[10px] font-medium text-neutral-500 dark:text-neutral-300">
                        {t("chat.colorTitle")}
                      </span>
                      <div className="flex items-center gap-2">
                        {s.color && (
                          <button
                            onClick={() => setTagColor(s.id, "")}
                            className="text-[10px] text-neutral-400 hover:text-red-500"
                          >
                            {t("chat.colorClear")}
                          </button>
                        )}
                        <button
                          onClick={() => setColorFor(null)}
                          title={t("common.close")}
                          className="icon-btn h-6 w-6 shrink-0"
                        >
                          <IconX size={11} />
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {TAG_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => setTagColor(s.id, c)}
                          title={c}
                          className={`h-[18px] w-[18px] rounded-full ${
                            s.color === c ? "ring-2 ring-neutral-900/40 ring-offset-1 dark:ring-white/50" : ""
                          }`}
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {/* 行内「移到分组」面板：点已有组名直接归入，或在输入框里敲一个新组名 */}
                {groupFor === s.id && (
                  <div
                    onMouseDown={(e) => e.stopPropagation()}
                    className="swatch-in mt-0.5 rounded-2xl border border-neutral-200 bg-white p-2 shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="flex items-center gap-1 text-[10px] font-medium text-neutral-500 dark:text-neutral-300">
                        <IconFolder size={11} className="text-amber-500/80 dark:text-amber-400/80" />
                        {t("chat.groupMove")}
                      </span>
                      <button
                        onClick={() => setGroupFor(null)}
                        title={t("common.close")}
                        className="icon-btn h-6 w-6 shrink-0"
                      >
                        <IconX size={11} />
                      </button>
                    </div>
                    {(allGroupNames.length > 0 || grouped) && (
                      <div className="flex flex-wrap gap-1">
                        {allGroupNames.map((g) => (
                          <button
                            key={g}
                            onClick={() => moveSessionToGroup(s.id, g)}
                            disabled={g === (s.group || "").trim()}
                            title={g}
                            className={`max-w-full truncate rounded-full border px-2 py-0.5 text-[10px] ${
                              g === (s.group || "").trim()
                                ? "border-amber-400/60 bg-amber-400/15 text-amber-600 dark:text-amber-300"
                                : "border-neutral-200 text-neutral-600 hover:border-amber-400/60 hover:text-amber-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:text-amber-300"
                            }`}
                          >
                            {g}
                          </button>
                        ))}
                        {grouped && (
                          <button
                            onClick={() => moveSessionToGroup(s.id, "")}
                            className="rounded-full border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-500 hover:border-red-300 hover:text-red-500 dark:border-neutral-700 dark:text-neutral-400"
                          >
                            {t("chat.groupUngroup")}
                          </button>
                        )}
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center gap-1">
                      <input
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") createGroupWith(s.id);
                          if (e.key === "Escape") setGroupFor(null);
                        }}
                        placeholder={t("chat.groupNewPlaceholder")}
                        maxLength={40}
                        className="field min-w-0 flex-1 px-2 py-0.5 text-[11px]"
                        style={{ borderRadius: "var(--look-ui-radius, 1rem)" }}
                      />
                      <button
                        onClick={() => createGroupWith(s.id)}
                        disabled={!newGroupName.trim()}
                        title={t("chat.groupCreate")}
                        className="icon-btn h-6 w-6 shrink-0 accent-solid disabled:opacity-40"
                      >
                        <IconPlus size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* 底部工具区：会话列表下方常年空白，图标可拖到这里（折叠侧栏时并回输入框工具栏）。
            出厂态是空的（图标默认都在输入框那一排），拖空之后这一排仍要能接住拖拽，
            所以留 min-height + 一句落位提示。侧栏只有 208px 宽：只排一行，放不下的收进「⋯」。
            这一排贴窗口下沿，图标自带的弹层由 Popup 自己翻向，不再往下开出屏。 */}
        <IconRow
          layout={tools}
          zone="chatFooter"
          nodes={chatNodes}
          className="min-h-[36px] shrink-0 pt-1"
          maxLines={1}
          popClass="bottom-8 right-0 w-52"
          fitPx={TOOL_PX}
        >
          {ftIds.filter((id) => iconNode(id) || chatNodes[id]).length === 0 && (
            <span className="px-1 text-[10px] leading-tight text-neutral-400 dark:text-neutral-500">{t("chat.toolsHere")}</span>
          )}
        </IconRow>
      </div>
      )}

      {/* 对话主区：无标题行，主体完全留给消息 */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* 外层承载专属背景（panel-chat 伪元素不随滚动），overflow 挪到内层滚动容器 */}
        <div className="panel-surface panel-chat card relative flex-1 overflow-hidden">
        {/* 操作反馈浮层：分支/回退等提示原来只挂在多选栏，普通对话里看不到 */}
        {batchHint && !multiMode && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-neutral-200 bg-white/95 px-3 py-1 text-xs text-neutral-700 shadow-sm dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-200">
            {batchHint}
          </div>
        )}
        <div className="h-full select-text overflow-y-auto">
          {messages.length === 0 && !busy && (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-neutral-400">
              {t("chat.emptyHint")}
            </div>
          )}
          {/* 消息列随容器宽度自适应：不设固定限宽，宽窗口下气泡自然拉满卡片宽度 */}
          <div className="flex w-full flex-col gap-3 px-1">
            {(() => {
              // QQ 式时间分割线：相邻两条消息（带时间戳的）间隔 ≥5 分钟时，
              // 在后一条上方画一条居中时间线，方便回看历史定位时间点。
              // 旧会话消息无 ts 字段 → 不画线，自然兼容。
              let lastTs = null;
              const fmt = (ts) => {
                const d = new Date(ts.replace(" ", "T"));
                if (Number.isNaN(d.getTime())) return ts;
                const now = new Date();
                const sameDay = d.toDateString() === now.toDateString();
                const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
                return sameDay
                  ? hm
                  : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
              };
              // 最后一条 assistant / user 的下标：重新生成、编辑重发按钮只挂在这两条上
              const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");
              const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
              // 回退窗口下界：只有最近 10 条能回退，且这条之后必须还有内容
              const rollbackFloor = Math.max(0, messages.length - ROLLBACK_WINDOW);
              return messages.map((m, i) => {
                // 对话开头（此前没有带时间戳的消息）不画线；间隔 ≥5 分钟才画
                const showDivider =
                  m.ts && lastTs !== null && new Date(m.ts.replace(" ", "T")) - new Date(lastTs.replace(" ", "T")) >= 5 * 60 * 1000;
                if (m.ts) lastTs = m.ts;
                return (
                  <Fragment key={i}>
                    {showDivider && (
                      <div className="my-1 flex items-center gap-3">
                        <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-700" />
                        <span className="shrink-0 text-[11px] text-neutral-400">{fmt(m.ts)}</span>
                        <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-700" />
                      </div>
                    )}
                    {m.role === "system" ? (
                      // 压缩摘要：上方历史已被这条 system 消息取代，点开看摘要正文
                      <CompressedDivider content={m.content} />
                    ) : (
                      <MessageBubble
                        message={m}
                        index={i}
                        dark={darkMode}
                        {...bubbleCb}
                        canRegenerate={!busy && i === lastAssistantIdx}
                        canEdit={!busy && i === lastUserIdx}
                        canBranch={!busy && !!activeId}
                        canRollback={!busy && !!activeId && i < messages.length - 1 && i >= rollbackFloor}
                      />
                    )}
                  </Fragment>
                );
              });
            })()}
            {/* 排队中的消息：直接由队列派生（不写进 messages）。
                这样摘掉 pill 它就消失、拖拽改了序它跟着换位置、切会话再回来也不会一半有一半没有。 */}
            {(queues[activeId] || []).map((q, i) => (
              <MessageBubble
                key={`pend-${i}`}
                message={{ role: "user", content: q.bubble, images: q.imgData || [] }}
                index={-1}
                dark={darkMode}
                pending={{ onRemove: () => removeQueueItem(activeId, i) }}
                {...bubbleCb}
                canRegenerate={false}
                canEdit={false}
                canBranch={false}
                canRollback={false}
              />
            ))}
            {/* 流式实时区：已完成轮次的工具卡片 + 本轮增量文本 */}
            {live && (
              <div className="mr-auto flex max-w-[85%] flex-col gap-2">
                {live.cards.map((c, i) => {
                  const fileCalls = (c.calls || []).filter((x) => x.tool === "send_file" && x.ok);
                  const toolCalls = (c.calls || []).filter((x) => !(x.tool === "send_file" && x.ok));
                  return (
                    <div key={i} className="flex flex-col gap-2">
                      {/* 执行中占位卡（round_tools_starting 事件先渲染，tools 事件替换） */}
                      {c.pending && (!c.calls || c.calls.length === 0) && (
                        <div className="flex flex-col gap-1.5">
                          {c.pending.map((p, j) => (
                            <PendingToolCard key={j} tool={p.tool} summary={p.summary} />
                          ))}
                        </div>
                      )}
                      {toolCalls.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          {toolCalls.map((call, j) => (
                            <ToolCallCard key={j} call={call} />
                          ))}
                        </div>
                      )}
                      {c.visible && c.visible.trim() && (
                        <div className="rounded-[var(--look-ui-radius,1.5rem)] rounded-bl-lg border border-neutral-200 bg-white px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-900">
                          <Markdown>{c.visible}</Markdown>
                        </div>
                      )}
                      {/* 文件卡片放在说明文字之后：先说话后发文件 */}
                      {fileCalls.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          {fileCalls.map((call, j) => (
                            <FileCard
                              key={j}
                              path={call.params?.path}
                              bytes={call.result?.bytes}
                              note={call.params?.note}
                              onContextMenu={fileMenu.open(fileFromPath(call.params?.path, call.result?.bytes))}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* 本轮思考过程实时展示（默认展开，流式中） */}
                {live.think && live.think.trim() && <ThinkPanel text={live.think} openDefault streaming />}
                {live.text ? (
                  <div className="rounded-[var(--look-ui-radius,1.5rem)] rounded-bl-lg border border-neutral-200 bg-white px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-900">
                    <Markdown>{live.text}</Markdown>
                    <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-neutral-900 align-middle dark:bg-white" />
                  </div>
                ) : (
                  <div className="mr-auto flex items-center gap-2 rounded-[var(--look-ui-radius,1.5rem)] rounded-bl-lg border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-900 [animation-delay:0ms] dark:bg-white" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-900 [animation-delay:150ms] dark:bg-white" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-900 [animation-delay:300ms] dark:bg-white" />
                  </div>
                )}
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>
        </div>

        <div className="flex flex-col gap-2">
          {/* 状态条只留页眉没有的三件事：可改的上限、流式速度、超长告警。
              用量与缓存命中已在页眉显示，这里不再重复；上限在自动取到模型上限时没有可编辑的意义，也就不显示。
              状态与钩子统计固定同一行：窄栏（预览分栏打开）下只截断告警文案，不换行也不上下堆叠 */}
          {(visibleMessages.length > 0 || usageKnown) && (
            <div className="flex min-w-0 items-center gap-x-3">
              {(ctxPct >= 0.7 || !ctxLimitKnown || speed != null || compressing) && (
                <div
                  className={`flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap rounded-full px-3 py-1 text-[11px] ${
                    ctxPct >= 1
                      ? "bg-red-500/10 text-red-600 dark:text-red-400"
                      : ctxPct >= 0.7
                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : "text-neutral-400"
                  }`}
                >
                  {ctxPct >= 1 ? (
                    <span className="truncate">{t("chat.ctxTooLong")}</span>
                  ) : ctxPct >= 0.7 ? (
                    <span className="truncate">{t("chat.ctxHigh")}</span>
                  ) : null}
                  {!ctxLimitKnown && (
                    <span className="flex shrink-0 items-center gap-1">
                      {t("chat.ctxLimitLabel")}
                      {limitEdit ? (
                        <input
                          autoFocus
                          type="number"
                          min={4}
                          max={2000}
                          value={limitInput}
                          onChange={(e) => setLimitInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveLimit();
                            if (e.key === "Escape") setLimitEdit(false);
                          }}
                          onBlur={saveLimit}
                          className="w-14 rounded-md bg-transparent px-1 text-center outline-none ring-1 ring-current/40"
                        />
                      ) : (
                        <button
                          onClick={() => {
                            setLimitInput(String(ctxLimitK));
                            setLimitEdit(true);
                          }}
                          title={t("chat.ctxLimitTitle")}
                          className="underline decoration-dotted underline-offset-2 hover:opacity-70"
                        >
                          {ctxLimitK}K
                        </button>
                      )}
                    </span>
                  )}
                  {speed != null && <span className="shrink-0">{Math.round(speed)} tok/s</span>}
                  {(ctxPct >= 1 || compressing) && (
                    <button
                      onClick={compress}
                      disabled={compressing || busy}
                      title={t("chat.compressTip")}
                      className="shrink-0 rounded-full bg-red-500/15 px-2.5 py-0.5 font-medium text-red-600 transition-colors hover:bg-red-500/25 disabled:opacity-40 dark:text-red-400"
                    >
                      {compressing ? t("chat.compressing") : t("chat.compress")}
                    </button>
                  )}
                </div>
              )}

            </div>
          )}

          {/* 等待发送队列（拖拽 pill 调整发送顺序） */}
          {queues[activeId]?.length > 0 && (
            <div ref={queueBoxRef} className="flex flex-wrap items-center gap-2 px-1">
              <span className="flex items-center gap-1 text-[11px] text-neutral-400">
                <IconQueue size={13} />
                {queues[activeId].length} {t("chat.queued")}
              </span>
              {queues[activeId].map((q, i) => (
                <span
                  key={`${i}-${(q.bubble || "").slice(0, 8)}`}
                  data-qidx={i}
                  onMouseDown={() => setDragIdx(i)}
                  onDoubleClick={() => removeQueueItem(activeId, i)}
                  className={`flex max-w-[220px] cursor-grab select-none items-center gap-1 rounded-full px-2.5 py-1 text-[11px] transition-colors active:cursor-grabbing ${
                    dragIdx === i
                      ? "bg-neutral-900/15 ring-1 ring-neutral-900/30 dark:bg-white/20 dark:ring-white/40"
                      : "bg-neutral-900/5 hover:bg-neutral-900/10 dark:bg-white/10 dark:hover:bg-white/15"
                  }`}
                  title={t("chat.queueDragHint")}
                >
                  <span className="text-neutral-400">{i + 1}</span>
                  <span className="truncate">{queueLabel(q, t)}</span>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => removeQueueItem(activeId, i)}
                    className="shrink-0 text-neutral-400 hover:text-red-500"
                    title={t("common.remove")}
                  >
                    <IconX size={10} />
                  </button>
                </span>
              ))}
              {queuePaused[activeId] && (
                <>
                  <span className="text-[11px] text-amber-500">{t("chat.queuePaused")}</span>
                  <button onClick={() => resumeQueue(activeId)} className="text-[11px] text-emerald-500 hover:underline">
                    {t("chat.resumeQueue")}
                  </button>
                </>
              )}
              <button onClick={() => clearQueue(activeId)} className="text-[11px] text-neutral-400 hover:text-red-500">
                {t("chat.clearAll")}
              </button>
            </div>
          )}

          {/* 工具审批卡片 */}
          {approvals.map((a) => (
            <div key={a.id} className="card border-amber-400/60 p-3 dark:border-amber-500/40">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <IconShield size={15} className="text-amber-500" />
                {t("chat.approvalTitle")}
                <span className="font-mono">{a.tool}</span>
              </div>
              <pre className="mb-2 max-h-32 overflow-auto rounded-2xl bg-neutral-100 p-2 text-[11px] dark:bg-neutral-900">
                {JSON.stringify(a.params, null, 2)}
              </pre>
              <div className="flex gap-2">
                <button onClick={() => answerApproval(a.id, true)} className="pill pill-hover">
                  {t("chat.approve")}
                </button>
                <button onClick={() => answerApproval(a.id, false)} className="pill-outline pill-hover text-red-500">
                  {t("chat.reject")}
                </button>
              </div>
            </div>
          ))}

          {/* ask_user 提问卡片：AI 主动提问，选项点选 + 补充输入 */}
          {asks.map((a) => {
            const picks = askPicks[a.id] || [];
            const text = (askText[a.id] || "").trim();
            const ready = picks.length > 0 || text.length > 0;
            return (
              <div key={a.id} className="card border-violet-400/60 p-3 dark:border-violet-500/40">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <IconChat size={15} className="text-violet-500" />
                  {t("chat.askTitle")}
                  {a.allow_multiple && <span className="text-[11px] text-neutral-400">{t("chat.askMulti")}</span>}
                </div>
                <div className="mb-2 text-sm whitespace-pre-wrap">{a.question}</div>
                {a.options?.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {a.options.map((opt, idx) => {
                      const on = picks.includes(idx);
                      return (
                        <button
                          key={idx}
                          onClick={() => toggleAskPick(a, idx)}
                          className={on ? "pill border-violet-500 bg-violet-500 text-white" : "pill-outline pill-hover"}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                )}
                <textarea
                  value={askText[a.id] || ""}
                  onChange={(e) => setAskText((m) => ({ ...m, [a.id]: e.target.value }))}
                  placeholder={t("chat.askCustom")}
                  rows={2}
                  className="field mb-2 w-full rounded-[var(--look-ui-radius,1rem)]"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => submitAsk(a)}
                    disabled={!ready}
                    className={`pill ${ready ? "pill-hover bg-violet-500 text-white" : "opacity-40"}`}
                  >
                    {t("chat.askSubmit")}
                  </button>
                </div>
              </div>
            );
          })}

          {/* 隐藏文件输入 */}
          <input
            ref={imgInput}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onPickImages}
          />
          <input
            ref={docInput}
            type="file"
            accept=".xlsx,.xls,.csv,.docx,.txt,.md"
            multiple
            className="hidden"
            onChange={onPickDocs}
          />

          {/* 附件预览区：定宽列的网格，附件卡按列拉伸填满整行 */}
          {(hasAttachments || attaching || attachErr) && (
            <div className="card grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] items-center gap-1.5 p-2.5">
              {images.map((img, i) => (
                <div key={`img-${i}`} className="group relative w-fit justify-self-start">
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    title={img.name}
                    className="h-14 w-14 rounded-lg object-cover ring-1 ring-neutral-200 dark:ring-neutral-700"
                  />
                  <button
                    onClick={() => removeImage(i)}
                    title={t("common.remove")}
                    className="accent-solid absolute -right-1.5 -top-1.5 rounded-full p-0.5 opacity-0 shadow transition-opacity group-hover:opacity-100"
                  >
                    <IconX size={11} />
                  </button>
                </div>
              ))}
              {docs.map((doc, i) => (
                <FileChip
                  key={`doc-${i}`}
                  file={{ ...doc, removeTitle: t("common.remove") }}
                  onRemove={() => removeDoc(i)}
                  onContextMenu={fileMenu.open(doc)}
                  title={doc.path || doc.name}
                />
              ))}
              {attaching && (
                <span className="col-span-full text-xs text-neutral-400">{t("chat.parsing")}</span>
              )}
              {attachErr && (
                <span className="col-span-full text-xs text-red-500" title={attachErr}>
                  {attachErr}
                </span>
              )}
              {hasAttachments && (
                <button
                  onClick={clearAttachments}
                  className="col-span-full ml-auto text-xs text-neutral-400 hover:text-red-500"
                >
                  {t("chat.clearAll")}
                </button>
              )}
            </div>
          )}

          {/* URL 输入面板 */}
          {urlOpen && (
            <div className="card flex flex-wrap items-center gap-2 p-2.5">
              <input
                autoFocus
                type="text"
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addUrl();
                  if (e.key === "Escape") setUrlOpen(false);
                }}
                placeholder={t("chat.urlPlaceholder")}
                className="field min-w-0 flex-1"
              />
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={urlParse}
                  onChange={(e) => setUrlParse(e.target.checked)}
                />
                {t("chat.parseContent")}
              </label>
              <button
                onClick={addUrl}
                disabled={!urlText.trim() || attaching}
                className="pill pill-hover shrink-0"
              >
                {t("common.add")}
              </button>
              <button
                onClick={() => setUrlOpen(false)}
                title={t("common.close")}
                className="icon-btn h-7 w-7 shrink-0"
              >
                <IconX size={14} />
              </button>
            </div>
          )}

          {/* 后台长命令状态：原固定条已迁移到工具栏「后台运行任务状态」按钮 popover */}

          {/* 子代理状态条：宿主派出的子代理实时进度（点击查看子会话全过程） */}
          {subList.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900">
              <IconQueue size={14} className="shrink-0 text-neutral-500" />
              {subList.map((s) => {
                const done = s.phase === "done";
                const failed = s.phase === "error";
                const secs = s.ms ? Math.max(1, Math.round(s.ms / 1000)) : 0;
                return (
                  <button
                    key={s.session_id}
                    onClick={() => selectSession(s.session_id)}
                    title={t("chat.subagentJump")}
                    className={`min-w-0 max-w-full truncate rounded-lg px-1.5 py-0.5 text-left hover:bg-neutral-900/5 dark:hover:bg-white/10 ${
                      failed
                        ? "text-red-500"
                        : done
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-neutral-600 dark:text-neutral-300"
                    }`}
                  >
                    <span className="mr-1 font-medium">{s.title || t("chat.subagent")}</span>
                    <span className="text-neutral-400">
                      {failed
                        ? `${t("chat.subagentFailed")}${s.error ? `：${s.error}` : ""}`
                        : done
                        ? `${t("chat.subagentDone")} · ${secs}s`
                        : t("chat.thinking")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 语音输入状态行：录音 / 转写 / 模型下载进度条 / 唤醒监听 / 临时提示 */}
          {(recording || transcribing || downloading || voiceHint || wakeOn) && (
            <div className="flex flex-col gap-1 px-1 pb-1">
              <p
                className={`text-xs ${
                  voiceHint?.kind === "err" ? "text-red-500" : "text-neutral-500 dark:text-neutral-400"
                }`}
              >
                {voiceHint?.msg ||
                  (recording
                    ? t("chat.voiceRecording")
                    : transcribing
                    ? t("chat.voiceTranscribing")
                    : downloading
                    ? voiceDl.total
                      ? t("voice.downloading", { p: Math.round((voiceDl.done / voiceDl.total) * 100) })
                      : t("voice.downloadStart")
                    : wakeOn
                    ? t("voice.kwsOn")
                    : "")}
              </p>
              {downloading && voiceDl.total > 0 && (
                <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-sky-500 transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.round((voiceDl.done / voiceDl.total) * 100))}%` }}
                  />
                </div>
              )}
            </div>
          )}
          {/* 底部 pb-12 为工具栏/发送按钮预留独立一行：textarea 只在自己的区域滚动，永不进入按钮行 */}
          {/* panel-input：输入区专属背景（图片+透明度由外观页控制），textarea 本身透明可透出 */}
          <div className="panel-surface panel-input relative rounded-[var(--look-ui-radius,1rem)] bg-white pb-12 dark:bg-neutral-950">
            {/* 工具栏：左下角 absolute 排成一行（外层按钮收进输入框内）。
                右侧让出 96px：边距 8 + 发送 40 + 间隙 6 + 话筒 34 + 间隙 8（话筒关掉时只让 56）。
                让多了就会「还有空位也折」，插件图标白白塞进「⋯」。
                定宽（right 也钉住）而不是贴着内容长：这一排的可用宽度从此是个死数，
                折叠 / 摊回的判分才量得准，右边那段空白也正好是右键「加图标」的落点。 */}
            <IconRow
              layout={tools}
              zone="chatToolbar"
              nodes={chatNodes}
              className={`pointer-events-auto absolute bottom-2 left-2 z-10 ${micVisible ? "right-24" : "right-14"}`}
              maxLines={1}
              fitPx={TOOL_PX}
            />

            {/* 多行输入：随内容自动增高，超出后内部滚动；Enter 发送，Shift+Enter 换行 */}
            <textarea
              ref={inputRef}
              rows={1}
              className="block w-full max-h-[160px] min-h-[80px] resize-none overflow-y-auto rounded-t-2xl bg-transparent px-4 pt-3 pb-2 text-sm text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
              value={input}
              placeholder={
                !activeId
                  ? t("chat.selectFirst")
                  : busy
                    ? t("chat.busyPlaceholder")
                    : t("chat.inputPlaceholder")
              }
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPasteInput}
              onKeyDown={(e) => {
                // Enter 发送；Shift+Enter 换行；中文输入法选词回车不发送（isComposing 保护）；录音期间不发送
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !recording) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={!activeId}
            />
            <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5">
              {voiceBtn}
              {busy ? (
                <button
                  onClick={interrupt}
                  title={t("chat.stop")}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10 text-red-600 transition-colors hover:bg-red-500/25 dark:text-red-400"
                >
                  <IconStop size={16} />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={(!input.trim() && !hasAttachments) || !activeId || recording}
                  title={t("common.send")}
                  className="accent-solid flex h-10 w-10 items-center justify-center rounded-full shadow-sm transition-all duration-200 hover:brightness-110 active:scale-95 disabled:opacity-40"
                >
                  <IconSend size={16} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* AI 接收内容预览 */}
        {previewOpen && preview && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
            onClick={() => setPreviewOpen(false)}
          >
            <div
              className="card flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 overflow-hidden p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{t("chat.preview")}</h3>
                <div className="flex items-center gap-3 text-xs text-neutral-400">
                  <span>
                    {preview.messages.length - 1} {t("chat.previewMsgsCount")}
                  </span>
                  <span>
                    {preview.tools.length} {t("chat.previewToolsShort")}
                  </span>
                  <span>
                    {t("chat.previewTokens")} ~{preview.est_tokens}
                  </span>
                  <button onClick={() => setPreviewOpen(false)} title={t("common.close")} className="icon-btn h-7 w-7 shrink-0">
                    <IconX size={14} />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
                <div>
                  <p className="mb-1 text-xs font-semibold text-neutral-500">{t("chat.previewSystem")}</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-2xl bg-neutral-100 p-2.5 text-[11px] leading-relaxed dark:bg-neutral-900">
                    {preview.system}
                  </pre>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold text-neutral-500">{t("chat.previewMsgs")}</p>
                  <div className="space-y-1">
                    {preview.messages.slice(1).map((m) => (
                      <div
                        key={m.index}
                        className="rounded-2xl bg-neutral-100 px-2.5 py-1.5 text-[11px] dark:bg-neutral-900"
                      >
                        <span className="mr-2 font-mono font-semibold">{m.role}</span>
                        <span className="text-neutral-500">
                          {m.preview}
                          {m.content.length > m.preview.length ? "…" : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold text-neutral-500">{t("chat.previewTools")}</p>
                  <div className="flex flex-wrap gap-1">
                    {preview.tools.map((tl, i) => (
                      <span
                        key={i}
                        title={tl.description}
                        className="rounded-full border border-neutral-200 px-2 py-0.5 font-mono text-[10px] dark:border-neutral-700"
                      >
                        {tl.name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
      {/* 右侧预览/编辑面板：多标签 + 左边缘拖宽。AI 改完文件直接在这里看、改、存回原路径 */}
      {paneOpen && (
        <div
          className="flex h-full shrink-0 gap-1.5"
          style={{ width: Math.min(paneW + 6, Math.max(280, Math.round(window.innerWidth * 0.45))) + 6 }}
        >
          <div
            onMouseDown={startPaneResize}
            className="w-1.5 shrink-0 cursor-col-resize rounded-full hover:bg-neutral-300 dark:hover:bg-neutral-700"
            title={t("chat.paneClose")}
          />
          <div className="card flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--look-ui-radius,1rem)] p-0">
            {/* 标签栏：多开预览，点标签切换，✕ 关闭；橙点 = 有未保存修改 */}
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-200 px-1.5 py-1 dark:border-neutral-800">
              {tabs.map((x) => (
                <div
                  key={x.path}
                  onClick={() => setActivePath(x.path)}
                  title={x.path}
                  onContextMenu={x.kind === "web" ? undefined : fileMenu.open(fileFromPath(x.path))}
                  className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11px] ${
                    x.path === activePath
                      ? "accent-solid"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                  }`}
                >
                  <span className="max-w-36 truncate font-mono">
                    {x.kind === "web"
                      ? x.title || x.path.replace(/^https?:\/\//i, "").split("/")[0]
                      : x.path.split(/[\\/]/).pop()}
                  </span>
                  {x.kind !== "web" && x.text !== null && x.text !== x.base && (
                    <span className="accent-solid h-1.5 w-1.5 shrink-0 rounded-full" />
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(x.path);
                    }}
                    className="shrink-0 opacity-50 hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  setPaneMsg("");
                  setWebDraft((v) => (v === null ? "" : null));
                }}
                title={t("chat.webNewTab")}
                className="icon-btn ml-auto h-6 w-6 shrink-0 text-xs"
              >
                <IconGlobe size={13} />
              </button>
              <button
                type="button"
                onClick={() => setPaneOpen(false)}
                title={t("chat.paneClose")}
                className="icon-btn h-6 w-6 shrink-0 text-xs"
              >
                ⇥
              </button>
            </div>
            {webDraft !== null && (
              <form
                className="flex shrink-0 items-center gap-1.5 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800"
                onSubmit={(e) => {
                  e.preventDefault();
                  openWebTab(webDraft);
                }}
              >
                <IconGlobe size={13} className="shrink-0 text-neutral-400" />
                <input
                  autoFocus
                  value={webDraft}
                  spellCheck={false}
                  onChange={(e) => setWebDraft(e.target.value)}
                  placeholder={t("chat.webUrlPlaceholder")}
                  className="min-w-0 flex-1 rounded-full bg-neutral-100 px-3 py-1 font-mono text-[11px] text-neutral-700 outline-none placeholder:text-neutral-400 dark:bg-neutral-800 dark:text-neutral-200"
                />
                <button type="submit" disabled={!String(webDraft).trim()} className="pill pill-hover px-3 py-1 text-[11px]">
                  {t("chat.webGo")}
                </button>
                <button type="button" onClick={() => setWebDraft(null)} title={t("common.close")} className="icon-btn h-6 w-6 shrink-0">
                  <IconX size={12} />
                </button>
              </form>
            )}
            {activeTab && activeTab.kind !== "web" && (
              <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
                <span className="truncate font-mono text-[11px] text-neutral-500">{activeTab.path}</span>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setInput(t("chat.editPathPrompt", { path: activeTab.path }));
                      inputRef.current?.focus();
                    }}
                    className="pill-outline pill-hover px-3 py-1 text-[11px]"
                  >
                    {t("chat.paneAsk")}
                  </button>
                  {activeTab.kind !== "img" && activeTab.kind !== "doc" && (
                    <button
                      type="button"
                      onClick={() => setPaneMode(paneMode === "edit" ? "view" : "edit")}
                      className="pill-outline pill-hover px-3 py-1 text-[11px]"
                    >
                      {paneMode === "edit" ? t("chat.panePreview") : t("chat.paneEdit")}
                    </button>
                  )}
                  {/* 办公文档改不了也存不回二进制，只能交系统程序编辑 */}
                  {activeTab.kind === "doc" && (
                    <button
                      type="button"
                      onClick={() => api.openPath(activeTab.path, false).catch(() => {})}
                      className="pill-outline pill-hover px-3 py-1 text-[11px]"
                    >
                      {t("chat.paneOpenWith")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => reloadTab(activeTab.path)}
                    className="pill-outline pill-hover px-3 py-1 text-[11px]"
                  >
                    {t("chat.paneReload")}
                  </button>
                  {activeTab.kind !== "doc" && (
                    <button
                      type="button"
                      disabled={activeTab.text === null || activeTab.text === activeTab.base}
                      onClick={() => saveTab(activeTab.path)}
                      className="pill pill-hover px-3 py-1 text-[11px]"
                    >
                      {t("chat.paneSave")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {!!paneMsg && <div className="shrink-0 px-3 py-1 text-[11px] text-neutral-500">{paneMsg}</div>}
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {/* 网页标签全部常驻：切走再切回来还是原来那一页（滚动位置、表单、前进后退都留着），
                  只把非活动层藏起来，而不是卸载重挂 webview */}
              {tabs
                .filter((x) => x.kind === "web")
                .map((x) => (
                  <div
                    key={x.path}
                    className={`absolute inset-0 flex min-h-0 flex-col ${
                      x.path === activePath ? "" : "invisible pointer-events-none"
                    }`}
                  >
                    <WebPane
                      initialUrl={x.path}
                      onTitle={(title) =>
                        setTabs((prev) =>
                          prev.map((t) => (t.path === x.path && t.title !== title ? { ...t, title } : t))
                        )
                      }
                    />
                  </div>
                ))}
              {!activeTab ? (
                <div className="p-6 text-center text-xs text-neutral-500">{t("chat.paneEmpty")}</div>
              ) : activeTab.kind === "web" ? null : (
                <div className="flex h-full min-h-0 flex-col overflow-auto">
                  {paneMode === "edit" && activeTab.kind !== "img" ? (
                    <textarea
                      className="field m-3 min-h-0 w-auto flex-1 resize-none rounded-[var(--look-ui-radius,1rem)] px-4 py-3 font-mono text-xs leading-relaxed"
                      value={activeTab.text ?? ""}
                      spellCheck={false}
                      onChange={(e) => {
                        const v = e.target.value;
                        setTabs((prev) => prev.map((x) => (x.path === activeTab.path ? { ...x, text: v } : x)));
                      }}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                          e.preventDefault();
                          saveTab(activeTab.path);
                        }
                      }}
                    />
                  ) : activeTab.kind === "doc" ? (
                    <DocPane
                      tab={activeTab}
                      onView={(v) =>
                        setTabs((prev) => prev.map((x) => (x.path === activeTab.path ? { ...x, view: v } : x)))
                      }
                    />
                  ) : activeTab.kind === "md" ? (
                    <div className="px-5 py-4">
                      <Markdown>{activeTab.text ?? ""}</Markdown>
                    </div>
                  ) : activeTab.kind === "img" ? (
                    <div className="flex h-full items-center justify-center p-4">
                      <img src={convertFileSrc(activeTab.path)} alt="" className="max-h-full max-w-full object-contain" />
                    </div>
                  ) : activeTab.kind === "html" || activeTab.kind === "svg" ? (
                    // key 带上落盘内容：重新读取或保存后强制重挂，避免 iframe 停在旧文件上
                    <iframe
                      key={`${activeTab.path}#${activeTab.base}`}
                      title="pane-preview"
                      src={convertFileSrc(activeTab.path)}
                      className="h-full w-full border-0 bg-white"
                      sandbox="allow-scripts allow-popups allow-top-navigation"
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap p-3 font-mono text-xs">{activeTab.text ?? ""}</pre>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {shellLogJob && (
        <ShellLogModal
          job={shellLogJob}
          onClose={() => setShellLogJob(null)}
          onStop={() => shellJobs.stopJob(shellLogJob.job_id)}
        />
      )}
      {/* 编辑重发弹窗：改写最后一条 user 消息后重新生成回复 */}
      {editResend && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6"
          onClick={() => setEditResend(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="card flex w-[520px] max-w-[calc(100vw-24px)] flex-col gap-3 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("chat.editResendTitle")}</h3>
            <textarea
              autoFocus
              className="field min-h-32 w-full resize-y"
              value={editResend.text}
              onChange={(e) => setEditResend({ text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && editResend.text.trim()) {
                  startRegenerate(editResend.text.trim());
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <button className="pill pill-hover text-xs" onClick={() => setEditResend(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="pill pill-hover text-xs"
                disabled={!editResend.text.trim()}
                onClick={() => startRegenerate(editResend.text.trim())}
              >
                {t("chat.editResendConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 识别模型选择弹窗（多模型选一）：麦克风未就绪时触发；选中即 resolve(id) */}
      {voicePicker && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6"
          onClick={() => {
            voicePicker.resolve(null);
            setVoicePicker(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="card w-[420px] max-w-[calc(100vw-24px)] max-h-[70vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {t("voice.pickTitle")}
            </h3>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("voice.pickBody")}</p>
            <div className="mt-3 flex flex-col gap-1.5">
              {voicePicker.variants.map((v) => {
                const active = v.id === voicePicker.pickedId;
                return (
                  <button
                    key={v.id}
                    onClick={() => setVoicePicker({ ...voicePicker, pickedId: v.id })}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                      active
                        ? "border-neutral-900 bg-neutral-900/5 dark:border-neutral-200 dark:bg-white/10"
                        : "border-neutral-200 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
                    }`}
                  >
                    <span
                      className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                        active
                          ? "border-neutral-900 bg-neutral-900 dark:border-neutral-100 dark:bg-neutral-100"
                          : "border-neutral-300 dark:border-neutral-600"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-neutral-900 dark:text-neutral-100">
                        {v.label}
                        {v.id === voicePicker.currentId && (
                          <span className="ml-1.5 text-[10px] text-neutral-400">{t("voice.pickCurrent")}</span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-neutral-400">
                        {v.sizeText} · {v.langText}
                      </span>
                    </span>
                    {v.ready && (
                      <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                        {t("voice.pickReady")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                className="pill pill-outline pill-hover"
                onClick={() => {
                  voicePicker.resolve(null);
                  setVoicePicker(null);
                }}
              >
                {t("dialog.cancel")}
              </button>
              <button
                className="pill pill-hover"
                onClick={() => {
                  voicePicker.resolve(voicePicker.pickedId || voicePicker.currentId);
                  setVoicePicker(null);
                }}
              >
                {t("voice.pickConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 复制按钮：复制消息原文，成功短暂打勾（悬停气泡时浮现）
function CopyBtn({ text }) {
  const { t } = useLang();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      // 剪贴板不可用（非安全上下文/无权限）时静默放弃
    }
  };
  return (
    <button
      onClick={copy}
      title={done ? t("common.copied") : t("common.copy")}
      className="icon-btn h-6 w-6 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
    >
      {done ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

// 单条消息朗读按钮：空闲（悬停浮现）/合成中（脉冲）/播放中（点按停止）三态
function SpeakBtn({ text }) {
  const { t } = useLang();
  const [phase, setPhase] = useState("idle"); // idle | busy | playing
  useEffect(() => () => stopTts(), []); // 卸载时兜底停声
  const speak = async () => {
    if (phase === "playing") {
      stopTts();
      setPhase("idle");
      return;
    }
    if (phase === "busy") return;
    setPhase("busy");
    try {
      await speakText(text);
      setPhase("idle");
    } catch {
      setPhase("idle"); // 合成/播放失败静默复位
    }
  };
  return (
    <button
      onClick={speak}
      title={phase === "playing" ? t("chat.speakStop") : phase === "busy" ? t("chat.speaking") : t("chat.speak")}
      className={`icon-btn h-6 w-6 rounded-full transition-opacity ${
        phase === "idle" ? "opacity-0 group-hover:opacity-100" : "text-amber-600 opacity-100 dark:text-amber-400"
      }`}
    >
      {phase === "playing" ? <IconSpeakerOff size={12} /> : <IconSpeaker size={12} className={phase === "busy" ? "animate-pulse" : undefined} />}
    </button>
  );
}

// 思考过程折叠面板：流式期间默认展开（openDefault），历史消息默认折叠
// 压缩摘要分割线：会话里的 system 消息就是压缩摘要（自动压缩 / compress_session / compact_history 写入）。
// 摘要动辄几百字，默认折成一条线，点开才铺开正文——否则一屏全是摘要，看不到对话。
function CompressedDivider({ content }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2" data-bit-compressed={open ? "open" : "closed"}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t("chat.compressedToggle", "展开或收起摘要")}
        className="flex w-full items-center gap-3 text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200"
      >
        <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-700" />
        <span className="flex shrink-0 items-center gap-1 text-[11px]">
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          {t("chat.compressedDivider")}
        </span>
        <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-700" />
      </button>
      {open && (
        <div className="mx-auto mt-1.5 w-[min(72ch,86%)] rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[13px] leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          <Markdown>{content}</Markdown>
        </div>
      )}
    </div>
  );
}

function ThinkPanel({ text, openDefault = false, streaming = false }) {
  const [open, setOpen] = useState(openDefault);
  if (!text || !text.trim()) return null;
  return (
    <div className="w-full overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs text-neutral-500 dark:text-neutral-400"
      >
        <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        {streaming ? t("chat.thinking") : t("chat.thinkLabel")}
        {streaming && <span className="h-1 w-1 animate-pulse rounded-full bg-neutral-500" />}
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto whitespace-pre-wrap border-t border-neutral-200 px-3 py-2 text-xs leading-relaxed text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          {text}
        </div>
      )}
    </div>
  );
}

// 单条消息气泡：user / assistant，assistant 可携带工具调用卡片
// send_file 成功的调用渲染为文件卡片（如同收文件），不出工具卡
// ── 图片/图表媒体操作条：预览（灯箱放大）/ 下载（另存为）/ 打开位置 ──
// src: 显示源（data:URL 或 asset 路径）；path: 本地源文件路径（无则没有"打开位置"）
// svgText: 图表的 SVG 文本（下载/预览直接用它，不需要落盘文件）
function svgDataUrl(svg) {
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
}
function MediaActions({ src, path, svgText, name }) {
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // 灯箱变换：s=缩放倍率，x/y=平移偏移（滚轮缩放、拖拽平移、双击复位）
  const [tf, setTf] = useState({ s: 1, x: 0, y: 0 });
  const dragRef = useRef(null);
  const closeLightbox = () => {
    setZoom(false);
    setNote("");
    setTf({ s: 1, x: 0, y: 0 });
  };
  // Esc 关闭灯箱（点空白/×之外的可靠途径）
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e) => {
      if (e.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);
  const dataSrc = src || (svgText ? svgDataUrl(svgText) : "");
  const canReveal = !!path && !path.startsWith("data:");
  const openLightbox = () => {
    setTf({ s: 1, x: 0, y: 0 });
    setZoom(true);
  };
  const onWheel = (e) => {
    e.stopPropagation();
    setTf((p) => {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      return { ...p, s: Math.min(10, Math.max(0.2, p.s * factor)) };
    });
  };
  const onDown = (e) => {
    dragRef.current = { sx: e.clientX - tf.x, sy: e.clientY - tf.y };
  };
  const onMove = (e) => {
    if (!dragRef.current) return;
    const { sx, sy } = dragRef.current;
    setTf((p) => ({ ...p, x: e.clientX - sx, y: e.clientY - sy }));
  };
  const onUp = () => {
    dragRef.current = null;
  };
  const dl = async () => {
    if (!dataSrc || busy) return;
    setBusy(true);
    setNote("");
    try {
      const saved = await api.saveFileAs(canReveal ? path : dataSrc, name);
      if (saved) setNote(t("chat.savedTo") + saved);
    } catch (e) {
      setNote(String(e));
    }
    setBusy(false);
  };
  return (
    <div className="mt-1 flex items-center justify-end gap-3 text-[11px] text-neutral-400">
      {note && <span className="mr-auto max-w-56 truncate text-emerald-500" title={note}>{note}</span>}
      <button type="button" className="hover:text-neutral-600 dark:hover:text-neutral-200" onClick={openLightbox}>
        {t("chat.zoom")}
      </button>
      <button type="button" className="hover:text-neutral-600 dark:hover:text-neutral-200 disabled:opacity-50" disabled={busy || !dataSrc} onClick={dl}>
        {busy ? "…" : t("chat.saveAs")}
      </button>
      {canReveal && (
        <button type="button" className="hover:text-neutral-600 dark:hover:text-neutral-200" onClick={() => api.openPath(path, true).catch(() => {})}>
          {t("chat.openLocation")}
        </button>
      )}
      {zoom && (
        <div
          className="fixed inset-0 z-[120] flex select-none flex-col items-center justify-center gap-2 overflow-hidden bg-black/75 p-6"
          onWheel={onWheel}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
          onDoubleClick={() => setTf({ s: 1, x: 0, y: 0 })}
          onDragStart={(e) => e.preventDefault()}
          style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
          onClick={(e) => {
            // 拖拽结束的 mouseup 不关闭：只有未发生拖拽时点击空白才关
            if (!dragRef.current && Math.abs(tf.x) + Math.abs(tf.y) < 6 && e.target === e.currentTarget) {
              closeLightbox();
            }
          }}
        >
          <button
            type="button"
            className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-lg text-neutral-200 hover:bg-black/70 hover:text-white"
            onClick={closeLightbox}
            title={t("chat.lightboxClose")}
          >
            ×
          </button>
          {svgText ? (
            <div
              className="max-h-full max-w-full rounded-xl bg-white p-5 dark:bg-neutral-900 [&_svg]:max-h-none"
              style={{ transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.s})`, transformOrigin: "center center" }}
              dangerouslySetInnerHTML={{ __html: svgText }}
            />
          ) : (
            <img
              src={dataSrc}
              alt="preview"
              className="max-h-full max-w-full rounded-xl object-contain"
              style={{ transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.s})`, transformOrigin: "center center" }}
              draggable={false}
            />
          )}
          <div className="rounded-full bg-black/50 px-3 py-1 text-[11px] text-neutral-300">
            {t("chat.lightboxHint", { z: `${Math.round(tf.s * 100)}%` })}
          </div>
        </div>
      )}
    </div>
  );
}

// 独立图卡片：Mermaid 渲染 + 标题 + 媒体操作条（下载的是渲染好的 SVG）
function DiagramCard({ diagram, dark }) {
  const [svgText, setSvgText] = useState("");
  if (!diagram || !diagram.code) return null;
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      {diagram.title && (
        <div className="mb-2 text-center text-xs font-semibold text-neutral-500">{diagram.title}</div>
      )}
      <Mermaid code={diagram.code} dark={dark} onSvg={setSvgText} />
      <MediaActions
        svgText={svgText}
        name={`${(diagram.title || "diagram").replace(/[\\/:*?"<>|]/g, "_")}.svg`}
      />
    </div>
  );
}

/**
 * 队列 pill 的一句话摘要。不能用 bubble 的第一行：带附件时第一行是
 * `[[bit-file {json}]]` 那段机器标记，摆在 pill 里就是一串没人看的乱码。
 * 这里拆回成人话：附件名 · 图片数 · 用户自己打的那句。
 */
function queueLabel(q, t) {
  const { files, rest } = parseFileBlocks(q.bubble || "");
  const parts = [];
  if (files.length) parts.push(files.map((f) => f.name).join("、"));
  const imgs = (q.imgData || []).filter(Boolean).length;
  if (imgs) parts.push(`${t("chat.attachImages")} ×${imgs}`);
  const head = String(rest || "").trim().split("\n")[0];
  if (head) parts.push(head);
  return parts.join(" · ");
}

const MessageBubble = memo(function MessageBubble({ message, index, dark, onPreview, canRegenerate, canEdit, canBranch, canRollback, onRegenerate, onEdit, onBranch, onRollback, onFileMenu, pending }) {
  const { t } = useLang();
  const isUser = message.role === "user";
  // 后台 shell 结束时由宿主注入的说明消息（用户没说话，别渲染成用户的气泡）。
  // 三种结束都带 [后台任务…] 前缀：完成 / 已手动停止 / 超时终止
  const isBgDone =
    isUser && typeof message.content === "string" && message.content.startsWith("[后台任务");
  const calls = message.tool_calls || [];
  const fileCalls = calls.filter((c) => c.tool === "send_file" && c.ok);
  const toolCalls = calls.filter((c) => !(c.tool === "send_file" && c.ok));
  const hasText = message.content && message.content.trim().length > 0;

  if (isBgDone) {
    return (
      <div className="group mr-auto flex max-w-[85%] flex-col gap-0.5">
        <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-400">
          {message.content}
        </div>
        <CopyBtn text={message.content || ""} />
      </div>
    );
  }

  if (isUser) {
    // 发出去的图必须看得见：核心把随消息附带的 dataURL 存在 images 上，
    // 气泡上方回显缩略图（点「预览」开灯箱、「下载」回取原图）；
    // 不存的话切走再回来只剩「图片 ×N」，用户无从核对自己发了哪张。
    const sentImgs = Array.isArray(message.images) ? message.images.filter(Boolean) : [];
    // 附件文档：正文是给模型的上下文，气泡只画卡片。带标记的新消息和只带
    // 【附件：x】的老消息都认，历史记录不会突然刷出一屏解析正文。
    const { files: sentFiles, rest } = parseFileBlocks(message.content);
    const restText = String(rest || "").trim();
    return (
      <div className={`group ml-auto flex max-w-[80%] flex-col items-end gap-0.5 ${pending ? "opacity-60" : ""}`}>
        {sentImgs.length > 0 && (
          <div className="mb-1 flex max-w-full flex-wrap items-end justify-end gap-2">
            {sentImgs.map((src, i) => (
              <div key={i} className="flex max-w-full flex-col items-end">
                <div className="overflow-hidden rounded-[var(--look-ui-radius,1.5rem)] rounded-tr-lg border border-neutral-200 dark:border-neutral-800">
                  <img src={src} alt={`${t("chat.attachImages")} ${i + 1}`} className="max-h-40 w-auto max-w-full" />
                </div>
                <MediaActions src={src} name={`image-${i + 1}.png`} />
              </div>
            ))}
          </div>
        )}
        {sentFiles.length > 0 && (
          <div className="mb-1 flex max-w-full flex-wrap items-end justify-end gap-1.5">
            {sentFiles.map((f, i) => (
              <FileChip key={`f-${i}`} file={f} size={24} onContextMenu={onFileMenu(f)} />
            ))}
          </div>
        )}
        {/* 只发图/只发附件不打字时不画空气泡：缩略图与附件卡本身就是这条消息 */}
        {restText && (
          <div className="accent-solid whitespace-pre-wrap rounded-[var(--look-ui-radius,1.5rem)] rounded-br-lg px-4 py-2.5 text-sm leading-relaxed">
            {restText}
          </div>
        )}
        <div className="flex items-center gap-1">
          {pending && (
            <span className="flex items-center gap-1 rounded-full bg-neutral-900/5 px-2 py-0.5 text-[11px] text-neutral-400 dark:bg-white/10">
              <IconQueue size={11} />
              {t("chat.queuePending")}
              <button
                onClick={() => pending.onRemove()}
                title={t("chat.queueDrop")}
                className="text-neutral-400 hover:text-red-500"
              >
                <IconX size={10} />
              </button>
            </span>
          )}
          {!!restText && <CopyBtn text={restText} />}
          {canEdit && onEdit && (
            <button
              onClick={() => onEdit(message.content)}
              title={t("chat.editResend")}
              className="icon-btn h-6 w-6 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
            >
              <IconEdit size={12} />
            </button>
          )}
          {canRollback && onRollback && (
            <button
              onClick={() => onRollback(index)}
              title={t("chat.rollbackHere")}
              className="icon-btn h-6 w-6 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
            >
              <IconUndo size={12} />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mr-auto flex max-w-[85%] flex-col gap-2">
      {toolCalls.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {toolCalls.map((c, i) => (
            <ToolCallCard key={i} call={c} />
          ))}
        </div>
      )}
      {message.thinking && message.thinking.trim() && <ThinkPanel text={message.thinking} />}
      {message.image && (
        <div>
          <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
            <img src={message.image} alt="tool output" className="max-h-96 w-auto max-w-full" />
          </div>
          <MediaActions
            src={message.image}
            path={message.image_path}
            name={message.image_path ? message.image_path.split(/[\\/]/).pop() : "image.png"}
          />
        </div>
      )}
      {message.video && (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
          <video src={convertFileSrc(message.video)} controls className="max-h-96 w-auto max-w-full" />
        </div>
      )}
      {message.diagram && <DiagramCard diagram={message.diagram} dark={dark} />}
      {message.preview && (
        <button
          type="button"
          onClick={() => onPreview && onPreview(message.preview)}
          className="flex items-center gap-2 rounded-2xl border border-neutral-200 px-4 py-2.5 text-sm transition-colors hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
        >
          <span className="text-base leading-none">
            {message.preview.kind === "html" ? (
              <IconGlobe size={16} />
            ) : message.preview.kind === "md" ? (
              <IconFile size={16} />
            ) : (
              <IconImage size={16} />
            )}
          </span>
          <span className="max-w-64 truncate font-mono text-xs">
            {message.preview.path.split(/[\\/]/).pop()}
          </span>
          <span className="text-xs text-neutral-400">{t("chat.clickPreview")}</span>
        </button>
      )}
      {(hasText || (canRollback && onRollback)) && (
        <div className="group flex flex-col gap-0.5">
          {hasText && (
            <div className="rounded-[var(--look-ui-radius,1.5rem)] rounded-bl-lg border border-neutral-200 bg-white px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-900">
              <Markdown>{message.content}</Markdown>
            </div>
          )}
          <div className="flex items-center gap-1">
            {hasText && <SpeakBtn text={message.content || ""} />}
            {hasText && <CopyBtn text={message.content || ""} />}
            {hasText && canRegenerate && onRegenerate && (
              <button
                onClick={onRegenerate}
                title={t("chat.regenerate")}
                className="icon-btn h-6 w-6 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              >
                <IconRefresh size={12} />
              </button>
            )}
            {hasText && canBranch && onBranch && (
              <button
                onClick={() => onBranch(index)}
                title={t("chat.branchHere")}
                className="icon-btn h-6 w-6 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              >
                <IconBranch size={12} />
              </button>
            )}
            {canRollback && onRollback && (
              <button
                onClick={() => onRollback(index)}
                title={t("chat.rollbackHere")}
                className="icon-btn h-6 w-6 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              >
                <IconUndo size={12} />
              </button>
            )}
          </div>
        </div>
      )}
      {/* 文件卡片放在文字之后：先说话后发文件，如同聊天里收到附件 */}
      {fileCalls.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {fileCalls.map((c, i) => (
            <FileCard
              key={i}
              path={c.params?.path}
              bytes={c.result?.bytes}
              note={c.params?.note}
              onContextMenu={onFileMenu(fileFromPath(c.params?.path, c.result?.bytes))}
            />
          ))}
        </div>
      )}
    </div>
  );
});
