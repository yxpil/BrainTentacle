// yxpil · 在线语音合成真出声自检（三端）
//! 本地内核有 cargo e2e 兜底，在线引擎（edge / gtts）此前只验证过「依赖装了没」这类
//! 状态位，从没真出过一段声音。这里直接拉起出厂的那条链路：spawn voice-bridge/tts-worker.mjs
//! （与 Rust 侧同一条 spawn 契约：argv[2] 配置 + DSH_TTS_TOKEN 64hex + stdout {"port":N}），
//! POST /synthesize 断言真的拿回一段可解码音频。
//! 覆盖的是「桥代码 + node-edge-tts + 厂商端点」三段，只有 API Key 类引擎（siliconflow/openai）
//! 需要密钥，CI 里没有，明确跳过。
//! 用法：node e2e/tts-online-check.cjs   （需先装 voice-bridge 依赖）
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WORKER = path.join(ROOT, "voice-bridge", "tts-worker.mjs");
const TIMEOUT_SYNTH = Number(process.env.BIT_TTS_CHECK_TIMEOUT || 90000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Check {
  constructor() {
    this.rows = [];
    this.failed = [];
  }
  record(name, ok, detail) {
    this.rows.push(`${ok === null ? "-" : ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (ok === false) this.failed.push(name);
    console.log(this.rows[this.rows.length - 1]);
  }
}

// worker 只在 stdout 打印一行 {"port":N}；其余输出留作失败诊断
function startWorker(dataDir, token) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify({ dataDir })], {
    env: { ...process.env, DSH_TTS_TOKEN: token, DSH_TTS_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`桥启动超时：${(out + err).slice(-400)}`)), 20000);
    const tick = setInterval(() => {
      const m = /"port"\s*:\s*(\d+)/.exec(out);
      if (child.exitCode !== null) {
        clearInterval(tick);
        clearTimeout(deadline);
        reject(new Error(`桥进程退出（${child.exitCode}）：${(out + err).slice(-400)}`));
        return;
      }
      if (m) {
        clearInterval(tick);
        clearTimeout(deadline);
        resolve(Number(m[1]));
      }
    }, 100);
  });
  return { child, ready, log: () => (out + err).slice(-600) };
}

function post(port, token, body, ms) {
  return new Promise((resolve, reject) => {
    const req = require("http").request(
      {
        host: "127.0.0.1",
        port,
        path: "/synthesize",
        method: "POST",
        timeout: ms,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(d);
          } catch {
            return reject(new Error(`响应不是 JSON（HTTP ${res.statusCode}）：${d.slice(0, 200)}`));
          }
          if (res.statusCode !== 200) return reject(new Error(json.error || `HTTP ${res.statusCode}`));
          resolve(json);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("合成超时")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

// MP3 帧头（FF Ex/FB）——只验「是一段音频」，不验内容
function looksLikeAudio(buf, format) {
  if (!buf.length) return "空音频";
  if (format === "mp3") {
    for (let i = 0; i < Math.min(buf.length - 1, 64); i += 1) {
      if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return "";
    }
    return "找不到 MP3 帧头";
  }
  if (buf.slice(0, 4).toString("latin1") === "RIFF") return "";
  return `未知格式 ${format}`;
}

(async () => {
  const c = new Check();
  if (!fs.existsSync(WORKER)) throw new Error(`找不到桥脚本：${WORKER}`);

  // 依赖装了才有意义（Rust 的 edge 就绪判定用的就是同一条目录检查）
  const depDir = path.join(ROOT, "voice-bridge", "node_modules", "node-edge-tts");
  c.record("voice-bridge 在线依赖已安装", fs.existsSync(depDir), depDir);
  if (!fs.existsSync(depDir)) {
    console.log("在线自检无法继续：缺 node-edge-tts");
    process.exit(1);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bit-tts-online-"));
  const token = crypto.randomBytes(32).toString("hex");
  const w = startWorker(dataDir, token);
  let exitCode = 0;
  try {
    const port = await w.ready;
    console.log(`(tts-worker ready :${port}, data_dir: ${dataDir})`);

    // ① 出厂默认引擎：edge（App 的 TTS 默认值就是它）——真出声，硬断言
    try {
      const r = await post(port, token, { engine: "edge", text: "联调自检：触手怪语音合成。" }, TIMEOUT_SYNTH);
      const buf = Buffer.from(String(r.audioBase64 || ""), "base64");
      const bad = looksLikeAudio(buf, r.format);
      c.record(
        "edge 在线合成真出声",
        !bad && buf.length > 2000,
        `${buf.length} 字节 ${r.format || "?"} @${r.sampleRate || "?"}Hz${bad ? ` — ${bad}` : ""}`
      );
    } catch (e) {
      c.record("edge 在线合成真出声", false, e.message);
    }

    // ② gtts：走 Google 端点，出口 IP 常被限流 → 只记录，不作闸门
    try {
      const r = await post(port, token, { engine: "gtts", text: "hello" }, TIMEOUT_SYNTH);
      const buf = Buffer.from(String(r.audioBase64 || ""), "base64");
      c.record("gtts 在线合成（参考）", null, `${buf.length} 字节 ${r.format || "?"}`);
    } catch (e) {
      c.record("gtts 在线合成（参考）", null, `跳过：${e.message}`);
    }

    // ③ 需密钥的引擎在 CI 里必然报「未配置 Key」——断言的是这条中文提示真的到位
    try {
      await post(port, token, { engine: "siliconflow", text: "hi" }, 20000);
      c.record("无密钥引擎返回可读错误", false, "居然合成成功了");
    } catch (e) {
      c.record("无密钥引擎返回可读错误", /Key/i.test(e.message), e.message);
    }

    // ④ 非法输入走 400（输入错误与上游错误分流，前端才能区分提示色）
    try {
      await post(port, token, { engine: "whisper", text: "hi" }, 20000);
      c.record("未知引擎被拒", false, "居然通过了");
    } catch (e) {
      c.record("未知引擎被拒", /不支持/.test(e.message), e.message);
    }
  } catch (e) {
    c.record("tts-worker 桥可用", false, `${e.message}\n桥日志：${w.log()}`);
  } finally {
    try {
      w.child.kill();
    } catch {}
    await sleep(300);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("");
  if (c.failed.length) {
    console.log(`==== tts-online-check FAIL：${c.failed.join(" / ")}`);
    exitCode = 1;
  } else {
    console.log("==== tts-online-check PASS");
  }
  process.exit(exitCode);
})().catch((e) => {
  console.error(`[tts-online-check] 异常：${e.stack || e.message}`);
  process.exit(1);
});
