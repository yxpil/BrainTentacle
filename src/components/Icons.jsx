// 纯 SVG 图标库（黑白线性风格，无 emoji）
const I = ({ children, size = 18, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    {children}
  </svg>
);

export const IconPlay = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
  </I>
);

// 扬声器+声波：消息朗读按钮（描边风格，与工具栏其它图标统一）
export const IconSpeaker = (p) => (
  <I {...p}>
    <polygon points="11,5 6,9 3,9 3,15 6,15 11,19" fill="none" strokeLinejoin="round" />
    <path d="M14.5 9.5a4 4 0 0 1 0 5" />
    <path d="M17.5 7a7.5 7.5 0 0 1 0 10" />
  </I>
);

// 扬声器+斜线：停止朗读 / 关闭自动朗读（描边风格）
export const IconSpeakerOff = (p) => (
  <I {...p}>
    <polygon points="11,5 6,9 3,9 3,15 6,15 11,19" fill="none" strokeLinejoin="round" />
    <line x1="15" y1="9.5" x2="20.5" y2="14.5" />
    <line x1="20.5" y1="9.5" x2="15" y2="14.5" />
  </I>
);

export const IconPause = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <line x1="10" y1="9" x2="10" y2="15" />
    <line x1="14" y1="9" x2="14" y2="15" />
  </I>
);

// 裸图标（无外圈），用于放进实心圆形按钮内，复刻 PLocalSwitch 的启用/暂停圆钮
export const IconPauseBars = (p) => (
  <I {...p}>
    <line x1="9" y1="7" x2="9" y2="17" />
    <line x1="15" y1="7" x2="15" y2="17" />
  </I>
);
export const IconPlayTri = (p) => (
  <I {...p}>
    <polygon points="8,6 18,12 8,18" fill="currentColor" stroke="none" />
  </I>
);

export const IconChat = (p) => (
  <I {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z" />
    <circle cx="9" cy="12" r="0.5" fill="currentColor" />
    <circle cx="12.5" cy="12" r="0.5" fill="currentColor" />
    <circle cx="16" cy="12" r="0.5" fill="currentColor" />
  </I>
);

export const IconTool = (p) => (
  <I {...p}>
    <path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.6L3 17.6V21h3.4l5.7-5.7a4.5 4.5 0 0 0 5.6-6L14.5 12l-2.5-2.5 2.7-3.2z" />
  </I>
);

export const IconMemory = (p) => (
  <I {...p}>
    <rect x="5" y="5" width="14" height="14" rx="3" />
    <circle cx="9.5" cy="10" r="0.5" fill="currentColor" />
    <circle cx="14.5" cy="10" r="0.5" fill="currentColor" />
    <circle cx="9.5" cy="14" r="0.5" fill="currentColor" />
    <circle cx="14.5" cy="14" r="0.5" fill="currentColor" />
  </I>
);

export const IconSkill = (p) => (
  <I {...p}>
    <polygon points="12,3 14.5,8.5 20,9.3 16,13.2 17,19 12,16 7,19 8,13.2 4,9.3 9.5,8.5" />
  </I>
);

export const IconAudit = (p) => (
  <I {...p}>
    <path d="M6 3h12v18l-6-3-6 3z" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="9" y1="12" x2="15" y2="12" />
  </I>
);

export const IconGlobe = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.5 3.5 5.7 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.7-3.5-9s1-6.5 3.5-9z" />
  </I>
);

export const IconLang = (p) => (
  <I {...p}>
    <path d="M4 6h9M8.4 4.2V6M11 6c-.8 3.4-3.2 6.4-6 8M6 10c1.2 2.2 3.2 4 5.6 4.8" />
    <path d="M13 20l3.5-8 3.5 8M14.6 17h3.8" />
  </I>
);

export const IconSettings = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.5-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.4-2.6a7 7 0 0 0 2-1.2l2.5 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" />
  </I>
);

