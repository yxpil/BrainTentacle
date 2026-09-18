// yxpil · BIT 原生弹窗/导航守卫自动化测试
//! 验证 Deep Customization 防呆全部生效（见 electron/main.cjs「原生提示框防呆」）：
//!   1) window.alert / confirm / prompt 在渲染层被禁用（Chrome 样式弹层永不出现）
//!   2) location.href 整窗跳转被 will-navigate 拦截（http(s) 转系统浏览器，窗口留在 SPA）
//!   3) window.open 被 setWindowOpenHandler 拦截
//! 用法：node scripts/guard-test.cjs（自行拉起带 remote-debugging 的 electron，跑完即收）
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function getMainPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${PORT}/json`);
      // 主界面 = 非 tray-status 的页面（tray 面板 title 是「任务面板」）
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
      m.error ? reject(new Error(m.error.message)) : resolve(m.result?.result?.value);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
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
      // 独立数据目录：绕开单实例锁（不影响正在运行的正式实例），测试数据随手可弃
      BIT_DATA_DIR: path.join(require('os').tmpdir(), 'bit-guard-test'),
    },
    stdio: 'ignore',
  });
  const results = [];
  try {
    const target = await getMainPageTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

    // 1) alert/confirm/prompt 全部静默降级
    results.push(['alert 被禁用', (await evaluate(ws, 'typeof window.alert === "function" && (window.alert("guard-test"), true)')) === true]);
    results.push(['confirm 返回 false（不弹窗）', (await evaluate(ws, 'window.confirm("guard-test")')) === false]);
    results.push(['prompt 返回 null（不弹窗）', (await evaluate(ws, 'window.prompt("guard-test")')) === null]);

    // 2) 整窗跳转被拦：location.href 赋值后窗口 URL 不变
    const before = await evaluate(ws, 'location.href');
    await evaluate(ws, 'location.href = "https://example.com/guard-test"; 0');
    await new Promise((r) => setTimeout(r, 1200));
    const after = await evaluate(ws, 'location.href');
    results.push([`整窗跳转被拦（${before.slice(0, 40)}… 不变）`, after === before]);

    // 3) window.open 被拦：返回 null
    results.push(['window.open 返回 null（转系统浏览器）', (await evaluate(ws, 'window.open("https://example.com/guard-test")')) === null]);

    // 4) 应用还活着（没有被跳转带走/崩溃）
    results.push(['渲染进程存活', (await evaluate(ws, '1 + 1')) === 2]);
    ws.close();

    let fail = 0;
    console.log('\n══ BIT 原生弹窗/导航守卫测试 ══');
    for (const [name, ok] of results) {
      console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`);
      if (!ok) fail++;
    }
    console.log(`══ ${results.length - fail}/${results.length} 通过 ══\n`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('测试执行失败:', e.message);
    process.exitCode = 2;
  } finally {
    try { child.kill(); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
})();
