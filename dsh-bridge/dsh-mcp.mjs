#!/usr/bin/env node
// DeepSeek Harness（dsh）插件桥 —— stdio MCP server
//
// 职责：在独立进程里以最小 Cordis 宿主装载 toolhomes/dsh/plugins/ 下的 dsh 插件，
// 把插件注册到 ctx.tools 的工具映射为 MCP tools/list + tools/call，供 BIT 主进程
// 经 mcp_add_stdio 接入后按统一权限/执行链调用。
//
// 环境变量契约（由 crates/bit-core/src/dsh.rs setup_bridge 写入）：
//   DshPluginsDir   插件目录（<toolhomes>/dsh/plugins），每个子目录一个 npm 包
//   DshDisabledFile 启停清单（<toolhomes>/dsh/disabled.json，形如 {"plugins":["a","b"]}）
//
// 与 Rust 侧的匹配契约（status 判定桥是否已注册）：本文件名必须是 dsh-mcp.mjs，
// 且注册时 command = 当前应用可执行文件、args[0] = 本脚本绝对路径、
// env ELECTRON_RUN_AS_NODE=1（用 Electron 二进制当 Node 跑，不依赖用户装 Node）。
//
// 协议约束：stdout 是 MCP 协议流，一切日志（含第三方插件的 console.log）必须走 stderr。
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { parse as parseYaml } from 'yaml'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local' // dsh-fs 只是抽象基类，本地后端在 fs-local（补 resolve/stat/read）
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'

// stdout 专属 MCP 协议：第三方插件里若有 console.log 会破坏协议流，统一改道 stderr
console.log = (...args) => console.error('[plugin]', ...args)
const log = (...args) => console.error('[dsh-bridge]', ...args)

// 网关韧性：插件的异步错误只记录，不拉垮整个桥进程
process.on('uncaughtException', (e) => log('uncaughtException:', e?.stack || e))
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.stack || e))

// cordis fiber.state 枚举（0 起）；PENDING = inject 的服务缺失（静默不生效，需显式检查）
const FIBER_STATE = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'UNLOADING', 'DISPOSED']
const stateOf = (fiber) => FIBER_STATE[fiber?.state] ?? String(fiber?.state)

const SERVER_INFO = { name: 'dsh-bridge', version: '0.1.0' }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const pluginsDir = process.env.DshPluginsDir
const disabledFile = process.env.DshDisabledFile

let ctx = null
let booting = null // 后台装载 promise（list 请求短暂等待它，最多 12s）
let callSeq = 0

// ── 宿主服务层 ────────────────────────────────────────────────
// 顺序同官方宿主：上层服务 inject 下层。工具插件常见的 inject 是 tools/fs/llm 等。
async function mountHost() {
  ctx = new Context()
  const layers = [
    ['SystemPrompt', SystemPrompt],
    ['ToolRuntime', ToolRuntime],
    ['SessionProjection', SessionProjectionRegistry],
    ['LocalFileSystem', LocalFileSystem],
    ['WorkingDirectory', WorkingDirectoryService],
    ['LlmRuntime', LlmRuntime],
    ['SkillRegistry', SkillRegistry],
  ]
  for (const [label, plugin] of layers) {
    try {
      const fiber = await ctx.plugin(plugin)
      if (stateOf(fiber) !== 'ACTIVE') log(`服务 ${label} 状态=${stateOf(fiber)}（非 ACTIVE，依赖它的插件将不生效）`)
    } catch (e) {
      log(`服务 ${label} 装载失败:`, e?.message || e)
    }
  }
  if (!ctx.tools) throw new Error('ToolRuntime 未就绪（ctx.tools 缺失），宿主不可用')
}

// ── 插件 peer 解析链接 ────────────────────────────────────────
// 插件包放在 toolhomes/dsh/plugins/<pkg>/，其 peerDependencies（@deepseek-ai/cordis、
// dsh-* 服务包等）没有自己的 node_modules 时按目录向上查找。把桥自身的 node_modules
// 链到 toolhomes/dsh/node_modules，插件 import bare specifier 即可解析到宿主同一套依赖
// （等价于 dsh CLI 用 pnpm 装进 profile 的效果）。Windows 上用 junction 免特权。
function linkPeerModules() {
  if (!pluginsDir) return
  const target = path.join(path.dirname(path.resolve(pluginsDir)), 'node_modules')
  try {
    if (fs.lstatSync(target)) return // 已存在（含指向别处的旧链）不覆盖，避免误伤
  } catch { /* 不存在则建 */ }
  const source = path.join(HERE, 'node_modules')
  try {
    fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    log('已建立 peer 解析链接:', target, '->', source)
  } catch (e) {
    log('peer 解析链接建立失败（插件可能缺依赖）:', e?.message || e)
  }
}

