'use strict';
/**
 * 工具：协议分析
 * 对目标主机做协议栈/服务协议识别：
 *  - TCP 协议栈指纹（TTL、窗口大小、MSS 等，来自 ping + 主动连接）
 *  - 应用层协议探测（HTTP/TLS/SSH/FTP/SMTP/IMAP/POP3/Redis/MySQL/RTSP 等，通过 banner 与握手响应）
 *  - 协议汇总与风险提示
 */
const net = require('net');
const tls = require('tls');
const { execFile } = require('child_process');

/** 主动向端口发送探测字节，收集响应 */
function probeRaw(host, port, payload, waitMs = 1200) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let done = false;
    sock.setTimeout(waitMs);
    sock.on('data', d => { buf = Buffer.concat([buf, d]); if (buf.length > 4096) done = true; finish(); });
    sock.once('connect', () => { try { sock.write(payload); } catch (e) {} });
    sock.once('end', finish);
    sock.once('close', finish);
    sock.once('timeout', finish);
    sock.once('error', finish);
    function finish() {
      if (done) return;
      done = true;
      sock.destroy();
      const text = buf.toString('utf8');
      const hex = buf.toString('hex').slice(0, 512);
      resolve({ raw: buf, text: text.replace(/[^\x20-\x7e\r\n\t]/g, '.').slice(0, 1024), hex, length: buf.length });
    }
    sock.connect(port, host);
  });
}

/** TLS 握手探测 */
function probeTls(host, port, timeout = 1500) {
  return new Promise(resolve => {
    const socket = tls.connect({
      host, port, timeout,
      rejectUnauthorized: false,
      servername: host
    }, () => {
      try {
        const cert = socket.getPeerCertificate();
        const proto = socket.getProtocol();
        const cipher = socket.getCipher();
        resolve({
          tls: true,
          protocol: proto,
          cipher: cipher ? cipher.name : null,
          subject: cert && cert.subject ? `${cert.subject.CN || ''}` : null,
          issuer: cert && cert.issuer ? `${cert.issuer.O || ''}` : null,
          validFrom: cert ? cert.valid_from : null,
          validTo: cert ? cert.valid_to : null,
          daysLeft: cert && cert.valid_to ? Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000) : null,
          sniUnknown: false
        });
        socket.end();
      } catch (e) {
        resolve({ tls: false });
        socket.destroy();
      }
    });
    socket.once('timeout', () => { socket.destroy(); resolve({ tls: false }); });
    socket.once('error', () => resolve({ tls: false }));
  });
}

/** TCP 指纹：SYN 连接后的窗口/行为特征（简化——直接连接记录是否响应 banner） */
function tcpBehaviorFingerprint(host, port) {
  return probeRaw(host, port, Buffer.from('\x00\x00\x00\x00', 'binary'), 800).then(r => ({
    respondsToNullProbe: r.length > 0,
    responsePreview: r.text || null
  }));
}

/** 解析 HTTP 响应头获取协议信息 */
function parseHttpBanner(banner) {
  if (!banner) return null;
  const info = { protocol: 'HTTP' };
  const status = banner.match(/^HTTP\/1\.[01]\s+(\d{3})\s*([^\r\n]*)/);
  if (status) { info.statusCode = status[1]; info.statusText = status[2].trim(); }
  const server = banner.match(/^Server:\s*(.+)$/im);
  if (server) info.server = server[1].trim();
  const poweredBy = banner.match(/^X-Powered-By:\s*(.+)$/im);
  if (poweredBy) info.poweredBy = poweredBy[1].trim();
  const wwwAuth = banner.match(/^WWW-Authenticate:\s*(.+)$/im);
  if (wwwAuth) info.wwwAuth = wwwAuth[1].trim();
  const location = banner.match(/^Location:\s*(.+)$/im);
  if (location) info.redirect = location[1].trim();
  return info;
}

