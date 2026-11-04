'use strict';
/**
 * NetON 简易日志
 * 上游原本把日志追加到 <项目根>/logs/neton.log。被 BIT 宿主托管时不能这么干：
 * 插件包目录要当作只读看（清单校验基线也在包里），而宿主本来就抓 stdout/stderr
 * 进 WorkWith 的运行日志环，「服务」页展开就能看——所以托管态只写 stderr、不碰磁盘。
 * 自己 `node src/index.js` 跑着玩时（没有 BIT_PLUGIN_ID）仍按上游落文件。
 */
const fs = require('fs');
const path = require('path');

const HOSTED = !!process.env.BIT_PLUGIN_ID;
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'neton.log');

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
}

function ts() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function write(level, msg) {
  const line = `[${ts()}] [${level}] ${msg}\n`;
  if (HOSTED) {
    // 宿主接管进程：stderr 就是日志通道（WorkWith 逐行入环，界面「运行日志」可见）
    try { process.stderr.write(line); } catch (e) {}
    return;
  }
  try {
    ensureDir();
    fs.appendFileSync(LOG_FILE, line, 'utf8');
    if (level === 'ERROR') console.error('[neton]', line.trim());
    else console.log('[neton]', line.trim());
  } catch (e) {
    try { console.error('[logger-fail]', e.message, msg); } catch (_) {}
  }
}

function log(msg) { write('INFO', msg); }
function warn(msg) { write('WARN', msg); }
function error(msg, err) {
  const detail = err
    ? ` | ${err.message}` + (err.stack ? ' | Stack=' + err.stack.split('\n').slice(0, 8).join(' || ') : '')
    : '';
  write('ERROR', msg + detail);
}
function request(req, extra) {
  try {
    const line = `${extra || ''} ${req.method} ${req.url} host=${req.headers.host || ''} session=${(req.headers['mcp-session-id'] || '').slice(0, 12)}`;
    write('REQ', line);
  } catch (e) {}
}

module.exports = { log, warn, error, request };
