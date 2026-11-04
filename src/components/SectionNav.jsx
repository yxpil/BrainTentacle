// 与设置中心同一套「左列表选中 + 右侧分组」骨架：搜索框、分组小标题、选中条、
// 右栏页头与分组面板全部复用 .set-* 类。自动化工具、记忆与技能这三个管理页
// 原来是整页平铺的长卡片，读法与设置中心不一样，这里收进同一个壳子。
//
// 约定和设置中心一致：所有分区常驻挂载，非当前的只用 display 藏起来不卸载，
// 所以切分区不会丢表单草稿、勾选和滚动位置。
import { useEffect, useRef } from "react";
import SearchBox from "./SearchBox.jsx";

// 大小写不敏感的子串匹配；页面筛列表项时也用它，口径保持一致
export function hit(text, q) {
  if (!q) return true;
  return String(text ?? "")
    .toLowerCase()
    .includes(q);
}

export default function SectionNav({
  eyebrow,
  title,
  desc,
  actions = null,
  groups = [],
  active,
  onSelect,
  query = "",
  onQuery,
  searchPlaceholder,
  emptyText,
  children,
}) {
  const bodyRef = useRef(null);
  // 换区即换页：右栏滚回顶部，别带着上一页的滚动位置
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [active]);

  const q = String(query || "").trim().toLowerCase();
  // 搜索筛左栏条目：命中标题、所在分组名，或页面算好的 hits（这一区有内容命中，正文已经摊开）
  // 少了 hits 这一路，就会出现「正文有结果、左栏说没找到」的割裂
  const shown = groups
    .map((g) => {
      const items = g.items.filter((it) => hit(it.label, q) || hit(g.head, q) || it.hits);
      return { ...g, items };
    })
    .filter((g) => g.items.length > 0);

  return (
    <div className="set-shell">
      <aside className="set-nav">
        <SearchBox
          className="set-nav-search"
          value={query}
          onChange={onQuery}
          placeholder={searchPlaceholder}
        />
        <nav className="set-nav-list">
          {shown.map((g) => (
            <div key={g.key || g.head} className="set-nav-domain">
              {g.head ? (
                <p className="set-nav-head">
                  {g.HeadIcon ? <g.HeadIcon size={12} className="shrink-0 opacity-60" /> : null}
                  {g.head}
                </p>
              ) : null}
              {g.items.map((it) => {
                const Icon = it.icon;
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => onSelect(it.id)}
                    title={it.label}
                    className={`set-nav-item flex items-center gap-1.5 ${active === it.id ? "on" : ""}`}
                  >
                    {Icon ? <Icon size={13} className="shrink-0 opacity-60" /> : null}
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {typeof it.count === "number" && it.count > 0 ? (
                      <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">{it.count}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
          {shown.length === 0 && emptyText ? (
            <p className="px-2 py-2 text-xs text-neutral-400">{emptyText}</p>
          ) : null}
        </nav>
      </aside>
      <div className="set-body" ref={bodyRef}>
        <div className="set-page">
          <header className="set-head">
            {eyebrow ? <p className="set-head-eyebrow">{eyebrow}</p> : null}
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 flex-1">{title}</h2>
              {actions}
            </div>
            {desc ? <p className="set-head-desc">{desc}</p> : null}
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}

// 一个分区 = 设置中心里的一块分组面板。页面自己算 show：
// 没搜索词时等价于「左栏选中了这一区」，有词时等价于「这一区有命中条目」。
export function Section({ show, children }) {
  return (
    <section className="set-group" style={show ? undefined : { display: "none" }}>
      {children}
    </section>
  );
}

/**
 * 分区显隐与条目筛选的统一口径（自动化、工具、记忆与技能三页共用）：
 * 没搜索词——只给左栏选中的那一区，条目全出；
 * 有搜索词——条目名或分组名命中就整列摊开，否则只留命中关键词的条目，一条不中就整块藏。
 * labels 是「分区 id → { label, head }」的映射，由调用方从 groups 摊平得来。
 */
export function makePart(active, q, labels) {
  return (id, items, textOf = () => []) => {
    const info = labels.get(id) || {};
    if (!q) return { show: active === id, items };
    if (hit(info.label, q) || hit(info.head, q)) return { show: true, items };
    const keep = items.filter((it) => textOf(it).some((s) => hit(s, q)));
    return { show: keep.length > 0, items: keep };
  };
}