export const IconPlus = (p) => (
  <I {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </I>
);

export const IconTrash = (p) => (
  <I {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </I>
);

export const IconFolderOpen = (p) => (
  <I {...p}>
    <path d="M4 6a1 1 0 0 1 1-1h4.6l1.7 2H19a1 1 0 0 1 1 1v2H6.4a1 1 0 0 0-.96.72L4 14.5V6zM4 18.5l2.4-7.06a1 1 0 0 1 .95-.69H21l-2.1 7.03a1 1 0 0 1-.96.72H5a1 1 0 0 1-1-1z" />
  </I>
);

// 拼图：插件导航（与“打开目录”的文件夹区分开）
export const IconPuzzle = (p) => (
  <I {...p}>
    <path d="M4 6h5a2.5 2.5 0 0 1 5 0h6v4a2.5 2.5 0 0 0 0 5v5H4z" />
  </I>
);

// 闭合文件夹：会话分组头与“移到分组”入口
export const IconFolder = (p) => (
  <I {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4.2l1.7 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </I>
);

// 水滴：分组配色入口（与行内彩色标签共用同一套色板）
export const IconDroplet = (p) => (
  <I {...p}>
    <path d="M12 3.2s5.4 5.9 5.4 9.8a5.4 5.4 0 0 1-10.8 0C6.6 9.1 12 3.2 12 3.2z" />
  </I>
);

export const IconSend = (p) => (
  <I {...p}>
    <path d="M22 2 11 13M22 2 15 22l-4-9-9-4 20-7z" />
  </I>
);

export const IconBolt = (p) => (
  <I {...p}>
    <polygon points="13,2 4,14 11,14 10,22 20,9 13,9" />
  </I>
);

export const IconRefresh = (p) => (
  <I {...p}>
    <path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6" />
  </I>
);

// 分叉：从某条消息开出新会话（git-branch 形状，与朗读/复制/重新生成同一行）
export const IconBranch = (p) => (
  <I {...p}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </I>
);

// 回退：从某条消息之后截断会话并恢复文件（逆时针回转箭头，与分支按钮同一行）
export const IconUndo = (p) => (
  <I {...p}>
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    <path d="M8 5 4 9l4 4" />
  </I>
);

// 相机：网页截图（内嵌浏览器地址栏右侧）
export const IconCamera = (p) => (
  <I {...p}>
    <path d="M4 8h3l1.5-2h7L17 8h3v10H4z" />
    <circle cx="12" cy="13" r="3.2" />
  </I>
);

export const IconStop = (p) => (
  <I {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </I>
);

export const IconSearch = (p) => (
  <I {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M16.5 16.5 21 21" />
  </I>
);
export const IconEye = (p) => (
  <I {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </I>
);

export const IconShield = (p) => (
  <I {...p}>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
  </I>
);

export const IconQueue = (p) => (
  <I {...p}>
    {/* 墨迹必须落在 4..20 的方框内并对称于 (12,12)：原来箭头跑到 21，整颗字看起来偏右下、像是歪的 */}
    <line x1="4" y1="5" x2="20" y2="5" />
    <line x1="4" y1="10.5" x2="20" y2="10.5" />
    <line x1="4" y1="16" x2="13" y2="16" />
    <path d="M16.5 13l3.5 3-3.5 3" />
  </I>
);

export const IconTarget = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </I>
);

export const IconCheck = (p) => (
  <I {...p}>
    <path d="M4 12.5 9.5 18 20 6" />
  </I>
);

// 钟表：圆圈 + 时针分针（待办计划时间展示）
export const IconClock = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </I>
);

// 麦克风：胶囊拾音头 + 弧形支架 + 底座（语音输入）
export const IconMic = (p) => (
  <I {...p}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11v1a7 7 0 0 0 14 0v-1" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </I>
);

export const IconCopy = (p) => (
  <I {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </I>
);

export const IconX = (p) => (
  <I {...p}>
    <line x1="5" y1="5" x2="19" y2="19" />
    <line x1="19" y1="5" x2="5" y2="19" />
  </I>
);

/* ---- 标题栏 / 主题 / 解释器相关 ---- */

export const IconMinus = (p) => (
  <I {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </I>
);

export const IconSquare = (p) => (
  <I {...p}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </I>
);

export const IconSun = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </I>
);

export const IconMoon = (p) => (
  <I {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </I>
);

export const IconShirt = (p) => (
  <I {...p}>
    <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
  </I>
);

export const IconServer = (p) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <line x1="7" y1="7.5" x2="7.01" y2="7.5" />
    <line x1="7" y1="16.5" x2="7.01" y2="16.5" />
  </I>
);

// WorkWith：本地服务托管（服务器 + 播放三角）
export const IconWorkWith = (p) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <polygon points="10,5.8 14,7.5 10,9.2" fill="currentColor" stroke="none" />
    <polygon points="10,14.8 14,16.5 10,18.2" fill="currentColor" stroke="none" />
  </I>
);

export const IconTerminal = (p) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M13 15h4" />
  </I>
);

export const IconCode = (p) => (
  <I {...p}>
    <path d="M8 6l-5 6 5 6M16 6l5 6-5 6" />
  </I>
);

export const IconInfo = (p) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="11" x2="12" y2="16" />
    <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
  </I>
);

export const IconEdit = (p) => (
  <I {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </I>
);

export const IconChevronLeft = (p) => (
  <I {...p}>
    <path d="M15 18l-6-6 6-6" />
  </I>
);

export const IconChevronDown = (p) => (
  <I {...p}>
    <path d="M6 9l6 6 6-6" />
  </I>
);

export const IconChevronRight = (p) => (
  <I {...p}>
    <path d="M9 6l6 6-6 6" />
  </I>
);

/* ---- 附件：图片 / 文件 / 链接 ---- */

export const IconImage = (p) => (
  <I {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </I>
);

export const IconScissors = (p) => (
  <I {...p}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <line x1="20" y1="4" x2="8.12" y2="15.88" />
    <line x1="14.47" y1="14.48" x2="20" y2="20" />
    <line x1="8.12" y1="8.12" x2="12" y2="12" />
  </I>
);

// 通用文件（无扩展名 / 未识别类型的兜底）。
// 形状取自 Tabler Icons（MIT）的 file：与下面整族 file-type-* 同一个文档轮廓 + 折角，
// 免得同排里出现两种纸张形状。
export const IconFile = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" />
  </I>
);

export const IconLink = (p) => (
  <I {...p}>
    <path d="M10 13a5 5 0 0 0 7.07 0l2-2a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-2 2a5 5 0 0 0 7.07 7.07l1.5-1.5" />
  </I>
);

/* ---- 会话收藏 / 多选 ---- */

export const IconStar = (p) => (
  <I {...p}>
    <polygon points="12,3.6 14.7,9 20.4,9.8 16.2,13.8 17.3,19.6 12,16.5 6.7,19.6 7.8,13.8 3.6,9.8 9.3,9" />
  </I>
);

export const IconStarSolid = (p) => (
  <I {...p}>
    <polygon
      points="12,3.6 14.7,9 20.4,9.8 16.2,13.8 17.3,19.6 12,16.5 6.7,19.6 7.8,13.8 3.6,9.8 9.3,9"
      fill="currentColor"
      stroke="none"
    />
  </I>
);

// 三点：导航项放不下时的「更多」入口
export const IconMore = (p) => (
  <I {...p}>
    <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </I>
);

// ── 文档类型图标族（file-type-*）────────────────────────────────────────
// 形状取自 Tabler Icons 3.50.0（© Paweł Kuna，MIT 协议）的 outline 系列，
// 逐条搬进本文件这唯一的图标出口：同一 24 格画布、同一线宽（走 <I> 的 1.8）、
// 同一描边风格，不在页面里内联零散 SVG。扩展名徽标（PDF/DOC/XLS…）由
// components/FileRef.jsx 按文件名挑选，别在文字里打 emoji 或字符图标。
export const IconFilePdf = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" />
    <path d="M17 18h2" />
    <path d="M20 15h-3v6" />
    <path d="M11 15v6h1a2 2 0 0 0 2 -2v-2a2 2 0 0 0 -2 -2h-1" />
  </I>
);

export const IconFileWord = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M2 15v6h1a2 2 0 0 0 2 -2v-2a2 2 0 0 0 -2 -2h-1" />
    <path d="M17 16.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0" />
    <path d="M9.5 15a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1 -3 0v-3a1.5 1.5 0 0 1 1.5 -1.5" />
    <path d="M19.5 15l3 6" />
    <path d="M19.5 21l3 -6" />
  </I>
);

export const IconFileExcel = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M4 15l4 6" />
    <path d="M4 21l4 -6" />
    <path d="M17 20.25c0 .414 .336 .75 .75 .75h1.25a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-1a1 1 0 0 1 -1 -1v-1a1 1 0 0 1 1 -1h1.25a.75 .75 0 0 1 .75 .75" />
    <path d="M11 15v6h3" />
  </I>
);

