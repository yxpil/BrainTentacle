import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api.js";
import { IconPlayTri, IconStop, IconTrash, IconWorkWith, IconX } from "../components/Icons.jsx";
import { useLang } from "../i18n.js";

const EMPTY_FORM = {
  id: "",
  name: "",
  runtime_id: "custom",
  program: "",
  args: "",
  cwd: "",
  env: "",
  port: "",
  auto_with_session: false,
};

// 本地服务托管（WorkWith）：条目 CRUD + 启停 + 实时日志 + 会话联动
export default function WorkWithPage() {
  const { t } = useLang();
  const [entries, setEntries] = useState([]);
  const [runtimes, setRuntimes] = useState([]);
  const [form, setForm] = useState(null); // null = 关闭表单
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [logId, setLogId] = useState(""); // 展开日志的条目
  const [logs, setLogs] = useState([]);
  const logBox = useRef(null);

  const reload = () =>
    api.listWorkwith().then((r) => setEntries(r.entries || [])).catch(() => {});

  useEffect(() => {
    reload();
    api.listRuntimes().then((r) => setRuntimes(r.runtimes || [])).catch(() => {});
    // 生命周期事件：任何 phase 变化都刷新列表（started/exited/killed/mcp-* 等）
    let un;
    listen("workwith", () => reload()).then((f) => (un = f)).catch(() => {});
    return () => un && un();
  }, []);

  // 展开日志时轮询（1s）；进程退出后停止轮询由事件刷新兜底
  useEffect(() => {
    if (!logId) return;
    let alive = true;
    const pull = () =>
      api.workwithLogs(logId, 400).then((r) => {
        if (!alive) return;
        setLogs(r.logs || []);
      }).catch(() => {});
    pull();
    const iv = setInterval(pull, 1000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [logId]);

  useEffect(() => {
    // 日志自动滚底
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [logs]);

  const startEdit = (e) => {
    setErr("");
    setForm({
      id: e.id,
      name: e.name,
      runtime_id: e.runtime_id || "custom",
      program: e.program,
      args: (e.args || []).join(" "),
      cwd: e.cwd || "",
      env: Object.entries(e.env || {}).map(([k, v]) => `${k}=${v}`).join("\n"),
      port: e.port ? String(e.port) : "",
      auto_with_session: !!e.auto_with_session,
    });
  };

  const submit = async (ev) => {
    ev.preventDefault();
    setErr("");
    const env = {};
    (form.env || "").split("\n").forEach((line) => {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    const entry = {
      id: form.id || "",
      name: form.name.trim(),
      runtime_id: form.runtime_id,
      program: form.program.trim(),
      args: form.args.trim().split(/\s+/).filter(Boolean),
      cwd: form.cwd.trim(),
      env,
      port: Number(form.port) || 0,
      auto_with_session: form.auto_with_session,
    };
    setBusy(true);
    try {
      await api.saveWorkwith(entry);
      setForm(null);
      await reload();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const toggleRun = async (e) => {
    setBusy(true);
    setErr("");
    try {
      if (e.status === "running") {
        await api.stopWorkwith(e.id);
      } else {
        await api.startWorkwith(e.id);
        setLogId(e.id); // 启动即展开日志，直观看服务起来没有
      }
      await reload();
    } catch (ex) {
      setErr(String(ex?.message || ex));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e) => {
    if (!window.confirm(t("ww.confirmRemove"))) return;
    setBusy(true);
    setErr("");
    try {
      if (logId === e.id) setLogId("");
      await api.removeWorkwith(e.id);
      await reload();
    } catch (ex) {
      setErr(String(ex?.message || ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("ww.title")}</h2>
          <p className="text-xs text-neutral-500">{t("ww.desc")}</p>
        </div>
        <button className="pill pill-hover shrink-0" onClick={() => { setErr(""); setForm({ ...EMPTY_FORM }); }}>
          {t("ww.add")}
        </button>
      </div>

      {err && (
        <div className="card flex items-center gap-2 border-red-200 py-3 text-sm text-red-600">
          {err}
          <button className="icon-btn ml-auto h-6 w-6 hover:bg-red-50" onClick={() => setErr("")}>
            <IconX size={13} className="mx-auto" />
          </button>
        </div>
      )}

      {form && (
        <form onSubmit={submit} className="card flex flex-col gap-3">
          <div className="text-sm font-semibold">{form.id ? t("ww.edit") : t("ww.add")}</div>
          <div className="grid grid-cols-2 gap-3">
            <input className="field" placeholder={t("ww.namePlaceholder")} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <select className="field" value={form.runtime_id}
              onChange={(e) => setForm({ ...form, runtime_id: e.target.value })}>
              <option value="custom">{t("ww.runtimeCustom")}</option>
              {runtimes.filter((r) => r.enabled).map((r) => (
                <option key={r.id} value={r.id}>{r.name}（{r.id}）</option>
              ))}
            </select>
          </div>
          <input className="field" placeholder={t("ww.programPlaceholder")} value={form.program}
            onChange={(e) => setForm({ ...form, program: e.target.value })} required />
          <div className="grid grid-cols-2 gap-3">
            <input className="field" placeholder={t("ww.argsPlaceholder")} value={form.args}
              onChange={(e) => setForm({ ...form, args: e.target.value })} />
            <input className="field" placeholder={t("ww.cwdPlaceholder")} value={form.cwd}
              onChange={(e) => setForm({ ...form, cwd: e.target.value })} />
          </div>
          <textarea className="field !rounded-2xl min-h-[60px] resize-y"
            rows={2} placeholder={t("ww.envPlaceholder")}
            value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <span className="shrink-0 text-neutral-600">{t("ww.port")}</span>
              <input type="number" min="0" max="65535" className="field w-28" value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
              <input type="checkbox" className="size-4 accent-neutral-800" checked={form.auto_with_session}
                onChange={(e) => setForm({ ...form, auto_with_session: e.target.checked })} />
              {t("ww.auto")}
            </label>
          </div>
          <p className="text-xs text-neutral-400">{t("ww.autoHint")}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="pill-outline pill-hover" onClick={() => setForm(null)}>{t("ww.cancel")}</button>
            <button className="pill pill-hover" disabled={busy || !form.name.trim() || !form.program.trim()}>
              {t("ww.save")}
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-col gap-2.5">
        {entries.map((e) => {
          const running = e.status === "running";
          return (
            <div key={e.id} className="card py-4">
              <div className="flex items-start gap-3">
                <IconWorkWith size={18} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* 状态点：绿=运行中，灰=已停止 */}
                    <span className={`inline-block size-2 shrink-0 rounded-full ${running ? "bg-green-500" : "bg-neutral-300"}`} />
                    <span className="font-semibold break-all" style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>{e.name}</span>
                    {running && <span className="chip">{t("ww.running")} · {e.pid}</span>}
                    {running && e.port > 0 && <span className="chip">{t("ww.linked")}</span>}
                    {e.auto_with_session && <span className="chip">{t("ww.auto")}</span>}
                  </div>
                  <p className="mt-1 text-sm text-neutral-600 break-all" style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>
                    {e.runtime_id === "custom" ? "" : `${e.runtime_id} · `}{e.program}
                    {(e.args || []).length > 0 && ` ${e.args.join(" ")}`}
                    {e.port > 0 && `  ·  :${e.port}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {running ? (
                    <button title={t("ww.stop")} disabled={busy}
                      className="icon-btn hover:bg-neutral-100 hover:text-red-600"
                      onClick={() => toggleRun(e)}>
                      <IconStop size={14} className="mx-auto" />
                    </button>
                  ) : (
                    <button title={t("ww.start")} disabled={busy}
                      className="icon-btn hover:bg-green-50 hover:text-green-600"
                      onClick={() => toggleRun(e)}>
                      <IconPlayTri size={14} className="mx-auto" />
                    </button>
                  )}
                  <button title={t("ww.edit")} disabled={busy || running}
                    className="icon-btn text-sm disabled:opacity-40"
                    onClick={() => startEdit(e)}>
                    ✎
                  </button>
                  <button title={t("common.delete")} disabled={busy}
                    className="icon-btn hover:bg-red-50 hover:text-red-600"
                    onClick={() => remove(e)}>
                    <IconTrash size={15} className="mx-auto" />
                  </button>
                </div>
              </div>
              {logId === e.id && (
                <div className="mt-3">
                  <div className="mb-1 flex items-center gap-2 text-xs text-neutral-400">
                    {t("ww.logs")}
                    <button className="icon-btn ml-auto h-6 w-6 hover:bg-neutral-100" onClick={() => setLogId("")}>
                      <IconX size={12} className="mx-auto" />
                    </button>
                  </div>
                  <pre ref={logBox}
                    className="max-h-56 overflow-y-auto rounded-2xl bg-neutral-100 p-3 text-xs leading-5 whitespace-pre-wrap break-all dark:bg-neutral-800 dark:text-neutral-200">
                    {logs.length === 0
                      ? <span className="text-neutral-400">{t("ww.noLogs")}</span>
                      : logs.map((l, i) => (
                          <span key={i} className={l.stream === "err" ? "text-red-500 dark:text-red-400" : ""}>
                            {l.text}{"\n"}
                          </span>
                        ))}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
        {entries.length === 0 && !form && (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
            <IconWorkWith size={16} />
            {t("ww.empty")}
          </div>
        )}
      </div>
    </div>
  );
}
