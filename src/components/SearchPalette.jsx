import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { subscribePluginSettings, getPluginSettingsView } from "../pluginHost.js";
import { DOMAIN_META, settingsCards, matchSettings } from "../settingsCatalog.js";
import { IconStarSolid, IconPuzzle } from "./Icons.jsx";
import SearchBox from "./SearchBox.jsx";

const PLATFORM = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toString();
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(PLATFORM);
/** 快捷键文案：页眉按钮 title 与面板底部提示共用，避免两处写死 */
export const searchHotkey = IS_MAC ? "⌘K / ⌘F" : "Ctrl K / Ctrl F";

/**
 * 全局悬浮搜索：Ctrl/Cmd+K（或 Ctrl/Cmd+F）唤起，按标题 + 正文搜会话，
 * 同时命中设置中心的卡片（点结果直接落到那张卡）。
 * 会话命中后只广播 bit-open-session，切会话的动作仍由 ChatPage 自己做——
 * 会话状态、消息加载、审批监听都在 ChatPage 里，这里不该复制那份逻辑。
 */
export default function SearchPalette({ onPick, onOpenSettings }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [all, setAll] = useState([]);
  const [hits, setHits] = useState(null);
  const [idx, setIdx] = useState(0);
  const listRef = useRef(null);
  // 设置卡片来自运行期清单（插件会注入自己的卡片），订阅后才能跟着启用/停用刷新
  const pluginView = useSyncExternalStore(subscribePluginSettings, getPluginSettingsView);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && !e.shiftKey && /^(k|f)$/i.test(e.key || "")) {
        e.preventDefault();
        setOpen((v) => !v); // 同一键再按一次收起，符合命令面板直觉
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("bit-open-search", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("bit-open-search", onOpen);
    };
  }, []);

  // 每次唤起都回到干净状态：空查询先铺最近会话，避免打开是一片空白。
  // 焦点交给 input 的 autoFocus——面板关闭时整棵树卸载，重开即重新挂载，
  // 而 rAF 里 focus() 在窗口被遮挡时根本不回调（Chromium 节流），会开出一个没光标的框
  useEffect(() => {
    if (!open) return;
    setQ("");
    setHits(null);
    setIdx(0);
    api
      .listSessions()
      // 插件会话也要能搜到；只有完全空的（插件建了没用上）不占位
      .then((r) =>
        setAll((r?.sessions || []).filter((s) => !String(s.id || "").startsWith("plugin:") || s.count > 0)),
      )
      .catch(() => setAll([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim().toLowerCase();
    if (!term) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchSessions(term)
        .then((r) => setHits((r && r.hits) || {}))
        .catch(() => setHits(null));
    }, 200);
    return () => clearTimeout(timer);
  }, [q, open]);

  // 设置卡片与设置中心左栏共用一份关键词表，所以「查找设置」能搜到的词这里一样能搜到
  const settingsHits = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return matchSettings(settingsCards(pluginView.cards), term, t).slice(0, 6);
  }, [q, pluginView, t]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) {
      return all.slice(0, 30).map((s) => ({
        kind: "session",
        id: s.id,
        title: s.title,
        favorite: s.favorite,
        plugin: String(s.id || "").startsWith("plugin:"),
      }));
    }
    const out = settingsHits.map((c) => ({
      kind: "settings",
      id: c.id,
      title: t(c.label),
      hint: t(DOMAIN_META[c.domain]?.label || ""),
    }));
    // 插件会话不再排除：唤回注入的回复就在 plugin:<id> 里，搜不到等于丢了对话
    for (const id of Object.keys(hits || {})) {
      const s = all.find((x) => x.id === id);
      out.push({
        kind: "session",
        id,
        title: s?.title || "",
        favorite: s?.favorite,
        plugin: String(id).startsWith("plugin:"),
        snippet: hits[id]?.snippet,
        role: hits[id]?.role,
      });
    }
    return out;
  }, [q, hits, all, settingsHits, t]);

  const settingsCount = q.trim() ? settingsHits.length : 0;

  const pick = (row) => {
    if (!row) return;
    setOpen(false);
    // 设置项直接跳卡片；会话仍交给 ChatPage 装载（状态/审批监听都在那边）
    if (row.kind === "settings") {
      onOpenSettings?.(row.id);
      return;
    }
    onPick?.();
    window.dispatchEvent(new CustomEvent("bit-open-session", { detail: { id: row.id } }));
  };

  useEffect(() => {
    // 分组标题也渲染在列表里，按 data-row 定位，别让标题把索引挤歪
    listRef.current?.querySelector(`[data-row="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx, rows.length]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/25 px-4"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="search-panel card mt-[9vh] flex max-h-[min(62vh,32rem)] w-[min(94vw,34rem)] flex-col overflow-hidden p-0"
        style={{ borderRadius: "var(--look-ui-radius, 1.5rem)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 与设置中心左栏同一套无框搜索行：图标 + 透明输入，不再在面板里套一层输入框 */}
        <SearchBox
          className="shrink-0 px-3 py-2.5"
          size={15}
          autoFocus
          showClear={false}
          value={q}
          onChange={(v) => {
            setQ(v);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(rows.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(rows[Math.min(idx, rows.length - 1)]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={t("search.placeholder")}
          inputClass="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
          right={<kbd className="chip shrink-0 px-2 py-0 font-mono text-[10px]">Esc</kbd>}
        />

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
          {rows.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-neutral-400 dark:text-neutral-500">
              {t("search.noMatch")}
            </div>
          )}
          {rows.map((r, i) => (
            <Fragment key={`${r.kind}:${r.id}`}>
              {/* 有设置命中就加「设置」小标题；「会话」标题只在两组都有结果时出现 */}
              {settingsCount > 0 && i === 0 && (
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {t("search.settings")}
                </p>
              )}
              {settingsCount > 0 && i === settingsCount && (
                <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {t("search.sessions")}
                </p>
              )}
              <button
                data-row={i}
                type="button"
                onMouseEnter={() => setIdx(i)}
                onClick={() => pick(r)}
                className={`flex w-full flex-col gap-0.5 rounded-2xl px-3 py-2 text-left transition-colors ${
                  i === idx ? "accent-solid" : "hover:bg-neutral-900/5 dark:hover:bg-white/5"
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {r.kind === "session" && r.favorite && (
                    <IconStarSolid size={10} className={`shrink-0 ${i === idx ? "" : "text-amber-400"}`} />
                  )}
                  {r.kind === "session" && r.plugin && (
                    <IconPuzzle
                      size={11}
                      title={t("chat.pluginSession", { id: String(r.id).replace(/^plugin:/, "").split(":")[0] })}
                      className={`shrink-0 ${i === idx ? "" : "opacity-70"}`}
                    />
                  )}
                  <span className="truncate text-[13px] font-medium">{r.title || r.id || t("chat.newChat")}</span>
                  {r.kind === "settings" && r.hint && (
                    <span
                      className={`ml-auto shrink-0 text-[10px] ${
                        i === idx ? "opacity-80" : "text-neutral-400 dark:text-neutral-500"
                      }`}
                    >
                      {r.hint}
                    </span>
                  )}
                </span>
                {r.kind === "session" && r.snippet && (
                  <span
                    title={r.snippet}
                    className={`truncate text-[10px] leading-tight ${
                      i === idx ? "opacity-80" : "text-neutral-400 dark:text-neutral-500"
                    }`}
                  >
                    …{r.snippet}
                  </span>
                )}
              </button>
            </Fragment>
          ))}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-neutral-200 px-3 py-1.5 text-[10px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
          <span>{t("search.navHint")}</span>
          <span>
            {q.trim() ? `${rows.length} · ` : ""}
            {searchHotkey}
          </span>
        </div>
      </div>
    </div>
  );
}
