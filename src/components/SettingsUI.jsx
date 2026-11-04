// 设置中心的通用排版件：分组标题、设置行、说明文字与表单字段。
// 所有设置页共用同一套"标题在左、控件在右、说明最多两行再展开"的节奏，
// 避免每页各写一套 flex/字号/留白，长说明也不会再把面板撑得又高又碎。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLang } from "../i18n.js";

export function SetSection({ title, desc, extra, children, className = "" }) {
  return (
    <div className={`set-section ${className}`}>
      <div className="set-section-head">
        <div className="min-w-0 flex-1">
          {title && <p className="set-section-title">{title}</p>}
          {desc && <SetDesc text={desc} />}
        </div>
        {extra && <div className="shrink-0">{extra}</div>}
      </div>
      {children}
    </div>
  );
}

export function SetRow({ title, desc, hint, control, children, stacked = false, className = "" }) {
  return (
    <div className={`set-row ${stacked ? "set-row-stacked" : ""} ${className}`}>
      <div className="set-row-text">
        {title && <p className="set-row-title">{title}</p>}
        {desc && <SetDesc text={desc} />}
        {hint && <p className="set-row-hint">{hint}</p>}
      </div>
      {(control || children) && (
        <div className="set-row-ctl">
          {control}
          {children}
        </div>
      )}
    </div>
  );
}

// 长说明默认折到两行，需要时点「更多」展开；短说明照常显示，不额外占一行按钮。
// 按真实溢出判断：字数多但折行后放得下时不显示「更多」，避免点了没反应的空按钮。
export function SetDesc({ text, lines = 2, className = "" }) {
  const { t } = useLang();
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const value = String(text || "");

  // 切换说明文字时先收起，再按新内容重新量一次
  useEffect(() => setOpen(false), [value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // line-clamp 生效时 scrollHeight 也会被裁到可视高度，量不出真实行数；
    // 先临时撤掉 clamp 让内容自然撑开，量完再原样写回内联样式，过程中不触发重绘。
    const measure = () => {
      if (open) return;
      const prev = el.getAttribute("style") || "";
      el.style.display = "block";
      el.style.webkitLineClamp = "unset";
      el.style.overflow = "visible";
      const full = el.scrollHeight;
      el.setAttribute("style", prev);
      const lineH = parseFloat(getComputedStyle(el).lineHeight) || 19;
      setClipped(full > lineH * lines + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, lines, open]);

  if (!value) return null;
  const clamp = !open
    ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }
    : undefined;

  return (
    <div className={`set-desc-wrap ${className}`}>
      <p ref={ref} className="set-desc" style={clamp} title={clipped && !open ? value : undefined}>
        {value}
      </p>
      {(clipped || open) && (
        <button type="button" className="set-more" onClick={() => setOpen((v) => !v)}>
          {open ? t("settings.less") : t("settings.more")}
        </button>
      )}
    </div>
  );
}

export function SetField({ label, hint, children, className = "" }) {
  return (
    <label className={`set-field ${className}`}>
      {label && <span className="set-field-label">{label}</span>}
      {children}
      {hint && <SetDesc text={hint} className="set-field-hint" />}
    </label>
  );
}
