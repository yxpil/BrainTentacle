// 文件类型识别与展示：把「一个文件」画成一张专业的附件卡，而不是裸链接。
//
// 图标全部来自 src/components/Icons.jsx 那个唯一出口（Tabler outline 族，MIT），
// 这里只做「扩展名 → 图标 / 标签 / 配色」的映射，不在组件里内联 SVG。
//
// 消息正文里的附件块用一行机器可读的标记开头：
//   [[bit-file {"name":"报告.pdf","size":24576,"kind":"pdf","path":"C:/…"}]]
// 之后紧跟解析出来的正文。模型看到的是「这个附件叫什么、多大」，前端靠它把
// 正文折起来、只画卡片——重载前后一致，不会再出现「发出去只剩 [文档 ×2]」。
import { getLang } from "../i18n.js";
import { pluginFileKind } from "../pluginHost.js";
import PluginGlyph from "./PluginGlyph.jsx";
import {
  IconFile,
  IconFileCode,
  IconFileCss,
  IconFileCsv,
  IconFileExcel,
  IconFileHtml,
  IconFileImage,
  IconFileJpg,
  IconFileJs,
  IconFileMusic,
  IconFilePdf,
  IconFilePng,
  IconFileSlides,
  IconFileSql,
  IconFileTs,
  IconFileTxt,
  IconFileVideo,
  IconFileWord,
  IconFileXml,
  IconFileZip,
  IconLink,
  IconX,
} from "./Icons.jsx";

const KINDS = {
  pdf: { Icon: IconFilePdf, label: "PDF", tone: "red" },
  doc: { Icon: IconFileWord, label: "DOC", tone: "blue" },
  docx: { Icon: IconFileWord, label: "DOCX", tone: "blue" },
  rtf: { Icon: IconFileWord, label: "RTF", tone: "blue" },
  pages: { Icon: IconFileWord, label: "PAGES", tone: "blue" },
  xls: { Icon: IconFileExcel, label: "XLS", tone: "green" },
  xlsx: { Icon: IconFileExcel, label: "XLSX", tone: "green" },
  ods: { Icon: IconFileExcel, label: "ODS", tone: "green" },
  csv: { Icon: IconFileCsv, label: "CSV", tone: "green" },
  ppt: { Icon: IconFileSlides, label: "PPT", tone: "orange" },
  pptx: { Icon: IconFileSlides, label: "PPTX", tone: "orange" },
  key: { Icon: IconFileSlides, label: "KEY", tone: "orange" },
  txt: { Icon: IconFileTxt, label: "TXT", tone: "slate" },
  md: { Icon: IconFileTxt, label: "MD", tone: "slate" },
  log: { Icon: IconFileTxt, label: "LOG", tone: "slate" },
  json: { Icon: IconFileCode, label: "JSON", tone: "amber" },
  yaml: { Icon: IconFileCode, label: "YAML", tone: "amber" },
  yml: { Icon: IconFileCode, label: "YML", tone: "amber" },
  toml: { Icon: IconFileCode, label: "TOML", tone: "amber" },
  js: { Icon: IconFileJs, label: "JS", tone: "amber" },
  jsx: { Icon: IconFileJs, label: "JSX", tone: "amber" },
  mjs: { Icon: IconFileJs, label: "MJS", tone: "amber" },
  ts: { Icon: IconFileTs, label: "TS", tone: "blue" },
  tsx: { Icon: IconFileTs, label: "TSX", tone: "blue" },
  py: { Icon: IconFileCode, label: "PY", tone: "blue" },
  rs: { Icon: IconFileCode, label: "RS", tone: "orange" },
  go: { Icon: IconFileCode, label: "GO", tone: "cyan" },
  java: { Icon: IconFileCode, label: "JAVA", tone: "orange" },
  c: { Icon: IconFileCode, label: "C", tone: "slate" },
  h: { Icon: IconFileCode, label: "H", tone: "slate" },
  sh: { Icon: IconFileCode, label: "SH", tone: "slate" },
  bat: { Icon: IconFileCode, label: "BAT", tone: "slate" },
  ps1: { Icon: IconFileCode, label: "PS1", tone: "blue" },
  sql: { Icon: IconFileSql, label: "SQL", tone: "blue" },
  html: { Icon: IconFileHtml, label: "HTML", tone: "orange" },
  htm: { Icon: IconFileHtml, label: "HTM", tone: "orange" },
  css: { Icon: IconFileCss, label: "CSS", tone: "blue" },
  xml: { Icon: IconFileXml, label: "XML", tone: "amber" },
  ini: { Icon: IconFileCode, label: "INI", tone: "slate" },
  env: { Icon: IconFileCode, label: "ENV", tone: "slate" },
  zip: { Icon: IconFileZip, label: "ZIP", tone: "violet" },
  rar: { Icon: IconFileZip, label: "RAR", tone: "violet" },
  "7z": { Icon: IconFileZip, label: "7Z", tone: "violet" },
  tar: { Icon: IconFileZip, label: "TAR", tone: "violet" },
  gz: { Icon: IconFileZip, label: "GZ", tone: "violet" },
  exe: { Icon: IconFile, label: "EXE", tone: "slate" },
  msi: { Icon: IconFile, label: "MSI", tone: "slate" },
  apk: { Icon: IconFile, label: "APK", tone: "green" },
  dmg: { Icon: IconFile, label: "DMG", tone: "slate" },
  iso: { Icon: IconFile, label: "ISO", tone: "violet" },
  png: { Icon: IconFilePng, label: "PNG", tone: "cyan" },
  jpg: { Icon: IconFileJpg, label: "JPG", tone: "cyan" },
  jpeg: { Icon: IconFileJpg, label: "JPEG", tone: "cyan" },
  gif: { Icon: IconFileImage, label: "GIF", tone: "cyan" },
  webp: { Icon: IconFileImage, label: "WEBP", tone: "cyan" },
  bmp: { Icon: IconFileImage, label: "BMP", tone: "cyan" },
  svg: { Icon: IconFileImage, label: "SVG", tone: "amber" },
  ico: { Icon: IconFileImage, label: "ICO", tone: "cyan" },
  mp3: { Icon: IconFileMusic, label: "MP3", tone: "violet" },
  wav: { Icon: IconFileMusic, label: "WAV", tone: "violet" },
  flac: { Icon: IconFileMusic, label: "FLAC", tone: "violet" },
  m4a: { Icon: IconFileMusic, label: "M4A", tone: "violet" },
  ogg: { Icon: IconFileMusic, label: "OGG", tone: "violet" },
  mp4: { Icon: IconFileVideo, label: "MP4", tone: "red" },
  mov: { Icon: IconFileVideo, label: "MOV", tone: "red" },
  avi: { Icon: IconFileVideo, label: "AVI", tone: "red" },
  mkv: { Icon: IconFileVideo, label: "MKV", tone: "red" },
  webm: { Icon: IconFileVideo, label: "WEBM", tone: "red" },
};

