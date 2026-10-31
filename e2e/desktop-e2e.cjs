// yxpil · 整应用端到端（Linux / Xvfb、Windows 真桌面）
//! 起真的 Electron + 真的渲染层，用 Chromium 的假麦克风喂固定素材，把「语音输入 → 转写 →
//! 粘回原应用」「框选截图 → 挂附件」「在线合成」「全局语音事件通路」真跑一遍。
//! 覆盖的是任何单测都摸不到的那一层：renderer 取流/编码/调 core、主进程 hostCommand、
//! 剪贴板 → xdotool/keybd_event 注入、截图工具真被调用、事件回渲染层并落到 DOM。
//!
//! 平台差异：
//!   Linux   截图走 scrot + xdotool 画选区；粘贴走 xdotool（P1b/P3b/P4/P4b）
//!   Windows 截图走 ms-screenclip（交互式，CI 里不点）；粘贴走 keybd_event；
//!           P4b 额外用 PowerShell 从外部读回剪贴板，验证图片/文本被原样还原
//!
//! 前置（由 .github/workflows/desktop-e2e.yml 提供）：
//!   - dist/（vite 产物）、crates/bit-napi/bit_napi.node（cargo 产物改名落位）
//!   - voice-bridge 依赖 + Linux 系统里的 Xvfb / openbox / scrot / xdotool
//! 用法：xvfb-run -a node e2e/desktop-e2e.cjs   /   node e2e/desktop-e2e.cjs（Windows）
//! 环境：BIT_E2E_KEEP=1 保留数据目录；BIT_E2E_DISPLAY 指定 DISPLAY；
//!       BIT_E2E_SKIP_SCREENSHOT=1 / BIT_E2E_SKIP_VOICE=1 跳过对应探针（本机调试用）。
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FIXTURE_WAV = path.join(__dirname, "fixtures", "voice-e2e-zh.wav");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 进度行同时进 stdout 与数据目录里的 harness.log：CI 里某一步卡住时，日志文件
// 能说明卡在哪儿（stdout 有缓冲，进程被外部杀掉时可能整段丢失）
let logFile = null;
function say(...parts) {
  const line = parts.join(" ");
  process.stdout.write(line + "\n");
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch {}
  }
}

// ── 小工具 ───────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, env: process.env }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") })
    );
  });
}

// Windows：剪贴板与前台窗口都只能借 PowerShell 操作。
// -STA 是硬要求：System.Windows.Forms 的 Clipboard 在 MTA 线程上会抛 ThreadStateException。
function psRun(script, timeout = 30000) {
  return run("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout });
}

// 读剪贴板：优先读 Windows 的 PNG 自定义格式（Electron 写图片时一定有），
// 退到 CF_BITMAP。返回 { formats, png, pngLen, color:"R,G,B", text }
// 这是「另一只手」读：被测应用自称还原成功不算数，要外部程序真的读得回来。
const PS_CLIP_READ = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Read-Clip {
  $do = [System.Windows.Forms.Clipboard]::GetDataObject()
  if ($null -eq $do) { return @{ formats = @(); png = $false; pngLen = 0; color = $null; text = $null } }
  $o = @{ formats = @($do.GetFormats()); png = $false; pngLen = 0; color = $null; text = $null }
  if ($do.GetDataPresent('PNG')) {
    $raw = $do.GetData('PNG')
    if ($raw -is [System.IO.MemoryStream]) { $bytes = $raw.ToArray() } else { $bytes = [byte[]]$raw }
    if ($bytes.Length -gt 8) {
      $o.png = $true
      $o.pngLen = $bytes.Length
      $ms = New-Object System.IO.MemoryStream(,$bytes)
      $bmp = New-Object System.Drawing.Bitmap($ms)
      $c = $bmp.GetPixel(5,5)
      $o.color = "$($c.R),$($c.G),$($c.B)"
      $bmp.Dispose()
    }
  } elseif ($do.GetDataPresent('Bitmap')) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img) {
      $c = $img.GetPixel(5,5)
      $o.color = "$($c.R),$($c.G),$($c.B)"
      $img.Dispose()
    }
  }
  if ($do.GetDataPresent([System.Windows.Forms.DataFormats]::UnicodeText)) {
    $o.text = [string]$do.GetData([System.Windows.Forms.DataFormats]::UnicodeText)
  }
  return $o
}
$ok = $false
$res = $null
for ($i = 0; $i -lt 12 -and -not $ok; $i++) {
  try { $res = Read-Clip; $ok = $true } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $ok) { throw '剪贴板被占用，读取失败' }