export const IconFileCsv = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M7 16.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0" />
    <path d="M10 20.25c0 .414 .336 .75 .75 .75h1.25a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-1a1 1 0 0 1 -1 -1v-1a1 1 0 0 1 1 -1h1.25a.75 .75 0 0 1 .75 .75" />
    <path d="M16 15l2 6l2 -6" />
  </I>
);

export const IconFileSlides = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" />
    <path d="M11 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" />
    <path d="M16.5 15h3" />
    <path d="M18 15v6" />
  </I>
);

export const IconFileTxt = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M4.5 15h3" />
    <path d="M6 15v6" />
    <path d="M16.5 15h3" />
    <path d="M18 15v6" />
    <path d="M10 15l4 6" />
    <path d="M10 21l4 -6" />
  </I>
);

export const IconFileJs = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2h-1" />
    <path d="M3 15h3v4.5a1.5 1.5 0 0 1 -3 0" />
    <path d="M9 20.25c0 .414 .336 .75 .75 .75h1.25a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-1a1 1 0 0 1 -1 -1v-1a1 1 0 0 1 1 -1h1.25a.75 .75 0 0 1 .75 .75" />
  </I>
);

export const IconFileTs = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2h-1" />
    <path d="M3.5 15h3" />
    <path d="M5 15v6" />
    <path d="M9 20.25c0 .414 .336 .75 .75 .75h1.25a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-1a1 1 0 0 1 -1 -1v-1a1 1 0 0 1 1 -1h1.25a.75 .75 0 0 1 .75 .75" />
  </I>
);

