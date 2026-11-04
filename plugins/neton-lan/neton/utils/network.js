'use strict';
/**
 * NetON 核心网络工具库（零依赖）
 * 提供 IP/CIDR 计算、TCP 端口探测、Ping 存活、ARP 解析、OUI 厂商识别、Banner 抓取
 */
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');

/* ========================== IP 计算 ========================== */

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * 解析 CIDR 或 IP 段，返回 { start, end, size, hosts[] 可迭代范围 }
 * 支持: 192.168.1.0/24、192.168.1.1、192.168.1.1-192.168.1.50、192.168.1.1-50
 */
function parseTarget(input) {
  input = String(input || '').trim();
  if (!input) throw new Error('目标不能为空');

  // 单 IP
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(input)) {
    const n = ipToInt(input);
    return { start: n, end: n, size: 1, desc: input };
  }

  // CIDR
  const cidrMatch = input.match(/^(\d{1,3}(\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidrMatch) {
    const base = ipToInt(cidrMatch[1]);
    const prefix = parseInt(cidrMatch[3], 10);
    if (prefix < 0 || prefix > 32) throw new Error('CIDR 前缀无效: /' + prefix);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const start = (base & mask) >>> 0;
    const end = (start + (1 << (32 - prefix)) - 1) >>> 0;
    return { start, end, size: end - start + 1, desc: input };
  }

  // 段 192.168.1.1-192.168.1.50 或 192.168.1.1-50
  const rangeMatch = input.match(/^(\d{1,3})(\.\d{1,3}){3}\s*-\s*(\d{1,3}(\.\d{1,3}){3}|\d{1,3})$/);
  if (rangeMatch) {
    const dashIdx = input.indexOf('-');
    const left = input.slice(0, dashIdx).trim();
    let right = input.slice(dashIdx + 1).trim();
    if (/^\d{1,3}$/.test(right)) {
      right = left.slice(0, left.lastIndexOf('.')) + '.' + right;
    }
    const s = ipToInt(left);
    const e = ipToInt(right);
    if (e < s) throw new Error('IP 段起始大于结束');
    return { start: s, end: e, size: e - s + 1, desc: input };
  }

  throw new Error('无法识别的目标格式: ' + input + '（支持 192.168.1.1 / 192.168.1.0/24 / 段）');
}

/** 根据地址判断是否私网/环回/链路本地 */
function classifyIp(ip) {
  const n = ipToInt(ip);
  const b1 = (n >>> 24) & 255;
  if (b1 === 127) return 'loopback';
  if (b1 === 10) return 'private';
  if (b1 === 172 && ((n >>> 16) & 255) >= 16 && ((n >>> 16) & 255) <= 31) return 'private';
  if (b1 === 192 && ((n >>> 16) & 255) === 168) return 'private';
  if (b1 === 169 && ((n >>> 16) & 255) === 254) return 'link-local';
  return 'public';
}

/** 获取本机所有 IPv4 接口，含网卡名、掩码、CIDR */
function getLocalInterfaces() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        const ip = a.address;
        const cidr = a.cidr || ip;
        result.push({
          name,
          address: ip,
          netmask: a.netmask,
          mac: a.mac,
          cidr,
          internal: false
        });
      }
    }
  }
  // 加上 loopback
  result.push({ name: 'Loopback', address: '127.0.0.1', netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8', internal: true });
  return result;
}

/* ========================== TCP 端口探测 ========================== */

/**
 * 并发探测端口是否开放
 * @param {string} host 目标 IP
 * @param {number[]} ports 端口列表
 * @param {object} opts { timeout, concurrency }
 * @returns {Promise<{port:number, open:boolean, service:string}[]>}
 */
async function checkTcpPorts(host, ports, opts = {}) {
  const timeout = opts.timeout || 800;
  const concurrency = opts.concurrency || 100;
  const results = [];
  let index = 0;

  async function worker() {
    while (index < ports.length) {
      const port = ports[index++];
      const t0 = Date.now();
      const open = await new Promise(resolve => {
        const sock = new net.Socket();
        let done = false;
        const cleanup = () => { done = true; sock.destroy(); };
        sock.setTimeout(timeout);
        sock.once('connect', () => { if (!done) { done = true; resolve(true); sock.destroy(); } });
        sock.once('timeout', () => { if (!done) { done = true; resolve(false); cleanup(); } });
        sock.once('error', () => { if (!done) { done = true; resolve(false); cleanup(); } });
        sock.connect(port, host);
      });
      results.push({ port, open, service: getServiceName(port), latency: open ? Date.now() - t0 : null });
    }
  }

  const workers = [];
  const n = Math.min(concurrency, ports.length || 1);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** 抓取端口 banner（连接后读数据，最多读 n 字节，等待 timeout ms） */
function grabBanner(host, port, timeout = 1500) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let data = '';
    let done = false;
    sock.setTimeout(timeout);
    sock.once('connect', () => { /* 等待 banner */ });
    sock.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 2048) { finish(); }
    });
    sock.once('end', finish);
    sock.once('close', finish);
    sock.once('timeout', () => { sock.end(); });
    sock.once('error', () => resolve(null));
    function finish() {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(data.replace(/[^\x20-\x7e\r\n\t]/g, '.').slice(0, 2048) || null);
    }
    sock.connect(port, host);
  });
}

