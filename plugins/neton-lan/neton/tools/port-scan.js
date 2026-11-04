'use strict';
/**
 * 工具：端口扫描
 * 对单个主机或网段做端口扫描，支持常见端口/指定端口/全端口(1-65535 需谨慎)，可选 banner 抓取与服务识别
 */
const net = require('net');
const {
  parseTarget, intToIp, classifyIp, checkTcpPorts, grabBanner,
  getServiceName, getProtocolName, COMMON_PORTS
} = require('../utils/network');

function parsePortList(input) {
  const ports = new Set();
  const items = String(input || '').split(',').map(s => s.trim()).filter(Boolean);
  if (items.length === 0) return null;
  for (const item of items) {
    if (/^\d+$/.test(item)) {
      const p = parseInt(item, 10);
      if (p < 1 || p > 65535) throw new Error('端口超出范围: ' + item);
      ports.add(p);
    } else if (/^(\d+)-(\d+)$/.test(item)) {
      const m = item.match(/^(\d+)-(\d+)$/);
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a < 1 || b > 65535 || a > b) throw new Error('端口段无效: ' + item);
      if (b - a > 65535) throw new Error('端口段过大');
      for (let p = a; p <= b; p++) ports.add(p);
    } else {
      throw new Error('无法解析端口: ' + item);
    }
  }
  return [...ports];
}

async function scanHost(ip, ports, opts) {
  const host = {
    ip,
    hostname: null,
    openPorts: [],
    closedPorts: [],
    filteredPorts: []
  };

  // 反向 DNS（可选，快速失败）
  if (opts.reverseDns) {
    host.hostname = await new Promise(resolve => {
      const socket = new net.Socket();
      socket.setTimeout(800);
      socket.once('connect', () => { socket.destroy(); resolve(null); });
      socket.once('timeout', () => { socket.destroy(); resolve(null); });
      socket.once('error', () => resolve(null));
      // 不做真正的 PTR 查询，这里仅留空（Node 无内置反查，需外部实现）
      resolve(null);
    });
  }

  const results = await checkTcpPorts(ip, ports, {
    timeout: opts.timeout || 700,
    concurrency: opts.concurrency || 100
  });

  for (const r of results) {
    if (r.open) {
      const item = {
        port: r.port,
        service: getServiceName(r.port),
        protocol: getProtocolName(r.port),
        latency: r.latency
      };
      if (opts.banner) {
        item.banner = await grabBanner(ip, r.port, opts.bannerTimeout || 1500);
      }
      host.openPorts.push(item);
    } else {
      host.closedPorts.push({ port: r.port, service: getServiceName(r.port) });
    }
  }

  host.openPorts.sort((a, b) => a.port - b.port);
  host.closedPorts.sort((a, b) => a.port - b.port);
  host.status = host.openPorts.length > 0 ? 'open' : 'closed';
  return host;
}

async function run(params = {}) {
  const t0 = Date.now();
  const target = params.target || params.host;
  if (!target) return { error: '缺少 target 参数，请指定目标 IP 或 IP 段' };

  // 解析目标
  let addressList = [];
  try {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
      addressList = [target];
    } else {
      const range = parseTarget(target);
      if (range.size > 256 && params.ports !== '1-65535') {
        // 多主机时限制不让扫全端口
      }
      for (let n = range.start; n <= range.end; n++) addressList.push(intToIp(n));
      if (addressList.length > 4096) {
        return { error: '主机数量过多（' + addressList.length + '），单次最多 4096 个 IP' };
      }
    }
  } catch (e) {
    return { error: e.message };
  }

  // 解析端口
  let ports;
  try {
    ports = parsePortList(params.ports || 'common');
  } catch (e) {
    return { error: e.message };
  }

  if (params.ports === 'all') {
    ports = Array.from({ length: 65535 }, (_, i) => i + 1);
  } else if (params.ports === 'common' || !params.ports) {
    ports = [...new Set([
      ...COMMON_PORTS.web, ...COMMON_PORTS.remote, ...COMMON_PORTS.database,
      ...COMMON_PORTS.file, ...COMMON_PORTS.mail, ...COMMON_PORTS.messaging,
      ...COMMON_PORTS.infra
    ])].sort((a, b) => a - b);
  } else if (params.ports === 'top100') {
    ports = [21,22,23,25,53,80,110,111,135,139,143,161,179,443,445,465,500,514,548,554,587,631,636,993,995,1080,1433,1521,1701,1723,1883,1900,2049,2083,2181,2375,2376,3000,3128,3306,3389,3478,3689,4369,5000,5060,5222,5353,5432,5672,5900,5901,5984,5985,5986,6000,6379,6443,6666,7001,7002,8000,8009,8080,8081,8161,8200,8443,8500,8888,9000,9001,9042,9090,9092,9200,9300,9418,9999,10000,11211,15672,16379,20000,27017,28017,32400,50000,50070,61616,25565];
  }

  const opts = {
    timeout: params.timeout || 700,
    concurrency: params.concurrency || 100,
    banner: params.banner === true,
    bannerTimeout: params.bannerTimeout || 1500,
    reverseDns: params.reverseDns === true
  };

  if (addressList.length === 1) {
    // 单主机
    const host = await scanHost(addressList[0], ports, opts);
    return {
      target,
      ports: { count: ports.length, list: ports.length <= 200 ? ports : ports.slice(0, 200) },
      hosts: [host],
      summary: {
        openPorts: host.openPorts.length,
        closedPorts: host.closedPorts.length,
        durationMs: Date.now() - t0
      }
    };
  }

  // 多主机：只统计开放端口，不输出全部 closed
  const hosts = [];
  for (const ip of addressList) {
    const h = await scanHost(ip, ports, opts);
    hosts.push({ ip: h.ip, status: h.status, openPorts: h.openPorts });
  }
  const openCount = hosts.reduce((acc, h) => acc + h.openPorts.length, 0);
  return {
    target,
    ports: { count: ports.length },
    hosts,
    summary: {
      scannedHosts: hosts.length,
      aliveHosts: hosts.filter(h => h.openPorts.length > 0).length,
      totalOpenPorts: openCount,
      durationMs: Date.now() - t0
    }
  };
}

module.exports = { run, name: 'port_scan', description: '端口扫描：对目标主机/网段扫描端口（支持常见端口、指定端口、全端口），返回开放端口、服务识别与可选 banner' };
