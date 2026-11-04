'use strict';
/**
 * NetON 的 BIT 插件启动入口（上游 src/index.js 的插件化改写）
 *
 * 三处必要的适配：
 *  1. 端口：优先用宿主分配的 BIT_PLUGIN_PORT（清单里 port=0 = 让 BIT 找空闲端口再下发），
 *     自己双击运行时回退 NETON_PORT / 3000；
 *  2. 只绑 127.0.0.1：这是一台会主动探测主机的服务，不接受用外部环境变量把它暴露到局域网；
 *  3. 作用域护栏（NETON_SCOPE=loopback，夹具默认开）：只允许对回环地址做端口/协议探测，
 *     拒绝扫描真实网段、拒绝 pktmon 抓网卡流量——测试夹具不该动用户家的网络。
 *     想看完整能力就把 NETON_SCOPE 设成 full（在插件的托管服务条目里改 env，或自己命令行跑）。
 */
const { McpStreamableHttpServer } = require('./neton/mcp/server');
const { executeTool } = require('./neton/tools/registry');
const logger = require('./neton/utils/logger');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BIT_PLUGIN_PORT || process.env.NETON_PORT || process.env.PORT || 3000);
const SCOPE = String(process.env.NETON_SCOPE || 'loopback').trim().toLowerCase();
const MAX_PORTS = 256;

process.on('uncaughtException', (err, origin) => logger.error('[uncaughtException] origin=' + origin, err));
process.on('unhandledRejection', (reason) => logger.error('[unhandledRejection]', reason instanceof Error ? reason : new Error(String(reason))));

/** 回环判定：127.x.x.x / localhost / ::1，CIDR 与区间只看首地址是不是回环 */
function isLoopback(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return false;
  if (t === 'localhost' || t === '::1') return true;
  const head = t.split(/[,\/\-]/)[0];
  return /^127\./.test(head);
}

/** 把 target / subnet 拆成原子项（逗号、空格、CIDR、区间都算一项） */
function targetsOf(args) {
  const out = [];
  for (const key of ['target', 'subnet']) {
    const v = args && args[key];
    if (v === undefined || v === null) continue;
    String(v).split(/[,\s]+/).forEach((p) => { if (p) out.push(p); });
  }
  return out;
}

/** 端口写法粗算数量：all / 大区间在回环护栏里一律挡掉（对自己机器打 6.5 万次连接不是测试需要的东西） */
function portSpread(ports) {
  const s = String(ports || 'common').trim().toLowerCase();
  if (s === 'all') return Infinity;
  if (s === 'common' || s === 'top100' || s === '') return 32;
  let n = 0;
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)-(\d+)$/);
    n += m ? Math.abs(Number(m[2]) - Number(m[1])) + 1 : 1;
  }
  return n;
}

function runTool(name, args) {
  if (SCOPE !== 'loopback') return executeTool(name, args);
  if (name === 'device_discovery' || name === 'network_scan') {
    throw new Error(`[neton-scope] 夹具作用域=${SCOPE}：这两个工具会扫整段局域网/读 ARP 表，本夹具不放行。把托管服务的 NETON_SCOPE 改成 full 才可用`);
  }
  if (name === 'packet_capture') {
    const mode = String((args && args.mode) || 'auto').toLowerCase();
    if (mode !== 'live') {
      throw new Error('[neton-scope] 夹具作用域=loopback：只放行 live（读本机 TCP 连接表），pktmon/auto 要抓网卡流量，不放行');
    }
    return executeTool(name, args);
  }
  if (portSpread(args && args.ports) > MAX_PORTS) {
    throw new Error(`[neton-scope] 端口跨度过大（上限 ${MAX_PORTS} 个）：请给具体端口列表，如 "8341,8798"`);
  }
  const items = targetsOf(args);
  if (!items.length) {
    throw new Error('[neton-scope] 夹具作用域=loopback：必须显式给出回环目标（target="127.0.0.1"），不接受自动挑网段');
  }
  if (!items.every(isLoopback)) {
    throw new Error(`[neton-scope] 只允许回环地址，收到：${items.filter((x) => !isLoopback(x)).join(' ')}`);
  }
  return executeTool(name, args);
}

const server = new McpStreamableHttpServer({
  port: PORT,
  host: HOST,
  serverName: 'neton-lan',
  serverVersion: '2.0.1',
  executeTool: runTool,
  instructions: [
    'NetON 局域网工具集（BIT 测试夹具形态）：六个 MCP 工具照常可列可调用。',
    '当前作用域=' + SCOPE + '：',
    '  - port_scan / port_analyze / protocol_analyze 仅允许 127.0.0.1（端口跨度 ≤ 256）',
    '  - device_discovery / network_scan / pktmon 抓包在该作用域下被拒绝',
    '  - 需要真实网段能力时，在「服务」页把该条目的环境变量 NETON_SCOPE 改为 full'
  ].join('\n')
});

server
  .start()
  .then(() => {
    logger.log(`[boot] NetON 就绪 pid=${process.pid} 监听 ${HOST}:${PORT} 作用域=${SCOPE}`);
  })
  .catch((e) => {
    logger.error('[boot-fail] ' + e.message, e);
    process.exit(1);
  });
