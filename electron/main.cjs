// yxpil · BIT Electron 主进程
//! 从 Tauri 2 迁移的桌面壳（M2）：bit.node（napi-rs）承载全部核心逻辑，
//! 本文件只做 Electron 系统能力与 IPC 路由：
//!   1) 加载 bit.node → hostStart（Ctx 装载，数据目录与 Tauri 版同源 com.bit.hub）
//!   2) TSFN UI 事件 → 路由给渲染层（preload 的 __TAURI_INTERNALS__ shim 接收）
//!   3) invoke 路由：B 类宿主命令（对话框/自启/热键/提权/换装重启）JS 拦截，
//!      其余透传 Rust dispatch（白名单查表）
//!   4) bit-asset 协议替代 Tauri assetProtocol（convertFileSrc 的文件图片访问）
const { app, BrowserWindow, ipcMain, dialog, protocol, net, globalShortcut, Notification, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// ── userData 隔离：BIT_DATA_DIR 隔离数据目录时，Electron 层的 userData（单实例锁、
// GPU 缓存等）也一并隔离——否则多实例（E2E/多开）会因单实例锁直接退出
if (process.env.BIT_DATA_DIR) {
  app.setPath('userData', path.join(process.env.BIT_DATA_DIR, 'electron-userdata'));
}

// ── 守护进程兜底转交：electron.exe 不含 --bit-guardian 主循环（在 bit-cli 里）。
// arm() 正常经 worker_exe 直接拉 bit-cli；走到这里说明 sidecar 缺失——找得到就转交，找不到直接退出
// （由主进程 watchdog 5s 后重布防），绝不带着该参数进 GUI（否则无限重生循环）
if (process.argv.slice(1).includes('--bit-guardian')) {
  const cli = app.isPackaged
    ? path.join(process.resourcesPath, 'bit-cli.exe')
    : path.join(__dirname, '..', 'src-tauri', 'target', 'debug', 'bit-cli.exe');
  if (fs.existsSync(cli)) {
    require('child_process')
      .spawn(cli, process.argv.slice(process.argv.indexOf('--bit-guardian')), { stdio: 'ignore', detached: true, windowsHide: true })
      .unref();
  }
  process.exit(0);
}

// ── 单实例保护：二次启动唤起已有窗口（对应 tauri-plugin-single-instance）──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// bit-asset 协议特权：必须在任何 ready 之前注册（convertFileSrc shim 的文件访问通道）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bit-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

const isDev = !app.isPackaged;
const ROOT = path.join(__dirname, '..');
const VERSION = app.getVersion();
// napi 原生模块：开发期在 crates/bit-napi/，打包后在 resources
const NODE_PATH = isDev
  ? path.join(ROOT, 'crates', 'bit-napi', 'bit_napi.node')
  : path.join(process.resourcesPath, 'bit.node');
// worker sidecar（bit-cli）：存在即传给 Rust（子代理/后台 shell 用）；缺省 None 由 core 自行解析
const WORKER_EXE = isDev
  ? path.join(ROOT, 'src-tauri', 'target', 'debug', 'bit-cli.exe')
  : path.join(process.resourcesPath, 'bit-cli.exe');
// 应用图标：开发期在 src-tauri/icons，打包后在 resources（extraResources 注入）
const ICON = isDev
  ? path.join(ROOT, 'src-tauri', 'icons', 'icon.ico')
  : path.join(process.resourcesPath, 'icon.ico');

let bit = null; // bit.node 导出：hostStart / invoke / onUiEvent
let win = null;
let tray = null;
let quitting = false; // 真正退出（quit_app / app.quit）时置位：窗口关闭不再隐藏到托盘

// ── 托盘常驻（M3）：点击/菜单唤起主界面，退出走真正退出链 ──
function createTray() {
  try {
    tray = new Tray(ICON);
  } catch (e) {
    console.warn('[BIT] 托盘创建失败（不影响主流程）:', e.message);
    return;
  }
  tray.setToolTip('触手怪 Tentacle');
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: showWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 与前端 quit_app 同链路：expect_exit 通知守护进程 + core 收尾
        bit?.invoke('quit_app').catch(() => app.quit());
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow); // Windows 单击托盘图标
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ── core 事件路由：TSFN {event, payload} → 广播给渲染层（preload 本地有监听表）──
function routeCoreEvent(e) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('bit:core-event', e);
  } catch {
    /* 窗口关闭竞态：忽略 */
  }
  // 托盘/通知钩子在收到事件时顺带处理（M3）
  handleCoreEventHooks(e);
}

// ── 渲染层窗口命令映射（plugin:window|* → BrowserWindow）──
function monitorInfo(d) {
  if (!d) return null;
  return {
    name: d.label,
    scaleFactor: d.scaleFactor,
    position: { x: d.bounds.x, y: d.bounds.y },
    size: { width: d.bounds.width, height: d.bounds.height },
    workArea: {
      position: { x: d.workArea.x, y: d.workArea.y },
      size: { width: d.workArea.width, height: d.workArea.height },
    },
  };
}

