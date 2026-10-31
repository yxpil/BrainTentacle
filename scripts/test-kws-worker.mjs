// KWS e2e：起 voice-worker（whisper-tiny 转写 + KWS 唤醒配置）→ /kws/start → 喂官方测试 wav → 期待命中
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const dir = `${home}/Library/Application Support/com.bit.hub/voice`;
const bridge = "/tmp/bt-clone/voice-bridge";

// t3.wav（官方 6 wav 之一）+ 测试词表：已验证能命中「文森特卡索」
const wav = readFileSync("/tmp/kws-probe/t3-44.wav");
const pcm = wav.subarray(44);

const cfg = {
  bridgeToken: "e2e-test",
  maxAudioBytes: 32 * 1024 * 1024,
  threads: 2,
  engine: "whisper",
  dir,
  encoder: `${dir}/whisper-tiny/encoder.int8.onnx`,
  decoder: `${dir}/whisper-tiny/decoder.int8.onnx`,
  tokens: `${dir}/whisper-tiny/tokens.txt`,
  vad: `${dir}/whisper-tiny/silero_vad.onnx`,
  kws: {
    encoder: `${dir}/kws/encoder.int8.onnx`,
    decoder: `${dir}/kws/decoder.onnx`,
    joiner: `${dir}/kws/joiner.int8.onnx`,
    tokens: `${dir}/kws/tokens.txt`,
    keywords: "/tmp/kws-probe/test-kw.txt", // 用官方测试词表（0.wav 对应「文森特卡索」），命中即闭环
    score: 1.0,
    threshold: 0.25,
    threads: 1,
  },
};

const worker = spawn(process.execPath, [`${bridge}/voice-worker.mjs`, JSON.stringify(cfg)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_SPEECH_TOKEN: "e".repeat(64) },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
worker.stdout.on("data", (d) => {
  stdout += d.toString();
  if (stdout.includes("\n")) {
    for (const line of stdout.split("\n")) {
      if (line.trim().startsWith("{")) console.log("WORKER:", line.trim());
    }
    stdout = stdout.split("\n").pop();
  }
});
worker.stderr.on("data", (d) => console.error("WORKER-ERR:", d.toString().trim().slice(0, 300)));

const ready = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("worker 30s 未就绪")), 30000);
  const onData = (d) => {
    const m = (stdout + d.toString()).match(/"port":(\d+)/);
    if (m) {
      clearTimeout(t);
      resolve(Number(m[1]));
    }
  };
  worker.stdout.on("data", onData);
});

const H = { authorization: "Bearer " + "e".repeat(64), "content-type": "application/octet-stream" };
const r1 = await fetch(`http://127.0.0.1:${ready}/kws/start`, { method: "POST", headers: H });
console.log("kws/start:", r1.status, await r1.json());

// 分块喂（每块 16000 采样 = 32000 字节，1 秒）
let hit = null;
for (let off = 0; off < pcm.length; off += 32000) {
  const chunk = pcm.subarray(off, Math.min(off + 32000, pcm.length));
  const rr = await fetch(`http://127.0.0.1:${ready}/kws/feed`, { method: "POST", headers: H, body: chunk });
  const j = await rr.json();
  if (j.hit) {
    hit = j.hit;
    break;
  }
}
console.log("KWS HIT:", hit ?? "(未命中)");
const r3 = await fetch(`http://127.0.0.1:${ready}/kws/stop`, { method: "POST", headers: H });
console.log("kws/stop:", r3.status, await r3.json());

// 顺带验证 whisper 转写链路（同一 wav 转写）
const r4 = await fetch(`http://127.0.0.1:${ready}/transcribe`, {
  method: "POST",
  headers: { authorization: "Bearer " + "e".repeat(64), "content-type": "application/octet-stream" },
  body: wav,
});
const j4 = await r4.json();
console.log("transcribe:", r4.status, JSON.stringify(j4).slice(0, 200));

worker.kill("SIGKILL");
process.exit(hit ? 0 : 2);