export const IconFileHtml = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M2 21v-6" />
    <path d="M5 15v6" />
    <path d="M2 18h3" />
    <path d="M7.5 15h3" />
    <path d="M9 15v6" />
    <path d="M13 21v-6l2 3l2 -3v6" />
    <path d="M20 15v6h2" />
  </I>
);

export const IconFileCss = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M8 16.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0" />
    <path d="M11 20.25c0 .414 .336 .75 .75 .75h1.25a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-1a1 1 0 0 1 -1 -1v-1a1 1 0 0 1 1 -1h1.25a.75 .75 0 0 1 .75 .75" />
    <path d="M17 20.25c0 .414 .336 .75 .75 .75h1.25a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-1a1 1 0 0 1 -1 -1v-1a1 1 0 0 1 1 -1h1.25a.75 .75 0 0 1 .75 .75" />
  </I>
);

export const IconFileXml = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M4 15l4 6" />
    <path d="M4 21l4 -6" />
    <path d="M11 21v-6l2.5 3l2.5 -3v6" />
    <path d="M19 15v6h3" />
  </I>
);

export const IconFileSql = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M5 20.25c0 .414 .336 .75 .75 .75h1.25a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-1a1 1 0 0 1 -1 -1v-1a1 1 0 0 1 1 -1h1.25a.75 .75 0 0 1 .75 .75" />
    <path d="M13 15a2 2 0 0 1 2 2v2a2 2 0 1 1 -4 0v-2a2 2 0 0 1 2 -2" />
    <path d="M14 20l1.5 1.5" />
    <path d="M18 15v6h2" />
  </I>
);

export const IconFileZip = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M5 15h3l-3 6h3" />
    <path d="M12 15v6" />
    <path d="M16 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" />
  </I>
);

export const IconFilePng = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" />
    <path d="M11 21v-6l3 6v-6" />
    <path d="M20 15h-1a2 2 0 0 0 -2 2v2a2 2 0 0 0 2 2h1v-3" />
  </I>
);

export const IconFileJpg = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" />
    <path d="M5 15h3v4.5a1.5 1.5 0 0 1 -3 0" />
    <path d="M11 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" />
    <path d="M20 15h-1a2 2 0 0 0 -2 2v2a2 2 0 0 0 2 2h1v-3" />
  </I>
);

export const IconFileCode = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" />
    <path d="M10 13l-1 2l1 2" />
    <path d="M14 13l1 2l-1 2" />
  </I>
);

export const IconFileMusic = (p) => (
  <I {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" />
    <path d="M10 16a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    <path d="M12 16l0 -5l2 1" />
  </I>
);

export const IconFileVideo = (p) => (
  <I {...p}>
    <path d="M3 8a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -8" />
    <path d="M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4" />
  </I>
);

export const IconFileImage = (p) => (
  <I {...p}>
    <path d="M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12" />
    <path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5" />
    <path d="M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3" />
    <path d="M15 8h.01" />
  </I>
);