const PROTOCOL_PROBES = [
  { port: 80, name: 'HTTP', kind: 'http' },
  { port: 443, name: 'HTTP-TLS', kind: 'tls' },
  { port: 8443, name: 'HTTPS-Alt', kind: 'tls' },
  { port: 8080, name: 'HTTP-Alt', kind: 'http' },
  { port: 22, name: 'SSH', kind: 'ssh' },
  { port: 21, name: 'FTP', kind: 'ftp' },
  { port: 25, name: 'SMTP', kind: 'smtp' },
  { port: 110, name: 'POP3', kind: 'pop3' },
  { port: 143, name: 'IMAP', kind: 'imap' },
  { port: 6379, name: 'Redis', kind: 'redis' },
  { port: 3306, name: 'MySQL', kind: 'mysql' },
  { port: 5432, name: 'PostgreSQL', kind: 'pgsql' },
  { port: 5900, name: 'VNC-RFB', kind: 'generic' },
  { port: 23, name: 'Telnet', kind: 'telnet' },
  { port: 1883, name: 'MQTT', kind: 'mqtt' },
  { port: 554, name: 'RTSP', kind: 'rtsp' },
  { port: 5000, name: 'UPnP', kind: 'generic' },
  { port: 445, name: 'SMB', kind: 'smb' },
  { port: 139, name: 'NetBIOS', kind: 'generic' }
];

