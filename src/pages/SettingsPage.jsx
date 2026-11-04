// yxpil · 设置中心
// 左栏一张卡片 = 一组设置 = 右屏一屏内容。
// 早先是「4 个域 + 域下若干行小字锚点」，点锚点在同一条 4000px 长页里滚动定位，
// 找一项设置要先认域、再在子项里挑、再滚——三级迷宫。现在域只是卡片上的小标题，
// 每组自己就是一张卡片，点中只渲染那一组，不再滚动跳转。
//
// 五个域组件仍常驻挂载（只切 display）：远程页的在途保存、AI 页的模型列表拉取
// 不该因为换一张卡就丢；域内部同理，非当前的 .set-group 也只藏不卸载。
// 最后一个域是"插件"：条目由插件清单的 settings 段注入（也可由 JS 插件用
// api.registerSettingsPage 自己登记），点开展示插件的设置页——iframe 页或 React 组件，
// 两者都没有时退回宿主的键值面板。域和卡片都是运行时才知道有没有，所以不进 CARDS。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLang } from "../i18n.js";
import AiSettingsPage from "./AiSettingsPage.jsx";
import ThemePage from "./ThemePage.jsx";
import I18nPage from "./I18nPage.jsx";
import SecurityPage from "./SecurityPage.jsx";
import RemotePage from "./RemotePage.jsx";
import PluginPermsPage from "./PluginPermsPage.jsx";
import { subscribePluginSettings, getPluginSettingsView, capCall } from "../pluginHost.js";
import SearchBox from "../components/SearchBox.jsx";
import { CARDS, DOMAIN_META, firstCardOf, settingsCards, matchSettings } from "../settingsCatalog.js";

// 页面组件挂在这里；分组标题/图标与卡片关键词放在 settingsCatalog，全局搜索共用同一份
const DOMAINS = {
  ai: { ...DOMAIN_META.ai, page: AiSettingsPage },
  theme: { ...DOMAIN_META.theme, page: ThemePage },
  i18n: { ...DOMAIN_META.i18n, page: I18nPage },
  security: { ...DOMAIN_META.security, page: SecurityPage },
  remote: { ...DOMAIN_META.remote, page: RemotePage },
  // 插件域没有固定组件：卡片内容跟着清单走，见 PluginSettingsBody
  plugin: { ...DOMAIN_META.plugin, page: null },
};

const STORE_KEY = "bit.settings.card";
const OLD_SEC_KEY = "bit.settings.sec"; // 旧版存的是域名，迁移到该域第一张卡

// ── 插件注入的设置内容 ──

