// yxpil · 记忆与技能（二合一）
// 这两页本来就是一件事的两半：记忆记"发生过什么"，技能记"会做什么"，
// 合并后左栏少一项，切换也不丢各自的过滤词与多选勾选。
// 版式与设置中心同构：左栏挑分区，右栏只给那一区的分组面板，搜索框全站同一颗。
import { useEffect, useState } from "react";
import { useLang } from "../i18n.js";
import SectionNav, { makePart } from "../components/SectionNav.jsx";
import { IconMemory, IconSkill, IconStar, IconQueue } from "../components/Icons.jsx";
import MemoryPage from "./MemoryPage.jsx";
import SkillsPage from "./SkillsPage.jsx";

const SEC_KEY = "bit.memsec";
const IDS = ["entries", "goals", "todos", "skills"];
// 存档与旧深链用的是分段名（memory / skills），认不出来一律回到记忆条目
const resolve = (v) => (v === "skills" ? "skills" : IDS.includes(v) ? v : "entries");
// 子页把「这一区此刻有没有显示」回报上来，全灭时右栏好给一句实话
const VISIBLE_KEYS = IDS.map((id) => `vis:${id}`);

export default function MemorySkillsPage({ onStats }) {
  const { t } = useLang();
  const [sec, setSec] = useState(() => resolve(localStorage.getItem(SEC_KEY)));
  const [query, setQuery] = useState("");
  // 各区条目数由子页回报：数据在子页手里，左栏只负责显示
  const [counts, setCounts] = useState({});

  const pick = (k) => {
    setSec(k);
    localStorage.setItem(SEC_KEY, k);
  };
  const report = (key, n) =>
    setCounts((c) => (c[key] === n ? c : { ...c, [key]: n }));

  // 旧页 id 的深链（bit-open-page 的 memory / skills）落到本页后直接切分区
  useEffect(() => {
    const on = (e) => pick(e?.detail?.sec === "skills" ? "skills" : "entries");
    window.addEventListener("bit-memsec", on);
    return () => window.removeEventListener("bit-memsec", on);
  }, []);

  const groups = [
    {
      key: "mem",
      head: t("mem.groupMemory"),
      HeadIcon: IconMemory,
      items: [
        { id: "entries", label: t("mem.entriesTitle"), icon: IconMemory, count: counts.entries, hits: counts["vis:entries"] },
        { id: "goals", label: t("memory.goalsTitle"), icon: IconStar, count: counts.goals, hits: counts["vis:goals"] },
        { id: "todos", label: t("memory.todosTitle"), icon: IconQueue, count: counts.todos, hits: counts["vis:todos"] },
      ],
    },
    {
      key: "skill",
      head: t("mem.groupSkills"),
      HeadIcon: IconSkill,
      items: [
        { id: "skills", label: t("mem.skillsTitle"), icon: IconSkill, count: counts.skills, hits: counts["vis:skills"] },
      ],
    },
  ];
  const flat = new Map();
  for (const g of groups) for (const it of g.items) flat.set(it.id, { ...it, head: g.head });
  const activeItem = flat.get(sec) || flat.get("entries");
  const q = query.trim().toLowerCase();
  const part = makePart(activeItem.id, q, flat);

  const descOf = {
    entries: t("memory.desc"),
    goals: t("memory.goalsDesc"),
    todos: t("memory.todosDesc"),
    skills: t("skills.desc"),
  }[activeItem.id];

  return (
    <SectionNav
      eyebrow={`${t("nav.memorySkills")} · ${activeItem.head}`}
      title={activeItem.label}
      desc={descOf}
      groups={groups}
      active={activeItem.id}
      onSelect={pick}
      query={query}
      onQuery={setQuery}
      searchPlaceholder={t("mem.find")}
      emptyText={t("common.noMatch")}
    >
      <MemoryPage onStats={onStats} part={part} report={report} />
      <SkillsPage onStats={onStats} part={part} report={report} />
      {q && VISIBLE_KEYS.every((k) => !counts[k]) && (
        <p className="rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
          {t("common.noMatch")}
        </p>
      )}
    </SectionNav>
  );
}
