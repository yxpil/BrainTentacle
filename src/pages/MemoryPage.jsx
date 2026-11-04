import { useEffect, useState } from "react";
import { api } from "../api.js";
import { IconPlus, IconMemory, IconTrash } from "../components/Icons.jsx";
import { useLang } from "../i18n.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import { listen } from "@tauri-apps/api/event";
import { Section } from "../components/SectionNav.jsx";

// 记忆页：计划目标 / 待办事项管理（可删除）+ 原始记忆（单条删除与多选批量删除）
// 三块都在「记忆与技能」的左栏分区里，一屏只给选中那一区；part/q/report 由合并页下发
export default function MemoryPage({ onStats, part, report }) {
  const { t } = useLang();
  const [memories, setMemories] = useState([]);
  const [goals, setGoals] = useState([]);
  const [todos, setTodos] = useState([]);
  const [sessionNames, setSessionNames] = useState({});
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const reload = () => {
    api.listMemories().then((r) => {
      setMemories(r.memories || []);
      report("entries", (r.memories || []).length);
      // 列表刷新后清掉已不存在的选中项
      setSelected((prev) => {
        const alive = new Set((r.memories || []).map((m) => m.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
    });
    api.listGoals().then((r) => {
      setGoals(r.goals || []);
      report("goals", (r.goals || []).filter((g) => g.status === "active").length);
    });
    api.listTodos().then((r) => {
      setTodos(r.todos || []);
      report("todos", (r.todos || []).filter((x) => x.status !== "completed").length);
    });
    // 会话标题映射：用于标注目标/待办归属的会话
    api.listSessions().then((r) => {
      const map = {};
      for (const s of r.sessions || []) map[s.id] = s.title;
      setSessionNames(map);
    });
  };
  useEffect(() => {
    reload();
    // AI 可能在任意会话里完成目标/待办：轮询 + 窗口聚焦时重拉，保证列表实时
    const timer = setInterval(reload, 3000);
    const unFocus = listen("tauri://focus", reload);
    return () => {
      clearInterval(timer);
      unFocus.then((fn) => fn());
    };
  }, []);

  const add = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await api.addMemory(content);
      setContent("");
      await reload();
      onStats?.();
    } catch (err) {
      setError(String(err));
    }
  };

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const allChecked = memories.length > 0 && selected.size === memories.length;
  const toggleAll = () =>
    setSelected(allChecked ? new Set() : new Set(memories.map((m) => m.id)));

  const removeOne = async (id) => {
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("common.confirmDelete"),
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api.deleteMemories([id]);
      await reload();
      onStats?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    if (!selected.size) return;
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("common.confirmDeleteSelected"),
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api.deleteMemories([...selected]);
      setSelected(new Set());
      await reload();
      onStats?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeGoal = async (id) => {
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("common.confirmDelete"),
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api.removeGoal(id);
      await reload();
      onStats?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeTodo = async (id) => {
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("common.confirmDelete"),
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api.removeTodo(id);
      await reload();
      onStats?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const goalStatusLabel = {
    active: t("memory.goalActive"),
    achieved: t("memory.goalAchieved"),
    abandoned: t("memory.goalAbandoned"),
  };
  const todoStatusLabel = {
    pending: t("memory.todoPending"),
    in_progress: t("memory.todoInProgress"),
    completed: t("memory.todoCompleted"),
  };

  const pEntries = part("entries", memories, (m) => [m.content, m.kind, m.source]);
  const pGoals = part("goals", goals.filter((g) => g.status === "active"), (g) => [g.title, g.detail]);
  const pTodos = part("todos", todos.filter((td) => td.status !== "completed"), (td) => [td.content]);
  // 哪几区此刻露着：合并页据此决定要不要给一句「没有匹配」
  useEffect(() => {
    report("vis:entries", pEntries.show);
    report("vis:goals", pGoals.show);
    report("vis:todos", pTodos.show);
  });

  // 行卡：分组面板里用发丝线分隔，不再各自描一圈圆角框
  const rowCls = "flex gap-3 border-b border-neutral-200/60 py-3 last:border-0 dark:border-neutral-800/60";
  const noneCls = "py-4 text-center text-sm text-neutral-400";

  return (
    <>
      {/* ── 计划目标 ── */}
      <Section show={pGoals.show}>
        {pGoals.items.length === 0 ? (
          <div className="card">
            <p className={noneCls}>{t("memory.goalEmpty")}</p>
          </div>
        ) : (
          <div className="card">
            {pGoals.items.map((g) => (
              <div key={g.id} className={`group ${rowCls}`}>
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span
                      className={`chip ${
                        g.status === "achieved"
                          ? "accent-solid"
                          : g.status === "abandoned"
                            ? "border-red-200 text-red-500"
                            : ""
                      }`}
                    >
                      {goalStatusLabel[g.status] || g.status}
                    </span>
                    {g.session_id && (
                      <span className="chip max-w-40 truncate" title={sessionNames[g.session_id] || g.session_id}>
                        {sessionNames[g.session_id] || g.session_id}
                      </span>
                    )}
                    <span className="text-xs text-neutral-400">{g.updated_ts || g.ts}</span>
                  </div>
                  <p className="text-sm font-medium">{g.title}</p>
                  {g.detail && <p className="mt-1 text-xs leading-relaxed text-neutral-500">{g.detail}</p>}
                </div>
                <button
                  title={t("common.delete")}
                  className="icon-btn mt-0.5 shrink-0 hover:bg-red-50 hover:text-red-600"
                  disabled={busy}
                  onClick={() => removeGoal(g.id)}
                >
                  <IconTrash size={15} className="mx-auto" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── 待办事项 ── */}
      <Section show={pTodos.show}>
        {pTodos.items.length === 0 ? (
          <div className="card">
            <p className={noneCls}>{t("memory.todoEmpty")}</p>
          </div>
        ) : (
          <div className="card">
            {pTodos.items.map((td) => (
              <div key={td.id} className={`group ${rowCls}`}>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span
                      className={`chip ${
                        td.status === "completed"
                          ? "accent-solid"
                          : td.status === "in_progress"
                            ? ""
                            : "border-neutral-200 text-neutral-500"
                      }`}
                    >
                      {todoStatusLabel[td.status] || td.status}
                    </span>
                    {td.session_id && (
                      <span className="chip max-w-40 truncate" title={sessionNames[td.session_id] || td.session_id}>
                        {sessionNames[td.session_id] || td.session_id}
                      </span>
                    )}
                    <span className="text-xs text-neutral-400">{td.ts}</span>
                  </div>
                  <p className="text-sm">{td.content}</p>
                </div>
                <button
                  title={t("common.delete")}
                  className="icon-btn mt-0.5 shrink-0 hover:bg-red-50 hover:text-red-600"
                  disabled={busy}
                  onClick={() => removeTodo(td.id)}
                >
                  <IconTrash size={15} className="mx-auto" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── 记忆条目 ── */}
      <Section show={pEntries.show}>
        <form onSubmit={add} className="card flex gap-2">
          <input
            className="field flex-1"
            placeholder={t("memory.placeholder")}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <button className="pill pill-hover" disabled={!content.trim()}>
            <IconPlus size={15} />
            {t("common.add")}
          </button>
        </form>
        {error && <p className="card text-xs text-red-600">{error}</p>}

        {memories.length > 0 && (
          <div className="card flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-600 select-none">
              <input
                type="checkbox"
                className="size-4 accent-neutral-800"
                checked={allChecked}
                onChange={toggleAll}
              />
              {t("common.selectAll")}
            </label>
            {selected.size > 0 && (
              <button
                className="pill-outline pill-hover ml-auto border-red-200 text-red-600 disabled:opacity-50"
                disabled={busy}
                onClick={removeSelected}
              >
                <IconTrash size={14} />
                {t("common.deleteSelected")} ({selected.size})
              </button>
            )}
          </div>
        )}

        {pEntries.items.length === 0 ? (
          <div className="card">
            <p className={`flex items-center justify-center gap-2 ${noneCls}`}>
              <IconMemory size={16} />
              {t("memory.empty")}
            </p>
          </div>
        ) : (
          <div className="card">
            {pEntries.items.map((m) => (
              <div key={m.id} className={`group ${rowCls}`}>
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-neutral-800"
                  checked={selected.has(m.id)}
                  onChange={() => toggle(m.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className={`chip ${m.kind === "summary" ? "accent-solid" : ""}`}>
                      {m.kind === "summary" ? t("memory.chipSummary") : t("memory.chipRaw")}
                    </span>
                    <span className="text-xs text-neutral-400">
                      {m.ts} · {m.source}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed">{m.content}</p>
                </div>
                <button
                  title={t("common.delete")}
                  className="icon-btn mt-0.5 shrink-0 hover:bg-red-50 hover:text-red-600"
                  disabled={busy}
                  onClick={() => removeOne(m.id)}
                >
                  <IconTrash size={15} className="mx-auto" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
