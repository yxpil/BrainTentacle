'use strict';
/**
 * 工具：端口分析
 * 对单个主机的一个或多个开放端口做深入分析：服务识别、协议推断、banner 指纹匹配、风险评级、建议
 */
const { checkTcpPorts, grabBanner, getServiceName, getProtocolName } = require('../utils/network');

/** banner 指纹库：正则 -> 服务/版本信息 */
const BANNER_FINGERPRINTS = [
  { pattern: /SSH-2\.0-([^\r\n]+)/i, service: 'OpenSSH', extract: 'ssh_version' },
  { pattern: /OpenSSH[_-]([\d.]+p?\d*)/i, service: 'OpenSSH', extract: 'software_version' },
  { pattern: /220[- ]([^\r\n]+)ESMTP/i, service: 'SMTP', extract: 'smtp_banner' },
  { pattern: /Microsoft ESMTP/i, service: 'Microsoft SMTP' },
  { pattern: /^220[ -].*FTP/i, service: 'FTP' },
  { pattern: /FTP.*ready|[Ff]ile[Zz]illa|vsFTPd|ProFTPD|pure-ftpd|Microsoft FTP|Serv-U/i, service: 'FTP Server' },
  { pattern: /HTTP\/1\.[01] \d{3}/i, service: 'HTTP' },
  { pattern: /Server:\s*([^\r\n]+)/i, service: 'HTTP Server', extract: 'http_server' },
  { pattern: /nginx\/([\d.]+)/i, service: 'Nginx', extract: 'nginx_version' },
  { pattern: /Apache\/([\d.]+)/i, service: 'Apache', extract: 'apache_version' },
  { pattern: /Microsoft-IIS\/([\d.]+)/i, service: 'Microsoft IIS', extract: 'iis_version' },
  { pattern: /Redis server v=([\d.]+)/i, service: 'Redis', extract: 'redis_version' },
  { pattern: /MySQL|mariadb|MariaDB/i, service: 'MySQL/MariaDB' },
  { pattern: /PostgreSQL/i, service: 'PostgreSQL' },
  { pattern: /MongoDB/i, service: 'MongoDB' },
  { pattern: /Minecraft/i, service: 'Minecraft' },
  { pattern: /Telnet|Password:|login:/i, service: 'Telnet' },
  { pattern: /\[J|RDP|COOKIE|mstshash/i, service: 'RDP' },
  { pattern: /RFB \d{3}\.\d{3}/i, service: 'VNC (RFB)' },
  { pattern: /Docker|HTTP\/1\.1 \d{3}.*docker/i, service: 'Docker API' },
  { pattern: /SSDP|UPnP|ST: urn:/i, service: 'UPnP/SSDP' },
  { pattern: /SIP\/2\.0|Via: SIP/i, service: 'SIP' },
  { pattern: /\* OK.*IMAP|IMAP4rev1/i, service: 'IMAP' },
  { pattern: /\+OK.*POP3|POP3 ready/i, service: 'POP3' },
  { pattern: /smtp|SMTP/i, service: 'SMTP' },
  { pattern: /BitTorrent|bittorrent/i, service: 'BitTorrent' },
  { pattern: /MySQL|mariadb|MariaDB/i, service: 'MySQL/MariaDB' }
];

/** 端口风险知识库：端口 -> { risk, level, desc } */
const RISK_TABLE = {
  21: { level: 'medium', risk: 'FTP 明文传输凭据，易被暴力破解/匿名访问', recommendation: '如非必要关闭；改用 SFTP/FTPS；限制来源 IP' },
  22: { level: 'low', risk: 'SSH 暴露可能被暴力破解', recommendation: '使用密钥认证；禁用 root 密码登录；更换非默认端口' },
  23: { level: 'high', risk: 'Telnet 明文传输账号密码，可被嗅探', recommendation: '立即关闭，改用 SSH' },
  25: { level: 'medium', risk: 'SMTP 可能被滥用发垃圾邮件', recommendation: '限制中继；启用认证与 TLS' },
  53: { level: 'low', risk: 'DNS 服务暴露可能被利用做放大攻击/域传送', recommendation: '限制递归查询；关闭域传送' },
  135: { level: 'high', risk: 'MSRPC 暴露存在远程代码执行风险（经典漏洞）', recommendation: '防火墙屏蔽；仅内网可信主机访问' },
  137: { level: 'medium', risk: 'NetBIOS 暴露可泄露主机信息', recommendation: '屏蔽 UDP 137-139' },
  139: { level: 'high', risk: 'NetBIOS-SSN 可被用于 SMB 攻击', recommendation: '屏蔽 139；使用 SMB over 445' },
  445: { level: 'critical', risk: 'SMB 暴露面临 EternalBlue 等严重漏洞风险', recommendation: '非必要关闭；打补丁；防火墙限制' },
  3389: { level: 'high', risk: 'RDP 暴露易受暴力破解/漏洞攻击（BlueKeep）', recommendation: '启用 NLA；限制来源 IP；使用 VPN 或堡垒机' },
  3306: { level: 'high', risk: 'MySQL 暴露可被暴力破解数据库口令', recommendation: '仅监听内网；限制访问 IP；使用强密码' },
  5432: { level: 'high', risk: 'PostgreSQL 暴露可被暴力破解', recommendation: '仅内网访问；pg_hba.conf 限制；强密码' },
  6379: { level: 'critical', risk: 'Redis 未授权访问可导致服务器沦陷', recommendation: '设置 requirepass；bind 内网；禁用危险命令' },
  27017: { level: 'high', risk: 'MongoDB 未授权访问风险极高', recommendation: '开启认证；绑定内网；设置防火墙' },
  9200: { level: 'high', risk: 'Elasticsearch 未授权访问可泄露全部数据', recommendation: '开启 X-Pack 认证；不暴露公网' },
  8080: { level: 'medium', risk: 'HTTP 管理后台暴露可能被攻击', recommendation: '识别后台并加固认证；限制访问' },
  8443: { level: 'medium', risk: 'HTTPS 管理端口暴露', recommendation: '确认证书有效；限制来源 IP' },
  5900: { level: 'high', risk: 'VNC 暴露可被暴力破解/未授权访问', recommendation: '设置强密码；限制来源 IP；改用 SSH 隧道' },
  11211: { level: 'high', risk: 'Memcached 未授权访问可被利用做 DDoS 放大', recommendation: '绑定内网；防火墙屏蔽' },
  1900: { level: 'low', risk: 'SSDP 暴露可能参与 DDoS 放大', recommendation: '路由器/主机禁用 UPnP' },
  1433: { level: 'high', risk: 'MSSQL 暴露可被暴力破解', recommendation: '限制来源 IP；启用加密；强密码' },
  1521: { level: 'high', risk: 'Oracle 监听器暴露存在历史漏洞', recommendation: '限制来源；禁用高危服务' },
  1080: { level: 'medium', risk: 'SOCKS 代理暴露可能被滥用为跳板', recommendation: '确认是否必要；加认证或关闭' },
  3128: { level: 'medium', risk: 'HTTP 代理暴露可能被滥用', recommendation: '加认证或关闭' },
  2049: { level: 'high', risk: 'NFS 暴露可能导致未授权文件访问', recommendation: '限制 exports；仅内网挂载' },
  137: { level: 'medium', risk: 'NetBIOS 名称服务暴露泄漏主机名', recommendation: '防火墙屏蔽' },
  111: { level: 'medium', risk: 'rpcbind 暴露泄漏 RPC 服务信息', recommendation: '限制来源；屏蔽公网' },
  23: { level: 'high', risk: 'Telnet 明文传输凭据', recommendation: '关闭并改用 SSH' }
};

/** 服务分级：根据端口默认服务判断是否高危 */
function analyzePort(port, service, bannerText) {
  const riskInfo = RISK_TABLE[port] || null;
  const analysis = {
    port,
    service: getServiceName(port),
    protocol: getProtocolName(port),
    riskLevel: 'info'
  };

  // banner 指纹匹配
  if (bannerText) {
    for (const fp of BANNER_FINGERPRINTS) {
      const m = bannerText.match(fp.pattern);
      if (m) {
        analysis.fingerprint = {
          detected: fp.service,
          detail: fp.extract && m[1] ? m[1] : null
        };
        break;
      }
    }
  }

  if (riskInfo) {
    analysis.riskLevel = riskInfo.level;
    analysis.risk = riskInfo.risk;
    analysis.recommendation = riskInfo.recommendation;
  }

  // 对已知服务但端口不标准的告警
  const knownServices = ['http', 'https', 'ssh', 'ftp', 'smtp', 'dns', 'mysql', 'rdp', 'sip', 'mqtt'];
  if (analysis.service === 'unknown' && bannerText) {
    analysis.note = '端口不在常见服务表，具体类型请结合 banner 判断';
  }

  return analysis;
}

async function run(params = {}) {
  const t0 = Date.now();
  const target = params.target || params.host;
  if (!target) return { error: '缺少 target 参数' };
  const ports = params.ports || params.port;
  if (!ports) return { error: '缺少 ports 参数（逗号分隔或单端口）' };

  const portList = String(ports).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
  if (portList.length === 0) return { error: '端口列表无效' };

  // 确认端口开放
  const probes = await checkTcpPorts(target, portList, { timeout: params.timeout || 800, concurrency: portList.length });
  const openPorts = probes.filter(p => p.open);
  const closedPorts = probes.filter(p => !p.open).map(p => p.port);

  const analyzed = [];
  for (const p of openPorts) {
    let banner = null;
    if (params.banner !== false) {
      banner = await grabBanner(target, p.port, params.bannerTimeout || 1800);
    }
    const a = analyzePort(p.port, p.service, banner);
    a.banner = banner;
    a.latency = p.latency;
    analyzed.push(a);
  }

  // 整体风险评分
  const riskScore = analyzed.reduce((acc, a) => {
    const scoreMap = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return acc + (scoreMap[a.riskLevel] || 0);
  }, 0);

  const maxRisk = Math.max(...analyzed.map(a => {
    const scoreMap = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return scoreMap[a.riskLevel] || 0;
  }), 0);
  const overallLevel = ['info', 'low', 'medium', 'high', 'critical'][maxRisk];

  return {
    target,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    requestedPorts: portList,
    openPorts: analyzed,
    closedPorts,
    overallRisk: {
      level: overallLevel,
      score: riskScore,
      openCount: analyzed.length,
      summary: analyzed.length === 0
        ? '所有请求端口均关闭或未响应'
        : `发现 ${analyzed.length} 个开放端口，综合风险评级：${overallLevel.toUpperCase()}`
    }
  };
}

module.exports = { run, name: 'port_analyze', description: '端口分析：对指定主机端口做深入分析——服务识别、协议判断、banner 指纹匹配、风险评级、安全加固建议' };
