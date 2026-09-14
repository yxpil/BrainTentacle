import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { useLang } from "../i18n";
import { IconStop, IconTerminal, IconX } from "./Icons";

/**
 * 后台长命令状态条（挂在聊天页输入框上方，子代理状态条之下）。
 * 数据来自后端 shellbg：shell 命令超过前台窗口仍没跑完时自动转后台并广播
 * `shell-job`（started / done / killed）事件；这里实时展示命令、运行时长，
 * 并提供逐条「停止」按钮。空态不占位，只在有命令在跑时出现。
 *
 * 点击 job 区域打开日志弹窗（ShellLogModal），后端通过 `shell-job-log` 事件
 * 持续推送增量输出（每 500ms / 每 20 行节流）。
 */
export default function ShellJobsBar() {
  const { t } = useLang();
  const [jobs, setJobs] = useState([]); // [{ job_id, command, session_id, startedAt(本地 ms) }]
  const [stopping, setStopping] = useState([]); // 已请求停止、等待 killed 事件确认的 job
  const [now, setNow] = useState(Date.now());
  const [logJob, setLogJob] = useState(null); // 当前打开日志弹窗的 job

  // 初始状态（进程重启后仍可能在跑的作业）+ 事件订阅
  useEffect(() => {
    let alive = true;
    let unlisten;
    api
      .listRunningShells()
      .then((arr) => {
        if (!alive || !Array.isArray(arr)) return;
        setJobs(
          arr.map((j) => ({
            job_id: j.job_id,
            command: j.command,
            session_id: j.session_id,
            startedAt: Date.now() - (j.elapsed_ms || 0),
          }))
        );
      })
      .catch(() => {});
    listen("shell-job", (e) => {
      if (!alive) return;
      const p = e.payload || {};
      if (p.phase === "started") {
        const existing = p.job_id;
        setJobs((prev) => {
          if (prev.some((j) => j.job_id === existing)) return prev;
          return [
            ...prev,
            {
              job_id: p.job_id,
              command: p.command || "",
              session_id: p.session_id,
              startedAt: Date.now(),
            },
          ];
        });
      } else if (p.phase === "done" || p.phase === "killed" || p.phase === "error") {
        setJobs((prev) => prev.filter((j) => j.job_id !== p.job_id));
        // 如果弹窗正看这个 job，通知已结束（让 Modal 自动显示 end state）
        setLogJob((cur) => (cur && cur.job_id === p.job_id ? { ...cur, _ended: true } : cur));
      }
    })
      .then((f) => {
        unlisten = f;
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, []);

  // 每秒刷新运行时长
  useEffect(() => {
    if (jobs.length === 0) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [jobs.length]);

  if (jobs.length === 0) return null;

  const stopJob = async (jid) => {
    setStopping((s) => [...s, jid]);
    try {
      await api.cancelShell(jid);
    } catch (e) {
      console.warn("cancel shell failed:", e);
      setStopping((s) => s.filter((x) => x !== jid));
    }
  };

  const fmt = (startedAt) => {
    const s = Math.max(0, Math.floor((now - startedAt) / 1000));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return mm > 0 ? `${mm}m${ss}s` : `${ss}s`;
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-sky-200 bg-sky-50/70 px-2.5 py-1.5 text-xs dark:border-sky-900/50 dark:bg-sky-950/40">
        <span
          className="flex shrink-0 items-center gap-1 font-medium text-sky-700 dark:text-sky-300"
          title={t("chat.bgShellHint")}
        >
          <IconTerminal size={14} className="animate-pulse" />
          {t("chat.bgShells")}
        </span>
        {jobs.map((j) => (
          <span
            key={j.job_id}
            onClick={() => setLogJob(j)}
            className="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-lg bg-white px-1.5 py-0.5 ring-1 ring-neutral-200 hover:ring-sky-400 dark:bg-neutral-800 dark:ring-neutral-700 dark:hover:ring-sky-600"
            title={`${j.job_id} · ${j.command}\n${t("chat.bgLogClickHint") || "点击查看实时日志"}`}
          >
            <code className="max-w-[40vw] truncate font-mono text-[11px]">{j.command}</code>
            <span className="shrink-0 tabular-nums text-neutral-400">{fmt(j.startedAt)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                stopJob(j.job_id);
              }}
              disabled={stopping.includes(j.job_id)}
              title={`${t("chat.stop")} ${j.job_id}`}
              className="shrink-0 rounded p-0.5 text-neutral-400 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
            >
              {stopping.includes(j.job_id) ? (
                <span className="text-[10px]">…</span>
              ) : (
                <IconStop size={11} />
              )}
            </button>
          </span>
        ))}
      </div>
      {logJob && (
        <ShellLogModal
          job={logJob}
          onClose={() => setLogJob(null)}
          onStop={() => stopJob(logJob.job_id)}
        />
      )}
    </>
  );
}

/**
 * 后台 shell 作业日志弹窗：拉一次 detail 拿当前所有行，然后监听 `shell-job-log`
 * 事件增量追加，自动滚到底。任务结束后 Modal 继续显示（直到用户关），让结束态
 * 能被看到。
 */
function ShellLogModal({ job, onClose, onStop }) {
  const { t } = useLang();
  const [lines, setLines] = useState([]);
  const [closed, setClosed] = useState(job._ended || false);
  const [err, setErr] = useState(null);
  const unlistenRef = useRef(null);
  const autoScrollRef = useRef(true);
  const scrollerRef = useRef(null);
  const fetchedRef = useRef(job.job_id);

  // 一次性拉取详情 + 启动增量监听
  useEffect(() => {
    let alive = true;
    fetchedRef.current = job.job_id;
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
          // 防重复：按 ts_ms + stream 去重
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
              <span className="shrink-0 rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                {t("chat.shellLogClosed")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!closed && (
              <button
                onClick={onStop}
                className="rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-500/10"
                title={t("chat.shellLogStop")}
              >
                <IconStop size={11} className="mr-1 inline" />
                {t("chat.shellLogStop")}
              </button>
            )}
            <button onClick={onClose} title={t("common.close")} className="rounded p-1 hover:bg-neutral-200 dark:hover:bg-neutral-700">
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
          className="min-h-0 flex-1 overflow-auto rounded-xl bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-100"
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
