#!/usr/bin/env node
// yxpil · BIT · 语音识别子进程
// 移植自 @deepseek-ai/dsh-experimental-speech-to-text-sensevoice 的 lib/worker.js（MIT 协议），
// 去掉 zod / schemastery / dsh 专有依赖，手写最简配置校验，唯一运行时依赖为 sherpa-onnx-node。
//
// 进程协议（与 dsh 原版一致，宿主侧见 crates/bit-core/src/voice.rs）：
//   argv[2]            = JSON 配置（model / tokens / vad 三个模型文件绝对路径 + 可选调参）
//   env DSH_SPEECH_TOKEN = 64 位 hex 鉴权令牌（读到后立即从环境删除，不落盘）
//   就绪后向 stdout 打一行 {"port":N}\n（stdout 唯一输出）；就绪前失败写 stderr 并 exit 1
//   HTTP 服务只监听 127.0.0.1 随机端口，POST /transcribe?language=xx，
//   要求 Authorization: Bearer <token>（timingSafeEqual 常量时间比较），
//   请求体为 WAV 字节，响应 {text, audioSeconds, inferenceSeconds}

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

// SenseVoice 支持的语言提示（与 dsh 原版 languages 一致）
const LANGUAGES = ["auto", "zh", "en", "yue", "ja", "ko"];

// 配置默认值（对照 dsh 原版 Config schema；此处不引入 zod，手写取值 + 夹取范围）
const DEFAULTS = {
  threads: 2,
  segmentSeconds: 30,
  vadThreshold: 0.5,
  minSpeechSeconds: 0.25,
  minSilenceSeconds: 0.5,
  vadOnsetPaddingSeconds: 0.3,
  maxAudioBytes: 4 * 1024 * 1024,
};

