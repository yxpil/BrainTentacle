# BIT — Agent Tool Hub

**English** | [简体中文](README.md)

[![Release](https://img.shields.io/github/v/release/yxpil/BrainTentacle?style=flat-square&label=%E7%89%88%E6%9C%AC)](https://github.com/yxpil/BrainTentacle/releases/latest) [![下载](https://img.shields.io/github/downloads/yxpil/BrainTentacle/total?style=flat-square&label=%E4%B8%8B%E8%BD%BD)](https://github.com/yxpil/BrainTentacle/releases) [![License](https://img.shields.io/github/license/yxpil/BrainTentacle?style=flat-square)](https://github.com/yxpil/BrainTentacle/blob/main/LICENSE) [![CI](https://img.shields.io/github/actions/workflow/status/yxpil/BrainTentacle/release.yml?style=flat-square&label=CI)](https://github.com/yxpil/BrainTentacle/actions) [![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux%20%C2%B7%20%E9%BE%99%E8%8A%AF%20%C2%B7%20RISC--V-black?style=flat-square)](https://osbt.space) [![官网](https://img.shields.io/website?up_message=osbt.space&down_message=%E7%A6%BB%E7%BA%BF&style=flat-square&url=https%3A%2F%2Fosbt.space)](https://osbt.space) [![QQ群](https://img.shields.io/badge/QQ%E7%BE%A4-%E7%82%B9%E5%87%BB%E5%8A%A0%E5%85%A5-black?style=flat-square)](https://qm.qq.com/q/qlFr8ct0ps)

[![Homebrew](https://img.shields.io/badge/Homebrew-brew%20install%20--cask%20bit-black?style=flat-square)](https://github.com/yxpil/homebrew-bit) [![Scoop](https://img.shields.io/badge/Scoop-scoop%20install%20bit-black?style=flat-square)](https://github.com/yxpil/scoop-bit) [![npm](https://img.shields.io/badge/npm-bit--agent-black?style=flat-square)](https://www.npmjs.com/package/bit-agent) [![winget](https://img.shields.io/badge/winget-yxpil.bit-black?style=flat-square)](https://github.com/yxpil/BrainTentacle/releases) [![APT](https://img.shields.io/badge/APT-yxpil%2Fapt--repo-black?style=flat-square)](https://yxpil.github.io/apt-repo) [![DNF](https://img.shields.io/badge/DNF-yxpil%2Fdnf--repo-black?style=flat-square)](https://yxpil.github.io/dnf-repo) [![pacman](https://img.shields.io/badge/pacman-yxpil%2Fpacman--repo-black?style=flat-square)](https://yxpil.github.io/pacman-repo)

BIT is a desktop AI Agent tool hub: an **Electron tray shell + Rust core (`bit-core`) + React frontend** (the same core also builds a Tauri 2 native shell). Configure any AI provider to chat over streaming, and let the AI call local tools, write its own scripts, and accumulate memory and skills — with secrets masked from the model and all data kept on your machine. Auditable and remotely accessible.

**BIT is free forever**: fully open source (Apache-2.0), every feature free for individuals and businesses — no in-app purchases, no subscriptions, no locked features, no telemetry; build it yourself from source anytime.

> Frameless custom title bar · Dark/light themes · Minimal black-and-white design · [QQ group](https://qm.qq.com/q/qlFr8ct0ps)

## Table of Contents

[Quick Start](#quick-start) · [Features](#features) · [Extensions & Plugins](#extensions--plugins) · [Installation](#installation) · [Remote Access & API](#remote-access--api) · [Documentation](#documentation) · [Security & Privacy](#security--privacy) · [Friendly Links](#friendly-links) · [Tech Stack](#tech-stack) · [Development](#development) · [Project Structure](#project-structure) · [License](#license)

## Quick Start

**① Install and launch**

Download your platform's installer from [Releases](https://github.com/yxpil/BrainTentacle/releases) (Windows: `BIT_<version>_x64-setup.exe`; macOS: the `dmg` matching your chip; Linux: `AppImage` / `deb` / `rpm`), or use a package manager (see [Installation](#installation)). If macOS reports "damaged" or Windows shows SmartScreen on first launch, follow [Installation Troubleshooting](#installation-troubleshooting).

**② Configure a model**

Go to **AI Settings** → **Add provider** → pick a protocol (OpenAI / Gemini / Claude), fill in Base URL, API Key and model name (click **Fetch from API** to pull the model list) → click the **play button** on that entry to activate it. Only one provider is active at a time; the others pause automatically.

**③ Start chatting**

Go back to **Chat** and just ask. Tool calls show up as cards with their arguments and results. Approval mode has three levels: **ask every time / auto-approve (dangerous operations still ask) / allow everything**. Replies stream in character by character, with the thinking process shown separately.

**④ Put it to work**

Try these natural-language prompts to feel the tool hub:

```
List the files in the current directory and total their sizes
Write a script that summarizes this week's git log by author into a table
Look up this error message for me
Remember that this project uses pnpm, not npm
```

The AI picks tools on its own, writes scripts when needed, and distills useful conclusions via `add_memory` / `skill` for reuse across sessions.

**⑤ Add extensions (optional — this is where BIT shines)**

Three layers of extensibility; pick whichever fits. See [Extensions & Plugins](#extensions--plugins):

- **Local plugins**: drop a plugin package (a folder with `plugin.json`) into the plugins directory and hit **Rescan plugins** — tools, prompts, skills and scheduled jobs all take effect at once
- **MCP extensions**: paste an `mcpServers` config (Cursor / Claude Desktop compatible), or scan a port range for auto-discovery
- **WorkWith**: on the **Services** page, enter the program path — **adding it is all you do: BIT starts the program, scans the port and links it as an MCP server automatically**, so its tools are plug-and-play

**⑥ Use it from your phone (optional)**

Enable the **Remote** page and scan the QR code with the [bit-mobile](https://github.com/yxpil/bit-mobile) Android app to chat and approve tool calls on the go. You can also use BIT as an OpenAI-compatible gateway for other clients — see [Remote Access & API](#remote-access--api).

> For a step-by-step walkthrough (plus common blockers), see the wiki page [快速上手 / Quick Start](https://github.com/yxpil/BrainTentacle/wiki/快速上手).
> Terminal users: after installing, type `bit` in any terminal to enter the TUI chat (no window, no single-instance constraint, no port listening).

## Features

**Chat & AI**

- **Streaming chat**: end-to-end streaming across frontend and backend (SSE + Electron/Tauri Event); replies render character by character; the thinking process is shown separately; assistant messages support Markdown rendering (tables, code blocks, etc.); real-time cache-hit-rate stats.
- **Multi-provider**: the OpenAI / Gemini / Claude protocols; multiple providers can be configured but **only one is active at a time** (mutually exclusive); test upstream connectivity before saving; "Fetch from API" pulls the model list in one click.
- **Multimodal**: image input is supported and sent along with the message to multimodal models.
- **Long-conversation governance**: one-click compression into a summary; favourites, colour labels and multi-select deletion for sessions; tasks keep running when you switch away, and long commands move to the background automatically.
- **Terminal mode**: type `bit` in any terminal to enter a minimal TUI — no window, no single-instance constraint, no port listening. Ideal for SSH / headless environments.

**Agent capabilities**

- **Tool hub**: register, enable/disable, and invoke tools; auto-detects and registers local interpreters (JS / Python, plus Perl / Julia / compiled languages and arbitrary executables) — the AI only needs to write a script that can communicate and it becomes a tool; tools hot-reload, each with success-rate and average-latency stats.
- **AI-built capabilities**: the AI can write its own plugins via built-in tools / execute scripts directly / promote scripts into persistent tools (executed inside the restricted Rhai sandbox with depth / operation / wall-clock budgets).
- **Memory and skills**: the AI summarizes and stores knowledge by itself via the `add_memory` / `skill` tools, reused across sessions — no manual triggering.
- **Goals and sub-agents**: with Autopilot on, todos can be dispatched to sub-agents in parallel; planned goals and todos are listed (and deletable) on the **Memory** page.

**Protocols & integration**

- **MCP client**: connect to any standard MCP server with two transports:
  - **Streamable HTTP** — scan port range or enter URL manually, for standalone MCP services
  - **stdio (JSON-RPC 2.0)** — paste Cursor/Claude Desktop compatible `{ "mcpServers": { ... } }` config JSON (supports `command` + `args` + `env`); on Windows, npm commands like `npx`/`uvx` are automatically wrapped with `cmd /c`
- **MCP server**: BIT itself also exposes a standard MCP endpoint (`POST /mcp`); any MCP client such as Claude Desktop can directly call all of BIT's enabled tools.
- **OpenAI-compatible endpoint**: `/v1/chat/completions` supports streaming, so third-party apps can use BIT as a local AI gateway.
- **Local service hosting (WorkWith)**: host your own long-running programs and have them linked as MCP servers automatically — see the next section.

**Reliability & governance**

- **Security Center**: shield icon in the left sidebar, two lines of defense:
  - **HiddenCode masking**: API keys / phone numbers / emails / usernames are replaced with placeholders (`[HC:xxxxxx]`) or custom aliases (小明→李四) before being sent to the AI; real values are restored only when tools run locally. Supports built-in type masking, exact values, custom regexes, and paste-to-scan detection
  - **L2 PASS second-model review (experimental)**: before a tool runs, a second model reviews it for Allow / Deny (can also cover auto-approved tools); falls back to manual approval when the reviewer is unreachable
- **File encoding auto-detection**: read / write / edit auto-detect BOM / UTF-16 / GBK encodings, preserve source encoding on edit, adapt `.bat`/`.cmd`/`.ps1` script encoding on Windows, or take an explicit `encoding` parameter
- **Audit log**: all tool calls and key operations are logged, filterable by actor / action / target on the **Audit** page.
- **System tray**: closing the window keeps BIT in the tray without dropping tasks; right-click for the task panel (session turns / background commands / sub-agents / active goals), hover for a read-only preview; the status dot is white = idle, yellow = working, green = last task succeeded, red = blocked.
- **Auto update**: checks, downloads, and swaps in new versions automatically on all platforms (can be disabled).
- **Local-first data**: sessions, memory, skills, and settings all stay on your machine.

## Extensions & Plugins

BIT extends in three layers, **from lightest to heaviest**: local plugins (declarative, easiest) → MCP extensions (wire up an existing server) → WorkWith (host your own long-running program). All three feed the same tool registry, and the AI calls them uniformly.

### 1. Local plugins (`plugin.json`)

The recommended path: **one folder + one `plugin.json`** declares tools, prompts, skills, memories and scheduled jobs in a single shot.

**① Find the plugins directory**

It always lives under the **data directory** at `toolhomes/plugins/`:

| Platform | Data directory | Plugins directory |
|---|---|---|
| Windows | `%APPDATA%\com.bit.hub` | `%APPDATA%\com.bit.hub\toolhomes\plugins\` |
| macOS | `~/Library/Application Support/com.bit.hub` | `~/Library/Application Support/com.bit.hub/toolhomes/plugins/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.bit.hub` | `…/com.bit.hub/toolhomes/plugins/` |

> The `BIT_DATA_DIR` environment variable overrides the base. On the **Tools** page, the **Local plugins** section **displays the full plugins path** — click to copy it instead of deriving it yourself.

**② Download or create a plugin package**

A plugin package is just a subdirectory whose **name becomes the plugin id** (`<plugins>/<plugin-name>/plugin.json`). Two sources:

- **Download one**: unpack a released plugin (repo / Releases / archive) into the `plugins` directory, keeping the layout `plugins/<plugin-name>/plugin.json`
- **Write your own**: create a folder under `plugins` and add a `plugin.json`

A complete example (one Python tool + a prompt + a skill + a scheduled job):

```json
{
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "One line about what this plugin does",
  "tools": [{
    "name": "disk_usage",
    "description": "Report disk usage for a directory",
    "parameters": {
      "type": "object",
      "properties": { "path": { "type": "string", "description": "Directory path" } },
      "required": ["path"]
    },
    "kind": "interpreter",
    "runtime": "py",
    "file": "disk_usage.py"
  }],
  "prompts": ["Answer in English by default."],
  "skills": [{ "name": "Disk triage", "summary": "Start with disk_usage, then drill down level by level" }],
  "memories": ["The default working directory on this machine is D:/work"],
  "jobs": [{
    "name": "Daily report",
    "schedule": "daily 09:00",
    "runtime": "py",
    "file": "daily.py"
  }]
}
```

Field reference (**everything except `name` is optional**; `plugin.json` is the only manifest):

| Field | Description |
|---|---|
| `name` / `version` / `description` | Display info; the plugin **id comes from the directory name**, so you need not write it |
| `tools[]` | Declared tools. `kind` = `interpreter` (run with a local interpreter) or `script` (Rhai sandbox); `interpreter` requires `runtime` (`py` / `js` / `ps1` / …); source via inline `code` or a plugin-relative `file` (**`file` wins over `code`**) |
| `tools[].parameters` | JSON Schema for the arguments; omitted means no arguments |
| `prompts[]` | Instruction fragments appended to the system prompt while enabled |
| `skills[]` | Injected into the skill list (`name` + `summary`), structurally identical to AI-distilled skills |
| `memories[]` | Injected as memory entries |
| `jobs[]` | Scheduled jobs. `schedule` accepts `every 30m` / `every 2h` / `every 90s` / `daily 09:00`; set `session` to a session id to inject the result there (empty = audit log only) |

**Tool script contract** (identical to hand-written tools): **read the argument JSON from stdin, print the result to stdout**. So `disk_usage.py` looks like:

```python
import json, sys, shutil
params = json.loads(sys.stdin.read() or '{}')
total, used, free = shutil.disk_usage(params.get("path", "."))
print(json.dumps({"total": total, "used": used, "free": free}, ensure_ascii=False))
```

**③ Activate**

Back on the **Tools** page → **Local plugins** → click **Rescan plugins**. The plugin's tools appear in the tool list immediately; `prompts` / `memories` apply from the next turn.

- Each plugin has its own **enable / disable** switch, stored in config (`disabled_plugins`) — **rescanning never loses your choice**
- Plugins that fail to scan are **skipped and listed with the reason**, never silently dropped — fix `plugin.json` per the message and rescan
- Plugin tools run through the existing execution chain and inherit the `toolhomes` environment and timeout settings, so security policy applies equally

### 2. MCP extensions (wire up an existing MCP server)

If the capability you want already is (or can be) a standard MCP server, connect it at the bottom of the **Tools** page — **no code required**:

**Option A — Auto-scan (easiest)**

**Tools** page → **MCP servers · auto-discovery** → set the start / end ports → scan → connect with one click. BIT performs the `initialize` handshake and **merges the server's tools into the registry**. The same scan also finds MCP servers on other machines on your LAN.

**Option B — Enter an endpoint URL**

If you know the Streamable HTTP endpoint (e.g. `http://127.0.0.1:8341/`), paste the URL and press Enter.

**Option C — Paste an `mcpServers` config (stdio)**

Cursor / Claude Desktop configs work as-is:

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

Each stdio server runs as an **independent child process**; once the handshake completes its tools are merged automatically. `command` + `args` + `env` are supported, and on Windows `npx` / `uvx` are wrapped with `cmd /c`. Connected servers can be **paused / resumed / removed (kills the process) / re-pulled to re-import tools**.

**Where to find MCP servers**

- **[TentacleTool](https://github.com/yxpil/TentacleTool)** by the same author: **13 zero-dependency MCP toolsets** (filesystem `fsx`, Git `gitx`, HTTP `httpx`, crypto `cryptox`, database `kb`, code graph `analyze`, time & scheduling `stamp`, data formats `jsonx`, local search `find`, calculator `calc`, aggregated search `search`, web-to-Markdown `webview`, LAN `neton`). Each listens on its own port — **just scan the port range**
- Community collections: [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) (servers), [awesome-mcp-clients](https://github.com/punkpeye/awesome-mcp-clients) (clients)
- Specification: [Model Context Protocol](https://modelcontextprotocol.io)

### 3. WorkWith: local service hosting (**add it, and it scans & runs automatically**)

The **Services** page (WorkWith) brings your **local long-running programs** into BIT, using the runtimes BIT already detected (`server.js`, `xxx.jar`, or any custom executable).

**All you do is create an entry, fill in the path, and save.** BIT then performs every remaining step on its own:

```
save entry -> start the program (no window) -> capture logs live -> detect the port becoming ready
          -> automatically scan and link it as an MCP server -> its tools become available
stop / crash -> automatically disable that MCP server and remove its tools (no dead tools left)
```

Entry fields:

| Field | Description |
|---|---|
| Name | Display name, e.g. "My MCP service" |
| Runtime | Pick a detected interpreter (node / java / python…) or "custom executable" to run the binary directly |
| Program path | e.g. `C:/app/server.js` or `app.jar` |
| Arguments | Space-separated, e.g. `--port 3000` |
| Working directory / Env vars | Optional; one `K=V` per line for env vars |
| **Service port** | The port the program listens on. **`0` = host the process only, no MCP linking** |
| **Link to session** | When checked, **the first turn of a new session starts it automatically** (idempotent — skipped if already running); unchecked means manual Start |

The page shows **live logs** (stdout / stderr, polled once a second with event-driven fallback on exit), and each entry card shows "running · PID" and "**MCP linked**". **Deleting an entry stops the running service and removes its MCP tools.**

> Typical use: have BIT **automatically start your own local MCP service / database gateway / build-script service** before a conversation, and stop it when done — convenient, with no leftover processes.
> In one line: **just add it in WorkWith — it scans, runs and links automatically.**

### Troubleshooting

- Tool call fails: check the tool card in the chat and "last error" on the **Tools** page, then verify the record on the **Audit** page
- MCP server not discovered: widen the port range, or enter the URL directly; a malformed stdio config fails to start — logs appear on both the **Services** and **Tools** pages
- Tools invoked remotely (OpenAI-compatible or MCP endpoint) are still subject to per-tool enable switches and the approval mode
- Plugin not taking effect: make sure the layout is `plugins/<plugin-name>/plugin.json` (no extra nesting) and hit **Rescan plugins**; scan errors are listed directly

## Installation

Download the installer for your platform from [Releases](https://github.com/yxpil/BrainTentacle/releases):

| Platform | Installer | Notes |
|---|---|---|
| Windows x64 | `BIT_<version>_x64-setup.exe` (NSIS) | Double-click to install; ARM64 laptops (Snapdragon X) should pick the `aarch64` build |
| macOS Apple Silicon | `BIT_<version>_aarch64.dmg` | M-series chips |
| macOS Intel | `BIT_<version>_x64.dmg` | Drag into Applications to install |
| Linux x64 / ARM64 | `BIT_<version>_amd64.deb` / `.AppImage` / `.x86_64.rpm` | Pick whichever fits your distro's convention |
| Loongson LoongArch64 (3A5000/3A6000) | See musl/exotic note below | Tauri-based BIT installer recommended |
| RISC-V 64 (VisionFive 2, etc.) | See musl/exotic note below | Tauri-based BIT installer recommended |
| Phytium / Kunpeng / Kylin ARM | `BIT_<version>_aarch64.deb` / `.AppImage` / `.rpm` | Same as Linux ARM64 |
| Zhaoxin / Hygon | `BIT_<version>_amd64.deb` / `.AppImage` / `.x86_64.rpm` | Same as Linux x64 |

> **musl (Alpine) / exotic (LoongArch / RISC-V / ppc64le)**: this repo only ships `bit-cli_*` (TUI / worker / guardian CLI) for these architectures.
> For a GUI, download the **Tauri-based BIT** installer ([bit releases](https://github.com/yxpil/bit/releases)) — it shares the same Rust core and the same data directory as the Electron build.

> For the full breakdown of supported CPU architectures and operating systems (including the Phytium / Kunpeng / Kylin / UOS / ChromeOS matrix), see the wiki: [安装与更新 / Installation](https://github.com/yxpil/BrainTentacle/wiki/安装与更新).

### Package Managers

macOS (Homebrew):

```bash
brew tap yxpil/bit
brew install --cask bit
```

Windows (Scoop):

```powershell
scoop bucket add bit https://github.com/yxpil/scoop-bit
scoop install bit
```

npm (cross-platform; automatically downloads the app for your platform):

```bash
npm install -g bit-agent
bit-agent   # Start BIT
```

Windows (winget, under review): `winget install yxpil.bit`

Debian / Ubuntu / UOS / Kylin (APT repository):

```bash
echo "deb [trusted=yes] https://yxpil.github.io/apt-repo stable main" | sudo tee /etc/apt/sources.list.d/bit.list
sudo apt update && sudo apt install bit
```

Fedora / RHEL / openSUSE (dnf repository):

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

Arch / Manjaro (pacman repository):

```bash
echo "
[bit]
Server = https://yxpil.github.io/pacman-repo/\$arch
SigLevel = Never" | sudo tee /etc/pacman.d/bit.conf
# Add this line before [core] in /etc/pacman.conf: Include = /etc/pacman.d/bit.conf
sudo pacman -Sy bit
```

### Installation Troubleshooting

**macOS Says the App "Is Damaged and Can't Be Opened"?**

BIT does not currently hold a paid Apple Developer certificate ($99/year) and is signed ad-hoc. macOS blocks apps **downloaded from the internet** by default, and newer systems report them as "damaged" outright. Any of the following fixes it:

**Option 1: Remove the quarantine attribute (most reliable, recommended)**

```bash
# Run once after installing
xattr -cr /Applications/BIT.app
```

**Option 2: Allow it in System Settings**

1. Double-click the dmg to install. If a warning appears on first launch, **do not click "Move to Trash" yet**
2. Open System Settings → Privacy & Security → scroll down to the Security section → click **"Open Anyway"**

**Option 3: Right-click to open (macOS 14 and earlier)**

Control-click (or right-click) BIT → choose "Open" → click "Open" again to confirm.

> Why it works: `xattr -cr` removes the file's quarantine attribute; the signature itself is intact and verifiable, so once quarantine is removed macOS no longer blocks it.

**Windows SmartScreen Warning on First Launch?**

The installer is not code-signed (EV certificates also cost money). When the SmartScreen prompt appears, click **"More info" → "Run anyway"**.

**Running the AppImage on Linux**

```bash
chmod +x BIT_<version>_amd64.AppImage
./BIT_<version>_amd64.AppImage
```

**ChromeOS (Crostini)**

ChromeOS ships with a built-in Linux development environment (a Debian 12 container), so BIT's Linux packages work directly — no special build needed:

1. Settings → About ChromeOS → Developers → Linux development environment → Enable (supported on both Intel/AMD and ARM devices)
2. Install from the Linux terminal (amd64 for Intel/AMD, arm64 for ARM): `sudo apt install ./BIT_<version>_amd64.deb`

The dependencies (libwebkit2gtk-4.1, libgtk-3, libayatana-appindicator3) are pulled in automatically from the Debian 12 repositories. After installation BIT appears in the "Linux apps" folder; the window is displayed via Wayland, matching the native Linux experience.

### First Run

Open **AI Settings** → add a provider (protocol / Base URL / API Key / model; click "Fetch from API" to pull the model list) → click the play button to activate it → go back to **Chat** and start using it.

For terminal users: after installing, type `bit` in any terminal to jump straight into the TUI chat.

## Remote Access & API

Once enabled on the **Remote** page, BIT serves an HTTP API (default `127.0.0.1:8600`; switch to `0.0.0.0` for LAN access; disabled by default — the client key and access password are generated automatically when you turn it on).

**Authentication**

- **Client Key** (`bit_` prefix, generated automatically): `Authorization: Bearer <key>` or `?key=<key>` — used for `/v1/*` and `/mcp`
- **Access password**: `/api/*` admin endpoints additionally require an `X-Access-Password` header (OpenAI / MCP clients cannot carry custom headers, so those endpoints are exempt)

**Endpoints**

| Endpoint | Method | Description |
|---|---|---|
| `/v1/chat/completions` | POST | OpenAI-compatible chat (SSE streaming supported) |
| `/v1/models` | GET | Model list |
| `/mcp` | POST / DELETE | Standard MCP server (Streamable HTTP / JSON-RPC 2.0) |
| `/api/*` | — | Admin endpoints for sessions / settings / audit (access password required) |
| `/api/health` | GET | Health check (no auth) |

```bash
curl http://127.0.0.1:8600/v1/chat/completions \
  -H "Authorization: Bearer $BIT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"YOUR_MODEL","messages":[{"role":"user","content":"list the current directory"}]}'
```

Any OpenAI-compatible client (Cherry Studio, LobeChat, immersive translators, etc.) can use BIT as a local model service, with streaming and image passthrough. On mobile, pair the [bit-mobile](https://github.com/yxpil/bit-mobile) app by QR code (LAN → IPv6 direct → cloud relay).

See the wiki for details: [工具与-MCP / Tools & MCP](https://github.com/yxpil/BrainTentacle/wiki/工具与-MCP).

## Documentation

Full documentation lives in the [Wiki](https://github.com/yxpil/BrainTentacle/wiki):

- **Getting started**: [快速上手 / Quick Start](https://github.com/yxpil/BrainTentacle/wiki/快速上手) · [安装与更新 / Installation](https://github.com/yxpil/BrainTentacle/wiki/安装与更新) · [功能总览 / Feature Overview](https://github.com/yxpil/BrainTentacle/wiki/功能总览) · [FAQ](https://github.com/yxpil/BrainTentacle/wiki/FAQ)
- **Extensions**: [扩展与插件 / Extensions & Plugins](https://github.com/yxpil/BrainTentacle/wiki/扩展与插件) · [工具与-MCP / Tools & MCP](https://github.com/yxpil/BrainTentacle/wiki/工具与-MCP)
- **Security**: [安全与脱敏 / Security](https://github.com/yxpil/BrainTentacle/wiki/安全与脱敏)
- **Contributing**: [开发与构建 / Development & Build](https://github.com/yxpil/BrainTentacle/wiki/开发与构建) · [友情链接 / Friendly Links](https://github.com/yxpil/BrainTentacle/wiki/友情链接)

Website: [osbt.space](https://osbt.space)

## Security & Privacy

- **Local-first data**: sessions, memory, skills, and settings all live in the app's local data directory (Windows default `%APPDATA%\com.bit.hub`, core database `bit.db`) — no telemetry uploaded.
- **Sensitive-data masking**: HiddenCode keeps real API keys / phone numbers / emails / usernames invisible to the AI; placeholders or aliases are restored only during local tool execution.
- **Dual review**: beyond normal approvals, L2 PASS uses a second model to Allow / Deny tool calls — every verdict is recorded in the audit log.
- **Two-factor auth**: Client Key (compared in constant time to prevent timing side channels) + access password; remote access is off by default and the local server binds to loopback only.
- **Encrypted storage**: sensitive settings are encrypted with a device-derived key and protected against tampering.
- **Sandboxing and limits**: AI-built scripts run inside the restricted Rhai sandbox (depth / operation / wall-clock budgets); subprocess tools get timeout kills, output caps, and resource reaping.
- **Controllable extension sources**: plugins are local declarative files (nothing is downloaded or executed), and every MCP server and tool added via MCP or WorkWith has its own enable switch and can be disconnected at any time — **you decide what runs and what connects**.
- **MCP session governance**: sessions idle out after 30 minutes, are capped in count, and can be explicitly terminated via DELETE.
- **Signing transparency**: macOS ad-hoc signing / no Windows EV certificate (a trade-off of not paying for certificates — see the installation notes above); the source and CI build pipeline are fully public.

See the wiki: [安全与脱敏 / Security](https://github.com/yxpil/BrainTentacle/wiki/安全与脱敏) · [SECURITY.md](SECURITY.md)

## Friendly Links

**Official entries for this project**

| Resource | Description |
|---|---|
| [osbt.space](https://osbt.space) | Official website and online docs |
| [Releases](https://github.com/yxpil/BrainTentacle/releases) | Installers for all platforms and changelogs |
| [Wiki](https://github.com/yxpil/BrainTentacle/wiki) | Full documentation |
| [QQ group](https://qm.qq.com/q/qlFr8ct0ps) | Feedback and discussion |
| [Issues](https://github.com/yxpil/BrainTentacle/issues) | Bug reports and feature requests |

**Sibling projects (same author, designed to combine with BIT)**

| Project | Description |
|---|---|
| [TentacleTool](https://github.com/yxpil/TentacleTool) | The BIT MCP toolset: **13 zero-dependency MCP servers** (filesystem / Git / HTTP / crypto / database / code graph / time & scheduling / data formats / search / calculator…); scan a port range to connect them |
| [bit](https://github.com/yxpil/bit) | The Tauri 2 native shell on the same Rust core (best GUI choice for LoongArch / RISC-V) |
| [bit-mobile](https://github.com/yxpil/bit-mobile) | Android companion: pair by QR code for chat, tool approval and multi-path connectivity |
| [BITSDK](https://github.com/yxpil/BITSDK) | Call BIT's capabilities from your own programs |
| [PANOPTES](https://github.com/yxpil/PANOPTES) | Screen-operation MCP server (screenshots + mouse/keyboard control) |
| [Neton](https://github.com/yxpil/Neton) | Network tooling for agents (LAN discovery / port scan / protocol analysis / packet capture) |
| [Firelin](https://github.com/yxpil/Firelin) | Network penetration toolset for agents |
| [ADONWORD](https://github.com/yxpil/ADONWORD) | Active defence tooling for agents |
| [HOWCUEME](https://github.com/yxpil/HOWCUEME) | Conditional self-wakeup for agents |
| [MemoryPool](https://github.com/yxpil/MemoryPool) | Memory-pool program for agents |
| [SECFORGE](https://github.com/yxpil/SECFORGE) | Aggregates the security satellites above into 29 MCP tools behind one entry point |

**Ecosystem and standards**

- [Model Context Protocol](https://modelcontextprotocol.io) — the open protocol and spec BIT's MCP support implements
- [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) — collection of MCP servers; find extensions here
- [awesome-mcp-clients](https://github.com/punkpeye/awesome-mcp-clients) — collection of MCP clients
- [Tauri](https://tauri.app) · [Electron](https://www.electronjs.org) · [React](https://react.dev) — the desktop shells and frontend BIT builds on

> Want your project listed here? Open an [Issue](https://github.com/yxpil/BrainTentacle/issues) or a PR.

## Tech Stack

| Layer | Technologies |
|----|------|
| Frontend | React 18, Vite 6, Tailwind CSS 4, react-markdown + remark-gfm |
| Desktop shells | Electron (tray form, shipped on all platforms) + Tauri 2 (native form) |
| Core | Rust: reqwest (with stream), tokio, axum, rhai, futures-util |
| Bridge | N-API (Electron reuses the same Rust core) |

## Development

Prerequisites: [Node.js](https://nodejs.org/), the [Rust](https://www.rust-lang.org/) toolchain, and Tauri's system dependencies.

```bash
npm install          # Install frontend dependencies
npm run tauri dev    # Tauri dev mode (hot reload)
npm run tauri build  # Build Tauri release (NSIS / MSI / dmg / AppImage / deb)
```

For the Electron shell, see `electron-builder.yml` and `scripts/stage-pack.cjs`. Local setup, testing and release flow are documented in the wiki: [开发与构建 / Development & Build](https://github.com/yxpil/BrainTentacle/wiki/开发与构建).

## Project Structure

```
src/               React frontend
  pages/           Chat / Tools / Services (WorkWith) / Memory / Skills / Audit / Security / Remote / AI Settings / Theme
  components/      Markdown, tool cards, icons, etc.
crates/bit-core/   Rust core: ai, agent, mcp, registry, runtime, script_runtime,
                   http_api, update, audit, session, goal, memory, plugins, workwith …
crates/bit-napi/   N-API bridge used by Electron
src-tauri/         Tauri shell (native build)
electron/          Electron shell (tray, preload)
packaging/         Distribution channels: npm / flatpak / musl / exotic / Arch
installer/bit.iss  Inno Setup packaging script
```

## License

[Apache License 2.0](LICENSE) — **BIT is free forever**: all features with no in-app purchases, no subscriptions, and no locked features, free for personal and commercial use.
