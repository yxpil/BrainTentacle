import { useEffect, useRef, useState } from "react";
import { useLang } from "../i18n.js";

// 全局页内确认弹窗：替换 window.confirm / window.alert 的统一入口。
// confirmDialog() 通过自定义事件把请求推进 <ConfirmHost /> 的内部队列
//（App 挂载一次），逐个展示；resolve 后自动展示下一条。
// 用法：if (await confirmDialog({ title, message, danger: true })) { ... }
//       confirmDialog({ title, alert: true }) —— 只有确认按钮的提示弹窗

const ASK_EVENT = "bit-confirm-ask";

/** 异步确认/提示弹窗，返回 Promise<boolean>；也支持 confirmDialog("消息") 简写 */
export function confirmDialog(opts = {}) {
  const req = typeof opts === "string" ? { message: opts } : opts;
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { ...req, resolve } }));
  });
}

export default function ConfirmHost() {
  const { t } = useLang();
  const [queue, setQueue] = useState([]);
  const dlg = queue[0];
  const confirmBtnRef = useRef(null);
  const cardRef = useRef(null);

  useEffect(() => {
    const onAsk = (e) => setQueue((q) => [...q, e.detail]);
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, []);

  const settle = (ok) => {
    if (!queue.length) return;
    queue[0].resolve(ok);
    setQueue((q) => q.slice(1));
  };

  // 键盘：Esc=取消 / Enter=确认；焦点已在弹窗按钮上时 Enter 交给浏览器默认点击
  //（自动聚焦的就是确认按钮，避免确认/取消双触发）
  useEffect(() => {
    if (!dlg) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
      } else if (e.key === "Enter") {
        const el = document.activeElement;
        if (el?.tagName === "BUTTON" && cardRef.current?.contains(el)) return;
        e.preventDefault();
        settle(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // 弹窗打开（含队列推进到下一条）时焦点给确认按钮
  useEffect(() => {
    if (dlg) confirmBtnRef.current?.focus();
  }, [dlg]);

  if (!dlg) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6"
      onClick={() => settle(false)}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        className="card w-[340px] max-w-[calc(100vw-24px)]"
        onClick={(e) => e.stopPropagation()}
      >
        {dlg.title && (
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{dlg.title}</h3>
        )}
        {dlg.message && (
          <p
            className={`text-sm leading-relaxed text-neutral-500 dark:text-neutral-400 ${
              dlg.title ? "mt-1.5" : ""
            }`}
          >
            {dlg.message}
          </p>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          {!dlg.alert && (
            <button className="pill pill-outline pill-hover" onClick={() => settle(false)}>
              {dlg.cancelText ?? t("dialog.cancel")}
            </button>
          )}
          <button
            ref={confirmBtnRef}
            onClick={() => settle(true)}
            className={`pill pill-hover ${
              dlg.danger
                ? "border-red-600 bg-red-600 text-white hover:border-red-500 hover:bg-red-500"
                : ""
            }`}
          >
            {dlg.confirmText ?? t("dialog.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
