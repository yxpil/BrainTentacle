#!/usr/bin/env node
// yxpil · BIT · 语音合成子进程（在线引擎）
// 协议与 voice-bridge/voice-worker.mjs 完全同构：
//   argv[2]                 = JSON 配置（dataDir / baseUrls；不含密钥）
//   env DSH_TTS_TOKEN       = 64 位 hex 鉴权令牌（读到后立即从环境删除）
//   env DSH_TTS_KEYS        = JSON {"siliconflow":"","openai":""}（读后立即删除）
//   env DSH_TTS_DATA_DIR    = 数据目录（edge 音色列表缓存落这里）
//   就绪后 stdout 打一行 {"port":N}（stdout 唯一输出）；失败写 stderr 并 exit 1
//   HTTP 只监听 127.0.0.1 随机端口，全部要求 Authorization: Bearer <token>：
//     POST /synthesize {engine,text,voice,speed,pitch,volume} → {audioBase64,sampleRate,format}
//     GET  /voices?engine=edge → {voices:[...], groups:{lang:[...]}, cached:bool}
//
// 在线四分支：
//   edge        node-edge-tts（MIT），SSML rate/pitch/volume，429/5xx 退避重试
//   gtts        直连谷歌 translate TTS（无 key）
//   siliconflow POST {base_url}/v1/audio/speech + Bearer key
//   openai      POST {base_url}/v1/audio/speech + Bearer key

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);

const ENGINES = ["edge", "gtts", "siliconflow", "openai"];

// 默认 base_url（用户只填 key，不改端点；不做自定义 API 模板）
const DEFAULT_BASE_URLS = {
  siliconflow: "https://api.siliconflow.cn",
  openai: "https://api.openai.com",
};

// 在线引擎默认音色（与 Rust 侧 default_voice 保持一致）
const DEFAULT_VOICES = {
  edge: "zh-CN-XiaoxiaoNeural",
  siliconflow: "FunAudioLLM/CosyVoice2-0.5B:alex",
  openai: "alloy",
  gtts: "",
};

// 微软 Edge 语音列表端点（公开 trusted client token，与 edge-tts 生态一致）
const EDGE_VOICES_URL =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list" +
  "?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VOICES_TTL_MS = 24 * 60 * 60 * 1000; // 缓存一天

// 请求被拒绝、但服务可继续使用的输入类错误（400 而非 500）
class InputError extends Error {}

// 启动前失败：只向 stderr 写一行消息再退出
function fail(message) {
  process.stderr.write(`${message}\n`, () => process.exit(1));
}

