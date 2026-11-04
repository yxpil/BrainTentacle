import { useEffect, useRef, useState } from "react";

const IS_MAC = typeof navigator !== "undefined" && navigator.platform?.includes?.("Mac");

// 录入中的组合键 → Electron/Tauri 通用 accelerator。
// 只认「带修饰键的组合」或 F1–F12：裸键会拦掉全局输入，也不允许当全局热键，
// 所以普通字符键不拦截，输入框仍可手动打字改。
const KEY_NAMES = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

export function accelFromEvent(e) {
  // 只按下修饰键本身：还没构成组合，继续等下一个键
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(e.key)) return null;
  const code = e.code || "";
  const fn = /^F([1-9]|1[0-2])$/.test(e.key) ? e.key : null;
  const hasMod = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
  if (!hasMod && !fn) return null;

  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = code.slice(6);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else key = KEY_NAMES[code] || null;
  if (!key) return null;

  const mods = [];
  // mac 上 ⌘ 与 Ctrl 是两个键：按谁记谁（CommandOrControl 在 mac 会读成 ⌘，会骗人）
  if (e.metaKey) mods.push(IS_MAC ? "Command" : "Super");
  else if (e.ctrlKey) mods.push(IS_MAC ? "Control" : "CommandOrControl");
  if (e.altKey) mods.push(IS_MAC ? "Option" : "Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

/** 快捷键录入框：点一下再直接按下组合键即写入并保存，也保留手动输入。
 *  Esc 退出录入（不改动）；录到与当前值相同的组合不触发保存，避免白写一次盘。 */
export default function HotkeyField({ value, onChange, onRecorded, placeholder, title, className }) {
  const [recording, setRecording] = useState(false);
  const ref = useRef(null);

  // 失焦即退出录入态：否则「按了个不认识的键」会一直挂着高亮，看不出还能不能按
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onBlur = () => setRecording(false);
    el.addEventListener("blur", onBlur);
    return () => el.removeEventListener("blur", onBlur);
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={recording ? placeholder?.record : placeholder?.idle}
      title={title}
      onFocus={() => setRecording(true)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.currentTarget.blur(); // 退出录入，保留原值
          return;
        }
        const combo = accelFromEvent(e);
        if (!combo) return; // 普通字符键：不拦，仍可手打
        e.preventDefault();
        e.stopPropagation(); // 别让 Ctrl+K / Ctrl+Enter 这类全局键在录入时抢先触发
        onChange(combo);
        setRecording(false);
        e.currentTarget.blur();
        if (combo !== value) onRecorded?.(combo);
      }}
      className={`${className || "field w-40 text-center font-mono text-xs"} ${
        recording ? "hotkey-recording" : ""
      }`}
    />
  );
}
