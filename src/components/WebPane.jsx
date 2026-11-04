// yxpil · BIT
// 右侧文件面板里的网页标签：直接用 Electron 的 webview（同一套 Chromium 内核）浏览网页，
// 地址栏/前进后退/刷新由页面内自绘；截图走宿主 web_capture（capturePage）挂到输入框附件。
// 安全约束在主进程（will-attach-webview / web-contents-created），这里只负责交互。
import { useEffect, useRef, useState } from "react";
import { useLang } from "../i18n.js";
import { api } from "../api.js";
import { IconChevronLeft, IconChevronRight, IconRefresh, IconCamera, IconGlobe } from "./Icons.jsx";

// 地址栏容错：裸域名补 https，本机服务补 http
export function normalizeWebUrl(input) {
  const v = String(input || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(localhost|127(\.\d+){3}|\[::1\])(:\d+)?([/?#]|$)/i.test(v)) return `http://${v}`;
  return `https://${v}`;
}

export default function WebPane({ initialUrl, onTitle }) {
  const { t } = useLang();
  const ref = useRef(null);
  const typing = useRef(false);
  // 标题回调每次渲染都会换新闭包：存 ref 里，事件监听只挂一次
  const titleCb = useRef(onTitle);
  titleCb.current = onTitle;
  const [addr, setAddr] = useState(initialUrl);
  const [loading, setLoading] = useState(true);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const [fail, setFail] = useState("");
  const [note, setNote] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const sync = () => {
      try {
        if (!typing.current) {
          const u = wv.getURL();
          if (u) setAddr(u);
        }
        setCanBack(wv.canGoBack());
        setCanFwd(wv.canGoForward());
      } catch {
        // 网页还没挂上 webContents 时取状态会抛，忽略
      }
    };
    const onStart = () => {
      setLoading(true);
      setFail("");
    };
    const onStop = () => {
      setLoading(false);
      sync();
    };
    const onReady = () => {
      setReady(true);
      sync();
    };
    const onFailLoad = (e) => {
      if (e.errorCode === -3) return; // 主动中断（重新导航/停止）不算失败
      setLoading(false);
      setFail(e.errorDescription || String(e.errorCode));
    };
    const onTitleEv = (e) => titleCb.current?.(e.title || "");
    const onNewDoc = () => sync();
    wv.addEventListener("dom-ready", onReady);
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    wv.addEventListener("did-fail-load", onFailLoad);
    wv.addEventListener("did-navigate", onNewDoc);
    wv.addEventListener("did-navigate-in-page", onNewDoc);
    wv.addEventListener("page-title-updated", onTitleEv);
    return () => {
      wv.removeEventListener("dom-ready", onReady);
      wv.removeEventListener("did-start-loading", onStart);
      wv.removeEventListener("did-stop-loading", onStop);
      wv.removeEventListener("did-fail-load", onFailLoad);
      wv.removeEventListener("did-navigate", onNewDoc);
      wv.removeEventListener("did-navigate-in-page", onNewDoc);
      wv.removeEventListener("page-title-updated", onTitleEv);
    };
  }, []);

  const go = () => {
    const url = normalizeWebUrl(addr);
    if (!url) return;
    try {
      ref.current?.loadURL(url);
      setAddr(url);
    } catch (e) {
      setFail(String(e?.message || e));
    }
  };

  const shot = async () => {
    setNote("");
    try {
      const id = ref.current?.getWebContentsId();
      if (!id) throw new Error(t("chat.webFail"));
      await api.webCapture(id);
      setNote(t("chat.webShotDone"));
    } catch (e) {
      setNote(`${t("chat.webShotFail")}${e?.message ? `：${e.message}` : ""}`);
    }
  };

  const navBtn =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-900/5 hover:text-neutral-900 disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 地址栏：与文件标签的路径行同一高度，不另占视觉层级 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <button type="button" onClick={() => ref.current?.goBack()} disabled={!canBack} title={t("chat.webBack")} className={navBtn}>
          <IconChevronLeft size={14} />
        </button>
        <button type="button" onClick={() => ref.current?.goForward()} disabled={!canFwd} title={t("chat.webForward")} className={navBtn}>
          <IconChevronRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (loading) ref.current?.stop();
            else ref.current?.reload();
          }}
          title={t("chat.webReload")}
          className={navBtn}
        >
          {loading ? <span className="block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <IconRefresh size={13} />}
        </button>
        <input
          value={addr}
          spellCheck={false}
          onChange={(e) => setAddr(e.target.value)}
          onFocus={(e) => {
            typing.current = true;
            e.target.select();
          }}
          onBlur={() => {
            typing.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
          placeholder={t("chat.webUrlPlaceholder")}
          className="min-w-0 flex-1 rounded-full bg-neutral-100 px-3 py-1 font-mono text-[11px] text-neutral-700 outline-none placeholder:text-neutral-400 focus:ring-1 focus:ring-neutral-400 dark:bg-neutral-800 dark:text-neutral-200 dark:focus:ring-neutral-600"
        />
        <button type="button" disabled={!ready} onClick={shot} title={t("chat.webShot")} className={navBtn}>
          <IconCamera size={14} />
        </button>
      </div>
      {fail && <div className="shrink-0 px-3 py-1 text-[11px] text-red-500">{t("chat.webFail")}：{fail}</div>}
      {note && <div className="shrink-0 px-3 py-1 text-[11px] text-emerald-500">{note}</div>}
      <div className="relative min-h-0 flex-1 bg-white">
        {loading && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-neutral-200/60">
            <div className="h-full w-1/3 animate-pulse bg-neutral-400" />
          </div>
        )}
        <webview
          ref={ref}
          src={initialUrl}
          partition="persist:bit-browser"
          allowpopups="true"
          className="h-full w-full"
          style={{ display: "flex", width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}

// 空地址栏时的占位（没有打开任何网页标签时由面板显示）
export function WebEmptyHint() {
  const { t } = useLang();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-neutral-500">
      <IconGlobe size={20} />
      {t("chat.webEmpty")}
    </div>
  );
}
