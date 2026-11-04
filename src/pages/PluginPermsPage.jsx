// yxpil · 设置中心：插件权限
// 一个插件一块面板：面板头是插件自己（名称、id、已开项数、整组全开/全关），下面每一行是它申报的一项权限。
// 面板头吸顶，滚到列表中段也知道这一串开关归谁。
// 关闭立即从运行时摘除（css/js 重放插件 UI，server/workwith 由后端收进程），
// 重新打开立即恢复；插件整体停用时开关保留，启用后按这里的选择生效。
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import PillSwitch from "../components/PillSwitch.jsx";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import { reloadPluginUi } from "../pluginHost.js";
import { permLabel } from "../pluginPerms.js";
import { IconRefresh, IconPuzzle } from "../components/Icons.jsx";

// 与插件页同一套口径：green 正常、red 异常/被改、gray 停用
const dotClass = (p) =>
  !p.enabled
    ? "bg-neutral-300 dark:bg-neutral-700"
    : p.verify === "tampered" || p.health
      ? "bg-red-500"
      : "bg-emerald-500";

export default function PluginPermsPage() {
  const { t } = useLang();
  const [plugins, setPlugins] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .listPlugins()
      .then((r) => {
        if (!live) return;
        setPlugins(r?.plugins || []);
        setErr("");
      })
      .catch((e) => {
        if (!live) return;
        setPlugins([]);
        setErr(String(e?.message || e));
      });
    return () => {
      live = false;
    };
  }, [seq]);

  const totals = useMemo(() => {
    let on = 0;
    let all = 0;
    for (const p of plugins || []) {
      const granted = new Set(p.granted_permissions ?? p.permissions ?? []);
      for (const perm of p.permissions || []) {
        all += 1;
        if (granted.has(perm)) on += 1;
      }
    }
    return { on, all };
  }, [plugins]);

  const toggle = async (p, perm, granted) => {
    setBusy(`${p.id}:${perm}`);
    try {
      await api.setPluginPermission(p.id, perm, granted);
      const r = await api.listPlugins();
      setPlugins(r?.plugins || []);
      setErr("");
      if (perm === "css" || perm === "js") await reloadPluginUi();
    } catch (e) {
      await confirmDialog({
        alert: true,
        title: granted ? t("plugin.permOnFailed") : t("plugin.permOffFailed"),
        message: String(e?.message || e),
      });
    } finally {
      setBusy("");
    }
  };

  // 整组开关：只动状态不一致的那几项，逐条落库后统一刷新一次、重放一次 UI
  const setAll = async (p, granted) => {
    const on = new Set(p.granted_permissions ?? p.permissions ?? []);
    const targets = (p.permissions || []).filter((perm) => on.has(perm) !== granted);
    if (!targets.length) return;
    if (!granted) {
      const ok = await confirmDialog({
        title: t("plugin.permBulkOffTitle", { name: p.name }),
        message: t("plugin.permBulkOffConfirm", { list: targets.join(", ") }),
      });
      if (!ok) return;
    }
    setBusy(`bulk:${p.id}`);
    try {
      for (const perm of targets) await api.setPluginPermission(p.id, perm, granted);
      const r = await api.listPlugins();
      setPlugins(r?.plugins || []);
      setErr("");
      if (targets.includes("css") || targets.includes("js")) await reloadPluginUi();
    } catch (e) {
      await confirmDialog({
        alert: true,
        title: granted ? t("plugin.permOnFailed") : t("plugin.permBulkOffFailed"),
        message: String(e?.message || e),
      });
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="page">
      <section className="set-group">
        <div className="card flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-neutral-600 dark:text-neutral-300">
              {plugins === null
                ? t("plugin.permsPageLoading")
                : t("plugin.permsPageSummary", {
                    plugins: plugins.length,
                    on: totals.on,
                    total: totals.all,
                  })}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
              {t("plugin.permsPageDesc")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSeq((n) => n + 1)}
            className="pill-outline pill-hover shrink-0 gap-1.5 px-3 py-1 text-xs"
          >
            <IconRefresh size={13} /> {t("plugin.permsPageRefresh")}
          </button>
        </div>

        {err && (
          <div className="card">
            <p className="break-all text-xs text-red-500 dark:text-red-400">
              {t("plugin.permsPageFailed", { msg: err })}
            </p>
          </div>
        )}

        {plugins !== null && plugins.length === 0 && !err && (
          <div className="card flex flex-col items-center gap-1.5 py-8 text-center">
            <IconPuzzle size={20} className="text-neutral-400" />
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("plugin.permsPageEmpty")}</p>
          </div>
        )}
      </section>

      <div className="flex flex-col gap-3">
        {(plugins || []).map((p) => {
          const granted = new Set(p.granted_permissions ?? p.permissions ?? []);
          const perms = p.permissions || [];
          const on = perms.filter((perm) => granted.has(perm)).length;
          return (
            <section key={p.id} className="set-group perm-group" data-bit-perm-group={p.id}>
              <div className="card perm-head flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className={`size-2 shrink-0 rounded-full ${dotClass(p)}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{p.name}</p>
                    {!p.enabled && <span className="chip text-[11px]">{t("plugin.permsPageDisabled")}</span>}
                    {(p.declared_permissions || []).includes("all") && (
                      <span
                        className="chip border-amber-400/60 text-[11px] text-amber-600 dark:text-amber-400"
                        title={t("plugin.permAllHint")}
                      >
                        {t("plugin.permAll")}
                      </span>
                    )}
                    {p.verify === "tampered" && (
                      <span className="chip border-red-400 text-[11px] text-red-500">{t("plugin.tampered")}</span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
                    {p.id} · {t("plugin.permsPageOnCount", { on, total: perms.length })}
                  </p>
                </div>
                {perms.length > 0 && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setAll(p, true)}
                      disabled={busy === `bulk:${p.id}` || on === perms.length}
                      className="pill-outline pill-hover px-2.5 py-1 text-[11px]"
                      title={t("plugin.permBulkOn", { name: p.name })}
                    >
                      {t("plugin.permBulkOnLabel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAll(p, false)}
                      disabled={busy === `bulk:${p.id}` || on === 0}
                      className="pill-outline pill-hover px-2.5 py-1 text-[11px]"
                      title={t("plugin.permBulkOff", { name: p.name })}
                    >
                      {t("plugin.permBulkOffLabel")}
                    </button>
                  </div>
                )}
              </div>

              {perms.length === 0 ? (
                <div className="card">
                  <p className="text-xs text-neutral-400">{t("plugin.permsNone")}</p>
                </div>
              ) : (
                perms.map((perm) => {
                  const enabled = granted.has(perm);
                  return (
                    <div
                      key={perm}
                      data-bit-perm-row={`${p.id}:${perm}`}
                      className={`card flex items-center gap-3 pl-4 ${enabled ? "" : "opacity-60"}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-[13px] leading-snug">{permLabel(t, perm)}</p>
                          {(perm === "exec" || perm === "write") && (
                            <span className="chip border-red-400/60 text-[10px] text-red-500">
                              {t("plugin.permRisky")}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
                          {perm}
                        </p>
                      </div>
                      <PillSwitch
                        size="sm"
                        checked={enabled}
                        disabled={busy === `${p.id}:${perm}`}
                        onChange={(next) => toggle(p, perm, next)}
                        title={
                          enabled
                            ? t("plugin.permOff", {
                                perm,
                                extra:
                                  perm === "server"
                                    ? t("plugin.permOffServer")
                                    : perm === "workwith"
                                      ? t("plugin.permOffWorkwith")
                                      : "",
                              })
                            : t("plugin.permOn", { perm, note: p.enabled ? "" : t("plugin.permOnOff") })
                        }
                      />
                    </div>
                  );
                })
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