$res | ConvertTo-Json -Compress`;

const PS_CLIP_SET_IMAGE = (r, g, b) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 40,40
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.Clear([System.Drawing.Color]::FromArgb(255,${r},${g},${b}))
$gfx.Dispose()
$ok = $false
for ($i = 0; $i -lt 12 -and -not $ok; $i++) {
  try { [System.Windows.Forms.Clipboard]::SetImage($bmp); $ok = $true } catch { Start-Sleep -Milliseconds 250 }
}
$bmp.Dispose()
if (-not $ok) { throw '剪贴板被占用，写入图片失败' }
'ok'`;

const PS_CLIP_SET_TEXT = (text) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$ok = $false
for ($i = 0; $i -lt 12 -and -not $ok; $i++) {
  try { [System.Windows.Forms.Clipboard]::SetText(${JSON.stringify(text)}); $ok = $true } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $ok) { throw '剪贴板被占用，写入文本失败' }
'ok'`;

async function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 800 });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}

// 让内核分配一个空闲端口（CDP 调试口不能写死：残留实例会把它占住）
function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error(`非 JSON 响应：${d.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject);
  });
}

// 轮询等待条件成立；返回条件值，超时抛错（带上最后一次观测值，便于定位）
async function until(what, fn, ms, every = 500) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`${what} 超时（${Math.round(ms / 1000)}s），最后观测：${JSON.stringify(last)}`);
}

