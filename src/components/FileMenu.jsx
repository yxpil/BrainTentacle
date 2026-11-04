import { useEffect, useState } from "react";
import { useLang } from "../i18n.js";
import { api } from "../api.js";
import { IconMenu } from "./IconRow.jsx";
import { fileKind, fmtBytes, requestFileTab, FileKindIcon } from "./FileRef.jsx";

const isRemote = (p) => /^https?:\/\//i.test(p || "");

// 卡片上只有路径与字节数（send_file 那条链路），右键菜单要的是同一个 file 形状
export function fileFromPath(path, bytes) {
  const name = String(path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path || "";
  return { name, path, size: typeof bytes === "number" ? bytes : 0 };
}

// 桥接层错误带 “Error invoking remote method '…': Error:” 前缀，详情里只留人话
const cleanErr = (e) => {
  const raw = String((e && e.message) || e || "");
  const m = /Error invoking remote method '[^']+':\s*([\s\S]*)$/.exec(raw);
  const msg = (m ? m[1] : raw).replace(/^Error:\s*/, "").trim() || raw;
  const tag = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(msg);
  return tag ? tag[2] : msg;
};

/**
 * 文件右键菜单：预览 / 打开 / 打开所在位置 / 查看详情 / 复制路径。
 * 没有本地路径的（粘贴进来的临时件、网址）该灰就灰，并把原因写在同一行，
 * 别让用户点了没反应再猜。
 */
export function FileMenu({ file, x, y, onClose, onDetails }) {
  const { t } = useLang();
  const local = !!file.path && !isRemote(file.path);
  const why = local ? "" : ` · ${t("filemenu.needPath")}`;
  const items = [
    { key: "name", label: file.name, disabled: true },
    local
      ? { key: "preview", label: t("filemenu.preview"), onSelect: () => requestFileTab(file.path) }
      : { key: "preview", label: t("filemenu.preview") + why, disabled: true },
    local
      ? { key: "open", label: t("filemenu.open"), onSelect: () => api.openPath(file.path, false).catch(() => {}) }
      : { key: "open", label: t("filemenu.open") + why, disabled: true },
    local
      ? { key: "reveal", label: t("filemenu.reveal"), onSelect: () => api.openPath(file.path, true).catch(() => {}) }
      : { key: "reveal", label: t("filemenu.reveal") + why, disabled: true },
    { key: "details", label: t("filemenu.details"), onSelect: () => onDetails(file) },
    {
      key: "copy",
      label: t("filemenu.copyPath"),
      onSelect: () => {
        const v = file.path || file.name || "";
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(v).catch(() => {});
      },
    },
  ];
  return <IconMenu x={x} y={y} items={items} onClose={onClose} />;
}

/// 一行「键 : 值」；值可能是长路径，允许换行与选中复制
function Row({ k, v, mono }) {
  return (
    <div className="flex items-start gap-3 border-b border-neutral-100 py-2 text-xs last:border-0 dark:border-neutral-800">
      <span className="w-20 shrink-0 text-neutral-400 dark:text-neutral-500">{k}</span>
      <span className={`min-w-0 flex-1 break-all text-neutral-700 dark:text-neutral-200 ${mono ? "font-mono" : ""}`}>{v}</span>
    </div>
  );
}

/**
 * 查看详情：大小、修改时间、类型、能不能解析（能解析就顺带报行数与字数）、完整路径。
 * 粘贴件没有路径，就只报卡片上已知的那点信息，并说清为什么读不到更多。
 */