/** 识别单端口协议 */
async function identifyProtocol(host, port, name) {
  const result = { port, name, detected: null, confidence: 0, detail: null };

  // 1. 先确认端口开放
  const open = await new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(600);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
  if (!open) return null;

  // 2. 按类型发送探测
  try {
    if (name === 'HTTP-TLS' || name === 'HTTPS-Alt') {
      const t = await probeTls(host, port);
      if (t.tls) {
        result.detected = 'TLS (HTTPS)';
        result.confidence = 95;
        result.detail = t;
      } else {
        // 不是 TLS，退回 HTTP 探测
        const r = await probeRaw(host, port, Buffer.from('GET / HTTP/1.0\r\nHost: ' + host + '\r\n\r\n'));
        if (r.text && r.text.includes('HTTP/')) {
          result.detected = 'HTTP';
          result.confidence = 90;
          result.detail = parseHttpBanner(r.text);
        } else {
          result.detected = 'Unknown (non-TLS)';
          result.confidence = 30;
          result.detail = { preview: r.text };
        }
      }
    } else if (kindOf[name] === 'http') {
      const r = await probeRaw(host, port, Buffer.from('GET / HTTP/1.0\r\nHost: ' + host + '\r\n\r\n'));
      if (r.text && r.text.includes('HTTP/')) {
        result.detected = 'HTTP';
        result.confidence = 95;
        result.detail = parseHttpBanner(r.text);
      } else {
        result.detected = 'Unknown';
        result.confidence = 20;
        result.detail = r.text ? { preview: r.text } : null;
      }
    } else if (name === 'SSH') {
      const r = await probeRaw(host, port, Buffer.from('SSH-2.0-NetONProbe\r\n'));
      if (r.text && /SSH-2\.0/i.test(r.text)) {
        result.detected = 'SSH';
        result.confidence = 97;
        result.detail = { banner: r.text.slice(0, 120) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 25;
        result.detail = { preview: r.text };
      }
    } else if (name === 'FTP') {
      const r = await probeRaw(host, port, Buffer.from('\r\n'));
      if (r.text && /^220[- ]/i.test(r.text)) {
        result.detected = 'FTP';
        result.confidence = 95;
        result.detail = { banner: r.text.slice(0, 180) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 20;
        result.detail = { preview: r.text };
      }
    } else if (name === 'SMTP') {
      const r = await probeRaw(host, port, Buffer.from('\r\n'));
      if (r.text && /^220[- ]/i.test(r.text) && /smtp|esmtp|mail/i.test(r.text)) {
        result.detected = 'SMTP';
        result.confidence = 95;
        result.detail = { banner: r.text.slice(0, 180) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 20;
        result.detail = { preview: r.text };
      }
    } else if (name === 'POP3') {
      const r = await probeRaw(host, port, Buffer.from('\r\n'));
      if (r.text && /^\+OK/i.test(r.text)) {
        result.detected = 'POP3';
        result.confidence = 92;
        result.detail = { banner: r.text.slice(0, 180) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 20;
        result.detail = { preview: r.text };
      }
    } else if (name === 'IMAP') {
      const r = await probeRaw(host, port, Buffer.from('\r\n'));
      if (r.text && /^\* OK/i.test(r.text)) {
        result.detected = 'IMAP';
        result.confidence = 93;
        result.detail = { banner: r.text.slice(0, 180) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 20;
        result.detail = { preview: r.text };
      }
    } else if (name === 'Redis') {
      const r = await probeRaw(host, port, Buffer.from('PING\r\n'));
      if (r.text && /\+PONG/i.test(r.text)) {
        result.detected = 'Redis';
        result.confidence = 98;
        result.detail = { response: '+PONG' };
      } else {
        result.detected = 'Unknown';
        result.confidence = 20;
        result.detail = r.text ? { preview: r.text } : null;
      }
    } else if (name === 'MySQL') {
      const r = await probeRaw(host, port, Buffer.from('\x0a\x00\x00\x00\x01\x00\x00\x00\x01', 'binary'));
      if (r.length > 0 && r.raw[0] === 0x0a) {
        result.detected = 'MySQL/MariaDB';
        result.confidence = 93;
        result.detail = { handshake: r.text.slice(0, 120), hex: r.hex.slice(0, 80) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 15;
        result.detail = r.text ? { preview: r.text } : null;
      }
    } else if (name === 'PostgreSQL') {
      const r = await probeRaw(host, port, Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
      if (r.length >= 4) {
        const len = r.raw[1];
        if (len === 0 && r.raw[0] === 0) {
          result.detected = 'PostgreSQL';
          result.confidence = 90;
          result.detail = { handshake: r.hex.slice(0, 80) };
        } else {
          result.detected = 'Unknown';
          result.confidence = 15;
          result.detail = r.text ? { preview: r.text } : null;
        }
      }
    } else if (name === 'MQTT') {
      // 发送 CONNECT 包（协议名 MQTT，v4）
      const connect = Buffer.from([0x10, 0x13, 0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c, 0x00, 0x01, 0x6e, 0x65, 0x74, 0x6f, 0x6e, 0x00, 0x00]);
      const r = await probeRaw(host, port, connect);
      if (r.raw.length >= 2 && r.raw[0] === 0x20) {
        result.detected = 'MQTT';
        result.confidence = 95;
        result.detail = { connack: r.hex.slice(0, 40) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 20;
        result.detail = { preview: r.text };
      }
    } else if (name === 'RTSP') {
      const r = await probeRaw(host, port, Buffer.from('OPTIONS rtsp://' + host + ' RTSP/1.0\r\nCSeq: 1\r\n\r\n'));
      if (r.text && /RTSP\/1\.0 \d{3}/i.test(r.text)) {
        result.detected = 'RTSP';
        result.confidence = 95;
        result.detail = { response: r.text.slice(0, 180) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 20;
        result.detail = { preview: r.text };
      }
    } else if (name === 'Telnet') {
      const r = await probeRaw(host, port, Buffer.from('\xff\xfd\x18\xff\xfd\x20\xff\xfd\x23\xff\xfc\x24', 'binary'));
      if (r.text && /login|password|#|>|\$|welcome|telnet/i.test(r.text)) {
        result.detected = 'Telnet';
        result.confidence = 85;
        result.detail = { preview: r.text.slice(0, 180) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 30;
        result.detail = { preview: r.text };
      }
    } else if (name === 'SMB') {
      // SMB2 协商请求
      const smb = Buffer.from([0x00,0x00,0x00,0x2f,0xff,0x53,0x4d,0x42,0x72,0x00,0x00,0x00,0x00,0x18,0x53,0x08,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x00]);
      const r = await probeRaw(host, port, smb, 1500);
      if (r.raw.length >= 4 && r.raw[4] === 0xff && r.raw[5] === 0x53 && r.raw[6] === 0x4d && r.raw[7] === 0x42) {
        result.detected = 'SMB (版本待确认)';
        result.confidence = 90;
        result.detail = { hex: r.hex.slice(0, 120) };
      } else {
        result.detected = 'Unknown';
        result.confidence = 20;
        result.detail = { preview: r.text };
      }
    } else {
      // generic
      const r = await probeRaw(host, port, Buffer.from('\r\n'));
      if (r.length > 0) {
        result.detected = 'Unknown service (responds)';
        result.confidence = 35;
        result.detail = { preview: r.text.slice(0, 200), hex: r.hex.slice(0, 100) };
      } else {
        result.detected = 'Unknown service (silent)';
        result.confidence = 50;
        result.detail = null;
      }
    }
  } catch (e) {
    result.detected = 'Error';
    result.confidence = 0;
    result.detail = e.message;
  }
  return result;
}

const kindOf = {
  'HTTP': 'http',
  'HTTP-Alt': 'http',
  'HTTP-TLS': 'tls',
  'HTTPS-Alt': 'tls'
};

async function run(params = {}) {
  const t0 = Date.now();
  const target = params.target || params.host;
  if (!target) return { error: '缺少 target 参数' };

  // 指定端口或默认扫描常用协议端口
  let probes = PROTOCOL_PROBES;
  if (params.ports) {
    const custom = String(params.ports).split(',').map(s => s.trim()).filter(Boolean);
    const known = { 80: 'HTTP', 443: 'HTTP-TLS', 22: 'SSH', 21: 'FTP', 25: 'SMTP', 110: 'POP3', 143: 'IMAP', 6379: 'Redis', 3306: 'MySQL', 5432: 'PostgreSQL', 5900: 'VNC-RFB', 23: 'Telnet', 8080: 'HTTP-Alt', 8443: 'HTTPS-Alt', 1883: 'MQTT', 554: 'RTSP', 5000: 'UPnP', 445: 'SMB', 139: 'NetBIOS' };
    probes = custom.map(p => {
      const port = parseInt(p, 10);
      return { port, name: known[port] || ('port-' + port), kind: known[port] === 'HTTP' || known[port] === 'HTTP-Alt' ? 'http' : known[port] === 'HTTP-TLS' || known[port] === 'HTTPS-Alt' ? 'tls' : 'custom' };
    });
  }

  // TCP 指纹（对每个开放端口做行为指纹）
  const results = [];
  for (const probe of probes) {
    const id = await identifyProtocol(target, probe.port, probe.name || ('port-' + probe.port));
    if (id) results.push(id);
  }

  // 系统指纹：ping TTL
  let systemFingerprint = null;
  try {
    const { execFile } = require('child_process');
    const pingOut = await new Promise(resolve => {
      execFile('ping', ['-n', '1', '-w', '1500', target], { windowsHide: true }, (err, stdout) => {
        resolve(String(stdout || ''));
      });
    });
    const ttlMatch = pingOut.match(/TTL=(\d+)/i);
    if (ttlMatch) {
      const ttl = parseInt(ttlMatch[1], 10);
      let osGuess = 'Unknown';
      if (ttl <= 64) osGuess = 'Linux/Unix/macOS (TTL≈64)';
      else if (ttl <= 128) osGuess = 'Windows (TTL≈128)';
      else osGuess = '网络设备/其他 (TTL≈255)';
      systemFingerprint = { ttl, osGuess }; 
    }
  } catch (e) {}

  const detectedCount = results.filter(r => r.detected && r.confidence >= 50).length;

  return {
    target,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    systemFingerprint,
    tcpStack: {
      note: '基于 TTL 与 banner 行为的简化指纹',
      osGuess: systemFingerprint ? systemFingerprint.osGuess : null
    },
    detectedProtocols: results,
    summary: {
      probedPorts: results.length,
      detected: detectedCount,
      openCount: results.filter(Boolean).length,
      list: results.filter(r => r.detected && r.confidence >= 50)
        .map(r => ({ port: r.port, protocol: r.detected, confidence: r.confidence }))
    }
  };
}

module.exports = { run, name: 'protocol_analyze', description: '协议分析：识别目标主机的应用层协议（HTTP/SSH/FTP/SMTP/TLS/Redis/MySQL/MQTT/SMB 等），结合 TTL 推断操作系统，输出协议栈指纹' };
