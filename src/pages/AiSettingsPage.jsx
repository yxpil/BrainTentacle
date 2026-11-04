import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api.js";
import { previewCompletion } from "../sound.js";
import { useLang } from "../i18n.js";
import { ttsVolumePct, setTtsVolumePct, applyTtsVolume } from "../ttsVolume.js";
import { DEFAULT_TPL_HOTKEY, readTplHotkey, saveTplHotkey, parseTplHotkey } from "../templateHotkey.js";
import { useAutoSpeak } from "../automationStore.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import PillSwitch from "../components/PillSwitch.jsx";
import HotkeyField from "../components/HotkeyField.jsx";
import {
  IconPlus,
  IconTrash,
  IconSettings,
  IconCheck,
  IconX,
} from "../components/Icons.jsx";

// 支持的协议：原生对接各家 API
const PROTOCOLS = [
  {
    id: "openai",
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    model: "gpt-6.1-terra",
  },
  {
    id: "gemini",
    label: "Gemini",
    base: "https://generativelanguage.googleapis.com",
    model: "gemini-3.8-flash",
  },
  {
    id: "claude",
    label: "Claude",
    base: "https://api.anthropic.com",
    model: "claude-sonnet-5-5",
  },
];
const protoLabel = (id) => PROTOCOLS.find((p) => p.id === id)?.label || id;

// 主流模型预设：点选自动填充协议 / Base URL / 模型名（各家 2026-10 公开文档确认的最新旗舰，也可点「从 API 获取」拉全量列表）
const PRESETS = [
  {
    name: "OpenAI GPT-6.1",
    protocol: "openai",
    base: "https://api.openai.com/v1",
    model: "gpt-6.1-terra",
  },
  {
    name: "DeepSeek V4.1 Flash",
    protocol: "openai",
    base: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
  },
  {
    name: "Kimi K3.1 Pro",
    protocol: "openai",
    base: "https://api.moonshot.cn/v1",
    model: "kimi-k3-1-pro",
  },
  {
    name: "Qwen 3.8 Max",
    protocol: "openai",
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
  },
  {
    name: "Zhipu GLM",
    protocol: "openai",
    base: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.2",
  },
  {
    name: "xAI Grok 4.7",
    protocol: "openai",
    base: "https://api.x.ai/v1",
    model: "grok-4.7",
  },
  {
    name: "OpenRouter",
    protocol: "openai",
    base: "https://openrouter.ai/api/v1",
    model: "openrouter/auto",
  },
  {
    name: "SiliconFlow",
    protocol: "openai",
    base: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
  },
  {
    name: "Ollama (local)",
    protocol: "openai",
    base: "http://127.0.0.1:11434/v1",
    model: "qwen3",
  },
  {
    name: "Google Gemini 3.8 Flash",
    protocol: "gemini",
    base: "https://generativelanguage.googleapis.com",
    model: "gemini-3.8-flash",
  },
  {
    name: "Claude Sonnet 5.5",
    protocol: "claude",
    base: "https://api.anthropic.com",
    model: "claude-sonnet-5-5",
  },
  {
    name: "Claude Opus 5.5",
    protocol: "claude",
    base: "https://api.anthropic.com",
    model: "claude-opus-5-5",
  },
];

const EMPTY = {
  id: null,
  name: "",
  protocol: "openai",
  base_url: "",
  api_key: "",
  model: "",
};

// ── 语音合成（TTS）：本地 sherpa 系 8 个引擎 + 在线 4 家 ──
// group 决定 optgroup 分组；meta/langKey 仅本地引擎展示体积与语种；needsKey 的在线引擎显示 API key 输入框
const TTS_ENGINES = [
  {
    id: "supertonic",
    group: "local",
    nameKey: "settings.ttsEngineSupertonic",
    meta: "129MB",
    langKey: "settings.ttsLangMulti",
  },
  {
    id: "kitten",
    group: "local",
    nameKey: "settings.ttsEngineKitten",
    meta: "31MB",
    langKey: "settings.ttsLangEn",
  },
  {
    id: "matcha",
    group: "local",
    nameKey: "settings.ttsEngineMatcha",
    meta: "75MB",
    langKey: "settings.ttsLangZh",
  },
  {
    id: "zipvoice",
    group: "local",
    nameKey: "settings.ttsEngineZipvoice",
    meta: "109MB",
    langKey: "settings.ttsLangZhEn",
  },
  {
    id: "pocket",
    group: "local",
    nameKey: "settings.ttsEnginePocket",
    meta: "98MB",
    langKey: "settings.ttsLangEn",
  },
  {
    id: "kokoro",
    group: "local",
    nameKey: "settings.ttsEngineKokoro",
    meta: "103MB",
    langKey: "settings.ttsLangEn",
  },
  {
    id: "piper-zh",
    group: "local",
    nameKey: "settings.ttsEnginePiperHuayan",
    meta: "67MB",
    langKey: "settings.ttsLangZh",
  },
  {
    id: "piper-en",
    group: "local",
    nameKey: "settings.ttsEnginePiperAmy",
    meta: "67MB",
    langKey: "settings.ttsLangEn",
  },
  {
    id: "edge",
    group: "online",
    nameKey: "settings.ttsEngineEdge",
    badgeKey: "settings.ttsFreeKey",
  },
  {
    id: "gtts",
    group: "online",
    nameKey: "settings.ttsEngineGtts",
    badgeKey: "settings.ttsFreeKey",
  },
  {
    id: "siliconflow",
    group: "online",
    nameKey: "settings.ttsEngineSiliconflow",
    badgeKey: "settings.ttsNeedKey",
    needsKey: true,
  },
  {
    id: "openai",
    group: "online",
    nameKey: "settings.ttsEngineOpenai",
    badgeKey: "settings.ttsNeedKey",
    needsKey: true,
  },
];

// 在线引擎的内置固定音色表（EdgeTTS 走后端拉取的 322 音色，不在其中）
const TTS_BUILTIN_VOICES = {
  siliconflow: [
    "alex",
    "anna",
    "bella",
    "benjamin",
    "charles",
    "claire",
    "david",
    "diana",
  ],
  openai: ["alloy", "echo", "fable", "nova", "onyx", "shimmer"],
};

