// yxpil · 多语言扩展：zh/en 以外的语言由外部引擎译出，结果落盘后热加载进词典
//
// 引擎是 bilibili Index-Translate 的公开 demo 站（https://index-translate.bilibili.com），
// 两个接口都是 OpenAI 兼容 SSE：/v1/chat/completions（带指令，可控格式）和
// /translate_stream（固定翻译模板，直出）。它是演示服务而不是官方 API——没有配额承诺，
// 接口和限速随时可能变，所以这套代码守住三条：
//   1) 只有用户在设置里主动点「生成」才发请求，切语言本身零请求；
//   2) 限速跑（并发 + 间隔都可调，默认很保守），不轮询、不重试成环；
//   3) 结果全量写进 localStorage，取消/断网保住已生成的部分，下次接着生成。
// 词典是增量的：i18n.js 的 t() 按 目标语言 → en → zh → key 回退，只译了一半也能切过去用。
import { addDict, baseKeys, dropLang, getEntries, getLang, refreshLang, setLang } from "./i18n.js";

const CFG_KEY = "bit.i18n.cfg.v1";
const CACHE_KEY = "bit.i18n.cache.v1";

const DEFAULT_CFG = {
  endpoint: "https://index-translate.bilibili.com",
  model: "index-mt-9b",
  src: "en", // 源语言：默认从英文词典译，术语比中文更接近目标语言的既有译法
  batch: 12, // 一次请求带几条。实测 12 条 9B 约 2~4s，太大模型会漏行
  concurrency: 2,
  gapMs: 400,
};

export const MODELS = ["index-mt-2b", "index-mt-9b", "index-mt-35b"];

// 引擎官方支持且 demo 站实测可选的常用语种；界面只显示本族语名 + 代码，
// 免得给 22 个语言名再各配一条 t() 词条（那种词条一多，词典本身就成了要翻译的东西）
export const EXT_LANGS = [
  { code: "ja", native: "日本語" },
  { code: "ko", native: "한국어" },
  { code: "de", native: "Deutsch" },
  { code: "fr", native: "Français" },
  { code: "es", native: "Español" },
  { code: "pt", native: "Português" },
  { code: "it", native: "Italiano" },
  { code: "nl", native: "Nederlands" },
  { code: "pl", native: "Polski" },
  { code: "ro", native: "Română" },
  { code: "sv", native: "Svenska" },
  { code: "ru", native: "Русский" },
  { code: "uk", native: "Українська" },
  { code: "tr", native: "Türkçe" },
  { code: "ar", native: "العربية" },
  { code: "hi", native: "हिन्दी" },
  { code: "th", native: "ไทย" },
  { code: "vi", native: "Tiếng Việt" },
  { code: "id", native: "Bahasa Indonesia" },
  { code: "ms", native: "Bahasa Melayu" },
  { code: "fil", native: "Filipino" },
];

// 界面上给语言起的显示名：一律用本族语写法，切到任何语言都不用再翻译一遍
export const LANG_LABELS = {
  zh: "中文（简体）",
  en: "English",
  ...Object.fromEntries(EXT_LANGS.map((l) => [l.code, l.native])),
};
export const langLabel = (code) => LANG_LABELS[code] || code;

const LANG_NAMES = {
  en: "English",
  zh: "Chinese (Simplified)",
  ja: "Japanese",
  ko: "Korean",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  ro: "Romanian",
  sv: "Swedish",
  ru: "Russian",
  uk: "Ukrainian",
  tr: "Turkish",
  ar: "Arabic",
  hi: "Hindi",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  ms: "Malay",
  fil: "Filipino",
};

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
};

export function readCfg() {
  return read(CFG_KEY, DEFAULT_CFG);
}

export function writeCfg(patch) {
  const next = { ...readCfg(), ...patch };
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
  } catch { /* 写不回去就用默认值跑，不该因此挡住生成 */ }
  return next;
}

let cache = {};
try {
  cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {};
} catch {
  cache = {};
}

function persistCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    return true;
  } catch {
    // 配额满：界面按已加载的词典继续工作，只是这批结果留不到下次
    return false;
  }
}

/** 把已缓存的语言词典灌进 i18n（模块加载时调用一次，切语言才不用等网络） */
export function hydrateExtLangs() {
  for (const [code, rec] of Object.entries(cache)) {
    if (rec?.entries) addDict({ [code]: rec.entries });
  }
}
hydrateExtLangs();