// ── 启停清单 ─────────────────────────────────────────────────
// 状态权威是 disabled.json（与前端开关、dsh_status 返回一致）；
// 插件自带 cordis.patch.yml 里的 disabled 字段是 dsh 宿主的建议值，这里忽略，
// 否则会出现「UI 显示已启用但桥没装」的矛盾。
function readDisabled() {
  if (!disabledFile) return new Set()
  try {
    const doc = JSON.parse(fs.readFileSync(disabledFile, 'utf8'))
    return new Set(Array.isArray(doc?.plugins) ? doc.plugins : [])
  } catch { return new Set() }
}

// ── 插件配置（cordis.patch.yml）──────────────────────────────
// 很多插件的 Config 有必填项（如 dsh-tool-todo 的 allowParallelInProgress），
// 不传会 ValidationError。插件包可用 package.json 的 dsh.bundle.patch（或顶层
// "dsh.bundle.patch" 键）声明 patch 文件，其 insert[].config 即装载配置建议值。
function readPatchConfig(dir, pkg) {
  const rel = pkg['dsh.bundle.patch'] ?? pkg?.dsh?.bundle?.patch
  if (!rel || typeof rel !== 'string') return {}
  try {
    const doc = parseYaml(fs.readFileSync(path.join(dir, rel), 'utf8'))
    const entries = []
    for (const item of Array.isArray(doc) ? doc : [doc]) {
      if (item && Array.isArray(item.insert)) entries.push(...item.insert)
      else if (item) entries.push(item)
    }
    const hit = entries.find((e) => e?.name === pkg.name || e?.id === pkg.name)
      ?? (entries.length === 1 ? entries[0] : null)
    return hit?.config && typeof hit.config === 'object' ? hit.config : {}
  } catch (e) {
    log(`patch 解析失败（按空配置装载）: ${pkg.name}:`, e?.message || e)
    return {}
  }
}

// 包入口：exports['.'] 优先，退回 main/index.js
function entryOf(pkg) {
  const ex = pkg?.exports?.['.']
  if (typeof ex === 'string') return ex
  if (ex && typeof ex === 'object' && typeof (ex.default ?? ex.import) === 'string') return ex.default ?? ex.import
  return pkg?.main ?? 'index.js'
}

// ── 插件依赖就地安装 ─────────────────────────────────────────
// 裸放进来的插件目录往往没有 node_modules（用 dsh plugin add / npm 装的才有）。
// 策略按需触发：先直接 import，报 ERR_MODULE_NOT_FOUND 且本机有 npm 时就地
// `npm install --omit=dev` 补齐后重试一次——已有完整依赖（pnpm/npm 装好的）
// 零打扰，缺什么补什么。首装可能耗时，启动序已改为"先握手、装载后台跑"，
// 不受 MCP initialize 15s 限制（list 内部最多等 25s）。
let npmChecked = null
function npmAvailable() {
  if (npmChecked !== null) return npmChecked
  try {
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
      timeout: 10000, stdio: 'ignore', shell: process.platform === 'win32',
    })
    npmChecked = r.status === 0
  } catch { npmChecked = false }
  if (!npmChecked) log('未检测到可用 npm，插件缺依赖时将无法自动补齐')
  return npmChecked
}

async function npmInstall(dir, id) {
  log(`正在为插件就地安装依赖: ${id} …`)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  })
  const stderrChunks = []
  child.stderr.on('data', (d) => stderrChunks.push(d))
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(-2) }, 300000)
    child.on('exit', (c) => { clearTimeout(timer); resolve(c) })
    child.on('error', (e) => { clearTimeout(timer); log('npm 启动失败:', e?.message || e); resolve(-1) })
  })
  if (code !== 0) {
    log(`插件依赖安装失败（${id}，exit=${code}）:`)
    log(stderrChunks.join('').split('\n').filter(Boolean).slice(-5).join('\n') || '（无 npm 错误输出）')
    return false
  }
  log(`插件依赖安装完成: ${id}`)
  return true
}

// import 插件入口，缺模块时按需补装并重试一次
async function importPlugin(dir, pkg, id) {
  const url = pathToFileURL(path.join(dir, entryOf(pkg))).href
  try { return await import(url) } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !npmAvailable()) throw e
    log(`插件缺依赖（${e.message.split('\n')[0]}）`)
    if (!(await npmInstall(dir, id))) throw e
    return await import(url)
  }
}