function handleWindowOp(op, args) {
  if (!win) return null;
  const { screen } = require('electron');
  switch (op) {
    case 'show': win.show(); return null;
    case 'hide': win.hide(); return null;
    case 'close':
      // 与 Tauri 版一致：关闭窗口 = 隐藏到托盘（真正退出走 quit_app → quitting 置位）
      if (!quitting) {
        win.hide();
        return null;
      }
      return win.close();
    case 'destroy': return win.destroy();
    case 'minimize': win.minimize(); return null;
    case 'unminimize': win.restore(); return null;
    case 'maximize': win.maximize(); return null;
    case 'unmaximize': win.unmaximize(); return null;
    case 'toggle_maximize':
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return null;
    case 'is_maximized': return win.isMaximized();
    case 'is_minimized': return win.isMinimized();
    case 'is_visible': return win.isVisible();
    case 'is_focused': return win.isFocused();
    case 'is_fullscreen': return win.isFullScreen();
    case 'is_decorated': return !win.frame;
    case 'title': return win.getTitle();
    case 'outer_position': {
      const b = win.getBounds();
      return { x: b.x, y: b.y };
    }
    case 'inner_position':
    case 'outer_size': {
      const b = win.getBounds();
      return { width: b.width, height: b.height };
    }
    case 'inner_size': {
      const c = win.getContentBounds();
      return { width: c.width, height: c.height };
    }
    case 'set_position': {
      const p = args.position || args;
      win.setPosition(p.x, p.y);
      return null;
    }
    case 'set_size': {
      const s = args.size || {};
      win.setSize(s.width || win.getBounds().width, s.height || win.getBounds().height);
      return null;
    }
    case 'center': win.center(); return null;
    case 'set_focus': win.focus(); return null;
    case 'request_user_attention': win.show(); win.focus(); return null;
    case 'current_monitor': return monitorInfo(screen.getDisplayMatching(win.getBounds()));
    case 'primary_monitor': return monitorInfo(screen.getPrimaryDisplay());
    case 'available_monitors': return screen.getAllDisplays().map(monitorInfo);
    case 'scale_factor': return win.webContents.getZoomFactor() || 1;
    case 'set_title': win.setTitle(args.title || ''); return null;
    case 'start_dragging': {
      // Tauri 的 data-tauri-drag-region 由注入 JS 调用；Electron 等价物是相对鼠标的移动
      const { screen: sc } = require('electron');
      const p = sc.getCursorScreenPoint();
      const b = win.getBounds();
      win.setPosition(b.x + (p.x - (args._cursor?.x ?? 0)), b.y + (p.y - (args._cursor?.y ?? 0)));
      return null;
    }
    default:
      console.warn(`[BIT] 未实现的窗口命令: ${op}`);
      return null;
  }
}

// ── B 类宿主命令：JS 拦截（Tauri 里走 AppHandle/插件，Electron 原生能力等价实现）──
async function hostCommand(cmd, args) {
  switch (cmd) {
    // 原生另存为 + 复制（data:URL 解码落盘），与 Tauri 版返回形状一致
    case 'save_file_as': {
      const srcPath = args.path || '';
      const suggested = args.suggestedName || 'image.png';
      const isData = srcPath.startsWith('data:');
      const r = await dialog.showSaveDialog(win, {
        title: '保存为',
        defaultPath: suggested,
      });
      if (r.canceled || !r.filePath) return null; // 取消 → None
      if (isData) {
        const b64 = srcPath.slice(srcPath.indexOf(',') + 1);
        fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
      } else {
        if (!fs.existsSync(srcPath)) throw new Error(`文件不存在: ${srcPath}`);
        fs.copyFileSync(srcPath, r.filePath);
      }
      return r.filePath;
    }
    case 'get_autostart':
      return { enabled: app.getLoginItemSettings().openAtLogin };
    case 'set_autostart': {
      const enabled = !!args.enabled;
      app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
      return { enabled };
    }
    case 'set_hotkey': {
      // Tauri 版注册全局热键唤起主窗口；Electron 用 globalShortcut
      const hotkey = String(args.hotkey || '');
      return await ipcInvokeSetHotkey(hotkey);
    }
    case 'set_elevation': {
      // 高权限模式：UAC 弹窗后以管理员身份重启（Windows）
      const enabled = !!args.enabled;
      const { spawn } = require('child_process');
      const exe = process.execPath;
      if (process.platform === 'win32') {
        const verb = enabled ? 'RunAs' : undefined;
        const ps = `Start-Process -FilePath '${exe.replace(/'/g, "''")}'` + (verb ? ` -Verb ${verb}` : '');
        await new Promise((resolve, reject) => {
          spawn('powershell.exe', ['-NoProfile', '-Command', ps], { detached: true, windowsHide: true })
            .on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`授权被取消 (${code})`))))
            .on('error', reject);
        });
        await bit.invoke('quit_app', {});
        app.exit(0);
        return { active: enabled, enabled };
      }
      throw new Error('高权限模式仅支持 Windows');
    }
    case 'update_apply': {
      // 换装重启：静默更新已在退出路径落盘（quit_app → apply_update），这里仅优雅重启
      app.relaunch();
      await bit.invoke('quit_app', {});
      app.exit(0);
      return null;
    }
    default:
      return undefined; // 未拦截 → 透传 Rust
  }
}

