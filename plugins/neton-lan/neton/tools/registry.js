'use strict';
/**
 * 工具注册表：汇总所有工具的定义（名称、描述、参数 Schema）与执行入口
 */
const deviceDiscovery = require('./device-discovery');
const networkScan = require('./network-scan');
const portScan = require('./port-scan');
const portAnalyze = require('./port-analyze');
const protocolAnalyze = require('./protocol-analyze');
const packetCapture = require('./packet-capture');

const TOOLS = [
  {
    name: 'device_discovery',
    title: '局域网设备发现',
    description: '通过 ARP 表 + ICMP Ping 扫描 + 常见端口探测，发现局域网内活跃设备，识别 MAC 地址、OUI 厂商、HTTP 服务信息。适合快速摸清网段内有哪些设备。',
    inputSchema: {
      type: 'object',
      properties: {
        subnet: { type: 'string', description: '扫描网段，如 192.168.1.0/24；不填则自动探测本机所有局域网网段' },
        ping: { type: 'boolean', description: '是否执行 ICMP 扫描（默认 true）' },
        arp: { type: 'boolean', description: '是否读取 ARP 表（默认 true）' },
        portProbe: { type: 'boolean', description: '是否对存活设备探测常见端口（默认 true）' },
        httpProbe: { type: 'boolean', description: '是否探测 HTTP 服务信息（默认 true）' }
      }
    },
    run: deviceDiscovery.run
  },
  {
    name: 'network_scan',
    title: '局域网扫描',
    description: '对指定 IP 段做全量 ICMP 存活探测 + 常见端口扫描，输出存活主机清单、每台主机的开放端口与服务、端口热度统计。适合整体评估网段资产。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '扫描目标：IP / CIDR / 段，如 192.168.1.0/24（不填自动取本机所在 /24）' },
        ports: { type: 'array', items: { type: 'number' }, description: '要扫描的端口列表，默认 [22,80,443,445,139,135,53,21,23,25,110,143,3389,5900,8080,8443,3306,5432,6379,27017]' },
        timeout: { type: 'number', description: 'ping 超时毫秒（默认 1500）' },
        portTimeout: { type: 'number', description: '端口连接超时毫秒（默认 700）' },
        portScan: { type: 'boolean', description: '是否执行端口扫描（默认 true）' },
        arp: { type: 'boolean', description: '是否读取 ARP 表补充 MAC/厂商（默认 true）' },
        concurrency: { type: 'number', description: '并发数（默认 128）' }
      }
    },
    run: networkScan.run
  },
  {
    name: 'port_scan',
    title: '端口扫描',
    description: '对单个主机或 IP 段扫描指定端口（支持常见端口/指定列表/全端口 1-65535），返回开放端口、服务名、协议与连接延迟，可选抓取 banner。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标主机 IP 或 IP 段（如 192.168.1.5 或 192.168.1.1-50）' },
        ports: { type: 'string', description: '端口定义：all=全端口1-65535、common=常用端口、top100=TOP100、或 22,80,443、或 1-1024' },
        timeout: { type: 'number', description: '连接超时毫秒（默认 700）' },
        concurrency: { type: 'number', description: '并发连接数（默认 100）' },
        banner: { type: 'boolean', description: '是否抓取 banner（默认 false）' },
        bannerTimeout: { type: 'number', description: 'banner 等待毫秒（默认 1500）' }
      },
      required: ['target']
    },
    run: portScan.run
  },
  {
    name: 'port_analyze',
    title: '端口分析',
    description: '对目标主机的指定开放端口做深入分析：服务识别、协议判断、banner 指纹匹配（识别 OpenSSH/Nginx/Apache/IIS/Redis 等）、风险评级（info/low/medium/high/critical）与安全加固建议。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标主机 IP' },
        ports: { type: 'string', description: '端口或端口列表，如 22 或 80,443,3389' },
        timeout: { type: 'number', description: '连接超时毫秒（默认 800）' },
        banner: { type: 'boolean', description: '是否抓取 banner 做指纹（默认 true）' },
        bannerTimeout: { type: 'number', description: 'banner 等待毫秒（默认 1800）' }
      },
      required: ['target', 'ports']
    },
    run: portAnalyze.run
  },
  {
    name: 'protocol_analyze',
    title: '协议分析',
    description: '识别目标主机开放端口上的应用层协议：发送定向探测包（HTTP 请求、SSH 握手、TLS ClientHello、FTP/SMTP/POP3/IMAP 命令、Redis PING、MySQL 握手、MQTT CONNECT、SMB 协商等）根据响应指纹判定协议，并通过 TTL 推断操作系统类型。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标主机 IP' },
        ports: { type: 'string', description: '可选：只分析指定端口（逗号分隔），默认分析 22,21,23,25,80,110,143,443,445,554,139,1883,3306,5000,5432,5900,6379,8080,8443' }
      },
      required: ['target']
    },
    run: protocolAnalyze.run
  },
  {
    name: 'packet_capture',
    title: '抓包',
    description: '网络抓包：mode=pktmon 使用 Windows 内置 pktmon（无需安装、需管理员权限）真实捕获网卡流量并解析为结构化数据；mode=live 轮询 Get-NetTCPConnection 实时监控活跃 TCP 连接（无需管理员）。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto', 'pktmon', 'live'], description: '抓包模式：pktmon=真实抓包（需管理员），live=TCP 连接监控，auto=自动检测（默认 auto）' },
        duration: { type: 'number', description: '抓包时长秒（默认 8）' },
        trafficType: { type: 'string', enum: ['all', 'tcp', 'udp'], description: '过滤流量类型（pktmon 模式）' },
        target: { type: 'string', description: '只关注与该 IP 相关的连接（live 模式）' },
        localPort: { type: 'number', description: '只关注本机该端口的连接（live 模式）' },
        interval: { type: 'number', description: 'live 模式采样间隔毫秒（默认 1000）' }
      }
    },
    run: packetCapture.run
  }
];

/** 转换成 MCP tools/list 返回格式 */
function toMcpTools() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

async function executeTool(name, args) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    throw new Error('未知工具: ' + name);
  }
  const result = await tool.run(args || {});
  return result;
}

module.exports = { TOOLS, toMcpTools, executeTool };