/** 扩展语言概况，按生成时间排序供界面列出 */
export function listExtLangs() {
  return Object.entries(cache)
    .filter(([, rec]) => rec?.entries)
    .map(([code, rec]) => ({
      code,
      native: EXT_LANGS.find((l) => l.code === code)?.native || code,
      count: Object.keys(rec.entries).length,
      total: baseKeys().length,
      at: rec.at || 0,
      model: rec.model || "",
    }))
    .sort((a, b) => b.at - a.at);
}

export function extStatus(code) {
  const rec = cache[code];
  const entries = rec?.entries || {};
  const keys = baseKeys();
  const have = keys.filter((k) => entries[k]).length;
  return { have, total: keys.length, at: rec?.at || 0, model: rec?.model || "" };
}

export function clearExtLang(code) {
  const base = cache[code]?.src === "zh" ? "zh" : "en";
  delete cache[code];
  persistCache();
  // 运行期词典也要一起摘，否则界面还挂着已删的语言、切过去仍是旧译文
  dropLang(code);
  // 正在用这门语言的话退回它的源语言，别把人晾在一个已经不存在的语言上
  if (getLang() === code) setLang(base);
  refreshLang();
}

export function clearAllExt() {
  for (const code of Object.keys(cache)) clearExtLang(code);
  cache = {};
  persistCache();
}

