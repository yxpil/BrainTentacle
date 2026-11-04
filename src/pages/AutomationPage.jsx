import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { useSubagents, patchBehavior } from "../automationStore.js";
import { useShellJobs } from "../hooks/useShellJobs.js";
import ShellLogModal from "../components/ShellLogModal.jsx";
import PillSwitch from "../components/PillSwitch.jsx";
import SectionNav, { Section, makePart } from "../components/SectionNav.jsx";
import {
  IconPlay,
  IconPause,
  IconPlus,
  IconTrash,
  IconCheck,
  IconRefresh,
  IconStop,
  IconMinus,
  IconClock,
  IconTerminal,
  IconQueue,
  IconTarget,
  IconBolt,
  IconStar,
  IconBranch,
} from "../components/Icons.jsx";
import { confirmDialog } from "../components/ConfirmHost.jsx";

/**
 * 自动化：把散在「AI 设置」行为项、「对话」委派弹层、插件清单里的定时任务
 * 这几处的东西收到一页——能开关自主执行、能建目标/待办、能看在跑的子代理和后台命令。
 * 版式与设置中心同构：左栏挑分区，右栏只给那一区的分组面板，搜索框全站同一颗。
 */
const SEC_KEY = "bit.autosec";
export default function AutomationPage({ stats, visible, onStats }) {
  const { t } = useLang();
  const [behavior, setBehavior] = useState(null);
  const [goals, setGoals] = useState([]);
  const [todos, setTodos] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [newGoal, setNewGoal] = useState({ title: "", detail: "" });
  const [newTodo, setNewTodo] = useState({ content: "", goal_id: "" });
  const [schedEdit, setSchedEdit] = useState(null); // 正在编辑定时的待办 { id, scheduled_at, schedule }
  const [logJob, setLogJob] = useState(null);
  const [sec, setSec] = useState(() => localStorage.getItem(SEC_KEY) || "engine");
  const [query, setQuery] = useState("");
  const subs = useSubagents();
  const shell = useShellJobs();

  const applyBehavior = (r) =>
    setBehavior({
      auto_drive: !!r?.auto_drive,
      auto_delegate: !!r?.auto_delegate,
      subagent_max: r?.subagent_max ?? 3,
      // 这三项归别处管（审批在页眉、内容审查在 AI 设置），写回时原样带上，别被本页覆盖
      tool_approval: r?.tool_approval || "ask",
      moderation_enabled: r?.moderation_enabled ?? true,
      compat_mode: r?.compat_mode ?? false,
    });

  const reload = async () => {
    const [b, g, td, pl] = await Promise.all([
      api.getBehaviorSettings().catch(() => null),
      api.listGoals().catch(() => null),
      api.listTodos().catch(() => null),
      api.listPlugins().catch(() => null),
    ]);
    if (b) applyBehavior(b);
    setGoals(g?.goals || []);
    setTodos(td?.todos || []);
    setJobs(
      (pl?.plugins || []).flatMap((p) =>
        (p.jobs || []).map((j) => ({ ...j, plugin: p.name, enabled: !!p.enabled }))
      )
    );
  };

  useEffect(() => {
    reload();
  }, []);
  useEffect(() => {
    if (visible) reload();
  }, [visible]);

  /** 行为项整包写回（helper 在 automationStore，与页眉的自动委派开关共用） */
  const patch = async (partial) => {
    if (!behavior) return;
    const optimistic = { ...behavior, ...partial };
    setBehavior(optimistic);
    setErr("");
    try {
      await patchBehavior(optimistic);
      reload();
      onStats?.();
    } catch (e) {
      setErr(String(e?.message || e));
      reload();
    }
  };

  const toggleAutopilot = async () => {
    setBusy(true);
    try {
      await api.toggleAutopilot();
      onStats?.();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const addGoal = async () => {
    const title = newGoal.title.trim();
    if (!title) return;
    setBusy(true);
    try {
      await api.createGoal(title, newGoal.detail.trim());
      setNewGoal({ title: "", detail: "" });
      reload();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const addTodo = async () => {
    const content = newTodo.content.trim();
    if (!content) return;
    setBusy(true);
    try {
      await api.addTodo(content, newTodo.goal_id || null);
      setNewTodo({ content: "", goal_id: "" });
      reload();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const autoRun = !!stats?.autopilot_running;

  // 左栏分区表：一条目对应右栏一块分组面板，与设置中心同构
  const NAV = [
    { key: "ctrl", head: t("auto.groupControl"), HeadIcon: IconBolt, ids: ["engine", "goals", "todos"] },
    { key: "run", head: t("auto.groupRunning"), HeadIcon: IconPlay, ids: ["subagents", "shells", "jobs"] },
  ];
  const meta = {
    engine: { label: t("auto.engine"), icon: IconTarget },
    goals: { label: t("auto.goals"), icon: IconStar },
    todos: { label: t("auto.todos"), icon: IconQueue },
    subagents: { label: t("auto.subagents"), icon: IconBranch },
    shells: { label: t("auto.shells"), icon: IconTerminal },
    jobs: { label: t("auto.pluginJobsShort"), icon: IconClock },
  };
  const flat = new Map();
  for (const g of NAV) for (const id of g.ids) flat.set(id, { id, label: meta[id].label, head: g.head });
  const activeItem = flat.get(sec) || flat.get("engine");
  const pickSec = (id) => {
    setSec(id);
    localStorage.setItem(SEC_KEY, id);
  };

  const q = query.trim().toLowerCase();
  const part = makePart(activeItem.id, q, flat);
  const P = {
    engine: part("engine", []),
    goals: part("goals", goals, (g) => [g.title, g.detail, g.status]),
    todos: part("todos", todos, (d) => [d.content, d.scheduled_at, d.schedule]),
    subagents: part("subagents", subs, (s) => [s.title, s.task, s.error]),
    shells: part("shells", shell.jobs, (j) => [j.command, j.job_id]),
    jobs: part("jobs", jobs, (j) => [j.name, j.plugin, j.schedule]),
  };
  const counts = {
    goals: goals.length,
    todos: todos.filter((x) => x.status !== "completed").length,
    subagents: subs.length,
    shells: shell.jobs.length,
    jobs: jobs.length,
  };
  // hits：这一区有没有内容命中。左栏要跟着摊开，否则正文有结果、左栏却报「没找到」
  const groups = NAV.map((g) => ({
    ...g,
    items: g.ids.map((id) => ({ id, ...meta[id], count: counts[id], hits: P[id].show })),
  }));
  const anyShow = Object.values(P).some((p) => p.show);
  const { engine: pEngine, goals: pGoals, todos: pTodos, subagents: pSubs, shells: pShells, jobs: pJobs } = P;

  const descOf = {
    engine: t("auto.engineHint"),
    goals: t("auto.goalsDesc"),
    todos: t("auto.todosDesc"),
    subagents: t("auto.subagentsDesc"),
    shells: t("auto.shellsDesc"),
    jobs: t("auto.pluginJobsHint"),
  }[activeItem.id];

  // 分区能露出来就说明它要么被选中、要么名字/条目命中了搜索词，
  // 此时列表为空是「真没有」，措辞用本区自己的空态，不谎报「没有匹配项」
  const emptyRow = (showing, blankKey) =>
    showing.length === 0 ? (
      <div className="card">
        <p className="text-xs text-neutral-400">{t(blankKey)}</p>
      </div>
    ) : null;

  return (
    <SectionNav
      eyebrow={`${t("auto.title")} · ${activeItem.head}`}
      title={activeItem.label}
      desc={descOf}
      actions={
        <button
          type="button"
          onClick={reload}
          className="pill-outline pill-hover shrink-0 gap-1.5 px-3 py-1 text-xs"
        >
          <IconRefresh size={13} /> {t("common.refresh")}
        </button>
      }
      groups={groups}
      active={activeItem.id}
      onSelect={pickSec}
      query={query}
      onQuery={setQuery}
      searchPlaceholder={t("auto.find")}
      emptyText={t("common.noMatch")}
    >
      {err && (
        <p className="shrink-0 rounded-2xl border border-red-300/60 bg-red-50/60 px-3 py-2 text-xs text-red-600 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-400">
          {err}
        </p>
      )}

      {/* ── 自主执行 ── */}
      <Section show={pEngine.show}>
        <div className="card flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-sm">{t("auto.runNow")}</span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t("auto.runNowHint")}</span>
          </span>
          <button
            type="button"
            onClick={toggleAutopilot}
            disabled={busy}
            title={autoRun ? t("auto.pauseTip") : t("auto.startTip")}
            className={`pill-hover shrink-0 gap-1.5 px-3 py-1 text-xs ${autoRun ? "pill" : "pill-outline"}`}
          >
            {autoRun ? <IconPause size={13} /> : <IconPlay size={13} />}
            {autoRun ? t("auto.pause") : t("auto.start")}
          </button>
        </div>
        {!behavior ? (
          <div className="card">
            <p className="text-xs text-neutral-400">{t("auto.loading")}</p>
          </div>
        ) : (
          <div className="card space-y-2.5">
            <label className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm">{t("auto.autoDrive")}</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t("auto.autoDriveHint")}</span>
              </span>
              <PillSwitch checked={behavior.auto_drive} onChange={(v) => patch({ auto_drive: v })} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm">{t("auto.autoDelegate")}</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t("auto.autoDelegateHint")}</span>
              </span>
              <PillSwitch checked={behavior.auto_delegate} onChange={(v) => patch({ auto_delegate: v })} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm">{t("auto.subagentMax")}</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t("auto.subagentMaxHint")}</span>
              </span>
              <input
                type="number"
                min="1"
                max="8"
                value={behavior.subagent_max}
                onChange={(e) => setBehavior((b) => ({ ...b, subagent_max: Number(e.target.value) || 1 }))}
                onBlur={(e) => patch({ subagent_max: Number(e.target.value) || 1 })}
                className="field w-20 px-3 py-1 text-right font-mono text-sm"
              />
            </label>
          </div>
        )}
      </Section>

      {/* ── 目标 ── */}
      <Section show={pGoals.show}>
        <div className="card flex flex-wrap gap-1.5">
          <input
            value={newGoal.title}
            onChange={(e) => setNewGoal((g) => ({ ...g, title: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && addGoal()}
            placeholder={t("auto.goalTitle")}
            className="field min-w-0 flex-1 px-3 py-1 text-xs"
          />
          <input
            value={newGoal.detail}
            onChange={(e) => setNewGoal((g) => ({ ...g, detail: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && addGoal()}
            placeholder={t("auto.goalDetail")}
            className="field min-w-0 flex-1 px-3 py-1 text-xs"
          />
          <button type="button" onClick={addGoal} disabled={busy || !newGoal.title.trim()} className="pill gap-1 px-3 py-1 text-xs">
            <IconPlus size={13} /> {t("common.add")}
          </button>
        </div>
        {emptyRow(pGoals.items, "auto.goalsEmpty")}
        {pGoals.items.length > 0 && (
          <ul className="card">
            {pGoals.items.map((g) => (
              <li key={g.id} className="flex items-start gap-2 border-b border-neutral-200/60 py-2.5 last:border-0 dark:border-neutral-800/60">
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm font-medium ${g.status === "achieved" ? "text-emerald-600 dark:text-emerald-400" : g.status === "abandoned" ? "text-neutral-400 line-through" : ""}`}>
                    {g.title}
                  </p>
                  <p className="truncate text-xs text-neutral-500 dark:text-neutral-400" title={g.detail}>
                    {g.detail || "—"}
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-neutral-400">
                    {g.ts} · {g.source}
                    {g.session_id ? ` · ${t("auto.fromSession")}` : ` · ${t("auto.global")}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {g.status === "active" ? (
                    <>
                      <button type="button" title={t("auto.achieved")} onClick={() => api.updateGoalStatus(g.id, "achieved").then(reload).catch((e) => setErr(String(e?.message || e)))} className="icon-btn h-7 w-7">
                        <IconCheck size={13} />
                      </button>
                      <button type="button" title={t("auto.abandoned")} onClick={() => api.updateGoalStatus(g.id, "abandoned").then(reload).catch((e) => setErr(String(e?.message || e)))} className="icon-btn h-7 w-7">
                        <IconMinus size={13} />
                      </button>
                    </>
                  ) : (
                    <button type="button" title={t("auto.reopen")} onClick={() => api.updateGoalStatus(g.id, "active").then(reload).catch((e) => setErr(String(e?.message || e)))} className="pill-outline pill-hover px-2 py-0.5 text-[11px]">
                      {t("auto.reopen")}
                    </button>
                  )}
                  <button
                    type="button"
                    title={t("common.delete")}
                    onClick={async () => {
                      if (!(await confirmDialog({ title: t("auto.delGoal"), message: g.title }))) return;
                      api.removeGoal(g.id).then(reload).catch((e) => setErr(String(e?.message || e)));
                    }}
                    className="icon-btn h-7 w-7 text-red-500"
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── 待办 ── */}
      <Section show={pTodos.show}>
        <div className="card flex flex-wrap gap-1.5">
          <input
            value={newTodo.content}
            onChange={(e) => setNewTodo((s) => ({ ...s, content: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && addTodo()}
            placeholder={t("auto.todoContent")}
            className="field min-w-0 flex-1 px-3 py-1 text-xs"
          />
          <select
            value={newTodo.goal_id}
            onChange={(e) => setNewTodo((s) => ({ ...s, goal_id: e.target.value }))}
            className="field w-auto px-3 py-1 text-xs"
          >
            <option value="">{t("auto.noGoal")}</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
          <button type="button" onClick={addTodo} disabled={busy || !newTodo.content.trim()} className="pill gap-1 px-3 py-1 text-xs">
            <IconPlus size={13} /> {t("common.add")}
          </button>
        </div>
        {emptyRow(pTodos.items, "auto.todosEmpty")}
        {pTodos.items.length > 0 && (
          <ul className="card">
            {pTodos.items.map((d) => {
              const editing = schedEdit?.id === d.id;
              return (
                <li key={d.id} className="border-b border-neutral-200/60 py-1.5 last:border-0 dark:border-neutral-800/60">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      title={d.status === "completed" ? t("auto.reopen") : t("auto.complete")}
                      onClick={() =>
                        api
                          .updateTodoStatus(d.id, d.status === "completed" ? "pending" : "completed")
                          .then(reload)
                          .catch((e) => setErr(String(e?.message || e)))
                      }
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                        d.status === "completed" ? "accent-solid border-transparent" : "border-neutral-300 dark:border-neutral-600"
                      }`}
                    >
                      {d.status === "completed" && <IconCheck size={11} strokeWidth={3} />}
                    </button>
                    <span className={`min-w-0 flex-1 truncate text-sm ${d.status === "completed" ? "text-neutral-400 line-through" : ""}`} title={d.content}>
                      {d.content}
                    </span>
                    {d.scheduled_at && <span className="chip shrink-0 font-mono text-[10px]">{d.scheduled_at}</span>}
                    {d.schedule && <span className="chip shrink-0 font-mono text-[10px]">{d.schedule}</span>}
                    {d.status === "in_progress" && <span className="chip shrink-0 text-[10px]">{t("auto.inProgress")}</span>}
                    <button
                      type="button"
                      onClick={() =>
                        setSchedEdit(
                          editing
                            ? null
                            : { id: d.id, scheduled_at: (d.scheduled_at || "").replace(" ", "T"), schedule: d.schedule || "" }
                        )
                      }
                      className={`pill-hover shrink-0 px-2 py-0.5 text-[11px] ${editing ? "pill" : "pill-outline"}`}
                    >
                      {t("auto.schedule")}
                    </button>
                    <button type="button" title={t("common.delete")} onClick={() => api.removeTodo(d.id).then(reload).catch((e) => setErr(String(e?.message || e)))} className="icon-btn h-6 w-6 shrink-0 text-red-500">
                      <IconTrash size={12} />
                    </button>
                  </div>
                  {editing && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-neutral-200/70 pt-2 dark:border-neutral-800/70">
                      <input
                        type="datetime-local"
                        value={schedEdit.scheduled_at}
                        onChange={(e) => setSchedEdit((s) => ({ ...s, scheduled_at: e.target.value }))}
                        className="field w-auto px-3 py-1 font-mono text-xs"
                      />
                      <input
                        value={schedEdit.schedule}
                        onChange={(e) => setSchedEdit((s) => ({ ...s, schedule: e.target.value }))}
                        placeholder={t("auto.scheduleHint")}
                        className="field min-w-0 flex-1 px-3 py-1 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.scheduleTodo(d.id, "set", schedEdit.scheduled_at.replace("T", " "), schedEdit.schedule);
                            setSchedEdit(null);
                            setErr("");
                            reload();
                          } catch (e) {
                            setErr(String(e?.message || e)); // 时间/文法非法要说出来，别默默失败
                          }
                        }}
                        disabled={!schedEdit.scheduled_at && !schedEdit.schedule.trim()}
                        className="pill px-3 py-1 text-xs"
                      >
                        {t("auto.scheduleSet")}
                      </button>
                      {(d.scheduled_at || d.schedule) && (
                        <button
                          type="button"
                          onClick={async () => {
                            await api.scheduleTodo(d.id, "clear").catch((e) => setErr(String(e?.message || e)));
                            setSchedEdit(null);
                            reload();
                          }}
                          className="pill-outline pill-hover px-3 py-1 text-xs"
                        >
                          {t("auto.scheduleClear")}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* ── 运行中的子代理 ── */}
      <Section show={pSubs.show}>
        {emptyRow(pSubs.items, "auto.subagentsEmpty")}
        {pSubs.items.length > 0 && (
          <ul className="card">
            {pSubs.items.map((s) => {
              const done = s.phase === "done";
              const failed = s.phase === "error";
              return (
                <li key={s.session_id} className="flex items-center gap-2 border-b border-neutral-200/60 py-2 last:border-0 dark:border-neutral-800/60">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" title={s.task || s.title || ""}>
                      {s.title || t("auto.subagent")}
                    </span>
                    <span className={`block truncate text-xs ${failed ? "text-red-500" : done ? "text-emerald-600 dark:text-emerald-400" : "text-neutral-400"}`} title={s.task || s.error || ""}>
                      {failed ? `${t("auto.subFailed")}${s.error ? `：${s.error}` : ""}` : done ? t("auto.subDone") : s.task || t("auto.subRunning")}
                    </span>
                  </span>
                  {!done && !failed && (
                    <button type="button" title={t("chat.stop")} onClick={() => api.stopSubagent(s.session_id).catch(() => {})} className="icon-btn h-7 w-7 shrink-0 text-red-500">
                      <IconStop size={12} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* ── 后台命令 ── */}
      <Section show={pShells.show}>
        {emptyRow(pShells.items, "auto.shellsEmpty")}
        {pShells.items.length > 0 && (
          <ul className="card">
            {pShells.items.map((j) => (
              <li key={j.job_id} className="flex items-center gap-2 border-b border-neutral-200/60 py-2 last:border-0 dark:border-neutral-800/60">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={j.command}>
                  {j.command || j.job_id}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-neutral-400">
                  {Math.max(0, Math.round((shell.now - j.startedAt) / 1000))}s
                </span>
                <button type="button" onClick={() => setLogJob(j)} className="pill-outline pill-hover shrink-0 px-2 py-0.5 text-[11px]">
                  {t("auto.log")}
                </button>
                <button
                  type="button"
                  title={t("chat.stop")}
                  disabled={shell.stopping.includes(j.job_id)}
                  onClick={() => shell.stopJob(j.job_id)}
                  className="icon-btn h-7 w-7 shrink-0 text-red-500 disabled:opacity-40"
                >
                  <IconStop size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── 插件声明的定时任务 ── */}
      <Section show={pJobs.show}>
        {emptyRow(pJobs.items, "auto.pluginJobsEmpty")}
        {pJobs.items.length > 0 && (
          <ul className="card">
            {pJobs.items.map((j) => (
              <li key={`${j.plugin}-${j.name}`} className="flex items-center gap-2 border-b border-neutral-200/60 py-2 last:border-0 dark:border-neutral-800/60">
                <span className="min-w-0 flex-1 truncate text-sm">{j.name}</span>
                <span className="chip shrink-0 font-mono text-[10px]">{j.schedule}</span>
                <span className={`shrink-0 text-[11px] ${j.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-neutral-400"}`}>
                  {j.enabled ? t("auto.on") : t("auto.off")}
                </span>
                <span className="shrink-0 truncate text-[11px] text-neutral-400">{j.plugin}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {q && !anyShow && (
        <p className="rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
          {t("common.noMatch")}
        </p>
      )}

      {logJob && (
        <ShellLogModal
          job={logJob}
          onClose={() => setLogJob(null)}
          onStop={() => {
            shell.stopJob(logJob.job_id);
            setLogJob(null);
          }}
        />
      )}
    </SectionNav>
  );
}
