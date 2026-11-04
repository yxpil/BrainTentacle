# neton-lan — NetON 改成的套件正例夹具

上游是独立项目 **NetON**（`netonhome-mcp-server` v2.0.0，零依赖 MCP Streamable HTTP 服务器，6 个局域网网络工具）。
这里把它搬进 BIT 插件体系，用来验一条真实链路：**第三方 MCP 服务器 → 宿主托管进程 → 端口就绪 → 自动接入 MCP → 工具进对话**。

## 包结构

```
plugin.json          一条 services[]：runtime=node、program=server.js、port=0（宿主分配）、mcp_mode=http、auto_start
server.js            插件化入口（上游 src/index.js 的改写）：端口 / 绑定地址 / 作用域护栏
neton/               上游 src/ 原样保留（mcp / tools / utils），只有两处为宿主环境改动
```

对上游只做了两处必要改动：

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `neton/mcp/server.js` | 工具执行入口改成构造时注入（`options.executeTool`），默认仍是注册表实现 | 让入口层能加护栏，而不用把判定抄进每个工具 |
| `neton/utils/logger.js` | 被宿主托管（有 `BIT_PLUGIN_ID`）时只写 stderr，不再往包目录落 `logs/neton.log` | 插件包目录当只读看；stderr 会被 WorkWith 收进运行日志环，「服务」页直接能看 |

## 作用域护栏（夹具的硬要求）

这台服务能扫网段、能抓包，所以**默认锁在回环**：`NETON_SCOPE=loopback`（清单 env 里写死）。

- 放行：`port_scan` / `port_analyze` / `protocol_analyze` 指向 `127.0.0.1`、`localhost`、`::1`，端口跨度 ≤ 256；`packet_capture` 只允许 `mode:"live"`（读本机 TCP 连接表）
- 拒绝：`device_discovery` / `network_scan`（扫整段网段 + 读 ARP 表）、`pktmon` 抓网卡流量、任何非回环目标、`ports:"all"`
- 拒绝文案一律以 `[neton-scope]` 开头，模型和探针都能读出来是护栏挡的，不是服务坏了

想要完整能力：在「服务」页把该条目的 `NETON_SCOPE` 改成 `full`，或自己命令行 `node server.js` 跑。

## 测试怎么用

```bash
node scripts/install-plugin-suite.cjs --dest "<BIT_DATA_DIR>/toolhomes/plugins"
# 起实例后：条目 psvc-neton-lan-neton 自启 → 端口就绪 → MCP 接入 → 六个工具进工具表
```

配套探针：`Temp/it-probe/verify-plugin-neton.cjs`（真机 1440/920）。关键判据是把**自己的监听端口**当哨兵——
`port_scan {target:"127.0.0.1", ports:"<宿主分配的端口>"}` 必须报这个端口开放，这个数字只可能来自真实 TCP 探测。
