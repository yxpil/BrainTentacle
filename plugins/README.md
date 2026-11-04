# 插件验证套件（plugins/）

一批「真能跑起来」的插件包，把插件系统的每一条扩展面与几种真实业务形态都踩一遍。
目录名就是插件 id（后端 `scan()` 按目录名认领），每个目录里必须有 `plugin.json`。

- 业务型插件（`biz-*` / `dash-*` / `srv-*` / `ui-*` / `svc-*`）：清单校验必须通过，能力必须真能用。
- 负面夹具（`_invalid/bad-*`）：**故意**写坏，用来证明 `validate()` 的每一道闸门会整体拒收，并把错误串如实列到「插件」页。
  只在装套件时带上（`--with-invalid`），不进正式环境。
- 整棵 `plugins/` 树只活在开发树里：`electron-builder.yml` 的 `files` 是白名单（`dist` / `electron` / 两座桥 / `package.json`），
  套件与 `e2e/`、`scripts/` 一起被挡在包外；装套件走 `scripts/install-plugin-suite.cjs --dest <隔离数据目录>`，
  它认出 `%APPDATA%\com.bit.hub` 会直接拒绝。产物内容由 `scripts/check-pack-contents.cjs` 复核，夹具漏进包即打包失败。

## 套件清单（21 个正例 + 27 个夹具）

| 目录 | 场景 | 覆盖的扩展面 |
| --- | --- | --- |
| `biz-price-watcher` | 电商价格盯盘 | Python + Rhai 工具、`jobs[]`（daily / every）、prompts/skills/memories、静态页、设置条目、`chat_icons`（prompt）、任务与工具靠工作目录文件接力 |
| `biz-inventory` | 仓库库存盘点 | Node + Python 工具、静态页 + `status_page`、设置条目（无页 → 宿主键值面板）、夜间盘点任务 |
| `biz-crm` | 客户跟进 | `Bit.chat` 走插件会话命名空间、`session.*`、独立设置页、Rhai 工具、`storage` 草稿 |
| `srv-dashboard` | 自带服务器的经营看板 | `server`（node、`auto_start`）、url 型动态页、`status_page`、进程侧 HTTP `/cap` + Bearer、`plugin_server_logs`、动态页自己引 `/sdk.js` |
| `dash-kanban` | 项目看板 | 两个静态页各带自定义字形 `paths`、两颗 `chat_icons`（page）、命名空间存储共享数据 |
| `ui-terminal` | 运维速记台 | JS 型插件：`ui.css` + `ui.js` 里 `registerPage` / `registerSettingsPage`（用宿主 React）、`cap`、`data`、`notify`、`onEvent` |
| `ui-theme` | 外观微调 | 最小面积 css 插件：只注入两个可测量的自定义属性 |
| `svc-sync` | 数据同步服务组 | `services[]` 两条：普通常驻进程 + `mcp_mode: http`（端口就绪后接入 MCP）、`env`/`cwd`、服务进程回连 `/cap` 读自己的设置 |
| `svc-mcp-stdio` | 设备桥 | `services[]` + `mcp_mode: stdio`：进程本身就是 MCP 服务器，JSON-RPC 走 stdin/stdout |
| `neton-lan` | NetON 网络侦察（外部项目改造） | 多文件第三方包（`neton/mcp·tools·utils`）作服务程序、`port: 0` 由宿主分配端口（进程读 `BIT_PLUGIN_PORT`）、`mcp_mode: http` 导入 6 个工具、工具自带 `[neton-scope]` 作用域护栏（夹具只打 127.0.0.1） |
| `biz-alerts` | 告警中心 | `events`（宿主事件转进帧）、`notify`、限流与静音表 |
| `biz-notes` | 便签本 | `data.*` 按目录分层读写自己的数据目录、Python 工具统计、整理任务写报告 |
| `biz-caps-exec` | 运维脚本台 | `exec.run`（program / command / 二选一约束）、`fs.*` 全动词、未申报能力当场被拒的正例 |
| `biz-sessions` | 工单收件箱 | `session.list/read/append/wake`、`plugin:<id>` 会话进左侧列表、跨插件命名空间隔离 |
| `biz-takeover-voice` | 语音转写台 | `takeover: ["chat.voice"]` + 顶替用的 `chat_icons`、`setTitle` / `openPage` |
| `biz-takeover-zip` | 附件坞 | 多槽位接管（语音 / 预览 / 附件）；与上一插件争抢 `chat.voice`，按 id 字典序判归属（`voice` < `zip`，它只拿到预览与附件） |
| `biz-heavy-tools` | 投研流水线 | `permissions: ["all"]` 通配位、6 个工具（node / python / `py` 别名 / Rhai）压工具清单、静态页里直接 `invoke_tool` |
| `svc-crash` | 假死巡检服务 | 服务秒退 → `plugin_health` 异常登记与页眉异常灯（反面用例） |
| `sdk-sugar` | 开发糖示范 | 清单简写（`preset` / 单数 `page` / 字符串 `permission` / 一行 `server` / `interpreters`）、ESM 服务 `import "bit"`、CJS 常驻服务 `require("bit")`、解释器工具回连、页面糖（`boot` / `on(name)` / `can` / `exec.node` / `data.writeJSON` / `runtime.list`） |
| `biz-filekind` | 文件类型工坊 | `file_kinds[]`：`.fz/.fzz` 换图标 + 由本插件 node 工具解析正文（拖入 / 侧栏预览 / 模型 `read_doc` 三条链同一口径），`.ztl` 只登记图标；`files.kinds` 能力回读自己的登记 |
| `biz-net` | 外部网关连接器 | `connections[]` 两条：一条 `auto_connect` + `Authorization: Bearer {setting:token}`（令牌只活在插件设置里），一条整段地址来自设置；`net.connections/connect/disconnect` 能力、连接台页面、缺设置值时的"先填哪几项" |
| `_invalid/bad-*` | 闸门夹具 | 未知权限 / 缺 `bridge` / 令牌取值非法 / 坏 schedule / 图标超量 / 图标动作非法 / UI 文件缺失 / 夹带脚本 / 服务程序缺失 / MCP 取值非法 / 未知槽位 / 想接管设置 / 页面路径越界 / 页面没申报权限 / 服务器没申报权限 / 工具缺运行时 / 清单坏 JSON / 缺清单 / 未知 preset / interpreters 漏报 exec / file_kinds 漏报 files / 抢内置 `.pdf` / connections 漏报 net / 非 http(s) 地址 / 连接重名 / 头名带空格 / `{setting:` 没闭合 |

