# 触手怪 BIT — Agent Tool Hub

简体中文 | [English](README_EN.md)

[![Release](https://img.shields.io/github/v/release/yxpil/BrainTentacle?style=flat-square&label=%E7%89%88%E6%9C%AC)](https://github.com/yxpil/BrainTentacle/releases/latest) [![下载](https://img.shields.io/github/downloads/yxpil/BrainTentacle/total?style=flat-square&label=%E4%B8%8B%E8%BD%BD)](https://github.com/yxpil/BrainTentacle/releases) [![License](https://img.shields.io/github/license/yxpil/BrainTentacle?style=flat-square)](https://github.com/yxpil/BrainTentacle/blob/main/LICENSE) [![CI](https://img.shields.io/github/actions/workflow/status/yxpil/BrainTentacle/release.yml?style=flat-square&label=CI)](https://github.com/yxpil/BrainTentacle/actions) [![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux%20%C2%B7%20%E9%BE%99%E8%8A%AF%20%C2%B7%20RISC--V-black?style=flat-square)](https://osbt.space) [![官网](https://img.shields.io/website?up_message=osbt.space&down_message=%E7%A6%BB%E7%BA%BF&style=flat-square&url=https%3A%2F%2Fosbt.space)](https://osbt.space) [![QQ群](https://img.shields.io/badge/QQ%E7%BE%A4-%E7%82%B9%E5%87%BB%E5%8A%A0%E5%85%A5-black?style=flat-square)](https://qm.qq.com/q/qlFr8ct0ps)

[![Homebrew](https://img.shields.io/badge/Homebrew-brew%20install%20--cask%20bit-black?style=flat-square)](https://github.com/yxpil/homebrew-bit) [![Scoop](https://img.shields.io/badge/Scoop-scoop%20install%20bit-black?style=flat-square)](https://github.com/yxpil/scoop-bit) [![npm](https://img.shields.io/badge/npm-bit--agent-black?style=flat-square)](https://www.npmjs.com/package/bit-agent) [![winget](https://img.shields.io/badge/winget-yxpil.bit-black?style=flat-square)](https://github.com/yxpil/BrainTentacle/releases) [![APT](https://img.shields.io/badge/APT-yxpil%2Fapt--repo-black?style=flat-square)](https://yxpil.github.io/apt-repo) [![DNF](https://img.shields.io/badge/DNF-yxpil%2Fdnf--repo-black?style=flat-square)](https://yxpil.github.io/dnf-repo) [![pacman](https://img.shields.io/badge/pacman-yxpil%2Fpacman--repo-black?style=flat-square)](https://yxpil.github.io/pacman-repo)

BIT 是一个桌面 AI Agent 工具中枢：**Electron 托盘壳 + Rust 核心（bit-core）+ React 前端**（同一份核心也构建 Tauri 2 原生壳）。配置任意 AI 提供方即可流式对话，并让 AI 调用本机工具、自写脚本、沉淀记忆与技能；密钥等敏感信息对 AI 脱敏，全部数据保存在本机。可审计、可远程访问。

**BIT 永久免费**：完全开源（Apache-2.0），所有功能对个人与商业用户永久免费——无内购、无订阅、无功能锁、无遥测，可随时自行编译。

> 无边框自定义标题栏 · 深/浅色主题 · 黑白线性设计 · [QQ 交流群](https://qm.qq.com/q/qlFr8ct0ps)

## 目录

[三分钟上手](#三分钟上手) · [功能特性](#功能特性) · [扩展与插件](#扩展与插件) · [安装使用](#安装使用) · [远程访问与 API](#远程访问与-api) · [文档](#文档) · [安全与隐私](#安全与隐私) · [友情链接](#友情链接) · [技术栈](#技术栈) · [开发](#开发) · [项目结构](#项目结构) · [许可](#许可)

## 三分钟上手

**① 装好并打开**

到 [Releases](https://github.com/yxpil/BrainTentacle/releases) 下载对应平台的安装包（Windows 选 `BIT_<版本>_x64-setup.exe`，macOS 按芯片选 `dmg`，Linux 用 `AppImage` / `deb` / `rpm`），或用包管理器安装（见 [安装使用](#安装使用)）。首次打开遇到 SmartScreen / 「已损坏」提示，按 [安装疑难](#安装疑难) 放行即可。

**② 配一个模型**

进入「**AI 设置**」页 → 「添加提供方」→ 选协议（OpenAI / Gemini / Claude）、填 Base URL、API Key、模型名（可点「**从 API 获取**」一键拉取模型列表）→ 点该条目上的**播放按钮**激活。同一时刻只有一个提供方生效，其余自动暂停。

**③ 开始对话**

回到「**对话**」页直接提问。工具调用会以卡片展示参数与结果；审批模式三档可切：**每次询问 / 自动审批（危险操作仍询问）/ 完全放行**。回复流式逐字输出，思考过程独立显示。

**④ 让它干活**

试试这些自然语言指令，感受一下工具中枢：

```
列出当前目录的文件并统计大小
写一个脚本，把这周的 git log 按作者汇总成表格
帮我查一下这个报错信息
把「本项目用 pnpm 不要用 npm」记下来
```

AI 会自己挑工具、必要时写脚本、把有用的结论用 `add_memory` / `skill` 沉淀下来，跨会话复用。

**⑤ 加扩展（可选，这是 BIT 最强的地方）**

三层扩展，任选其一，详见 [扩展与插件](#扩展与插件)：

- **本地插件**：把插件包丢进插件目录，点「重扫插件」→ 工具 / 提示词 / 技能 / 定时任务一次性生效
- **MCP 扩展**：粘贴一份 `mcpServers` 配置（兼容 Cursor / Claude Desktop），或扫描端口自动发现
- **WorkWith**：在「**服务**」页填一下程序路径，**添加即可 —— BIT 自动拉起程序、自动扫描端口、自动接入 MCP**，工具即插即用

**⑥ 手机远程用（可选）**

「远程」页开启后，手机 App（[bit-mobile](https://github.com/yxpil/bit-mobile)）扫码即可随身对话与审批工具；也可把 BIT 当成 OpenAI 兼容网关给其它客户端用，详见 [远程访问与 API](#远程访问与-api)。

> 更细的分步讲解（含界面截图位说明与常见卡点）见 Wiki [快速上手](https://github.com/yxpil/BrainTentacle/wiki/快速上手)。
> 终端场景：安装后在任意终端输入 `bit` 直接进入 TUI 对话（无窗口、无单实例约束、不监听端口）。

## 功能特性

**对话与 AI**

- **流式对话**：前后端全链路流式（SSE + Electron/Tauri Event），回复逐字展示；思考过程独立显示；助手消息 Markdown 渲染（表格、代码块等）；缓存命中率实时统计。
- **多提供方**：OpenAI / Gemini / Claude 三种协议，可配置多家、同一时刻激活一个（互斥）；先测试上游连通性再保存；「从 API 获取」一键拉取模型列表。
- **多模态**：支持图片输入，随消息发给多模态模型。
- **长对话治理**：一键压缩为摘要；会话收藏、彩色标签、多选删除；执行中的任务切走不中断，长命令自动转后台。
- **终端模式**：终端直接输入 `bit` 进入简约 TUI——无窗口、无单实例约束、不监听端口，适合 SSH / 无桌面环境。

**Agent 能力**

- **工具中枢**：注册、启停、调用工具；自动探测并注册本机解释器（JS / Python 等，也支持 Perl / Julia / 编译型与任意可执行文件）；AI 只需写一段能通讯的脚本即可成为工具；工具热更新，每项带成功率 / 平均耗时统计。
- **AI 自建能力**：AI 可通过内置工具自写插件 / 直接执行脚本 / 把脚本沉淀为常驻工具（Rhai 沙箱受限执行，带深度 / 操作数 / 墙钟预算）。
- **记忆与技能**：AI 通过 `add_memory` / `skill` 工具自行总结沉淀，跨会话复用，无需手动触发。
- **目标与子代理**：Autopilot 打开后待办可自动派给子代理并行推进；计划目标与待办在「记忆」页可查可删。

**协议与集成**

- **MCP 客户端**：接入任意标准 MCP 服务器，支持两种传输方式：
  - **Streamable HTTP** — 扫描端口范围或手动填 URL，适合独立部署的 MCP 服务
  - **stdio（JSON-RPC 2.0）** — 粘贴 `{ "mcpServers": { ... } }` 格式配置（兼容 Cursor / Claude Desktop），支持 `command` + `args` + `env`，Windows 下自动 `cmd /c` 包裹 npx/uvx 等 npm 命令
- **MCP 服务器**：BIT 自身也暴露标准 MCP 端点（`POST /mcp`），Claude Desktop 等任何 MCP 客户端可直接调用 BIT 的全部启用工具。
- **OpenAI 兼容端点**：`/v1/chat/completions` 支持流式，第三方应用可把 BIT 当本地 AI 网关使用。
- **本地服务托管（WorkWith）**：托管本机常驻程序并自动接入 MCP，见下一节。

**可靠与治理**

- **安全中心**：左侧盾牌图标进入，两道防线：
  - **HiddenCode 脱敏**：密钥 / 手机号 / 邮箱 / 用户名在发给 AI 前替换为占位符（`[HC:xxxxxx]`）或自定义别名（小明→李四），工具本机执行时自动还原，AI 全程看不到原文；支持内置类型掩码、精确值、自定义正则与粘贴扫描探测
  - **L2 PASS 二级审核（实验）**：工具执行前先由另一个模型审核 Allow / Deny，可覆盖自动放行工具；审核模型不可达时回退人工审批，不打断正常使用
- **文件编码自适应**：read / write / edit 自动探测 BOM / UTF-16 / GBK 等编码，编辑旧文件不改编码，`.bat`/`.cmd`/`.ps1` 写盘自动适配 Windows 脚本编码，也可用 `encoding` 参数显式指定
- **审计日志**：所有工具调用与关键操作留痕，可在「审计」页按主体 / 动作 / 目标过滤。
- **系统托盘**：关窗即驻留托盘不丢任务；右键任务面板（会话回合 / 后台命令 / 子代理 / 活跃目标），悬停只读预览，状态灯白=空闲 黄=进行中 绿=成功 红=受阻。
- **自动更新**：全平台自动检查、下载、换装（可关闭）。
- **数据本地化**：会话、记忆、技能、配置全部保存在本机。

## 扩展与插件

BIT 的扩展能力分三层，**从轻到重**：本地插件（声明式，最省事）→ MCP 扩展（接现成服务器）→ WorkWith（托管你自己的常驻程序）。三者最终都把能力汇入同一个工具注册中心，AI 一视同仁地调用。

### 一、本地插件（plugin.json）

最推荐的方式：**一个文件夹 + 一个 `plugin.json`**，就能一次性声明工具、提示词、技能、记忆和定时任务。

**① 找到插件目录**

插件目录固定在**数据目录**下的 `toolhomes/plugins/`：

| 平台 | 数据目录 | 插件目录 |
|---|---|---|
| Windows | `%APPDATA%\com.bit.hub` | `%APPDATA%\com.bit.hub\toolhomes\plugins\` |
| macOS | `~/Library/Application Support/com.bit.hub` | `~/Library/Application Support/com.bit.hub/toolhomes/plugins/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.bit.hub` | `…/com.bit.hub/toolhomes/plugins/` |

> 设了 `BIT_DATA_DIR` 环境变量时以它为准。打开「工具」页 → 「本地插件」区块，**页面上直接显示当前插件目录的完整路径**，点一下复制即可，不用自己推。

**② 下载或新建一个插件包**

插件包就是一个子目录，目录名即插件 id（`<插件目录>/<插件名>/plugin.json`）。两种来源：

- **下载现成的**：从插件作者发布的仓库 / Releases / 压缩包拿到后，解压到上面那个 `plugins` 目录即可（层级要求：`plugins/<插件名>/plugin.json`）
- **自己写一个**：在 `plugins` 下新建文件夹，放一个 `plugin.json`

一个完整的示例（声明了一个 Python 工具 + 一条提示词 + 一个技能 + 一个定时任务）：

```json
{
  "name": "我的插件",
  "version": "0.1.0",
  "description": "一句话说明这个插件干什么",
  "tools": [{
    "name": "disk_usage",
    "description": "查看指定目录的磁盘占用",
    "parameters": {
      "type": "object",
      "properties": { "path": { "type": "string", "description": "目录路径" } },
      "required": ["path"]
    },
    "kind": "interpreter",
    "runtime": "py",
    "file": "disk_usage.py"
  }],
  "prompts": ["回答时优先使用中文。"],
  "skills": [{ "name": "磁盘排查", "summary": "先用 disk_usage 看占用，再逐层往下钻" }],
  "memories": ["本机默认工作目录是 D:/work"],
  "jobs": [{
    "name": "日报",
    "schedule": "daily 09:00",
    "runtime": "py",
    "file": "daily.py"
  }]
}
```

字段说明（**除 `name` 外全部可选**，`plugin.json` 就是唯一清单文件）：

| 字段 | 说明 |
|---|---|
| `name` / `version` / `description` | 展示信息；插件 id 取**目录名**，无需在文件里写 |
| `tools[]` | 声明的工具。`kind` = `interpreter`（用本机解释器跑）或 `script`（Rhai 沙盒）；`interpreter` 必填 `runtime`（`py` / `js` / `ps1` / …）；源码用 `code` 内联，或用 `file` 指向插件目录内的相对路径（**`file` 优先于 `code`**） |
| `tools[].parameters` | JSON Schema 参数描述，缺省视为无参 |
| `prompts[]` | 启用时追加到系统提示词的指令片段 |
| `skills[]` | 注入技能列表（`name` + `summary`），与 AI 自动提炼的技能同构 |
| `memories[]` | 作为记忆注入的内容 |
| `jobs[]` | 定时任务。`schedule` 支持 `every 30m` / `every 2h` / `every 90s` / `daily 09:00`；`session` 填会话 id 可把结果注入该会话（留空则只记审计日志） |

**工具脚本的通讯约定**（和手写工具完全一致）：**从 stdin 读参数 JSON，把结果打印到 stdout**。所以 `disk_usage.py` 长这样：

```python
import json, sys, shutil
params = json.loads(sys.stdin.read() or '{}')
total, used, free = shutil.disk_usage(params.get("path", "."))
print(json.dumps({"total": total, "used": used, "free": free}, ensure_ascii=False))
```

**③ 生效**

回到「工具」页 → 「本地插件」区块 → 点「**重扫插件**」。插件里的工具会立刻出现在工具列表中，`prompts` / `memories` 下次对话生效。

- 每个插件有独立**启用 / 停用**开关，开关状态存在配置里（`disabled_plugins`），**重扫不会丢掉你的选择**
- 扫描失败的插件会被**跳过并列出错误原因**，不会静默消失——照提示改 `plugin.json` 再重扫即可
- 插件工具走的是既有执行链，自动继承 `toolhomes` 环境与超时配置，安全策略一视同仁

### 二、MCP 扩展（接入现成的 MCP 服务器）

如果你的能力已经是（或能拿到）一个标准 MCP 服务器，直接在「工具」页下方接入，**不需要写任何代码**：

**方式 A：自动扫描（最省事）**

「工具」页 → 「MCP 服务器 · 自动发现」→ 指定起始 / 结束端口 → 扫描 → 发现后一键接入。BIT 会连上去做 `initialize` 握手，把该服务器暴露的工具**自动并入注册表**。工具页的扫描也能发现**局域网内**其它机器的 MCP 服务器。

**方式 B：粘贴端点 URL**

知道 Streamable HTTP 端点时（形如 `http://127.0.0.1:8341/`），直接填 URL 回车接入。

**方式 C：粘贴 `mcpServers` 配置（stdio）**

兼容 Cursor / Claude Desktop 的现成配置，粘进去就能用：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/data"]
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "xxx" }
    }
  }
}
```

每个 stdio 服务器作为**独立子进程**启动，握手完成后工具自动并入；支持 `command` + `args` + `env`，Windows 下自动用 `cmd /c` 包裹 npx / uvx 等命令。已接入的服务器可**暂停 / 恢复 / 移除（kill 进程）/ 重新拉取并导入工具**。

**去哪找 MCP 服务器？**

- 本仓库作者维护的 **[TentacleTool](https://github.com/yxpil/TentacleTool)**：13 个零依赖 MCP 工具集（文件系统 fsx、Git gitx、HTTP httpx、加密 cryptox、数据库 kb、代码图谱 analyze、时间调度 stamp、数据格式 jsonx、本机搜索 find、计算 calc、聚合搜索 search、网页转 MD webview、局域网 neton），每个都自带端口，**扫描端口即可发现**
- 社区合集：[awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)（服务器）、[awesome-mcp-clients](https://github.com/punkpeye/awesome-mcp-clients)（客户端）
- 协议与规范：[Model Context Protocol 官方](https://modelcontextprotocol.io)

### 三、WorkWith：本地服务托管（**添加即可，自动扫描运行**）

「**服务**」页（WorkWith）用来把**本机常驻程序**接进 BIT：用本机已探测的运行环境托管服务器程序（`server.js`、`xxx.jar`，或任意自定义可执行文件）。

**你只需要做一件事：新建条目、填路径、保存。** 之后 BIT 会自动完成剩下的全部动作——

```
填好条目 → 自动拉起程序（无窗口）→ 实时捕获日志 → 自动探测端口就绪
        → 自动扫描并接入为 MCP 服务器 → 该服务上的工具自动可用
停止 / 崩溃 → 自动禁用该 MCP 并同步移除其工具（不留死工具）
```

新建条目需要填的字段：

| 字段 | 说明 |
|---|---|
| 名称 | 展示名，如「我的 MCP 服务」 |
| 运行环境 | 从已探测的解释器里选（node / java / python…），或选「自定义可执行文件」直接跑程序 |
| 程序路径 | 如 `C:/app/server.js` 或 `app.jar` |
| 启动参数 | 空格分隔，如 `--port 3000` |
| 工作目录 / 环境变量 | 可选；环境变量每行一条 `K=V` |
| **服务端口** | 该程序监听的端口。**填 0 = 只托管进程，不联动 MCP** |
| **会话联动** | 勾上后**新会话首回合自动拉起**（幂等，已在运行则跳过）；不勾则手动点「启动」 |

页面内可直接展开看**运行日志**（stdout / stderr，1 秒轮询，进程退出由事件刷新兜底），条目卡片上会显示「运行中 · PID」「**MCP 已接入**」等状态。**删除条目时，运行中的服务会被停止，其 MCP 工具同步移除。**

> 典型用法：让 AI 在对话前**自动拉起你自己的本地 MCP 服务 / 数据库网关 / 构建脚本服务**，用完即停——既省手，又不会留下常驻进程。
> 一句话概括：**在 WorkWith 里添加即可，它会自动扫描运行、自动接入。**

### 排查建议

- 工具调用失败：先看对话里的工具卡片与「工具」页的「最近错误」，再到「审计」页核对调用记录
- MCP 扫描不到：扩大端口范围，或直接填 URL；stdio 配置格式错误会启动失败，日志在「服务」页与「工具」页均有提示
- 远程调用工具（OpenAI 兼容端点或 MCP 端点）同样受工具启用开关与审批模式约束
- 插件不生效：确认层级是 `plugins/<插件名>/plugin.json`（不能多层嵌套），改完点「重扫插件」；扫描错误会直接列出

## 安装使用

从 [Releases](https://github.com/yxpil/BrainTentacle/releases) 下载对应平台的安装包：

| 平台 | 安装包 | 说明 |
|---|---|---|
| Windows x64 | `BIT_<版本>_x64-setup.exe`（NSIS） | 双击安装；ARM64 笔记本（骁龙 X）选 `aarch64` 版 |
| macOS Apple Silicon | `BIT_<版本>_aarch64.dmg` | M 系列芯片 |
| macOS Intel | `BIT_<版本>_x64.dmg` | 拖入 Applications 安装 |
| Linux x64 / ARM64 | `BIT_<版本>_amd64.deb` / `.AppImage` / `.x86_64.rpm` | 按发行版习惯选择 |
| 龙芯 LoongArch64（3A5000/3A6000） | 见下方 musl/exotic 说明 | 建议下载 Tauri 版 BIT 安装包 |
| RISC-V 64（VisionFive 2 等） | 见下方 musl/exotic 说明 | 建议下载 Tauri 版 BIT 安装包 |
| 飞腾 / 鲲鹏 / 麒麟 ARM | `BIT_<版本>_aarch64.deb` / `.AppImage` / `.rpm` | 与 Linux ARM64 通用 |
| 兆芯 / 海光 | `BIT_<版本>_amd64.deb` / `.AppImage` / `.x86_64.rpm` | 与 Linux x64 通用 |

> **musl（Alpine）/ exotic（龙芯 / RISC-V / ppc64le）架构**：本仓库在这些架构上仅提供 `bit-cli_*`（TUI / worker / guardian 命令行形态）。
> 需要 GUI 版时可直接下载 **Tauri 版 BIT** 的安装包（[bit releases](https://github.com/yxpil/bit/releases)，与 Electron 版共用同一份 Rust 核心与同一数据目录）。

> 全部支持的芯片架构与操作系统明细（含飞腾 / 鲲鹏 / 麒麟 / UOS / ChromeOS 矩阵）见 Wiki：[安装与更新](https://github.com/yxpil/BrainTentacle/wiki/安装与更新)。

### 包管理器安装

macOS（Homebrew）：

```bash
brew tap yxpil/bit
brew install --cask bit
```

Windows（Scoop）：

```powershell
scoop bucket add bit https://github.com/yxpil/scoop-bit
scoop install bit
```

npm（跨平台，自动下载对应平台应用）：

```bash
npm install -g bit-agent
bit-agent   # 启动 BIT
```

Windows（winget，审核中）：`winget install yxpil.bit`

Debian / Ubuntu / UOS / 麒麟（APT 源）：

```bash
echo "deb [trusted=yes] https://yxpil.github.io/apt-repo stable main" | sudo tee /etc/apt/sources.list.d/bit.list
sudo apt update && sudo apt install bit
```

Fedora / RHEL / openSUSE（dnf 源）：

```bash
sudo tee /etc/yum.repos.d/bit.repo <<'EOF'
[bit]
name=BIT
baseurl=https://yxpil.github.io/dnf-repo
enabled=1
gpgcheck=0
EOF
sudo dnf install bit
```

Arch / Manjaro（pacman 源）：

```bash
echo "
[bit]
Server = https://yxpil.github.io/pacman-repo/\$arch
SigLevel = Never" | sudo tee /etc/pacman.d/bit.conf
# 在 /etc/pacman.conf 的 [core] 前加一行：Include = /etc/pacman.d/bit.conf
sudo pacman -Sy bit
```

### 安装疑难

**macOS 提示「已损坏，无法打开」？**

BIT 目前未购买 Apple 开发者证书（$99/年），采用 ad-hoc 签名。macOS 对**从网络下载**的应用默认拦截，新系统会直接报「已损坏」。以下任一方式即可正常使用：

方式一：移除隔离属性（最可靠，推荐）

```bash
# 安装后执行一次即可
xattr -cr /Applications/BIT.app
```

方式二：系统设置放行 —— 双击 dmg 安装，首次打开若弹出警告**先不要点「移到废纸篓」**，到 系统设置 → 隐私与安全性 → 滚动到下方安全区 → 点「**仍要打开**」。

方式三：右键打开（macOS 14 及更早）—— 按住 Control（或右键）点击 BIT → 选「打开」→ 再点「打开」确认。

> 原理：`xattr -cr` 删除文件的 quarantine 隔离标记；签名本身完整可校验，去掉隔离后 macOS 不再拦截。

**Windows 首次运行提示 SmartScreen？**

安装包未做代码签名（EV 证书同样需付费）。SmartScreen 弹窗时点「**更多信息**」→「**仍要运行**」即可。

**Linux 运行 AppImage**

```bash
chmod +x BIT_<版本>_amd64.AppImage
./BIT_<版本>_amd64.AppImage
```

**ChromeOS（Crostini）**

ChromeOS 内置 Linux 开发环境（Debian 12 容器），BIT 的 Linux 安装包可直接使用，无需专门版本：

1. 设置 → 关于 ChromeOS → 开发者 → Linux 开发环境 → 启用（Intel/AMD 与 ARM 机型均支持）
2. 在 Linux 终端安装（Intel/AMD 选 amd64，ARM 选 arm64）：`sudo apt install ./BIT_<版本>_amd64.deb`

依赖（libwebkit2gtk-4.1、libgtk-3、libayatana-appindicator3）会由 Debian 12 仓库自动补齐；安装后 BIT 出现在「Linux 应用」文件夹，窗口经 Wayland 显示，与原生 Linux 体验一致。

### 首次使用

进入「AI 设置」→ 添加一个提供方（协议 / Base URL / API Key / 模型，可点「从 API 获取」拉取模型列表）→ 点击播放按钮激活 → 回到「对话」开始使用。

终端场景：安装后在任意终端输入 `bit` 直接进入 TUI 对话。

## 远程访问与 API

「远程」页开启后，BIT 在本机监听 HTTP API（默认 `127.0.0.1:8600`，可改为 `0.0.0.0` 供局域网访问；默认关闭，开启时自动生成密钥与访问密码）。

**认证**

- **Client Key**（`bit_` 前缀，自动生成）：`Authorization: Bearer <key>` 或 `?key=<key>`——用于 `/v1/*` 与 `/mcp` 端点
- **访问密码**：`/api/*` 管理端点额外要求 `X-Access-Password` 头（OpenAI / MCP 客户端无法携带自定义头，故豁免）

**端点**

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v1/chat/completions` | POST | OpenAI 兼容对话（支持 SSE 流式） |
| `/v1/models` | GET | 模型列表 |
| `/mcp` | POST / DELETE | 标准 MCP 服务器（Streamable HTTP / JSON-RPC 2.0） |
| `/api/*` | — | 会话 / 配置 / 审计等管理接口（需访问密码） |
| `/api/health` | GET | 健康检查（无需认证） |

```bash
curl http://127.0.0.1:8600/v1/chat/completions \
  -H "Authorization: Bearer $BIT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"YOUR_MODEL","messages":[{"role":"user","content":"列出当前目录"}]}'
```

任何支持 OpenAI 接口的客户端（Cherry Studio、LobeChat、沉浸式翻译等）都可把 BIT 当本地模型服务接入，支持流式输出与图片多模态透传。手机端用 [bit-mobile](https://github.com/yxpil/bit-mobile) 扫码配对（局域网 → IPv6 直连 → 云中继）。

详见 Wiki：[远程访问与 API](https://github.com/yxpil/BrainTentacle/wiki/工具与-MCP)。

## 文档

完整文档在 [Wiki](https://github.com/yxpil/BrainTentacle/wiki)：

- **入门**：[快速上手](https://github.com/yxpil/BrainTentacle/wiki/快速上手) · [安装与更新](https://github.com/yxpil/BrainTentacle/wiki/安装与更新) · [功能总览](https://github.com/yxpil/BrainTentacle/wiki/功能总览) · [FAQ](https://github.com/yxpil/BrainTentacle/wiki/FAQ)
- **扩展**：[扩展与插件](https://github.com/yxpil/BrainTentacle/wiki/扩展与插件) · [工具与 MCP](https://github.com/yxpil/BrainTentacle/wiki/工具与-MCP)
- **安全**：[安全与脱敏](https://github.com/yxpil/BrainTentacle/wiki/安全与脱敏)
- **参与**：[开发与构建](https://github.com/yxpil/BrainTentacle/wiki/开发与构建) · [友情链接](https://github.com/yxpil/BrainTentacle/wiki/友情链接)

在线站点：[osbt.space](https://osbt.space)

## 安全与隐私

- **数据本地化**：会话、记忆、技能、配置全部保存在本机应用数据目录（Windows 默认 `%APPDATA%\com.bit.hub`，核心库 `bit.db`），不上传遥测。
- **敏感信息脱敏**：HiddenCode 让 AI 处理任务时看不到真实密钥 / 手机号 / 邮箱 / 用户名，占位符或别名在本机执行工具时才还原。
- **双重审核**：普通审批之外，L2 PASS 可用第二个模型对工具调用做 Allow / Deny 审核，决定全部记入审计。
- **双重认证**：Client Key（常数时间比较防时序侧信道）+ 访问密码；远程访问默认关闭，本地服务默认只绑定环回地址。
- **加密存储**：设备密钥派生加密敏感配置，带防篡改校验。
- **沙箱与限额**：AI 自建脚本经 Rhai 沙箱受限执行（深度 / 操作数 / 墙钟预算）；子进程工具带超时杀灭、输出上限与资源回收。
- **扩展来源可控**：插件是本地声明式文件（不下载即不执行），MCP / WorkWith 接入的每个服务器与工具都有独立启停开关，随时可断开——**接入谁、跑什么，始终由你决定**。
- **MCP 会话治理**：会话 30 分钟空闲过期、数量上限、显式 DELETE 终止。
- **签名透明**：macOS ad-hoc 签名 / Windows 无 EV 证书（均为无付费证书的取舍，见上方安装说明），源码与 CI 构建流程全部公开可查。

详见 Wiki：[安全与脱敏](https://github.com/yxpil/BrainTentacle/wiki/安全与脱敏) · [SECURITY.md](SECURITY.md)

## 友情链接

**本项目的官方入口**

| 资源 | 说明 |
|---|---|
| [osbt.space](https://osbt.space) | 官网与在线文档 |
| [Releases](https://github.com/yxpil/BrainTentacle/releases) | 全平台安装包与更新日志 |
| [Wiki](https://github.com/yxpil/BrainTentacle/wiki) | 完整使用文档 |
| [QQ 交流群](https://qm.qq.com/q/qlFr8ct0ps) | 反馈与交流 |
| [Issues](https://github.com/yxpil/BrainTentacle/issues) | Bug 与功能建议 |

**同门项目（同一作者，可与 BIT 组合使用）**

| 项目 | 说明 |
|---|---|
| [TentacleTool](https://github.com/yxpil/TentacleTool) | 触手怪的 MCP 工具集：**13 个零依赖 MCP 服务器**（文件系统 / Git / HTTP / 加密 / 数据库 / 代码图谱 / 时间调度 / 数据格式 / 搜索 / 计算…），扫描端口即可接入 BIT |
| [bit](https://github.com/yxpil/bit) | 同一 Rust 核心的 Tauri 2 原生壳版本（龙芯 / RISC-V 等架构的 GUI 首选） |
| [bit-mobile](https://github.com/yxpil/bit-mobile) | 安卓伴侣端：扫码配对，随身对话 / 工具审批 / 多路连接 |
| [BITSDK](https://github.com/yxpil/BITSDK) | 让开发者在自己的程序里调用 BIT 的能力 |
| [PANOPTES](https://github.com/yxpil/PANOPTES) | 屏幕操作 MCP 服务器（截图 + 鼠标键盘控制） |
| [Neton](https://github.com/yxpil/Neton) | 智能体操作网络系统的工具（局域网设备发现 / 端口扫描 / 协议分析 / 抓包） |
| [Firelin](https://github.com/yxpil/Firelin) | 智能体网络渗透工具集 |
| [ADONWORD](https://github.com/yxpil/ADONWORD) | 智能体主动防御工具 |
| [HOWCUEME](https://github.com/yxpil/HOWCUEME) | 智能体条件自唤醒程序 |
| [MemoryPool](https://github.com/yxpil/MemoryPool) | 智能体记忆池程序 |
| [SECFORGE](https://github.com/yxpil/SECFORGE) | 把上述安全卫星聚合成 29 个 MCP 工具的统一入口 |

**生态与标准**

- [Model Context Protocol](https://modelcontextprotocol.io) — BIT 的 MCP 实现遵循的开放协议与规范
- [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) — MCP 服务器合集，在这里找扩展
- [awesome-mcp-clients](https://github.com/punkpeye/awesome-mcp-clients) — MCP 客户端合集
- [Tauri](https://tauri.app) · [Electron](https://www.electronjs.org) · [React](https://react.dev) — BIT 的桌面壳与前端基础

> 想把自己的项目加进这份名单？欢迎提 [Issue](https://github.com/yxpil/BrainTentacle/issues) 或 PR。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18、Vite 6、Tailwind CSS 4、react-markdown + remark-gfm |
| 桌面壳 | Electron（托盘形态，全平台发行）+ Tauri 2（原生形态） |
| 核心 | Rust：reqwest（含 stream）、tokio、axum、rhai、futures-util |
| 桥接 | N-API（Electron 复用同一份 Rust 核心） |

## 开发

前置：[Node.js](https://nodejs.org/)、[Rust](https://www.rust-lang.org/) 工具链、Tauri 系统依赖。

```bash
npm install          # 安装前端依赖
npm run tauri dev    # Tauri 开发模式（热更新）
npm run tauri build  # 构建 Tauri release（NSIS / MSI / dmg / AppImage / deb）
```

Electron 壳的构建见 `electron-builder.yml` 与 `scripts/stage-pack.cjs`；本地运行、测试与发版流程详见 Wiki [开发与构建](https://github.com/yxpil/BrainTentacle/wiki/开发与构建)。

## 项目结构

```
src/               React 前端
  pages/           对话 / 工具 / 服务(WorkWith) / 记忆 / 技能 / 审计 / 安全 / 远程 / AI 设置 / 主题
  components/      Markdown、工具卡片、图标等
crates/bit-core/   Rust 核心：ai、agent、mcp、registry、runtime、script_runtime、
                   http_api、update、audit、session、goal、memory、plugins、workwith …
crates/bit-napi/   Electron 用的 N-API 桥
src-tauri/         Tauri 壳（原生版）
electron/          Electron 壳（托盘、preload）
packaging/         npm / flatpak / musl / exotic / Arch 等分发通道
installer/bit.iss  Inno Setup 打包脚本
```

## 许可

[Apache License 2.0](LICENSE) — **BIT 永久免费**：所有功能无内购、无订阅、无功能锁，个人与商业使用均免费。
