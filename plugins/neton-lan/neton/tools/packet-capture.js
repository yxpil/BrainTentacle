'use strict';
/**
 * 工具：抓包（Packet Capture）
 * Windows 实现方案（零依赖、无需管理员安装）：
 *  1. pktmon（Windows 10 1809+ 内置）：真实抓包，输出 ETL 后可转 pcapng/文本
 *  2. 实时连接监控：轮询 Get-NetTCPConnection，记录活动连接与端口
 *  3. netsh trace（备用）
 */
const os = require('os');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCommand(cmd, args, timeout = 15000) {
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 检查 pktmon 是否可用 */
async function checkPktmon() {
  const r = await runCommand('pktmon', ['version']);
  return !r.err;
}

/** pktmon 抓包核心：启动 -> 等待 -> 停止 -> 转文本 -> 解析 */
async function captureWithPktmon(options) {
  const duration = options.duration || 8;
  const tmpDir = options.tmpDir || os.tmpdir();
  const tag = Date.now();
  const etl = path.join(tmpDir, `neton_capture_${tag}.etl`);
  const txt = path.join(tmpDir, `neton_capture_${tag}.txt`);

  const steps = [];
  const packets = [];

  // 1. 启动抓包
  let startArgs = ['start', '--capture', '--pkt-size', '512'];
  if (options.trafficType === 'udp') {
    startArgs.push('--filter', 'udp');
  } else if (options.trafficType === 'tcp') {
    startArgs.push('--filter', 'tcp');
  }
  const start = await runCommand('pktmon', startArgs, 10000);
  steps.push({ action: 'start', ok: !start.err, detail: start.err ? start.stderr.trim() : 'pktmon start OK' });
  if (start.err) {
    return {
      error: 'pktmon 启动失败（可能需要管理员权限），请以管理员身份运行 NetON',
      detail: start.stderr.trim(),
      steps
    };
  }

  try {
    // 2. 等待抓包时长
    await new Promise(r => setTimeout(r, duration * 1000));

    // 3. 停止
    const stop = await runCommand('pktmon', ['stop'], 10000);
    steps.push({ action: 'stop', ok: !stop.err, output: stop.err ? stop.stderr.trim() : stop.stdout.trim() });
  } catch (e) {
    try { await runCommand('pktmon', ['stop'], 5000); } catch (e2) {}
    return { error: '抓包等待失败: ' + e.message, steps };
  }

  // 4. 转为文本
  const conv = await runCommand('pktmon', ['etl2txt', etl, '-o', txt], 20000);
  steps.push({ action: 'etl2txt', ok: !conv.err, detail: conv.err ? conv.stderr.trim() : '转换成功' });

  let raw = '';
  if (fs.existsSync(txt)) {
    raw = fs.readFileSync(txt, 'utf8').slice(0, 512 * 1024);
  }

  // 5. 解析文本
  const lines = raw.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    // 行格式示例：
    // 0.0000000: 0x0012 0x0001 Header: IPv4 ...
    // 查找 IPv4/TCP/UDP 关键行
    const ipMatch = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b.*\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
    const protoMatch = line.match(/Header:\s*(IPv4|IPv6|TCP|UDP|ARP|ICMP)/i);
    const timeMatch = line.match(/^(\d+\.\d+):/);
    if (timeMatch) {
      current = { time: parseFloat(timeMatch[1]), proto: null, src: null, dst: null, port: null, length: null };
      packets.push(current);
    }
    if (current && protoMatch) current.proto = protoMatch[1].toUpperCase();
    if (current && ipMatch) {
      const nums = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g);
      if (nums && nums.length >= 2) {
        if (!current.src) { current.src = nums[0]; current.dst = nums[1]; }
      }
    }
    const portMatch = line.match(/SrcPort[=:]\s*(\d+)|source port[=:]\s*(\d+)/i);
    if (current && portMatch && !current.port) current.port = parseInt(portMatch[1], 10);
    const lenMatch = line.match(/Length[=:]\s*(\d+)/i);
    if (current && lenMatch) current.length = parseInt(lenMatch[1], 10);
  }

  // 清理临时文件
  try { fs.unlinkSync(etl); } catch (e) {}
  try { fs.unlinkSync(txt); } catch (e) {}

  // 统计
  const protoCount = {};
  const flowSet = new Set();
  for (const p of packets) {
    if (p.proto) protoCount[p.proto] = (protoCount[p.proto] || 0) + 1;
    if (p.src && p.dst) flowSet.add(`${p.src} -> ${p.dst}`);
  }

  return {
    method: 'pktmon',
    durationSeconds: duration,
    totalPackets: packets.length,
    decodedPackets: packets.slice(0, 200),
    protocolBreakdown: protoCount,
    flows: [...flowSet].slice(0, 50),
    summary: {
      packets: packets.length,
      protocols: protoCount,
      uniqueFlows: flowSet.size,
      note: '真实网卡抓包（pktmon），数据在用户态捕获'
    },
    steps
  };
}

