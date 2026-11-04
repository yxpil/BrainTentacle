// 批量排查：6 个官方 wav × 官方词表/测试词表，看哪个组合能命中
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire("/tmp/bt-clone/voice-bridge/noop.js");
const sherpa = require("sherpa-onnx-node");

const dir = `${process.env.HOME}/Library/Application Support/com.bit.hub/voice`;
const INNER = "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01";

// 从 GitHub 包流式解出全部 6 个 wav（0~5）
const wavs = [];
for (let i = 0; i <= 5; i++) {
  const out = `/tmp/kws-probe/t${i}.wav`;
  try {
    execSync(
      `cd /tmp/kws-probe && bzcat kws.tar.bz2 2>/dev/null | tar xjf - -O "${INNER}/test_wavs/${i}.wav" > ${out} 2>/dev/null || true`
    );
    // 规范化为 44 字节头
    const d = readFileSync(out);
    let off = 12, pcm = null;
    while (off + 8 <= d.length) {
      const cid = d.subarray(off, off + 4), sz = d.readUInt32LE(off + 4);
      if (cid.toString() === "data") { pcm = d.subarray(off + 8, off + 8 + sz); break; }
      off += 8 + sz + (sz & 1);
    }
    if (!pcm) continue;
    const hdr = Buffer.concat([Buffer.from("RIFF"), structSize(36 + pcm.length), Buffer.from("WAVEfmt "),
      u32(16), u16(1), u16(1), u32(16000), u32(32000), u16(2), u16(16), Buffer.from("data"), u32(pcm.length)]);
    writeFileSync(`/tmp/kws-probe/t${i}-44.wav`, Buffer.concat([hdr, pcm]));
    wavs.push(`/tmp/kws-probe/t${i}-44.wav`);
  } catch { /* 流未到该成员 */ }
}
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function structSize(v) { return u32(v); }

function loadF32(path) {
  const wav = readFileSync(path);
  const pcm = wav.subarray(44);
  const n = Math.floor(pcm.length / 2);
  const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, n);
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) f32[i] = i16[i] / 32768;
  return f32;
}

function makeSpotter(kwFile, score) {
  return new sherpa.KeywordSpotter({
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
    keywordsFile: kwFile,
    keywordsScore: score,
    keywordsThreshold: 0.25,
    maxActivePaths: 4,
  });
}

const kws = [
  ["/tmp/kws-probe/test-kw.txt", "test词表"],
  ["/tmp/bt-clone/voice-bridge/kws-keywords.txt", "官方8词"],
];
for (const [kwFile, kwName] of kws) {
  for (const score of [1.0, 2.0]) {
    const spotter = makeSpotter(kwFile, score);
    for (const w of wavs) {
      const stream = spotter.createStream();
      const f32 = loadF32(w);
      let hit = null;
      for (let off = 0; off < f32.length; off += 8000) {
        stream.acceptWaveform({ sampleRate: 16000, samples: f32.subarray(off, Math.min(off + 8000, f32.length)) });
        while (spotter.isReady(stream)) {
          spotter.decode(stream);
          const r = spotter.getResult(stream);
          if (r?.keyword) { hit = r.keyword; break; }
        }
        if (hit) break;
      }
      console.log(`${kwName} score=${score} ${w.split("/").pop()} -> ${hit ?? "-"}`);
    }
  }
}
