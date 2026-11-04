import { useLang } from "../i18n.js";
import { api } from "../api.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { fileKind, fmtBytes } from "./FileRef.jsx";

// 侧栏里的办公文档标签。两条路：
//   PDF —— 先看原生视觉视图（Chromium 自带 PDF 阅读器），可切「正文」看核心解析出来的文字；
//   docx/pptx/xlsx/ods —— 只有解析正文可看（没有原生渲染器），标题栏给出规模信息。
// 解析不动的文件不糊乱码：说清楚并留一个「系统程序打开」。
export default function DocPane({ tab, onView }) {
  const { t } = useLang();
  const isPdf = /\.pdf$/i.test(tab.path || "");
  const visual = isPdf && tab.view !== "text";
  const k = fileKind(tab.name || tab.path || "");
  const pill = (on) =>
    `px-2.5 py-1 text-[11px] rounded-full border transition-colors ${
      on
        ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
        : "border-neutral-200 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
    }`;

  return (
    <div data-bit-doc-pane="1" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-1.5 text-[11px] text-neutral-500 dark:border-neutral-800">
        <span className="shrink-0 font-medium">{k.label || "DOC"}</span>
        {tab.meta && (
          <span className="truncate">
            {fmtBytes(tab.meta.bytes)} · {t("chat.paneDocStats", { lines: tab.meta.lines, chars: tab.meta.chars })}
          </span>
        )}
        {isPdf && !tab.err && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button type="button" className={pill(visual)} onClick={() => onView("visual")}>
              {t("chat.paneDocVisual")}
            </button>
            <button type="button" className={pill(!visual)} onClick={() => onView("text")}>
              {t("chat.paneDocText")}
            </button>
          </span>
        )}
      </div>
      {tab.err ? (
        <div className="flex flex-col items-start gap-2 p-5 text-xs leading-relaxed text-neutral-500">
          <span>{t("chat.paneDocFailed")}</span>
          <span className="max-w-full break-all font-mono text-[11px] text-red-500">{tab.err}</span>
          <button
            type="button"
            onClick={() => api.openPath(tab.path, false).catch(() => {})}
            className="pill-outline pill-hover px-3 py-1 text-[11px]"
          >
            {t("chat.paneOpenWith")}
          </button>
        </div>
      ) : visual ? (
        // key 带路径：换标签或重新读取时重挂，别停在上一份文件上
        <iframe
          key={`${tab.path}#doc`}
          title="doc-viewer"
          src={convertFileSrc(tab.path)}
          className="h-full w-full border-0 bg-white"
        />
      ) : tab.text === null ? (
        <div className="p-5 text-xs text-neutral-500">{t("chat.parsing")}</div>
      ) : (
        <pre className="whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed">{tab.text}</pre>
      )}
    </div>
  );
}