function num(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// 读取 argv[2] 配置：dataDir / baseUrls；非法直接抛中文错误
function parseConfig() {
  let raw = {};
  try {
    raw = process.argv[2] ? JSON.parse(process.argv[2]) : {};
  } catch {
    throw new Error("配置参数（argv[2]）不是合法 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("配置参数必须是 JSON 对象");
  }
  const baseUrls = {};
  for (const engine of ["siliconflow", "openai"]) {
    const v = raw.baseUrls?.[engine];
    baseUrls[engine] =
      typeof v === "string" && v.trim() ? v.trim().replace(/\/+$/, "") : DEFAULT_BASE_URLS[engine];
  }
  return {
    dataDir:
      typeof raw.dataDir === "string" && raw.dataDir ? raw.dataDir : process.env.DSH_TTS_DATA_DIR || ".",
    baseUrls,
  };
}

// 语言检测（仅用于"引擎不支持该文本语言"的中文提示）
function detectLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  return "en";
}

// 文本 → gTTS 的 tl 参数（voice 可显式指定语言，否则按文本检测）
function gttsLanguage(voice, text) {
  const v = (voice || "").trim().toLowerCase();
  if (v && /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(v)) return v;
  return { zh: "zh-CN", en: "en", ja: "ja", ko: "ko", ru: "ru", ar: "ar" }[detectLanguage(text)];
}

// 从 Edge 音色名取 locale（zh-CN-XiaoxiaoNeural → zh-CN）
function edgeLang(voice) {
  const m = /^([a-z]{2,3}-[A-Z]{2})/.exec(voice || "");
  return m ? m[1] : "en-US";
}

// 指数退避：仅对 429 / 5xx / 网络错误重试，最多 5 次
async function withRetry(label, fn, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (error) {
      lastErr = error;
      const status = error?.status;
      const retriable = status === undefined || status === 429 || status >= 500;
      if (!retriable || i === attempts - 1) break;
      // 递增等待：1s、2s、4s、8s（上限 8s）
      const wait = Math.min(8000, 1000 * 2 ** i);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function httpError(status, detail) {
  const e = new Error(detail || `HTTP ${status}`);
  e.status = status;
  return e;
}

// 统一 fetch：超时 60 秒；网络错误折成中文
async function fetchWithTimeout(url, init = {}, ms = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (error) {
    throw new Error(
      `网络连接失败，请检查网络后重试（${error?.name === "AbortError" ? "请求超时" : error.message}）`
    );
  } finally {
    clearTimeout(timer);
  }
}

// 从 content-type / 字节头判断音频格式与采样率
function detectAudio(buffer, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("wav") || (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF")) {
    let sampleRate = 0;
    if (buffer.length >= 28) sampleRate = buffer.readUInt32LE(24);
    return { format: "wav", sampleRate: sampleRate || 24000 };
  }
  if (ct.includes("ogg") || buffer.subarray(0, 4).toString("ascii") === "OggS") {
    return { format: "ogg", sampleRate: 24000 };
  }
  return { format: "mp3", sampleRate: 24000 };
}

// ---------- 在线四分支 ----------

// EdgeTTS：node-edge-tts 落临时文件再读回（包本身只提供写文件接口）
async function synthesizeEdge(cfg, req) {
  let EdgeTTS;
  try {
    ({ EdgeTTS } = require("node-edge-tts"));
  } catch {
    throw new Error("缺少在线语音依赖 node-edge-tts，请先安装 voice-bridge 依赖");
  }
  const voice = req.voice || DEFAULT_VOICES.edge;
  const rate = `${Math.round((num(req.speed, 0.5, 2.0, 1.0) - 1) * 100) >= 0 ? "+" : ""}${Math.round(
    (num(req.speed, 0.5, 2.0, 1.0) - 1) * 100
  )}%`;
  const pitchHz = Math.round(num(req.pitch, -50, 50, 0));
  const pitch = `${pitchHz >= 0 ? "+" : ""}${pitchHz}Hz`;
  const volPct = Math.round((num(req.volume, 0, 1, 1) - 1) * 100);
  const volume = `${volPct >= 0 ? "+" : ""}${volPct}%`;
  const tts = new EdgeTTS({
    voice,
    lang: edgeLang(voice),
    outputFormat: "audio-24khz-48kbitrate-mono-mp3",
    rate,
    pitch,
    volume,
    saveSubtitles: false,
  });
  const tmpDir = path.join(cfg.dataDir, "tts", "tmp");
  await mkdir(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `edge-${randomUUID()}.mp3`);
  try {
    await withRetry("edge", () => tts.ttsPromise(req.text, file));
    const buffer = await readFile(file);
    if (!buffer.length) throw new Error("EdgeTTS 返回空音频");
    return { buffer, format: "mp3", sampleRate: 24000 };
  } finally {
    await unlink(file).catch(() => {});
  }
}

// gTTS：直连谷歌 translate TTS（无 key）；本机网络不通时给中文错误
async function synthesizeGtts(req) {
  const lang = gttsLanguage(req.voice, req.text);
  const speed = num(req.speed, 0.5, 2.0, 1.0);
  const ttsspeed = speed < 0.8 ? "0.24" : "1";
  const url =
    "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob" +
    `&tl=${encodeURIComponent(lang)}&ttsspeed=${ttsspeed}&q=${encodeURIComponent(req.text)}`;
  const resp = await withRetry("gtts", async () => {
    const r = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0 (BIT TTS)" },
    });
    if (!r.ok) throw httpError(r.status, `gTTS 返回 HTTP ${r.status}`);
    return r;
  });
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (!buffer.length) throw new Error("gTTS 返回空音频");
  return { buffer, format: "mp3", sampleRate: 24000 };
}

// SiliconFlow / OpenAI：OpenAI 兼容 /v1/audio/speech
async function synthesizeOpenAiCompatible(cfg, engine, req) {
  const key = cfg.keys[engine] || "";
  if (!key) {
    throw new InputError(
      engine === "siliconflow"
        ? "尚未配置 SiliconFlow API Key（请先在设置里填写）"
        : "尚未配置 OpenAI API Key（请先在设置里填写）"
    );
  }
  // SiliconFlow 的 CosyVoice 只覆盖中/英/日/韩/粤，其他语种明确提示
  if (engine === "siliconflow") {
    const lang = detectLanguage(req.text);
    if (!["zh", "en", "ja", "ko"].includes(lang)) {
      throw new InputError("SiliconFlow 引擎不支持该文本语言（仅支持中/英/日/韩）");
    }
  }
  const body = {
    model:
      engine === "siliconflow"
        ? process.env.DSH_TTS_SILICONFLOW_MODEL || "FunAudioLLM/CosyVoice2-0.5B"
        : process.env.DSH_TTS_OPENAI_MODEL || "gpt-4o-mini-tts",
    input: req.text,
    voice: req.voice || DEFAULT_VOICES[engine],
    response_format: "mp3",
    speed: num(req.speed, 0.25, 4.0, 1.0),
  };
  const url = `${cfg.baseUrls[engine]}/v1/audio/speech`;
  const resp = await withRetry(engine, async () => {
    const r = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let detail = "";
      try {
        detail = (await r.text()).slice(0, 300);
      } catch {
        /* 忽略读取错误 */
      }
      if (r.status === 401 || r.status === 403) {
        throw new InputError(`${engine === "siliconflow" ? "SiliconFlow" : "OpenAI"} API Key 无效或无权限`);
      }
      throw httpError(r.status, detail || `HTTP ${r.status}`);
    }
    return r;
  });
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (!buffer.length) throw new Error("在线语音服务返回空音频");
  const meta = detectAudio(buffer, resp.headers.get("content-type"));
  return { buffer, ...meta };
}