// ── CDP 客户端（Node 22 原生 WebSocket）──────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const p = msg.id && this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p(msg);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 60000);
    });
  }
  // 在页面里求值并取回 JSON 值；页面内异常原样抛出
  async js(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面异常：${d.text || ""} ${d.exception?.description || d.exception?.value || ""}`.trim());
    }
    return r.result?.value;
  }
  // 走 preload shim → ipcRenderer.invoke('bit:invoke') → 主进程 hostCommand / Rust
  invoke(cmd, args = {}) {
    return this.js(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function connectCdp(port) {
  const pages = await until(
    "CDP 调试端口就绪",
    async () => {
      try {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        // 只认主窗口：托盘状态灯是 data:text/html 的离屏页，先到先得会连错目标
        const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url));
        if (!page) return null;
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = () => rej(new Error("WebSocket 连接失败"));
        });
        return { ws, url: page.url };
      } catch {
        return null;
      }
    },
    90000,
    500
  );
  return { cdp: new Cdp(pages.ws), url: pages.url };
}

// ── 探针框架 ─────────────────────────────────────────────────────
const results = [];
async function probe(name, fn, { hard = true } = {}) {
  const t0 = Date.now();
  say(`\n▶ ${name}`);
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true, hard, detail, ms });
    say(`✓ ${name}${detail ? ` — ${detail}` : ""} (${(ms / 1000).toFixed(1)}s)`);
    return true;
  } catch (e) {
    const ms = Date.now() - t0;
    results.push({ name, ok: false, hard, detail: e.message, ms });
    say(`${hard ? "✗" : "!"} ${name} — ${e.message} (${(ms / 1000).toFixed(1)}s)`);
    return false;
  }
}

// 截图/语音探针的最长等待：模型与内核下载都要留够
const WAIT_MODEL = Number(process.env.BIT_E2E_WAIT_MODEL || 15 * 60 * 1000);
const WAIT_EVENT = Number(process.env.BIT_E2E_WAIT_EVENT || 60 * 1000);
const WAIT_ASR = Number(process.env.BIT_E2E_WAIT_ASR || 180 * 1000);

(async () => {
  if (!fs.existsSync(FIXTURE_WAV)) throw new Error(`缺少固定素材：${FIXTURE_WAV}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bit-desktop-e2e-"));
  logFile = path.join(dataDir, "harness.log");
  const logs = []; // 主进程 stdout/stderr 环形缓冲（失败时打印尾部）
  const log = (src) => (d) => {
    const s = String(d);
    logs.push(s);
    if (logs.length > 800) logs.splice(0, 400);
    if (process.env.BIT_E2E_VERBOSE === "1") process.stdout.write(`[${src}] ${s}`);
  };
  const tail = (n = 40) => logs.join("").split("\n").filter(Boolean).slice(-n).join("\n");

  // 固定端口会被上一趟没退干净的实例占住（连上去的是别人的窗口，症状极难认），
  // 所以每趟挑一个空闲端口自己用
  const cdpPort = await pickPort();

  // 窗口管理器：Electron 焦点/激活行为在有 WM 时才是真实桌面语义（Xvfb 默认没有）
  let wm = null;
  if (process.env.DISPLAY) {
    const hasOpenbox = !(await run("which", ["openbox"])).err;
    if (hasOpenbox) {
      wm = spawn("openbox", [], { stdio: "ignore" });
      await sleep(800);
      say("(openbox 已启动)");
    } else {
      say("(无 openbox：焦点走 X 默认行为，粘贴探针可能不稳)");
    }
  }

  const electronExe = require("electron"); // 普通 node 下返回可执行文件路径
  const args = [
    "electron/main.cjs",
    "--no-sandbox",
    `--remote-debugging-port=${cdpPort}`,
    // 假麦克风：Chromium 内置假设备回放固定 WAV，渲染层 getUserMedia 拿到的就是这段人声
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${FIXTURE_WAV}`,
  ];
  const env = { ...process.env, BIT_DATA_DIR: dataDir, BIT_ELECTRON_DIST: "1" };
  // 冒烟日志与后台任务都不需要；但保留 BIT_SMOKE 会让应用自己退出，故显式清掉
  delete env.BIT_SMOKE;
  delete env.BIT_HEADLESS; // 必须真显示：截图/焦点/粘贴都依赖窗口在屏
  // detached：自成进程组，退出时整组杀掉。关窗=收进托盘，单发 SIGTERM 杀不掉 Electron
  const app = spawn(electronExe, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  app.stdout.on("data", log("main"));
  app.stderr.on("data", log("main:err"));
  app.on("exit", (c) => say(`(electron 退出 code=${c})`));
  // 外部中断也要把应用带走，否则下一趟会连到残留实例
  const sweep = () => {
    if (process.platform === "win32") {
      // Windows 没有进程组信号：taskkill /T 按父子树收掉 Electron 与它的 worker
      try {
        require("child_process").execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
      return;
    }
    try {
      process.kill(-app.pid, "SIGKILL");
    } catch {}
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => (sweep(), process.exit(130)));

  let cdp = null;
  let exitCode = 1;
  try {
    const conn = await connectCdp(cdpPort);
    cdp = conn.cdp;
    say(`(CDP 已连接：:${cdpPort} ${conn.url}；数据目录 ${dataDir})`);
    await cdp.send("Runtime.enable");

    // ── P0 启动与宿主能力 ─────────────────────────────────────
    await probe("P0 启动：shim + 渲染树 + core 命令通路", async () => {
      const st = await until(
        "渲染树挂载",
        async () => {
          const s = await cdp.js(`(() => {
            const root = document.getElementById('root');
            return { shim: !!window.__TAURI_INTERNALS__, root: root ? root.children.length : 0,
                     title: document.title, vis: document.visibilityState, href: location.href };
          })()`);
          // 直接返回对象会让 until 立刻成立（对象恒真），必须按条件给值
          return s && s.root > 0 ? s : null;
        },
        60000
      );
      if (!st.shim) throw new Error("__TAURI_INTERNALS__ 缺失（preload 未生效）");
      if (!/index\.html/.test(st.href)) throw new Error(`连到了非主窗口页面：${st.href.slice(0, 120)}`);
      if (st.vis !== "visible") throw new Error(`窗口不可见（${st.vis}）——Xvfb 里应显示`);
      const ov = await cdp.invoke("get_overview");
      if (typeof ov.tool_count !== "number") throw new Error(`get_overview 异常：${JSON.stringify(ov).slice(0, 200)}`);
      // 宿主机自报的能力位：证明 app 自己探到了截图后端与粘贴工具
      const hk = await cdp.invoke("get_app_hotkeys");
      const caps = hk?.caps || {};
      if (process.platform === "linux") {
        if (!caps.screenshot_supported) throw new Error(`截图后端不可用：${caps.screenshot_hint || "无提示"}`);
        if (!caps.paste_supported) throw new Error(`粘贴工具不可用：${caps.paste_hint || "无提示"}`);
      }
      if (process.platform === "win32") {
        // Windows 的截图走 ms-screenclip、粘贴走 keybd_event，两者都无外部依赖：
        // 能力位为假说明选择矩阵/平台判断写错了
        if (!caps.screenshot_supported) throw new Error(`截图后端不可用：${caps.screenshot_hint || "无提示"}`);
        if (!caps.paste_supported) throw new Error(`粘贴通道不可用：${caps.paste_hint || "无提示"}`);
      }
      return `title=${st.title} tools=${ov.tool_count} 截图=${caps.screenshot_backend || "-"} 粘贴=${caps.paste_tool || "-"}`;
    });

    // 复用：把当前窗口抬到最前（真实桌面语义：激活 + 输入焦点）
    const focusWindow = async () => {
      const title = await cdp.js("document.title");
      if (process.platform === "darwin") {
        // 没有 xdotool：借 System Events 把本进程拽到前台。
        // 未授予「自动化 → System Events」时会失败，调用方据此跳过焦点类断言。
        const r = await run("osascript", [
          "-e",
          `tell application "System Events" to set frontmost of (first process whose unix id is ${app.pid}) to true`,
        ]);
        if (r.err) throw new Error(`osascript 聚焦失败：${r.err.message}`);
        return String(app.pid);
      }
      if (process.platform === "win32") {
        // user32 SetForegroundWindow；被前台锁挡住时退到 WScript.Shell AppActivate。
        // 必须确认真的成了前台窗口：keybd_event 的 Ctrl+V 只会落到当前前台。
        const r = await psRun(`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace BIT -Name W -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'
$p = Get-Process -Id ${app.pid}
$p.Refresh()
$h = $p.MainWindowHandle
if ($h -eq [System.IntPtr]::Zero) { throw '主窗口句柄为空（窗口可能还没显示）' }
[BIT.W]::ShowWindow($h, 9) | Out-Null
[BIT.W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
if ([BIT.W]::GetForegroundWindow() -ne $h) {
  (New-Object -ComObject WScript.Shell).AppActivate(${app.pid}) | Out-Null
  Start-Sleep -Milliseconds 300
}
if ([BIT.W]::GetForegroundWindow() -ne $h) { throw '窗口未能成为前台窗口' }
$h.ToString()`);
        if (r.err) throw new Error(`PowerShell 聚焦失败：${(r.stderr || r.err.message).trim().split("\n").filter(Boolean).slice(-2).join(" ")}`);
        return r.stdout.trim();
      }
      let r = await run("xdotool", ["search", "--onlyvisible", "--name", title]);
      let ids = r.stdout.split("\n").filter(Boolean);
      if (!ids.length) {
        r = await run("xdotool", ["search", "--onlyvisible", "--class", "Electron"]);
        ids = r.stdout.split("\n").filter(Boolean);
      }
      if (!ids.length) throw new Error(`xdotool 找不到窗口（title=${title}）`);
      const id = ids[ids.length - 1];
      await run("xdotool", ["windowactivate", "--sync", id]);
      await run("xdotool", ["windowfocus", "--sync", id]);
      return id;
    };

    // 渲染层统一取草稿框（composer）：只有它是圆角 t-2xl 的多行输入
    const DRAFT_SEL = "textarea.rounded-t-2xl";
    const draftValue = () => cdp.js(`(document.querySelector(${JSON.stringify(DRAFT_SEL)}) || {}).value || ""`);
    const toastText = () => cdp.js(`document.body.innerText || ""`);
    // Windows 专用：外部视角读剪贴板（见 PS_CLIP_READ）
    const clipState = async () => {
      const r = await psRun(PS_CLIP_READ);
      if (r.err) {
        throw new Error(`读剪贴板失败：${(r.stderr || r.err.message).trim().split("\n").filter(Boolean).slice(-2).join(" ")}`);
      }
      try {
        return JSON.parse(r.stdout.trim());
      } catch {
        throw new Error(`剪贴板状态不是 JSON：${r.stdout.slice(0, 200)}`);
      }
    };
    const psErr = (r) => (r.stderr || r.err.message).trim().split("\n").filter(Boolean).slice(-2).join(" ");

    // ── P1a 附件事件通路（不依赖截图工具，三端都跑）───────────
    // 与主进程 sendToMain('screenshot-capture') 落到渲染层是同一个入口：
    // 渲染层 → emit → 主进程广播 → preload 分发给监听表 → React 状态 → DOM。
    await probe("P1a 附件事件通路：screenshot-capture → 输入框出现图片 + 提示", async () => {
      const before = await cdp.js(`document.querySelectorAll('img[src^="data:image"]').length`);
      // 1x1 透明 PNG：只为验证通路，不做像素断言
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      await cdp.invoke("plugin:event|emit", { event: "screenshot-capture", payload: { dataUrl: png } });
      const after = await until(
        "附件进 DOM",
        async () => {
          const n = await cdp.js(`document.querySelectorAll('img[src^="data:image"]').length`);
          return n > before ? n : null;
        },
        20000
      );
      const body = await toastText();
      if (!/截图已附到输入框|Screenshot attached/.test(body)) throw new Error("未出现「截图已附到输入框」提示");
      return `${before}→${after} 张`;
    });

    // ── P1b 框选截图 → 挂附件（真调系统的截图工具）───────────
    if (process.platform === "linux" && process.env.BIT_E2E_SKIP_SCREENSHOT !== "1") {
      await probe("P1b 框选截图：真调截图工具 → 事件回渲染层 → 输入框出附件", async () => {
        const before = await cdp.js(`document.querySelectorAll('img[src^="data:image"]').length`);
        // 与对话页剪刀按钮同一个 hostCommand；它立刻返回，真正框选在后台
        await cdp.invoke("screenshot_region", {});
        // 用 xdotool 画一个选区（对 scrot 的橡皮筋和 import 的区域选择都成立：
        // 按下→移动→抬起 = 矩形；单点会被当成取消/整窗）
        try {
          await sleep(1500);
          await run("xdotool", ["mousemove", "--sync", "120", "120"]);
          await run("xdotool", ["mousedown", "1"]);
          await sleep(300);
          await run("xdotool", ["mousemove", "--sync", "300", "200"]);
          await sleep(300);
          await run("xdotool", ["mousemove", "--sync", "620", "460"]);
          await sleep(300);
          await run("xdotool", ["mouseup", "1"]);
          const after = await until(
            "screenshot-capture 落到 DOM",
            async () => {
              // 先把主进程的失败行捞出来：框选工具失败时等待会一直空转到超时，
              // 只报「超时」等于把真正的死因藏起来
              const shotErr = logs.join("").match(/\[BIT\]\[shot\] (失败: .+|未产出图片.*)/);
              if (shotErr) throw new Error(`主进程截图未成功：${shotErr[1]}`);
              const n = await cdp.js(`document.querySelectorAll('img[src^="data:image"]').length`);
              return n > before ? n : null;
            },
            WAIT_EVENT
          );
          // 附件是真 PNG：dataUrl 足够长，且回填了提示文案
          const info = await cdp.js(`(() => {
            const imgs = [...document.querySelectorAll('img[src^="data:image"]')];
            const src = imgs[imgs.length - 1].src;
            return { len: src.length, png: src.startsWith('data:image/png;base64,') };
          })()`);
          if (!info.png || info.len < 2000) throw new Error(`附件不是有效 PNG：${JSON.stringify(info)}`);
          const body = await toastText();
          if (!/截图已附到输入框|Screenshot attached/.test(body)) throw new Error("未出现「截图已附到输入框」提示");
          return `${before}→${after} 张，dataUrl ${info.len} 字符`;
        } finally {
          // 框选工具选中时会独占指针/键盘（Esc 取消），没退出就会把后面的粘贴注入吃掉
          await run("pkill", ["-f", "scrot"]).catch(() => {});
        }
      });
    }

    // ── P2 在线合成（edge）：走 core 真出声 ───────────────────
    await probe("P2 在线合成：tts_speak(edge) 拿回可解码音频", async () => {
      const r = await cdp.invoke("tts_speak", { text: "联调自检：触手怪语音合成。", opts: { engine: "edge" } });
      const buf = Buffer.from(String(r?.audioBase64 || ""), "base64");
      if (buf.length < 2000) throw new Error(`音频过小：${buf.length} 字节`);
      const mp3 = buf[0] === 0xff || buf.slice(0, 3).toString("latin1") === "ID3";
      if (!mp3) throw new Error(`不是 MP3 帧头：${buf.slice(0, 4).toString("hex")}`);
      return `${buf.length} 字节 ${r.format} @${r.sampleRate}Hz`;
    });

    // ── P3 语音输入：全局语音事件 → 假麦克风录音 → 转写 → 粘回前台 ──
    if (process.env.BIT_E2E_SKIP_VOICE !== "1") {
      await probe("P3a 识别模型就绪（voice_prepare + 轮询）", async () => {
        let st = await cdp.invoke("voice_status");
        if (st?.ready) return `已就绪：${st.model_dir}`;
        await cdp.invoke("voice_prepare");
        st = await until(
          "识别模型就绪",
          async () => {
            const s = await cdp.invoke("voice_status");
            if (s?.error) throw new Error(`下载失败：${s.error}`);
            return s?.ready ? s : null;
          },
          WAIT_MODEL,
          3000
        );
        return `已就绪：${st.model_dir}`;
      });

      await probe("P3b 假麦克风录音 → 转写 → xdotool 粘回输入框", async () => {
        await focusWindow();
        // 焦点落到草稿框：粘贴注入的目标就是「当前焦点」
        await cdp.js(`(() => { const t = document.querySelector(${JSON.stringify(DRAFT_SEL)}); if (!t) throw new Error('找不到草稿框'); t.focus(); return document.activeElement === t; })()`);
        const before = await draftValue();
        // 与全局语音快捷键同一条链路：主进程 emit global-voice → 渲染层开录（假麦克风）
        const emit = () => cdp.invoke("plugin:event|emit", { event: "global-voice", payload: { bundleId: "" } });
        await emit();
        // 录 ~3 秒固定素材（素材本身约 2 秒，Chromium 会循环回放）
        await sleep(3200);
        await emit(); // 再触发一次 = 停止并转写
        const text = await until(
          "转写结果落地",
          async () => {
            const v = await draftValue();
            return v && v.length > before.length ? v.slice(before.length).trim() : null;
          },
          WAIT_ASR,
          1000
        );
        if (!/[\u4e00-\u9fff]{2,}/.test(text)) throw new Error(`转写结果不像中文：${JSON.stringify(text)}`);
        // 粘贴通道可用时结果应落到前台并提示「已粘贴到原应用」；不可用（macOS 未授权辅助功能
        // 等）时渲染层会兜底回草稿并提示「粘贴失败」——两种都算链路走通，但不能两种都没有。
        const capsNow = (await cdp.invoke("get_app_hotkeys"))?.caps || {};
        const body = await toastText();
        const pasted = /已粘贴到原应用|Pasted to the previous app/.test(body);
        const fellBack = /粘贴失败|Paste failed/.test(body);
        if (capsNow.paste_supported && !pasted) {
          throw new Error(`转写成功但剪贴板注入未成功（提示里没有「已粘贴到原应用」）：${text}`);
        }
        if (!capsNow.paste_supported && !fellBack) {
          throw new Error(`本机无粘贴通道（${capsNow.paste_hint || "-"}），但界面也没给出兜底提示：${text}`);
        }
        const st = await cdp.invoke("voice_status");
        if (!st?.worker_running) throw new Error("转写完成但识别 worker 未在运行");
        return `「${text}」${pasted ? "（已粘贴）" : "（转写结果回草稿）"}`;
      });
    }

    // ── P4 显式注入：paste_text_to_foreground → 模拟 Ctrl+V ─────
    // 与语音无关，单独跑：本机没有粘贴通道时只记录，不判失败
    if (process.env.BIT_E2E_SKIP_PASTE !== "1") {
      const capsNow = (await cdp.invoke("get_app_hotkeys"))?.caps || {};
      await probe(
        "P4 显式粘贴：hostCommand 写剪贴板 → Ctrl+V 落到焦点框",
        async () => {
          if (!capsNow.paste_supported) return `跳过：${capsNow.paste_hint || "本机无粘贴工具"}`;
          await focusWindow();
          await cdp.js(`(() => { const t = document.querySelector(${JSON.stringify(DRAFT_SEL)}); t.focus(); return true; })()`);
          const marker = `联调注入${Date.now()}`;
          const r = await cdp.invoke("paste_text_to_foreground", { text: marker });
          if (!r?.ok) throw new Error(`hostCommand 返回：${JSON.stringify(r)}`);
          await until(
            "标记文本进入输入框",
            async () => (await draftValue()).includes(marker),
            15000,
            300
          );
          return marker;
        },
        { hard: capsNow.paste_supported }
      );
    }

    // ── P4b 剪贴板还原（Windows）：粘贴借走剪贴板后，原图片/原文本要还回去 ──
    // 与截图提问共用同一条「图片回读」通道：captureWindows 靠 clipboardPngBase64
    // 从剪贴板取 ms-screenclip 的图，图片还原则走 clipboardWritePng。Electron 44
    // 删掉同步 readImage/writeImage 后，这里曾是静默失效且没有任何自动验证的角落。
    if (process.platform === "win32") {
      await probe("P4b 剪贴板还原：图片/文本粘贴后原内容回位（截图回读同一通道）", async () => {
        const COLOR = [12, 34, 56];
        const want = COLOR.join(",");
        const pasteAndWait = async (marker) => {
          await focusWindow();
          await cdp.js(`(() => { const t = document.querySelector(${JSON.stringify(DRAFT_SEL)}); t.focus(); return true; })()`);
          const r = await cdp.invoke("paste_text_to_foreground", { text: marker });
          if (!r?.ok) throw new Error(`hostCommand 返回：${JSON.stringify(r)}`);
          await until("标记文本进入输入框", async () => (await draftValue()).includes(marker), 15000, 300);
        };

        // ① 原剪贴板是一张图片
        const setImg = await psRun(PS_CLIP_SET_IMAGE(...COLOR));
        if (setImg.err) throw new Error(`写剪贴板图片失败：${psErr(setImg)}`);
        const pre = await clipState();
        if (pre.color !== want) throw new Error(`图片未按预期落到剪贴板：${JSON.stringify(pre).slice(0, 300)}`);
        await pasteAndWait(`贴图还原${Date.now()}`);
        const imgBack = await until(
          "剪贴板图片还原",
          async () => {
            const s = await clipState();
            return s.color === want ? s : null;
          },
          20000,
          700
        );

        // ② 原剪贴板是文本（图片场景下 writeText 与 write 的先后顺序也要正确）
        const txt = "BIT-CLIP-ORIGINAL";
        const setTxt = await psRun(PS_CLIP_SET_TEXT(txt));
        if (setTxt.err) throw new Error(`写剪贴板文本失败：${psErr(setTxt)}`);
        await pasteAndWait(`文本还原${Date.now()}`);
        await until(
          "剪贴板文本还原",
          async () => {
            const s = await clipState();
            return s.text === txt ? s : null;
          },
          20000,
          700
        );
        return `图片 ${want}（${imgBack.png ? `PNG ${imgBack.pngLen}B` : "DIB"}）+ 文本 ${txt} 均已还原`;
      });
    }

    // ── P5 热键注册（信息性）：注册表能写、宿主能读回 ──────────
    await probe(
      "P5 全局热键注册表写入/读回（信息性）",
      async () => {
        const saved = await cdp.invoke("get_app_hotkeys");
        const r = await cdp.invoke("set_app_hotkeys", { screenshot: null, voice: "Control+Alt+D" });
        const back = await cdp.invoke("get_app_hotkeys");
        if (back.voice !== "Control+Alt+D") throw new Error(`读回不一致：${JSON.stringify(back)}`);
        await cdp.invoke("set_app_hotkeys", { screenshot: null, voice: saved?.voice || "" });
        return `voice=${r?.voice} caps=${r?.caps?.paste_tool || "-"}`;
      },
      { hard: false }
    );

    const hard = results.filter((r) => r.hard);
    const bad = hard.filter((r) => !r.ok);
    exitCode = bad.length ? 1 : 0;
  } catch (e) {
    console.error(`\n[desktop-e2e] 异常：${e.message}`);
    console.error(`--- 主进程日志尾部 ---\n${tail(60)}`);
    exitCode = 1;
  } finally {
    // 先走应用自己的退出链，再兜底强杀（直接 SIGKILL 会留下半截 worker 子进程）
    try {
      await cdp?.invoke("quit_app", {});
    } catch {}
    try {
      cdp?.close();
    } catch {}
    await sleep(800);
    sweep();
    try {
      wm?.kill();
    } catch {}
    if (process.env.BIT_E2E_KEEP === "1") {
      console.log(`(保留数据目录：${dataDir})`);
    } else {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  }

  // ── 汇总 ───────────────────────────────────────────────────
  say("\n======== desktop-e2e 汇总 ========");
  for (const r of results) {
    const mark = r.ok ? "✓" : r.hard ? "✗" : "-";
    say(`${mark} ${r.name}${r.detail ? ` — ${r.detail}` : ""} (${(r.ms / 1000).toFixed(1)}s)`);
  }
  if (!results.length) {
    say(`没有跑到任何探针。主进程日志尾部：\n${tail(60)}`);
  }
  say(`==== desktop-e2e ${exitCode ? "FAIL" : "PASS"} ====`);
  process.exit(exitCode);
})().catch((e) => {
  console.error(`[desktop-e2e] 致命错误：${e.stack || e.message}`);
  process.exit(1);
});