// ---------- 引擎调用 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sseRequest(path, body, signal) {
  const { endpoint } = readCfg();
  const resp = await fetch(`${endpoint.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data);
        if (obj.error) throw new Error(String(obj.error));
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) out += delta;
      } catch (e) {
        if (e instanceof Error && !e.message.startsWith("Unexpected")) throw e;
      }
    }
  }
  return out;
}

const PH_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}/g;
const tokens = (s) => s.match(PH_RE) || [];

// 译文可用判定：非空、没跑飞成一段解释、{占位符} 一个不少
// 占位符是 t(key, params) 的命门，译丢或译花就宁可不要这条，回退英文
function usable(src, out) {
  if (!out || !out.trim()) return false;
  if (out.length > Math.max(400, src.length * 6)) return false;
  const want = tokens(src);
  if (!want.length) return true;
  const got = tokens(out);
  return want.every((w) => got.includes(w));
}

// 少数词条首尾带空格（与页面拼接的既有约定），编号批译会吃掉，补回原样
const EDGE_LEAD = /^[ \t\u00a0\u3000]*/;
const EDGE_TRAIL = /[ \t\u00a0\u3000]*$/;
function reedge(src, out) {
  return `${EDGE_LEAD.exec(src)?.[0] || ""}${out.trim()}${EDGE_TRAIL.exec(src)?.[0] || ""}`;
}

function batchPrompt(items, targetCode, srcCode) {
  const tn = LANG_NAMES[targetCode] || targetCode;
  const sn = LANG_NAMES[srcCode] || srcCode;
  const lines = items.map((it, i) => `${i + 1}. ${it.text}`);
  return [
    `Translate ${items.length} short UI strings from ${sn} to ${tn}.`,
    `Output exactly ${items.length} lines. Each line must start with its number "N. " followed only by the translation.`,
    `Keep {placeholders}, code, URLs, numbers, file names and product names exactly as they are.`,
    `No explanations, no notes, no extra lines.`,
    ``,
    lines.join("\n"),
  ].join("\n");
}

function onePrompt(text, targetCode, srcCode) {
  const tn = LANG_NAMES[targetCode] || targetCode;
  const sn = LANG_NAMES[srcCode] || srcCode;
  return [
    `Translate this text from ${sn} to ${tn}. Keep every line break, {placeholder}, URL and code unchanged.`,
    `Output only the translation, nothing else.`,
    ``,
    text,
  ].join("\n");
}

const CHAT = "/v1/chat/completions";

function chatBody(content, model) {
  return {
    model,
    stream: true,
    temperature: 0,
    max_tokens: 2048,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: "user", content }],
  };
}

function parseNumbered(out, n) {
  const map = new Map();
  for (const raw of out.split("\n")) {
    const m = /^\s*(\d{1,3})\s*[.、)：:]\s*(.*)$/.exec(raw);
    if (!m) continue;
    const i = Number(m[1]);
    if (i >= 1 && i <= n && !map.has(i)) map.set(i, m[2].trim());
  }
  return map;
}

// ---------- 生成 ----------

let controller = null;
let running = null; // { locale, done, total, ok, failed }

export function isRunning() {
  return !!running;
}
export function runState() {
  return running;
}
export function cancelGenerate() {
  controller?.abort();
}

/**
 * 为 code 生成词典。只补缺的 key（已生成的跳过），逐批落盘，
 * 取消或断网保住已有结果。onProgress({done,total,ok,failed,skipped,locale}) 每批回调一次。
 */
export async function generateLocale(code, { onProgress, overwrite = false } = {}) {
  if (running) throw new Error("busy");
  const cfg = readCfg();
  const srcDict = getEntries(cfg.src) || {};
  const zhDict = getEntries("zh") || {};
  const kept = overwrite ? {} : { ...(cache[code]?.entries || {}) };
  const pending = baseKeys().filter((k) => !kept[k] && (srcDict[k] || zhDict[k]));

  controller = new AbortController();
  const signal = controller.signal;
  running = { locale: code, done: 0, total: pending.length, ok: 0, failed: 0, skipped: 0 };
  const report = () => onProgress?.({ ...running });
  report();

  const batchable = [];
  for (const key of pending) {
    const text = (srcDict[key] ?? zhDict[key] ?? "").trim();
    if (!text) {
      running.failed += 1;
      running.done += 1;
      continue;
    }
    // 多行词条只有几条，全是输入框里的示例文本（审核词表、提示词模板、唤醒词清单）。
    // 模型面对整段多行文本会把首行「例如：」当指令吃掉、后面再凑行数，行数对得上而内容已经串行——
    // 与其塞进词典一条看着像译文的错译文，不如留源语言走英文回退，一眼能看出没译。
    if (text.includes("\n")) {
      running.skipped += 1;
      running.done += 1;
      continue;
    }
    batchable.push({ key, text, src: srcDict[key] ? cfg.src : "zh" });
  }
  report();

  let persistFailed = false;
  const commit = (key, val) => {
    kept[key] = val;
    running.ok += 1;
  };
  const flush = () => {
    cache[code] = { at: Date.now(), model: cfg.model, src: cfg.src, entries: kept };
    addDict({ [code]: kept });
    persistFailed = !persistCache();
  };

  // 批里漏掉/没对齐的词条逐条补：先带指令 chat（能挂占位符与格式约束），
  // 再退固定模板的 /translate_stream；两条都不合格就宁可不收，回退源语言
  const oneByOne = async (item) => {
    const strategies = [
      async () => (await sseRequest(CHAT, chatBody(onePrompt(item.text, code, item.src), cfg.model), signal)).trim(),
      async () =>
        (
          await sseRequest(
            "/translate_stream",
            { text: item.text, source_lang: item.src, target_lang: code, model: cfg.model, stream: true },
            signal
          )
        ).trim(),
    ];
    for (const strategy of strategies) {
      if (signal.aborted) return;
      try {
        const out = await strategy();
        if (out && usable(item.text, out)) {
          commit(item.key, reedge(item.text, out));
          flush();
          return;
        }
      } catch {
        if (signal.aborted) return;
      }
      if (cfg.gapMs > 0) await sleep(cfg.gapMs);
    }
    running.failed += 1;
  };

  const size = Math.max(1, Math.min(30, Number(cfg.batch) || 12));
  const pools = [];
  for (let i = 0; i < batchable.length; i += size) pools.push(batchable.slice(i, i + size));

  // 并发跑批：池子小、间隔可配，对公开 demo 服务保持礼貌
  let cursor = 0;
  const worker = async () => {
    while (cursor < pools.length) {
      if (signal.aborted) return;
      const pool = pools[cursor++];
      try {
        const out = await sseRequest(
          CHAT,
          chatBody(batchPrompt(pool, code, cfg.src), cfg.model),
          signal
        );
        const map = parseNumbered(out, pool.length);
        const missed = [];
        pool.forEach((item, i) => {
          const val = map.get(i + 1);
          if (val && usable(item.text, val)) commit(item.key, reedge(item.text, val));
          else missed.push(item);
        });
        for (const item of missed) await oneByOne(item);
        running.done += pool.length;
        flush();
        report();
      } catch {
        if (signal.aborted) return;
        // 整批失败（多半是 429 或接口变更）就此收手不逐条追打：
        // 这些 key 没进词典，下次点「生成」会自动只补这部分
        running.failed += pool.length;
        running.done += pool.length;
        report();
      }
      if (cfg.gapMs > 0) await sleep(cfg.gapMs);
    }
  };
  const n = Math.max(1, Math.min(4, Number(cfg.concurrency) || 2));
  await Promise.all(Array.from({ length: n }, worker));

  flush();
  refreshLang();
  const res = { ...running, persistFailed, aborted: signal.aborted };
  running = null;
  controller = null;
  return res;
}
