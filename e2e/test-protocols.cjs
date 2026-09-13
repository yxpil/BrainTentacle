// BIT 三协议格式验证：OpenAI / Anthropic Claude / Google Gemini
// 每个协议激活对应的 mock provider，发一个 mock-ai 能识别的 prompt，检查回复里是否有正确的标记
// 用法：先启动 mock-ai 和 fake_relay，然后 node e2e/test-protocols.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const BIN = path.resolve(
  process.argv[2] || path.join(__dirname, "..", "src-tauri", "target", "release", "bit.exe")
);
const CONFIG = path.join(os.homedir(), "AppData", "Roaming", "com.bit.hub", "ai_config.json");

// 三套 mock 提供方（protocol 字段决定 BIT 走哪条链路）
const PROVIDERS = [
  {
    id: "e2e-mock-openai-native",
    label: "OpenAI /v1/chat/completions",
    prompt: "E2E-PLAIN",
    expect: /E2E-FINAL-PLAIN/, // mock 返回的成功标记
  },
  {
    id: "e2e-mock-claude",
    label: "Anthropic Claude /v1/messages",
    prompt: "E2E-PLAIN",
    expect: /E2E-FINAL-PLAIN/,
  },
  {
    id: "e2e-mock-gemini",
    label: "Google Gemini /v1beta/models/...",
    prompt: "E2E-PLAIN",
    expect: /E2E-FINAL-PLAIN/,
  },
];

function readCfg() {
  return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
}
function writeCfg(cfg) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}
function activate(id) {
  const cfg = readCfg();
  cfg.providers.forEach((p) => (p.active = p.id === id));
  writeCfg(cfg);
}
function restoreMock() {
  const cfg = readCfg();
  cfg.providers.forEach((p) => (p.active = p.id.startsWith("e2e-mock") && p.id === "e2e-mock-provider"));
  writeCfg(cfg);
}

// 跑 bit tui，发 prompt，等回复，然后 /quit
// 返回 { ok, output, stderr }
function runOnce(prompt, timeoutMs = 40000) {
  return new Promise((resolve) => {
    const proc = spawn(BIN, ["tui"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_AT_BRIDGE: "1" },
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const t = setTimeout(() => {
      proc.kill();
      finish({ ok: false, output: out, stderr: err + "(timeout)" });
    }, timeoutMs);
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => finish({ ok: false, output: "", stderr: e.message }));
    proc.on("close", () => {
      if (settled) return;
      clearTimeout(t);
      finish({ ok: true, output: out, stderr: err });
    });
    setTimeout(() => proc.stdin.write(prompt + "\n"), 1500);
    setTimeout(() => {
      proc.stdin.write("/quit\n");
      setTimeout(() => proc.stdin.end(), 400);
    }, 15000); // 给 AI 15 秒回复
  });
}

async function main() {
  // 保存原始激活项
  const original = readCfg().providers.find((p) => p.active)?.id;

  console.log(`=== BIT 三协议格式验证 ===`);
  console.log(`二进制: ${BIN}\n`);

  let pass = 0;
  for (const prov of PROVIDERS) {
    process.stdout.write(`▶ ${prov.label.padEnd(35)} ... `);
    activate(prov.id);
    try {
      const r = await runOnce(prov.prompt);
      const ok = prov.expect.test(r.output);
      if (ok) {
        console.log("✅ PASS");
        pass++;
      } else {
        console.log("❌ FAIL");
        console.log(`   输出: ${r.output.trim().slice(-300)}`);
        if (r.stderr) console.log(`   err:  ${r.stderr.trim().slice(-200)}`);
      }
    } catch (e) {
      console.log(`❌ EXCEPTION: ${e.message}`);
    }
  }

  // 还原
  if (original) {
    activate(original);
  } else {
    restoreMock();
  }

  console.log(`\n结果: ${pass}/${PROVIDERS.length} 通过`);
  process.exit(pass === PROVIDERS.length ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
