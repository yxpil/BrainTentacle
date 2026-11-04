// yxpil · 插件管理页
// 原先插件的启用/重扫埋在「工具」页里，和运行时、MCP、写脚本变工具挤在一屏。
// 这页管本机扩展：左侧是插件包列表（选中后右侧看详情）与本地服务入口，
// 右侧详情包含能力清单、页面/入口、权限与安全、自带服务器与插件自带的状态面板。
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import WorkWithPage from "./WorkWithPage.jsx";
import PillSwitch from "../components/PillSwitch.jsx";
import PluginFramePage from "../components/PluginFramePage.jsx";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import { subscribePluginStatus, getPluginStatusPages } from "../pluginHost.js";
import { permLabel as permLabelOf } from "../pluginPerms.js";
import {
  IconRefresh,
  IconFolderOpen,
  IconServer,
  IconPlayTri,
  IconStop,
  IconTerminal,
  IconX,
  IconPuzzle,
} from "../components/Icons.jsx";
import SearchBox from "../components/SearchBox.jsx";

// 接管槽位的人话名称（与后端 TAKEOVER_SLOTS 对应；未知槽位直接显示原名）
const TAKEOVER_KEY = {
  "chat.voice": "sec.takeover.slotVoice",
  "chat.preview": "sec.takeover.slotPreview",
  "chat.attach": "sec.takeover.slotAttach",
  "chat.plan": "sec.takeover.slotPlan",
  "chat.template": "sec.takeover.slotTemplate",
  "chat.web": "sec.takeover.slotWeb",
  "chat.bgjobs": "sec.takeover.slotBgJobs",
};

// 运行异常的人话标签（与核心 phase 一一对应；message 里是原始原因）
const HEALTH_KEY = {
  crashed: "plugin.health.crashed",
  "start-failed": "plugin.health.startFailed",
  "port-timeout": "plugin.health.portTimeout",
};

