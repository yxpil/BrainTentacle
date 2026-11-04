// 全站唯一的搜索输入行：图标 + 透明输入 + 可选清除钮，规格照对话页的会话搜索。
// 之前设置中心、插件页、审计页、命令面板各写各的（有的套圆角输入框、有的没图标），
// 同一件事在同一款产品里长得不一样。这里收成一个组件，页面只传行为。
import { IconSearch, IconX } from "./Icons.jsx";

export default function SearchBox({
  value,
  onChange,
  placeholder,
  onEnter,
  onEscape,
  onKeyDown,
  autoFocus = false,
  showClear = true,
  onClear,
  size = 13,
  className = "",
  inputClass,
  right = null,
  title = undefined,
  clearTitle = undefined,
  ariaLabel = undefined,
}) {
  const clear = () => {
    if (onClear) onClear();
    else onChange("");
  };
  return (
    <div className={`search-box flex items-center gap-2 ${className}`}>
      <IconSearch size={size} className="search-ico shrink-0 text-neutral-400" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (typeof onKeyDown === "function") return onKeyDown(e);
          if (e.key === "Enter") onEnter?.();
          if (e.key === "Escape") (onEscape || clear)();
        }}
        placeholder={placeholder}
        title={title}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        className={inputClass || "min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-neutral-400"}
      />
      {right}
      {showClear && value ? (
        <button
          type="button"
          onClick={clear}
          title={clearTitle}
          className="shrink-0 rounded-md p-0.5 text-neutral-400 transition-colors hover:bg-neutral-900/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <IconX size={12} />
        </button>
      ) : null}
    </div>
  );
}
