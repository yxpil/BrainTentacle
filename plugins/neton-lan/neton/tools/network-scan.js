'use strict';
/**
 * 工具：局域网扫描
 * 对指定网段做全量存活探测 + 关键端口扫描，输出主机清单与开放服务汇总
 */
const {
  parseTarget, intToIp, classifyIp, pingRange, checkTcpPorts,
  parseArpTable, lookupOui, normalizeMac, getServiceName, getProtocolName
} = require('../utils/network');

const DEFAULT_PORTS = [22, 80, 443, 445, 139, 135, 53, 21, 23, 25, 110, 143, 3389, 5900, 8080, 8443, 3306, 5432, 6379, 27017];

async function run(params = {}) {
  const t0 = Date.now();
  const target = params.target || params.subnet || (() => {
    // 默认取第一个非内部 IPv4 接口的 /24
    const os = require('os');
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) {
          const parts = a.address.split('.');
          return parts[0] + '.' + parts[1] + '.' + parts[2] + '.0/24';
        }
      }
    }
    return '127.0.0.1/32';
  })();

  let range;
  try {
    range = parseTarget(target);
  } catch (e) {
    return { error: e.message };
  }

  if (range.size > 65536) {
    return { error: '网段过大（' + range.size + ' 个地址），最多支持 65536 个' };
  }

  // 生成 IP 列表
  const ips = [];
  for (let n = range.start; n <= range.end; n++) {
    const ip = intToIp(n);
    if (classifyIp(ip) === 'loopback') continue;
    ips.push(ip);
  }

  // ARP 表作为辅助（用于给存活主机补充 MAC/厂商）
  const arpMap = new Map();
  if (params.arp !== false) {
    const rows = await parseArpTable();
    for (const r of rows) {
      if (r.mac && r.ip) arpMap.set(r.ip, { mac: normalizeMac(r.mac), vendor: lookupOui(r.mac), type: r.type });
    }
  }

  // ICMP 存活探测
  const pingTimeout = params.timeout || 1500;
  const alive = await pingRange(ips, { concurrency: Math.min(256, params.concurrency || 128), timeout: pingTimeout });

  // 对存活主机做端口扫描
  // 端口参数：支持字符串 '80,443,445' / '21-23,80' 或数组
  let portList = params.ports || DEFAULT_PORTS;
  if (typeof portList === 'string') {
    portList = portList.split(',').map(x => x.trim()).filter(Boolean);
    const expanded = [];
    for (const item of portList) {
      const m = item.match(/^(\d+)-(\d+)$/);
      if (m) {
        const a = Math.min(parseInt(m[1],10), parseInt(m[2],10));
        const b = Math.max(parseInt(m[1],10), parseInt(m[2],10));
        for (let x = a; x <= b; x++) if (x >= 1 && x <= 65535) expanded.push(x);
      } else {
        const n = parseInt(item, 10);
        if (!isNaN(n) && n >= 1 && n <= 65535) expanded.push(n);
      }
    }
    portList = [...new Set(expanded)];
  } else if (Array.isArray(portList)) {
    portList = portList.map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 65535);
    portList = [...new Set(portList)];
  }
  if (!portList.length) portList = DEFAULT_PORTS;
  const ports = portList;
  const portTimeout = params.portTimeout || 700;
  const scanPorts = async (host) => {
    const r = await checkTcpPorts(host.ip, ports, { timeout: portTimeout, concurrency: 32 });
    host.openPorts = r.filter(x => x.open).map(x => ({ port: x.port, service: x.service, protocol: getProtocolName(x.port) }));
    host.openPorts.sort((a, b) => a.port - b.port);
  };

  // 分批并行扫描，避免瞬间打开太多 socket
  const batchSize = 24;
  const hostList = alive.map(a => ({
    ip: a.ip, rtt: a.rtt, ttl: a.ttl, mac: null, vendor: null, openPorts: []
  }));

  // 补 MAC
  for (const h of hostList) {
    const arp = arpMap.get(h.ip);
    if (arp) { h.mac = arp.mac; h.vendor = arp.vendor; }
  }

  if (params.portScan !== false) {
    for (let i = 0; i < hostList.length; i += batchSize) {
      const batch = hostList.slice(i, i + batchSize);
      await Promise.all(batch.map(scanPorts));
    }
  }

  const openPortCount = hostList.reduce((acc, h) => acc + h.openPorts.length, 0);
  const portSummary = {};
  for (const h of hostList) {
    for (const p of h.openPorts) {
      portSummary[p.port] = portSummary[p.port] || { count: 0, service: p.service };
      portSummary[p.port].count++;
    }
  }

  const result = {
    target,
    range: { start: intToIp(range.start), end: intToIp(range.end), size: range.size },
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    ping: { scanned: ips.length, alive: hostList.length },
    scanConfig: { ports: params.portScan === false ? [] : ports, totalScanned: ips.length * (params.portScan === false ? 0 : ports.length) },
    hosts: hostList.sort((a, b) => {
      const pa = a.ip.split('.').map(Number), pb = b.ip.split('.').map(Number);
      for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    }),
    portSummary: Object.entries(portSummary)
      .sort((a, b) => a[0] - b[0])
      .map(([port, info]) => ({ port: Number(port), service: info.service, hosts: info.count })),
    summary: {
      aliveHosts: hostList.length,
      totalOpenPorts: openPortCount,
      uniqueOpenPorts: Object.keys(portSummary).length,
      scanTimeMs: Date.now() - t0
    }
  };

  return result;
}

module.exports = { run, name: 'network_scan', description: '局域网扫描：对 IP 段做 ICMP 存活探测 + 常见端口扫描，输出主机清单、开放端口、服务归纳与端口热度' };