export default function PluginsPage({ visible }) {
  const { t } = useLang();
  const [plugins, setPlugins] = useState([]);
  const [dir, setDir] = useState("");
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [logId, setLogId] = useState("");
  const [logs, setLogs] = useState([]);
  const [sel, setSel] = useState("");
  const [q, setQ] = useState("");
  const [serviceCount, setServiceCount] = useState(0);
  const statusPages = useSyncExternalStore(subscribePluginStatus, getPluginStatusPages);

  // 深链/插件唤醒：App 把旧 workwith 页映射到本页的服务分段；
  // 页眉异常灯点击会带 plugin id，直接选中出问题的包
  useEffect(() => {
    const on = (e) =>
      setSel(e?.detail?.plugin || (e?.detail?.tab === "services" ? "services" : ""));
    window.addEventListener("bit-plugins-tab", on);
    return () => window.removeEventListener("bit-plugins-tab", on);
  }, []);

  const apply = (r) => {
    setPlugins(r?.plugins || []);
    setDir(r?.dir || "");
    setErrors(r?.errors || []);
  };

  const reload = () => api.listPlugins().then(apply).catch(() => {});
  useEffect(() => {
    reload();
    // 服务列表只在选中「本地服务」时挂载；计数先单独取一次，左栏和工具栏不用等用户点进去
    api.listWorkwith().then((r) => setServiceCount((r?.entries || []).length)).catch(() => {});
  }, []);

  // 标签页保活（切走只 display:none），但插件的状态在别处会变：工具页停用插件、
  // 权限页翻 net 位、外部连接由会话或插件自己的页面连上断开。回到本页必须重拉一次，
  // 否则连接区停在离开时那一帧——按钮写着「连接」而后端早连上了，点一下反而把连接断掉。
  useEffect(() => {
    if (!visible) return;
    reload();
    api.listWorkwith().then((r) => setServiceCount((r?.entries || []).length)).catch(() => {});
  }, [visible]);

  // 服务器进程的事件（started/ready/killed/exited/port-timeout）：状态灯要实时跟着走；
  // 异常登记（plugin-health）同时刷新左栏红点与服务器卡片的原因；
  // plugin-net 是外部连接的连/断/回收，本页那一区的开关全靠它对齐
  useEffect(() => {
    const un = listen("plugin-server", () => reload());
    const un2 = listen("plugin-health", () => reload());
    const un3 = listen("plugin-net", () => reload());
    return () => {
      un.then((f) => f()).catch(() => {});
      un2.then((f) => f()).catch(() => {});
      un3.then((f) => f()).catch(() => {});
    };
  }, []);

  // 展开某插件的服务器日志时轮询尾部（进程输出是持续产生的）
  useEffect(() => {
    if (!logId) return undefined;
    const pull = () => api.pluginServerLogs(logId, 400).then((r) => setLogs(r?.logs || [])).catch(() => {});
    pull();
    const timer = setInterval(pull, 1500);
    return () => clearInterval(timer);
  }, [logId]);

  const permLabel = (perm) => permLabelOf(t, perm);
  const takeoverLabel = (slot) => (TAKEOVER_KEY[slot] ? t(TAKEOVER_KEY[slot]) : slot);
  const healthLabel = (phase) => (HEALTH_KEY[phase] ? t(HEALTH_KEY[phase]) : t("plugin.healthAbnormal"));
  const listSep = t("plugin.listSep");

  // 外部连接那一行的状态话：连没连、带哪几个头、还缺哪几项设置、权限位是否被单独关掉
  const netStateLine = (c) => {
    const bits = [];
    bits.push(
      c.connected
        ? t("plugin.netConnected", { name: c.server_name || c.label, tools: c.tools })
        : t("plugin.netDisconnected")
    );
    if (c.auto_connect) bits.push(t("plugin.netAuto"));
    if (c.header_names?.length) bits.push(t("plugin.netHeaders", { list: c.header_names.join(listSep) }));
    if (c.missing_settings?.length) bits.push(t("plugin.netNeedSettings", { list: c.missing_settings.join(listSep) }));
    if (!c.granted) bits.push(t("plugin.permClosedSuffix"));
    return bits.join(" · ");
  };

  const activeId = sel === "services" ? "services" : plugins.some((p) => p.id === sel) ? sel : plugins[0]?.id || "";
  const active = plugins.find((p) => p.id === activeId) || null;
  const statusPage = active ? statusPages[active.id] : null;
  const enabledCount = plugins.filter((p) => p.enabled).length;
  // 后端下发生效权限；旧版本没有该字段时退回"清单申报即全开"
  const grantedSet = useMemo(
    () => new Set(active?.granted_permissions ?? active?.permissions ?? []),
    [active]
  );
  const closedPerms = (active?.permissions || []).filter((perm) => !grantedSet.has(perm));

  // 换插件就收起上一个的日志：日志是进程输出，跟着插件走才不会串
  useEffect(() => {
    setLogId("");
    setLogs([]);
  }, [activeId]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return plugins;
    return plugins.filter((p) => `${p.name} ${p.id} ${p.description || ""}`.toLowerCase().includes(term));
  }, [q, plugins]);

  const rescan = async () => {
    setBusy(true);
    try {
      await api.refreshPlugins();
      apply(await api.listPlugins());
      const { reloadPluginUi } = await import("../pluginHost.js");
      await reloadPluginUi();
    } catch (e) {
      await confirmDialog({ alert: true, title: t("plugin.rescanFailed"), message: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (p) => {
    // 启用 = 明示信任：先摊开权限清单让用户确认（停用无需确认）
    if (!p.enabled && (p.permissions?.length || p.has_ui)) {
      const perms = (p.permissions || []).map((x) => `· ${x} — ${permLabel(x)}`).join("\n");
      const extra = [];
      if (p.server) {
        const port = p.server.port ? t("plugin.confirmPort", { port: p.server.port }) : t("plugin.confirmPortAuto");
        extra.push(t("plugin.confirmServer", { runtime: p.server.runtime, program: p.server.program, port }));
      }
      if (p.pages?.length) extra.push(t("plugin.confirmPages", { list: p.pages.map((g) => g.label).join(listSep) }));
      if (p.status_page) extra.push(t("plugin.confirmStatusPage", { label: p.status_page.label }));
      if (p.settings?.entries?.length) {
        extra.push(t("plugin.confirmSettingsEntries", { list: p.settings.entries.map((e) => e.label).join(listSep) }));
      }
      if (p.settings?.page) extra.push(t("plugin.confirmSettingsPage", { page: p.settings.page }));
      if (p.takeover?.length) {
        extra.push(t("plugin.confirmTakeover", { list: p.takeover.map(takeoverLabel).join(listSep) }));
      }
      if ((p.permissions || []).includes("chat")) extra.push(t("plugin.confirmChat"));
      if ((p.permissions || []).includes("workwith")) extra.push(t("plugin.confirmWorkwith"));
      if ((p.permissions || []).includes("session")) extra.push(t("plugin.confirmSession"));
      if ((p.permissions || []).includes("data")) extra.push(t("plugin.confirmData"));
      if ((p.permissions || []).includes("exec")) {
        extra.push(t("plugin.confirmExec"));
        if (p.interpreters?.length) extra.push(t("plugin.confirmExecNarrow", { list: p.interpreters.join(listSep) }));
      }
      if ((p.permissions || []).includes("write")) extra.push(t("plugin.confirmWrite"));
      if (p.file_kinds?.length) {
        extra.push(
          t("plugin.confirmFileKinds", {
            list: p.file_kinds.map((k) => `${(k.exts || []).join("/")} → ${k.tool || t("plugin.fileKindIconOnly")}`).join(listSep),
          })
        );
      }
      // 外部连接单独说一遍：连到哪儿是用户最该在点头前看见的一条信息
      if (p.connections?.length) {
        extra.push(
          t("plugin.confirmNet", {
            list: p.connections.map((c) => `${c.label} → ${c.url_template}`).join(listSep),
          })
        );
      }
      if ((p.declared_permissions || []).includes("all")) extra.push(t("plugin.confirmAll"));
      // 通讯令牌：所有通道共用一枚，停用即收回——这里说明白，用户才知道"未声明的一律拒"是有凭据兜底的
      extra.push(t("plugin.confirmToken"));
      const ok = await confirmDialog({
        title: t("plugin.confirmTitle", { name: p.name }),
        message:
          `${t("plugin.confirmPerms")}\n${perms || t("plugin.none")}\n` +
          (extra.length ? `\n${extra.join("\n")}\n` : "") +
          `\n${t("plugin.confirmBaseline")}` +
          `\n${t("plugin.confirmIndividually")}` +
          (p.has_ui ? `\n\n${t("plugin.confirmHasUi")}` : ""),
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.togglePlugin(p.id, !p.enabled);
      apply(await api.listPlugins());
      const { reloadPluginUi } = await import("../pluginHost.js");
      await reloadPluginUi();
    } catch (e) {
      await confirmDialog({ alert: true, title: t("plugin.actionFailed"), message: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  // 外部连接的手动连/断：连是用户明示动作（握手成功后工具立刻进注册中心），
  // 断只收工具并置灰条目，清单声明留着，随时能再连
  const netToggle = async (p, c) => {
    setBusy(true);
    try {
      if (c.connected) await api.disconnectPluginNet(p.id, c.name);
      else await api.connectPluginNet(p.id, c.name);
      apply(await api.listPlugins());
    } catch (e) {
      await confirmDialog({ alert: true, title: t("plugin.netFailed"), message: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  // 逐权限开关：只影响运行时能力（清单与哈希基线都不动）。
  // css/js 关掉后已经注入的内容要立即撤掉，所以单独重放一次插件 UI；
  // 页面/设置/图标由后端 plugin-pages 事件驱动各窗口重放，server/workwith 由后端收进程。
  const togglePerm = async (p, perm, granted) => {
    setBusy(true);
    try {
      await api.setPluginPermission(p.id, perm, granted);
      apply(await api.listPlugins());
      if (perm === "css" || perm === "js") {
        const { reloadPluginUi } = await import("../pluginHost.js");
        await reloadPluginUi();
      }
    } catch (e) {
      await confirmDialog({
        alert: true,
        title: granted ? t("plugin.permOnFailed") : t("plugin.permOffFailed"),
        message: String(e?.message || e),
      });
    } finally {
      setBusy(false);
    }
  };

  // 插件自带服务器的启停：状态由 list_plugins 的 server 字段带回，页面地址随之刷新
  const runServer = async (p) => {
    setBusy(true);
    try {
      if (p.server?.running) await api.stopPluginServer(p.id);
      else await api.startPluginServer(p.id);
      await reload();
    } catch (e) {
      await confirmDialog({ alert: true, title: p.server?.running ? t("plugin.stopFailed") : t("plugin.startFailed"), message: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const toolbar = (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="text-xs text-neutral-500 dark:text-neutral-400">
        {t("plugin.count", { total: plugins.length, on: enabledCount, svc: serviceCount })}
      </span>
      {activeId !== "services" && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {dir && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.openPath(dir); // 直接打开插件文件夹本身（reveal=true 是"在父目录里选中"）
                } catch (e) {
                  await confirmDialog({ alert: true, title: t("plugin.openDirFailed"), message: String(e?.message || e) });
                }
              }}
              title={dir}
              className="pill-outline pill-hover gap-1.5 px-3 py-1 text-xs"
            >
              <IconFolderOpen size={13} /> {t("plugin.openDir")}
            </button>
          )}
          <button
            type="button"
            onClick={rescan}
            disabled={busy}
            title={t("plugin.rescanTitle")}
            className="pill-outline pill-hover gap-1.5 px-3 py-1 text-xs"
          >
            <IconRefresh size={13} /> {t("plugin.rescan")}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="set-shell">
      <aside className="set-nav">
        <SearchBox
          className="set-nav-search"
          value={q}
          onChange={setQ}
          placeholder={t("plugin.search")}
        />
        <nav className="set-nav-list">
          <div className="set-nav-domain">
            <p className="set-nav-head">
              <IconPuzzle size={12} className="shrink-0 opacity-60" />
              {t("plugin.navPackages")}
            </p>
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSel(p.id)}
                title={p.description || p.id}
                className={`set-nav-item ${activeId === p.id ? "on" : ""}`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      !p.enabled
                        ? "bg-neutral-300 dark:bg-neutral-700"
                        : p.verify === "tampered" || p.health
                          ? "bg-red-500"
                          : "bg-emerald-500"
                    }`}
                    title={
                      !p.enabled
                        ? t("plugin.statusDisabled")
                        : p.verify === "tampered"
                          ? t("plugin.statusTampered")
                          : p.health
                            ? t("plugin.statusHealth", { msg: p.health.message || healthLabel(p.health.phase) || p.health.phase })
                            : t("plugin.statusEnabled")
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </span>
              </button>
            ))}
            {shown.length === 0 && (
              <p className="px-2 py-1 text-xs text-neutral-400">{plugins.length ? t("plugin.noMatch") : t("plugin.empty")}</p>
            )}
          </div>
          <div className="set-nav-domain">
            <p className="set-nav-head">
              <IconServer size={12} className="shrink-0 opacity-60" />
              {t("plugin.navServices")}
            </p>
            <button
              type="button"
              onClick={() => setSel("services")}
              className={`set-nav-item ${activeId === "services" ? "on" : ""}`}
            >
              {serviceCount ? t("plugin.servicesWithCount", { n: serviceCount }) : t("plugin.servicesTitle")}
            </button>
          </div>
        </nav>
      </aside>

      {activeId === "services" ? (
        <div className="set-body">
          {toolbar}
          <header className="set-head">
            <p className="set-head-eyebrow">{t("plugin.navServices")}</p>
            <h2 className="text-base font-semibold">{t("plugin.servicesTitle")}</h2>
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              {t("plugin.servicesDesc")}
            </p>
          </header>
          <WorkWithPage embedded onCount={setServiceCount} />
        </div>
      ) : (
        <div className="set-body">
          {toolbar}

          {errors.length > 0 && (
            <div className="card mb-2 space-y-1">
              <p className="text-xs font-semibold text-red-500">{t("plugin.scanErrors", { n: errors.length })}</p>
              {/* 一条都不藏：夹具一多，只列前几条会把用户真正要查的那条挤出去，改成整块滚动 */}
              <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                {errors.map((e, i) => (
                  <p key={i} className="truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400" title={typeof e === "string" ? e : JSON.stringify(e)}>
                    {typeof e === "string" ? e : `${e?.path || e?.id || ""} ${e?.error || e?.msg || ""}`}
                  </p>
                ))}
              </div>
            </div>
          )}

          {!active ? (
            <div className="rounded-2xl border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-700">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("plugin.emptyHint")}</p>
              {dir && (
                <p className="mt-1 truncate font-mono text-[11px] text-neutral-400 dark:text-neutral-500" title={dir}>
                  {dir}
                </p>
              )}
            </div>
          ) : (
            <>
              <header className="set-head">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="set-head-eyebrow">{t("plugin.pkgEyebrow", { id: active.id })}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{active.name}</h2>
                      {active.version && <span className="chip">{active.version}</span>}
                      {(active.declared_permissions || []).includes("all") && (
                        <span
                          className="chip border-amber-400/60 text-amber-600 dark:text-amber-400"
                          title={t("plugin.permAllHint")}
                        >
                          {t("plugin.permAll")}
                        </span>
                      )}
                      {active.verify === "tampered" && (
                        <span className="chip border-red-400 text-red-500" title={t("plugin.tamperedTitle")}>
                          {t("plugin.tampered")}
                        </span>
                      )}
                      {active.bridge?.token === "required" && (
                        <span
                          className="chip border-emerald-400/60 text-emerald-600 dark:text-emerald-400"
                          title={t("plugin.tokenTitle")}
                        >
                          {t("plugin.tokenOn")}
                        </span>
                      )}
                    </div>
                    {active.description && (
                      <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{active.description}</p>
                    )}
                  </div>
                  <PillSwitch
                    checked={active.enabled}
                    onChange={() => toggle(active)}
                    disabled={busy}
                    title={active.enabled ? t("plugin.disable") : t("plugin.enable")}
                  />
                </div>
              </header>

              <div className="set-group">
                <section className="card space-y-2">
                  <p className="text-xs font-semibold">{t("plugin.capabilities")}</p>
                  {active.tools?.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {active.tools.map((n) => (
                        <span key={n} className="chip font-mono">{n}</span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-neutral-400">{t("plugin.noTools")}</p>
                  )}
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                    <span>{t("plugin.prompts", { n: active.prompts || 0 })}</span>
                    <span>{t("plugin.skills", { n: active.skills?.length || 0 })}</span>
                    <span>{t("plugin.memories", { n: active.memories || 0 })}</span>
                    <span>{t("plugin.jobs", { n: active.jobs?.length || 0 })}</span>
                  </div>
                  {active.skills?.length > 0 && (
                    <p className="truncate text-xs text-neutral-500 dark:text-neutral-400" title={active.skills.join(listSep)}>
                      {t("plugin.skillsList", { list: active.skills.join(listSep) })}
                    </p>
                  )}
                  {active.jobs?.length > 0 && (
                    <div className="space-y-0.5">
                      {active.jobs.map((j) => (
                        <p key={j.name} className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                          {j.name} · <span className="font-mono">{j.schedule}</span>
                        </p>
                      ))}
                    </div>
                  )}
                  {active.services?.length > 0 && (
                    <div className="space-y-0.5">
                      {active.services.map((s) => (
                        <p key={s.id} className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                          {s.label} · <span className="font-mono">{s.runtime}</span>
                          {s.auto_start ? ` · ${t("plugin.serviceAuto")}` : ""}
                          {" · "}
                          {s.running ? t("plugin.serviceRunning") : t("plugin.serviceStopped")}
                        </p>
                      ))}
                    </div>
                  )}
                  {active.file_kinds?.length > 0 && (
                    <div className="space-y-0.5">
                      {active.file_kinds.map((k) => (
                        <p key={k.id} className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                          <span className="font-mono">{(k.exts || []).join(" ")}</span>
                          {` · ${k.label}`}
                          {" · "}
                          {k.tool ? t("plugin.fileKindParses", { tool: k.tool }) : t("plugin.fileKindIconOnly")}
                        </p>
                      ))}
                    </div>
                  )}
                  {active.connections?.length > 0 && (
                    <div className="space-y-1" data-bit-net-group={active.id}>
                      <p className="text-xs font-semibold">{t("plugin.netTitle")}</p>
                      {active.connections.map((c) => (
                        <div key={c.id} data-bit-net-row={c.name} className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs" title={c.url_template}>
                              {c.label} · <span className="font-mono text-neutral-500 dark:text-neutral-400">{c.url_template}</span>
                            </p>
                            <p className="truncate text-xs text-neutral-500 dark:text-neutral-400" title={netStateLine(c)}>
                              {netStateLine(c)}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="btn btn-ghost shrink-0 text-xs"
                            disabled={busy || !c.granted}
                            onClick={() => netToggle(active, c)}
                          >
                            {c.connected ? t("plugin.netDisconnect") : t("plugin.netConnect")}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="card space-y-2">
                  <p className="text-xs font-semibold">{t("plugin.pages")}</p>
                  {active.pages?.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {active.pages.map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() =>
                            window.dispatchEvent(new CustomEvent("bit-open-page", { detail: { page: `${active.id}:${g.id}` } }))
                          }
                          title={`${g.kind === "static" ? t("plugin.pageStatic") : t("plugin.pageDynamic")} · ${t("plugin.pageOpen")}`}
                          className="chip cursor-pointer transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        >
                          {t("plugin.pageChip", { label: g.label })}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-neutral-400">{t("plugin.noPages")}</p>
                  )}
                  {active.status_page && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t("plugin.statusPageInline", { label: active.status_page.label })}
                    </p>
                  )}
                  {active.has_ui && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("plugin.uiInjected")}</p>
                  )}
                  {active.settings?.entries?.length > 0 && (
                    <p className="truncate text-xs text-neutral-500 dark:text-neutral-400" title={active.settings.entries.map((e) => e.label).join(listSep)}>
                      {t("plugin.settingsEntries", { list: active.settings.entries.map((e) => e.label).join(listSep) })}
                    </p>
                  )}
                  {active.settings?.page && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t("plugin.settingsPage", { page: active.settings.page })}
                    </p>
                  )}
                  {active.takeover?.length > 0 && (
                    <p
                      className="truncate text-xs text-neutral-500 dark:text-neutral-400"
                      title={active.takeover.map(takeoverLabel).join(listSep)}
                    >
                      {t("plugin.takeoverEntries", { list: active.takeover.map(takeoverLabel).join(listSep) })}
                      {grantedSet.has("takeover") ? "" : t("plugin.permClosedSuffix")}
                    </p>
                  )}
                </section>

                <section className="card space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold">{t("plugin.perms")}</p>
                    {active.permissions?.length > 0 && (
                      <span className="chip">
                        {t("plugin.permsAllowed", {
                          on: (active.permissions || []).length - closedPerms.length,
                          total: active.permissions.length,
                        })}
                      </span>
                    )}
                    {closedPerms.length > 0 && (
                      <span className="chip border-amber-400/60 text-amber-600 dark:text-amber-400">
                        {t("plugin.permsClosed", { n: closedPerms.length })}
                      </span>
                    )}
                  </div>
                  {active.permissions?.length > 0 ? (
                    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {active.permissions.map((perm) => {
                        const on = grantedSet.has(perm);
                        return (
                          <div
                            key={perm}
                            className={`flex items-center gap-3 py-2.5 text-xs ${on ? "" : "opacity-60"}`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <p className="text-[13px] leading-snug">{permLabel(perm)}</p>
                                {(perm === "exec" || perm === "write") && (
                                  <span className="chip border-red-400/60 text-red-500">
                                    {t("plugin.permRisky")}
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
                                {perm}
                              </p>
                              {perm === "exec" && active.interpreters?.length > 0 && (
                                <p
                                  className="mt-0.5 truncate text-[11px] text-emerald-600 dark:text-emerald-400"
                                  title={active.interpreters.join(listSep)}
                                >
                                  {t("plugin.execNarrow", { list: active.interpreters.join(listSep) })}
                                </p>
                              )}
                            </div>
                            <PillSwitch
                              size="sm"
                              checked={on}
                              disabled={busy}
                              onChange={(next) => togglePerm(active, perm, next)}
                              title={
                                on
                                  ? t("plugin.permOff", {
                                      perm,
                                      extra:
                                        perm === "server"
                                          ? t("plugin.permOffServer")
                                          : perm === "workwith"
                                            ? t("plugin.permOffWorkwith")
                                            : "",
                                    })
                                  : t("plugin.permOn", { perm, note: active.enabled ? "" : t("plugin.permOnOff") })
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-neutral-400">{t("plugin.permsNone")}</p>
                  )}
                  <p className="text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
                    {t("plugin.permsExplain")}
                  </p>
                  <p className="text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
                    {t("plugin.baselineExplain")}
                  </p>
                </section>

                {active.server && (
                  <section className="card space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs font-semibold">{t("plugin.server")}</p>
                      <span
                        className={`inline-block size-2 shrink-0 rounded-full ${
                          active.server.running ? (active.server.port ? "bg-green-500" : "bg-amber-400") : "bg-neutral-300 dark:bg-neutral-700"
                        }`}
                        title={
                          active.server.running
                            ? active.server.port
                              ? t("plugin.serverReady")
                              : t("plugin.serverPortPending")
                            : t("plugin.serverStopped")
                        }
                      />
                      {active.health && (
                        <span className="chip border-red-400 text-red-500" title={active.health.message}>
                          {healthLabel(active.health.phase)}
                        </span>
                      )}
                      <IconServer size={13} className="text-neutral-400" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
                        {active.server.runtime} {active.server.program}
                      </span>
                      {active.server.running && <span className="chip">pid {active.server.pid}</span>}
                      {active.server.auto_start && <span className="chip">{t("plugin.autoStart")}</span>}
                      <button
                        type="button"
                        disabled={busy || !active.enabled}
                        title={active.server.running ? t("plugin.serverStop") : t("plugin.serverStart")}
                        onClick={() => runServer(active)}
                        className={`icon-btn h-6 w-6 ${
                          active.server.running ? "hover:bg-red-50 hover:text-red-600" : "hover:bg-green-50 hover:text-green-600"
                        } disabled:opacity-40`}
                      >
                        {active.server.running ? <IconStop size={12} className="mx-auto" /> : <IconPlayTri size={12} className="mx-auto" />}
                      </button>
                      <button
                        type="button"
                        title={logId === active.id ? t("plugin.logHide") : t("plugin.logShow")}
                        onClick={() => setLogId(logId === active.id ? "" : active.id)}
                        className={`icon-btn h-6 w-6 hover:bg-neutral-100 ${logId === active.id ? "bg-neutral-100 text-neutral-900" : ""}`}
                      >
                        {logId === active.id ? <IconX size={12} className="mx-auto" /> : <IconTerminal size={12} className="mx-auto" />}
                      </button>
                    </div>
                    {active.server.url && (
                      <p className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">{active.server.url}</p>
                    )}
                    {active.health && (
                      <p className="text-xs text-red-500 dark:text-red-400">
                        {t("plugin.healthDetail", { label: healthLabel(active.health.phase), msg: active.health.message })}
                      </p>
                    )}
                    {logId === active.id && (
                      <pre className="max-h-56 overflow-y-auto rounded-2xl bg-neutral-100 p-3 text-xs leading-5 whitespace-pre-wrap break-all dark:bg-neutral-800 dark:text-neutral-200">
                        {logs.length === 0 ? (
                          <span className="text-neutral-400">{t("plugin.noOutput")}</span>
                        ) : (
                          logs.map((l, i) => (
                            <span key={i} className={l.stream === "err" ? "text-red-500 dark:text-red-400" : ""}>
                              {l.text}{"\n"}
                            </span>
                          ))
                        )}
                      </pre>
                    )}
                  </section>
                )}

                {active.status_page && (
                  <section className="card space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs font-semibold">{t("plugin.statusPanel", { label: active.status_page.label })}</p>
                      <span className="chip">{active.status_page.kind === "static" ? t("plugin.kindStatic") : t("plugin.kindDynamic")}</span>
                    </div>
                    {!active.enabled ? (
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("plugin.statusEnableHint")}</p>
                    ) : active.verify === "tampered" ? (
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        {t("plugin.statusTamperedHint")}
                      </p>
                    ) : statusPage ? (
                      <div className="h-[24rem] overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
                        <PluginFramePage
                          page={statusPage}
                          onOpenPlugins={() => window.dispatchEvent(new CustomEvent("bit-open-page", { detail: { page: "plugins" } }))}
                        />
                      </div>
                    ) : (
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        {active.status_page.kind === "server" && !active.server?.running
                          ? t("plugin.statusLoading")
                          : t("plugin.statusLoading2")}
                      </p>
                    )}
                  </section>
                )}
              </div>

              <p className="shrink-0 pb-2 pt-2 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
                {t("plugin.footer")}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