// ── 插件装载 ─────────────────────────────────────────────────
// 两种插件形状（实验结论）：功能插件命名导出 {name, inject, apply}（无 default，
// ESM 下 import * as 即可）；服务插件 default 导出 Service 子类。
// 单个插件失败只记日志不中断；inject 服务缺失时 fiber 停在 PENDING（apply 不跑也不报错），
// 必须显式查 state 才能发现。
async function loadPlugins() {
  if (!pluginsDir) { log('DshPluginsDir 未设置，跳过插件装载'); return 0 }
  let names = []
  try { names = fs.readdirSync(pluginsDir) } catch { log('插件目录不存在，跳过:', pluginsDir); return 0 }
  const disabled = readDisabled()
  let ok = 0
  for (const name of names.sort()) {
    const dir = path.join(pluginsDir, name)
    let pkg
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { continue }
    const id = pkg.name || name
    if (disabled.has(id)) { log('已停用，跳过:', id); continue }
    try {
      const mod = await importPlugin(dir, pkg, id)
      let plugin = typeof mod?.apply === 'function' ? mod : mod?.default
      if (typeof plugin !== 'function' && typeof plugin?.apply !== 'function') {
        log('无法识别的插件形状（缺 apply），跳过:', id); continue
      }
      const fiber = await ctx.plugin(plugin, readPatchConfig(dir, pkg))
      const st = stateOf(fiber)
      if (st === 'ACTIVE') { ok += 1; log('已装载:', id) }
      else log(`装载状态异常: ${id} -> ${st}${st === 'PENDING' ? '（inject 的服务缺失，插件未生效）' : ''}`)
    } catch (e) {
      log('装载失败:', id, '-', String(e?.message || e).split('\n')[0])
    }
  }
  return ok
}

// ── MCP server ───────────────────────────────────────────────
// tools/list  ← ctx.tools.schemas()：本身就是 wire 级 JSON Schema，直接作 inputSchema
// tools/call  ← ctx.tools.execute({callId, name, arguments, signal}) → {isError, content[]}
//               （0.2.1-rc.5 是单 call 语义，缺 signal 会抛 TypeError，必须传）
// 插件动态增删工具 → ctx.on('tools/change') → notifications/tools/list_changed
const server = new Server(SERVER_INFO, { capabilities: { tools: { listChanged: true } } })

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (booting) await Promise.race([booting, sleep(25000)]) // 装载中稍候；BIT 端请求 30s 超时，留 5s 余量
  let schemas = []
  try { schemas = ctx?.tools?.schemas?.() ?? [] } catch (e) { log('schemas() 失败:', e?.message || e) }
  return {
    tools: schemas.map((s) => ({
      name: s.name,
      description: s.description ?? '',
      inputSchema: s.parameters && s.parameters.type === 'object'
        ? s.parameters
        : { type: 'object', properties: s.parameters?.properties ?? {}, required: s.parameters?.required ?? [] },
    })),
  }
})

// dsh 工具结果的 content 项到 MCP content 的宽松映射（text/image 保留，其余转 JSON 文本）
function mapContent(content) {
  if (!Array.isArray(content) || content.length === 0) return [{ type: 'text', text: '' }]
  return content.map((item) => {
    if (item?.type === 'text') return { type: 'text', text: String(item.text ?? '') }
    if (item?.type === 'image' && item.data) return { type: 'image', data: item.data, mimeType: item.mimeType || 'image/png' }
    return { type: 'text', text: JSON.stringify(item) }
  })
}

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params
  try {
    const result = await ctx.tools.execute({
      callId: `mcp-${Date.now()}-${(callSeq += 1)}`,
      name,
      arguments: args ?? {},
      signal: extra?.signal ?? new AbortController().signal,
    })
    const out = { content: mapContent(result?.content) }
    if (result?.isError) out.isError = true
    return out
  } catch (e) {
    return { content: [{ type: 'text', text: `工具执行失败: ${String(e?.message || e)}` }], isError: true }
  }
})

// ── 启动 ─────────────────────────────────────────────────────
// BIT 端 initialize 超时仅 15s，而插件首装依赖可能更久，所以：
// 服务层就绪后立即 connect 应答握手；插件装载作为后台 promise 跑，
// tools/list 最多等它 25s（BIT 端所有 MCP 请求 30s 超时，留余量），
// 装载完成后补发 list_changed 通知。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  linkPeerModules()
  try { await mountHost() } catch (e) { log('宿主启动失败（以空工具表运行）:', e?.message || e) }

  const boot = (async () => {
    const loaded = await loadPlugins() // 单插件失败内部已捕获，这里兜装载阶段整体错误
    try {
      if (ctx) {
        ctx.on('tools/change', () => {
          try { server.sendToolListChanged?.()?.catch?.(() => {}) } catch { /* 通知失败不影响调用 */ }
        })
      }
    } catch { /* 事件接口缺失则不发列表变更通知 */ }
    const count = (() => { try { return ctx?.tools?.schemas?.().length ?? 0 } catch { return 0 } })()
    log(`装载完成：${loaded} 个插件生效，工具 ${count} 个`)
  })().catch((e) => log('插件装载阶段出错:', e?.message || e))

  booting = boot
  await server.connect(new StdioServerTransport())
  log('MCP stdio 已就绪')
}

main().catch((e) => { log('致命错误:', e?.stack || e); process.exit(1) })