// 有界数值读取：非法/缺失回退默认值，再夹到 [min, max]
function num(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// 整数数值读取（同上，取整）
function int(v, min, max, dflt) {
  return Math.round(num(v, min, max, dflt));
}

// 启动前失败：只向 stderr 写一行消息再退出（宿主把 stderr 收进错误信息）
function fail(message) {
  process.stderr.write(`${message}\n`, () => process.exit(1));
}

// 读取并校验 argv[2] JSON 配置：按引擎确定模型路径组必填，其余键取默认值。
// 引擎协议（宿主 worker_config_json 生成）：
//   senseVoice / paraformer: model + tokens + vad
//   transducer: encoder + decoder + joiner + tokens + vad
//   whisper:    model + tokens + vad（tokens 为 .txt 词表）
function parseConfig() {
  let raw;
  try {
    raw = JSON.parse(process.argv[2]);
  } catch {
    throw new Error("配置参数（argv[2]）不是合法 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("配置参数必须是 JSON 对象");
  }
  const engine = typeof raw.engine === "string" && raw.engine ? raw.engine : "senseVoice";
  const groups = {
    senseVoice: ["model", "tokens", "vad"],
    paraformer: ["model", "tokens", "vad"],
    transducer: ["encoder", "decoder", "joiner", "tokens", "vad"],
    whisper: ["encoder", "decoder", "tokens", "vad"],
  };
  const keys = groups[engine];
  if (!keys) {
    throw new Error(`不支持的识别引擎: ${engine}`);
  }
  for (const key of keys) {
    if (typeof raw[key] !== "string" || raw[key].length === 0) {
      throw new Error(`配置缺少模型路径: ${key}（引擎 ${engine}）`);
    }
  }
  return {
    engine,
    model: raw.model,
    tokens: raw.tokens,
    vad: raw.vad,
    encoder: raw.encoder,
    decoder: raw.decoder,
    joiner: raw.joiner,
    // 唤醒（可选节）：路径组原样透传给 createKws
    kws: raw.kws && typeof raw.kws === "object" ? raw.kws : undefined,
    threads: int(raw.threads, 1, 16, DEFAULTS.threads),
    segmentSeconds: num(raw.segmentSeconds, 1, 120, DEFAULTS.segmentSeconds),
    vadThreshold: num(raw.vadThreshold, 0, 1, DEFAULTS.vadThreshold),
    minSpeechSeconds: num(raw.minSpeechSeconds, 0, 10, DEFAULTS.minSpeechSeconds),
    minSilenceSeconds: num(raw.minSilenceSeconds, 0.01, 10, DEFAULTS.minSilenceSeconds),
    vadOnsetPaddingSeconds: num(raw.vadOnsetPaddingSeconds, 0, 1, DEFAULTS.vadOnsetPaddingSeconds),
    maxAudioBytes: int(raw.maxAudioBytes, 46, 64 * 1024 * 1024, DEFAULTS.maxAudioBytes),
  };
}

// 校验请求语言：不在白名单直接拒绝（原生推理前拦下，识别器不受污染）
function normalizeLanguage(language) {
  if (!LANGUAGES.includes(language)) {
    throw new Error(`不支持的语言: ${language}（可选 ${LANGUAGES.join("/")}）`);
  }
  return language;
}

// 校验浏览器录制的 WAV：只接受规范的 16 kHz 单声道 PCM16（44 字节头，正好对齐
// 转写侧 byteOffset+44 的读法），并限制时长；移植自 dsh 的 validateWave
function validateWave(audio, maxDurationSeconds) {
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (
    data.length < 46 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WAVE" ||
    data.toString("ascii", 12, 16) !== "fmt " ||
    data.readUInt32LE(16) !== 16 ||
    data.readUInt16LE(20) !== 1 ||
    data.readUInt16LE(22) !== 1 ||
    data.readUInt32LE(24) !== 16000 ||
    data.readUInt32LE(28) !== 32000 ||
    data.readUInt16LE(32) !== 2 ||
    data.readUInt16LE(34) !== 16 ||
    data.toString("ascii", 36, 40) !== "data" ||
    data.readUInt32LE(4) !== data.length - 8 ||
    data.readUInt32LE(40) !== data.length - 44 ||
    (data.length - 44) % 2 !== 0
  ) {
    throw new Error("音频必须是规范的 16 kHz 单声道 PCM16 WAV 录音");
  }
  const seconds = (data.length - 44) / 32000;
  if (seconds > maxDurationSeconds) {
    throw new Error(`音频时长超过 ${maxDurationSeconds} 秒上限`);
  }
  return seconds;
}

// 触发请求前的完整校验（语言白名单 → 字节上限 → WAV 结构/时长），返回时长秒数
function validateInput(audio, language, maxAudioBytes) {
  normalizeLanguage(language);
  if (audio.byteLength > maxAudioBytes) {
    throw new Error("音频字节数超过识别服务上限");
  }
  return validateWave(audio, maxAudioBytes / 32000);
}

// 本请求被拒绝、但识别器保持可用的输入类错误（响应 400 而非 500）
class SpeechInputError extends Error {}

// 加载 native 模型（按引擎构建识别器 + Silero VAD），返回同步转写函数。
// 所有推理都在本进程内完成，宿主只经 HTTP 拿结果。
function createTranscriber(config) {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");

  // 按引擎组装 modelConfig（senseVoice / transducer / paraformer / whisper）
  // 注意：tokens/numThreads/provider/debug 必须在 modelConfig 内（顶层无效）
  function buildRecognizerConfig() {
    const common = {
      tokens: config.tokens,
      numThreads: config.threads,
      provider: "cpu",
      debug: 0,
    };
    const base = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
    };
    switch (config.engine) {
      case "senseVoice":
        base.modelConfig = {
          ...common,
          senseVoice: {
            model: config.model,
            language: "auto",
            useInverseTextNormalization: 1,
          },
        };
        break;
      case "transducer":
        base.modelConfig = {
          ...common,
          transducer: {
            encoder: config.encoder,
            decoder: config.decoder,
            joiner: config.joiner,
          },
          decodingMethod: "greedy_search",
        };
        break;
      case "paraformer":
        base.modelConfig = {
          ...common,
          paraformer: { model: config.model },
        };
        break;
      case "whisper":
        base.modelConfig = {
          ...common,
          whisper: {
            encoder: config.encoder,
            decoder: config.decoder,
            language: "auto",
            task: "transcribe",
          },
        };
        break;
      default:
        throw new Error(`不支持的识别引擎: ${config.engine}`);
    }
    return base;
  }

  const nativeConfig = buildRecognizerConfig();
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig);
  const detector = new sherpa.Vad(
    {
      sileroVad: {
        model: config.vad,
        threshold: config.vadThreshold,
        minSilenceDuration: config.minSilenceSeconds,
        minSpeechDuration: config.minSpeechSeconds,
        maxSpeechDuration: config.segmentSeconds,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: config.threads,
      provider: "cpu",
      debug: 0,
    },
    config.segmentSeconds + config.minSilenceSeconds + 1,
  );
  return (audio, language) => {
    let audioSeconds;
    try {
      audioSeconds = validateInput(audio, language, config.maxAudioBytes);
    } catch (error) {
      // 输入类错误：识别器保持可复用
      throw new SpeechInputError(error instanceof Error ? error.message : String(error));
    }
    // 44 字节规范头之后即 16 kHz 单声道 PCM16 采样，转成 [-1,1) 浮点
    const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44);
    const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768);
    // 每次录音按引擎切换语言提示并重置 VAD 状态
    if (nativeConfig.modelConfig.senseVoice) {
      nativeConfig.modelConfig.senseVoice.language = language;
    }
    if (nativeConfig.modelConfig.whisper) {
      // whisper 语言参数：auto 之外用小写 ISO 码；不支持时由原生侧兜底
      nativeConfig.modelConfig.whisper.language = language === "auto" ? "" : language;
    }
    recognizer.setConfig(nativeConfig);
    detector.reset();
    const started = performance.now();
    const texts = [];
    // 首段向前补一点起始静音，避免句首被 VAD 切掉半个字
    const onsetPadding = Math.round(config.vadOnsetPaddingSeconds * 16000);
    let isFirstSegment = true;
    const drain = () => {
      while (!detector.isEmpty()) {
        const segment = detector.front(false);
        let speech = segment.samples;
        if (isFirstSegment) {
          isFirstSegment = false;
          const from = Math.max(0, segment.start - onsetPadding);
          if (from < segment.start) {
            const restored = new Float32Array(segment.start - from + speech.length);
            restored.set(samples.subarray(from, segment.start));
            restored.set(speech, segment.start - from);
            speech = restored;
          }
        }
        const stream = recognizer.createStream();
        stream.acceptWaveform({
          sampleRate: 16000,
          samples: speech,
        });
        recognizer.decode(stream);
        texts.push(recognizer.getResult(stream).text.trim());
        detector.pop();
      }
    };
    // 按 512 采样窗口喂 VAD，边喂边取分段送识别
    for (let offset = 0; offset < samples.length; offset += 512) {
      detector.acceptWaveform(samples.subarray(offset, offset + 512));
      drain();
    }
    detector.flush();
    drain();
    return {
      text: texts.filter(Boolean).join(" ").trim(),
      audioSeconds,
      inferenceSeconds: (performance.now() - started) / 1000,
    };
  };
}

