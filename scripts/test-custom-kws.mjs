// 自定义唤醒词 e2e：kws_set 带词表 → 检查生成文件 → worker HTTP 喂 t3.wav 应命中
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire("/tmp/bt-clone/crates/bit-napi/noop.js");
const b = require("/tmp/bt-clone/crates/bit-napi/bit_napi.node");

const home = process.env.HOME;
const customPath = `${home}/Library/Application Support/com.bit.hub/voice/kws-keywords-custom.txt`;
const words = [
  { word: "文森特卡索", pinyin: "wen2 sen1 te4 ka3 suo3" },
  { word: "小爱同学", pinyin: "xiao3 ai4 tong2 xue2" },
  { word: "小鑫", pinyin: "xiao3 xin1" },
];

b.hostStart();
const st = await new Promise((resolve) => {
  setTimeout(async () => {
    const r = await b.invoke("voice_kws_set", { enabled: true, score: 1.0, keywords: words });
    resolve(r);
  }, 1200);
});
console.log("kws:", JSON.stringify(st.kws));
console.log("custom file:", JSON.stringify(execSync(`cat "${customPath}" 2>&1`).toString()));

// 用 worker HTTP 喂 t3.wav（文森特卡索）
const http = st.kws && (await b.invoke("voice_status")).worker_http;
if (!http) {
  console.log("worker 未起（kws ready=false?）");
  process.exit(2);
}
const H = { authorization: `Bearer ${http.token}`, "content-type": "application/octet-stream" };
const r1 = await fetch(`http://127.0.0.1:${http.port}/kws/start`, { method: "POST", headers: H });
console.log("kws/start:", r1.status);
const wav = readFileSync("/tmp/kws-probe/t3-44.wav");
const pcm = wav.subarray(44);
let hit = null;
for (let off = 0; off < pcm.length; off += 32000) {
  const rr = await fetch(`http://127.0.0.1:${http.port}/kws/feed`, {
    method: "POST", headers: H, body: pcm.subarray(off, Math.min(off + 32000, pcm.length)),
  });
  const j = await rr.json();
  if (j.hit) { hit = j.hit; break; }
}
console.log("HIT:", hit ?? "(未命中)");
await fetch(`http://127.0.0.1:${http.port}/kws/stop`, { method: "POST", headers: H });
// 恢复默认词表，清理现场
await new Promise((r) => setTimeout(r, 300));
await b.invoke("voice_kws_set", { enabled: true, score: 1.0, keywords: [] });
console.log("reset default:", !require("node:fs").existsSync(customPath));
process.exit(hit ? 0 : 2);