/* ========================== Ping 存活探测 ========================== */

/** Ping 单个主机，返回 { ip, alive, rtt, ttl? } */
function pingHost(ip, timeoutMs = 1500) {
  return new Promise(resolve => {
    const args = ['-n', '1', '-w', String(timeoutMs), ip];
    execFile('ping', args, { windowsHide: true, timeout: timeoutMs + 800 }, (err, stdout) => {
      if (err) {
        resolve({ ip, alive: false });
        return;
      }
      const out = String(stdout || '');
      const timeMatch = out.match(/时间[=<]\s*(\d+)ms|time[=<]\s*(\d+)ms/);
      const ttlMatch = out.match(/TTL=(\d+)/i);
      resolve({
        ip,
        alive: /(TTL=|字节=|回复|Reply)/i.test(out) || /(无法访问|超时|timed out|unreachable)/i.test(out) === false
          ? /(TTL=|回复|Reply)/i.test(out)
          : (/=*(?<=\d+)ms/.test(out) || true),
        rtt: timeMatch ? parseInt(timeMatch[1] || timeMatch[2], 10) : null,
        ttl: ttlMatch ? parseInt(ttlMatch[1], 10) : null
      });
    });
  });
}

/** 并发 ping 多个 IP，返回存活列表 */
async function pingRange(ips, opts = {}) {
  const concurrency = opts.concurrency || 64;
  const timeout = opts.timeout || 1500;
  const alive = [];
  let idx = 0;
  async function worker() {
    while (idx < ips.length) {
      const ip = ips[idx++];
      const r = await pingHost(ip, timeout);
      if (r.alive) alive.push(r);
    }
  }
  const pool = [];
  for (let i = 0; i < Math.min(concurrency, ips.length || 1); i++) pool.push(worker());
  await Promise.all(pool);
  return alive;
}

/* ========================== ARP 表解析 ========================== */

/** 解析 arp -a 输出，返回 [{ip,mac,type}] */
function parseArpTable() {
  return new Promise(resolve => {
    execFile('arp', ['-a'], { windowsHide: true, encoding: 'buffer' }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''), 'utf8');
      const text = buf.toString('latin1');
      const rows = [];
      const lines = text.split(/\r?\n/);
      let currentIface = null;
      for (const raw of lines) {
        const line = raw.trim();
        const ifaceMatch = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*---\s*0x/i);
        if (ifaceMatch) { currentIface = ifaceMatch[1]; continue; }
        const m = line.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\b/i);
        if (m) {
          const mac = m[2].toLowerCase();
          if (mac === 'ff-ff-ff-ff-ff-ff' || mac.startsWith('01-00-5e')) continue;
          const type = /(dyn|\u52a8)/i.test(line) ? 'dynamic' : 'static';
          rows.push({ ip: m[1], mac, type, interface: currentIface });
        }
      }
      resolve(rows);
    });
  });
}

/* ========================== OUI 厂商识别 ========================== */

