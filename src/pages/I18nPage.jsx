// yxpil · 语言与翻译（i18n）设置
// 上半是界面语言选择，下半是扩展语言的生成引擎。
// 中英以外的语言不随包：用 Index-Translate 把词典现译一份存本地，切过去就换词典。
// 引擎是公开 demo 服务，所以生成必须由用户点按钮发起，界面只做单次试译预览，不自动打请求。
import { useEffect, useMemo, useState } from "react";
import { useLang, getAvailableLangs, setLang } from "../i18n.js";
import {
  EXT_LANGS,
  MODELS,
  cancelGenerate,
  clearExtLang,
  extStatus,
  generateLocale,
  isRunning,
  langLabel,
  listExtLangs,
  readCfg,
  writeCfg,
} from "../i18nExt.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import { IconTrash } from "../components/Icons.jsx";
import { SetDesc, SetField, SetSection } from "../components/SettingsUI.jsx";

export default function I18nPage({ group }) {
  const { t, lang } = useLang();
  const gstyle = (id) => (group && group !== id ? { display: "none" } : undefined);

  const [cfg, setCfg] = useState(readCfg);
  const [target, setTarget] = useState("ja");
  const [overwrite, setOverwrite] = useState(false);
  const [prog, setProg] = useState(null);
  const [ext, setExt] = useState(listExtLangs);
  const [err, setErr] = useState("");

  const reload = () => {
    setExt(listExtLangs());
    setCfg(readCfg());
  };

  // 生成中途切走再切回来，进度不能从 0 开始骗人
  useEffect(() => {
    if (isRunning()) setProg(null);
    reload();
  }, [group]);

  const patch = (p) => setCfg(writeCfg(p));

  const available = useMemo(() => getAvailableLangs(), [ext, lang]);
  const done = prog?.done || 0;
  const total = prog?.total || 0;

  const start = async () => {
    setErr("");
    setProg({ done: 0, total: 0, ok: 0, failed: 0, locale: target });
    try {
      const r = await generateLocale(target, { onProgress: setProg, overwrite });
      if (r.aborted) setErr(t("i18n.aborted", "已中断，已生成的部分保留，再点一次只补剩下的。"));
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      reload();
    }
  };

  const drop = async (code) => {
    const ok = await confirmDialog({
      title: t("i18n.delTitle", "删除这门语言"),
      message: t("i18n.delBody", "只删本地缓存的译文，不影响中英词典。删除后该语言从语言列表消失。"),
      danger: true,
    });
    if (!ok) return;
    clearExtLang(code);
    reload();
  };

  return (
    <div className="page">
      {err && <div className="card border border-red-400/40 text-sm text-red-500">{err}</div>}

      {/* ==== 界面语言 ==== */}
      <section className="set-group" id="set-i18n-lang" style={gstyle("i18n-lang")}>
        <div className="set-grid">
        <SetSection
          className="card"
          title={t("i18n.cur", "当前界面语言")}
          desc={t("i18n.langHint", "中文、英文随程序内置。其余语言由下面的翻译服务在本地生成，生成一次长期离线可用。")}
        >
          <div className="flex flex-wrap gap-2">
            {available.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setLang(code)}
                className={`${code === lang ? "pill" : "pill-outline pill-hover"} px-3 py-1 text-xs`}
                title={code}
              >
                {langLabel(code)}
              </button>
            ))}
          </div>

          {ext.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                {t("i18n.generated", "已生成的扩展语言")}
              </div>
              {ext.map((l) => (
                <div
                  key={l.code}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-700"
                >
                  <div className="min-w-0">
                    <span className="font-medium">{langLabel(l.code)}</span>
                    <span className="ml-2 text-xs text-neutral-400">{l.code}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {extStatus(l.code).have} / {extStatus(l.code).total}
                      <span className="ml-2 opacity-70">{l.model}</span>
                    </span>
                    <button type="button" onClick={() => drop(l.code)} className="pill-outline pill-hover px-2 py-1" title={t("i18n.del", "删除")}>
                      <IconTrash size={13} />
                    </button>
                  </div>
                </div>
              ))}
              <SetDesc text={t("i18n.fallback", "词条没译全时，缺的部分自动回退英文，再缺回退中文——半截词典也能切过去用。")} />
            </div>
          )}
        </SetSection>
        </div>
      </section>

      {/* ==== 语言扩展 ==== */}
      <section className="set-group" id="set-i18n-engine" style={gstyle("i18n-engine")}>
        <div className="set-grid">
        <SetSection
          className="card"
          title={t("i18n.engine", "Index-Translate 语言扩展")}
          desc={t(
            "i18n.engineHint",
            "B 站开源翻译模型的公开演示服务，不是官方 API：没有配额承诺，地址和限速随时可能变。生成过程可在任意时刻中断，已写盘的部分会保留。",
          )}
        >
          <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <SetField label={t("i18n.target", "目标语言")}>
              <select value={target} onChange={(e) => setTarget(e.target.value)} className="field w-full" disabled={isRunning()}>
                {EXT_LANGS.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.native} · {l.code}
                  </option>
                ))}
              </select>
            </SetField>
            <SetField label={t("i18n.source", "源语言")}>
              <select value={cfg.src} onChange={(e) => patch({ src: e.target.value })} className="field w-full" disabled={isRunning()}>
                <option value="en">English · en</option>
                <option value="zh">中文 · zh</option>
              </select>
            </SetField>
            <SetField label={t("i18n.model", "模型")}>
              <select value={cfg.model} onChange={(e) => patch({ model: e.target.value })} className="field w-full" disabled={isRunning()}>
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </SetField>
            <SetField label={t("i18n.endpoint", "服务地址")}>
              <input
                value={cfg.endpoint}
                onChange={(e) => patch({ endpoint: e.target.value.trim() })}
                className="field w-full"
                disabled={isRunning()}
                placeholder="https://index-translate.bilibili.com"
              />
            </SetField>
            <SetField label={t("i18n.batch", "每批条数")}>
              <input
                type="number"
                min="1"
                max="30"
                value={cfg.batch}
                onChange={(e) => patch({ batch: Number(e.target.value) || 1 })}
                className="field w-full"
                disabled={isRunning()}
              />
            </SetField>
            <SetField label={t("i18n.conc", "并发数")}>
              <input
                type="number"
                min="1"
                max="4"
                value={cfg.concurrency}
                onChange={(e) => patch({ concurrency: Number(e.target.value) || 1 })}
                className="field w-full"
                disabled={isRunning()}
              />
            </SetField>
            <SetField label={t("i18n.gap", "每批间隔（毫秒）")}>
              <input
                type="number"
                min="0"
                step="100"
                value={cfg.gapMs}
                onChange={(e) => patch({ gapMs: Math.max(0, Number(e.target.value) || 0) })}
                className="field w-full"
                disabled={isRunning()}
              />
            </SetField>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-3 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70">
            {isRunning() ? (
              <button type="button" onClick={() => cancelGenerate()} className="pill">
                {t("i18n.stop", "中断")}
              </button>
            ) : (
              <button type="button" onClick={start} className="pill">
                {t("i18n.generate", "生成该语言词典")}
              </button>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <input type="checkbox" className="size-4 accent-neutral-800" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} disabled={isRunning()} />
              {t("i18n.overwrite", "全部重译（默认只补没译的）")}
            </label>
            {total > 0 && (
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {done} / {total}
                {prog?.failed ? ` · ${t("i18n.failed", "失败")} ${prog.failed}` : ""}
                {prog?.skipped ? ` · ${t("i18n.skipped", "跳过")} ${prog.skipped}` : ""}
              </span>
            )}
          </div>

          {total > 0 && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
              <div
                className="h-full rounded-full bg-neutral-800 transition-[width] dark:bg-neutral-200"
                style={{ width: `${Math.min(100, Math.round((done / total) * 100))}%` }}
              />
            </div>
          )}

          <div className="mt-1 flex flex-col gap-1 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70">
            <SetDesc
              text={t(
                "i18n.cost",
                "全量约 900 条词条。默认并发 2、每批 12 条、间隔 400ms，跑完约两三分钟；把并发或间隔调大就是在压演示服务，不建议。",
              )}
            />
            <SetDesc
              text={t("i18n.mlNote", "少数多行示例文本（审核词表、提示词模板、唤醒词清单）不参与翻译：模型会把首行「例如：」当指令吃掉、内容串行而行数照样对齐，这种假译文不如留英文原文。")}
            />
          </div>
        </SetSection>
        </div>
      </section>
    </div>
  );
}