// 热键注册（set_hotkey 的实现体）：core 配置 + globalShortcut 双写
async function ipcInvokeSetHotkey(hotkey) {
  if (globalShortcut) {
    globalShortcut.unregisterAll();
    if (hotkey && hotkey.trim()) {
      // Tauri 格式（如 Ctrl+Shift+B）与 Electron 兼容，直接注册
      try {
        globalShortcut.register(hotkey, () => {
          // Tauri 版语义：唤出/隐藏切换——已可见且聚焦时隐藏，否则唤出
          if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
            win.hide();
          } else {
            showWindow();
          }
        });
      } catch (e) {
        console.warn('[BIT] 热键注册失败:', e.message);
      }
    }
  }
  // 配置落盘走 core（get_hotkey 是 A 类命令，读的就是这份配置）
  return await bit.invoke('set_hotkey', { hotkey });
}

// ── bit-asset 协议：bit-asset://localhost/<encodeURIComponent(绝对路径)> ──
function handleAssetProtocol() {
  protocol.handle('bit-asset', (request) => {
    const u = new URL(request.url);
    // pathname 带前导 '/'，解码后即绝对路径（Windows 盘符 C%3A%5C → C:\）
    let p = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    if (!path.isAbsolute(p)) {
      // 非绝对路径（理论不发生）：拒绝
      return new Response('bad path', { status: 400 });
    }
    return net.fetch('file:///' + p.replace(/\\/g, '/'));
  });
}

