'use strict';
/**
 * 工具：局域网设备发现
 * 通过 ARP 表 + ICMP Ping 扫描 + OUI 厂商识别，发现局域网内的活跃设备
 */
const http = require('http');
const {
  getLocalInterfaces, parseArpTable, pingRange, ipToInt, intToIp,
  lookupOui, normalizeMac, classifyIp
} = require('../utils/network');

/**
 * 主入口
 * @param {object} params
 *  - subnet: 指定网段（如 192.168.1.0/24），默认自动探测本机所有局域网网段
 *  - ping: 是否用 ICMP 扫描（默认 true）
 *  - arp: 是否读取 ARP 表（默认 true）
 *  - mdns: 是否探测 mDNS/主机名（默认 false）
 *  - portProbe: 对发现的设备探测常见端口（默认 true）
 */
async function run(params = {}) {
  const ping = params.ping !== false;
  const useArp = params.arp !== false;
  const timeStart = Date.now();

  // 1. 确定扫描网段
  const interfaces = getLocalInterfaces().filter(i => !i.internal);
  let subnets = [];
  if (params.subnet) {
    subnets = [params.subnet];
  } else {
    subnets = interfaces.map(i => i.cidr);
  }
  if (subnets.length === 0) {
    subnets = ['127.0.0.1/32'];
  }

  const devices = new Map(); // key: mac 或 ip

  // 2. 从 ARP 表收集已有记录
  let arpRows = [];
  if (useArp) {
    arpRows = await parseArpTable();
    for (const row of arpRows) {
      if (!row.ip || !row.mac || row.mac.replace(/:/g, '') === 'ffffffffffff') continue;
      const key = row.mac;
      if (!devices.has(key)) {
        devices.set(key, {
          ip: row.ip,
          mac: normalizeMac(row.mac),
          vendor: lookupOui(row.mac),
          firstSeen: 'arp-table',
          hostname: null,
          ports: [],
          lastSeen: new Date().toISOString()
        });
      }
    }
  }

  // 3. 生成待扫描 IP 列表（合并所有网段，去重）
  const ipSet = new Set();
  for (const s of subnets) {
    try {
      const { parseTarget } = require('../utils/network');
      const range = parseTarget(s);
      // 限制单次扫描规模，避免扫描公网大段
      if (range.size > 65536) {
        throw new Error('网段 ' + s + ' 过大（' + range.size + ' 个地址），请缩小范围');
      }
      for (let n = range.start; n <= range.end; n++) {
        const ip = intToIp(n);
        if (classifyIp(ip) === 'loopback') continue;
        if (classifyIp(ip) === 'link-local' && !s.includes('169.254')) continue;
        ipSet.add(ip);
      }
    } catch (e) {
      return { error: e.message };
    }
  }

  const allIps = [...ipSet];
  const results = { totalHosts: allIps.length, scannedAt: new Date().toISOString(), subnets, devices: [] };

  // 4. Ping 扫描存活主机
  if (ping && allIps.length > 0 && allIps.length <= 4096) {
    const alive = await pingRange(allIps, { concurrency: 128, timeout: 1200 });
    for (const a of alive) {
      // 将 ping 存活的结果合并进 devices：优先按 ip 关联已有 ARP 记录
      let found = null;
      for (const d of devices.values()) {
        if (d.ip === a.ip) { found = d; break; }
      }
      if (found) {
        found.alive = true;
        found.rtt = a.rtt;
        found.firstSeen = found.firstSeen || 'ping';
      } else {
        devices.set('ip:' + a.ip, {
          ip: a.ip, mac: null, vendor: null, alive: true, rtt: a.rtt,
          firstSeen: 'ping', hostname: null, ports: [], lastSeen: new Date().toISOString()
        });
      }
    }
  }

  // 5. 对存活设备做 HTTP / 常见端口探测
  const aliveDevices = [...devices.values()].filter(d => d.alive || d.firstSeen === 'arp-table');
  if (params.portProbe !== false && aliveDevices.length <= 64) {
    const { checkTcpPorts } = require('../utils/network');
    const probePorts = [80, 443, 22, 23, 3389, 445, 139, 8080, 53, 21];
    const probeBatch = async (d) => {
      try {
        const r = await checkTcpPorts(d.ip, probePorts, { timeout: 600, concurrency: 10 });
        d.ports = r.filter(x => x.open).map(x => x.port);
      } catch (e) { d.ports = []; }
    };
    await Promise.all(aliveDevices.map(probeBatch));
  }

  // 6. 尝试 HTTP HEAD 拿主机名/设备名（可选）
  if (params.httpProbe !== false) {
    const httpDevices = aliveDevices.filter(d => d.ports && d.ports.includes(80) && !d.hostname);
    await Promise.all(httpDevices.slice(0, 20).map(d => {
      return new Promise(res => {
        const req = http.get({ host: d.ip, port: 80, path: '/', timeout: 1200, headers: { Host: d.ip } }, r => {
          const server = r.headers['server'];
          const poweredBy = r.headers['x-powered-by'];
          const location = r.headers['location'];
          if (server) d.httpServer = Array.isArray(server) ? server[0] : server;
          if (poweredBy) d.httpPoweredBy = Array.isArray(poweredBy) ? poweredBy[0] : poweredBy;
          if (location) d.httpRedirect = Array.isArray(location) ? location[0] : location;
          r.resume();
          res();
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} res(); });
        req.on('error', () => res());
      });
    }));
  }

  // 7. 组装最终结果
  const deviceList = [...devices.values()]
    .filter(d => d.alive || d.firstSeen === 'arp-table' || d.mac)
    .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  results.devices = deviceList.map(d => ({
    ip: d.ip,
    mac: d.mac || null,
    vendor: d.vendor || null,
    hostname: d.hostname || null,
    alive: !!d.alive || d.firstSeen === 'arp-table',
    rtt: d.rtt ?? null,
    firstSeen: d.firstSeen,
    httpServer: d.httpServer || null,
    httpPoweredBy: d.httpPoweredBy || null,
    openPorts: d.ports || []
  }));

  results.summary = {
    total: results.devices.length,
    alive: results.devices.filter(d => d.alive).length,
    withMac: results.devices.filter(d => d.mac).length,
    arpRecords: arpRows.length,
    scanTimeMs: Date.now() - timeStart,
    scannedRange: subnets
  };

  return results;
}

module.exports = { run, name: 'device_discovery', description: '局域网设备发现：通过 ARP 表 + ICMP 扫描 + 端口探测，识别网段内的活跃设备、MAC、厂商与开放端口' };