export function FileDetails({ file, onClose }) {
  const { t } = useLang();
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState("");
  const local = !!file.path && !isRemote(file.path);

  useEffect(() => {
    const k = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    if (!local) {
      setInfo({ name: file.name, bytes: file.size || 0, parsable: false, noPath: true, path: file.path || "" });
      return () => {
        alive = false;
      };
    }
    api
      .statPath(file.path)
      .then(async (s) => {
        if (s.parsable) {
          try {
            const e = await api.extractPath(file.path);
            s.lines = e.lines;
            s.chars = e.chars;
          } catch (x) {
            s.parseError = cleanErr(x);
          }
        }
        if (alive) setInfo(s);
      })
      .catch((e) => alive && setErr(cleanErr(e)));
    return () => {
      alive = false;
    };
    // file.path 变了才重查（同一张卡不重复 stat）
  }, [file.path, local]);

  const k = fileKind(file.name, file.mime, file.kind);
  const parseLine = () => {
    if (!info) return t("filemenu.loading");
    if (info.noPath) return t("filemenu.noPathDetail");
    // 插件登记并负责解析的类型：说清楚是谁读的，用户才知道装了哪个插件才有这份正文
    const by = info.parsed_by?.parses ? t("filemenu.parsedBy", { plugin: info.parsed_by.plugin_name }) : "";
    if (info.lines !== undefined) {
      const own = t("filemenu.parsable", { lines: info.lines, chars: info.chars });
      return by ? `${own} · ${by}` : own;
    }
    if (info.parseError) return info.parseError;
    if (info.parsable) return t("filemenu.parsableUnknown");
    return info.parsed_by ? t("filemenu.iconBy", { plugin: info.parsed_by.plugin_name }) : t("filemenu.unparsable");
  };

  return (
    <>
      <div className="fixed inset-0 z-[72] bg-black/40" onClick={onClose} />
      <div
        data-bit-file-details="1"
        className="card anim-pop fixed left-1/2 top-1/2 z-[73] flex max-h-[80vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--look-ui-radius,1rem)]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <span className={`bit-file-tile bit-file-tile--${k.tone} h-7 w-7 shrink-0 rounded-lg`}>
            <FileKindIcon kind={k} size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
          <button type="button" onClick={onClose} className="icon-btn h-7 w-7" title={t("common.close")}>
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {err && <div className="px-1 py-2 text-xs text-red-500">{err}</div>}
          <Row k={t("filemenu.fieldType")} v={k.label || "—"} />
          <Row k={t("filemenu.fieldSize")} v={info ? fmtBytes(info.bytes) : fmtBytes(file.size || 0)} />
          <Row k={t("filemenu.fieldModified")} v={info && info.modified ? info.modified : "—"} />
          <Row k={t("filemenu.fieldParse")} v={parseLine()} />
          <Row k={t("filemenu.fieldPath")} v={file.path || "—"} mono />
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
          {local && (
            <button
              type="button"
              onClick={() => api.openPath(file.path, true).catch(() => {})}
              className="pill-outline pill-hover px-3 py-1 text-[11px]"
            >
              {t("filemenu.reveal")}
            </button>
          )}
          {local && (
            <button
              type="button"
              onClick={() => {
                // 预览开在右侧栏，弹窗不关掉正好把栏挡住：先收窗口再看文件
                onClose();
                requestFileTab(file.path);
              }}
              className="pill pill-hover px-3 py-1 text-[11px]"
            >
              {t("filemenu.preview")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * 给任意「代表一个文件的元素」挂上右键菜单 + 详情弹窗。
 * 用法：`const menu = useFileMenu(); <div onContextMenu={menu.open(file)}>{menu.node()}</div>`
 * 同一时刻只开一层（菜单关掉才谈详情），组件不必自己管坐标与关闭。
 */
export function useFileMenu() {
  const [menu, setMenu] = useState(null);
  const [detail, setDetail] = useState(null);
  return {
    open: (file) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDetail(null);
      setMenu({ file, x: e.clientX, y: e.clientY });
    },
    node: () =>
      menu ? (
        <FileMenu
          file={menu.file}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onDetails={(f) => {
            setMenu(null);
            setDetail(f);
          }}
        />
      ) : null,
    detailNode: () => (detail ? <FileDetails file={detail} onClose={() => setDetail(null)} /> : null),
  };
}
