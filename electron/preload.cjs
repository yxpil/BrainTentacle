// yxpil · BIT Electron preload
//! __TAURI_INTERNALS__ 兼容 shim：让 @tauri-apps/api@2 的源码零改动跑在 Electron 上。
//! 实现面（对照 node_modules/@tauri-apps/api 2.11 的实际调用点）：
//!   - transformCallback / unregisterCallback / invoke / convertFileSrc / metadata
//!   - plugin:event|listen/unlisten/emit（事件系统本地路由）
//!   - plugin:window|*（窗口命令 → IPC → 主进程 BrowserWindow）
//!   - plugin:app|version 等只读元信息
//!   - Tauri 系统事件等价物：tauri://focus|blur|move|drag-*（DOM 事件翻译）
//!   - data-tauri-drag-region 拖拽区（mousedown 左键 → start_dragging，双击 → 最大化切换）
const { ipcRenderer, contextBridge } = require('electron');

// ── 回调注册表：transformCallback 返回 id，事件到达时按 id 取回调用 ──
const callbacks = new Map(); // handlerId -> { fn }
let seq = 0;
const nextId = (prefix) => `${prefix}${++seq}`;

// ── 事件监听表：eventName -> Map<eventId, handlerId> ──
const eventListeners = new Map();

function deliverEvent(event, payload) {
  const m = eventListeners.get(event);
  if (!m) return;
  for (const [eventId, handlerId] of m) {
    const c = callbacks.get(handlerId);
    try {
      c?.fn?.({ event, id: eventId, payload });
    } catch (err) {
      console.error(`[bit:event] ${event} 处理器异常:`, err);
    }
  }
}

// ── core 事件入口（主进程 TSFN → webContents.send 广播到这里）──
ipcRenderer.on('bit:core-event', (_e, { event, payload }) => {
  deliverEvent(event, payload);
});

window.__TAURI_INTERNALS__ = {
  // 当前窗口/webview 标签（单窗口固定 main）
  metadata: {
    currentWindow: { label: 'main' },
    currentWebview: { label: 'main' },
  },

  transformCallback(fn, _once = false) {
    const id = nextId('cb');
    callbacks.set(id, { fn });
    return id;
  },

  unregisterCallback(id) {
    callbacks.delete(id);
  },

  // Tauri Windows 形态用 http://asset.localhost；这里统一走自注册的 bit-asset 标准协议
  convertFileSrc(filePath, _protocol = 'asset') {
    return `bit-asset://localhost/${encodeURIComponent(filePath)}`;
  },

  async invoke(cmd, args = {}) {
    // ── 事件插件：本地路由（监听表在 preload，事件广播由主进程统一下发）──
    if (cmd === 'plugin:event|listen') {
      const eventId = nextId('ev');
      let m = eventListeners.get(args.event);
      if (!m) {
        m = new Map();
        eventListeners.set(args.event, m);
      }
      m.set(eventId, args.handler); // args.handler 是 transformCallback 返回的 id
      return eventId;
    }
    if (cmd === 'plugin:event|unlisten') {
      eventListeners.get(args.event)?.delete(args.eventId);
      return null;
    }
    if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') {
      // 前端 → 应用事件：回主进程广播（与 Tauri emit 语义一致）
      ipcRenderer.send('bit:event-emit', { event: args.event, payload: args.payload });
      return null;
    }

    // ── 窗口命令：转发主进程 BrowserWindow ──
    if (cmd.startsWith('plugin:window|')) {
      return ipcRenderer.invoke('bit:window', cmd.slice('plugin:window|'.length), args);
    }

    // ── 应用元信息 ──
    if (cmd === 'plugin:app|version') return ipcRenderer.invoke('bit:version');
    if (cmd === 'plugin:app|name') return 'BIT';
    if (cmd === 'plugin:app|tauri_version') return '2.0.0';
    if (cmd === 'plugin:app|identifier') return 'com.bit.hub';
    if (cmd === 'plugin:app|bundle_type') return null;
    if (cmd.startsWith('plugin:app|')) return null;

    // ── 业务命令：透传 Rust dispatch（白名单查表）──
    return ipcRenderer.invoke('bit:invoke', cmd, args);
  },
};

// event.js 的 _unlisten 会调用（存在性即可，真正的清理在上面 unlisten 分支完成）
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener(event, eventId) {
    eventListeners.get(event)?.delete(eventId);
  },
};

// ── Tauri 系统事件等价物 ──
// 焦点/失焦：主进程窗口事件也发（下面 DOM 兜底，双通道幂等，监听表去重靠 handler 不去重也安全）
window.addEventListener('focus', () => deliverEvent('tauri://focus', {}));
window.addEventListener('blur', () => deliverEvent('tauri://blur', {}));

// 拖拽：HTML5 DnD → tauri://drag-enter/over/leave/drop（payload.paths 用 webUtils 取绝对路径）
const { webUtils } = require('electron');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  dragDepth++;
  if (e.dataTransfer?.types?.includes('Files')) {
    deliverEvent('tauri://drag-enter', { paths: [], position: { x: e.clientX, y: e.clientY } });
  }
});
document.addEventListener('dragover', (e) => {
  e.preventDefault(); // 允许 drop
  if (e.dataTransfer?.types?.includes('Files')) {
    deliverEvent('tauri://drag-over', { paths: [], position: { x: e.clientX, y: e.clientY } });
  }
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) deliverEvent('tauri://drag-leave', {});
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  const paths = [...(e.dataTransfer?.files || [])]
    .map((f) => {
      try {
        return webUtils.getPathForFile(f);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  deliverEvent('tauri://drag-drop', { paths, position: { x: e.clientX, y: e.clientY } });
});

// ── data-tauri-drag-region：与 Tauri core 注入行为一致 ──
// 左键按在带属性元素上 → 跟踪 mousemove 增量发主进程平移窗口；双击 → 最大化切换
let dragOrigin = null; // 起始屏幕坐标
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !e.target?.hasAttribute?.('data-tauri-drag-region')) return;
  dragOrigin = { x: e.screenX, y: e.screenY };
  ipcRenderer.send('bit:drag-start');
});
document.addEventListener('mousemove', (e) => {
  if (!dragOrigin) return;
  ipcRenderer.send('bit:drag-move', {
    dx: e.screenX - dragOrigin.x,
    dy: e.screenY - dragOrigin.y,
  });
});
document.addEventListener('mouseup', () => {
  if (!dragOrigin) return;
  dragOrigin = null;
  ipcRenderer.send('bit:drag-end');
});
document.addEventListener('dblclick', (e) => {
  if (!e.target?.hasAttribute?.('data-tauri-drag-region')) return;
  window.__TAURI_INTERNALS__.invoke('plugin:window|toggle_maximize', {});
});

// 诊断口：控制台可查 shim 状态
contextBridge; // 保持引用（避免 lint 误报未使用；实际导出走主世界直挂）
console.info('[BIT] __TAURI_INTERNALS__ shim 就绪');