// 链接（http/https）单独一档，沿用附件菜单里「网址」的语义
const LINK = { Icon: IconLink, label: "URL", tone: "cyan" };

/// 按文件名认类型：先看插件登记的后缀，再走内置映射 / MIME 兜底 / 通用文件图标。
/// 插件登记的类型带自己的 `paths` 字形（后端已按白名单过滤），界面用 PluginGlyph 画，
/// 与内置图标同一套描边口径；没登记过的文件行为与改造前完全一致。
export function fileKind(name, mime, hint) {
  const clean = String(name || "");
  if (hint === "url" || /^https?:\/\//i.test(clean.trim())) return { key: "url", ...LINK };
  const fk = pluginFileKind(clean);
  if (fk) {
    return {
      key: fk.key,
      Icon: IconFile,
      // 名字是插件作者写的，按数据不译的口径原样显示（英文界面优先 label_en）
      label: (getLang() === "en" && fk.label_en) || fk.label || "FILE",
      tone: "violet",
      paths: fk.paths || [],
      parsedBy: fk.parses ? fk.plugin_name : "",
    };
  }
  const base = clean.split(/[\\/]/).pop() || clean;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const hit = KINDS[ext];
  if (hit) return { key: ext, ...hit };
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return { key: "image", ...KINDS.png };
  if (m.startsWith("audio/")) return { key: "audio", ...KINDS.mp3 };
  if (m.startsWith("video/")) return { key: "video", ...KINDS.mp4 };
  if (m.startsWith("text/")) return { key: "text", ...KINDS.txt };
  if (m === "application/zip" || m === "application/x-7z-compressed") return { key: "zip", ...KINDS.zip };
  return { key: "file", Icon: IconFile, label: ext ? ext.toUpperCase() : "FILE", tone: "slate" };
}

/// 字节数成人话：1024 进制，保留一位小数（整数不带小数点）
export function fmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const text = i === 0 ? String(Math.round(v)) : v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[i]}`;
}

/// 类型图标：插件登记的类型用它自己声明的字形（PluginGlyph，与内置图标同一套描边口径），
/// 其余走 Icons.jsx 那个唯一出口。三处文件展示（附件卡 / AI 文件卡 / 右键菜单）共用这一个入口。
export function FileKindIcon({ kind: k, size = 20 }) {
  if (k?.paths?.length) return <PluginGlyph paths={k.paths} size={size} />;
  const Icon = k?.Icon || IconFile;
  return <Icon size={size} />;
}

const MARK = "[[bit-file ";
const MARK_END = "]]";

/// 附件块开头那行标记：值走 JSON，路径里的反斜杠与引号都不用手工拼
export function fileBlockMarker(f) {
  return MARK + JSON.stringify({ name: f.name, size: f.size ?? 0, kind: f.kind ?? "", path: f.path ?? "" }) + MARK_END;
}

/// 把「正文 = 若干附件块 + 用户自己打的字」拆回来：
/// 返回 { files: [...], rest: 去掉附件块正文后的用户文本 }。
/// 兼容改造前的旧标记（【附件：x】/ [Attachment: x]），老消息不至于刷一屏正文。
export function parseFileBlocks(content) {
  const text = typeof content === "string" ? content : "";
  if (!text) return { files: [], rest: text };
  const blocks = text.split("\n\n---\n\n");
  const files = [];
  const rest = [];
  for (const block of blocks) {
    const nl = block.indexOf("\n");
    const head = nl < 0 ? block : block.slice(0, nl);
    if (head.startsWith(MARK) && head.endsWith(MARK_END)) {
      try {
        const j = JSON.parse(head.slice(MARK.length, -MARK_END.length));
        files.push({ name: j.name || "", size: j.size, path: j.path || "", kind: j.kind || "" });
        continue; // 解析出来的正文不进气泡：太长，而且用户本来就没打这些字
      } catch {
        /* 标记坏了就原样当正文显示，别把用户的话吞了 */
      }
    }
    const legacy = /^[【[]?(?:附件|Attachment)[：:]\s*(.+?)[】\]]?$/.exec(head.trim());
    if (legacy && nl > 0) {
      files.push({ name: legacy[1].trim(), size: 0, path: "", kind: "" });
      continue;
    }
    rest.push(block);
  }
  return { files, rest: rest.join("\n\n---\n\n") };
}

/// 请对话页在右侧栏打开一个文件：附件卡与 AI 发来的文件卡都发这个事件，
/// 组件不必认识侧栏，ChatPage 自己监听并决定用哪种视图（图片/文本/网页/办公文档）。
export function requestFileTab(path) {
  if (!path) return;
  window.dispatchEvent(new CustomEvent("bit-open-file-tab", { detail: { path } }));
}

/**
 * 附件卡：类型图标 + 文件名 + 「类型 · 大小 · 状态」。
 * file: {name, size, path, kind, mime, meta}；有 path 就能点开：本地文件进右侧栏预览，http(s) 交系统浏览器。
 * onOpen 覆盖默认打开行为，onRemove 给了才画删除。
 */
export function FileChip({ file, size = 26, onOpen, onRemove, title, onContextMenu }) {
  const k = fileKind(file.name, file.mime, file.kind);
  const bytes = file.size ? fmtBytes(file.size) : "";
  const meta = [k.label, bytes, file.meta].filter(Boolean).join(" · ");
  // 网址附件交给系统浏览器（宿主把 window.open 的 http(s) 转 openExternal），
  // 本地文件才进侧栏——点它不该把系统图片查看器叫出来
  const open =
    onOpen ||
    (file.path
      ? /^https?:/i.test(file.path)
        ? (f) => window.open(f.path, "_blank", "noopener")
        : (f) => requestFileTab(f.path)
      : null);
  const inner = (
    <>
      <span
        className={`bit-file-tile bit-file-tile--${k.tone} shrink-0`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <FileKindIcon kind={k} size={Math.round(size * 0.62)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs leading-tight">{file.name}</span>
        {meta && <span className="block truncate text-[10px] leading-tight opacity-60">{meta}</span>}
      </span>
    </>
  );
  const cls =
    "bit-file-chip flex w-full min-w-0 max-w-[240px] items-center gap-2 rounded-xl border px-2 py-1.5 text-left transition-colors";
  return (
    <span
      className="group/chip relative flex max-w-full items-center"
      onContextMenu={onContextMenu}
      data-bit-file-chip={file.name || ""}
    >
      {open ? (
        <button
          type="button"
          onClick={() => open(file)}
          title={title || `${file.name} · ${file.path || ""}`}
          className={`${cls} cursor-pointer`}
        >
          {inner}
        </button>
      ) : (
        <span className={cls} title={title || file.name}>
          {inner}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(file)}
          title={file.removeTitle}
          className="ml-0.5 shrink-0 rounded-full p-0.5 opacity-0 transition-opacity hover:text-red-500 group-hover/chip:opacity-100"
        >
          <IconX size={12} />
        </button>
      )}
    </span>
  );
}