// ── core 事件钩子：notify-done → 系统通知（对应 Tauri notify_done）；其余 M3 接托盘 ──
function handleCoreEventHooks(e) {
  if (e?.event === 'notify-done') {
    const p = e.payload || {};
    try {
      const n = new Notification({
        title: p.title ? `触手怪 · ${p.title}` : '触手怪',
        body: p.reply || '任务执行完成',
        icon: ICON,
      });
      n.on('click', () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      n.show();
    } catch {
      /* 通知失败不影响主流程 */
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 920,
    minHeight: 620,
    center: true,
    title: '触手怪',
    frame: false, // 前端自绘标题栏（与 Tauri decorations:false 一致）
    transparent: true,
    hasShadow: true,
    show: false, // 首帧渲染完成后由前端 invoke is_headless → win.show()
    backgroundColor: '#00000000',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: false, // 与 Tauri 模型一致：前端与 shim 同世界（回调函数可直达）
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.on('closed', () => {
    win = null;
  });

  // 冒烟模式（BIT_SMOKE=1）：渲染管线 console 转发 stdout，便于无窗诊断
  if (process.env.BIT_SMOKE === '1') {
    win.webContents.on('console-message', (_e, _level, message) => {
      console.log(`[renderer] ${message}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[renderer] GONE: ${JSON.stringify(details)}`);
    });
    win.webContents.on('preload-error', (_e, p, err) => {
      console.error(`[preload-error] ${p}: ${err}`);
    });
    win.webContents.on('did-finish-load', () => smokeCheck());
  }

  // BIT_ELECTRON_DIST=1：dev 下也加载 dist 产物（E2E 无需 vite dev server）
  if (isDev && process.env.BIT_ELECTRON_DIST !== "1") {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  }
}

// ── GUI 冒烟（BIT_SMOKE=1，配合 BIT_HEADLESS=1 不弹窗）：
// shim 挂载 + 渲染树非空 + core 命令通路 → PASS 退出码 0，任一失败退出码 1 ──
async function smokeCheck() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      await wait(Number(process.env.BIT_SMOKE_WAIT) || 2500); // React 挂载 + 首个 invoke 往返
      const state = await win.webContents.executeJavaScript(
        `JSON.stringify({
           shim: !!window.__TAURI_INTERNALS__,
           root: document.getElementById('root')?.children?.length ?? 0,
           title: document.title,
           rootHtml: (document.getElementById('root')?.innerHTML || '').slice(0, 200),
         })`
      );
      const s = JSON.parse(state);
      console.log(`[smoke] shim=${s.shim} root=${s.root} title=${s.title} rootHtml=${s.rootHtml}`);
    if (!s.shim || s.root === 0) throw new Error('渲染树未挂载或 shim 缺失');
    const overview = await bit.invoke('get_overview');
    console.log(`[smoke] get_overview tools=${overview.tool_count}`);
    if (typeof overview.tool_count !== 'number') throw new Error('core 命令通路异常');
    console.log('[smoke] PASS');
    app.exit(0);
  } catch (e) {
    console.error('[smoke] FAIL:', e.message || e);
    app.exit(1);
  }
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  handleAssetProtocol();
  try {
    bit = require(NODE_PATH);
  } catch (e) {
    dialog.showErrorBox('触手怪', `原生模块加载失败：\n${e.message}\n\n请重新构建 bit-napi。`);
    app.exit(1);
    return;
  }

  // 宿主点火：数据目录默认 %APPDATA%/com.bit.hub（与 Tauri 版共享 bit.db）；
  // BIT_DATA_DIR 可隔离（E2E/冒烟不污染真实数据）。
  // app_args：guardian 复活时透传给 electron.exe（裸拉只会打开默认欢迎页）
  const workerExe = fs.existsSync(WORKER_EXE) ? WORKER_EXE : null;
  await bit.hostStart(
    process.env.BIT_DATA_DIR || null,
    VERSION,
    workerExe,
    process.execPath,
    JSON.stringify([__filename]),
  );

  // UI 事件回流：TSFN → 渲染层广播 + 托盘/通知钩子
  bit.onUiEvent(routeCoreEvent);

  // 优雅退出：core quit_app → ElectronHostHooks::exit_app → 这里 app.quit()
  // （before-quit 里做 globalShortcut 清理；core 侧的硬退 exit(0) 仅兜底）
  bit.onHostExit(() => {
    app.quit();
  });

  // invoke 路由：B 类宿主命令 JS 拦截，其余透传 Rust dispatch
  ipcMain.handle('bit:invoke', async (_e, cmd, args) => {
    try {
      const intercepted = await hostCommand(cmd, args || {});
      if (intercepted !== undefined) return intercepted;
      return await bit.invoke(cmd, args || {});
    } catch (err) {
      throw new Error(typeof err === 'string' ? err : err.message || String(err));
    }
  });

  ipcMain.handle('bit:window', (_e, op, args) => {
    try {
      return handleWindowOp(op, args || {});
    } catch (err) {
      console.warn(`[BIT] 窗口操作 ${op} 失败:`, err.message);
      return null;
    }
  });

  ipcMain.handle('bit:version', () => VERSION);

  // 前端 → 应用事件广播（多窗口场景；当前单窗口）
  ipcMain.on('bit:event-emit', (_e, { event, payload }) => {
    routeCoreEvent({ event, payload });
  });

  // 自绘标题栏拖拽：preload 跟踪 mousemove 增量，这里按起始 bounds 平移窗口
  let dragOrigin = null;
  ipcMain.on('bit:drag-start', () => {
    if (win && !win.isDestroyed()) dragOrigin = win.getBounds();
  });
  ipcMain.on('bit:drag-move', (_e, { dx = 0, dy = 0 } = {}) => {
    if (!win || win.isDestroyed() || !dragOrigin) return;
    win.setPosition(dragOrigin.x + dx, dragOrigin.y + dy);
  });
  ipcMain.on('bit:drag-end', () => {
    dragOrigin = null;
  });

  // 托盘常驻（M3）+ 启动时按配置注册全局热键（与 Tauri 版 setup 行为一致）
  createTray();
  try {
    const hk = await bit.invoke('get_hotkey', {});
    await ipcInvokeSetHotkey(String(hk?.hotkey || ''));
  } catch (e) {
    console.warn('[BIT] 启动热键注册失败:', e.message);
  }

  // core 服务 bootstrap（守护进程/HTTP 服务/插件/autopilot/自动更新）
  try {
    await bit.invoke('bootstrap_services', {});
  } catch (e) {
    console.error('[BIT] bootstrap_services 失败:', e.message || e);
  }

  createWindow();

  app.on('activate', () => {
    if (!win) createWindow();
  });
});

// 窗口全部关闭 ≠ 退出：托盘常驻（M3 实现托盘后语义不变）
app.on('window-all-closed', () => {
  // 不退出：与 Tauri 版「关闭即隐藏到托盘」一致
});

// 真正退出由 quit_app（guardian 握手 + 静默更新 + exit(0)）触发；
// before-quit 里补 Electron 层清理 + 置位 quitting（窗口关闭不再隐藏到托盘）
app.on('before-quit', () => {
  quitting = true;
  try {
    globalShortcut?.unregisterAll();
  } catch {}
  try {
    tray?.destroy();
    tray = null;
  } catch {}
});
