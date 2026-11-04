// 提示词收藏快捷键：默认 Ctrl+A+S —— 按住 Ctrl（mac 上 ⌘ 同等）依次按 A、S，
// 把输入框当前内容存成一条提示词模板。写法是「修饰键+按键序列」，可在 AI 设置里改。
// 存 localStorage 的 bit.tplHotkey；留空或等于默认值时不写盘，跟随版本默认。

export const DEFAULT_TPL_HOTKEY = "Ctrl+A+S";
const STORE_KEY = "bit.tplHotkey";
const SEQ_GAP_MS = 1500; // 两键之间超过这个间隔就重新开始，免得半分钟前的 Ctrl+A 还算数

// 修饰键别名统一收成四类；Ctrl 与 Cmd/Meta 合并成一类（双平台同一套写法都能按）
const MOD_ALIASES = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "ctrl",
  command: "ctrl",
  meta: "ctrl",
  super: "ctrl",
  win: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

// 非字母数字键：event.code / 写法里的名字 → 统一 token
const SPECIAL = {
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
};
const SPECIAL_ALIASES = {
  space: "Space",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  del: "Delete",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
};

/** 单个 token 归一成统一按键名；认不出返回 null */
function normalizeKeyToken(tok) {
  const s = String(tok || "").trim();
  if (!s) return null;
  if (/^f([1-9]|1[0-2])$/i.test(s)) return s.toUpperCase();
  if (/^[a-z0-9]$/i.test(s)) return s.toUpperCase();
  return SPECIAL_ALIASES[s.toLowerCase()] || null;
}

/**
 * 解析快捷键写法，如 "Ctrl+A+S" / "Alt+Shift+Q" / "F8"。
 * 前导的修饰键别名任意顺序，剩下的是要按顺序敲下的按键（1–3 个）。
 * 无效写法返回 null（设置页据此提示，不写盘）。
 */
export function parseTplHotkey(spec) {
  const parts = String(spec || "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set();
  let i = 0;
  for (; i < parts.length; i++) {
    const alias = MOD_ALIASES[parts[i].toLowerCase()];
    if (!alias) break;
    mods.add(alias);
  }
  const keys = parts.slice(i).map(normalizeKeyToken);
  if (!keys.length || keys.length > 3 || keys.some((k) => !k)) return null;
  const hasMod = mods.size > 0;
  if (!hasMod && !/^F([1-9]|1[0-2])$/.test(keys[0])) return null; // 裸键太容易误触
  return {
    ctrl: mods.has("ctrl"),
    alt: mods.has("alt"),
    shift: mods.has("shift"),
    keys,
  };
}

/** 当前生效的快捷键写法（未自定义时回退默认） */
export function readTplHotkey() {
  const saved = (localStorage.getItem(STORE_KEY) || "").trim();
  return { spec: saved || DEFAULT_TPL_HOTKEY, custom: !!saved };
}

/** 保存快捷键写法；空串或默认值 = 清除自定义、跟随默认 */
export function saveTplHotkey(spec) {
  const v = String(spec || "").trim();
  if (!v || v === DEFAULT_TPL_HOTKEY) localStorage.removeItem(STORE_KEY);
  else localStorage.setItem(STORE_KEY, v);
  window.dispatchEvent(new CustomEvent("bit-tpl-hotkey"));
}

/** 键盘事件里的按键名，与写法里的 token 同一套（用 code 归一，避免 Shift 改掉大小写） */
function eventKeyToken(e) {
  const code = e.code || "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F\d{1,2}$/.test(e.key)) return e.key.toUpperCase();
  return SPECIAL[code] || null;
}

/** 修饰键是否刚好是写法要求的那一组（Ctrl 与 Cmd/Meta 视为同一类） */
function modsMatch(e, parsed) {
  const ctrl = e.ctrlKey || e.metaKey;
  return ctrl === parsed.ctrl && !!e.altKey === parsed.alt && !!e.shiftKey === parsed.shift;
}

/**
 * 序列匹配：seq 由调用方持有（{ n, at }），跨 keydown 记录已按到第几键。
 * 命中完整序列返回 true 并复位；按错键则回到开头（若按的是首键就直接算第一键）。
 */
export function matchTplSequence(e, parsed, seq) {
  if (!parsed) return false;
  if (Date.now() - seq.at > SEQ_GAP_MS) seq.n = 0;
  if (!modsMatch(e, parsed)) {
    seq.n = 0;
    return false;
  }
  const key = eventKeyToken(e);
  if (!key) return false; // 修饰键自身、输入法处理中的键：不推进也不清零
  if (key === parsed.keys[seq.n]) {
    seq.n += 1;
    seq.at = Date.now();
    if (seq.n === parsed.keys.length) {
      seq.n = 0;
      return true;
    }
    return false;
  }
  seq.n = key === parsed.keys[0] ? 1 : 0;
  seq.at = seq.n ? Date.now() : 0;
  return false;
}

/** 把默认写法里的 Ctrl 换成 mac 的 ⌘，只影响展示 */
export function formatTplHotkey(spec) {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || "");
  return isMac ? String(spec).replace(/\bCtrl\b/g, "⌘") : String(spec);
}