/// 条目没有独立页时的兜底面板：直接读写该插件存在宿主机里的键值。
/// 走的是和插件自己一样的入口（capCall → plugin_cap_call），所以权限位、命名空间、审计全都算数。
function PluginKvPanel({ card }) {
  const { t } = useLang();
  const [values, setValues] = useState(null);
  const [err, setErr] = useState("");
  const [nk, setNk] = useState("");
  const [nv, setNv] = useState("");

  const pull = () =>
    capCall(card.plugin_id, "settings.all", {})
      .then((r) => {
        setValues(r?.values || {});
        setErr("");
      })
      .catch((e) => {
        setErr(String(e?.message || e));
        setValues({});
      });
  useEffect(() => {
    pull();
  }, [card.plugin_id]);

  const put = async (key, value) => {
    try {
      await capCall(card.plugin_id, "settings.set", { key, value });
      setErr("");
      await pull();
    } catch (e) {
      setErr(String(e?.message || e));
    }
  };

  if (!values) return <p className="p-4 text-xs text-neutral-400">{t("settings.pluginLoading")}</p>;
  const keys = Object.keys(values);
  return (
    <div className="card space-y-2 p-3">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("settings.pluginStored", { name: card.plugin_name, n: keys.length })}</p>
      {err && <p className="text-xs break-all text-red-500">{err}</p>}
      {keys.length === 0 && <p className="text-xs text-neutral-400">{t("settings.pluginEmpty")}</p>}
      {keys.map((k) => (
        <div key={k} className="flex items-start gap-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
          <span className="w-40 shrink-0 truncate font-mono text-xs" title={k}>
            {k}
          </span>
          <span className="min-w-0 flex-1 break-all text-xs text-neutral-600 dark:text-neutral-300" title={String(values[k])}>
            {typeof values[k] === "string" ? values[k] : JSON.stringify(values[k])}
          </span>
          <button type="button" className="pill-outline pill-hover shrink-0 px-2 py-0.5 text-[11px]" onClick={() => put(k, null)}>
            {t("common.delete")}
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
        <input className="field min-w-0 flex-1 px-2 py-1 text-xs" placeholder={t("settings.pluginKey")} value={nk} onChange={(e) => setNk(e.target.value)} />
        <input className="field min-w-0 flex-1 px-2 py-1 text-xs" placeholder={t("settings.pluginValue")} value={nv} onChange={(e) => setNv(e.target.value)} />
        <button
          type="button"
          className="pill pill-hover shrink-0 px-3 py-1 text-xs"
          disabled={!nk.trim()}
          onClick={async () => {
            await put(nk.trim(), nv);
            setNk("");
            setNv("");
          }}
        >
          {t("settings.pluginWrite")}
        </button>
      </div>
    </div>
  );
}

/** 插件卡片的内容：优先插件自己的设置页（React 组件或 iframe），都没有才用宿主键值面板 */
function PluginSettingsBody({ card, view }) {
  const { t } = useLang();
  const c = view.cards.find((x) => x.key === card.id);
  if (!c) return <p className="p-4 text-xs text-neutral-400">{t("settings.pluginGone")}</p>;
  const pg = c.pageKey ? view.pages[c.pageKey] : null;
  if (pg && pg.component) {
    const Comp = pg.component;
    // iframe 页要一个真实高度：容器是自动高的 block，iframe 的 h-full 会塌成浏览器默认的 150px
    return (
      <div className={pg.page?.frame ? "h-[62vh] min-h-[380px]" : undefined}>
        <Comp pluginId={pg.plugin_id} card={c} />
      </div>
    );
  }
  // 宿主键值面板没有独立页面骨架，单独限宽，别让一行键值横跨整个右栏
  return (
    <div className="page">
      <PluginKvPanel card={c} />
    </div>
  );
}

export default function SettingsPage({ onStats, stats, focus }) {
  const { t } = useLang();
  // 插件注入是运行期变化的（启用/停用/重扫），用外部存储订阅而不是 props 透传
  const pluginView = useSyncExternalStore(subscribePluginSettings, getPluginSettingsView);
  const allCards = useMemo(() => settingsCards(pluginView.cards), [pluginView]);
  // focus / 存档可能是卡片 id，也可能是旧域名，还可能什么都不是
  const resolveCard = (v) => {
    if (allCards.some((c) => c.id === v)) return v;
    return firstCardOf(v, allCards) || CARDS[0].id;
  };
  const [card, setCard] = useState(() =>
    resolveCard(localStorage.getItem(STORE_KEY) || localStorage.getItem(OLD_SEC_KEY) || "")
  );
  const [q, setQ] = useState("");
  const bodyRef = useRef(null);

  // focus 带自增序号：全局搜索再次命中同一张卡时也能把用户从手动切换的卡拉回来
  useEffect(() => {
    if (focus?.v) setCard(resolveCard(focus.v));
  }, [focus]);
  useEffect(() => {
    localStorage.setItem(STORE_KEY, card);
    localStorage.removeItem(OLD_SEC_KEY);
  }, [card]);
  // 换卡即换页：右栏滚回顶部，别带着上一页的滚动位置
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [card]);

  const shown = matchSettings(allCards, q, t);
  const active = allCards.find((c) => c.id === card) || allCards[0];
  const activePlugin = active.domain === "plugin" ? pluginView.cards.find((c) => c.key === active.id) : null;
  // 条目背后的独立设置页（若有）：插件用 Bit.setTitle 改名时这里跟着变，改名才有可见效果
  const activePage = activePlugin?.pageKey ? pluginView.pages[activePlugin.pageKey] : null;

  return (
    <div className="set-shell">
      <aside className="set-nav">
        <SearchBox
          className="set-nav-search"
          value={q}
          onChange={setQ}
          placeholder={t("settings.find")}
        />
        <nav className="set-nav-list">
          {Object.entries(DOMAINS).map(([dom, D]) => {
            const cards = shown.filter((c) => c.domain === dom);
            if (!cards.length) return null; // 搜索时没命中的域连小标题一起收掉
            const Icon = D.icon;
            return (
              <div key={dom} className="set-nav-domain">
                <p className="set-nav-head">
                  <Icon size={12} className="shrink-0 opacity-60" />
                  {t(D.label)}
                </p>
                {cards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCard(c.id)}
                    title={t(c.label)}
                    className={`set-nav-item ${card === c.id ? "on" : ""}`}
                  >
                    {t(c.label)}
                  </button>
                ))}
              </div>
            );
          })}
          {shown.length === 0 && (
            <p className="px-2 py-2 text-xs text-neutral-400">{t("settings.noMatch")}</p>
          )}
        </nav>
      </aside>
      <div className="set-body" ref={bodyRef}>
        {/* 页头与卡片共用同一条中轴线：标题、说明、内容都落在 .set-page 里 */}
        <div className="set-page">
          <header className="set-head">
            <p className="set-head-eyebrow">
              {activePlugin ? `${activePlugin.plugin_name}${activePage ? ` · ${t(activePage.label)}` : ""}` : t(DOMAINS[active.domain].label)}
            </p>
            <h2>{t(active.label)}</h2>
            <p className="set-head-desc">
              {activePlugin ? activePlugin.description || "" : t(`setcard.${active.id}`, "")}
            </p>
          </header>
          {Object.entries(DOMAINS).map(([id, D]) => {
            const Page = D.page;
            return (
              <div key={id} style={{ display: active.domain === id ? "block" : "none" }}>
                {Page ? (
                  <Page onStats={onStats} stats={stats} group={card} />
                ) : active.id === "plugin-perms" ? (
                  <PluginPermsPage />
                ) : (
                  <PluginSettingsBody card={active} view={pluginView} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