// ---------- 关键词唤醒（KWS，可选）：argv[2].kws 存在时启用 ----------
// 协议（宿主 voice.rs 生成 kws 配置）：
//   kws: { encoder, decoder, joiner, tokens, keywords, score?, threshold?, threads? }
// HTTP：POST /kws/start（建流） /kws/feed（PCM16 16k 原始字节） /kws/stop（重置）
// 命中：feed 响应 {"hit":"<关键词>"}，流已自动 reset 可继续喂

// KWS 运行态（懒初始化；spotter 只建一次，stream 可反复 reset）
let kwsState = null;

async function createKws(config) {
  if (!config.kws) return null;
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: config.kws.encoder, decoder: config.kws.decoder, joiner: config.kws.joiner },
      tokens: config.kws.tokens,
      numThreads: config.kws.threads,
      debug: 0,
      provider: "cpu",
    },
    keywordsFile: config.kws.keywords,
    keywordsScore: config.kws.score,
    keywordsThreshold: config.kws.threshold,
    maxActivePaths: 4,
  });
  return { spotter };
}

// 喂一块 PCM16 16k 音频；命中关键词时 reset 流并返回关键词，否则返回 null
function kwsFeed(state, pcm16) {
  if (!state?.stream) throw new Error("唤醒流未启动（先 POST /kws/start）");
  const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.byteLength / 2));
  const f32 = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) f32[i] = samples[i] / 32768;
  state.stream.acceptWaveform({ sampleRate: 16000, samples: f32 });
  while (state.spotter.isReady(state.stream)) {
    state.spotter.decode(state.stream);
    const r = state.spotter.getResult(state.stream);
    if (r && r.keyword) {
      state.spotter.reset(state.stream);
      return r.keyword;
    }
  }
  return null;
}

