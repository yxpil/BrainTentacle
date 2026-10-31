import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api.js";
import { useLang } from "../i18n.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import PillSwitch from "../components/PillSwitch.jsx";
import { IconPlus, IconTrash, IconSettings, IconCheck, IconX } from "../components/Icons.jsx";

// 支持的协议：原生对接各家 API
const PROTOCOLS = [
  { id: "openai", label: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-6.1-terra" },
  { id: "gemini", label: "Gemini", base: "https://generativelanguage.googleapis.com", model: "gemini-3.8-flash" },
  { id: "claude", label: "Claude", base: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
];
const protoLabel = (id) => PROTOCOLS.find((p) => p.id === id)?.label || id;

// 主流模型预设：点选自动填充协议 / Base URL / 模型名（各家 2026-10 公开文档确认的最新旗舰，也可点「从 API 获取」拉全量列表）
const PRESETS = [
  { name: "OpenAI GPT-6.1", protocol: "openai", base: "https://api.openai.com/v1", model: "gpt-6.1-terra" },
  { name: "DeepSeek V4.1 Flash", protocol: "openai", base: "https://api.deepseek.com/v1", model: "deepseek-flash" },
  { name: "Kimi K3.1 Pro", protocol: "openai", base: "https://api.moonshot.cn/v1", model: "kimi-k3-1-pro" },
  { name: "Qwen 3.8 Max (通义千问)", protocol: "openai", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.8-max" },
  { name: "Zhipu GLM (智谱)", protocol: "openai", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2" },
  { name: "xAI Grok 4.7", protocol: "openai", base: "https://api.x.ai/v1", model: "grok-4.7" },
  { name: "OpenRouter", protocol: "openai", base: "https://openrouter.ai/api/v1", model: "openrouter/auto" },
  { name: "SiliconFlow (硅基流动)", protocol: "openai", base: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  { name: "Ollama (local / 本地)", protocol: "openai", base: "http://127.0.0.1:11434/v1", model: "qwen3" },
  { name: "Google Gemini 3.8 Flash", protocol: "gemini", base: "https://generativelanguage.googleapis.com", model: "gemini-3.8-flash" },
  { name: "Claude Sonnet 5.5", protocol: "claude", base: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  { name: "Claude Opus 5.5", protocol: "claude", base: "https://api.anthropic.com", model: "claude-opus-5-5" },
];

const EMPTY = { id: null, name: "", protocol: "openai", base_url: "", api_key: "", model: "" };

// ── 语音合成（TTS）：本地 sherpa 系 8 个引擎 + 在线 4 家 ──
// group 决定 optgroup 分组；meta/langKey 仅本地引擎展示体积与语种；needsKey 的在线引擎显示 API key 输入框
const TTS_ENGINES = [
  { id: "supertonic", group: "local", nameKey: "settings.ttsEngineSupertonic", meta: "129MB", langKey: "settings.ttsLangMulti" },
  { id: "kitten", group: "local", nameKey: "settings.ttsEngineKitten", meta: "31MB", langKey: "settings.ttsLangEn" },
  { id: "matcha", group: "local", nameKey: "settings.ttsEngineMatcha", meta: "75MB", langKey: "settings.ttsLangZh" },
  { id: "zipvoice", group: "local", nameKey: "settings.ttsEngineZipvoice", meta: "109MB", langKey: "settings.ttsLangZhEn" },
  { id: "pocket", group: "local", nameKey: "settings.ttsEnginePocket", meta: "98MB", langKey: "settings.ttsLangEn" },
  { id: "kokoro", group: "local", nameKey: "settings.ttsEngineKokoro", meta: "103MB", langKey: "settings.ttsLangEn" },
  { id: "piper-zh", group: "local", nameKey: "settings.ttsEnginePiperHuayan", meta: "67MB", langKey: "settings.ttsLangZh" },
  { id: "piper-en", group: "local", nameKey: "settings.ttsEnginePiperAmy", meta: "67MB", langKey: "settings.ttsLangEn" },
  { id: "edge", group: "online", nameKey: "settings.ttsEngineEdge", badgeKey: "settings.ttsFreeKey" },
  { id: "gtts", group: "online", nameKey: "settings.ttsEngineGtts", badgeKey: "settings.ttsFreeKey" },
  { id: "siliconflow", group: "online", nameKey: "settings.ttsEngineSiliconflow", badgeKey: "settings.ttsNeedKey", needsKey: true },
  { id: "openai", group: "online", nameKey: "settings.ttsEngineOpenai", badgeKey: "settings.ttsNeedKey", needsKey: true },
];

// 在线引擎的内置固定音色表（EdgeTTS 走后端拉取的 322 音色，不在其中）
const TTS_BUILTIN_VOICES = {
  siliconflow: ["alex", "anna", "bella", "benjamin", "charles", "claire", "david", "diana"],
  openai: ["alloy", "echo", "fable", "nova", "onyx", "shimmer"],
};

const TTS_PARAM_DEFAULT = { voice: "", speed: 1, pitch: 0, volume: 100 };

// 最近一次选择的引擎（后端配置优先；这里只做 UI 回显）
function ttsSavedEngine() {
  const saved = localStorage.getItem("bit.ttsEngine");
  return TTS_ENGINES.some((e) => e.id === saved) ? saved : "edge";
}

// 引擎 id 与后端 engines 键名容错匹配（后端命名若有出入仍能对上模型状态）
function resolveTtsKey(id, engines) {
  if (!engines) return id;
  if (engines[id]) return id;
  const tokens = id.split("-");
  let best = id;
  let bestScore = 0;
  for (const k of Object.keys(engines)) {
    const score = tokens.filter((tok) => k.includes(tok)).length;
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return bestScore > 0 ? best : id;
}

// 音色列表归一化：兼容 ["en-US-AvaNeural"] / [{name,locale}] / {voices:[...]} / {groups:[{voices}]}
function ttsVoiceGroups(raw) {
  const entries = [];
  const push = (v) => {
    if (!v) return;
    const value = typeof v === "string" ? v : v.value ?? v.shortName ?? v.name ?? v.id;
    if (!value) return;
    const label = typeof v === "string" ? v : v.label ?? v.friendly ?? v.shortName ?? v.name ?? value;
    const locale = typeof v === "object" ? v.locale ?? v.lang ?? v.language ?? "" : "";
    const loc = locale || (/^[a-z]{2,3}-[A-Za-z]{2,4}/.test(value) ? value.split("-").slice(0, 2).join("-") : "other");
    entries.push({ value: String(value), label: String(label), locale: String(loc) });
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (Array.isArray(raw?.groups)) raw.groups.forEach((g) => (g.voices || g.items || []).forEach(push));
  else if (Array.isArray(raw?.voices)) raw.voices.forEach(push);
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.locale)) groups.set(e.locale, []);
    groups.get(e.locale).push(e);
  }
  return [...groups.entries()].map(([locale, items]) => ({ locale, items }));
}

function ttsBase64Bytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 语音合成卡：引擎选择 / 本地模型下载状态 / API key / 按引擎动态参数 / 试听播放
function TtsCard({ t }) {
  const [status, setStatus] = useState(null); // ttsStatus() 原样（null=探测中）
  const [engine, setEngine] = useState(ttsSavedEngine);
  const engineRef = useRef(engine);
  const [params, setParams] = useState({}); // engine -> {voice,speed,pitch,volume}
  const [extras, setExtras] = useState({}); // "engine:key" -> 引擎专属参数值
  const [voices, setVoices] = useState(null); // EdgeTTS 音色分组
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [err, setErr] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [fileHint, setFileHint] = useState("");
  const [dlProgress, setDlProgress] = useState(null);
  const audioRef = useRef(null);
  const urlRef = useRef("");
  const firstRef = useRef(true);
  const prevSampleRef = useRef("");

  const cfg = TTS_ENGINES.find((x) => x.id === engine) || TTS_ENGINES[0];
  const isLocal = cfg.group === "local";
  const engines = status?.engines || null;
  const backendKey = resolveTtsKey(engine, engines);
  const st = engines?.[backendKey] || null;

  // 在线引擎的试听示例句：按引擎支持语种挑
  const sampleFor = (id) => {
    const e = TTS_ENGINES.find((x) => x.id === id);
    if (e?.group === "local") {
      if (e.langKey === "settings.ttsLangZh") return t("settings.ttsExampleZh");
      if (e.langKey === "settings.ttsLangZhEn") return `${t("settings.ttsExampleZh")} ${t("settings.ttsExampleEn")}`;
      return t("settings.ttsExampleEn");
    }
    return t("settings.ttsExampleZh");
  };

  const refreshTts = () => {
    if (!api.ttsStatus) return;
    Promise.resolve(api.ttsStatus())
      .then((s) => {
        setStatus(s || null);
        if (firstRef.current) {
          firstRef.current = false;
          if (typeof s?.engine === "string" && TTS_ENGINES.some((e) => e.id === s.engine)) {
            setEngine(s.engine);
            localStorage.setItem("bit.ttsEngine", s.engine);
            // 示例文案未被用户改动时，跟着后端配置的引擎切换语种
            const next = sampleFor(s.engine);
            setText((cur) => (cur === "" || cur === prevSampleRef.current ? next : cur));
            prevSampleRef.current = next;
          }
        }
        const key = resolveTtsKey(engineRef.current, s?.engines);
        const cur = s?.engines?.[key];
        if (cur?.ready) {
          setStarting(false);
        } else if (!s?.downloading && !cur?.downloading && s?.error) {
          // 下载已停止但未就绪：停止轮询并展示失败原因
          setStarting(false);
          setErr(`${t("settings.ttsDownloadFailed")}：${s.error}`);
        }
      })
      .catch(() => setStatus(null));
  };

  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  useEffect(() => {
    setText(sampleFor(engine));
    prevSampleRef.current = sampleFor(engine);
    // 仅首次挂载填充示例文案
  }, []);

  useEffect(() => {
    refreshTts();
    let un = null;
    let alive = true;
    // 下载进度事件（后端 200ms 节流）：只采纳当前引擎的进度，结束后回拉状态
    listen("tts-progress", (e) => {
      const payload = e?.payload || {};
      const pEngine = payload.engine || "";
      if (pEngine && pEngine !== engineRef.current) return;
      const done = payload.progress?.done ?? payload.done ?? 0;
      const total = payload.progress?.total ?? payload.total ?? 0;
      if (total) setDlProgress({ done, total });
      if (payload.downloading === false || payload.ready || payload.finished) refreshTts();
    })
      .then((u) => {
        if (alive) un = u;
        else u?.();
      })
      .catch(() => {});
    return () => {
      alive = false;
      try {
        un?.();
      } catch {
        /* 忽略 */
      }
    };
  }, []);

  const downloading = !!(st?.downloading || (status?.downloading && status?.progress));
  // 下载进行中 / 已触发下载时 1.2s 轮询兜底
  useEffect(() => {
    if (!starting && !downloading) return;
    const timer = setInterval(refreshTts, 1200);
    return () => clearInterval(timer);
  }, [starting, downloading]);

  // EdgeTTS 音色自动拉取（322 个，按语言分组）；后端未提供该接口时保留手填输入框
  useEffect(() => {
    if (engine !== "edge" || voices !== null) return;
    const fn = api.ttsVoices || api.ttsListVoices;
    if (!fn) return;
    Promise.resolve(fn())
      .then((r) => setVoices(ttsVoiceGroups(r)))
      .catch(() => setVoices([]));
  }, [engine]);

  const stopAudio = () => {
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
      } catch {
        /* 忽略 */
      }
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = "";
    }
    setPlaying(false);
  };

  useEffect(
    () => () => {
      const a = audioRef.current;
      if (a) {
        try {
          a.pause();
        } catch {
          /* 忽略 */
        }
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );

  const p = params[engine] || TTS_PARAM_DEFAULT;
  const setP = (patch) =>
    setParams((all) => ({ ...all, [engine]: { ...(all[engine] || TTS_PARAM_DEFAULT), ...patch } }));

  const changeEngine = (id) => {
    stopAudio();
    setEngine(id);
    localStorage.setItem("bit.ttsEngine", id);
    setErr("");
    setFileHint("");
    setDlProgress(null);
    const next = sampleFor(id);
    if (!text || text === prevSampleRef.current) setText(next);
    prevSampleRef.current = next;
    // 选择持久化到 bit.db（tts 配置的保存入口是 ttsStatus(patch)）
    Promise.resolve(api.ttsStatus?.({ engine: id })).catch(() => {});
  };

  const startDownload = () => {
    if (starting) return;
    setErr("");
    setStarting(true);
    setDlProgress(null);
    Promise.resolve(api.ttsPrepare?.(backendKey))
      .then(() => setTimeout(refreshTts, 300))
      .catch((e) => {
        setStarting(false);
        setErr(`${t("settings.ttsDownloadFailed")}：${e?.message || e}`);
      });
  };

  const saveKey = async () => {
    const v = keyDraft.trim();
    if (!v) return;
    if (!api.ttsStatus) {
      setErr(t("settings.ttsKeySaveUnsupported"));
      return;
    }
    setErr("");
    try {
      // 后端 key 保存入口：ttsStatus({keys:{<engine>: <key>}})
      await api.ttsStatus({ keys: { [engine]: v } });
      setKeyDraft("");
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 1500);
      setTimeout(refreshTts, 300);
    } catch (e) {
      setErr(`${t("settings.ttsSpeakFailed")}：${e?.message || e}`);
    }
  };

  const tunables = Array.isArray(st?.tunables) ? st.tunables : [];
  const extraVal = (tb) =>
    extras[`${engine}:${tb.key}`] ?? tb.default ?? tb.def ?? tb.value ?? (tb.type === "select" || tb.type === "text" ? "" : tb.min ?? 0);
  const setExtra = (key, val) => setExtras((x) => ({ ...x, [`${engine}:${key}`]: val }));

  const speakErrText = (raw) => {
    const m = String(raw || "");
    if (/key|密钥|unauthorized|401/i.test(m)) return t("settings.ttsKeyMissing", { name: t(cfg.nameKey) });
    if (/network|超时|timeout|connect|ENOTFOUND|fetch|socket/i.test(m)) return t("settings.ttsNetworkError");
    if (/中文|Chinese|不支持该语言|unsupported language/i.test(m)) return t("settings.ttsLangUnsupported");
    return `${t("settings.ttsSpeakFailed")}：${m}`;
  };

  const speak = async () => {
    const say = (text || "").trim();
    if (!say) return;
    stopAudio();
    setErr("");
    if (!api.ttsSpeak) {
      setErr(t("settings.ttsUnsupported"));
      return;
    }
    if (cfg.needsKey && !status?.keys?.[engine]) {
      setErr(t("settings.ttsKeyMissing", { name: t(cfg.nameKey) }));
      return;
    }
    if (isLocal && !st?.ready) {
      setErr(t("settings.ttsNotDownloaded"));
      return;
    }
    const extra = {};
    tunables.forEach((tb) => {
      if (tb?.key) extra[tb.key] = extraVal(tb);
    });
    const opts = {
      engine: backendKey,
      voice: p.voice || undefined,
      speed: engine === "gtts" ? undefined : Number(p.speed),
      pitch: engine === "edge" ? Number(p.pitch) : undefined,
      volume: engine === "edge" ? Number(p.volume) : undefined,
      extra: tunables.length ? extra : undefined,
    };
    setBusy(true);
    try {
      const r = await api.ttsSpeak(say, opts);
      const b64 = r?.audioBase64 || r?.audio_base64;
      if (!b64) throw new Error(t("settings.ttsEmptyAudio"));
      const fmt = String(r?.format || "");
      const mime = /wav/i.test(fmt) ? "audio/wav" : /ogg/i.test(fmt) ? "audio/ogg" : "audio/mpeg";
      const url = URL.createObjectURL(new Blob([ttsBase64Bytes(b64)], { type: mime }));
      urlRef.current = url;
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = stopAudio;
      a.onerror = () => {
        stopAudio();
        setErr(t("settings.ttsPlayFailed"));
      };
      await a.play();
      setPlaying(true);
    } catch (e) {
      setErr(speakErrText(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // 音色下拉：Edge 拉取分组 / 在线内置表 / 本地默认（多说话人模型另有 sid 可调项）
  let voiceGroups = [];
  if (engine === "edge") voiceGroups = voices || [];
  else if (TTS_BUILTIN_VOICES[engine]) {
    voiceGroups = [{ locale: "", items: TTS_BUILTIN_VOICES[engine].map((v) => ({ value: v, label: v })) }];
  } else if (isLocal) {
    const local = ttsVoiceGroups(st?.voices);
    voiceGroups = local.length ? local : [{ locale: "", items: [{ value: "", label: t("settings.ttsVoiceDefault") }] }];
  }
  const pct = dlProgress?.total
    ? Math.round((dlProgress.done / dlProgress.total) * 100)
    : st?.progress?.total
    ? Math.round((st.progress.done / st.progress.total) * 100)
    : null;

  const renderTunable = (tb) => {
    if (!tb || !tb.key) return null;
    const key = tb.key;
    const value = extraVal(tb);
    const label = tb.label || key;
    // 克隆参考音频：文件选择器取本地绝对路径，取不到时允许手填
    if (tb.type === "file" || /reference.?audio/i.test(key)) {
      return (
        <div key={key}>
          <label className="mb-1 block px-2 text-xs text-neutral-500">{label}</label>
          <div className="flex items-center gap-2">
            <input
              className="field font-mono text-xs"
              value={value}
              onChange={(e) => setExtra(key, e.target.value)}
              placeholder={t("settings.ttsRefAudioPlaceholder")}
            />
            <label className="pill shrink-0 cursor-pointer text-xs">
              {t("settings.ttsPickFile")}
              <input
                type="file"
                accept="audio/*,.wav,.mp3"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const path = f.path || "";
                  if (path) {
                    setExtra(key, path);
                    setFileHint("");
                  } else {
                    setFileHint(t("settings.ttsPickFileHint"));
                  }
                }}
              />
            </label>
          </div>
          {fileHint && <p className="mt-1 px-2 text-[11px] text-amber-600 dark:text-amber-400">{fileHint}</p>}
        </div>
      );
    }
    if (tb.type === "select") {
      const opts = (tb.options || tb.values || []).map((o) =>
        typeof o === "object"
          ? { value: o.value ?? o.id ?? o, label: o.label ?? o.name ?? String(o.value ?? o.id ?? o) }
          : { value: o, label: String(o) }
      );
      return (
        <div key={key}>
          <label className="mb-1 block px-2 text-xs text-neutral-500">{label}</label>
          <select className="field" value={value} onChange={(e) => setExtra(key, e.target.value)}>
            {opts.map((o) => (
              <option key={String(o.value)} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    }
    if (tb.type === "text") {
      return (
        <div key={key}>
          <label className="mb-1 block px-2 text-xs text-neutral-500">{label}</label>
          <input
            className="field text-xs"
            value={value}
            onChange={(e) => setExtra(key, e.target.value)}
            placeholder={label}
          />
        </div>
      );
    }
    const min = tb.min ?? 0;
    const max = tb.max ?? 1;
    const step = tb.step ?? 0.01;
    return (
      <div key={key}>
        <div className="mb-1 flex items-center justify-between px-2">
          <label className="text-xs text-neutral-500">{label}</label>
          <span className="text-xs tabular-nums">{String(value)}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => setExtra(key, parseFloat(e.target.value))}
          className="w-full accent-[var(--accent)]"
        />
      </div>
    );
  };

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("settings.tts")}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{t("settings.ttsHint")}</p>
        </div>
        {keySaved && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
            <IconCheck size={14} />
            {t("settings.ttsKeySaved")}
          </span>
        )}
      </div>

      {/* 引擎：本地 / 在线 两组 */}
      <select className="field" value={engine} onChange={(e) => changeEngine(e.target.value)}>
        <optgroup label={t("settings.ttsGroupLocal")}>
          {TTS_ENGINES.filter((x) => x.group === "local").map((x) => (
            <option key={x.id} value={x.id}>
              {`${t(x.nameKey)} · ${x.meta} · ${t(x.langKey)}`}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("settings.ttsGroupOnline")}>
          {TTS_ENGINES.filter((x) => x.group === "online").map((x) => (
            <option key={x.id} value={x.id}>
              {`${t(x.nameKey)} · ${t(x.badgeKey)}`}
            </option>
          ))}
        </optgroup>
      </select>

      {/* 本地引擎模型状态行：未下载 / 下载中百分比 / 已就绪 */}
      {isLocal && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <span className={err && !st?.ready ? "text-red-500" : "text-neutral-500 dark:text-neutral-400"}>
            {status === null
              ? "…"
              : st?.ready
              ? t("settings.ttsReady")
              : pct != null
              ? t("settings.ttsDownloading", { p: pct })
              : starting || st?.downloading
              ? t("settings.ttsDownloadStart")
              : t("settings.ttsNotDownloaded")}
          </span>
          {status !== null && !st?.ready && !starting && !st?.downloading && (
            <button className="pill pill-hover shrink-0 text-xs" onClick={startDownload}>
              {t("settings.ttsDownload")}
            </button>
          )}
        </div>
      )}

      {/* 合成内核（sherpa CLI，按 os-arch 首启下载，多引擎共用一份）状态行：
          跨平台适配的主要差异点，未收录的架构在此如实说明并引导改用在线引擎 */}
      {isLocal && status?.cli && (
        <div className="rounded-2xl border border-neutral-200 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          {status.cli.supported
            ? status.cli.ready
              ? t("settings.ttsCliReady", { v: status.cli.version, p: status.cli.platform })
              : t("settings.ttsCliMissing", { mb: Math.round((status.cli.bytes || 0) / 1048576) })
            : t("settings.ttsCliUnsupported", { p: status.cli.platform })}
        </div>
      )}

      {/* SiliconFlow / OpenAI 需 API key */}
      {cfg.needsKey && (
        <div className="flex flex-col gap-2 rounded-2xl border border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div className="flex items-center justify-between">
            <label className="text-xs text-neutral-500">{t("settings.ttsApiKey")}</label>
            {status?.keys?.[engine] && <span className="chip shrink-0">{t("settings.ttsKeyConfigured")}</span>}
          </div>
          <div className="flex gap-2">
            <input
              className="field font-mono text-xs"
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="sk-…"
            />
            <button
              className="pill shrink-0 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!keyDraft.trim()}
              onClick={saveKey}
            >
              {t("settings.ttsSave")}
            </button>
          </div>
        </div>
      )}

      {/* 音色：Edge 拉取分组 / 在线内置 / 本地默认 */}
      {voiceGroups.length > 0 && (
        <div>
          <label className="mb-1 block px-2 text-xs text-neutral-500">{t("settings.ttsVoice")}</label>
          <select className="field" value={p.voice} onChange={(e) => setP({ voice: e.target.value })}>
            {voiceGroups.length === 1
              ? voiceGroups[0].items.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))
              : voiceGroups.map((g) => (
                  <optgroup key={g.locale} label={g.locale}>
                    {g.items.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
          </select>
        </div>
      )}
      {engine === "edge" && (!voices || voices.length === 0) && (
        <div>
          <label className="mb-1 block px-2 text-xs text-neutral-500">{t("settings.ttsVoice")}</label>
          <input
            className="field font-mono text-xs"
            value={p.voice}
            onChange={(e) => setP({ voice: e.target.value })}
            placeholder="en-US-AvaNeural"
          />
        </div>
      )}

      {/* 语速（gTTS 单音色不支持） */}
      {engine !== "gtts" && (
        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <label className="text-xs text-neutral-500">{t("settings.ttsSpeed")}</label>
            <span className="text-xs tabular-nums">{Number(p.speed).toFixed(1)}×</span>
          </div>
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            value={p.speed}
            onChange={(e) => setP({ speed: parseFloat(e.target.value) })}
            className="w-full accent-[var(--accent)]"
          />
        </div>
      )}

      {/* 音调 / 音量：仅 EdgeTTS（SSML） */}
      {engine === "edge" && (
        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <label className="text-xs text-neutral-500">{t("settings.ttsPitch")}</label>
            <span className="text-xs tabular-nums">
              {`${p.pitch > 0 ? "+" : ""}${Math.round(p.pitch)} Hz`}
            </span>
          </div>
          <input
            type="range"
            min="-50"
            max="50"
            step="1"
            value={p.pitch}
            onChange={(e) => setP({ pitch: parseInt(e.target.value, 10) })}
            className="w-full accent-[var(--accent)]"
          />
        </div>
      )}
      {engine === "edge" && (
        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <label className="text-xs text-neutral-500">{t("settings.ttsVolume")}</label>
            <span className="text-xs tabular-nums">{`${Math.round(p.volume)}%`}</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={p.volume}
            onChange={(e) => setP({ volume: parseInt(e.target.value, 10) })}
            className="w-full accent-[var(--accent)]"
          />
        </div>
      )}

      {/* 引擎专属参数（assets.json tunables 模板渲染；缺字段即不渲染） */}
      {tunables.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70">
          <p className="text-xs font-medium text-neutral-500">{t("settings.ttsEngineParams")}</p>
          {tunables.map((tb) => renderTunable(tb))}
        </div>
      )}

      {/* 试听 */}
      <div className="flex flex-col gap-2 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70">
        <label className="block px-2 text-xs text-neutral-500">{t("settings.ttsPreviewText")}</label>
        <textarea
          className="field min-h-[64px] resize-y text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("settings.ttsPreviewPlaceholder")}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="pill pill-hover text-xs disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy}
            onClick={playing ? stopAudio : speak}
          >
            {playing ? t("settings.ttsStop") : busy ? t("settings.ttsSynthesizing") : t("settings.ttsPreview")}
          </button>
          {playing && <span className="text-[11px] text-neutral-500">{t("settings.ttsPlaying")}</span>}
          <span className="ml-auto text-[11px] text-neutral-400">{t("settings.ttsPreviewHint")}</span>
        </div>
        {err && <p className="px-2 text-xs text-red-500 dark:text-red-400">{err}</p>}
      </div>
    </div>
  );
}

// AI 设置：可增删的多家提供方，用播放/暂停切换，每次仅一个激活
export default function AiSettingsPage({ onStats, stats }) {
  const { t } = useLang();
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState(EMPTY); // 新增 / 编辑用同一张表单
  const [showForm, setShowForm] = useState(false); // 表单以悬浮弹窗呈现，平时不占页面空间
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // 模型采样参数：temperature null=默认；reasoning_effort ""=默认 / low / medium / high
  const [params, setParams] = useState({ temperature: null, reasoning_effort: "" });
  const [paramsSaved, setParamsSaved] = useState(false);
  // 幻觉防护阈值：word_repeat_max=单回复词重复上限 / tool_loop_max=单回合工具轮上限（0=关闭）
  const [limits, setLimits] = useState({ word_repeat_max: 20, tool_loop_max: 20 });
  const [limitsSaved, setLimitsSaved] = useState(false);
  const [toolEnv, setToolEnv] = useState({ tool_timeout_secs: 120, default_shell: "", available_shells: [] });
  const [toolEnvSaved, setToolEnvSaved] = useState(false);
  // AI 行为设置：自动推进 / 审批模式 / 敏感词审核 / 兼容模式
  const [behavior, setBehavior] = useState({
    auto_drive: true,
    auto_delegate: false,
    subagent_max: 3,
    tool_approval: "ask",
    moderation_enabled: true,
    compat_mode: false,
  });
  // 敏感词审核词表：文本为当前生效词表（未自定义时展示内置默认），每行一个词
  const [wordsText, setWordsText] = useState("");
  const [wordsCustom, setWordsCustom] = useState(false); // 是否已在用自定义词表
  const [wordsDirty, setWordsDirty] = useState(false);
  const [wordsSaved, setWordsSaved] = useState(false);
  // 用户自定义提示词/人设
  const [customPrompt, setCustomPrompt] = useState("");
  const [promptSaved, setPromptSaved] = useState(false);
  // 系统提示词模板覆盖（空=用默认）
  const [systemPrompt, setSystemPrompt] = useState("");
  const [systemPromptSaved, setSystemPromptSaved] = useState(false);
  // 开机自动启动：null=加载中；开启后登录系统即在后台驻留（托盘）
  const [autostart, setAutostart] = useState(null);
  // 唤出主界面的全局快捷键：文本框编辑 + 保存即生效（空 = 关闭）；冲突时后端返回错误原因
  const [hotkey, setHotkey] = useState("");
  const [hotkeySaved, setHotkeySaved] = useState(false);
  const [hotkeyErr, setHotkeyErr] = useState("");
  // 截图提问 / 全局语音：Electron 主进程注册的附加全局快捷键（存 userData/app-hotkeys.json）
  const [shotHotkey, setShotHotkey] = useState("");
  const [voiceHotkey, setVoiceHotkey] = useState("");
  const [appHkSaved, setAppHkSaved] = useState(""); // "screenshot" | "voice" | ""
  const [appHkErr, setAppHkErr] = useState("");
  const [appCaps, setAppCaps] = useState(null); // 主进程能力位：截图后端 / 粘贴通道是否可用
  // 提示词模板库：列表增/删/改，保存走 prompt_templates_set（清空保存 = 恢复内置默认）
  const [templates, setTemplates] = useState(null); // null=加载中
  const [tplSaved, setTplSaved] = useState(false);
  const [tplErr, setTplErr] = useState("");
  // 从提供方 API 拉取的模型列表（点击模型名直接填充）
  const [remoteModels, setRemoteModels] = useState(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsErr, setFetchModelsErr] = useState("");
  const [baseHint, setBaseHint] = useState("");
  // 高权限模式：elevation=null=探测中；elevErr=上次授权失败原因（v0.5.14 黑屏修复：声明漏写导致渲染期 ReferenceError 整树卸载）
  const [elevation, setElevation] = useState(null);
  const [elevErr, setElevErr] = useState("");
  // 自动运行（后台自主循环：记忆总结 / 技能提炼 / 目标行动）——运行总览里的小圆钮
  const [autoRun, setAutoRun] = useState(false);
  // 本机操控开关（screen/mouse/keyboard/draw_diagram/view_image，默认全关）
  const [deskTools, setDeskTools] = useState({ screen: false, mouse: false, keyboard: false, diagram: false, viewimage: false });
  // 写文件后轻量语法检查（json/js/py）：出错提醒模型与用户
  const [syntaxCheck, setSyntaxCheck] = useState(true);
  // 上下文自动压缩：会话超阈值把旧历史压成摘要再发模型（可选便宜模型压缩，数据库原文不动）
  const [compact, setCompact] = useState({ auto: false, chars: 24000, provider: "" });
  // 待办时钟（对话页待办面板显示计划时间）：纯 UI 偏好，localStorage 持久化，默认开
  const [todoClock, setTodoClock] = useState(() => localStorage.getItem("bit.todoClock") !== "0");
  const toggleTodoClock = () =>
    setTodoClock((v) => {
      const next = !v;
      localStorage.setItem("bit.todoClock", next ? "1" : "0");
      // 同窗口渲染：广播给对话页即时同步（跨窗口由 storage 事件兜底）
      window.dispatchEvent(new CustomEvent("bit-todo-clock"));
      return next;
    });
  // 语音输入开关（对话页输入框麦克风按钮）：localStorage bit.voiceInput，默认开
  const [voiceInput, setVoiceInput] = useState(() => localStorage.getItem("bit.voiceInput") !== "0");
  const toggleVoiceInput = () =>
    setVoiceInput((v) => {
      const next = !v;
      localStorage.setItem("bit.voiceInput", next ? "1" : "0");
      // 同窗口广播给对话页即时同步（跨窗口由 storage 事件兜底）
      window.dispatchEvent(new CustomEvent("bit-voice-input"));
      return next;
    });
  // 免手对话：语音唤醒转写完成后自动发送，朗读结束回到待唤醒（localStorage bit.freehand，默认关）
  const [freehand, setFreehand] = useState(() => localStorage.getItem("bit.freehand") === "1");
  const toggleFreehand = () =>
    setFreehand((v) => {
      const next = !v;
      localStorage.setItem("bit.freehand", next ? "1" : "0");
      // 同窗口广播给对话页即时同步（跨窗口由 storage 事件兜底）
      window.dispatchEvent(new CustomEvent("bit-freehand"));
      return next;
    });
  // 语音识别模型状态：null=探测中；{ ready, downloading, progress }
  const [voiceModel, setVoiceModel] = useState(null);
  // 识别模型多选一：variants 来自 voiceStatus；切换走 voiceSelect（未就绪的会触发下载）
  const [voiceVariants, setVoiceVariants] = useState([]);
  const [voiceVariant, setVoiceVariant] = useState("");
  const [voiceStarting, setVoiceStarting] = useState(false); // 已触发下载（防重复点 + 驱动进度轮询）
  const [voiceErr, setVoiceErr] = useState(""); // 下载失败原因
  const refreshVoiceModel = () =>
    api
      .voiceStatus()
      .then((s) => {
        const ready = !!s?.ready;
        const dl = !!s?.downloading;
        setVoiceModel({ ready, downloading: dl, progress: s?.progress || null, kws: s?.kws || null });
        setVoiceVariants(s?.variants || []);
        setVoiceVariant(s?.variant || "");
        if (ready) {
          setVoiceStarting(false);
          setVoiceErr("");
        } else {
          // 下载已停止但未就绪：停止轮询并展示失败原因（无 error 则保持上次提示）
          if (!dl) setVoiceStarting(false);
          if (s?.error) setVoiceErr(`${t("voice.downloadFailed")}：${s.error}`);
        }
      })
      .catch(() => setVoiceModel({ ready: false, downloading: false, progress: null, kws: null }));
  const voiceDownloading = !!voiceModel?.downloading;
  // 首次进入拉取模型状态；下载进行中轮询进度兜底（voice-progress 事件由对话页订阅）
  useEffect(() => {
    refreshVoiceModel();
  }, []);
  useEffect(() => {
    if (!voiceStarting && !voiceDownloading) return;
    const timer = setInterval(refreshVoiceModel, 1200);
    return () => clearInterval(timer);
  }, [voiceStarting, voiceDownloading]);
  const startVoiceDownload = () => {
    if (voiceStarting) return;
    setVoiceErr("");
    setVoiceStarting(true);
    // 幂等触发；进度与完成状态由 voiceStarting 驱动的轮询跟进
    api.voicePrepare().catch((e) => {
      const emsg = typeof e === "string" ? e : e?.message || String(e);
      setVoiceStarting(false);
      setVoiceErr(`${t("voice.downloadFailed")}${emsg ? `：${emsg}` : ""}`);
    });
  };
  // 切换识别模型（多选一）：写库 + 杀 worker 热切换；未就绪的模型自动接着触发下载
  const selectVoiceVariant = (id) => {
    if (!id || id === voiceVariant) return;
    setVoiceErr("");
    api
      .voiceSelect(id)
      .then(() => {
        setVoiceVariant(id);
        setVoiceModel((m) => ({ ...(m || { ready: false, downloading: false }), ready: false }));
        setVoiceStarting(true);
        // 幂等触发下载；进度由 voiceStarting 驱动的轮询跟进
        api.voicePrepare().catch((e) => {
          const emsg = typeof e === "string" ? e : e?.message || String(e);
          setVoiceStarting(false);
          setVoiceErr(`${t("voice.downloadFailed")}${emsg ? `：${emsg}` : ""}`);
        });
      })
      .catch((e) => {
        const emsg = typeof e === "string" ? e : e?.message || String(e);
        setVoiceErr(`${t("voice.downloadFailed")}${emsg ? `：${emsg}` : ""}`);
      });
  };

  // 语音唤醒（KWS）：状态并进 voiceModel.kws；灵敏度本地编辑 + 防抖提交
  const [kwsStarting, setKwsStarting] = useState(false);
  const [kwsErr, setKwsErr] = useState("");
  const [kwsScore, setKwsScore] = useState(1.5);
  const kwsScoreTimer = useRef(null);
  // 自定义唤醒词：textarea 文本（每行「词 拼音」），保存时转 [{word,pinyin}] 提交（[] = 恢复内置词表）
  const [kwsWordsText, setKwsWordsText] = useState("");
  const [kwsWordsErr, setKwsWordsErr] = useState("");
  useEffect(() => {
    const ws = voiceModel?.kws?.words;
    if (Array.isArray(ws)) {
      setKwsWordsText(ws.map((w) => `${w.word} ${w.pinyin}`).join("\n"));
    }
  }, [voiceModel?.kws?.words]);
  const submitKwsWords = (words) => {
    setKwsWordsErr("");
    api
      .voiceKwsSet(!!voiceModel?.kws?.enabled, kwsScore, words)
      .then(() => {
        refreshVoiceModel();
        window.dispatchEvent(new Event("bit-kws-changed")); // ChatPage 热重启唤醒监听
      })
      .catch((e) => setKwsWordsErr(typeof e === "string" ? e : e?.message || String(e)));
  };
  const saveKwsWords = () => {
    const words = kwsWordsText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.split(/\s+/);
        return { word: m[0], pinyin: m.slice(1).join(" ") };
      });
    submitKwsWords(words);
  };
  // 后端返回 score 时同步本地滑条（首次/切页回来）
  useEffect(() => {
    if (voiceModel?.kws?.score) setKwsScore(Number(voiceModel.kws.score) || 1.5);
  }, [voiceModel?.kws?.score]);
  const startKwsDownload = () => {
    if (kwsStarting) return;
    setKwsErr("");
    setKwsStarting(true);
    api
      .voiceKwsPrepare()
      .catch((e) => {
        const emsg = typeof e === "string" ? e : e?.message || String(e);
        setKwsErr(`${t("voice.downloadFailed")}${emsg ? `：${emsg}` : ""}`);
      })
      .finally(() => setKwsStarting(false));
  };
  // KWS 下载进度（与识别模型共用全局 progress：done/total）
  const kwsProgressPct = voiceModel?.progress?.total
    ? Math.min(100, Math.round((voiceModel.progress.done / voiceModel.progress.total) * 100))
    : 8;

  const load = () =>
    api.listProviders().then((r) => setProviders(r.providers || [])).catch(() => {});
  useEffect(() => {
    load();
    api.getAiParams().then((r) => setParams({ temperature: r?.temperature ?? null, reasoning_effort: r?.reasoning_effort || "" })).catch(() => {});
    api.getGuardLimits().then((r) => setLimits({ word_repeat_max: r?.word_repeat_max ?? 20, tool_loop_max: r?.tool_loop_max ?? 20 })).catch(() => {});
    api
      .getToolEnvSettings()
      .then((r) =>
        setToolEnv({
          tool_timeout_secs: r?.tool_timeout_secs ?? 120,
          default_shell: r?.default_shell || "",
          available_shells: r?.available_shells || [],
        })
      )
      .catch(() => {});
    api
      .getBehaviorSettings()
      .then((r) => {
        setBehavior({
          auto_drive: r?.auto_drive ?? true,
          auto_delegate: r?.auto_delegate ?? false,
          subagent_max: r?.subagent_max ?? 3,
          tool_approval: r?.tool_approval || "ask",
          moderation_enabled: r?.moderation_enabled ?? true,
          compat_mode: r?.compat_mode ?? false,
        });
        setWordsText((r?.blocked_words || []).join("\n"));
        setWordsCustom(!!r?.blocked_words_custom);
        setWordsDirty(false);
      })
      .catch(() => {});
    api.getCustomPrompt().then((r) => setCustomPrompt(r?.custom_prompt || "")).catch(() => {});
    api.getSystemPrompt().then((r) => setSystemPrompt(r?.system_prompt || "")).catch(() => {});
    api.compactConfigGet().then((r) => setCompact({ auto: !!r?.auto, chars: Number(r?.chars) || 24000, provider: r?.provider || "" })).catch(() => {});
    api.getAutostart().then((r) => setAutostart(!!r?.enabled)).catch(() => setAutostart(false));
    api.getHotkey().then((r) => setHotkey(r?.hotkey || "")).catch(() => {});
    api.getAppHotkeys().then((r) => { setShotHotkey(r?.screenshot || ""); setVoiceHotkey(r?.voice || ""); setAppCaps(r?.caps || null); }).catch(() => {});
    api.promptTemplatesGet().then((r) => setTemplates(r?.templates || [])).catch(() => setTemplates([]));
    api.getDesktopTools().then((r) => setDeskTools({ screen: !!r?.screen, mouse: !!r?.mouse, keyboard: !!r?.keyboard, diagram: !!r?.diagram, viewimage: !!r?.viewimage })).catch(() => {});
    api.getElevation().then((r) => setElevation({ active: !!r?.active, enabled: !!r?.enabled })).catch(() => setElevation({ active: false, enabled: false }));
  }, []);

  // 自动压缩配置：任何变更即时保存（开关/阈值/压缩模型）
  const saveCompact = (patch) => {
    const next = { ...compact, ...patch };
    setCompact(next);
    api.compactConfigSet(next.auto, Number(next.chars) || 24000, next.provider).catch(() => {});
  };

  // 提示词模板：整体保存（后端归一化/去空/上限 100；空列表 = 恢复内置默认）
  const saveTemplates = () => {
    setTplErr("");
    api
      .promptTemplatesSet(templates || [])
      .then(() => {
        setTplSaved(true);
        setTimeout(() => setTplSaved(false), 1500);
      })
      .catch((e) => setTplErr(typeof e === "string" ? e : e?.message || String(e)));
  };

  // 截图提问 / 全局语音快捷键：两键独立保存（Electron 主进程 globalShortcut）
  const saveAppHotkeys = (patch) => {
    const next = { screenshot: shotHotkey, voice: voiceHotkey, ...patch };
    setShotHotkey(next.screenshot);
    setVoiceHotkey(next.voice);
    setAppHkErr("");
    api
      .setAppHotkeys(next.screenshot, next.voice)
      .then((r) => {
        setAppCaps(r?.caps || appCaps);
        setAppHkSaved(patch.screenshot !== undefined ? "screenshot" : "voice");
        setTimeout(() => setAppHkSaved(""), 1500);
      })
      .catch((e) => setAppHkErr(typeof e === "string" ? e : e?.message || String(e)));
  };

  // App 定时轮询 overview，stats.autopilot_running 变化时同步小圆钮状态
  useEffect(() => setAutoRun(!!stats?.autopilot_running), [stats]);

  // 开机自启开关：先落系统登录项，失败回滚显示原状态
  const toggleAutostart = (enabled) => {
    const prev = autostart;
    setAutostart(enabled);
    api.setAutostart(enabled).catch(() => setAutostart(prev));
  };

  // 高权限开关：成功即触发系统授权弹窗并以目标权限重启（当前进程随后自动退出）；
  // 失败（用户取消授权等）回滚开关并显示原因
  const toggleElevation = (enabled) => {
    setElevation((e) => ({ ...(e || { active: false, enabled: false }), enabled }));
    setElevErr("");
    api.setElevation(enabled).catch((err) => {
      api.getElevation().then((r) => setElevation({ active: !!r?.active, enabled: !!r?.enabled })).catch(() => {});
      setElevErr(String(err).replace(/^.*Error[:：]\s*/, ""));
    });
  };

  // 变更即保存（温度滑块拖动用 300ms 防抖，避免频繁落盘）
  const debounceRef = useRef(null);
  const saveParams = (next, debounce = false) => {
    setParams(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const doSave = () => {
      api.setAiParams(next.temperature, next.reasoning_effort).then(() => {
        setParamsSaved(true);
        setTimeout(() => setParamsSaved(false), 1500);
      }).catch(() => {});
    };
    if (debounce) debounceRef.current = setTimeout(doSave, 300);
    else doSave();
  };

  // 幻觉防护阈值变更即保存（300ms 防抖，0=关闭对应检测）
  const limitsRef = useRef(null);
  const saveLimits = (next) => {
    setLimits(next);
    if (limitsRef.current) clearTimeout(limitsRef.current);
    limitsRef.current = setTimeout(() => {
      api.setGuardLimits(next.word_repeat_max, next.tool_loop_max).then(() => {
        setLimitsSaved(true);
        setTimeout(() => setLimitsSaved(false), 1500);
      }).catch(() => {});
    }, 300);
  };
  const toolEnvRef = useRef(null);
  const saveToolEnv = (next) => {
    setToolEnv(next);
    if (toolEnvRef.current) clearTimeout(toolEnvRef.current);
    toolEnvRef.current = setTimeout(() => {
      api.setToolEnvSettings(next.tool_timeout_secs, next.default_shell).then(() => {
        setToolEnvSaved(true);
        setTimeout(() => setToolEnvSaved(false), 1500);
      }).catch(() => {});
    }, 300);
  };
  const saveBehavior = (next) => {
    setBehavior(next);
    api
      .setBehaviorSettings(next.auto_drive, next.tool_approval, next.moderation_enabled, next.auto_delegate, next.compat_mode, next.subagent_max)
      .catch(() => {});
  };
  // 敏感词表：按行/中英文逗号/分号切分。空文本=空数组=恢复内置默认
  const wordsToList = (text) =>
    text
      .split(/[\n,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  const wordsCount = (text) => wordsToList(text).length;
  const saveWords = (list) => {
    api
      .setBehaviorSettings(behavior.auto_drive, behavior.tool_approval, behavior.moderation_enabled, behavior.auto_delegate, behavior.compat_mode, behavior.subagent_max, list)
      .then(() => {
        setWordsSaved(true);
        setTimeout(() => setWordsSaved(false), 1500);
        setWordsDirty(false);
        if (!list.length) {
          // 恢复内置默认：重新拉取内置词表展示
          api
            .getBehaviorSettings()
            .then((r) => {
              setWordsText((r?.blocked_words || []).join("\n"));
              setWordsCustom(false);
            })
            .catch(() => {});
        } else {
          setWordsCustom(true);
          setWordsText(list.join("\n"));
        }
      })
      .catch(() => {});
  };

  // 自动运行圆钮：状态以后端返回为准，失败保持原状
  const toggleAutoRun = async () => {
    try {
      const r = await api.toggleAutopilot();
      setAutoRun(!!r?.running);
      onStats?.();
    } catch {
      // 切换失败：保持原状态，不打扰用户
    }
  };

  const editing = form.id !== null;

  // 选协议时自动带出该协议的默认 base_url / model（仅当用户未填时）
  const pickProtocol = (protocol) => {
    const proto = PROTOCOLS.find((p) => p.id === protocol);
    setForm((f) => ({
      ...f,
      protocol,
      base_url: f.base_url && f.id ? f.base_url : proto?.base || "",
      model: f.model && f.id ? f.model : proto?.model || "",
    }));
  };

  // 选预设：一键填充协议 / Base URL / 模型 / 名称（Key 需用户自填）
  const pickPreset = (preset) => {
    setForm((f) => ({
      ...f,
      name: preset.name,
      protocol: preset.protocol,
      base_url: preset.base,
      model: preset.model,
    }));
    setRemoteModels(null);
    setFetchModelsErr("");
    setError("");
  };

  // 从提供方 API 拉取可用模型列表（需先填 Base URL 与 API Key）
  const fetchModels = async () => {
    setFetchingModels(true);
    setFetchModelsErr("");
    setBaseHint("");
    try {
      // 后端返回 {base, models}：base 为自动检测后的生效端点（如补了 /v1）
      const res = await api.listProviderModels(form.protocol, form.base_url, form.api_key);
      const list = Array.isArray(res) ? res : res?.models || [];
      setRemoteModels(list);
      const effective = Array.isArray(res) ? null : res?.base;
      if (effective && effective !== form.base_url.trim().replace(/\/+$/, "")) {
        setForm((f) => ({ ...f, base_url: effective }));
        setBaseHint(t("ai.baseAutoFixed").replace("{base}", effective));
      }
    } catch (err) {
      setRemoteModels(null);
      setFetchModelsErr(String(err));
    } finally {
      setFetchingModels(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      if (editing) {
        await api.updateProvider(form.id, form.name, form.protocol, form.base_url, form.api_key, form.model);
      } else {
        await api.addProvider(form.name, form.protocol, form.base_url, form.api_key, form.model);
      }
      setForm(EMPTY);
      setShowForm(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      await load();
      onStats?.();
    } catch (err) {
      setError(String(err));
    }
  };

  const startEdit = (p) => {
    setForm({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      base_url: p.base_url,
      api_key: p.api_key,
      model: p.model,
    });
    setRemoteModels(null);
    setFetchModelsErr("");
    setError("");
    setShowForm(true);
  };

  const remove = async (id) => {
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("ai.confirmRemove"),
        danger: true,
      }))
    )
      return;
    await api.removeProvider(id);
    if (form.id === id) setForm(EMPTY);
    await load();
    onStats?.();
  };

  // 播放/暂停：激活某项（互斥）或暂停当前项
  const toggleActive = async (p, next) => {
    await api.setProviderActive(p.id, next);
    await load();
    onStats?.();
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h2 className="text-lg font-semibold">{t("ai.title")}</h2>
        <p className="text-xs text-neutral-500">
          {t("ai.subtitle")}
        </p>
      </div>

      {/* 运行总览 */}
      {stats && (
        <div className="card">
          <p className="mb-3 text-xs font-medium text-neutral-900 dark:text-neutral-100">{t("ai.statsTitle")}</p>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {[
              [t("ai.statTools"), stats.tool_count],
              [t("ai.statMemory"), stats.memory_count],
              [t("ai.statSkills"), stats.skill_count],
              [t("ai.statGoals"), stats.goal_count],
              [t("ai.statTodos"), stats.todo_count],
              [t("ai.statAudit"), stats.audit_count],
            ].map(([label, n]) => (
              <div key={label} className="text-center">
                <div className="text-xl font-bold tabular-nums">{n ?? 0}</div>
                <div className="text-[11px] text-neutral-500">{label}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70">
            <span className="chip">{stats.ai_configured ? t("ai.aiActive") : t("ai.aiInactive")}</span>
            <span className={`chip ${stats.remote?.enabled ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : ""}`}>
              {stats.remote?.enabled ? `${t("ai.remoteOn")}${stats.remote.addr}` : t("ai.remoteOff")}
            </span>
            <button
              type="button"
              onClick={() => {
                setForm(EMPTY);
                setError("");
                setRemoteModels(null);
                setFetchModelsErr("");
                setShowForm(true);
              }}
              className="pill pill-hover text-xs"
            >
              + {t("ai.addProvider")}
            </button>
            <PillSwitch
              size="sm"
              checked={autoRun}
              onChange={toggleAutoRun}
              title={autoRun ? t("ai.autoOnTip") : t("ai.autoOffTip")}
            />
          </div>
        </div>
      )}

      {/* 提供方列表 */}
      <div className="flex flex-col gap-2">
        {providers.length === 0 && (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
            <IconSettings size={16} />
            {t("ai.emptyProviders")}
          </div>
        )}
        {providers.map((p) => (
          <div
            key={p.id}
            className={`card flex items-center gap-3 ${
              p.active ? "border-neutral-900/40 dark:border-white/40" : ""
            }`}
          >
            <PillSwitch
              checked={p.active}
              onChange={(next) => toggleActive(p, next)}
              title={p.active ? t("ai.pauseTip") : t("ai.playTip")}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{p.name}</span>
                <span className="chip shrink-0">{protoLabel(p.protocol)}</span>
                {p.active && (
                  <span className="chip shrink-0 border-emerald-500/50 text-emerald-600 dark:text-emerald-400">
                    {t("ai.inUse")}
                  </span>
                )}
                {!p.api_key && (
                  <span className="chip shrink-0 border-amber-500/50 text-amber-600 dark:text-amber-400">
                    {t("ai.missingKey")}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">
                {p.model} · {p.base_url}
              </p>
            </div>
            <button
              onClick={() => startEdit(p)}
              title={t("common.edit")}
              className="icon-btn shrink-0">
              <IconSettings size={15} />
            </button>
            <button
              onClick={() => remove(p.id)}
              title={t("common.delete")}
              className="icon-btn shrink-0 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40">
              <IconTrash size={15} />
            </button>
          </div>
        ))}
      </div>

      {/* 模型参数：思考强度 + 温度 */}
      <div className="card flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t("ai.paramsTitle")}</p>
          {paramsSaved && (
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <IconCheck size={14} />
              {t("common.saved")}
            </span>
          )}
        </div>

        <div>
          <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.reasoningLabel")}</label>
          <div className="flex gap-2">
            {[
              ["", t("ai.thinkDefault")],
              ["low", t("ai.thinkLow")],
              ["medium", t("ai.thinkMedium")],
              ["high", t("ai.thinkHigh")],
            ].map(([v, label]) => (
              <button
                key={v || "default"}
                type="button"
                onClick={() => saveParams({ ...params, reasoning_effort: v })}
                className={`flex-1 rounded-full px-3 py-2 text-xs font-medium transition-colors duration-200 ${
                  params.reasoning_effort === v
                    ? "accent-solid"
                    : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 px-2 text-[11px] text-neutral-400">{t("ai.reasoningHint")}</p>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <label className="text-xs text-neutral-500">{t("ai.temperatureLabel")}</label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => params.temperature !== null && saveParams({ ...params, temperature: null })}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-200 ${
                  params.temperature === null
                    ? "accent-solid"
                    : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                }`}
              >
                {t("ai.thinkDefault")}
              </button>
              <button
                type="button"
                onClick={() => (params.temperature === null ? saveParams({ ...params, temperature: 0.7 }) : saveParams({ ...params, temperature: Math.min(2, Math.max(0, params.temperature)) }))}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-200 ${
                  params.temperature !== null
                    ? "accent-solid"
                    : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                }`}
              >
                {t("ai.tempCustom")}
              </button>
            </div>
          </div>
          {params.temperature !== null ? (
            <div className="flex items-center gap-3 px-2">
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={params.temperature}
                onChange={(e) => saveParams({ ...params, temperature: parseFloat(e.target.value) }, true)}
                className="flex-1 accent-[var(--accent)]"
              />
              <span className="w-10 text-right text-xs tabular-nums">{params.temperature.toFixed(1)}</span>
            </div>
          ) : (
            <p className="px-2 text-[11px] text-neutral-400">{t("ai.temperatureDefaultHint")}</p>
          )}
        </div>
      </div>

      {/* 幻觉防护：词重复 / 工具死循环熔断阈值（0=关闭），深浅主题沿用 field/card 变量 */}
      <div className="card flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t("ai.guardTitle")}</p>
            <p className="mt-0.5 text-xs text-neutral-500">{t("ai.guardDesc")}</p>
          </div>
          {limitsSaved && (
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <IconCheck size={14} />
              {t("common.saved")}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.guardWord")}</label>
            <input
              className="field tabular-nums"
              type="number"
              min="0"
              max="10000"
              value={limits.word_repeat_max}
              onChange={(e) =>
                saveLimits({ ...limits, word_repeat_max: Math.max(0, Math.min(10000, parseInt(e.target.value, 10) || 0)) })
              }
            />
            <p className="mt-1 px-2 text-[11px] text-neutral-400">{t("ai.guardWordHint")}</p>
          </div>
          <div>
            <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.guardTool")}</label>
            <input
              className="field tabular-nums"
              type="number"
              min="0"
              max="10000"
              value={limits.tool_loop_max}
              onChange={(e) =>
                saveLimits({ ...limits, tool_loop_max: Math.max(0, Math.min(10000, parseInt(e.target.value, 10) || 0)) })
              }
            />
            <p className="mt-1 px-2 text-[11px] text-neutral-400">{t("ai.guardToolHint")}</p>
          </div>
        </div>
      </div>

      {/* 工具环境：自定义工具超时 / 默认 shell */}
      <div className="card flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t("ai.toolEnvTitle")}</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              {t("ai.toolEnvDesc")}
            </p>
          </div>
          {toolEnvSaved && (
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <IconCheck size={14} />
              {t("common.saved")}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.toolTimeout")}</label>
            <input
              className="field tabular-nums"
              type="number"
              min="10"
              max="600"
              value={toolEnv.tool_timeout_secs}
              onChange={(e) =>
                saveToolEnv({ ...toolEnv, tool_timeout_secs: Math.max(10, Math.min(600, parseInt(e.target.value, 10) || 120)) })
              }
            />
            <p className="mt-1 px-2 text-[11px] text-neutral-400">{t("ai.toolTimeoutHint")}</p>
          </div>
          <div>
            <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.defaultShell")}</label>
            <select
              className="field"
              value={toolEnv.default_shell}
              onChange={(e) => saveToolEnv({ ...toolEnv, default_shell: e.target.value })}
            >
              <option value="">{t("ai.shellAuto")}</option>
              {toolEnv.available_shells.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <p className="mt-1 px-2 text-[11px] text-neutral-400">{t("ai.shellAutoHint")}</p>
          </div>
        </div>
      </div>

      {/* AI 行为设置 */}
      <div className="card flex flex-col gap-4">
        <p className="text-sm font-medium">{t("ai.behaviorTitle")}</p>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm">{t("ai.autoDrive")}</p>
            <p className="text-xs text-neutral-500">{t("ai.autoDriveHint")}</p>
          </div>
          <PillSwitch
            checked={behavior.auto_drive}
            onChange={(v) => saveBehavior({ ...behavior, auto_drive: v })}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm">{t("ai.autoDelegate")}</p>
            <p className="text-xs text-neutral-500">{t("ai.autoDelegateHint")}</p>
          </div>
          <PillSwitch
            checked={!!behavior.auto_delegate}
            onChange={(v) => saveBehavior({ ...behavior, auto_delegate: v })}
          />
        </div>

        {behavior.auto_delegate && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm">{t("ai.subagentMax")}</p>
              <p className="text-xs text-neutral-500">{t("ai.subagentMaxHint")}</p>
            </div>
            <input
              className="field tabular-nums"
              style={{ width: 76 }}
              type="number"
              min="1"
              max="8"
              value={behavior.subagent_max}
              onChange={(e) =>
                saveBehavior({
                  ...behavior,
                  subagent_max: Math.max(1, Math.min(8, parseInt(e.target.value, 10) || 1)),
                })
              }
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm">{t("ai.autoCompact")}</p>
            <p className="text-xs text-neutral-500">{t("ai.autoCompactHint")}</p>
          </div>
          <PillSwitch
            checked={!!compact.auto}
            onChange={(v) => saveCompact({ auto: v })}
          />
        </div>

        {compact.auto && (
          <>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">{t("ai.compactChars")}</p>
                <p className="text-xs text-neutral-500">{t("ai.compactCharsHint")}</p>
              </div>
              <input
                className="field tabular-nums"
                style={{ width: 108 }}
                type="number"
                min="6000"
                max="200000"
                step="1000"
                value={compact.chars}
                onChange={(e) => saveCompact({ chars: Math.max(6000, Math.min(200000, parseInt(e.target.value, 10) || 24000)) })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">{t("ai.compactProvider")}</p>
                <p className="text-xs text-neutral-500">{t("ai.compactProviderHint")}</p>
              </div>
              <select
                className="field"
                style={{ width: 200 }}
                value={compact.provider}
                onChange={(e) => saveCompact({ provider: e.target.value })}
              >
                <option value="">{t("ai.compactProviderCurrent")}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* 提示词模板库：对话页输入框星标按钮一键插入；清空全部保存 = 恢复内置默认 */}
        <div className="flex flex-col gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm">{t("ai.promptTemplates")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">{t("ai.promptTemplatesHint")}</p>
            </div>
            <button
              className="pill pill-hover shrink-0 text-xs"
              onClick={() => setTemplates((l) => [...(l || []), { id: "", title: "", text: "" }])}
            >
              {t("ai.promptTemplatesAdd")}
            </button>
          </div>
          {(templates || []).map((tpl, i) => (
            <div
              key={i}
              className="flex flex-col gap-1.5 rounded-xl border border-neutral-200 bg-white px-2.5 py-2 dark:border-neutral-800 dark:bg-neutral-950"
            >
              <div className="flex items-center gap-2">
                <input
                  className="input flex-1 text-xs"
                  placeholder={t("ai.promptTemplatesTitlePh")}
                  value={tpl.title}
                  onChange={(e) =>
                    setTemplates((l) => (l || []).map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
                  }
                />
                <button
                  className="shrink-0 text-neutral-400 hover:text-red-500"
                  onClick={() => setTemplates((l) => (l || []).filter((_, j) => j !== i))}
                >
                  <IconTrash size={14} />
                </button>
              </div>
              <textarea
                className="input min-h-16 resize-y text-xs"
                rows={3}
                placeholder={t("ai.promptTemplatesTextPh")}
                value={tpl.text}
                onChange={(e) =>
                  setTemplates((l) => (l || []).map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                }
              />
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <span className={tplErr ? "text-xs text-red-500" : "text-xs text-neutral-500 dark:text-neutral-400"}>
              {tplErr || " "}
            </span>
            <button className="pill pill-hover shrink-0 text-xs" onClick={saveTemplates}>
              {tplSaved ? "✓" : t("common.save")}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm">{t("ai.compatMode")}</p>
            <p className="text-xs text-neutral-500">
              {t("ai.compatModeHint")}
            </p>
          </div>
          <PillSwitch
            checked={!!behavior.compat_mode}
            onChange={(v) => saveBehavior({ ...behavior, compat_mode: v })}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm">{t("ai.moderationTitle")}</p>
            <p className="text-xs text-neutral-500">{t("ai.moderationHint")}</p>
          </div>
          <PillSwitch
            checked={behavior.moderation_enabled}
            onChange={(v) => saveBehavior({ ...behavior, moderation_enabled: v })}
          />
        </div>

        <div className="flex flex-col gap-2 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-700 dark:text-neutral-300">{t("ai.moderationWordsTitle")}</p>
              <p className="text-xs text-neutral-500">
                {t("ai.moderationWordsHint")}
              </p>
            </div>
            {wordsSaved && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
                <IconCheck size={14} />
                {t("common.saved")}
              </span>
            )}
          </div>
          <textarea
            className="field rounded-[var(--look-ui-radius,1rem)] min-h-[130px] resize-y font-mono text-xs leading-relaxed disabled:cursor-not-allowed disabled:opacity-50"
            value={wordsText}
            onChange={(e) => {
              setWordsText(e.target.value);
              setWordsDirty(true);
            }}
            placeholder={t("ai.moderationPlaceholder")}
            disabled={!behavior.moderation_enabled}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
              {behavior.moderation_enabled
                ? wordsCustom
                  ? t("ai.moderationCustom", { n: wordsCount(wordsText) })
                  : t("ai.moderationDefault", { n: wordsCount(wordsText) })
                : t("ai.moderationOff")}
            </span>
            <div className="flex gap-2">
              {wordsCustom && (
                <button
                  className="pill text-xs disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!behavior.moderation_enabled}
                  onClick={() => saveWords([])}
                >
                  {t("ai.moderationReset")}
                </button>
              )}
              <button
                className="pill pill-hover text-xs disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!behavior.moderation_enabled || !wordsDirty}
                onClick={() => saveWords(wordsToList(wordsText))}
              >
                {t("ai.moderationSave")}
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm">{t("ai.approvalTitle")}</p>
            <p className="text-xs text-neutral-500">{t("ai.approvalHint")}</p>
          </div>
          <select
            className="field w-auto"
            value={behavior.tool_approval}
            onChange={(e) => saveBehavior({ ...behavior, tool_approval: e.target.value })}
          >
            <option value="ask">{t("ai.approvalAsk")}</option>
            <option value="auto">{t("ai.approvalAuto")}</option>
            <option value="allow_all">{t("ai.approvalAll")}</option>
          </select>
        </div>
      </div>

      {/* 待办时钟：对话页待办面板显示计划执行时间（localStorage 偏好，与工具开关解耦） */}
      <div className="card flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("settings.todoClock")}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{t("settings.todoClockHint")}</p>
        </div>
        <PillSwitch checked={todoClock} onChange={toggleTodoClock} />
      </div>

      {/* 语音输入：对话页输入框麦克风按钮（localStorage 偏好），下方展示离线识别模型状态 */}
      <div className="card flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("settings.voiceInput")}</p>
            <p className="mt-0.5 text-xs text-neutral-500">{t("settings.voiceInputHint")}</p>
          </div>
          <PillSwitch checked={voiceInput} onChange={toggleVoiceInput} />
        </div>
        {/* 识别模型多选一：sense-voice / zipformer / paraformer / whisper；未就绪的选中即下载 */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-neutral-500">{t("settings.voiceModel")}</p>
          <select
            className="field w-64 text-xs"
            value={voiceVariant}
            onChange={(e) => selectVoiceVariant(e.target.value)}
            disabled={voiceDownloading || voiceVariants.length === 0}
          >
            {voiceVariants.map((v) => (
              <option key={v.id} value={v.id}>
                {`${v.label} · ${(v.bytes / 1048576).toFixed(0)}MB${v.ready ? " · ✓" : ""}`}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center justify-between gap-3">
            <span className={voiceErr ? "text-red-500" : "text-neutral-500 dark:text-neutral-400"}>
              {voiceErr ||
                (voiceModel === null
                  ? "…"
                  : voiceModel.ready
                  ? t("voice.modelReady")
                  : voiceStarting || voiceModel.downloading
                  ? voiceModel.progress?.total
                    ? t("voice.downloading", {
                        p: Math.round((voiceModel.progress.done / voiceModel.progress.total) * 100),
                      })
                    : t("voice.downloadStart")
                  : t("voice.modelMissing"))}
            </span>
            {voiceModel &&
              !voiceModel.ready &&
              !voiceStarting &&
              !voiceModel.downloading && (
                <button className="pill pill-hover shrink-0 text-xs" onClick={startVoiceDownload}>
                  {t("voice.downloadBtn")}
                </button>
              )}
          </div>
          {/* 下载进度条：文字之外给个可见的比例条 */}
          {(voiceStarting || voiceModel?.downloading) && voiceModel?.progress?.total > 0 && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div
                className="h-full rounded-full bg-sky-500 transition-[width] duration-300"
                style={{
                  width: `${Math.min(100, Math.round((voiceModel.progress.done / voiceModel.progress.total) * 100))}%`,
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* 语音唤醒：关键词唤醒模型下载 + 开关 + 灵敏度；命中唤醒词自动开麦转写 */}
      {voiceModel?.kws && (
        <div className="card flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{t("voice.kwsTitle")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">{t("voice.kwsDesc")}</p>
            </div>
            {voiceModel.kws.ready ? (
              <PillSwitch
                checked={!!voiceModel.kws.enabled}
                onChange={(next) => {
                  api
                    .voiceKwsSet(next, kwsScore)
                    .then(() => {
                      refreshVoiceModel();
                      window.dispatchEvent(new Event("bit-kws-changed"));
                    })
                    .catch((e) => {
                      const emsg = typeof e === "string" ? e : e?.message || String(e);
                      setKwsErr(emsg ? `${emsg}` : t("voice.downloadFailed"));
                    });
                }}
              />
            ) : null}
          </div>
          {/* 模型未下载：显示体积 + 下载按钮 + 进度条；就绪后显示开关与灵敏度 */}
          {!voiceModel.kws.ready ? (
            <div className="flex flex-col gap-1.5 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-center justify-between gap-3">
                <span className={kwsErr ? "text-red-500" : "text-neutral-500 dark:text-neutral-400"}>
                  {kwsErr || t("voice.kwsModelMissing")}
                </span>
                <button className="pill pill-hover shrink-0 text-xs" onClick={startKwsDownload}>
                  {t("voice.kwsDownload")}
                </button>
              </div>
              {(kwsStarting || voiceModel.downloading) && (
                <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-sky-500 transition-[width] duration-300"
                    style={{
                      width: `${kwsProgressPct}%`,
                    }}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              <label className="flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
                <span className="shrink-0">{t("voice.kwsScore")}</span>
                <input
                  type="range"
                  min={0.8}
                  max={3}
                  step={0.1}
                  value={kwsScore}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setKwsScore(v);
                    // 拖动防抖 400ms 后提交（避免一路 invoke）
                    clearTimeout(kwsScoreTimer.current);
                    kwsScoreTimer.current = setTimeout(() => {
                      api
                        .voiceKwsSet(!!voiceModel.kws.enabled, v)
                        .then(() => refreshVoiceModel())
                        .catch(() => {});
                    }, 400);
                  }}
                  className="flex-1 accent-[var(--look-accent,#6366f1)]"
                />
                <span className="shrink-0 tabular-nums">{kwsScore.toFixed(1)}</span>
              </label>
              {/* 自定义唤醒词：每行「词 拼音」，后端转音素并校验模型词表，热重启生效 */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {t("voice.kwsWordsTitle")}
                    {voiceModel.kws.custom ? (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                        {t("voice.kwsCustomBadge")}
                      </span>
                    ) : null}
                  </span>
                  {voiceModel.kws.custom ? (
                    <button className="pill pill-hover shrink-0 text-xs" onClick={() => submitKwsWords([])}>
                      {t("voice.kwsWordsReset")}
                    </button>
                  ) : null}
                </div>
                <textarea
                  className="input min-h-16 resize-y font-mono text-xs"
                  rows={3}
                  value={kwsWordsText}
                  placeholder={t("voice.kwsWordsPlaceholder")}
                  onChange={(e) => setKwsWordsText(e.target.value)}
                />
                <div className="flex items-center justify-between gap-2">
                  <span className={kwsWordsErr ? "text-xs text-red-500" : "text-xs text-neutral-500 dark:text-neutral-400"}>
                    {kwsWordsErr || t("voice.kwsWordsHint")}
                  </span>
                  <button className="pill pill-hover shrink-0 text-xs" onClick={saveKwsWords}>
                    {t("voice.kwsWordsSave")}
                  </button>
                </div>
              </div>
              {/* 免手对话：转写完成自动发送，朗读结束回到待唤醒，朗读中说话可打断 */}
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="min-w-0">
                  <p className="text-xs text-neutral-600 dark:text-neutral-300">{t("voice.freehand")}</p>
                  <p className="mt-0.5 text-[11px] text-neutral-500">{t("voice.freehandHint")}</p>
                </div>
                <PillSwitch checked={freehand} onChange={toggleFreehand} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 语音合成：引擎选择（本地/在线）、模型下载、参数调节与试听 */}
      <TtsCard t={t} />

      {/* 系统提示词模板覆盖：完全替换内置 prompt；空=恢复默认 */}
      <div className="card flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t("ai.systemPromptTitle")}</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              {t("ai.systemPromptDesc")}
            </p>
          </div>
          {systemPromptSaved && (
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <IconCheck size={14} />
              {t("common.saved")}
            </span>
          )}
        </div>
        <textarea
          className="field rounded-[var(--look-ui-radius,1rem)] min-h-[200px] resize-y font-mono text-xs leading-relaxed"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={t("ai.systemPromptPlaceholder")}
        />
        <div className="flex justify-end gap-2">
          {systemPrompt && (
            <button
              className="pill text-xs"
              onClick={() => {
                setSystemPrompt("");
                api.setSystemPrompt("").then(() => {
                  setSystemPromptSaved(true);
                  setTimeout(() => setSystemPromptSaved(false), 1500);
                });
              }}
            >
              {t("ai.systemPromptReset")}
            </button>
          )}
          <button
            className="pill pill-hover text-xs"
            onClick={() => {
              api.setSystemPrompt(systemPrompt).then(() => {
                setSystemPromptSaved(true);
                setTimeout(() => setSystemPromptSaved(false), 1500);
              });
            }}
          >
            {t("common.save")}
          </button>
        </div>
      </div>

      {/* 本机操控三件套（实验性）：AI 可截屏看屏 / 控鼠标 / 打字按键 */}
      <div className="card flex flex-col gap-3">
        <div>
          <p className="text-sm font-medium">{t("ai.desktopToolsTitle")}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{t("ai.desktopToolsDesc")}</p>
        </div>
        {[
          ["screen", "ai.desktopScreen"],
          ["mouse", "ai.desktopMouse"],
          ["keyboard", "ai.desktopKeyboard"],
          ["diagram", "ai.desktopDiagram"],
          ["viewimage", "ai.desktopViewimage"],
        ].map(([key, label]) => (
          <div key={key} className="flex items-center justify-between">
            <p className="text-xs text-neutral-600 dark:text-neutral-400">{t(label)}</p>
            <PillSwitch
              checked={deskTools[key]}
              onChange={(v) => {
                const next = { ...deskTools, [key]: v };
                setDeskTools(next);
                api.setDesktopTools(next.screen, next.mouse, next.keyboard, next.diagram, next.viewimage).catch(() => {});
              }}
            />
          </div>
        ))}
      </div>

      {/* 写文件语法检查：写入/编辑 json、js、py 后自动体检，出错提醒模型与用户 */}
      <div className="card flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("ai.syntaxCheckTitle")}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{t("ai.syntaxCheckDesc")}</p>
        </div>
        <PillSwitch
          checked={syntaxCheck}
          onChange={(v) => {
            setSyntaxCheck(v);
            api.setSyntaxCheck(v).catch(() => {});
          }}
        />
      </div>

      {/* 用户自定义提示词/人设：追加到 system prompt 开头 */}
      <div className="card flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t("ai.customPromptTitle")}</p>
            <p className="mt-0.5 text-xs text-neutral-500">{t("ai.customPromptDesc")}</p>
          </div>
          {promptSaved && (
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <IconCheck size={14} />
              {t("common.saved")}
            </span>
          )}
        </div>
        <textarea
          className="field rounded-[var(--look-ui-radius,1rem)] min-h-[100px] resize-y font-mono text-xs leading-relaxed"
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder={t("ai.customPromptPlaceholder")}
        />
        <div className="flex justify-end gap-2">
          {customPrompt && (
            <button
              className="pill text-xs"
              onClick={() => {
                setCustomPrompt("");
                api.setCustomPrompt("").then(() => {
                  setPromptSaved(true);
                  setTimeout(() => setPromptSaved(false), 1500);
                });
              }}
            >
              {t("ai.customPromptClear")}
            </button>
          )}
          <button
            className="pill pill-hover text-xs"
            onClick={() => {
              api.setCustomPrompt(customPrompt).then(() => {
                setPromptSaved(true);
                setTimeout(() => setPromptSaved(false), 1500);
              });
            }}
          >
            {t("common.save")}
          </button>
        </div>
      </div>

      {/* 开机自动启动：登录系统后后台驻留（托盘），写入系统登录项 */}
      <div className="card flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("ai.autostartTitle")}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{t("ai.autostartDesc")}</p>
        </div>
        <PillSwitch
          checked={!!autostart}
          disabled={autostart === null}
          onChange={toggleAutostart}
        />
      </div>

      {/* 全局快捷键：唤出主界面（窗口隐藏/最小化时也能系统级唤出） */}
      <div className="card flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("ai.hotkeyTitle")}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{t("ai.hotkeyDesc")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            value={hotkey}
            onChange={(e) => setHotkey(e.target.value)}
            placeholder="Alt+Shift+B"
            className="field w-40 text-center font-mono text-xs"
          />
          {hotkey && (
            <button
              className="text-xs text-neutral-400 hover:text-red-500"
              title={t("ai.hotkeyClear")}
              onClick={() => {
                setHotkey("");
                api.setHotkey("").then(() => setHotkeySaved(true)).catch(() => {});
                setTimeout(() => setHotkeySaved(false), 1500);
              }}
            >
              {t("common.clear")}
            </button>
          )}
          <button
            className="pill pill-hover text-xs"
            onClick={() => {
              setHotkeyErr("");
              api.setHotkey(hotkey).then(() => {
                setHotkeySaved(true);
                setTimeout(() => setHotkeySaved(false), 1500);
              }).catch((e) => setHotkeyErr(String(e)));
            }}
          >
            {hotkeySaved ? "✓" : t("common.save")}
          </button>
        </div>
      </div>
      {hotkeyErr && <p className="-mt-2 text-xs text-red-500 dark:text-red-400">{hotkeyErr}</p>}

      {/* 截图提问：任意应用里框选截图，自动附到对话输入框（mac screencapture / win 截图快捷键 / linux grim 等） */}
      <div className="card flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("ai.hotkeyScreenshot")}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{t("ai.hotkeyScreenshotDesc")}</p>
          {appCaps && !appCaps.screenshot_supported && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("ai.hotkeyShotUnavailable")}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            value={shotHotkey}
            onChange={(e) => setShotHotkey(e.target.value)}
            placeholder="Control+Shift+A"
            className="field w-40 text-center font-mono text-xs"
          />
          {shotHotkey && (
            <button
              className="text-xs text-neutral-400 hover:text-red-500"
              title={t("ai.hotkeyClear")}
              onClick={() => saveAppHotkeys({ screenshot: "" })}
            >
              {t("common.clear")}
            </button>
          )}
          <button className="pill pill-hover text-xs" onClick={() => saveAppHotkeys({ screenshot: shotHotkey })}>
            {appHkSaved === "screenshot" ? "✓" : t("common.save")}
          </button>
        </div>
      </div>

      {/* 全局语音：其他应用里按键说话，转写后粘贴回原前台应用（mac osascript / win keybd_event / linux xdotool） */}
      <div className="card flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("ai.hotkeyVoice")}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{t("ai.hotkeyVoiceDesc")}</p>
          {appCaps && !appCaps.paste_supported && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("ai.hotkeyPasteUnavailable")}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            value={voiceHotkey}
            onChange={(e) => setVoiceHotkey(e.target.value)}
            placeholder="Control+Shift+V"
            className="field w-40 text-center font-mono text-xs"
          />
          {voiceHotkey && (
            <button
              className="text-xs text-neutral-400 hover:text-red-500"
              title={t("ai.hotkeyClear")}
              onClick={() => saveAppHotkeys({ voice: "" })}
            >
              {t("common.clear")}
            </button>
          )}
          <button className="pill pill-hover text-xs" onClick={() => saveAppHotkeys({ voice: voiceHotkey })}>
            {appHkSaved === "voice" ? "✓" : t("common.save")}
          </button>
        </div>
      </div>
      {appHkErr && <p className="-mt-2 text-xs text-red-500 dark:text-red-400">{appHkErr}</p>}

      {/* 新增 / 编辑表单：悬浮弹窗（点遮罩关闭），平时不占页面空间 */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            setForm(EMPTY);
            setShowForm(false);
          }}
        >
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card flex max-h-[85vh] w-full max-w-lg flex-col gap-4 overflow-y-auto shadow-[inset_0_2px_14px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_2px_14px_rgba(0,0,0,0.45)]">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{editing ? t("ai.editProvider") : t("ai.addProvider")}</p>
          <button
            type="button"
            onClick={() => {
              setForm(EMPTY);
              setShowForm(false);
            }}
            className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
          >
            <IconX size={13} />
            {editing ? t("ai.cancelEdit") : t("common.close")}
          </button>
        </div>

        {/* 主流模型预设：点选一键填充 */}
        <div>
          <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.preset")}</label>
          <div className="flex flex-wrap gap-1.5 px-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => pickPreset(preset)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-200 ${
                  form.model === preset.model && form.base_url === preset.base
                    ? "accent-solid"
                    : "border-neutral-200 text-neutral-500 hover:border-neutral-400 hover:text-neutral-900 dark:border-neutral-700 dark:hover:border-neutral-500 dark:hover:text-white"
                }`}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.protocol")}</label>
          <div className="flex gap-2">
            {PROTOCOLS.map((proto) => (
              <button
                key={proto.id}
                type="button"
                onClick={() => pickProtocol(proto.id)}
                className={`flex-1 rounded-full px-3 py-2 text-xs font-medium transition-colors duration-200 ${
                  form.protocol === proto.id
                    ? "accent-solid"
                    : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                }`}
              >
                {proto.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.nameLabel")}</label>
          <input
            className="field"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={`${t("ai.nameExample")}${protoLabel(form.protocol)}`}
          />
        </div>

        <div>
          <label className="mb-1 block px-2 text-xs text-neutral-500">Base URL</label>
          <input
            className="field font-mono"
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            placeholder={PROTOCOLS.find((p) => p.id === form.protocol)?.base}
          />
        </div>

        <div>
          <label className="mb-1 block px-2 text-xs text-neutral-500">API Key</label>
          <input
            className="field font-mono"
            type="password"
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            placeholder={form.protocol === "openai" ? "sk-…" : t("ai.keyPlaceholder")}
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <label className="text-xs text-neutral-500">{t("ai.model")}</label>
            <button
              type="button"
              onClick={fetchModels}
              disabled={fetchingModels || !form.base_url.trim()}
              className="text-xs text-neutral-500 transition-colors hover:text-neutral-900 disabled:opacity-40 dark:hover:text-white"
              title={t("ai.fetchModelsTip")}
            >
              {fetchingModels ? t("ai.fetchingModels") : t("ai.fetchModels")}
            </button>
          </div>
          <input
            className="field font-mono"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            placeholder={PROTOCOLS.find((p) => p.id === form.protocol)?.model}
          />
          {fetchModelsErr && (
            <p className="mt-1 px-2 text-[11px] text-red-600">{fetchModelsErr}</p>
          )}
          {baseHint && !fetchModelsErr && (
            <p className="mt-1 px-2 text-[11px] text-emerald-600 dark:text-emerald-400">{baseHint}</p>
          )}
          {Array.isArray(remoteModels) && remoteModels.length > 0 && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-2xl border border-neutral-200/80 dark:border-neutral-800">
              {remoteModels.map((m) => {
                const id = typeof m === "string" ? m : m.id;
                const len = typeof m === "object" && m ? m.context_length : null;
                const lenLabel = len ? ` · ${len >= 1024 ? `${Math.round(len / 1024)}K` : len} ctx` : "";
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, model: id }))}
                    className={`block w-full px-3 py-1.5 text-left font-mono text-[11px] transition-colors duration-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                      form.model === id ? "text-neutral-900 dark:text-white" : "text-neutral-500"
                    }`}
                  >
                    {id}
                    {lenLabel && <span className="float-right text-neutral-400">{lenLabel}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {Array.isArray(remoteModels) && remoteModels.length === 0 && (
            <p className="mt-1 px-2 text-[11px] text-neutral-400">{t("ai.noModels")}</p>
          )}
        </div>

        {error && <p className="px-2 text-xs text-red-600">{error}</p>}
        <div className="flex items-center justify-end gap-3">
          {saved && (
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <IconCheck size={14} />
              {t("common.saved")}
            </span>
          )}
          <button type="submit" className="pill pill-hover">
            {editing ? <IconCheck size={14} /> : <IconPlus size={14} />}
            {editing ? t("ai.saveChanges") : t("common.add")}
          </button>
        </div>
      </form>
        </div>
      )}

      {/* AI 自主能力说明 */}
      <div className="card text-xs leading-relaxed text-neutral-500">
        <p className="mb-2 font-medium text-neutral-900 dark:text-neutral-100">{t("ai.autonomyTitle")}</p>
        <ul className="list-inside list-disc space-y-1">
          <li>{t("ai.capTools")}</li>
          <li>{t("ai.capPlan")}</li>
          <li>{t("ai.capScript")}</li>
          <li>{t("ai.capSkill")}</li>
          <li>{t("ai.capInvoke")}</li>
        </ul>
        <p className="mt-3 border-t border-neutral-200/70 pt-2 text-neutral-500 dark:border-neutral-800/70">
          {t("ai.memoryNote1")}
          <b className="text-neutral-700 dark:text-neutral-300">{t("ai.memoryNote2")}</b>
          {t("ai.memoryNote3")}
        </p>
      </div>
    </div>
  );
}
