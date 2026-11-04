import { useState } from "react";
import { useLang } from "../i18n.js";
import { api } from "../api.js";
import { fileKind, fmtBytes, requestFileTab, FileKindIcon } from "./FileRef.jsx";

// 聊天内文件卡片：智能体 send_file 发来的文件，如同收到一条文件消息。
// 可在右侧栏预览（办公文档交核心解析），也可用系统默认程序打开或定位到所在文件夹。
export default function FileCard({ path, bytes, note, onContextMenu }) {
  const { t } = useLang();
  const [err, setErr] = useState("");
  const name = (path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path || "";
  // 类型图标与配色复用附件卡那一份映射：send_file 发来的 pdf 与拖进去的 pdf 长一样
  const k = fileKind(name);
  const size = fmtBytes(bytes);
  const open = async (reveal) => {
    try {
      setErr("");
      await api.openPath(path, reveal);
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="flex max-w-[85%] flex-col gap-1">
      <div
        data-bit-file-card={name}
        onContextMenu={onContextMenu}
        className="flex items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-3.5 py-2.5 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <span className={`bit-file-tile bit-file-tile--${k.tone} h-9 w-9 shrink-0 rounded-xl`}>
          <FileKindIcon kind={k} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{name}</div>
          <div className="truncate text-[11px] text-neutral-400">
            {t("filecard.fromAgent")}
            {k.label ? ` · ${k.label}` : ""}
            {size ? ` · ${size}` : ""}
            {note ? ` · ${note}` : ""}
          </div>
        </div>
        <button
          onClick={() => requestFileTab(path)}
          className="pill-outline pill-hover"
        >
          {t("filecard.preview")}
        </button>
        <button
          onClick={() => open(false)}
          className="pill pill-hover"
        >
          {t("filecard.open")}
        </button>
        <button
          onClick={() => open(true)}
          className="pill-outline pill-hover"
        >
          {t("filecard.reveal")}
        </button>
      </div>
      {err && <div className="px-1 text-[11px] text-red-500">{err}</div>}
    </div>
  );
}
