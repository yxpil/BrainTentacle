import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PhysicalPosition, currentMonitor, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import Popup from "./Popup.jsx";
import {
  IconMinus,
  IconSquare,
  IconX,
  IconBolt,
  IconShield,
  IconScissors,
  IconSpeaker,
  IconSpeakerOff,
  IconQueue,
  IconStop,
} from "./Icons.jsx";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { useAutoSpeak, useSubagents, patchBehavior } from "../automationStore.js";
import { useIconSpace, useIconSurface } from "../iconSpace.jsx";
import IconRow from "./IconRow.jsx";
import { InkGlyph, GLYPH_INK } from "./InkGlyph.jsx";
import PillSwitch from "./PillSwitch.jsx";

const fmtK = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}K` : String(n));
// 内存读数：过 1 GB 显示一位小数；内环按 2 GB 参考值折算比例
const fmtMem = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
const MEM_REF_MB = 2048;

// 页眉右侧那一排工具位：全站图标空间里的一条区，id 带 title: 前缀
const BAR_ZONE = "title";
const TITLE_PREFIX = "title:";
// 带下拉浮层的图标自己包一层 relative 再挂浮层：图标被拖到别的排时，
// 浮层的定位跟着节点走，不吃宿主那一格的样式
const BUILTIN_TOOLS = ["model", "approval", "shot", "speak", "subs"];

// 插件异常灯的原因文案：核心只报相位与原始信息，这里补一句人话
const ALERT_PHASE = {
  crashed: "title.pluginCrashed",
  "start-failed": "title.pluginStartFailed",
  "port-timeout": "title.pluginPortTimeout",
};

// macOS 使用原生 Overlay 标题栏（系统红绿灯按钮），隐藏自绘窗口按钮并为其留出空间；
// Windows/Linux 保持自绘无边框标题栏不变
const isMac = navigator.platform.toUpperCase().includes("MAC");

// 自定义无边框标题栏：与窗口按钮同高的页眉仪表盘（版本/会话/Token/内存），
// 数据不侵占内容区；中段可拖动，右侧窗口按钮
export default function TitleBar({ extras, onOpenAutomation }) {
  const { t } = useLang();
  const win = () => getCurrentWindow();
  const minimize = () => win().minimize().catch(() => {});
  const toggleMax = () => win().toggleMaximize().catch(() => {});
  // 关闭走 CloseRequested → 隐藏到托盘（后端已拦截），此处直接调用即可
  const close = () => win().close().catch(() => {});

  const [dash, setDash] = useState({ sessions: 0, tokens: 0, limitK: 128 });
  // 页眉上下文指示器：超小饼图平时只占一颗图标，悬浮才展开用量，点击进编辑。
  // 上下文长度写 bit.ctxLimitOverride + 强制标记（临时覆盖模型上报值与设置回退值），
  // 可一键恢复自动；自动压缩阈值与设置页共用 compact_config（字符数）。
  const [ctxMenu, setCtxMenu] = useState(false);
  const [ctxHover, setCtxHover] = useState(false);
  const [limitDraft, setLimitDraft] = useState("");
  const limitDirty = useRef(false);
  const [compact, setCompact] = useState(null);
  const [charDraft, setCharDraft] = useState("");
  const charDirty = useRef(false);
  const openCtxMenu = () => {
    setCtxMenu(true);
    setCtxHover(false);
    limitDirty.current = false;
    setLimitDraft(String(dash.limitK || 128));
    // 每次打开都重读：设置页可能刚改过压缩阈值
    api
      .compactConfigGet()
      .then((r) => {
        const c = { auto: !!r?.auto, chars: Number(r?.chars) || 24000, provider: r?.provider || "" };
        setCompact(c);
        charDirty.current = false;
        setCharDraft(String(c.chars));
      })
      .catch(() => {});
  };
  // 失焦不保存没改过的草稿：点开面板又点空白处不该把当前上限写成手动值
  const saveLimit = () => {
    if (!limitDirty.current) return;
    limitDirty.current = false;
    const v = Math.max(4, Math.min(2000, parseInt(limitDraft, 10) || dash.limitK || 128));
    setLimitDraft(String(v));
    try {
      localStorage.setItem("bit.ctxLimitOverride", String(v));
      localStorage.setItem("bit.ctxLimitForce", "1");
    } catch {
      /* 存储被禁时仅本次会话生效 */
    }
    window.dispatchEvent(new Event("bit-ctx-limit"));
  };
  const resetLimitAuto = () => {
    limitDirty.current = false;
    setLimitDraft(String(dash.limitK || 128));
    try {
      localStorage.removeItem("bit.ctxLimitOverride");
      localStorage.removeItem("bit.ctxLimitForce");
    } catch {
      /* 存储被禁时忽略 */
    }
    window.dispatchEvent(new Event("bit-ctx-limit"));
  };
  const saveCompact = (patch) => {
    const next = { ...(compact || { auto: false, chars: 24000, provider: "" }), ...patch };
    setCompact(next);
    api.compactConfigSet(next.auto, Number(next.chars) || 24000, next.provider).catch(() => {});
  };
  const saveChars = () => {
    if (!charDirty.current) return;
    charDirty.current = false;
    const v = Math.max(6000, Math.min(200000, parseInt(charDraft, 10) || 24000));
    setCharDraft(String(v));
    saveCompact({ chars: v });
  };
  const ctxPct = dash.limitK > 0 ? Math.min(1, (dash.tokens || 0) / (dash.limitK * 1024)) : 0;
  const ctxColor = ctxPct >= 0.9 ? "#ef4444" : ctxPct >= 0.7 ? "#f59e0b" : "var(--accent)";
  // 缓存命中折进饼图的读数里（原先是页眉右侧一颗常驻 pill，占位且和用量割裂）：
  // 端点未上报时值只显「—」，原因放到悬停说明，别把整句话挤进面板
  const cacheText = dash.cacheKnown ? `${Math.round((dash.cacheHitRate || 0) * 100)}%` : "—";
  const cacheTip = dash.cacheKnown ? t("chat.cacheTip") : `${t("chat.cacheTip")}\n${t("chat.cacheUnknown")}`;
  // 上限来源标签：接口上报 / Claude 家族默认 / 接口未上报用回退值
  const limitSrcLabel =
    dash.limitSource === "api"
      ? t("chat.ctxSrcApi")
      : dash.limitSource === "claude"
        ? t("chat.ctxSrcClaude")
        : t("chat.ctxSrcFallback");
  const limitSrcTitle =
    dash.limitSource === "api"
      ? t("chat.ctxSrcApiTitle")
      : dash.limitSource === "claude"
        ? t("chat.ctxSrcClaudeTitle")
        : t("chat.ctxSrcFallbackTitle");
  const [memMB, setMemMB] = useState(null);
  // 内环比例：内存 / 2 GB 参考值，超过即满环
  const memPct = memMB === null ? 0 : Math.min(1, memMB / MEM_REF_MB);
  const [update, setUpdate] = useState(null);

  // 标题栏右侧常驻：模型切换 / 工具审批 / 截图。
  // 这三样都是全局状态，原先埋在输入框那一排的小图标里，不点开根本看不见当前值
  const [providers, setProviders] = useState([]);
  const [modelMenu, setModelMenu] = useState(false);
  const [approvalMode, setApprovalMode] = useState("allow_all");
  const [approvalMenu, setApprovalMenu] = useState(false);
  const [canShot, setCanShot] = useState(false);
  // 自动朗读：开关在页眉，消费方（回复完成后触发朗读）在对话页，值走 automationStore
  const [speakOn, setSpeakOn] = useAutoSpeak();
  // 子代理：页眉弹层看实时生命周期 + 自动委派开关；细化管理在「自动化」页
  const [subsMenu, setSubsMenu] = useState(false);
  const [autoDelegate, setAutoDelegate] = useState(false);
  const subs = useSubagents();
  const refreshDelegate = () =>
    api
      .getBehaviorSettings()
      .then((r) => setAutoDelegate(!!r?.auto_delegate))
      .catch(() => {});
  const activeModel = providers.find((p) => p.active) || null;
  const refreshModel = () => api.listProviders().then((r) => setProviders(r.providers || [])).catch(() => {});
  useEffect(() => {
    refreshModel();
    api.getToolApproval().then((r) => setApprovalMode(r?.mode || "allow_all")).catch(() => {});
    // 截图按钮按主进程探测的真实后端显示，不按平台串猜（Windows 的 ms-screenclip 同样可用）
    api.getAppHotkeys().then((r) => setCanShot(!!r?.caps?.screenshot_supported)).catch(() => {});
  }, []);

  // 自动更新：启动 3 秒后查一次，之后每 6 小时复查（localStorage 节流跨重启生效）。
  // 后台下载完成 / 状态变化时由后端发 update-state 事件刷新 pill。
  useEffect(() => {
    const CHECK_KEY = "bit-last-update-check";
    const check = async () => {
      try {
        const last = Number(localStorage.getItem(CHECK_KEY) || 0);
        if (Date.now() - last < 6 * 3600 * 1000) return;
        localStorage.setItem(CHECK_KEY, String(Date.now()));
        const info = await invoke("check_updates");
        if (info?.has_update) setUpdate(info);
      } catch {
        /* 网络不可达时静默跳过 */
      }
    };
    const un = listen("update-state", (e) => {
      const s = e.payload || {};
      if (s.state === "downloaded") {
        setUpdate((prev) => ({
          latest: s.version,
          notes: s.notes || prev?.notes || "",
          url: s.url || prev?.url || "",
          has_update: true,
          downloaded: true,
        }));
      }
    });
    const t = setTimeout(check, 3000);
    const iv = setInterval(check, 6 * 3600 * 1000);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  // 已下载 → 点击直接换装重启（关闭时自动更新之外的手动路径）；
  // 未下载 → 打开下载页
  const openUpdate = () => {
    if (!update) return;
    if (update.downloaded) {
      invoke("update_apply").catch(() => {});
      return;
    }
    invoke("open_external", { url: update.url }).catch(() => {});
  };

  useEffect(() => {
    let timer = null;
    let unlisten = null;
    const clampIntoView = async () => {
      try {
        const w = win();
        if (await w.isMaximized()) return;
        const [pos, size, monitor] = await Promise.all([
          w.outerPosition(),
          w.outerSize(),
          currentMonitor().catch(() => null),
        ]);
        const target = monitor || (await primaryMonitor().catch(() => null));
        const area = target?.workArea;
        if (!area) return;
        const minVisibleX = Math.min(160, Math.max(72, Math.round(size.width * 0.2)));
        const titleBarHeight = 36;
        const minX = area.position.x - size.width + minVisibleX;
        const maxX = area.position.x + area.size.width - minVisibleX;
        const minY = area.position.y;
        const maxY = area.position.y + area.size.height - titleBarHeight;
        const nextX = Math.min(maxX, Math.max(minX, pos.x));
        const nextY = Math.min(maxY, Math.max(minY, pos.y));
        if (nextX !== pos.x || nextY !== pos.y) {
          await w.setPosition(new PhysicalPosition(nextX, nextY));
        }
      } catch {
        /* 忽略：旧权限或平台差异时保持原生行为 */
      }
    };
    const scheduleClamp = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(clampIntoView, 140);
    };
    clampIntoView();
    win()
      .onMoved(scheduleClamp)
      .then((f) => {
        unlisten = f;
      })
      .catch(() => {});
    return () => {
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  // ChatPage 广播会话数与当前上下文 Token
  useEffect(() => {
    const h = (e) => setDash(e.detail || {});
    window.addEventListener("bit-dash", h);
    return () => window.removeEventListener("bit-dash", h);
  }, []);

  // 插件运行异常（崩溃 / 启动失败 / 端口未就绪）：核心登记后广播，页眉亮一颗异常灯。
  // 挂载时先取一次快照兜底——事件可能在 JS 监听之前就发过了。清除用 phase=ok。
  const [pluginAlerts, setPluginAlerts] = useState([]);
  useEffect(() => {
    const apply = (p) => {
      if (!p?.id) return;
      setPluginAlerts((prev) => {
        const rest = prev.filter((x) => x.id !== p.id);
        return p.phase === "ok" ? rest : [...rest, p];
      });
    };
    api.pluginHealth()
      .then((r) => setPluginAlerts(Array.isArray(r?.entries) ? r.entries : []))
      .catch(() => {});
    const un = listen("plugin-health", (e) => apply(e.payload || {}));
    return () => un.then((f) => f()).catch(() => {});
  }, []);

  // 恢复自动后 ChatPage 会广播新的生效上限，编辑框跟着走（用户正在输入时不打扰）
  useEffect(() => {
    if (ctxMenu && !limitDirty.current) setLimitDraft(String(dash.limitK || 128));
  }, [dash.limitK, ctxMenu]);

  // 本进程内存占用，3 秒轮询
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const b = await invoke("mem_usage");
        if (!stop) setMemMB(Math.round((b?.bytes ?? b ?? 0) / 1048576));
      } catch {
        /* 忽略：命令不可用时隐藏该项 */
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  // 页眉工具位：顺序与落位来自全站共享的那份布局（左栏 / 对话页两排也在里面），
  // 所以这里的图标能拖到别的排、别的图标也能拖到这儿来。
  // 宿主注入的那几颗（搜索/明暗/语言/关于）按 extras 的键名进同一排，一起拖。
  const extraIds = Object.keys(extras || {});
  const barRawIds = [...BUILTIN_TOOLS, ...extraIds];
  const barIds = barRawIds.map((id) => TITLE_PREFIX + id);
  const bar = useIconSpace();
  // 页眉那一簇紧贴图标，自己没有空白可点；把图标库菜单借给中间那块拖动区当入口
  const barAddRef = useRef(null);

  // 页眉这一排的图标节点：先攒成表，交给 IconRow 按用户排好的顺序画（可拖 / 可右键摘掉 / 放不下折进「⋯」）
  const barRawNodes = {
    model: (
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (!modelMenu) refreshModel();
            setModelMenu(!modelMenu);
          }}
          title={activeModel ? `${t("chat.pickModel")} · ${activeModel.model}` : t("chat.pickModel")}
          className="flex h-6 max-w-52 items-center gap-1 rounded-full px-2 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <InkGlyph icon={IconBolt} size={14} ink={GLYPH_INK} className="shrink-0" />
          <span className="truncate font-mono">{activeModel?.model || t("chat.noModel")}</span>
          <span className="shrink-0 opacity-60">▾</span>
        </button>
        {modelMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setModelMenu(false)} />
            <Popup
              align="end"
              className="card max-h-80 w-64 rounded-[var(--look-ui-radius,1rem)] p-1"
              onDismiss={() => setModelMenu(false)}
            >
              {providers.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-neutral-500">{t("chat.noModel")}</div>
              )}
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={async () => {
                    // set_provider_active 互斥：激活一个即暂停其余
                    await api.setProviderActive(p.id, true).catch(() => {});
                    await refreshModel();
                    setModelMenu(false);
                  }}
                  className={`flex w-full flex-col gap-0.5 rounded-xl px-3 py-1.5 text-left text-[11px] hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                    p.active ? "accent-solid font-semibold" : ""
                  }`}
                >
                  <span className="truncate">{p.name}</span>
                  <span className={`truncate font-mono ${p.active ? "opacity-75" : "text-neutral-500"}`}>
                    {p.model}
                  </span>
                </button>
              ))}
            </Popup>
          </>
        )}
      </div>
    ),
    approval: (
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (!approvalMenu) api.getToolApproval().then((r) => setApprovalMode(r?.mode || "allow_all")).catch(() => {});
            setApprovalMenu(!approvalMenu);
          }}
          title={t("chat.approvalMode")}
          className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
            approvalMode !== "allow_all"
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : "text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          }`}
        >
          <InkGlyph icon={IconShield} size={14} ink={GLYPH_INK} />
        </button>
        {approvalMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setApprovalMenu(false)} />
            <Popup
              align="end"
              className="card w-56 rounded-[var(--look-ui-radius,1rem)] p-1"
              onDismiss={() => setApprovalMenu(false)}
            >
              {[
                ["ask", "chat.approvalAsk"],
                ["auto", "chat.approvalAuto"],
                ["l2pass", "chat.approvalL2"],
                ["allow_all", "chat.approvalAllowAll"],
              ].map(([m, k]) => (
                <button
                  key={m}
                  type="button"
                  onClick={async () => {
                    setApprovalMode(m);
                    setApprovalMenu(false);
                    await api.setToolApproval(m).catch(() => {});
                  }}
                  className={`w-full rounded-lg px-3 py-1.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                    approvalMode === m ? "font-semibold" : "text-neutral-500 dark:text-neutral-400"
                  }`}
                >
                  {t(k)}
                </button>
              ))}
            </Popup>
          </>
        )}
      </div>
    ),
    shot: canShot ? (
      <>
        <button
          type="button"
          onClick={() => api.screenshotRegion().catch(() => {})}
          title={t("chat.screenshot")}
          className="flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <InkGlyph icon={IconScissors} size={14} ink={GLYPH_INK} />
        </button>
      </>
    ) : null,
    speak: (
      <>
        <button
          type="button"
          onClick={() => setSpeakOn(!speakOn)}
          title={t("chat.autoSpeak")}
          className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
            speakOn
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : "text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          }`}
        >
          <InkGlyph icon={speakOn ? IconSpeaker : IconSpeakerOff} size={14} ink={GLYPH_INK} />
        </button>
      </>
    ),
    subs: (
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (!subsMenu) refreshDelegate();
            setSubsMenu((v) => !v);
          }}
          title={subs.length ? `${t("auto.subagents")} · ${subs.length}` : t("auto.subagents")}
          className={`flex h-6 items-center gap-1 rounded-full px-1.5 transition-colors ${
            subs.length
              ? "accent-solid"
              : "text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          }`}
        >
          <InkGlyph icon={IconQueue} size={14} ink={GLYPH_INK} />
          {subs.length > 0 && <span className="text-[10px] font-semibold tabular-nums">{subs.length}</span>}
        </button>
        {subsMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSubsMenu(false)} />
            <Popup
              align="end"
              className="card w-72 rounded-[var(--look-ui-radius,1rem)] p-2"
              onDismiss={() => setSubsMenu(false)}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-xs font-medium">{t("auto.autoDelegate")}</p>
                <PillSwitch
                  size="sm"
                  checked={autoDelegate}
                  title={autoDelegate ? t("auto.delegateOnTip") : t("auto.delegateOffTip")}
                  onChange={async (v) => {
                    setAutoDelegate(v);
                    try {
                      await patchBehavior({ auto_delegate: v });
                    } catch {
                      refreshDelegate(); // 写失败回滚到后端真实值
                    }
                  }}
                />
              </div>
              {subs.length === 0 ? (
                <p className="px-1 py-3 text-center text-[11px] text-neutral-400">{t("auto.subagentsEmpty")}</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {subs.map((s) => {
                    const done = s.phase === "done";
                    const failed = s.phase === "error";
                    return (
                      <li key={s.session_id} className="rounded-md px-1.5 py-1 hover:bg-neutral-900/5 dark:hover:bg-white/10">
                        <div className="flex items-center justify-between gap-1.5">
                          <span
                            title={s.task || s.title || ""}
                            className={`min-w-0 truncate text-[11px] font-medium ${
                              failed
                                ? "text-red-500"
                                : done
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-neutral-700 dark:text-neutral-200"
                            }`}
                          >
                            {s.title || t("auto.subagent")}
                          </span>
                          <span className="shrink-0 text-[10px] text-neutral-400">
                            {!done && !failed ? (
                              <button
                                type="button"
                                onClick={() => api.stopSubagent(s.session_id).catch(() => {})}
                                title={t("chat.stop")}
                                className="inline-flex items-center rounded px-1 py-0.5 text-neutral-400 hover:bg-red-500/10 hover:text-red-500"
                              >
                                <IconStop size={10} />
                              </button>
                            ) : failed ? (
                              "✗"
                            ) : (
                              "✓"
                            )}
                          </span>
                        </div>
                        {(s.task || s.error) && (
                          <p
                            className={`mt-0.5 truncate text-[10px] leading-snug ${failed ? "text-red-500" : "text-neutral-400"}`}
                            title={failed ? s.error : s.task}
                          >
                            {failed ? s.error : s.task}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <button
                type="button"
                onClick={() => {
                  setSubsMenu(false);
                  onOpenAutomation?.();
                }}
                className="pill-outline pill-hover mt-2 flex w-full items-center justify-center px-2 py-1 text-[11px]"
              >
                {t("auto.openPage")}
              </button>
            </Popup>
          </>
        )}
      </div>
    ),
    ...Object.fromEntries(extraIds.map((id) => [id, extras[id]])),
  };
  const barNodes = {};
  for (const [id, node] of Object.entries(barRawNodes)) barNodes[TITLE_PREFIX + id] = node;
  // 登记进全站图标空间：别的排也能画出模型 / 审批 / 朗读这些页眉图标
  useIconSurface("title", {
    ids: barIds,
    homes: Object.fromEntries(barIds.map((id) => [id, BAR_ZONE])),
    nodes: barNodes,
    labels: {},
  });

  // 一盏灯两件事：颜色说会话忙闲，插件出问题时在同一颗灯上叠异常态（灰与当前色交替闪）。
  // 原来这里并排两颗 12px 的灯，页眉左上角白占一格，点开还得分两个入口——合成一颗，
  // 统计面板与异常清单走同一个浮层，异常项直接跳插件页，功能一样不少。
  const lampState = !dash.running ? "is-idle" : dash.tool ? "is-tool" : dash.thinking ? "is-think" : "is-work";
  const lampTitle = !dash.running
    ? t("title.lampIdle")
    : dash.tool
      ? t("title.lampTool")
      : dash.thinking
        ? t("title.lampThink")
        : t("title.lampWork");
  // 指示灯即事件展示器：点开看本对话到目前为止的工具调用统计（ChatPage 随 bit-dash 一起广播）
  const [hooksMenu, setHooksMenu] = useState(false);
  const hooks = dash.hooks || { total: 0, kinds: 0, fail: 0, list: [], recent: [] };
  const alerting = pluginAlerts.length > 0;
  const lampHint = alerting
    ? `${t("title.pluginAlert")} ×${pluginAlerts.length} · ${t("title.pluginAlertOpen")}`
    : `${lampTitle} · ${t("title.lampStats")}`;
  // 跳到插件页并选中出问题的包：服务器卡片里能直接看日志、点重启
  const openPluginHome = (id) =>
    window.dispatchEvent(new CustomEvent("bit-open-page", { detail: { page: "plugins", plugin: id } }));

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center gap-2 pl-4 pr-4 pt-1"
      style={isMac ? { paddingLeft: 76 } : undefined}
    >
      {/* 页眉仪表盘（可拖动） */}
      <div
        data-tauri-drag-region
        className="anim-rise flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500"
      >
        <div className={`relative flex items-center${hooksMenu ? " z-50" : ""}`}>
          <button
            type="button"
            aria-expanded={hooksMenu}
            aria-label={lampHint}
            title={lampHint}
            onClick={() => setHooksMenu((v) => !v)}
            className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-neutral-900/10 dark:hover:bg-white/15"
          >
            <span className={`title-lamp ${lampState}${alerting ? " is-alert" : ""}`} />
          </button>
          {hooksMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setHooksMenu(false)} />
              <Popup
                data-bit-lamp-panel="1"
                className="card flex w-72 max-w-[calc(100vw-24px)] flex-col gap-2 rounded-[var(--look-ui-radius,1rem)] p-3 text-[11px]"
                onDismiss={() => setHooksMenu(false)}
              >
                {alerting && (
                  <>
                    <div className="text-xs font-medium text-red-500">
                      {t("title.pluginAlert")} ×{pluginAlerts.length}
                    </div>
                    {/* 异常清单进同一个浮层：一颗灯一个入口，点某一条直接落到那个插件的卡片看日志 */}
                    <ul className="flex flex-col gap-1">
                      {pluginAlerts.map((a) => (
                        <li key={a.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setHooksMenu(false);
                              openPluginHome(a.id);
                            }}
                            title={t("title.pluginAlertTip")}
                            className="flex w-full items-start gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
                          >
                            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-neutral-700 dark:text-neutral-200">
                                {a.name || a.id}
                              </span>
                              <span className="block truncate text-neutral-400">
                                {t(ALERT_PHASE[a.phase] || "title.pluginAlert")}
                                {a.message ? ` · ${a.message}` : ""}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="h-px bg-neutral-200 dark:bg-neutral-800" />
                  </>
                )}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                    {t("chat.hooksHint")}
                  </span>
                  <span className="shrink-0 tabular-nums text-[10px] text-neutral-400">
                    {t("chat.hooksKinds", { n: hooks.kinds })}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 tabular-nums text-neutral-500 dark:text-neutral-400">
                  <span>{t("chat.hooks", { n: hooks.total })}</span>
                  {hooks.fail > 0 && <span className="text-red-500">· {t("chat.hooksFail", { n: hooks.fail })}</span>}
                </div>
                {hooks.total === 0 ? (
                  <p className="py-2 text-center text-[11px] text-neutral-400">{t("chat.hooksNone")}</p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {hooks.list.map(([tool, n]) => (
                        <span
                          key={tool}
                          className="rounded-full bg-neutral-100 px-2 py-0.5 font-mono text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                        >
                          {tool} ×{n}
                        </span>
                      ))}
                    </div>
                    <div className="h-px bg-neutral-200 dark:bg-neutral-800" />
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                      {t("chat.hooksRecent")}
                    </div>
                    <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                      {hooks.recent.map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[11px]">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.ok ? "bg-emerald-500" : "bg-red-500"}`} />
                          <span className="shrink-0 font-mono text-neutral-600 dark:text-neutral-300">{c.tool}</span>
                          {c.summary && (
                            <span className="min-w-0 flex-1 truncate text-neutral-400" title={c.summary}>
                              {c.summary}
                            </span>
                          )}
                          {c.ts && <span className="ml-auto shrink-0 text-[10px] text-neutral-400">{c.ts.slice(11, 16)}</span>}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </Popup>
            </>
          )}
        </div>
        {update && (
          <button
            onClick={openUpdate}
            title={update.notes ? `${update.notes.slice(0, 120)}` : t("title.updateTo", { version: update.latest })}
            className="accent-solid rounded-full px-2 py-0.5 text-[10px] font-semibold"
          >
            {update.downloaded ? t("title.updateApply") : t("title.updateAvailable")} v{update.latest}
          </button>
        )}
        {update && <span className="opacity-50">·</span>}
        {/* 资源统计图：外环上下文占用，内环进程内存（2 GB 参考），悬停看明细（含缓存命中），点击改上限与压缩阈值。
            面板打开时把触发钮抬到全屏背板之上，再点一次就能收起 */}
        <div className={`relative flex items-center${ctxMenu || ctxHover ? " z-50" : ""}`}>
          <button
            type="button"
            aria-label={`${t("chat.ctxPieLabel")} ${Math.round(ctxPct * 100)}%${
              memMB !== null ? ` · ${t("chat.memUsage")} ${fmtMem(memMB)}` : ""
            }${dash.showCache ? ` · ${t("chat.cacheHit")} ${cacheText}` : ""}`}
            title={`${fmtK(dash.tokens)} / ${dash.limitK}K tok${
              memMB !== null ? ` · ${t("chat.memUsage")} ${fmtMem(memMB)}` : ""
            }${dash.showCache ? ` · ${t("chat.cacheHit")} ${cacheText}` : ""}`}
            onClick={() => (ctxMenu ? setCtxMenu(false) : openCtxMenu())}
            onMouseEnter={() => setCtxHover(true)}
            onMouseLeave={() => setCtxHover(false)}
            className="relative z-50 flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-30" />
              <circle
                cx="8"
                cy="8"
                r="6.2"
                fill="none"
                stroke={ctxColor}
                strokeWidth="2"
                strokeDasharray={`${(2 * Math.PI * 6.2 * ctxPct).toFixed(2)} ${(2 * Math.PI * 6.2).toFixed(2)}`}
                transform="rotate(-90 8 8)"
                style={{ transition: "stroke-dasharray .4s ease, stroke .4s ease" }}
              />
              <circle cx="8" cy="8" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.12" />
              {memMB !== null && (
                <circle
                  cx="8"
                  cy="8"
                  r="3.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeOpacity="0.6"
                  strokeDasharray={`${(2 * Math.PI * 3.4 * memPct).toFixed(2)} ${(2 * Math.PI * 3.4).toFixed(2)}`}
                  transform="rotate(-90 8 8)"
                  style={{ transition: "stroke-dasharray .4s ease" }}
                />
              )}
            </svg>
          </button>
          {ctxHover && !ctxMenu && (
            <Popup className="pointer-events-none w-max max-w-72 rounded-xl border border-neutral-200 bg-white/95 px-2.5 py-1.5 text-[11px] leading-snug shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95">
              <div className="tabular-nums text-neutral-700 dark:text-neutral-200">
                {dash.sessions} {t("chat.unitSessions")} · {fmtK(dash.tokens)} / {dash.limitK}K tok ·{" "}
                {Math.round(ctxPct * 100)}% · {limitSrcLabel}
              </div>
              {memMB !== null && (
                <div className="mt-0.5 tabular-nums text-neutral-500 dark:text-neutral-300">
                  {t("chat.memUsage")} {fmtMem(memMB)}
                </div>
              )}
              {dash.showCache && (
                <div className="mt-0.5 tabular-nums text-neutral-500 dark:text-neutral-300" title={cacheTip}>
                  {t("chat.cacheHit")} {cacheText}
                </div>
              )}
              <div className="mt-0.5 text-[10px] text-neutral-400">{t("chat.ctxPieHint")}</div>
              {memMB !== null && (
                <div className="text-[10px] text-neutral-400">{t("chat.memHint")}</div>
              )}
            </Popup>
          )}
          {ctxMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(false)} />
              <Popup
                className="card flex w-72 flex-col gap-2.5 rounded-[var(--look-ui-radius,1rem)] p-3 text-[11px]"
                onDismiss={() => setCtxMenu(false)}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                    {t("chat.ctxLength")}
                  </span>
                  <span className="tabular-nums text-[10px] text-neutral-400">
                    {fmtK(dash.tokens)} / {dash.limitK}K tok · {Math.round(ctxPct * 100)}%
                  </span>
                </div>
                {memMB !== null && (
                  <div className="flex items-baseline justify-between gap-2 text-[10px] text-neutral-400">
                    <span>{t("chat.memUsage")}</span>
                    <span className="tabular-nums" title={t("chat.memHint")}>
                      {fmtMem(memMB)}
                    </span>
                  </div>
                )}
                {dash.showCache && (
                  <div className="flex items-baseline justify-between gap-2 text-[10px] text-neutral-400">
                    <span>{t("chat.cacheHit")}</span>
                    <span className="tabular-nums" title={cacheTip}>
                      {cacheText}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    type="text"
                    inputMode="numeric"
                    value={limitDraft}
                    onChange={(e) => {
                      limitDirty.current = true;
                      setLimitDraft(e.target.value.replace(/[^\d]/g, ""));
                    }}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={saveLimit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveLimit();
                        e.currentTarget.blur();
                      } else if (e.key === "Escape") {
                        limitDirty.current = false;
                        setLimitDraft(String(dash.limitK || 128));
                      }
                    }}
                    className="w-20 rounded border border-neutral-300 bg-transparent px-1.5 py-1 text-right text-[11px] tabular-nums outline-none focus:border-[var(--accent)] dark:border-neutral-700"
                  />
                  <span className="text-neutral-400">K tok</span>
                  {dash.limitForce ? (
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={resetLimitAuto}
                      title={t("chat.ctxAutoTitle")}
                      className="ml-auto underline decoration-dotted underline-offset-2 hover:opacity-70"
                    >
                      {t("chat.ctxResetAuto")}
                    </button>
                  ) : (
                    <span
                      title={`${limitSrcTitle} · ${dash.limitK}K tok`}
                      className="ml-auto rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:text-neutral-400"
                    >
                      {limitSrcLabel}
                    </span>
                  )}
                </div>
                <div className="h-px bg-neutral-200 dark:bg-neutral-800" />
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                      {t("ai.autoCompact")}
                    </p>
                    <p className="text-[10px] leading-snug text-neutral-400">{t("ai.compactCharsHint")}</p>
                  </div>
                  <PillSwitch
                    checked={!!compact?.auto}
                    disabled={!compact}
                    title={t("ai.autoCompact")}
                    onChange={(v) => saveCompact({ auto: v })}
                  />
                </div>
                {compact?.auto && (
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[10px] text-neutral-400">{t("ai.compactChars")}</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={charDraft}
                      onChange={(e) => {
                        charDirty.current = true;
                        setCharDraft(e.target.value.replace(/[^\d]/g, ""));
                      }}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={saveChars}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          saveChars();
                          e.currentTarget.blur();
                        } else if (e.key === "Escape") {
                          charDirty.current = false;
                          setCharDraft(String(compact.chars));
                        }
                      }}
                      className="ml-auto w-24 rounded border border-neutral-300 bg-transparent px-1.5 py-1 text-right text-[11px] tabular-nums outline-none focus:border-[var(--accent)] dark:border-neutral-700"
                    />
                  </div>
                )}
              </Popup>
            </>
          )}
        </div>
      </div>

      {/* 弹性拖动区（self-stretch：空 div 在 items-center 下面高度是 0，撑不住就点不到）：
          右键这块空白 = 从图标库往页眉那一簇补一颗 */}
      <div data-tauri-drag-region className="flex-1 self-stretch" onContextMenu={(e) => barAddRef.current?.(e)} />

      {/* 常驻工具：模型 / 审批 / 截图 / 朗读 / 子代理，外加宿主注入的偏好项。
          整排横向可拖，改的是这一排的内部顺序（与对话页图标排、左栏导航共用一套机制）；
          右键图标摘掉它、右键空白从图标库补回来，窗口太窄放不下时尾部自动折进「⋯」。
          落在窗口按钮左侧，本身不参与窗口拖拽。 */}
      <IconRow
        layout={bar}
        zone={BAR_ZONE}
        nodes={barNodes}
        className="shrink-0 pr-1"
        nowrap
        shrinkSlots
        minGap={8}
        fitPx={24}
        popClass="left-0 top-7"
        addMenuRef={barAddRef}
        style={{ WebkitAppRegion: "no-drag" }}
      />

      {/* 窗口按钮（macOS 由系统红绿灯提供，不重复渲染） */}
      {!isMac && (
        <>
          <button
            onClick={minimize}
            aria-label={t("title.minimize")}
            className="flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <IconMinus size={13} />
          </button>
          <button
            onClick={toggleMax}
            aria-label={t("title.maximize")}
            className="flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <IconSquare size={12} />
          </button>
          <button
            onClick={close}
            aria-label={t("common.close")}
            className="flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-red-600 hover:text-white"
          >
            <IconX size={14} />
          </button>
        </>
      )}
    </div>
  );
}