## 开发糖（写插件时先读这一节）

### 一条命令起个能跑的包

```
npm run plugin:new -- --name 我的插件 --kind page      # page | service | tool | filekind | full
```

生成 `<name>/plugin.json` + 对应源码 + 一份 README，清单用的就是下面这些简写形式。
把目录拷进 `<数据目录>/toolhomes/plugins/`，在「设置 → 插件」点重新扫描即可，不用重启应用。
`--kind filekind` 那套还多给 `tools/parse_x.js`（宿主调它解析正文）和 `samples/demo.x`
（拖进对话就能验：chip 上用清单里的 `paths` 图标，侧栏预览走本插件的工具）。

### 清单可以写得很短

| 写法 | 等价于 |
| --- | --- |
| `"page": {…}` | `"pages": [{…}]`（`tool` / `service` / `job` / `skill` / `chat_icon` / `interpreter` / `takeover` 同理） |
| `"permission": "exec, data"` | `"permissions": ["exec", "data"]`（逗号、空格、分号都行，大小写与空格会被清洗去重） |
| `"server": "node server.js"` | `"server": { "runtime": "node", "program": "server.js" }` |
| `"preset": "page"` | 一组常用权限（`page` `ui` `server` `service` `connect` `ai` `tool` `device` `full`），与手写的 `permissions` 取并集 |
| `"interpreters": "node"` | `exec.run` 只允许跑 node；要跑 shell 命令得再写 `"shell"` |

`preset` **不代填 `bridge`**：令牌契约必须自己写出来，否则"用了预设就默认开了无凭据接口"这种事故没人能在评审里看出来。
`interpreters` 需要同时申报 `exec`，否则清单直接被拒（`bad-interpreters` 夹具钉住这条）。