/** 常见 OUI 厂商前缀表（前 3 字节） */
const OUI_TABLE = {
  '00:00:0c': 'Cisco Systems',
  '00:00:5e': 'IANA / VMware',
  '00:01:42': 'Google Fiber',
  '00:03:93': 'Apple',
  '00:04:f2': 'Huawei',
  '00:05:5d': 'Microsoft Hyper-V',
  '00:0a:5e': 'Huawei',
  '00:0c:29': 'VMware',
  '00:0c:e7': 'Intel',
  '00:0e:c6': 'Apple',
  '00:11:32': 'Dell',
  '00:14:22': 'Dell',
  '00:14:bf': 'Intel',
  '00:15:5d': 'Microsoft Hyper-V',
  '00:16:3e': 'Xen / Oracle VM',
  '00:1a:a0': 'Dell',
  '00:1b:21': 'Intel',
  '00:1c:42': 'TP-Link',
  '00:1f:3b': 'TP-Link',
  '00:21:91': 'D-Link',
  '00:23:24': 'Intel',
  '00:25:86': 'TP-Link',
  '00:26:ab': 'TP-Link',
  '00:2b:44': 'TP-Link',
  '00:3e:e1': 'Xiaomi',
  '00:50:56': 'VMware',
  '00:50:7f': 'HP',
  '00:60:2f': 'HP',
  '00:60:97': 'D-Link',
  '00:6b:8d': 'D-Link',
  '44:00:10': 'Huawei',
  '48:22:54': 'TP-Link',
  '4c:ed:fb': 'Xiaomi',
  '50:64:2b': 'Xiaomi',
  '54:c4:15': 'ASUSTek',
  '58:a2:b5': 'TP-Link',
  '6c:3e:6c': 'Technicolor',
  '78:11:dc': 'TP-Link',
  '7c:a6:0c': 'TP-Link',
  '80:89:17': 'Xiaomi',
  '84:a1:d1': 'Espressif (ESP8266)',
  '8c:de:f9': 'Huawei',
  '94:65:2d': 'TP-Link',
  '98:da:c4': 'TP-Link',
  'a0:63:91': 'Apple',
  'a0:bb:3e': 'TP-Link',
  'ac:84:c6': 'TP-Link',
  'bc:32:5f': 'TP-Link',
  'b0:be:76': 'TP-Link',
  'b8:ee:65': 'Espressif (ESP8266)',
  'c0:25:a5': 'TP-Link',
  'c4:e9:84': 'TP-Link',
  'cc:2d:8c': 'Liteon / Apple',
  'd4:83:04': 'Tuya Smart',
  'dc:fe:18': 'Apple',
  'e0:63:da': 'TP-Link',
  'ec:8e:b5': 'Huawei',
  'f4:f2:6d': 'Huawei',
  'f8:e4:e3': 'TP-Link',
  'fc:ec:da': 'ASUSTek',
  '60:32:b1': 'TP-Link',
  '3c:52:82': 'TP-Link',
  'b4:b6:86': 'Mercusys',
  '9c:ef:d5': 'TP-Link',
  '64:6e:6c': 'Navo / Realtek',
  '10:bf:48': 'Rockchip',
  '24:0a:c4': 'Espressif'
};

/** 查询 MAC 对应厂商 */
function lookupOui(mac) {
  if (!mac) return null;
  const norm = mac.toLowerCase().replace(/[:-]/g, '');
  if (norm.length < 6) return null;
  const oui = norm.slice(0, 2) + ':' + norm.slice(2, 4) + ':' + norm.slice(4, 6);
  // 常见虚拟化前缀直接识别
  if (norm.startsWith('000c29') || norm.startsWith('005056') || norm.startsWith('000569')) return 'VMware';
  if (norm.startsWith('00155d') || norm.startsWith('0003ff')) return 'Microsoft Hyper-V';
  if (norm.startsWith('00163e')) return 'Xen / Oracle VM';
  return OUI_TABLE[oui] || null;
}

function normalizeMac(mac) {
  if (!mac) return null;
  let n = String(mac).toLowerCase().replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(n)) return null;
  return n.match(/.{2}/g).join(':');
}

/* ========================== 服务/协议指纹 ========================== */

