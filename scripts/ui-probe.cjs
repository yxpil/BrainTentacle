// yxpil · BIT UI 探针：CDP 连进真实渲染进程执行任意表达式并回传结果
//! 用法：node scripts/ui-probe.cjs "<expression>"  —— 拉起独立实例（BIT_DATA_DIR 隔离，
//!       不影响正在运行的正式实例），等主窗口就绪后 evaluate，打印 JSON 结果后退出。
//! 示例：node scripts/ui-probe.cjs "document.title"
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
// 每次运行独立端口+数据目录：多实例并行互不干扰（僵尸实例也不会锁住下一次测试）
const PORT = 9500 + (process.pid % 400);
const EXPR = process.argv[2];
if (!EXPR) { console.error('用法: node scripts/ui-probe.cjs "<js expression>"'); process.exit(2); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}

async function getMainPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${PORT}/json`);
      const t = list.find((x) => x.type === 'page' && !/tray-status/.test(x.url));
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('没找到主窗口调试目标');
}

function evaluate(ws, expr) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== id) return;
      ws.off('message', onMsg);
      if (m.error) return reject(new Error(m.error.message));
      const r = m.result?.result || {};
      if (r.subtype === 'error' || r.type === 'object' && r.className === 'Error') return reject(new Error(r.description || 'evaluate error'));
      resolve(r.value !== undefined ? r.value : r.description);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}

(async () => {
  const electron = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', '.bin', 'electron');
  const child = spawn(electron, [`--remote-debugging-port=${PORT}`, path.join(ROOT, 'electron', 'main.cjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      BIT_ELECTRON_DIST: '1',
      // BIT_PROBE_DATA_DIR 可指定固定目录：跨重启验证 bit.db 持久化
      BIT_DATA_DIR: process.env.BIT_PROBE_DATA_DIR || path.join(require('os').tmpdir(), `bit-ui-probe-${process.pid}`),
    },
    stdio: 'ignore',
  });
  try {
    const target = await getMainPageTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    await new Promise((r) => setTimeout(r, 2500)); // 等前端路由/数据就绪
    const out = await evaluate(ws, EXPR);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
    ws.close();
  } catch (e) {
    console.error('探针失败:', e.message);
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
})();