### 进程里一行回连宿主

宿主把 SDK 物化在 `toolhomes/node_modules/bit`（node）与 `toolhomes/py/bit.py`（python）。
插件包在 `toolhomes/plugins/<id>/`，Node 沿目录往上找 node_modules 就能命中，**不需要配任何路径**：

```js
const bit = require("bit");          // CommonJS
import bit, { cap } from "bit";      // ESM（同一份实现）
```

```python
import bit                           # 服务进程由宿主追加 PYTHONPATH
```

```js
await bit.info();                    // 身份与生效权限
await bit.settings.set("k", 1);
await bit.data.writeJSON("a.json", { ok: true });
await bit.fs.write("C:/tmp/x.txt", "hi", { create_dirs: true });
await bit.exec.node(["-e", "console.log(1)"]);
await bit.runtime.list();            // 本机有哪些解释器（不要权限）
bit.can("exec");                     // 同步判断，读宿主下发的环境
bit.log("…");                        // 带插件前缀，进宿主的服务日志面板
```

解释器工具（`tools[]` / `jobs[]`）也带同一份凭据，但**只能用 `require`**：工具源码被写进
临时文件执行，ESM 的目录链在那儿不成立（`NODE_PATH` 指向 `toolhomes/node_modules`，CJS 认它）。
工具协议不变：stdin 收 JSON 参数、stdout 出 JSON 结果、日志走 stderr。

### 页面侧同一套词汇

静态页由宿主注入 `window.Bit`（含令牌），动态页自己 `<script src="${BIT_PLUGIN_API}/sdk.js">`。
方法与进程侧同名，另外三个开局糖：

```js
Bit.boot(async (info) => { … });     // 握手落地后再开工，不用自己写 ready().then
Bit.on("notify-done", (data) => …);  // 按事件名订阅（on(cb) 的老写法仍然全事件）
Bit.once("workwith", cb);            // 收一次就退订
```

### 让插件认领一类文件（`file_kinds[]`，需 `files` 权限）

宿主解析不了的后缀（`.fz`、公司内部格式、各种设备导出），插件可以登记成"自己这一类"：
换一颗图标，并用自己的工具把正文读出来。

```json
"permissions": ["files"],
"tool": { "name": "parse_fz", "runtime": "node", "file": "tools/parse_fz.js" },
"file_kinds": [
  { "id": "fz", "label": "FZ 脚本", "label_en": "FZ script", "ext": "fz, fzz",
    "paths": ["M6 4h9l3 3v13H6z", "M9 10h6"], "tool": "parse_fz" },
  { "id": "ztl", "label": "Z 模板", "exts": [".ztl"], "paths": ["M4 7h16v10H4z"] }
]
```

- `ext` / `exts`：字符串（逗号分隔）或数组都认，统一洗成小写带点；一条登记可以给多个后缀。
- `paths`：与 `pages` / `chat_icons` 同一套字形白名单（1–8 条 24 格 `path d`，标记字符一律不收）。
  不写就退回内置文档图标，**只换图标不认领解析**（上面 `.ztl` 那条）。
- `tool`：必须是本插件 `tools[]` 里声明过的工具名；留空 = 只登记图标。
- 工具收到的入参（stdin JSON）：`{ filename, path?, base64?, size, kind, label }`。
  拖进来的文件有 `path` 自己读；粘贴/URL 来的没路径才给 `base64`。
  返回两份口径任选：`{ "text": "正文" }`，或大正文写文件后回 `{ "file": "相对工作目录的路径" }`。
  正文由宿主统一封顶（12 万字），别自己截。

三条硬规矩，都是闸门而不是建议：

1. **核心优先**：`.pdf/.docx/.xlsx` 与文本类后缀不许抢（`bad-filekind-core` 钉住）。
   插件随时能被停用，停用后这些文件若已经改由插件解析，用户会突然发现文件打不开。
2. **不抢别人的后缀**：同一插件内扩展名重复直接拒收；跨插件重复按插件 id 字典序取一家，
   注册表里只留赢家（与 `takeover` 槽位同一套裁决）。