async function synthesize(cfg, req) {
  const engine = String(req.engine || "").trim();
  if (!ENGINES.includes(engine)) throw new InputError(`不支持的在线语音引擎：${engine}`);
  const text = String(req.text || "").trim();
  if (!text) throw new InputError("合成文本为空");
  if (text.length > 2000) throw new InputError("合成文本过长（上限 2000 字）");
  const normalized = { ...req, text, engine };
  switch (engine) {
    case "edge":
      return synthesizeEdge(cfg, normalized);
    case "gtts":
      return synthesizeGtts(normalized);
    default:
      return synthesizeOpenAiCompatible(cfg, engine, normalized);
  }
}

// ---------- 音色列表（Edge） ----------

// 微软音色：网络拉取 → 按语言分组 → 缓存到数据目录（失败时回退旧缓存）
async function edgeVoices(cfg) {
  const cacheFile = path.join(cfg.dataDir, "tts", "edge-voices.json");
  let cached = null;
  if (existsSync(cacheFile)) {
    try {
      cached = JSON.parse(await readFile(cacheFile, "utf8"));
    } catch {
      cached = null;
    }
  }
  if (cached && Array.isArray(cached.voices) && Date.now() - (cached.at || 0) < EDGE_VOICES_TTL_MS) {
    return { ...cached, cached: true };
  }
  try {
    const resp = await fetchWithTimeout(EDGE_VOICES_URL, { headers: { "User-Agent": "BIT-Agent" } }, 20000);
    if (!resp.ok) throw new Error(`语音列表返回 HTTP ${resp.status}`);
    const list = await resp.json();
    const voices = list.map((v) => ({
      shortName: v.ShortName,
      locale: v.Locale,
      gender: v.Gender,
      friendlyName: v.FriendlyName,
    }));
    const groups = {};
    for (const v of voices) {
      const lang = (v.locale || "").split("-")[0] || "other";
      (groups[lang] ||= []).push(v);
    }
    const payload = { voices, groups, at: Date.now() };
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(payload)).catch(() => {});
    return { ...payload, cached: false };
  } catch (error) {
    if (cached && Array.isArray(cached.voices)) return { ...cached, cached: true };
    throw new Error(`获取 Edge 音色列表失败：${error.message}`);
  }
}

// ---------- HTTP 服务 ----------

async function startServer(token, cfg) {
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      request.resume();
      reply(401, { error: "鉴权失败" });
      return;
    }
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/voices") {
      const engine = url.searchParams.get("engine") || "edge";
      if (engine !== "edge") {
        reply(400, { error: "仅 edge 引擎支持音色列表" });
        return;
      }
      edgeVoices(cfg).then(
        (v) => reply(200, v),
        (e) => reply(502, { error: e.message })
      );
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/synthesize") {
      request.resume();
      reply(404, { error: "未知接口" });
      return;
    }
    (async () => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
          throw new InputError("请求体过大");
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          throw new InputError("请求体不是合法 JSON");
        }
        const audio = await synthesize(cfg, body);
        reply(200, {
          audioBase64: audio.buffer.toString("base64"),
          sampleRate: audio.sampleRate,
          format: audio.format,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply(error instanceof InputError ? 400 : 502, { error: message });
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, port: server.address().port };
}

async function main() {
  const config = parseConfig();
  const token = process.env.DSH_TTS_TOKEN;
  if (!/^[a-f0-9]{64}$/.test(token ?? "")) {
    throw new Error("DSH_TTS_TOKEN 缺失或不是 64 位小写 hex");
  }
  // 密钥读取后立即从环境删除，不落盘、不进 argv
  let keys = { siliconflow: "", openai: "" };
  try {
    const raw = process.env.DSH_TTS_KEYS ? JSON.parse(process.env.DSH_TTS_KEYS) : {};
    keys = {
      siliconflow: typeof raw.siliconflow === "string" ? raw.siliconflow : "",
      openai: typeof raw.openai === "string" ? raw.openai : "",
    };
  } catch {
    keys = { siliconflow: "", openai: "" };
  }
  delete process.env.DSH_TTS_TOKEN;
  delete process.env.DSH_TTS_KEYS;
  const configWithKeys = { ...config, keys };
  const { port } = await startServer(token, configWithKeys);
  process.stdout.write(`${JSON.stringify({ port })}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
