// yxpil · 插件独立页面的宿主容器
//
// 一个沙箱 iframe：插件页面跑在自己的源里（http://127.0.0.1:<插件服务端口>），
// 与宿主不同源、无 node（主窗口 nodeIntegration:false，帧内也拿不到），
// 唯一的出站通道是 pluginHost 里按该插件权限位放行的 postMessage 桥。
//
// 两种页面形态：
//   static — 插件目录里的 HTML，由 BIT 插件服务托管（HTML 自动注入 SDK 脚本）
//   server — 插件自带服务器上的路径（服务器没跑时没有地址，这里给出明确提示）
import { useEffect, useRef, useState } from "react";
import { attachFrame } from "../pluginHost.js";
import { useLang } from "../i18n.js";
import { IconServer } from "../components/Icons.jsx";

export default function PluginFramePage({ page, onOpenPlugins }) {
  const { t } = useLang();
  const ref = useRef(null);
  const [alive, setAlive] = useState(false);

  // 桥登记：iframe 挂载后把它与所属插件的权限/源绑定起来，卸载即摘除
  useEffect(() => {
    const el = ref.current;
    if (!el || !page.frame) return undefined;
    const detach = attachFrame(el, page);
    return detach;
  }, [page]);

  if (!page.frame) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="card max-w-md space-y-3 p-5 text-center">
          <div className="flex items-center justify-center gap-2 text-sm font-semibold">
            <IconServer size={16} />
            {page.plugin_name} · {t("pluginFrame.stopped")}
          </div>
          <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            {t("pluginFrame.hint", { url: page.url || "/" })}
            {t("pluginFrame.autoReload")}
          </p>
          <button type="button" className="pill pill-hover px-3 py-1 text-xs" onClick={onOpenPlugins}>
            {t("pluginFrame.goStart")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {!alive && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400">
          {t("pluginFrame.loading", { label: page.label })}
        </div>
      )}
      <iframe
        ref={ref}
        src={page.frame}
        title={`${page.plugin_name} · ${page.label}`}
        onLoad={() => setAlive(true)}
        // allow-same-origin 让页面能用自己的 localStorage；源是本机端口，与宿主隔离
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        className="h-full w-full border-0 bg-white dark:bg-neutral-900"
      />
    </div>
  );
}