3. **权限可单独收回**：在「设置 → 插件」把 `files` 关掉，登记立刻从注册表消失，
   图标退回内置、正文回到「不支持解析」那条报错，不会留半个尾巴。

解析走的是既有工具执行链，但**不经过模型审批**（触发它的是用户拖文件这个动作），
所以每次解析都记一条 `files.parse` 审计；工具只能是该插件自己声明的脚本/解释器条目。

页面与进程侧都能回读自己当前真正生效的登记：

```js
const kinds = await Bit.files.kinds();      // 页面
const kinds = await require("bit").files.kinds();   // 进程
```

### 让插件接上外部 MCP 服务（`connections[]`，需 `net` 权限）

`services[]` 是"BIT 拉起本机进程"；`connections[]` 反过来——服务已经在别处跑着
（公司网关、SaaS、另一台机器上的自建 MCP），插件只负责把它接进来，握手成功就
`tools/list` 导入工具，AI 直接能用。

```json
"permissions": ["net", "settings"],
"connections": [
  { "name": "gateway", "label": "公司 MCP 网关",
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer {setting:token}" },
    "auto_connect": true },
  { "name": "relay", "url": "{setting:endpoint}" }
]
```

- `url` 必须是 `http(s)`，不许把账号密码写进地址（`https://user:pass@host` 直接拒收，
  凭据走 `headers`）。整段地址也可以来自设置：`"{setting:endpoint}"` 在连接当时展开。
- `{setting:KEY}` 取的是**本插件自己的设置**（键名不带插件前缀），所以插件包里
  永远没有令牌：用户卸载插件，令牌跟着设置一起没。
- `headers` 的头名必须是合法 HTTP token（不含空格/冒号/换行），单条连接最多 8 个头。
- 数量上限 8 条；`name` 在同插件内唯一，宿主侧条目 id 是 `pmcp-<插件id>-<name>`。
- `auto_connect: true` 时，启用插件 / 应用启动会逐个连；**缺设置值就跳过**，
  只在日志里点名要填哪几项，不会弹窗也不会把启动卡住。

闸门与生命周期（都在 `bad-net-*` 夹具里钉住）：

1. 没申报 `net` 却写 `connections[]` → 清单整体拒收。
2. 连接建立后，MCP 列表里那行的生命周期归插件：工具页不给它暂停/移除开关
   （暂停由插件详情里的"断开"负责），报错文案也会把人指回插件详情页。
3. 停用插件、单独关掉 `net` 位、或清单里删掉这条 → MCP 条目连同它导入的工具一起收回，
   不留"看起来还连着但调不动"的死工具。
4. 每次真实连接都记一条 `plugin.net-connect` 审计，里面只有地址（脱敏）与头名，**没有头的值**。

页面与进程侧都能看自己声明的连接与实时状态：

```js
const list = await Bit.net.connections();          // 页面：[{ name, label, url_template, connected, tools, missing_settings, granted }]
await Bit.net.connect("gateway");                  // 连上（失败返回原因，含"先填哪几项设置"）
await Bit.net.disconnect("gateway");               // 断开：条目置灰、工具摘掉，声明留着
```

## 用法

只往隔离验证实例里装，**不要装进 `%APPDATA%\com.bit.hub`**（安装器认出真实数据目录会直接拒绝）：

```
node scripts/install-plugin-suite.cjs --dest "<BIT_DATA_DIR>/toolhomes/plugins" [--with-invalid] [--clean] [--list]
```

起实例（每次换新的 CDP 端口，端口只往上走）：

```
BIT_DATA_DIR=<Temp 下新目录> BIT_NO_GUARDIAN=1 BIT_ELECTRON_DIST=1 \
  npx electron electron/main.cjs --remote-debugging-port=93xx
```

真机验收（1440×920 截图与 `report.json` 落 `--shots` 目录）：

```
node e2e/plugin-suite-probe.cjs http://127.0.0.1:93xx --data <BIT_DATA_DIR>
```

探针开头会 `set_tool_approval allow_all`，否则驱动里的工具调用会卡在审批卡上——那是夹具没设模式，不是功能坏了。

