import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { useLang } from "../i18n";
import { IconStop, IconTerminal, IconX } from "./Icons";

/**
 * 后台 shell 作业日志弹窗：拉一次 detail 拿当前所有行，然后监听 `shell-job-log`
 * 事件增量追加，自动滚到底。任务结束后 Modal 继续显示（直到用户关），让结束态
 * 能被看到。被 ShellJobsBar 和 ChatPage 抽屉共同引用。
 */
export default function ShellLogModal({ job, onClose, onStop }) {
  const { t } = useLang();
  const [lines, setLines] = useState([]);
  const [closed, setClosed] = useState(job._ended || false);
  const [err, setErr] = useState(null);
  const unlistenRef = useRef(null);
  const autoScrollRef = useRef(true);
  const scrollerRef = useRef(null);

  // 一次性拉取详情 + 启动增量监听
  useEffect(() => {
    let alive = true;
    setLines([]);
    setClosed(!!job._ended);
    setErr(null);

    api
      .getShellDetail(job.job_id)
      .then((v) => {
        if (!alive) return;
        if (v?.logs) {
          setLines(v.logs);
        }
      })
      .catch((e) => {
        if (!alive) return;
        setErr(String(e));
      });

    let ulLog;
    let ulPhase;
    // 增量日志事件
    listen("shell-job-log", (e) => {
      if (!alive) return;
      const p = e.payload || {};
      if (p.job_id !== job.job_id) return;
      if (Array.isArray(p.lines) && p.lines.length > 0) {
        setLines((prev) => {
          const last = prev[prev.length - 1];
          if (
            last &&
            p.lines[0].ts_ms === last.ts_ms &&
            p.lines[0].stream === last.stream &&
            p.lines[0].text === last.text
          ) {
            return [...prev, ...p.lines.slice(1)];
          }
          return [...prev, ...p.lines];
        });
      }
    })
      .then((f) => (ulLog = f))
      .catch(() => {});
    // done/killed 事件 → 标记结束
    listen("shell-job", (e) => {
      if (!alive) return;
      const p = e.payload || {};
      if (p.job_id !== job.job_id) return;
      if (p.phase === "done" || p.phase === "killed" || p.phase === "error") {
        setClosed(true);
      }
    })
      .then((f) => (ulPhase = f))
      .catch(() => {});

    unlistenRef.current = () => {
      ulLog?.();
      ulPhase?.();
    };
    return () => {
      alive = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [job.job_id]);

  // 自动滚到底
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="card flex h-[70vh] w-full max-w-3xl flex-col overflow-hidden p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <IconTerminal size={14} className="shrink-0 text-sky-500" />
            <h3 className="min-w-0 truncate font-semibold">
              {t("chat.shellLog")} · <code className="text-xs">{job.job_id}</code>
            </h3>
            {closed && (
              <span className="chip shrink-0">
                {t("chat.shellLogClosed")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!closed && (
              <button
                onClick={onStop}
                className="rounded-full px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10"
                title={t("chat.shellLogStop")}
              >
                <IconStop size={11} className="mr-1 inline" />
                {t("chat.shellLogStop")}
              </button>
            )}
            <button onClick={onClose} title={t("common.close")} className="icon-btn h-7 w-7 shrink-0">
              <IconX size={14} />
            </button>
          </div>
        </div>
        <p className="mb-2 truncate text-[11px] text-neutral-500" title={job.command}>
          <code>{job.command}</code>
        </p>
        <div
          ref={scrollerRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-auto rounded-2xl bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-100"
        >
          {err ? (
            <p className="text-red-400">{err}</p>
          ) : lines.length === 0 ? (
            <p className="text-neutral-500">…</p>
          ) : (
            lines.map((l, i) => (
              <div key={i} className={l.stream === "err" ? "text-red-300" : ""}>
                <span className="mr-2 select-none text-neutral-600">
                  [{String(l.ts_ms / 1000).padStart(4, "0")}.{String(l.ts_ms % 1000).padStart(3, "0")}]
                </span>
                <span className="whitespace-pre-wrap">{l.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