// KWS 路由：/kws/start、/kws/feed、/kws/stop；返回 true 表示已处理
function handleKwsRoute(kws, pathname, body, reply) {
  if (!pathname.startsWith("/kws/")) return false;
  if (!kws) {
    reply(404, { error: "本 worker 未启用唤醒（配置缺 kws 节）" });
    return true;
  }
  if (pathname === "/kws/start") {
    kwsState = { spotter: kws.spotter, stream: kws.spotter.createStream() };
    reply(200, { ok: true });
    return true;
  }
  if (pathname === "/kws/stop") {
    kwsState = null;
    reply(200, { ok: true });
    return true;
  }
  if (pathname === "/kws/feed") {
    try {
      const hit = kwsFeed(kwsState, body);
      reply(200, hit ? { hit } : { hit: null });
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  reply(404, { error: "未知接口" });
  return true;
}

// 绑定 127.0.0.1 随机端口的鉴权 HTTP 服务：Bearer 令牌常量时间比较，
// 模型加载完成后才调用本函数（就绪信号在监听成功后才发出）
async function startRecognitionServer(token, maxAudioBytes, transcribe, kws) {
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
    if (request.method === "POST" && url.pathname.startsWith("/kws/")) {
      // KWS：/kws/feed 的 body 是 PCM16 原始字节（0..maxAudioBytes），其余无 body
      (async () => {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          if (url.pathname === "/kws/feed" && (body.length < 2 || body.length > maxAudioBytes || body.length % 2 !== 0)) {
            reply(413, { error: "唤醒音频字节数不合法", code: "invalid-input" });
            return;
          }
          handleKwsRoute(kws, url.pathname, body, reply);
        } catch (error) {
          reply(500, { error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/transcribe") {
      request.resume();
      reply(404, { error: "未知接口" });
      return;
    }
    const length = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(length) || length < 46 || length > maxAudioBytes) {
      request.resume();
      reply(413, { error: "音频字节数不合法", code: "invalid-input" });
      return;
    }
    (async () => {
      try {
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        reply(200, transcribe(Buffer.concat(chunks), url.searchParams.get("language") ?? "auto"));
      } catch (error) {
        reply(error instanceof SpeechInputError ? 400 : 500, {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof SpeechInputError ? { code: "invalid-input" } : {}),
        });
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
  return {
    server,
    port: server.address().port,
  };
}

// 入口：读配置 → 读令牌（立即从环境删除）→ 加载模型 → 起服务 → 打印 {"port":N}
async function main() {
  const config = parseConfig();
  const token = process.env.DSH_SPEECH_TOKEN;
  if (!/^[a-f0-9]{64}$/.test(token ?? "")) {
    throw new Error("DSH_SPEECH_TOKEN 缺失或不是 64 位小写 hex");
  }
  delete process.env.DSH_SPEECH_TOKEN;
  const { port } = await startRecognitionServer(token, config.maxAudioBytes, createTranscriber(config), await createKws(config));
  process.stdout.write(`${JSON.stringify({ port })}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