const TTS_PARAM_DEFAULT = { voice: "", speed: 1, pitch: 0 };

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
    const value =
      typeof v === "string" ? v : (v.value ?? v.shortName ?? v.name ?? v.id);
    if (!value) return;
    const label =
      typeof v === "string"
        ? v
        : (v.label ?? v.friendly ?? v.shortName ?? v.name ?? value);
    const locale =
      typeof v === "object" ? (v.locale ?? v.lang ?? v.language ?? "") : "";
    const loc =
      locale ||
      (/^[a-z]{2,3}-[A-Za-z]{2,4}/.test(value)
        ? value.split("-").slice(0, 2).join("-")
        : "other");
    entries.push({
      value: String(value),
      label: String(label),
      locale: String(loc),
    });
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (Array.isArray(raw?.groups))
    raw.groups.forEach((g) => (g.voices || g.items || []).forEach(push));
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
  const [params, setParams] = useState({}); // engine -> {voice,speed,pitch}
  // 音量是全局播放增益（跨引擎、跨会话），不随引擎切换而各存一份
  const [volume, setVolume] = useState(ttsVolumePct);
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
      if (e.langKey === "settings.ttsLangZhEn")
        return `${t("settings.ttsExampleZh")} ${t("settings.ttsExampleEn")}`;
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
          if (
            typeof s?.engine === "string" &&
            TTS_ENGINES.some((e) => e.id === s.engine)
          ) {
            setEngine(s.engine);
            localStorage.setItem("bit.ttsEngine", s.engine);
            // 示例文案未被用户改动时，跟着后端配置的引擎切换语种
            const next = sampleFor(s.engine);
            setText((cur) =>
              cur === "" || cur === prevSampleRef.current ? next : cur,
            );
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
      if (payload.downloading === false || payload.ready || payload.finished)
        refreshTts();
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

  const downloading = !!(
    st?.downloading ||
    (status?.downloading && status?.progress)
  );
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
    [],
  );

  const p = params[engine] || TTS_PARAM_DEFAULT;
  const setP = (patch) =>
    setParams((all) => ({
      ...all,
      [engine]: { ...(all[engine] || TTS_PARAM_DEFAULT), ...patch },
    }));

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
    extras[`${engine}:${tb.key}`] ??
    tb.default ??
    tb.def ??
    tb.value ??
    (tb.type === "select" || tb.type === "text" ? "" : (tb.min ?? 0));
  const setExtra = (key, val) =>
    setExtras((x) => ({ ...x, [`${engine}:${key}`]: val }));

  const speakErrText = (raw) => {
    const m = String(raw || "");
    if (/key|密钥|unauthorized|401/i.test(m))
      return t("settings.ttsKeyMissing", { name: t(cfg.nameKey) });
    if (/network|超时|timeout|connect|ENOTFOUND|fetch|socket/i.test(m))
      return t("settings.ttsNetworkError");
    if (/中文|Chinese|不支持该语言|unsupported language/i.test(m))
      return t("settings.ttsLangUnsupported");
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
      // 合成端固定满音量：音量统一由播放增益负责，否则 edge 会被衰减两次
      volume: 1,
      extra: tunables.length ? extra : undefined,
    };
    setBusy(true);
    try {
      const r = await api.ttsSpeak(say, opts);
      const b64 = r?.audioBase64 || r?.audio_base64;
      if (!b64) throw new Error(t("settings.ttsEmptyAudio"));
      const fmt = String(r?.format || "");
      const mime = /wav/i.test(fmt)
        ? "audio/wav"
        : /ogg/i.test(fmt)
          ? "audio/ogg"
          : "audio/mpeg";
      const url = URL.createObjectURL(
        new Blob([ttsBase64Bytes(b64)], { type: mime }),
      );
      urlRef.current = url;
      const a = new Audio(url);
      applyTtsVolume(a);
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
    voiceGroups = [
      {
        locale: "",
        items: TTS_BUILTIN_VOICES[engine].map((v) => ({ value: v, label: v })),
      },
    ];
  } else if (isLocal) {
    const local = ttsVoiceGroups(st?.voices);
    voiceGroups = local.length
      ? local
      : [
          {
            locale: "",
            items: [{ value: "", label: t("settings.ttsVoiceDefault") }],
          },
        ];
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
          <label className="mb-1 block px-2 text-xs text-neutral-500">
            {label}
          </label>
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
          {fileHint && (
            <p className="mt-1 px-2 text-[11px] text-amber-600 dark:text-amber-400">
              {fileHint}
            </p>
          )}
        </div>
      );
    }
    if (tb.type === "select") {
      const opts = (tb.options || tb.values || []).map((o) =>
        typeof o === "object"
          ? {
              value: o.value ?? o.id ?? o,
              label: o.label ?? o.name ?? String(o.value ?? o.id ?? o),
            }
          : { value: o, label: String(o) },
      );
      return (
        <div key={key}>
          <label className="mb-1 block px-2 text-xs text-neutral-500">
            {label}
          </label>
          <select
            className="field"
            value={value}
            onChange={(e) => setExtra(key, e.target.value)}
          >
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
          <label className="mb-1 block px-2 text-xs text-neutral-500">
            {label}
          </label>
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
          <p className="mt-0.5 text-xs text-neutral-500">
            {t("settings.ttsHint")}
          </p>
        </div>
        {keySaved && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
            <IconCheck size={14} />
            {t("settings.ttsKeySaved")}
          </span>
        )}
      </div>

      {/* 引擎：本地 / 在线 两组 */}
      <select
        className="field"
        value={engine}
        onChange={(e) => changeEngine(e.target.value)}
      >
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
          <span
            className={
              err && !st?.ready
                ? "text-red-500"
                : "text-neutral-500 dark:text-neutral-400"
            }
          >
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
            <button
              className="pill pill-hover shrink-0 text-xs"
              onClick={startDownload}
            >
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
              ? t("settings.ttsCliReady", {
                  v: status.cli.version,
                  p: status.cli.platform,
                })
              : t("settings.ttsCliMissing", {
                  mb: Math.round((status.cli.bytes || 0) / 1048576),
                })
            : t("settings.ttsCliUnsupported", { p: status.cli.platform })}
        </div>
      )}

      {/* SiliconFlow / OpenAI 需 API key */}
      {cfg.needsKey && (
        <div className="flex flex-col gap-2 rounded-2xl border border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div className="flex items-center justify-between">
            <label className="text-xs text-neutral-500">
              {t("settings.ttsApiKey")}
            </label>
            {status?.keys?.[engine] && (
              <span className="chip shrink-0">
                {t("settings.ttsKeyConfigured")}
              </span>
            )}
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
          <label className="mb-1 block px-2 text-xs text-neutral-500">
            {t("settings.ttsVoice")}
          </label>
          <select
            className="field"
            value={p.voice}
            onChange={(e) => setP({ voice: e.target.value })}
          >
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
          <label className="mb-1 block px-2 text-xs text-neutral-500">
            {t("settings.ttsVoice")}
          </label>
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
            <label className="text-xs text-neutral-500">
              {t("settings.ttsSpeed")}
            </label>
            <span className="text-xs tabular-nums">
              {Number(p.speed).toFixed(1)}×
            </span>
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

      {/* 音调：仅 EdgeTTS（SSML 支持，其余引擎无此入参） */}
      {engine === "edge" && (
        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <label className="text-xs text-neutral-500">
              {t("settings.ttsPitch")}
            </label>
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
      {/* 音量：全局播放增益，所有引擎（含本地内核）都吃这个值 */}
      <div>
        <div className="mb-1 flex items-center justify-between px-2">
          <label className="text-xs text-neutral-500" title={t("settings.ttsVolumeHint")}>
            {t("settings.ttsVolume")}
          </label>
          <span className="text-xs tabular-nums">{`${volume}%`}</span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={volume}
          onChange={(e) => setVolume(setTtsVolumePct(e.target.value))}
          className="w-full accent-[var(--accent)]"
        />
      </div>

      {/* 引擎专属参数（assets.json tunables 模板渲染；缺字段即不渲染） */}
      {tunables.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70">
          <p className="text-xs font-medium text-neutral-500">
            {t("settings.ttsEngineParams")}
          </p>
          {tunables.map((tb) => renderTunable(tb))}
        </div>
      )}

      {/* 试听 */}
      <div className="flex flex-col gap-2 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70">
        <label className="block px-2 text-xs text-neutral-500">
          {t("settings.ttsPreviewText")}
        </label>
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
            {playing
              ? t("settings.ttsStop")
              : busy
                ? t("settings.ttsSynthesizing")
                : t("settings.ttsPreview")}
          </button>
          {playing && (
            <span className="text-[11px] text-neutral-500">
              {t("settings.ttsPlaying")}
            </span>
          )}
          <span className="ml-auto text-[11px] text-neutral-400">
            {t("settings.ttsPreviewHint")}
          </span>
        </div>
        {err && (
          <p className="px-2 text-xs text-red-500 dark:text-red-400">{err}</p>
        )}
      </div>
    </div>
  );
}

// 自动朗读回复：值一直在 automationStore（localStorage bit.autoSpeak），
// 页眉喇叭按钮也读同一个 store，所以两处任意一边切换另一边即时跟随。
function AutoSpeakCard({ t }) {
  const [on, setOn] = useAutoSpeak();
  return (
    <div className="card flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{t("chat.autoSpeak")}</p>
        <p className="mt-0.5 text-xs text-neutral-500">
          {t("settings.autoSpeakHint")}
        </p>
      </div>
      <PillSwitch checked={on} onChange={setOn} />
    </div>
  );
}

// 上下文上限：模型 API 没上报 max_context 时的回退值。
// 对话页状态条也能直接改，两边共用 localStorage bit.ctxLimitK，
// 改动时广播 bit-ctx-limit，已挂载的对话页无需重开即可生效。
function ContextLimitCard({ t }) {
  const read = () => {
    const v = parseInt(localStorage.getItem("bit.ctxLimitK"), 10);
    return Number.isFinite(v) && v >= 4 && v <= 2000 ? v : 128;
  };
  const [value, setValue] = useState(read);
  const [draft, setDraft] = useState(() => String(read()));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const sync = () => {
      const v = read();
      setValue(v);
      setDraft(String(v));
    };
    window.addEventListener("bit-ctx-limit", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("bit-ctx-limit", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const save = () => {
    const v = Math.max(4, Math.min(2000, parseInt(draft, 10) || 128));
    setDraft(String(v));
    if (v === value) return;
    setValue(v);
    try {
      localStorage.setItem("bit.ctxLimitK", String(v));
    } catch {
      /* 存储被禁时仅本次会话生效 */
    }
    window.dispatchEvent(new Event("bit-ctx-limit"));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("ai.ctxLimitTitle")}</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {t("ai.ctxLimitHint")}
          </p>
        </div>
        {saved && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
            <IconCheck size={14} />
            {t("common.saved")}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-neutral-500">{t("ai.ctxLimitLabel")}</span>
        <div className="flex shrink-0 items-center gap-2">
          <input
            type="number"
            min="4"
            max="2000"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            onBlur={save}
            className="field w-24 text-right font-mono tabular-nums"
          />
          <span className="text-xs text-neutral-500">K</span>
        </div>
      </div>
    </div>
  );
}

// AI 设置：可增删的多家提供方，用播放/暂停切换，每次仅一个激活
// group = 设置中心左栏当前卡片对应的组；其余组只藏不卸载（提供方表单、模型列表拉取都不该因为换张卡就丢）
export default function AiSettingsPage({ onStats, stats, group }) {
  const show = (id) => !group || group === id;
  const gstyle = (id) => (show(id) ? undefined : { display: "none" });
  const { t } = useLang();
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState(EMPTY); // 新增 / 编辑用同一张表单
  const [showForm, setShowForm] = useState(false); // 表单以悬浮弹窗呈现，平时不占页面空间
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // 模型采样参数：temperature null=默认；reasoning_effort ""=默认 / low / medium / high
  const [params, setParams] = useState({
    temperature: null,
    reasoning_effort: "",
  });
  const [paramsSaved, setParamsSaved] = useState(false);
  // 幻觉防护阈值：word_repeat_max=单回复词重复上限 / tool_loop_max=单回合工具轮上限（0=关闭）
  const [limits, setLimits] = useState({
    word_repeat_max: 20,
    tool_loop_max: 20,
  });
  const [limitsSaved, setLimitsSaved] = useState(false);
  const [toolEnv, setToolEnv] = useState({
    tool_timeout_secs: 120,
    default_shell: "",
    available_shells: [],
  });
  const [toolEnvSaved, setToolEnvSaved] = useState(false);
  // 托管服务生命周期：值与允许区间都由核心回，前端不抄一份数字（抄了就会和核心对不上）
  const [svcTuning, setSvcTuning] = useState({
    start_delay_ms: 300,
    ready_secs: 60,
    retries: 2,
    stop_grace_secs: 5,
    log_lines: 1000,
    ranges: [],
  });
  const [svcSaved, setSvcSaved] = useState(false);
  // 出网代理：改动不自动保存——地址打到一半就提交必然过不了校验，用「保存」显式落库
  const [proxy, setProxy] = useState({
    mode: "system",
    url_input: "",
    user: "",
    pass: "",
    bypass_input: "",
    effective_url: "",
    url_from: "",
    bypass: [],
    env: [],
    webview: null,
    export_env: true,
    fail_open: false,
    ca_input: "",
    ca_saved: "",
    insecure: false,
    ca_certs: 0,
    ca_error: false,
    system: { url: "", from: "", pac: "" },
  });
  const [proxySaved, setProxySaved] = useState(false);
  const [proxyErr, setProxyErr] = useState("");
  const [proxyTest, setProxyTest] = useState(null);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyPeers, setProxyPeers] = useState(null); // 本机代理探测结果
  // AI 行为设置：自动推进 / 审批模式 / 敏感词审核 / 兼容模式
  const [behavior, setBehavior] = useState({
    auto_drive: true,
    auto_delegate: false,
    subagent_max: 3,
    tool_approval: "ask",
    moderation_enabled: true,
    compat_mode: false,
  });
  // 工具按需加载：默认开——只常驻 skill 的 schema，其余工具由 AI 现场调取（省每轮的 schema token）
  const [lazyTools, setLazyTools] = useState(true);
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
  // 阻止系统休眠：仅在 Electron 宿主提供 powerSaveBlocker；null=加载中，active=系统是否真的被挡住
  const sleepGuardSupported = !!window.__BIT_ELECTRON__;
  const [preventSleep, setPreventSleep] = useState(null);
  const [sleepBlockActive, setSleepBlockActive] = useState(false);
  // 托盘悬浮预览延迟（毫秒，0=关闭）：null=加载中。托盘建不起来时 supported 为假，整卡不出现
  const [trayHover, setTrayHover] = useState(null);
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
  // 收藏当前输入为模板的快捷键（localStorage bit.tplHotkey，默认 Ctrl+A+S）
  const [tplHotkey, setTplHotkey] = useState(() => readTplHotkey().spec);
  const [tplHotkeyErr, setTplHotkeyErr] = useState("");
  // 输入框失焦 / 回车时提交：认不出的写法只提示，不写盘（旧值继续生效）
  const commitTplHotkey = (raw) => {
    const spec = String(raw || "").trim();
    setTplHotkey(raw);
    if (!spec) {
      saveTplHotkey("");
      setTplHotkey(DEFAULT_TPL_HOTKEY);
      setTplHotkeyErr("");
      return;
    }
    if (!parseTplHotkey(spec)) {
      setTplHotkeyErr(t("ai.tplHotkeyBad"));
      return;
    }
    saveTplHotkey(spec);
    setTplHotkeyErr("");
  };
  // 从提供方 API 拉取的模型列表（点击模型名直接填充）
  const [remoteModels, setRemoteModels] = useState(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsErr, setFetchModelsErr] = useState("");
  const [baseHint, setBaseHint] = useState("");
  // 本机操控开关（screen/mouse/keyboard/draw_diagram/view_image，默认全关）
  const [deskTools, setDeskTools] = useState({
    screen: false,
    mouse: false,
    keyboard: false,
    diagram: false,
    viewimage: false,
  });
  // 写文件后轻量语法检查（json/js/py）：出错提醒模型与用户
  const [syntaxCheck, setSyntaxCheck] = useState(true);
  // 上下文自动压缩：会话超阈值把旧历史压成摘要再发模型（可选便宜模型压缩，数据库原文不动）
  const [compact, setCompact] = useState({
    auto: false,
    chars: 24000,
    provider: "",
  });
  // 待办时钟（对话页待办面板显示计划时间）：纯 UI 偏好，localStorage 持久化，默认开
  const [todoClock, setTodoClock] = useState(
    () => localStorage.getItem("bit.todoClock") !== "0",
  );
  const toggleTodoClock = () =>
    setTodoClock((v) => {
      const next = !v;
      localStorage.setItem("bit.todoClock", next ? "1" : "0");
      // 同窗口渲染：广播给对话页即时同步（跨窗口由 storage 事件兜底）
      window.dispatchEvent(new CustomEvent("bit-todo-clock"));
      return next;
    });
  // 语音输入开关（对话页输入框麦克风按钮）：localStorage bit.voiceInput，默认开
  const [voiceInput, setVoiceInput] = useState(
    () => localStorage.getItem("bit.voiceInput") !== "0",
  );
  const toggleVoiceInput = () =>
    setVoiceInput((v) => {
      const next = !v;
      localStorage.setItem("bit.voiceInput", next ? "1" : "0");
      // 同窗口广播给对话页即时同步（跨窗口由 storage 事件兜底）
      window.dispatchEvent(new CustomEvent("bit-voice-input"));
      return next;
    });
  // 免手对话：语音唤醒转写完成后自动发送，朗读结束回到待唤醒（localStorage bit.freehand，默认关）
  const [freehand, setFreehand] = useState(
    () => localStorage.getItem("bit.freehand") === "1",
  );
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
        setVoiceModel({
          ready,
          downloading: dl,
          progress: s?.progress || null,
          kws: s?.kws || null,
        });
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
      .catch(() =>
        setVoiceModel({
          ready: false,
          downloading: false,
          progress: null,
          kws: null,
        }),
      );
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
        setVoiceModel((m) => ({
          ...(m || { ready: false, downloading: false }),
          ready: false,
        }));
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
      .catch((e) =>
        setKwsWordsErr(typeof e === "string" ? e : e?.message || String(e)),
      );
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
    if (voiceModel?.kws?.score)
      setKwsScore(Number(voiceModel.kws.score) || 1.5);
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
    ? Math.min(
        100,
        Math.round(
          (voiceModel.progress.done / voiceModel.progress.total) * 100,
        ),
      )
    : 8;

  const load = () =>
    api
      .listProviders()
      .then((r) => setProviders(r.providers || []))
      .catch(() => {});
  useEffect(() => {
    load();
    api
      .getAiParams()
      .then((r) =>
        setParams({
          temperature: r?.temperature ?? null,
          reasoning_effort: r?.reasoning_effort || "",
        }),
      )
      .catch(() => {});
    api
      .getGuardLimits()
      .then((r) =>
        setLimits({
          word_repeat_max: r?.word_repeat_max ?? 20,
          tool_loop_max: r?.tool_loop_max ?? 20,
        }),
      )
      .catch(() => {});
    api
      .getToolEnvSettings()
      .then((r) =>
        setToolEnv({
          tool_timeout_secs: r?.tool_timeout_secs ?? 120,
          default_shell: r?.default_shell || "",
          available_shells: r?.available_shells || [],
        }),
      )
      .catch(() => {});
    api
      .getServiceTuning()
      .then((r) =>
        setSvcTuning((prev) => ({
          ...prev,
          start_delay_ms: r?.start_delay_ms ?? prev.start_delay_ms,
          ready_secs: r?.ready_secs ?? prev.ready_secs,
          retries: r?.retries ?? prev.retries,
          stop_grace_secs: r?.stop_grace_secs ?? prev.stop_grace_secs,
          log_lines: r?.log_lines ?? prev.log_lines,
          ranges: r?.ranges || prev.ranges,
        })),
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
    api
      .getToolLoading()
      .then((r) => setLazyTools(r?.lazy_tools ?? true))
      .catch(() => {});
    refreshProxy();
    api
      .getCustomPrompt()
      .then((r) => setCustomPrompt(r?.custom_prompt || ""))
      .catch(() => {});
    api
      .getSystemPrompt()
      .then((r) => setSystemPrompt(r?.system_prompt || ""))
      .catch(() => {});
    api
      .compactConfigGet()
      .then((r) =>
        setCompact({
          auto: !!r?.auto,
          chars: Number(r?.chars) || 24000,
          provider: r?.provider || "",
        }),
      )
      .catch(() => {});
    api
      .getAutostart()
      .then((r) => setAutostart(!!r?.enabled))
      .catch(() => setAutostart(false));
    if (sleepGuardSupported) {
      api
        .getPreventSleep()
        .then((r) => {
          setPreventSleep(!!r?.enabled);
          setSleepBlockActive(!!r?.active);
        })
        .catch(() => setPreventSleep(false));
      api
        .getTrayHover()
        .then((r) => setTrayHover(r && r.supported ? r : null))
        .catch(() => setTrayHover(null));
    }
    api
      .getNotifySound()
      .then((r) => setNotify(r || null))
      .catch(() => setNotify(null));
    api
      .getHotkey()
      .then((r) => setHotkey(r?.hotkey || ""))
      .catch(() => {});
    api
      .getAppHotkeys()
      .then((r) => {
        setShotHotkey(r?.screenshot || "");
        setVoiceHotkey(r?.voice || "");
        setAppCaps(r?.caps || null);
      })
      .catch(() => {});
    api
      .promptTemplatesGet()
      .then((r) => setTemplates(r?.templates || []))
      .catch(() => setTemplates([]));
    api
      .getDesktopTools()
      .then((r) =>
        setDeskTools({
          screen: !!r?.screen,
          mouse: !!r?.mouse,
          keyboard: !!r?.keyboard,
          diagram: !!r?.diagram,
          viewimage: !!r?.viewimage,
        }),
      )
      .catch(() => {});
  }, []);

  // 切到「行为」卡片时重读自动执行/委派：页眉弹层和自动化页可能刚改过，别显示旧值
  useEffect(() => {
    if (group !== "ai-behavior") return;
    api
      .getBehaviorSettings()
      .then((r) =>
        setBehavior((b) => ({
          ...b,
          auto_drive: r?.auto_drive ?? b.auto_drive,
          auto_delegate: r?.auto_delegate ?? b.auto_delegate,
          subagent_max: r?.subagent_max ?? b.subagent_max,
        })),
      )
      .catch(() => {});
  }, [group]);

  // 自动压缩配置：任何变更即时保存（开关/阈值/压缩模型）
  const saveCompact = (patch) => {
    const next = { ...compact, ...patch };
    setCompact(next);
    api
      .compactConfigSet(next.auto, Number(next.chars) || 24000, next.provider)
      .catch(() => {});
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
      .catch((e) =>
        setTplErr(typeof e === "string" ? e : e?.message || String(e)),
      );
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
        // 注册失败的键已被宿主退回旧值，输入框跟着回退，别留一个按不动的组合
        if (r?.failed) {
          setShotHotkey(r.screenshot || "");
          setVoiceHotkey(r.voice || "");
          setAppHkErr(t("ai.hotkeyTaken"));
          return;
        }
        setAppHkSaved(patch.screenshot !== undefined ? "screenshot" : "voice");
        setTimeout(() => setAppHkSaved(""), 1500);
      })
      .catch((e) =>
        setAppHkErr(typeof e === "string" ? e : e?.message || String(e)),
      );
  };

  // 「唤出主界面」快捷键保存：录入框按下即存，手动改完点保存走同一条路
  const saveMainHotkey = (v = hotkey) => {
    setHotkeyErr("");
    return api
      .setHotkey(v)
      .then((r) => {
        // 宿主注册不下来（组合已被系统/别的应用抢占）时不落盘：把输入框退回真正生效的旧值
        if (r && r.ok === false) {
          setHotkey(r?.hotkey || "");
          setHotkeyErr(t("ai.hotkeyTaken"));
          return;
        }
        setHotkeySaved(true);
        setTimeout(() => setHotkeySaved(false), 1500);
      })
      .catch((e) =>
        setHotkeyErr(typeof e === "string" ? e : e?.message || String(e)),
      );
  };

  // 开机自启开关：先落系统登录项，失败回滚显示原状态
  const toggleAutostart = (enabled) => {
    const prev = autostart;
    setAutostart(enabled);
    api.setAutostart(enabled).catch(() => setAutostart(prev));
  };

  // 阻止休眠开关：宿主返回系统是否真的被挡住（active）；失败回滚开关
  const togglePreventSleep = (enabled) => {
    const prev = preventSleep;
    setPreventSleep(enabled);
    api
      .setPreventSleep(enabled)
      .then((r) => {
        setPreventSleep(!!r?.enabled);
        setSleepBlockActive(!!r?.active);
      })
      .catch(() => {
        setPreventSleep(prev);
        setSleepBlockActive(false);
      });
  };

  // 托盘悬浮预览延迟：改完由主进程当场按新值走（0 = 关掉悬浮窗），失败回滚选项
  const saveTrayHover = (delay) => {
    const prev = trayHover;
    setTrayHover((h) => ({ ...(h || {}), delay }));
    api
      .setTrayHover(delay)
      .then((r) => setTrayHover(r && r.supported ? r : null))
      .catch(() => setTrayHover(prev));
  };

  // 任务完成提示音：档位（default/custom/error-only）+ 音量 + 自定义音频。null=加载中
  const [notify, setNotify] = useState(null);
  const [notifyErr, setNotifyErr] = useState("");
  const [pickingSound, setPickingSound] = useState(false);
  const notifyFileRef = useRef(null);
  const notifyDeb = useRef(null);

  const commitNotify = (mode, volume) => {
    api
      .setNotifySound(mode, volume)
      .then((r) => {
        setNotify((n) => ({ ...(n || {}), ...(r || {}) }));
        setNotifyErr("");
      })
      .catch((e) => {
        // 选「自定义」但还没挑文件这类拒绝要当场说清，不能默默退回默认档
        setNotifyErr(String(e?.message || e));
        api.getNotifySound().then((r) => setNotify(r)).catch(() => {});
      });
  };

  const pickCustomSound = (file) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setNotifyErr(t("ai.notifyTooLarge", { kb: Math.round(file.size / 1024) }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPickingSound(true);
      api
        .setCustomSound(file.name, String(reader.result || ""))
        .then(() => api.getNotifySound())
        .then((r) => {
          setNotify(r);
          setNotifyErr("");
          previewCompletion(true); // 挑完当场响一声，省得用户还要再点试听
        })
        .catch((e) => setNotifyErr(String(e?.message || e)))
        .finally(() => setPickingSound(false));
    };
    reader.onerror = () => setNotifyErr(t("ai.notifyReadFailed"));
    reader.readAsDataURL(file);
  };

  // 变更即保存（温度滑块拖动用 300ms 防抖，避免频繁落盘）
  const debounceRef = useRef(null);
  const saveParams = (next, debounce = false) => {
    setParams(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const doSave = () => {
      api
        .setAiParams(next.temperature, next.reasoning_effort)
        .then(() => {
          setParamsSaved(true);
          setTimeout(() => setParamsSaved(false), 1500);
        })
        .catch(() => {});
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
      api
        .setGuardLimits(next.word_repeat_max, next.tool_loop_max)
        .then(() => {
          setLimitsSaved(true);
          setTimeout(() => setLimitsSaved(false), 1500);
        })
        .catch(() => {});
    }, 300);
  };
  const toolEnvRef = useRef(null);
  const saveToolEnv = (next) => {
    setToolEnv(next);
    if (toolEnvRef.current) clearTimeout(toolEnvRef.current);
    toolEnvRef.current = setTimeout(() => {
      api
        .setToolEnvSettings(next.tool_timeout_secs, next.default_shell)
        .then(() => {
          setToolEnvSaved(true);
          setTimeout(() => setToolEnvSaved(false), 1500);
        })
        .catch(() => {});
    }, 300);
  };
  // 托管服务生命周期：核心钳制后回显生效值，输入框跟着落回真数——
  // 用户填了 99999 秒，留在框里就是骗他
  const svcRef = useRef(null);
  const saveSvcTuning = (key, raw) => {
    const range = (svcTuning.ranges || []).find((r) => r.key === key) || {};
    const n = parseInt(raw, 10);
    const v = Number.isFinite(n)
      ? Math.max(range.min ?? 0, Math.min(range.max ?? n, n))
      : (svcTuning[key] ?? 0);
    setSvcTuning((prev) => ({ ...prev, [key]: v }));
    if (svcRef.current) clearTimeout(svcRef.current);
    svcRef.current = setTimeout(() => {
      api
        .setServiceTuning({ [key]: v })
        .then((r) => {
          if (r && typeof r === "object") {
            setSvcTuning((prev) => ({ ...prev, ...r }));
          }
          setSvcSaved(true);
          setTimeout(() => setSvcSaved(false), 1500);
        })
        .catch(() => {});
    }, 300);
  };
  // 出网代理：core 返回的都是稳定错误码，界面按当前语言出文案。
  // Electron 的 IPC 会把错误包一层（「Error invoking remote method 'bit:invoke': Error: proxy_empty」），
  // 所以先把 proxy_* 码抠出来再查表，否则所有具体错误都退化成「未能保存」
  const proxyErrCode = (msg) => {
    const s = String(msg || "");
    return s.match(/proxy_[a-z_]+/)?.[0] || s.trim();
  };
  const proxyErrText = (code) =>
    ({
      proxy_empty: t("ai.proxyErrEmpty"),
      proxy_scheme: t("ai.proxyErrScheme"),
      proxy_url: t("ai.proxyErrUrl"),
      proxy_addr: t("ai.proxyErrUrl"),
      proxy_host_missing: t("ai.proxyErrHost"),
      proxy_too_long: t("ai.proxyErrTooLong"),
      proxy_no_target: t("ai.proxyNoTarget"),
      proxy_ca_missing: t("ai.proxyErrCaMissing"),
      proxy_ca_parse: t("ai.proxyErrCaParse"),
    })[code] || t("ai.proxyErrUnknown");

  const refreshProxy = () =>
    api
      .getProxyConfig()
      .then((r) =>
        setProxy({
          mode: r?.mode || "system",
          url_input: r?.url_input || "",
          user: r?.user || "",
          pass: r?.pass || "",
          bypass_input: r?.bypass_input || "",
          effective_url: r?.url || "",
          url_from: r?.url_from || "",
          bypass: r?.bypass || [],
          env: r?.proxy_env || [],
          webview: r?.webview || null,
          export_env: r?.export_env !== false,
          fail_open: !!r?.fail_open,
          ca_input: r?.ca_input || "",
          ca_saved: r?.ca_file || "",
          insecure: !!r?.insecure,
          ca_certs: r?.ca_certs || 0,
          ca_error: !!r?.ca_error,
          system: r?.system || { url: "", from: "", pac: "" },
        }),
      )
      .catch(() => {});

  const saveProxy = () => {
    api
      .setProxyConfig(
        proxy.mode,
        proxy.url_input,
        proxy.user,
        proxy.pass,
        proxy.bypass_input,
        proxy.export_env,
        proxy.fail_open,
        proxy.ca_input,
        proxy.insecure,
      )
      .then(() => {
        setProxyErr("");
        setProxyTest(null);
        // 回读一次：core 会把裸 host:port 规范成带协议的地址、并刷新环境变量回显
        return refreshProxy();
      })
      .then(() => {
        setProxySaved(true);
        setTimeout(() => setProxySaved(false), 1600);
      })
      .catch((e) => setProxyErr(proxyErrText(proxyErrCode(e?.message || e))));
  };

  // 本机代理探测：填进地址框就完事，不自动保存——用户可能还想改端口与协议
  const runProxyProbe = () => {
    setProxyErr("");
    api
      .probeLocalProxy()
      .then((r) => setProxyPeers(r?.hits || []))
      .catch((e) => setProxyErr(proxyErrText(proxyErrCode(e?.message || e))));
  };

  const runProxyTest = () => {
    setProxyTesting(true);
    setProxyErr("");
    api
      .testProxy("")
      .then((r) => setProxyTest(r))
      .catch((e) => {
        setProxyTest(null);
        setProxyErr(proxyErrText(proxyErrCode(e?.message || e)));
      })
      .finally(() => setProxyTesting(false));
  };

  const saveBehavior = (next) => {
    setBehavior(next);
    api
      .setBehaviorSettings(
        next.auto_drive,
        next.tool_approval,
        next.moderation_enabled,
        next.auto_delegate,
        next.compat_mode,
        next.subagent_max,
      )
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
      .setBehaviorSettings(
        behavior.auto_drive,
        behavior.tool_approval,
        behavior.moderation_enabled,
        behavior.auto_delegate,
        behavior.compat_mode,
        behavior.subagent_max,
        list,
      )
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
      const res = await api.listProviderModels(
        form.protocol,
        form.base_url,
        form.api_key,
      );
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
        await api.updateProvider(
          form.id,
          form.name,
          form.protocol,
          form.base_url,
          form.api_key,
          form.model,
        );
      } else {
        await api.addProvider(
          form.name,
          form.protocol,
          form.base_url,
          form.api_key,
          form.model,
        );
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
    <div className="page">
      {/* 运行总览并到「模型提供方」这张卡里：总览上的主操作就是添加提供方，拆成两张卡反而要多点一次 */}
      <section className="set-group" id="set-ai-providers" style={gstyle("ai-providers")}>
        {stats && (
          <div className="card">
            <p className="mb-3 text-xs font-medium text-neutral-900 dark:text-neutral-100">
              {t("ai.statsTitle")}
            </p>
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
              <span className="chip">
                {stats.ai_configured ? t("ai.aiActive") : t("ai.aiInactive")}
              </span>
              <span
                className={`chip ${stats.remote?.enabled ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : ""}`}
              >
                {stats.remote?.enabled
                  ? `${t("ai.remoteOn")}${stats.remote.addr}`
                  : t("ai.remoteOff")}
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
            </div>
          </div>
        )}
        <div className="set-grid">
          {/* 提供方列表 */}
          <div className="flex flex-col gap-2">
            {providers.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-700">
                <IconSettings size={18} className="text-neutral-400" />
                <p className="text-sm text-neutral-500 dark:text-neutral-400">{t("ai.emptyProviders")}</p>
                <p className="text-xs text-neutral-400 dark:text-neutral-500">
                  {t("ai.emptyProvidersHint")}
                </p>
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
                    <span className="truncate text-sm font-semibold">
                      {p.name}
                    </span>
                    <span className="chip shrink-0">
                      {protoLabel(p.protocol)}
                    </span>
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
                  className="icon-btn shrink-0"
                >
                  <IconSettings size={15} />
                </button>
                <button
                  onClick={() => remove(p.id)}
                  title={t("common.delete")}
                  className="icon-btn shrink-0 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
                >
                  <IconTrash size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>
      {/* 出网代理：企业内网连不上公网端点时的出路。一份配置三处生效——
          core 的 reqwest 客户端、本进程环境变量（curl/git/npm 继承）与宿主 webview */}
      <section className="set-group" id="set-ai-proxy" style={gstyle("ai-proxy")}>
        <div className="set-grid">
          <div className="card flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">{t("ai.proxyTitle")}</p>
              {proxySaved && (
                <span className="flex items-center gap-1 text-xs text-neutral-500">
                  <IconCheck size={14} />
                  {t("ai.proxyApplied")}
                </span>
              )}
            </div>
            <p className="text-xs leading-snug text-neutral-500">{t("ai.proxyDesc")}</p>
            <div className="grid grid-cols-2 items-end gap-3">
              <div>
                <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.proxyMode")}</label>
                <select
                  className="field"
                  value={proxy.mode}
                  onChange={(e) => setProxy({ ...proxy, mode: e.target.value })}
                >
                  <option value="system">{t("ai.proxyModeSystem")}</option>
                  <option value="direct">{t("ai.proxyModeDirect")}</option>
                  <option value="custom">{t("ai.proxyModeCustom")}</option>
                </select>
              </div>
              <p className="px-2 pb-1 text-[11px] leading-snug text-neutral-400">
                {proxy.mode === "direct"
                  ? t("ai.proxyModeDirectHint")
                  : proxy.mode === "custom"
                    ? t("ai.proxyModeCustomHint")
                    : t("ai.proxyModeSystemHint")}
              </p>
            </div>
            {/* 跟随系统的实际读数：reqwest 不认注册表，core 读到了什么就照实说什么 */}
            {proxy.mode === "system" && (
              <p className="px-2 text-[11px] leading-snug text-neutral-400">
                {proxy.system?.url
                  ? `${t("ai.proxySystemFound")} ${proxy.system.url}`
                  : proxy.system?.pac
                    ? t("ai.proxySystemPac")
                    : t("ai.proxySystemNone")}
              </p>
            )}
            {proxy.mode === "custom" && (
              <div className="flex flex-col gap-3">
                <div>
                  <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.proxyUrl")}</label>
                  <input
                    className="field font-mono"
                    value={proxy.url_input}
                    placeholder="http://proxy.corp:3128"
                    spellCheck={false}
                    onChange={(e) => setProxy({ ...proxy, url_input: e.target.value })}
                  />
                  <p className="mt-1 px-2 text-[11px] leading-snug text-neutral-400">{t("ai.proxyUrlHint")}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.proxyUser")}</label>
                    <input
                      className="field"
                      value={proxy.user}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setProxy({ ...proxy, user: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.proxyPass")}</label>
                    <input
                      className="field"
                      type="password"
                      value={proxy.pass}
                      autoComplete="new-password"
                      onChange={(e) => setProxy({ ...proxy, pass: e.target.value })}
                    />
                  </div>
                </div>
                <p className="px-2 text-[11px] leading-snug text-neutral-400">{t("ai.proxyAuthHint")}</p>
                <div>
                  <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.proxyBypass")}</label>
                  <input
                    className="field font-mono"
                    value={proxy.bypass_input}
                    placeholder="intra.corp,10.0.0.0/8"
                    spellCheck={false}
                    onChange={(e) => setProxy({ ...proxy, bypass_input: e.target.value })}
                  />
                  <p className="mt-1 px-2 text-[11px] leading-snug text-neutral-400">{t("ai.proxyBypassHint")}</p>
                </div>
                {/* 出网口径细调：默认都跟着「一次设置、三层生效」走，勾掉才偏离 */}
                <div className="flex flex-col gap-2.5 border-t border-neutral-200/60 pt-2.5 dark:border-neutral-700/60">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{t("ai.proxyExport")}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-neutral-400">{t("ai.proxyExportHint")}</p>
                    </div>
                    <PillSwitch
                      size="sm"
                      checked={proxy.export_env}
                      onChange={(v) => setProxy({ ...proxy, export_env: v })}
                    />
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{t("ai.proxyFailOpen")}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-neutral-400">{t("ai.proxyFailOpenHint")}</p>
                    </div>
                    <PillSwitch
                      size="sm"
                      checked={proxy.fail_open}
                      onChange={(v) => setProxy({ ...proxy, fail_open: v })}
                    />
                  </div>
                </div>
                {/* 企业网关做 TLS 中间人时给的是自家根证书：指个路径就信它，别急着关掉校验 */}
                <div>
                  <label className="mb-1 block px-2 text-xs text-neutral-500">{t("ai.proxyCa")}</label>
                  <input
                    className="field font-mono"
                    value={proxy.ca_input}
                    placeholder="C:\\certs\\corp-root-ca.pem"
                    spellCheck={false}
                    onChange={(e) => setProxy({ ...proxy, ca_input: e.target.value })}
                  />
                  <p className="mt-1 px-2 text-[11px] leading-snug text-neutral-400">{t("ai.proxyCaHint")}</p>
                  {/* 状态行只按已保存的配置说，不然填了个坏路径也会显示「已加载 0 张」 */}
                  {proxy.ca_saved.trim() !== "" && (
                    <p
                      className={`mt-1 px-2 text-[11px] ${
                        proxy.ca_error ? "text-red-500 dark:text-red-400" : "text-neutral-500"
                      }`}
                    >
                      {proxy.ca_error ? t("ai.proxyCaBad") : t("ai.proxyCaLoaded", { n: proxy.ca_certs })}
                    </p>
                  )}
                  <div className="mt-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-red-600 dark:text-red-400">{t("ai.proxyInsecure")}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-neutral-400">{t("ai.proxyInsecureHint")}</p>
                    </div>
                    <PillSwitch
                      size="sm"
                      checked={proxy.insecure}
                      onChange={(v) => setProxy({ ...proxy, insecure: v })}
                    />
                  </div>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button className="pill pill-hover text-xs" onClick={saveProxy}>
                {t("common.save")}
              </button>
              <button
                className="pill-outline pill-hover text-xs disabled:opacity-50"
                onClick={runProxyTest}
                disabled={proxyTesting}
              >
                {proxyTesting ? t("ai.proxyTesting") : t("ai.proxyTest")}
              </button>
              {proxy.mode === "custom" && (
                <button className="pill-outline pill-hover text-xs" onClick={runProxyProbe}>
                  {t("ai.proxyProbe")}
                </button>
              )}
              {proxy.effective_url && (
                <span className="ml-auto truncate font-mono text-[11px] text-neutral-400">
                  {t("ai.proxyEffective")} {proxy.effective_url}
                  {proxy.url_from && proxy.url_from !== "config" ? ` · ${t("ai.proxyFromSystem")}` : ""}
                </span>
              )}
            </div>
            {/* 本机代理客户端探测结果：点一下就填进地址框，保存仍由用户决定 */}
            {proxy.mode === "custom" && proxyPeers && (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {proxyPeers.length === 0 ? (
                  <span className="text-neutral-400">{t("ai.proxyProbeNone")}</span>
                ) : (
                  <>
                    <span className="text-neutral-500">{t("ai.proxyProbeFound")}</span>
                    {proxyPeers.map((h) => (
                      <button
                        key={h.addr}
                        className="pill-outline pill-hover text-[11px] font-mono"
                        title={h.label || ""}
                        onClick={() => setProxy({ ...proxy, url_input: h.addr })}
                      >
                        {h.addr}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
            {proxyErr && <p className="text-xs text-red-500 dark:text-red-400">{proxyErr}</p>}
            {proxyTest && (
              <div className="flex flex-col gap-1.5 rounded-2xl bg-neutral-100 p-2.5 text-[11px] dark:bg-neutral-900">
                {proxyTest.proxy_addr && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        proxyTest.proxy_reachable ? "bg-emerald-500" : "bg-red-500"
                      }`}
                    />
                    <span>
                      {proxyTest.proxy_reachable
                        ? t("ai.proxyResultProxyOk", { addr: proxyTest.proxy_addr })
                        : t("ai.proxyResultProxyFail", { addr: proxyTest.proxy_addr })}
                    </span>
                    {typeof proxyTest.proxy_latency_ms === "number" && (
                      <span className="text-neutral-400">{t("ai.proxyLatency", { n: proxyTest.proxy_latency_ms })}</span>
                    )}
                  </div>
                )}
                {proxyTest.target && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        proxyTest.reachable ? "bg-emerald-500" : "bg-red-500"
                      }`}
                    />
                    <span>{proxyTest.reachable ? t("ai.proxyResultTargetOk") : t("ai.proxyResultTargetFail")}</span>
                    <span className="min-w-0 truncate font-mono text-neutral-400">{proxyTest.target}</span>
                    {proxyTest.status && (
                      <span className="text-neutral-400">{t("ai.proxyStatus", { code: proxyTest.status })}</span>
                    )}
                    {typeof proxyTest.latency_ms === "number" && (
                      <span className="text-neutral-400">{t("ai.proxyLatency", { n: proxyTest.latency_ms })}</span>
                    )}
                  </div>
                )}
                {proxyTest.detail && (
                  <p className="break-all font-mono text-neutral-400">{proxyTest.detail}</p>
                )}
              </div>
            )}
          </div>
          {/* 生效回显：把进程里真实存在的代理变量摊开，避免「设了却没生效」无从判断 */}
          <div className="card flex flex-col gap-2">
            <p className="text-sm font-medium">{t("ai.proxyEnvTitle")}</p>
            <p className="text-xs leading-snug text-neutral-500">{t("ai.proxyEnvHint")}</p>
            {proxy.env.filter((r) => r.value).length === 0 ? (
              <p className="text-xs text-neutral-400">{t("ai.proxyEnvNone")}</p>
            ) : (
              <div className="flex flex-col gap-1">
                {proxy.env
                  .filter((r) => r.value)
                  .map((r) => (
                    <div key={r.name} className="flex items-baseline justify-between gap-3 text-[11px]">
                      <span className="shrink-0 font-mono text-neutral-500">{r.name}</span>
                      <span className="min-w-0 truncate font-mono text-neutral-700 dark:text-neutral-200" title={r.value}>
                        {r.value}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            {proxy.bypass.length > 0 && (
              <p className="text-[11px] leading-snug text-neutral-400">
                {t("ai.proxyBypassCount", { n: proxy.bypass.length })} · {proxy.bypass.join(", ")}
              </p>
            )}
            {/* 三项口径的实际生效状态摊开回显，勾了没保存、保存了没生效一眼能分 */}
            <div className="flex flex-col gap-1 border-t border-neutral-200/60 pt-2 text-[11px] dark:border-neutral-700/60">
              <div className="flex items-baseline justify-between gap-3">
                <span className="shrink-0 text-neutral-500">{t("ai.proxyRowExport")}</span>
                <span className="min-w-0 truncate text-right text-neutral-700 dark:text-neutral-200">
                  {proxy.export_env ? t("ai.proxyRowExportOn") : t("ai.proxyRowExportOff")}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="shrink-0 text-neutral-500">{t("ai.proxyRowTls")}</span>
                <span
                  className={`min-w-0 truncate text-right ${
                    proxy.insecure ? "text-red-500 dark:text-red-400" : "text-neutral-700 dark:text-neutral-200"
                  }`}
                >
                  {proxy.insecure
                    ? t("ai.proxyRowTlsInsecure")
                    : proxy.ca_certs > 0
                      ? t("ai.proxyRowTlsCa", { n: proxy.ca_certs })
                      : t("ai.proxyRowTlsStrict")}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="shrink-0 text-neutral-500">{t("ai.proxyRowFailOpen")}</span>
                <span className="min-w-0 truncate text-right text-neutral-700 dark:text-neutral-200">
                  {proxy.fail_open ? t("ai.proxyRowOn") : t("ai.proxyRowOff")}
                </span>
              </div>
            </div>
            {proxy.webview?.resolved !== undefined && (
              <div className="flex flex-col gap-1 border-t border-neutral-200/60 pt-2 dark:border-neutral-700/60">
                <p className="text-[11px] text-neutral-500">{t("ai.proxyWebviewTitle")}</p>
                <div className="flex items-baseline justify-between gap-3 text-[11px]">
                  <span className="shrink-0 text-neutral-500">{t("ai.proxyWebviewPublic")}</span>
                  <span className="min-w-0 truncate font-mono text-neutral-700 dark:text-neutral-200">
                    {proxy.webview.resolved || "-"}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-3 text-[11px]">
                  <span className="shrink-0 text-neutral-500">{t("ai.proxyWebviewLocal")}</span>
                  <span className="min-w-0 truncate font-mono text-neutral-700 dark:text-neutral-200">
                    {proxy.webview.resolved_local || "-"}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
      <section className="set-group" id="set-ai-model" style={gstyle("ai-model")}>
        <div className="set-grid">
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
              <label className="mb-1 block px-2 text-xs text-neutral-500">
                {t("ai.reasoningLabel")}
              </label>
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
                    onClick={() =>
                      saveParams({ ...params, reasoning_effort: v })
                    }
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
              <p className="mt-1 px-2 text-[11px] text-neutral-400">
                {t("ai.reasoningHint")}
              </p>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between px-2">
                <label className="text-xs text-neutral-500">
                  {t("ai.temperatureLabel")}
                </label>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      params.temperature !== null &&
                      saveParams({ ...params, temperature: null })
                    }
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
                    onClick={() =>
                      params.temperature === null
                        ? saveParams({ ...params, temperature: 0.7 })
                        : saveParams({
                            ...params,
                            temperature: Math.min(
                              2,
                              Math.max(0, params.temperature),
                            ),
                          })
                    }
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
                    onChange={(e) =>
                      saveParams(
                        { ...params, temperature: parseFloat(e.target.value) },
                        true,
                      )
                    }
                    className="flex-1 accent-[var(--accent)]"
                  />
                  <span className="w-10 text-right text-xs tabular-nums">
                    {params.temperature.toFixed(1)}
                  </span>
                </div>
              ) : (
                <p className="px-2 text-[11px] text-neutral-400">
                  {t("ai.temperatureDefaultHint")}
                </p>
              )}
            </div>
          </div>
          {/* 上下文上限回退值：模型没上报上限时对话页按这个值估算并告警 */}
          <ContextLimitCard t={t} />
        </div>
      </section>
      <section className="set-group" id="set-ai-exec" style={gstyle("ai-exec")}>
        <div className="set-grid">
          {/* 幻觉防护：词重复 / 工具死循环熔断阈值（0=关闭），深浅主题沿用 field/card 变量 */}
          <div className="card flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{t("ai.guardTitle")}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {t("ai.guardDesc")}
                </p>
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
                <label className="mb-1 block px-2 text-xs text-neutral-500">
                  {t("ai.guardWord")}
                </label>
                <input
                  className="field tabular-nums"
                  type="number"
                  min="0"
                  max="10000"
                  value={limits.word_repeat_max}
                  onChange={(e) =>
                    saveLimits({
                      ...limits,
                      word_repeat_max: Math.max(
                        0,
                        Math.min(10000, parseInt(e.target.value, 10) || 0),
                      ),
                    })
                  }
                />
                <p className="mt-1 px-2 text-[11px] text-neutral-400">
                  {t("ai.guardWordHint")}
                </p>
              </div>
              <div>
                <label className="mb-1 block px-2 text-xs text-neutral-500">
                  {t("ai.guardTool")}
                </label>
                <input
                  className="field tabular-nums"
                  type="number"
                  min="0"
                  max="10000"
                  value={limits.tool_loop_max}
                  onChange={(e) =>
                    saveLimits({
                      ...limits,
                      tool_loop_max: Math.max(
                        0,
                        Math.min(10000, parseInt(e.target.value, 10) || 0),
                      ),
                    })
                  }
                />
                <p className="mt-1 px-2 text-[11px] text-neutral-400">
                  {t("ai.guardToolHint")}
                </p>
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
                <label className="mb-1 block px-2 text-xs text-neutral-500">
                  {t("ai.toolTimeout")}
                </label>
                <input
                  className="field tabular-nums"
                  type="number"
                  min="10"
                  max="600"
                  value={toolEnv.tool_timeout_secs}
                  onChange={(e) =>
                    saveToolEnv({
                      ...toolEnv,
                      tool_timeout_secs: Math.max(
                        10,
                        Math.min(600, parseInt(e.target.value, 10) || 120),
                      ),
                    })
                  }
                />
                <p className="mt-1 px-2 text-[11px] text-neutral-400">
                  {t("ai.toolTimeoutHint")}
                </p>
              </div>
              <div>
                <label className="mb-1 block px-2 text-xs text-neutral-500">
                  {t("ai.defaultShell")}
                </label>
                <select
                  className="field"
                  value={toolEnv.default_shell}
                  onChange={(e) =>
                    saveToolEnv({ ...toolEnv, default_shell: e.target.value })
                  }
                >
                  <option value="">{t("ai.shellAuto")}</option>
                  {toolEnv.available_shells.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <p className="mt-1 px-2 text-[11px] text-neutral-400">
                  {t("ai.shellAutoHint")}
                </p>
              </div>
            </div>
          </div>
          {/* 托管服务生命周期：WorkWith 条目与插件清单 services[] 共用这一套松紧旋钮。
              区间由核心一起回显，前端不抄数字；写完用核心返回的生效值覆盖输入框 */}
          <div className="card flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{t("ai.svcTitle")}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {t("ai.svcDesc")}
                </p>
              </div>
              {svcSaved && (
                <span className="flex items-center gap-1 text-xs text-neutral-500">
                  <IconCheck size={14} />
                  {t("common.saved")}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                ["start_delay_ms", "ai.svcDelay", "ai.svcDelayHint"],
                ["ready_secs", "ai.svcReady", "ai.svcReadyHint"],
                ["retries", "ai.svcRetry", "ai.svcRetryHint"],
                ["stop_grace_secs", "ai.svcStop", "ai.svcStopHint"],
                ["log_lines", "ai.svcLog", "ai.svcLogHint"],
              ].map(([key, label, hint]) => {
                const r =
                  (svcTuning.ranges || []).find((x) => x.key === key) || {};
                return (
                  <div key={key}>
                    <label className="mb-1 block px-2 text-xs text-neutral-500">
                      {t(label)}
                    </label>
                    <input
                      className="field tabular-nums"
                      type="number"
                      min={r.min}
                      max={r.max}
                      value={svcTuning[key]}
                      onChange={(e) => saveSvcTuning(key, e.target.value)}
                    />
                    <p className="mt-1 px-2 text-[11px] text-neutral-400">
                      {t(hint)}
                      {r.min !== undefined ? ` (${r.min}–${r.max})` : ""}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
          {/* 本机操控三件套（实验性）：AI 可截屏看屏 / 控鼠标 / 打字按键 */}
          <div className="card flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium">{t("ai.desktopToolsTitle")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {t("ai.desktopToolsDesc")}
              </p>
            </div>
            {[
              ["screen", "ai.desktopScreen"],
              ["mouse", "ai.desktopMouse"],
              ["keyboard", "ai.desktopKeyboard"],
              ["diagram", "ai.desktopDiagram"],
              ["viewimage", "ai.desktopViewimage"],
            ].map(([key, label]) => (
              <div key={key} className="flex items-center justify-between">
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  {t(label)}
                </p>
                <PillSwitch
                  checked={deskTools[key]}
                  onChange={(v) => {
                    const next = { ...deskTools, [key]: v };
                    setDeskTools(next);
                    api
                      .setDesktopTools(
                        next.screen,
                        next.mouse,
                        next.keyboard,
                        next.diagram,
                        next.viewimage,
                      )
                      .catch(() => {});
                  }}
                />
              </div>
            ))}
          </div>
          {/* 写文件语法检查：写入/编辑 json、js、py 后自动体检，出错提醒模型与用户 */}
          <div className="card flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ai.syntaxCheckTitle")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {t("ai.syntaxCheckDesc")}
              </p>
            </div>
            <PillSwitch
              checked={syntaxCheck}
              onChange={(v) => {
                setSyntaxCheck(v);
                api.setSyntaxCheck(v).catch(() => {});
              }}
            />
          </div>
          {/* AI 自主能力说明 */}
          <div className="card text-xs leading-relaxed text-neutral-500">
            <p className="mb-2 font-medium text-neutral-900 dark:text-neutral-100">
              {t("ai.autonomyTitle")}
            </p>
            <ul className="list-inside list-disc space-y-1">
              <li>{t("ai.capTools")}</li>
              <li>{t("ai.capPlan")}</li>
              <li>{t("ai.capScript")}</li>
              <li>{t("ai.capSkill")}</li>
              <li>{t("ai.capInvoke")}</li>
            </ul>
            <p className="mt-3 border-t border-neutral-200/70 pt-2 text-neutral-500 dark:border-neutral-800/70">
              {t("ai.memoryNote1")}
              <b className="text-neutral-700 dark:text-neutral-300">
                {t("ai.memoryNote2")}
              </b>
              {t("ai.memoryNote3")}
            </p>
          </div>
        </div>
      </section>
      <section className="set-group" id="set-ai-behavior" style={gstyle("ai-behavior")}>
        <div className="set-grid">
          {/* AI 行为：审批、压缩、兼容、审核都收在这张卡里，页头已给出本页范围 */}
          <div className="card flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">{t("ai.approvalTitle")}</p>
                <p className="text-xs text-neutral-500">
                  {behavior.tool_approval === "l2pass"
                    ? t("ai.approvalL2Hint")
                    : t("ai.approvalHint")}
                </p>
              </div>
              <select
                className="field w-auto"
                value={behavior.tool_approval}
                onChange={(e) =>
                  saveBehavior({ ...behavior, tool_approval: e.target.value })
                }
              >
                <option value="ask">{t("ai.approvalAsk")}</option>
                <option value="auto">{t("ai.approvalAuto")}</option>
                <option value="l2pass">{t("ai.approvalL2")}</option>
                <option value="allow_all">{t("ai.approvalAll")}</option>
              </select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">{t("ai.autoCompact")}</p>
                <p className="text-xs text-neutral-500">
                  {t("ai.autoCompactHint")}
                </p>
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
                    <p className="text-xs text-neutral-500">
                      {t("ai.compactCharsHint")}
                    </p>
                  </div>
                  <input
                    className="field tabular-nums"
                    style={{ width: 108 }}
                    type="number"
                    min="6000"
                    max="200000"
                    step="1000"
                    value={compact.chars}
                    onChange={(e) =>
                      saveCompact({
                        chars: Math.max(
                          6000,
                          Math.min(
                            200000,
                            parseInt(e.target.value, 10) || 24000,
                          ),
                        ),
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm">{t("ai.compactProvider")}</p>
                    <p className="text-xs text-neutral-500">
                      {t("ai.compactProviderHint")}
                    </p>
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

            {/* 工具按需加载：与兼容模式同组，二者都决定「工具清单怎么给模型」 */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">{t("ai.lazyTools")}</p>
                <p className="text-xs text-neutral-500">
                  {t("ai.lazyToolsHint")}
                </p>
              </div>
              <PillSwitch
                checked={!!lazyTools}
                onChange={(v) => {
                  setLazyTools(v);
                  api.setToolLoading(v).catch(() => {});
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">{t("ai.moderationTitle")}</p>
                <p className="text-xs text-neutral-500">
                  {t("ai.moderationHint")}
                </p>
              </div>
              <PillSwitch
                checked={behavior.moderation_enabled}
                onChange={(v) =>
                  saveBehavior({ ...behavior, moderation_enabled: v })
                }
              />
            </div>

            <div className="flex flex-col gap-2 border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-neutral-700 dark:text-neutral-300">
                    {t("ai.moderationWordsTitle")}
                  </p>
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

          </div>
          {/* 待办时钟：对话页待办面板显示计划执行时间（localStorage 偏好，与工具开关解耦） */}
          <div className="card flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("settings.todoClock")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {t("settings.todoClockHint")}
              </p>
            </div>
            <PillSwitch checked={todoClock} onChange={toggleTodoClock} />
          </div>
          {/* 自主执行与子代理：原先只在自动化页 / 页眉弹层里改，这里给偏好一个稳定的设置入口 */}
          <div className="card flex flex-col gap-3">
            <p className="text-sm font-medium">{t("ai.delegateTitle")}</p>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">{t("auto.autoDrive")}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {t("auto.autoDriveHint")}
                </p>
              </div>
              <PillSwitch
                checked={!!behavior.auto_drive}
                onChange={(v) => saveBehavior({ ...behavior, auto_drive: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">{t("auto.autoDelegate")}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {t("auto.autoDelegateHint")}
                </p>
              </div>
              <PillSwitch
                checked={!!behavior.auto_delegate}
                onChange={(v) => saveBehavior({ ...behavior, auto_delegate: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">{t("auto.subagentMax")}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {t("auto.subagentMaxHint")}
                </p>
              </div>
              <input
                type="number"
                min="1"
                max="8"
                value={behavior.subagent_max}
                onChange={(e) =>
                  setBehavior((b) => ({
                    ...b,
                    subagent_max: Number(e.target.value) || 1,
                  }))
                }
                onBlur={(e) =>
                  saveBehavior({
                    ...behavior,
                    subagent_max: Math.max(
                      1,
                      Math.min(8, Number(e.target.value) || 1),
                    ),
                  })
                }
                className="field w-20 text-right font-mono"
              />
            </div>
          </div>
        </div>
      </section>
      <section className="set-group" id="set-ai-voice" style={gstyle("ai-voice")}>
        <div className="set-grid">
          {/* 语音输入：对话页输入框麦克风按钮（localStorage 偏好），下方展示离线识别模型状态 */}
          <div className="card flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {t("settings.voiceInput")}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {t("settings.voiceInputHint")}
                </p>
              </div>
              <PillSwitch checked={voiceInput} onChange={toggleVoiceInput} />
            </div>
            {/* 识别模型多选一：sense-voice / zipformer / paraformer / whisper；未就绪的选中即下载 */}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-neutral-500">
                {t("settings.voiceModel")}
              </p>
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
                <span
                  className={
                    voiceErr
                      ? "text-red-500"
                      : "text-neutral-500 dark:text-neutral-400"
                  }
                >
                  {voiceErr ||
                    (voiceModel === null
                      ? "…"
                      : voiceModel.ready
                        ? t("voice.modelReady")
                        : voiceStarting || voiceModel.downloading
                          ? voiceModel.progress?.total
                            ? t("voice.downloading", {
                                p: Math.round(
                                  (voiceModel.progress.done /
                                    voiceModel.progress.total) *
                                    100,
                                ),
                              })
                            : t("voice.downloadStart")
                          : t("voice.modelMissing"))}
                </span>
                {voiceModel &&
                  !voiceModel.ready &&
                  !voiceStarting &&
                  !voiceModel.downloading && (
                    <button
                      className="pill pill-hover shrink-0 text-xs"
                      onClick={startVoiceDownload}
                    >
                      {t("voice.downloadBtn")}
                    </button>
                  )}
              </div>
              {/* 下载进度条：文字之外给个可见的比例条 */}
              {(voiceStarting || voiceModel?.downloading) &&
                voiceModel?.progress?.total > 0 && (
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
          {/* 自动朗读回复：与页眉喇叭按钮共用同一份开关状态 */}
          <AutoSpeakCard t={t} />
          {/* 语音唤醒：关键词唤醒模型下载 + 开关 + 灵敏度；命中唤醒词自动开麦转写 */}
          {voiceModel?.kws && (
            <div className="card flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{t("voice.kwsTitle")}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {t("voice.kwsDesc")}
                  </p>
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
                          const emsg =
                            typeof e === "string" ? e : e?.message || String(e);
                          setKwsErr(
                            emsg ? `${emsg}` : t("voice.downloadFailed"),
                          );
                        });
                    }}
                  />
                ) : null}
              </div>
              {/* 模型未下载：显示体积 + 下载按钮 + 进度条；就绪后显示开关与灵敏度 */}
              {!voiceModel.kws.ready ? (
                <div className="flex flex-col gap-1.5 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={
                        kwsErr
                          ? "text-red-500"
                          : "text-neutral-500 dark:text-neutral-400"
                      }
                    >
                      {kwsErr || t("voice.kwsModelMissing")}
                    </span>
                    <button
                      className="pill pill-hover shrink-0 text-xs"
                      onClick={startKwsDownload}
                    >
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
                    <span className="shrink-0 tabular-nums">
                      {kwsScore.toFixed(1)}
                    </span>
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
                        <button
                          className="pill pill-hover shrink-0 text-xs"
                          onClick={() => submitKwsWords([])}
                        >
                          {t("voice.kwsWordsReset")}
                        </button>
                      ) : null}
                    </div>
                    <textarea
                      className="field min-h-[64px] resize-y font-mono text-xs"
                      rows={3}
                      value={kwsWordsText}
                      placeholder={t("voice.kwsWordsPlaceholder")}
                      onChange={(e) => setKwsWordsText(e.target.value)}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={
                          kwsWordsErr
                            ? "text-xs text-red-500"
                            : "text-xs text-neutral-500 dark:text-neutral-400"
                        }
                      >
                        {kwsWordsErr || t("voice.kwsWordsHint")}
                      </span>
                      <button
                        className="pill pill-hover shrink-0 text-xs"
                        onClick={saveKwsWords}
                      >
                        {t("voice.kwsWordsSave")}
                      </button>
                    </div>
                  </div>
                  {/* 免手对话：转写完成自动发送，朗读结束回到待唤醒，朗读中说话可打断 */}
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
                    <div className="min-w-0">
                      <p className="text-xs text-neutral-600 dark:text-neutral-300">
                        {t("voice.freehand")}
                      </p>
                      <p className="mt-0.5 text-[11px] text-neutral-500">
                        {t("voice.freehandHint")}
                      </p>
                    </div>
                    <PillSwitch checked={freehand} onChange={toggleFreehand} />
                  </div>
                </div>
              )}
            </div>
          )}
          {/* 语音合成：引擎选择（本地/在线）、模型下载、参数调节与试听 */}
          <TtsCard t={t} />
          {/* 任务完成提示音：三档 + 音量 + 试听。系统气泡仍只由托盘那一处弹，这里只管出声 */}
          {notify && (
            <div className="card">
              <p className="text-sm font-medium">{t("ai.notifyTitle")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">{t("ai.notifyDesc")}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <select
                  className="field shrink-0"
                  value={notify.mode}
                  onChange={(e) => commitNotify(e.target.value, notify.volume)}
                >
                  <option value="default">{t("ai.notifyModeDefault")}</option>
                  <option value="custom">{t("ai.notifyModeCustom")}</option>
                  <option value="error-only">{t("ai.notifyModeErrorOnly")}</option>
                </select>
                <label className="flex min-w-[9rem] flex-1 items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <span className="shrink-0">{t("ai.notifyVolume")}</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={notify.volume}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setNotify((n) => ({ ...n, volume: v }));
                      clearTimeout(notifyDeb.current);
                      notifyDeb.current = setTimeout(() => commitNotify(notify.mode, v), 300);
                    }}
                  />
                  <span className="w-9 shrink-0 text-right tabular-nums">{notify.volume}</span>
                </label>
                <button
                  type="button"
                  className="pill pill-hover shrink-0 text-xs"
                  onClick={() => previewCompletion(true)}
                >
                  {t("ai.notifyPreview")}
                </button>
                <button
                  type="button"
                  className="pill pill-hover shrink-0 text-xs"
                  onClick={() => previewCompletion(false)}
                >
                  {t("ai.notifyPreviewFail")}
                </button>
                {
                  // 挑文件这件事不能只在 custom 档里出现：没有音频文件时切不到 custom，
                  // 那就永远点不到这颗按钮——所以三档下都给它摆在明面上。
                  <div className="flex w-full flex-wrap items-center gap-2">
                    <input
                      ref={notifyFileRef}
                      type="file"
                      accept=".mp3,.wav,.ogg,.m4a,.aac,.flac,audio/*"
                      className="hidden"
                      onChange={(e) => pickCustomSound(e.target.files?.[0])}
                    />
                    <button
                      type="button"
                      className="pill pill-hover shrink-0 text-xs"
                      disabled={pickingSound}
                      onClick={() => notifyFileRef.current?.click()}
                    >
                      {t("ai.notifyPickFile")}
                    </button>
                    <span
                      className="min-w-0 max-w-[14rem] truncate text-xs text-neutral-500"
                      title={notify.custom?.name || ""}
                    >
                      {notify.custom?.name || t("ai.notifyNoFile")}
                    </span>
                    {notify.custom?.bytes ? (
                      <span className="text-xs text-neutral-400 tabular-nums">
                        {(notify.custom.bytes / 1024).toFixed(0)} KB
                      </span>
                    ) : null}
                  </div>
                }
              </div>
              {notifyErr && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">{notifyErr}</p>
              )}
            </div>
          )}
        </div>
      </section>
      <section className="set-group" id="set-ai-prompt" style={gstyle("ai-prompt")}>
        <div className="set-grid">
          {/* 提示词模板库：对话页输入框星标按钮一键插入；清空全部保存 = 恢复内置默认 */}
          <div className="card flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">{t("ai.promptTemplates")}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {t("ai.promptTemplatesHint")}
                </p>
              </div>
              <button
                className="pill pill-hover shrink-0 text-xs"
                onClick={() =>
                  setTemplates((l) => [
                    ...(l || []),
                    { id: "", title: "", text: "" },
                  ])
                }
              >
                {t("ai.promptTemplatesAdd")}
              </button>
            </div>
            {(templates || []).map((tpl, i) => (
              <div
                key={i}
                className="border-t border-neutral-200/70 pt-3 dark:border-neutral-800/70"
              >
                <div className="flex items-center gap-2">
                  <input
                    className="field flex-1 text-xs"
                    placeholder={t("ai.promptTemplatesTitlePh")}
                    value={tpl.title}
                    onChange={(e) =>
                      setTemplates((l) =>
                        (l || []).map((x, j) =>
                          j === i ? { ...x, title: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <button
                    className="shrink-0 text-neutral-400 hover:text-red-500"
                    onClick={() =>
                      setTemplates((l) => (l || []).filter((_, j) => j !== i))
                    }
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
                <textarea
                  className="field mt-2 min-h-16 resize-y text-xs"
                  rows={3}
                  placeholder={t("ai.promptTemplatesTextPh")}
                  value={tpl.text}
                  onChange={(e) =>
                    setTemplates((l) =>
                      (l || []).map((x, j) =>
                        j === i ? { ...x, text: e.target.value } : x,
                      ),
                    )
                  }
                />
              </div>
            ))}
            <div className="flex flex-col gap-1.5 border-t border-neutral-200 pt-2 dark:border-neutral-800">
              <div>
                <p className="text-sm">{t("ai.tplHotkey")}</p>
                <p className="mt-0.5 text-xs text-neutral-500">{t("ai.tplHotkeyHint")}</p>
              </div>
              <div className="flex items-center gap-1">
                <input
                  className="field w-36 text-center font-mono text-xs"
                  value={tplHotkey}
                  placeholder={DEFAULT_TPL_HOTKEY}
                  onChange={(e) => setTplHotkey(e.target.value)}
                  onBlur={(e) => commitTplHotkey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitTplHotkey(e.currentTarget.value);
                      e.currentTarget.blur();
                    }
                  }}
                />
                <button
                  className="pill pill-hover shrink-0 text-xs"
                  onClick={() => commitTplHotkey(DEFAULT_TPL_HOTKEY)}
                >
                  {t("ai.tplHotkeyReset")}
                </button>
              </div>
              {tplHotkeyErr && (
                <span className="text-xs text-red-500">{tplHotkeyErr}</span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span
                className={
                  tplErr
                    ? "text-xs text-red-500"
                    : "text-xs text-neutral-500 dark:text-neutral-400"
                }
              >
                {tplErr || " "}
              </span>
              <button
                className="pill pill-hover shrink-0 text-xs"
                onClick={saveTemplates}
              >
                {tplSaved ? "✓" : t("common.save")}
              </button>
            </div>
          </div>
          {/* 系统提示词模板覆盖：完全替换内置 prompt；空=恢复默认 */}
          <div className="card flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">
                  {t("ai.systemPromptTitle")}
                </p>
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
          {/* 用户自定义提示词/人设：追加到 system prompt 开头 */}
          <div className="card flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">
                  {t("ai.customPromptTitle")}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {t("ai.customPromptDesc")}
                </p>
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
        </div>
      </section>
      <section className="set-group" id="set-ai-launch" style={gstyle("ai-launch")}>
        <div className="set-grid">
          {/* 开机自动启动：登录系统后后台驻留（托盘），写入系统登录项 */}
          <div className="card flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ai.autostartTitle")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {t("ai.autostartDesc")}
              </p>
            </div>
            <PillSwitch
              checked={!!autostart}
              disabled={autostart === null}
              onChange={toggleAutostart}
            />
          </div>
          {/* 阻止系统休眠：长任务/后台执行期间保持系统唤醒，屏幕仍按系统设置关闭 */}
          {sleepGuardSupported && (
            <div className="card flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("ai.preventSleepTitle")}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {t("ai.preventSleepDesc")}
                </p>
                {preventSleep && !sleepBlockActive && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    {t("ai.preventSleepFail")}
                  </p>
                )}
              </div>
              <PillSwitch
                checked={!!preventSleep}
                disabled={preventSleep === null}
                onChange={togglePreventSleep}
              />
            </div>
          )}
          {/* 托盘悬浮预览：鼠标停在图标上多久才弹状态小窗，0 = 不弹（划过托盘很常见，一碰就弹太吵） */}
          {trayHover && (
            <div className="card flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("ai.trayHoverTitle")}</p>
                <p className="mt-0.5 text-xs text-neutral-500">{t("ai.trayHoverDesc")}</p>
              </div>
              <select
                className="field shrink-0"
                value={String(trayHover.delay ?? 5000)}
                onChange={(e) => saveTrayHover(Number(e.target.value))}
              >
                <option value="0">{t("ai.trayHoverOff")}</option>
                {[1000, 2000, 5000, 10000].map((ms) => (
                  <option key={ms} value={String(ms)}>
                    {t("ai.trayHoverSeconds", { n: ms / 1000 })}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* 三个快捷键共用同一录入方式：先给组标题，说明只写一遍 */}
          <div className="card">
            <p className="text-sm font-medium">{t("ai.hotkeyGroupTitle")}</p>
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              {t("ai.hotkeyRecordHint")}
            </p>
          </div>
          {/* 全局快捷键：唤出主界面（窗口隐藏/最小化时也能系统级唤出） */}
          <div className="card flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ai.hotkeyTitle")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {t("ai.hotkeyDesc")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <HotkeyField
                value={hotkey}
                onChange={setHotkey}
                onRecorded={(v) => saveMainHotkey(v)}
                placeholder={{ idle: "Alt+Shift+B", record: t("ai.hotkeyPress") }}
                title={t("ai.hotkeyRecordTip")}
              />
              {hotkey && (
                <button
                  className="text-xs text-neutral-400 hover:text-red-500"
                  title={t("ai.hotkeyClear")}
                  onClick={() => {
                    setHotkey("");
                    saveMainHotkey("");
                  }}
                >
                  {t("common.clear")}
                </button>
              )}
              <button className="pill pill-hover text-xs" onClick={() => saveMainHotkey()}>
                {hotkeySaved ? "✓" : t("common.save")}
              </button>
            </div>
          </div>
          {hotkeyErr && (
            <p className="-mt-2 text-xs text-red-500 dark:text-red-400">
              {hotkeyErr}
            </p>
          )}
          {/* 截图提问：任意应用里框选截图，自动附到对话输入框（mac screencapture / win 截图快捷键 / linux grim 等） */}
          <div className="card flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ai.hotkeyScreenshot")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {t("ai.hotkeyScreenshotDesc")}
              </p>
              {appCaps && !appCaps.screenshot_supported && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {t("ai.hotkeyShotUnavailable")}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <HotkeyField
                value={shotHotkey}
                onChange={setShotHotkey}
                onRecorded={(v) => saveAppHotkeys({ screenshot: v })}
                placeholder={{ idle: "Control+Shift+A", record: t("ai.hotkeyPress") }}
                title={t("ai.hotkeyRecordTip")}
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
              <button
                className="pill pill-hover text-xs"
                onClick={() => saveAppHotkeys({ screenshot: shotHotkey })}
              >
                {appHkSaved === "screenshot" ? "✓" : t("common.save")}
              </button>
            </div>
          </div>
          {/* 全局语音：其他应用里按键说话，转写后粘贴回原前台应用（mac osascript / win keybd_event / linux xdotool） */}
          <div className="card flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ai.hotkeyVoice")}</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {t("ai.hotkeyVoiceDesc")}
              </p>
              {appCaps && !appCaps.paste_supported && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {t("ai.hotkeyPasteUnavailable")}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <HotkeyField
                value={voiceHotkey}
                onChange={setVoiceHotkey}
                onRecorded={(v) => saveAppHotkeys({ voice: v })}
                placeholder={{ idle: "Control+Shift+V", record: t("ai.hotkeyPress") }}
                title={t("ai.hotkeyRecordTip")}
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
              <button
                className="pill pill-hover text-xs"
                onClick={() => saveAppHotkeys({ voice: voiceHotkey })}
              >
                {appHkSaved === "voice" ? "✓" : t("common.save")}
              </button>
            </div>
          </div>
          {appHkErr && (
            <p className="-mt-2 text-xs text-red-500 dark:text-red-400">
              {appHkErr}
            </p>
          )}
        </div>
      </section>
      {/* 新增 / 编辑表单：悬浮弹窗（点遮罩关闭），平时不占页面空间。
          跟「模型提供方」同进同出——遮罩是 fixed 的，不跟着藏就会盖在别的卡片上；
          只藏不卸载，填了一半的表单不会因为切张卡就没了 */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          style={gstyle("ai-providers")}
          onClick={() => {
            setForm(EMPTY);
            setShowForm(false);
          }}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
            className="card flex max-h-[85vh] w-full max-w-lg flex-col gap-4 overflow-y-auto shadow-[inset_0_2px_14px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_2px_14px_rgba(0,0,0,0.45)]"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {editing ? t("ai.editProvider") : t("ai.addProvider")}
              </p>
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
              <label className="mb-1 block px-2 text-xs text-neutral-500">
                {t("ai.preset")}
              </label>
              <div className="flex flex-wrap gap-1.5 px-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => pickPreset(preset)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-200 ${
                      form.model === preset.model &&
                      form.base_url === preset.base
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
              <label className="mb-1 block px-2 text-xs text-neutral-500">
                {t("ai.protocol")}
              </label>
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
              <label className="mb-1 block px-2 text-xs text-neutral-500">
                {t("ai.nameLabel")}
              </label>
              <input
                className="field"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={`${t("ai.nameExample")}${protoLabel(form.protocol)}`}
              />
            </div>

            <div>
              <label className="mb-1 block px-2 text-xs text-neutral-500">
                Base URL
              </label>
              <input
                className="field font-mono"
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder={
                  PROTOCOLS.find((p) => p.id === form.protocol)?.base
                }
              />
            </div>

            <div>
              <label className="mb-1 block px-2 text-xs text-neutral-500">
                API Key
              </label>
              <input
                className="field font-mono"
                type="password"
                value={form.api_key}
                onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                placeholder={
                  form.protocol === "openai" ? "sk-…" : t("ai.keyPlaceholder")
                }
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between px-2">
                <label className="text-xs text-neutral-500">
                  {t("ai.model")}
                </label>
                <button
                  type="button"
                  onClick={fetchModels}
                  disabled={fetchingModels || !form.base_url.trim()}
                  className="text-xs text-neutral-500 transition-colors hover:text-neutral-900 disabled:opacity-40 dark:hover:text-white"
                  title={t("ai.fetchModelsTip")}
                >
                  {fetchingModels
                    ? t("ai.fetchingModels")
                    : t("ai.fetchModels")}
                </button>
              </div>
              <input
                className="field font-mono"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder={
                  PROTOCOLS.find((p) => p.id === form.protocol)?.model
                }
              />
              {fetchModelsErr && (
                <p className="mt-1 px-2 text-[11px] text-red-600">
                  {fetchModelsErr}
                </p>
              )}
              {baseHint && !fetchModelsErr && (
                <p className="mt-1 px-2 text-[11px] text-emerald-600 dark:text-emerald-400">
                  {baseHint}
                </p>
              )}
              {Array.isArray(remoteModels) && remoteModels.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto rounded-2xl border border-neutral-200/80 dark:border-neutral-800">
                  {remoteModels.map((m) => {
                    const id = typeof m === "string" ? m : m.id;
                    const len =
                      typeof m === "object" && m ? m.context_length : null;
                    const lenLabel = len
                      ? ` · ${len >= 1024 ? `${Math.round(len / 1024)}K` : len} ctx`
                      : "";
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, model: id }))}
                        className={`block w-full px-3 py-1.5 text-left font-mono text-[11px] transition-colors duration-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                          form.model === id
                            ? "text-neutral-900 dark:text-white"
                            : "text-neutral-500"
                        }`}
                      >
                        {id}
                        {lenLabel && (
                          <span className="float-right text-neutral-400">
                            {lenLabel}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {Array.isArray(remoteModels) && remoteModels.length === 0 && (
                <p className="mt-1 px-2 text-[11px] text-neutral-400">
                  {t("ai.noModels")}
                </p>
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
    </div>
  );
}