## 已知坑（套件在真机上踩出来的）

- **清单静态页开机就全量挂载**：宿主把所有页面（含每个插件的 `pages`）常驻挂在 `<main>` 里，不用时才 `display:none`；`PluginFramePage` 的 iframe 因此从启动那一刻就在加载。实测：一个只在页面脚本里 `notify` 的插件，应用一开机就刷出通知（`sdk-sugar` 踩到）。宿主不会告诉帧里"你现在可见吗"，所以顶层别放重活、轮询、通知——初始化放到 `await Bit.ready()` 之后，再按用户动作或事件触发。
- **具名订阅要等帧挂上才有效**：宿主在 iframe 挂载那一刻就替申报 `events` 的插件订好白名单事件（`src/pluginHost.js` 的 `attachFrame`），所以 `Bit.on("notify-done", …)` 在页面开局 `Bit.boot` 里发的通知也收得到。以前是 SDK 握手完再发 `watch`，八个 `listen` 逐个 await，页面自己 `notify` 得早就会丢事件（`sdk-sugar` 实测过一轮：通知已发出、订阅还没建好，具名订阅永远「未触发」）。
- **通知自喂死循环**：`notify` 成功会让宿主发一条 `notify-done`，而 `notify-done` 在转发给申报 `events` 的插件的白名单里。插件若「来事件就弹通知」，就成了自己弹给自己看，实测一秒刷出几百条。`biz-alerts` 现在把 `notify-done` 与 `chat.delta` 排除在弹通知之外，并加了 5 秒 3 颗的限流。
- **MCP 工具不能给空 `properties`**：宿主的工具表拒绝 `parameters.properties` 为空的对象型 schema（模型会瞎猜参数名），所以 `tools/list` 里这类工具会静默导入 0 个。两个 MCP 服务因此都带一个显式可选参数。
- **改完清单必须换干净数据目录**：插件首次扫描会把内容哈希记成基线，之后改任何文件（哪怕只改一个槽位）都会被判 `verify:"tampered"` 并整体不注入。装套件用新 `BIT_DATA_DIR`，别在跑着的实例上覆盖重装。
- **`services[]` 的条目 id 会被 sanitize**：连字符换成下划线，`svc-sync` 的服务实际是 `psvc-svc_sync-indexer`。按目录名硬编码断言会假失败。
- **`all` 通配位过去过不了清单闸门**：`ui.css` / `ui.js` / `server` / `pages` 四道闸门原本只认字面权限名，只写 `all` 的插件会被整体拒载（`biz-heavy-tools` 就栽在这儿）。现已统一走 `has_perm`，并有 `all_perm_satisfies_every_manifest_gate` 单测钉住。
- **Rhai 沙盒（`kind:"script"`）的几处反直觉**（都在 `crates/bit-core/src/script.rs` 的 `Engine::new()` 上实测，Rhai 1.26）：
  - 数组字面量是 `[]`，`#` 只属于 map 的 `#{}`；写 `#[]` 报 `'#' is a reserved symbol`。
  - 没有三元：`a ? b : c` 解析不过（`Unknown operator: '?'`），条件取值一律 `if … { } else { }` 表达式。
  - `trim()` / `replace()` 是**就地改并返回 `()`**，不能 `let s = c.trim()`（拿到的是 unit，后续 `.len()` 就炸）。正确写法是先取可写副本再调用：`let s = c + ""; s.trim();`。
  - 数组没有 `join` / `text`，字符串没有 `pad_start` / `trim_start`，也没有切片 `s[1:4]`；`let mut` 不是 Rhai 语法（`let` 本就可变）。拼接与补零用 `while` + `+` 手写。
- **页面开局读身份要 `await Bit.ready()`**：握手回执得等一次帧往返，`Bit.info()` 在 boot 里同步调用必然拿到 null。SDK 现在把回执做成 `await Bit.ready()`（连不上宿主时 5 秒超时 `resolve(null)`，不会把页面吊死），套件里 12 个页面都改用这条。
- **`--clean` 是单独一挡**：它照着 `.plugin-suite.json` 回收后直接返回，不会顺手重装；重装就把它去掉再跑一次。