const SERVICE_PORTS = {
  20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns',
  67: 'dhcp-server', 68: 'dhcp-client', 69: 'tftp', 80: 'http', 81: 'http-alt',
  88: 'kerberos', 110: 'pop3', 111: 'rpcbind', 123: 'ntp', 135: 'msrpc-epmap',
  137: 'netbios-ns', 138: 'netbios-dgm', 139: 'netbios-ssn', 143: 'imap',
  161: 'snmp', 162: 'snmptrap', 179: 'bgp', 194: 'irc', 389: 'ldap',
  443: 'https', 445: 'microsoft-ds', 465: 'smtps', 500: 'ipsec-isakmp',
  514: 'syslog', 515: 'printer', 548: 'afp', 554: 'rtsp', 587: 'submission',
  631: 'ipp', 636: 'ldaps', 993: 'imaps', 995: 'pop3s', 1080: 'socks-proxy',
  1433: 'mssql', 1521: 'oracle', 1701: 'l2tp', 1723: 'pptp', 1883: 'mqtt',
  1900: 'ssdp', 2049: 'nfs', 2083: 'cpanel', 2181: 'zookeeper', 2375: 'docker',
  2376: 'docker-tls', 3000: 'grafana/node', 3128: 'squid-proxy', 3306: 'mysql',
  3389: 'rdp', 3478: 'stun', 3689: 'daap', 4000: 'http-alt', 4369: 'erlang-epmd',
  5000: 'upnp', 5060: 'sip', 5061: 'sips', 5222: 'xmpp', 5353: 'mdns',
  5432: 'postgresql', 5672: 'amqp', 5900: 'vnc', 5901: 'vnc-1', 5984: 'couchdb',
  5985: 'winrm-http', 5986: 'winrm-https', 6000: 'x11', 6222: 'ipmi',
  6379: 'redis', 6443: 'kubernetes', 6666: 'irc-alt', 7001: 'weblogic',
  7002: 'weblogic-ssl', 7070: 'realserver', 8000: 'http-alt', 8009: 'ajp',
  8080: 'http-proxy', 8081: 'http-alt', 8082: 'http-alt', 8088: 'http-alt',
  8161: 'activemq', 8200: 'elasticsearch', 8443: 'https-alt', 8500: 'consul',
  8888: 'http-alt', 9000: 'php-fpm', 9001: 'supervisord', 9042: 'cassandra',
  9090: 'prometheus', 9092: 'kafka', 9200: 'elasticsearch', 9300: 'elasticsearch-tx',
  9418: 'git', 9999: 'http-alt', 10000: 'webmin', 11211: 'memcached',
  15672: 'rabbitmq-mgmt', 16379: 'redis-alt', 20000: 'dnp', 27017: 'mongodb',
  28017: 'mongodb-http', 32400: 'plex', 50000: 'sap', 50070: 'hdfs',
  61616: 'activemq', 6370: 'internal', 25565: 'minecraft'
};

const PROTOCOL_BY_PORT = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS (UDP)', 67: 'DHCP (UDP)',
  80: 'HTTP', 88: 'Kerberos', 110: 'POP3', 123: 'NTP (UDP)', 135: 'MSRPC', 137: 'NetBIOS (UDP)',
  139: 'NetBIOS-SSN', 143: 'IMAP', 161: 'SNMP (UDP)', 162: 'SNMP-Trap (UDP)', 179: 'BGP',
  389: 'LDAP', 443: 'HTTP over TLS', 445: 'SMB/MS-DS', 465: 'SMTPS', 500: 'IKE (UDP)',
  514: 'Syslog (UDP)', 548: 'AFP', 554: 'RTSP', 631: 'IPP', 636: 'LDAPS', 993: 'IMAPS',
  995: 'POP3S', 1080: 'SOCKS', 1433: 'MSSQL', 1521: 'Oracle DB', 1701: 'L2TP (UDP)',
  1723: 'PPTP', 1883: 'MQTT (TCP)', 1900: 'SSDP (UDP)', 2049: 'NFS', 2375: 'Docker API',
  3128: 'HTTP Proxy', 3306: 'MySQL', 3389: 'RDP', 5000: 'UPnP (UDP)', 5060: 'SIP (UDP)',
  5222: 'XMPP', 5353: 'mDNS (UDP)', 5432: 'PostgreSQL', 5672: 'AMQP', 5900: 'VNC',
  5985: 'WinRM', 6379: 'Redis', 6443: 'Kubernetes API', 8000: 'HTTP-Alt', 8080: 'HTTP-Proxy',
  8443: 'HTTPS-Alt', 8888: 'HTTP-Alt', 9090: 'Prometheus', 9200: 'Elasticsearch',
  11211: 'Memcached', 27017: 'MongoDB'
};

function getServiceName(port) {
  return SERVICE_PORTS[port] || 'unknown';
}

function getProtocolName(port, isUdp = false) {
  return PROTOCOL_BY_PORT[port] || (isUdp ? 'UDP' : 'TCP');
}

/** 常见端口列表，按用途分组 */
const COMMON_PORTS = {
  web: [80, 443, 8080, 8443, 8000, 8888, 81],
  remote: [22, 23, 3389, 5900, 5901, 5985, 5986],
  database: [3306, 5432, 1433, 1521, 6379, 27017, 9200],
  file: [21, 20, 445, 139, 137, 2049, 548],
  mail: [25, 110, 143, 465, 587, 993, 995],
  messaging: [1883, 5672, 5222, 61616],
  iot: [1883, 5683, 1900, 5000, 5353],
  infra: [53, 67, 123, 161, 179, 514, 389, 636, 111, 135]
};

module.exports = {
  ipToInt, intToIp, parseTarget, classifyIp, getLocalInterfaces,
  checkTcpPorts, grabBanner, pingHost, pingRange, parseArpTable,
  lookupOui, normalizeMac, getServiceName, getProtocolName, COMMON_PORTS, OUI_TABLE
};