/** 实时连接监控：轮询 Get-NetTCPConnection */
async function liveConnectionMonitor(options) {
  const duration = options.duration || 5;
  const interval = options.interval || 1000;
  const filterIp = options.target || null;
  const filterLocalPort = options.localPort || null;

  const samples = [];
  const seenConnections = new Map();
  const rounds = Math.max(1, Math.floor((duration * 1000) / interval));

  for (let i = 0; i < rounds; i++) {
    const r = await runCommand('powershell', ['-NoProfile', '-Command',
      "Get-NetTCPConnection -State Established,Listen | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess | ConvertTo-Json -Compress"
    ], 8000);
    let conns = [];
    if (!r.err && r.stdout.trim()) {
      try {
        const json = JSON.parse(r.stdout.trim());
        conns = Array.isArray(json) ? json : [json];
      } catch (e) {
        conns = [];
      }
    }
    const roundConns = [];
    for (const c of conns) {
      if (filterIp && !(String(c.RemoteAddress).includes(filterIp) || String(c.LocalAddress).includes(filterIp))) continue;
      if (filterLocalPort && c.LocalPort !== filterLocalPort) continue;
      const key = `${c.LocalAddress}:${c.LocalPort}->${c.RemoteAddress}:${c.RemotePort}`;
      if (!seenConnections.has(key)) {
        seenConnections.set(key, { firstSeen: i * interval, lastSeen: i * interval, count: 1, conn: c });
      } else {
        const rec = seenConnections.get(key);
        rec.lastSeen = i * interval;
        rec.count++;
      }
      roundConns.push({ key, local: `${c.LocalAddress}:${c.LocalPort}`, remote: `${c.RemoteAddress}:${c.RemotePort}`, state: c.State, pid: c.OwningProcess });
    }
    samples.push({ timeMs: i * interval, timestamp: new Date().toISOString(), connections: roundConns });
    if (i < rounds - 1) await new Promise(r => setTimeout(r, interval));
  }

  return {
    method: 'live-monitor',
    durationMs: rounds * interval,
    intervalMs: interval,
    rounds,
    samples,
    connections: [...seenConnections.values()].map(r => ({
      connection: r.conn ? `${r.conn.LocalAddress}:${r.conn.LocalPort} <-> ${r.conn.RemoteAddress}:${r.conn.RemotePort}` : null,
      state: r.conn ? r.conn.State : null,
      pid: r.conn ? r.conn.OwningProcess : null,
      firstSeenMs: r.firstSeen,
      lastSeenMs: r.lastSeen,
      sampleCount: r.count
    })),
    summary: {
      uniqueConnections: seenConnections.size,
      totalSamples: samples.length,
      note: '实时 TCP 连接监控（Get-NetTCPConnection）'
    }
  };
}

/** 抓包主入口 */
async function run(params = {}) {
  const mode = params.mode || 'pktmon';
  const t0 = Date.now();

  if (mode === 'live' || mode === 'monitor') {
    return liveConnectionMonitor(params);
  }

  if (mode === 'pktmon' || mode === 'capture' || mode === 'auto') {
    const available = await checkPktmon();
    if (!available) {
      return {
        error: 'pktmon 不可用（需要 Windows 10 1809+）',
        hint: '请尝试 mode=live 使用实时连接监控模式'
      };
    }
    return captureWithPktmon(params);
  }

  return { error: '未知抓包模式: ' + mode + '（可选 pktmon / live）' };
}

module.exports = {
  run,
  name: 'packet_capture',
  description: '抓包：Windows pktmon 真实网卡抓包（支持 TCP/UDP 过滤，解析为结构化数据）或实时 TCP 连接监控模式'
};
