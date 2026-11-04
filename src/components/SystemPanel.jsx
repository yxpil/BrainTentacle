// yxpil · 系统状态面板
// 原先是「关于」悬浮弹窗（fixed + backdrop-blur），版本、更新、自动更新开关、
// 安卓版二维码都藏在里面，关掉就什么都看不见。现在作为「系统状态」页的一节常驻展示。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import logoUrl from "../assets/logo-64.png";

const ANDROID_URL = "https://github.com/yxpil/bit-mobile/releases/latest";

// 体积/速度格式化：B / KB / MB / GB
const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

export default function SystemPanel() {
  const { t } = useLang();
  const [appVersion, setAppVersion] = useState("");
  const [androidQr, setAndroidQr] = useState("");
  // upd = check_updates 结果；dl = 下载进度（后端广播）；checking / updErr 为过程态
  const [upd, setUpd] = useState(null); // { current, latest, has_update, notes, downloaded }
  const [checking, setChecking] = useState(false);
  const [updErr, setUpdErr] = useState("");
  const [dl, setDl] = useState(null); // { downloaded, total, speed }
  // 自动更新开关（bit.db 持久化）：false = 启动不检测不静默下载，手动检查不受影响
  const [autoUpd, setAutoUpd] = useState(true);
  const [autoUpdBusy, setAutoUpdBusy] = useState(false);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
    api
      .getAutoUpdate()
      .then((r) => setAutoUpd(!!r?.enabled))
      .catch(() => {});
    invoke("qr_svg_url", { url: ANDROID_URL })
      .then((r) => setAndroidQr(r?.svg || r || ""))
      .catch(() => {});
  }, []);

  // 订阅后端广播：update-progress 推进进度条 / update-state(downloaded) 收尾
  useEffect(() => {
    const unP = listen("update-progress", (e) => {
      const p = e.payload || {};
      if (p.state === "downloading") {
        setDl({
          downloaded: p.downloaded || 0,
          total: p.total || 0,
          speed: p.speed || 0,
        });
      }
    });
    const unS = listen("update-state", (e) => {
      const s = e.payload || {};
      if (s.state === "downloaded") {
        setUpd((prev) => ({ ...(prev || {}), downloaded: true }));
        setDl(null);
      }
    });
    return () => {
      unP.then((f) => f()).catch(() => {});
      unS.then((f) => f()).catch(() => {});
    };
  }, []);

  const doCheckUpdate = async () => {
    setChecking(true);
    setUpdErr("");
    setDl(null);
    try {
      setUpd(await api.checkUpdates());
    } catch (e) {
      setUpdErr(typeof e === "string" ? e : String(e));
    } finally {
      setChecking(false);
    }
  };

  const doDownloadUpdate = async () => {
    setDl({ downloaded: 0, total: 0, speed: 0 });
    setUpdErr("");
    try {
      const r = await api.updateDownload();
      if (r?.state === "downloaded") {
        setUpd((prev) => ({ ...(prev || {}), downloaded: true }));
        setDl(null);
      }
    } catch (e) {
      setUpdErr(typeof e === "string" ? e : String(e));
      setDl(null);
    }
  };

  const doToggleAutoUpdate = async () => {
    setAutoUpdBusy(true);
    try {
      const r = await api.setAutoUpdate(!autoUpd);
      setAutoUpd(!!r?.enabled);
    } catch {
      // 静默失败：按钮状态不翻转，用户可重试
    } finally {
      setAutoUpdBusy(false);
    }
  };

  // 一张卡三栏（身份 / 更新 / 安卓版），窄屏自动换行。
  // 原来左「身份」右「更新+二维码」两列等高：身份卡被拉到 228px 高、底部空 105px，
  // 合并成一张按内容取高的卡后这块空白就没有了。
  return (
    <div className="card flex flex-wrap items-start gap-x-4 gap-y-3">
      {/* 身份：图标 / 版本 / 一句话简介 / 外部链接 */}
      <div className="flex min-w-0 basis-[15rem] flex-1 items-start gap-2.5">
        <img
          src={logoUrl}
          alt={t("app.brand")}
          className="h-10 w-10 shrink-0 rounded-full"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-bold leading-tight">{t("app.brand")}</h3>
            {appVersion && (
              <span className="chip px-1.5 py-0 font-mono text-[10px]">
                v{appVersion}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            {t("app.tagline")}
          </p>
          <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-neutral-400">
            {t("app.aboutDesc")}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              onClick={() =>
                invoke("open_external", {
                  url: "https://qm.qq.com/q/qlFr8ct0ps",
                }).catch(() => {})
              }
              className="pill-outline pill-hover px-2.5 py-0.5 text-[11px]"
            >
              {t("app.qqGroup")}
            </button>
            <button
              onClick={() =>
                invoke("open_external", {
                  url: "https://github.com/yxpil/BrainTentacle",
                }).catch(() => {})
              }
              className="pill-outline pill-hover px-2.5 py-0.5 text-[11px]"
            >
              GitHub
            </button>
          </div>
        </div>
      </div>

      <div className="min-w-0 basis-[20rem] flex-[1.7] border-neutral-200/70 pl-0 lg:border-l lg:pl-4 dark:border-neutral-800/70">
        {/* 版本更新：主动检查 / 下载进度 + 速度 / 重启更新 / 自动更新开关 */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">
            {t("app.update")}
          </span>
          <button
            onClick={doCheckUpdate}
            disabled={checking || !!dl}
            className="accent-solid inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold transition select-none hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking && (
              <span className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
            )}
            {checking ? t("app.checking") : t("app.checkUpdate")}
          </button>
        </div>

        {updErr && (
          <p className="mt-1.5 break-words text-[11px] text-red-500">
            {updErr}
          </p>
        )}
        {!upd && !checking && !updErr && (
          <p className="mt-1.5 text-[11px] text-neutral-400">
            {t("app.checkHint")}
          </p>
        )}

        {upd && (
          <div className="mt-1.5 space-y-2">
            {upd.has_update ? (
              <p className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                {t("app.newVersion")}
                <span className="accent-solid ml-1.5 rounded px-1.5 py-0.5 font-mono text-[11px] font-bold">
                  v{upd.latest}
                </span>
              </p>
            ) : (
              <p className="text-xs text-neutral-500">{t("app.upToDate")}</p>
            )}

            {upd.has_update && upd.notes && (
              <div className="rounded-lg bg-neutral-100/90 px-2 py-1.5 dark:bg-neutral-800/60">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                  {t("app.notes")}
                </p>
                <p className="mt-0.5 max-h-24 overflow-y-auto text-[11px] leading-snug text-neutral-600 dark:text-neutral-300">
                  {upd.notes}
                </p>
              </div>
            )}

            {upd.has_update && !upd.downloaded && !dl && (
              <div className="flex items-center gap-2">
                <button
                  onClick={doDownloadUpdate}
                  className="accent-solid inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold transition select-none hover:brightness-110"
                >
                  {t("app.downloadUpdate")}
                </button>
                {upd.url && (
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      invoke("open_external", { url: upd.url }).catch(() => {});
                    }}
                    className="text-[11px] text-neutral-400 underline-offset-2 hover:text-neutral-700 hover:underline dark:hover:text-neutral-200"
                  >
                    {t("app.releasesOpen")}
                  </a>
                )}
              </div>
            )}

            {upd.downloaded && (
              <button
                onClick={() => api.updateApply().catch(() => {})}
                className="accent-solid inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold transition select-none hover:brightness-110"
              >
                {t("title.updateApply")}
              </button>
            )}

            {dl && (
              <div>
                <div className="flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
                  <span>{t("app.downloading")}…</span>
                  <span className="font-mono">
                    {(() => {
                      const pct =
                        dl.total > 0
                          ? Math.min(
                              100,
                              Math.round((dl.downloaded / dl.total) * 100),
                            )
                          : null;
                      return `${pct !== null ? `${pct}% · ` : ""}${fmtBytes(dl.speed)}/s`;
                    })()}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <div
                    className={`accent-solid h-full rounded-full transition-[width] duration-200 ${dl.total > 0 ? "" : "animate-pulse"}`}
                    style={{
                      width:
                        dl.total > 0
                          ? `${Math.min(100, (dl.downloaded / dl.total) * 100)}%`
                          : "100%",
                    }}
                  />
                </div>
                <div className="mt-1 text-right font-mono text-[10px] text-neutral-400">
                  {fmtBytes(dl.downloaded)}
                  {dl.total > 0 ? ` / ${fmtBytes(dl.total)}` : ""}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 自动更新开关：未检查更新也能关，bit.db 持久化，手动检查不受影响 */}
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-neutral-200/70 pt-2 dark:border-neutral-800/70">
          <p
            className="min-w-0 flex-1 truncate text-[10px] leading-snug text-neutral-400"
            title={autoUpd ? t("app.autoUpdOn") : t("app.autoUpdOff")}
          >
            {autoUpd ? t("app.autoUpdOn") : t("app.autoUpdOff")}
          </p>
          <button
            onClick={doToggleAutoUpdate}
            disabled={autoUpdBusy}
            className="pill-outline shrink-0 !px-3 !py-1 !text-[11px] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {autoUpd ? t("app.stopUpdates") : t("app.resumeUpdates")}
          </button>
        </div>
      </div>

      {/* 安卓版：小二维码 + 打开下载页（黑码白底，扫码可靠性优先于主题） */}
      <div className="flex shrink-0 items-center gap-2.5 border-neutral-200/70 lg:border-l lg:pl-4 dark:border-neutral-800/70">
        <div className="h-14 w-14 shrink-0 rounded-lg border border-neutral-200 bg-white p-1 dark:border-neutral-700">
          {androidQr ? (
            <div
              className="h-full w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: androidQr }}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-neutral-400">
              …
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-neutral-700 dark:text-neutral-200">
            {t("app.android")}
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-neutral-400">
            {t("app.androidQr")}
          </p>
          <button
            onClick={() =>
              invoke("open_external", { url: ANDROID_URL }).catch(() => {})
            }
            className="mt-0.5 text-[11px] font-medium text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline dark:text-neutral-400 dark:hover:text-white"
          >
            {t("app.androidOpen")} ↗
          </button>
        </div>
      </div>
    </div>
  );
}
