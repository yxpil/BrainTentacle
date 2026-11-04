// KWS 直连调试：不经 HTTP，直接 node API 喂 wav，打印每次 decode 的结果
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/tmp/bt-clone/voice-bridge/noop.js");
const sherpa = require("sherpa-onnx-node");

const dir = `${process.env.HOME}/Library/Application Support/com.bit.hub/voice`;
const wav = readFileSync("/tmp/kws-probe/test0-44.wav");
const pcm = wav.subarray(44);
const n = Math.floor(pcm.length / 2);
const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, n);
const f32 = new Float32Array(n);
for (let i = 0; i < n; i++) f32[i] = i16[i] / 32768;

const spotter = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: `${dir}/kws/encoder.int8.onnx`,
      decoder: `${dir}/kws/decoder.onnx`,
      joiner: `${dir}/kws/joiner.int8.onnx`,
    },
    tokens: `${dir}/kws/tokens.txt`,
    numThreads: 1,
    provider: "cpu",
    debug: 0,
  },
  keywordsFile: "/tmp/kws-probe/test-kw.txt",
  keywordsScore: 1.0,
  keywordsThreshold: 0.25,
  maxActivePaths: 4,
});
const stream = spotter.createStream();

// 0.5s 块喂入（8000 采样）
const CHUNK = 8000;
let decoded = 0;
let shown = 0;
for (let off = 0; off < f32.length; off += CHUNK) {
  stream.acceptWaveform({ sampleRate: 16000, samples: f32.subarray(off, Math.min(off + CHUNK, f32.length)) });
  while (spotter.isReady(stream)) {
    spotter.decode(stream);
    decoded++;
    const r = spotter.getResult(stream);
    if (shown < 8) {
      console.log(`decode#${decoded} t=${(off / 16000).toFixed(1)}s`, JSON.stringify(r));
      shown++;
    }
    if (r && r.keyword) {
      console.log("HIT:", r.keyword);
      spotter.reset(stream);
    }
  }
}
console.log("total decodes:", decoded, "samples:", n, `${(n / 16000).toFixed(1)}s`);
