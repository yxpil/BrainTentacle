import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import PillSwitch from "../components/PillSwitch.jsx";
import { IconTrash, IconEye } from "../components/Icons.jsx";
import { subscribePluginTakeovers, getPluginTakeoverClaims, setPluginTakeover } from "../pluginHost.js";

// 接管槽位的中文键（与后端 TAKEOVER_SLOTS 一一对应；设置槽位不在目录里）
const TAKEOVER_SLOT_KEY = {
  "chat.voice": "sec.takeover.slotVoice",
  "chat.preview": "sec.takeover.slotPreview",
  "chat.attach": "sec.takeover.slotAttach",
  "chat.plan": "sec.takeover.slotPlan",
  "chat.template": "sec.takeover.slotTemplate",
  "chat.web": "sec.takeover.slotWeb",
  "chat.bgjobs": "sec.takeover.slotBgJobs",
};

/**
 * SecurityPage —— 安全中心
 *  - HiddenCode 敏感信息脱敏：发给 AI 前替换为占位符，工具本机执行时自动还原
 *  - L2 PASS：非安全工具执行前用另一个模型审核放行（不可达时回退人工审批）
 */
export default function SecurityPage({ group }) {
  const { t } = useLang();
  // group = 设置中心左栏当前卡片对应的组；其余组只藏不卸载
  const gstyle = (id) => (group && group !== id ? { display: "none" } : undefined);

  // —— 安全设置（两个总开关 + 审核 provider）——
  const [sec, setSec] = useState({
    hidden_code_enabled: false,
    l2pass_enabled: false,
    l2pass_provider_id: "",
    l2pass_cover_auto: false,
    l2pass_prompt: "",
    l2pass_prompt_default: "",
  });
  // L2 审核提示词草稿：长文本不逐字保存，点「保存提示词」才落盘
  const [promptDraft, setPromptDraft] = useState("");
  const [promptSaving, setPromptSaving] = useState(false);
  // 当前工具审批模式：l2pass 时 L2 卡即使总开关关着也会生效
  const [approvalMode, setApprovalMode] = useState("ask");
  // L2 就地提示（没有可用 provider 等）：不走页面顶部红色错误条，避免把用户甩到别处看原因
  const [l2Hint, setL2Hint] = useState("");
  // —— 插件接管 ——
  // 快照来自 pluginHost（与对话页同一份）：这里列出生效中的接管与冲突，
  // 每行都能单独"恢复内置"，插件停用/删除也会让对应行自动消失。
  const takeoverClaims = useSyncExternalStore(subscribePluginTakeovers, getPluginTakeoverClaims);
  const [takeBusy, setTakeBusy] = useState("");
  const [takeErr, setTakeErr] = useState("");
  // granted=false 恢复内置，true 把槽位重新交给插件（撤回是双向的）
  const setTakeover = async (c, granted) => {
    setTakeErr("");
    setTakeBusy(`${c.plugin_id}:${c.slot}`);
    try {
      await setPluginTakeover(c.plugin_id, c.slot, granted);
    } catch (e) {
      setTakeErr(errText(e));
    } finally {
      setTakeBusy("");
    }
  };
  // —— HiddenCode 条目 ——
  const [entries, setEntries] = useState([]);
  // —— provider 列表（L2 审核模型选择）——
  const [providers, setProviders] = useState([]);

  // 新条目表单
  const [kind, setKind] = useState("phone");
  const [value, setValue] = useState("");
  const [alias, setAlias] = useState("");
  const [asPattern, setAsPattern] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // 扫描探测
  const [scanText, setScanText] = useState("");
  const [candidates, setCandidates] = useState(null);

  // 条目值显隐（避免密钥常驻可见）
  const [revealed, setRevealed] = useState({});

  const load = () => {
    api.getSecuritySettings().then(setSec).catch(() => {});
    api.getHiddenCodes().then((r) => setEntries(r || [])).catch(() => {});
    api.listProviders().then((r) => setProviders(r.providers || [])).catch(() => {});
    api.getToolApproval().then((r) => setApprovalMode(r?.mode || "ask")).catch(() => {});
  };
  useEffect(load, []);
  // 服务端提示词变化（加载/保存/恢复默认）时同步草稿
  useEffect(() => {
    setPromptDraft(sec.l2pass_prompt || "");
  }, [sec.l2pass_prompt]);

  // 宿主错误带着 "Error invoking remote method..." 外壳，主界面只展示最后的原因
  const errText = (e) => String(e?.message || e).replace(/^.*Error[:：]\s*/, "");

  const saveSec = async (partial) => {
    setErr("");
    const next = { ...sec, ...partial };
    try {
      const r = await api.setSecuritySettings(
        next.hidden_code_enabled,
        next.l2pass_enabled,
        next.l2pass_provider_id,
        next.l2pass_cover_auto,
        next.l2pass_prompt,
      );
      // 合并而非整包覆盖：历史教训——后端只回 {ok} 时整包覆盖会把开关全部打挂
      setSec((prev) => ({ ...prev, ...r }));
    } catch (e) {
      setErr(errText(e));
    }
  };

  // L2 开关：没选审核模型时自动落到第一个已配置提供方；一个都没有就就地提示，不发请求
  const toggleL2 = (enabled) => {
    if (!enabled) {
      setL2Hint("");
      saveSec({ l2pass_enabled: false });
      return;
    }
    const picked = providers.some((p) => p.id === sec.l2pass_provider_id)
      ? sec.l2pass_provider_id
      : providers[0]?.id || "";
    if (!picked) {
      setL2Hint(t("sec.l2.needProvider", "还没有可用的模型提供方：先在「模型提供方」里配置一个，再开启 L2 审核"));
      return;
    }
    setL2Hint("");
    saveSec({ l2pass_enabled: true, l2pass_provider_id: picked });
  };

  const promptDirty = promptDraft !== (sec.l2pass_prompt || "");
  const savePrompt = async () => {
    setPromptSaving(true);
    try {
      await saveSec({ l2pass_prompt: promptDraft });
    } finally {
      setPromptSaving(false);
    }
  };
  const resetPrompt = () => {
    setPromptDraft("");
    saveSec({ l2pass_prompt: "" });
  };

  const addEntry = async () => {
    setErr("");
    setBusy(true);
    try {
      await api.addHiddenCode(kind, value, asPattern, alias);
      setValue("");
      setAlias("");
      api.getHiddenCodes().then((r) => setEntries(r || [])).catch(() => {});
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeEntry = async (id) => {
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("common.confirmDelete"),
        danger: true,
      }))
    )
      return;
    await api.removeHiddenCode(id).catch(() => {});
    api.getHiddenCodes().then((r) => setEntries(r || [])).catch(() => {});
  };

  const toggleEntry = async (id, enabled) => {
    await api.setHiddenCodeEnabled(id, enabled).catch(() => {});
    api.getHiddenCodes().then((r) => setEntries(r || [])).catch(() => {});
  };

  const scan = async () => {
    setCandidates([]);
    if (!scanText.trim()) return;
    try {
      const r = await api.scanHiddenCandidates(scanText);
      setCandidates(r || []);
    } catch (e) {
      setErr(String(e));
    }
  };

  // 探测结果一键加入条目（按精确值保存）
  const addCandidate = async (c) => {
    setErr("");
    try {
      await api.addHiddenCode(c.label, c.value, false);
      api.getHiddenCodes().then((r) => setEntries(r || [])).catch(() => {});
      setCandidates((cs) => (cs || []).filter((x) => x.value !== c.value));
    } catch (e) {
      setErr(String(e));
    }
  };

  // 值展示：密钥等敏感值默认打码，可点眼睛临时显示
  const maskValue = (v, show) => {
    if (show) return v;
    if (v.length <= 8) return "••••••";
    return v.slice(0, 4) + "••••" + v.slice(-4);
  };

  const kindLabel = (e) =>
    e.kind === "pattern"
      ? `${t("sec.hc.asPattern", "按类型掩码全部匹配")} · ${kindName(e.label)}`
      : kindName(e.label);
  const kindName = (k) =>
    t(`sec.hc.kind.${k}`, k === "custom" ? "自定义" : k);

  return (
    <div className="page">
      {err && (
        <div className="card border border-red-400/40 text-sm text-red-500">{err}</div>
      )}

      {/* ==== HiddenCode 敏感信息脱敏 ==== */}
      <section className="set-group" id="set-sec-hidden" style={gstyle("sec-hidden")}>
        <div className="set-grid">
        <div className="card space-y-4">
          <div>
            <div className="font-medium">{t("sec.hc.title", "敏感信息脱敏（HiddenCode）")}</div>
            <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t("sec.hc.desc", "发给 AI 前将密钥/手机号/邮箱等敏感值替换为占位符，工具在本机执行时自动还原真实值。")}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm">{t("sec.hc.enabled", "启用脱敏")}</span>
            <PillSwitch
              checked={sec.hidden_code_enabled}
              onChange={(v) => saveSec({ hidden_code_enabled: v })}
            />
          </div>

          {/* 新条目：与上方开关同一块面板，只用发丝线分段 */}
          <div
            className={`space-y-3 border-t border-neutral-200/70 pt-4 dark:border-neutral-800/70 ${
              !sec.hidden_code_enabled ? "opacity-40" : ""
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={kind}
                onChange={(e) => {
                  const k = e.target.value;
                  setKind(k);
                  // 自定义类型即正则模式：匹配到的每段文本都生成占位符
                  setAsPattern(k === "custom");
                }}
                className="field w-auto"
              >
                <option value="phone">{t("sec.hc.kind.phone", "手机号")}</option>
                <option value="email">{t("sec.hc.kind.email", "邮箱")}</option>
                <option value="apikey">{t("sec.hc.kind.apikey", "API 密钥")}</option>
                <option value="username">{t("sec.hc.kind.username", "用户名")}</option>
                <option value="custom">{t("sec.hc.kind.custom", "自定义")}</option>
              </select>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={
                  asPattern
                    ? kind === "custom"
                      ? t("sec.hc.regexPlaceholder", "正则表达式，如 sk-[A-Za-z0-9]{20,}")
                      : t("sec.hc.valueOptional", "值（留空掩全部）")
                    : t("sec.hc.value", "值")
                }
                className="field min-w-0 flex-1"
              />
              {!asPattern && (
                <input
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  placeholder={t("sec.hc.aliasPlaceholder", "别名（可选），如 李四")}
                  title={t("sec.hc.aliasHint", "AI 看到的是别名而非占位符；本机执行工具时自动换回真实值")}
                  className="field min-w-0 flex-1"
                />
              )}
              <button
                disabled={busy}
                onClick={addEntry}
                className="pill"
              >
                {t("sec.hc.add", "添加条目")}
              </button>
            </div>
            {kind !== "custom" && (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <input type="checkbox" className="size-4 accent-neutral-800" checked={asPattern} onChange={(e) => setAsPattern(e.target.checked)} />
                {t("sec.hc.asPattern", "按类型掩码全部匹配")}
                <span className="text-neutral-400 dark:text-neutral-500">
                  {t("sec.hc.patternHintShort", "值留空时掩掉该类型的所有匹配项")}
                </span>
              </label>
            )}
            {kind === "custom" && (
              <div className="text-xs text-neutral-400 dark:text-neutral-500">
                {t(
                  "sec.hc.regexHint",
                  "填入正则表达式，所有匹配到的文本都会被替换为占位符（Rust regex 语法，不支持 lookbehind / 反向引用）",
                )}
              </div>
            )}
          </div>

          {/* 条目列表 */}
          <div className="space-y-2">
            {entries.length === 0 && (
              <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-4 text-center text-xs text-neutral-400 dark:border-neutral-700">{t("sec.hc.empty", "暂无条目")}</div>
            )}
            {entries.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-2 rounded-2xl border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700"
              >
                <span className="chip shrink-0">
                  {kindLabel(e)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {e.kind === "pattern"
                    ? e.value /* 正则/内置名本身不敏感，直接展示 */
                    : maskValue(e.value, revealed[e.id])}
                </span>
                {e.alias && (
                  <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">
                    → {e.alias}
                  </span>
                )}
                {e.kind !== "pattern" && e.value && (
                  <button
                    onClick={() => setRevealed((r) => ({ ...r, [e.id]: !r[e.id] }))}
                    className="icon-btn shrink-0"
                    title={revealed[e.id] ? t("common.hide", "隐藏") : t("common.show", "显示")}
                  >
                    <IconEye size={15} />
                  </button>
                )}
                <PillSwitch checked={e.enabled} onChange={(v) => toggleEntry(e.id, v)} />
                <button
                  onClick={() => removeEntry(e.id)}
                  className="icon-btn shrink-0 hover:bg-red-50 hover:text-red-500"
                  title={t("common.delete", "删除")}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            ))}
          </div>

          {/* 扫描探测 */}
          <div className="space-y-2 border-t border-neutral-200/70 pt-4 dark:border-neutral-800/70">
            <div className="text-sm font-medium">{t("sec.hc.scan", "扫描探测")}</div>
            <textarea
              value={scanText}
              onChange={(e) => setScanText(e.target.value)}
              placeholder={t("sec.hc.scanText", "粘贴文本以探测敏感信息（不自动保存）")}
              rows={3}
              className="field rounded-[var(--look-ui-radius,1rem)] resize-y"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={scan}
                className="pill-outline pill-hover"
              >
                {t("sec.hc.scan", "扫描探测")}
              </button>
              {candidates && candidates.length === 0 && (
                <span className="text-xs text-neutral-400">
                  {t("sec.hc.scanEmpty", "未发现疑似敏感信息")}
                </span>
              )}
            </div>
            {candidates && candidates.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs text-neutral-500">{t("sec.hc.candidates", "探测结果")}</div>
                {candidates.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-2xl bg-neutral-50 px-2 py-1.5 text-xs dark:bg-neutral-800/60"
                  >
                    <span className="chip shrink-0">
                      {kindName(c.label)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {maskValue(c.value, false)}
                    </span>
                    <button
                      onClick={() => addCandidate(c)}
                      className="pill pill-hover shrink-0 text-xs"
                    >
                      {t("common.add", "添加")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        </div>

      </section>

      {/* ==== L2 PASS 二级模型审核 ==== */}
      <section className="set-group" id="set-sec-l2" style={gstyle("sec-l2")}>
        <div className="set-grid">
        <div className="card space-y-4">
          <div>
            <div className="font-medium">{t("sec.l2.title", "二级模型审核（L2 PASS · 实验）")}</div>
            <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t("sec.l2.desc", "工具执行前先让另一个模型判断风险；审核模型不可达或超时(20s)时回退为人工审批。")}
            </div>
            {approvalMode === "l2pass" && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[11px] text-[var(--accent)]">
                {t("sec.l2.modeActive", "当前审批模式：L2 模型审核（所有工具都会先过审核）")}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div>{t("sec.l2.enabled", "启用 L2 审核")}</div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                {t(
                  "sec.l2.enabledHint",
                  "ask / auto 模式下需要人工审批的工具先过 L2，通过即直接执行；审批模式选「L2 模型审核」时无需打开此开关",
                )}
              </div>
            </div>
            <PillSwitch checked={sec.l2pass_enabled} onChange={toggleL2} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{t("sec.l2.provider", "审核 provider")}</span>
            <select
              value={sec.l2pass_provider_id}
              onChange={(e) => {
                setL2Hint("");
                saveSec({ l2pass_provider_id: e.target.value });
              }}
              className="field min-w-48 flex-1"
            >
              <option value="">{t("sec.l2.providerNone", "请选择审核 provider")}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </div>
          {l2Hint && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{l2Hint}</p>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm">{t("sec.l2.prompt", "审核提示词")}</div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t(
                    "sec.l2.promptHint",
                    "留空使用内置策略；自定义只写判断标准，JSON 输出契约会自动追加",
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {sec.l2pass_prompt && (
                  <button className="pill pill-hover text-xs" onClick={resetPrompt}>
                    {t("sec.l2.promptReset", "恢复默认")}
                  </button>
                )}
                <button
                  className="pill pill-hover text-xs disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!promptDirty || promptSaving}
                  onClick={savePrompt}
                >
                  {t("sec.l2.promptSave", "保存提示词")}
                </button>
              </div>
            </div>
            <textarea
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              rows={5}
              placeholder={sec.l2pass_prompt_default}
              className="field w-full resize-y font-mono text-xs leading-relaxed"
            />
            <details className="text-xs text-neutral-500 dark:text-neutral-400">
              <summary className="cursor-pointer select-none">{t("sec.l2.promptDefault", "查看内置默认提示词")}</summary>
              <p className="mt-1 whitespace-pre-wrap rounded-lg bg-neutral-100 p-2 dark:bg-neutral-800/60">
                {sec.l2pass_prompt_default}
              </p>
            </details>
          </div>

          <div className={`flex items-center justify-between ${!sec.l2pass_enabled ? "opacity-40" : ""}`}>
            <div>
              <div className="text-sm">{t("sec.l2.coverAuto", "审核自动放行的工具")}</div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                {t(
                  "sec.l2.coverAutoHint",
                  "开启后 auto/全部放行模式下的工具也先过 L2 审核；审核模型不可达时保持原自动放行，不打断自动化",
                )}
              </div>
            </div>
            <PillSwitch
              checked={sec.l2pass_cover_auto}
              disabled={!sec.l2pass_enabled}
              onChange={(v) => saveSec({ l2pass_cover_auto: v })}
            />
          </div>
        </div>
        </div>
      </section>

      {/* ==== 插件接管：被挡掉的内置入口与逐项恢复 ==== */}
      <section className="set-group" id="set-sec-takeover" style={gstyle("sec-takeover")}>
        <div className="set-grid">
          <div className="card space-y-4">
            <div>
              <div className="font-medium">{t("sec.takeover.title")}</div>
              <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("sec.takeover.desc")}</div>
            </div>

            {takeoverClaims.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">{t("sec.takeover.empty")}</p>
            ) : (
              <div className="space-y-1.5">
                {takeoverClaims.map((c) => {
                  const denied = !!c.denied;
                  const on = c.effective !== false && !denied;
                  const busy = takeBusy === `${c.plugin_id}:${c.slot}`;
                  return (
                    <div
                      key={`${c.plugin_id}:${c.slot}`}
                      className={`flex items-center gap-2 rounded-xl px-1 py-1 text-sm ${on ? "" : "opacity-55"}`}
                    >
                      <span className="chip shrink-0 font-mono">{c.slot}</span>
                      <span className="min-w-0 flex-1 truncate" title={`${c.plugin_name} · ${c.slot}`}>
                        {t(TAKEOVER_SLOT_KEY[c.slot] || c.slot)}
                        <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                          {denied
                            ? t("sec.takeover.restored", { name: c.plugin_name })
                            : on
                            ? t("sec.takeover.by", { name: c.plugin_name })
                            : t("sec.takeover.shadowed", { name: c.plugin_name })}
                        </span>
                      </span>
                      {on && (
                        <button
                          type="button"
                          disabled={!!takeBusy}
                          onClick={() => setTakeover(c, false)}
                          className="pill-outline pill-hover shrink-0 px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {busy ? t("sec.takeover.restoring") : t("sec.takeover.restore")}
                        </button>
                      )}
                      {denied && (
                        <button
                          type="button"
                          disabled={!!takeBusy}
                          onClick={() => setTakeover(c, true)}
                          className="pill-outline pill-hover shrink-0 px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {busy ? t("sec.takeover.applying") : t("sec.takeover.reapply")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("sec.takeover.settingsLocked")}</p>
            {takeErr && <p className="text-xs break-all text-red-500">{takeErr}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
