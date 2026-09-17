import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import PillSwitch from "../components/PillSwitch.jsx";
import { IconShield, IconTrash, IconEye } from "../components/Icons.jsx";

/**
 * SecurityPage —— 安全中心
 *  - HiddenCode 敏感信息脱敏：发给 AI 前替换为占位符，工具本机执行时自动还原
 *  - L2 PASS：非安全工具执行前用另一个模型审核放行（不可达时回退人工审批）
 */
export default function SecurityPage() {
  const { t } = useLang();

  // —— 安全设置（两个总开关 + 审核 provider）——
  const [sec, setSec] = useState({
    hidden_code_enabled: false,
    l2pass_enabled: false,
    l2pass_provider_id: "",
    l2pass_cover_auto: false,
  });
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
  };
  useEffect(load, []);

  const saveSec = async (partial) => {
    setErr("");
    const next = { ...sec, ...partial };
    try {
      const r = await api.setSecuritySettings(
        next.hidden_code_enabled,
        next.l2pass_enabled,
        next.l2pass_provider_id,
        next.l2pass_cover_auto,
      );
      // 合并而非整包覆盖：历史教训——后端只回 {ok} 时整包覆盖会把开关全部打挂
      setSec((prev) => ({ ...prev, ...r }));
    } catch (e) {
      setErr(String(e));
    }
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
    <div className="mx-auto max-w-3xl space-y-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <IconShield size={20} />
        {t("nav.security", "安全")}
      </h2>

      {err && (
        <div className="card border border-red-400/40 text-sm text-red-500">{err}</div>
      )}

      {/* ==== HiddenCode 敏感信息脱敏 ==== */}
      <div className="card space-y-4">
        <div>
          <div className="font-medium">{t("sec.hc.title", "敏感信息脱敏（HiddenCode）")}</div>
          <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t("sec.hc.desc", "发给 AI 前将密钥/手机号/邮箱等敏感值替换为占位符，工具在本机执行时自动还原真实值。")}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span>{t("sec.hc.enabled", "启用脱敏")}</span>
          <PillSwitch
            checked={sec.hidden_code_enabled}
            onChange={(v) => saveSec({ hidden_code_enabled: v })}
          />
        </div>

        {/* 新条目 */}
        <div
          className={`space-y-3 rounded-2xl border border-neutral-200 p-3 dark:border-neutral-700 ${
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
                    : t("sec.hc.patternHint", "值留空并勾选「按类型掩码」可掩掉所有匹配项")
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
                （{t("sec.hc.patternHint", "值留空并勾选「按类型掩码」可掩掉所有匹配项（如全部手机号）；自定义正则请把表达式填在值里并勾选。")}）
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
            <div className="rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400 dark:border-neutral-700">{t("sec.hc.empty", "暂无条目")}</div>
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
        <div className="space-y-2 rounded-2xl border border-dashed border-neutral-300 p-3 dark:border-neutral-600">
          <div className="text-sm font-medium">{t("sec.hc.scan", "扫描探测")}</div>
          <textarea
            value={scanText}
            onChange={(e) => setScanText(e.target.value)}
            placeholder={t("sec.hc.scanText", "粘贴文本以探测敏感信息（不自动保存）")}
            rows={3}
            className="field !rounded-2xl resize-y"
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

      {/* ==== L2 PASS 二级模型审核 ==== */}
      <div className="card space-y-4">
        <div>
          <div className="font-medium">{t("sec.l2.title", "二级模型审核（L2 PASS · 实验）")}</div>
          <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t("sec.l2.desc", "非安全工具执行前，先用另一个模型审核是否放行；审核模型不可达或超时(20s)时回退为人工审批。")}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span>{t("sec.l2.enabled", "启用 L2 审核")}</span>
          <PillSwitch checked={sec.l2pass_enabled} onChange={(v) => saveSec({ l2pass_enabled: v })} />
        </div>

        <div
          className={`flex flex-wrap items-center gap-2 ${!sec.l2pass_enabled ? "opacity-40" : ""}`}
        >
          <span className="text-sm">{t("sec.l2.provider", "审核 provider")}</span>
          <select
            value={sec.l2pass_provider_id}
            onChange={(e) => saveSec({ l2pass_provider_id: e.target.value })}
            disabled={!sec.l2pass_enabled}
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
  );
}
