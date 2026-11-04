import { useEffect, useState } from "react";
import { api } from "../api.js";
import { IconPlus, IconSkill, IconTrash } from "../components/Icons.jsx";
import { useLang } from "../i18n.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import { Section } from "../components/SectionNav.jsx";

// 技能（SKILL）：Autopilot 从总结记忆中自动提炼，也可手动沉淀；支持单条删除与多选批量删除
// 分区显隐与搜索过滤的口径由「记忆与技能」合并页下发（part / q / report）
export default function SkillsPage({ onStats, part, report }) {
  const { t } = useLang();
  const [skills, setSkills] = useState([]);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const reload = () =>
    api.listSkills().then((r) => {
      setSkills(r.skills || []);
      report("skills", (r.skills || []).length);
      // 列表刷新后清掉已不存在的选中项
      setSelected((prev) => {
        const alive = new Set((r.skills || []).map((s) => s.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
    });
  useEffect(() => {
    reload();
  }, []);

  const add = async (e) => {
    e.preventDefault();
    try {
      await api.addSkill(name, summary);
      setName("");
      setSummary("");
      await reload();
      onStats?.();
    } catch {
      // 表单已做必填校验
    }
  };

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const allChecked = skills.length > 0 && selected.size === skills.length;
  const toggleAll = () =>
    setSelected(allChecked ? new Set() : new Set(skills.map((s) => s.id)));

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
    try {
      await api.deleteSkills([id]);
      await reload();
      onStats?.();
    } catch {
      // 删除失败静默，列表会保持原状
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
    try {
      await api.deleteSkills([...selected]);
      setSelected(new Set());
      await reload();
      onStats?.();
    } catch {
      // 同上
    } finally {
      setBusy(false);
    }
  };

  const pSkills = part("skills", skills, (s) => [s.name, s.summary, s.source]);
  useEffect(() => {
    report("vis:skills", pSkills.show);
  });

  return (
    <Section show={pSkills.show}>
      {/* 与记忆页的添加行同构：一行两栏 + 按钮，窄屏自动换行 */}
      <form onSubmit={add} className="card flex flex-wrap gap-2">
        <input className="field min-w-[10rem] flex-1 basis-40" placeholder={t("skills.namePlaceholder")} value={name}
          onChange={(e) => setName(e.target.value)} required />
        <input className="field min-w-0 flex-[2] basis-56" placeholder={t("skills.summaryPlaceholder")} value={summary}
          onChange={(e) => setSummary(e.target.value)} required />
        <button className="pill pill-hover shrink-0" disabled={!name.trim() || !summary.trim()}>
          <IconPlus size={15} />
          {t("common.add")}
        </button>
      </form>

      {skills.length > 0 && (
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

      {pSkills.items.length === 0 ? (
        <div className="card">
          <p className="flex items-center justify-center gap-2 py-4 text-center text-sm text-neutral-400">
            <IconSkill size={16} />
            {t("skills.empty")}
          </p>
        </div>
      ) : (
        <div className="card">
          {pSkills.items.map((s) => (
            <div
              key={s.id}
              className="flex items-start gap-3 border-b border-neutral-200/60 py-3 last:border-0 dark:border-neutral-800/60"
            >
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-neutral-800"
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
              />
              <IconSkill size={18} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{s.name}</span>
                  <span className="chip">{s.source}</span>
                </div>
                <p className="mt-1 text-sm text-neutral-600">{s.summary}</p>
                <p className="mt-1 text-xs text-neutral-400">{s.ts}</p>
              </div>
              <button
                title={t("common.delete")}
                className="icon-btn mt-0.5 shrink-0 hover:bg-red-50 hover:text-red-600"
                disabled={busy}
                onClick={() => removeOne(s.id)}
              >
                <IconTrash size={15} className="mx-auto" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
