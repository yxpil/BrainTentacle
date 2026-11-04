// yxpil · BIT
// 本地插件系统：toolhomes/plugins/<插件目录>/plugin.json 声明式插件。
//
// plugin.json 语法（以下字段除 name 外可选；声明桥接面的插件必须写 bridge）：
// {
//   "name": "我的插件",
//   "version": "0.1.0",
//   "description": "一句话说明",
//   "tools": [{
//     "name": "mouse_move", "description": "…",
//     "parameters": { "type": "object", "properties": { … } },
//     "kind": "interpreter",              // interpreter（本机解释器）| script（Rhai 沙盒）
//     "runtime": "py",                    // interpreter 必填：py/js/ps1/…
//     "code": "…源码…",                   // 内联源码（stdin 收 JSON params，stdout 出结果）
//     "file": "tool.py"                   // 或相对插件目录的源码文件（与 code 二选一，file 优先）
//   }],
//   "prompts": ["启用时追加到系统提示词的指令片段"],
//   "skills": [{ "name": "技能名", "summary": "技能说明" }],
//   "memories": ["作为记忆注入的内容"],
//   "jobs": [{
//     "name": "日报", "schedule": "every 1h | daily 09:00",
//     "runtime": "py", "code": "…", "file": "…",
//     "session": "可选：结果注入的会话 id（复用后台 shell 唤回链路）"
//   }],
//   "permissions": ["css", "js", "invoke", "server", "page", "chat",
//                   "settings", "session", "workwith", "pagectl", "events", "notify", "data", "storage",
//                   "chaticon", "takeover", "exec", "write", "all"],
//   // exec = 控制台执行程序；write = 读写/修改任意文件与程序；all = 一次声明全部权限
//   // （仍必须在清单里写明，且设置中心可逐项关闭）
//   "bridge": {                       // 对外桥接的安全声明：声明了 server / pages / 设置页就必须写
//     "token": "required"             // 唯一合法值：每条桥接调用都必须带本插件令牌
//   },
//   "server": {                       // 插件自带的本机服务器（BIT 托管进程与端口）
//     "runtime": "node",              // 运行环境 id；custom/空 = program 即可执行文件
//     "program": "server.js",         // 相对插件目录
//     "args": ["--verbose"],
//     "port": 0,                      // 期望端口；0/缺省 = BIT 分配空闲端口
//     "auto_start": true,             // 启用插件 / 应用启动即拉起
//     "entry": "/"                    // url 型页面的默认基准路径
//   },
//   "services": [{                    // 声明多个常驻服务，登记进 WorkWith（需 "workwith" 权限）
//     "name": "sync",                 // 同插件内唯一的服务名（条目 id = psvc-<插件id>-<name>）
//     "label": "同步服务",             // 可选展示名（缺省 name）
//     "runtime": "node",              // 运行环境 id；custom = program 直接执行
//     "program": "svc/sync.js",       // 相对插件目录；也接受绝对路径
//     "args": ["--verbose"],
//     "cwd": "svc",                   // 可选工作目录：相对插件目录或绝对路径（缺省插件目录）
//     "env": { "MODE": "local" },     // 额外环境变量（宿主会补插件 id/令牌/端口）
//     "port": 0,                      // 期望端口；0 = 分配空闲端口（经 BIT_PLUGIN_PORT 下发）
//     "mcp_mode": "http",             // 可选：http = 端口就绪后接入 MCP；stdio = 进程即 MCP 服务器
//     "auto_start": true              // 启用插件 / 应用启动即拉起
//   }],
//   "pages": [{                       // 在左栏注册一个独立页面（沙箱 iframe）
//     "id": "main", "label": "看板",
//     "src": "web/index.html",        // 静态页：由 BIT 插件服务托管该文件
//     "url": "/",                     // 或动态页：打开插件服务器上的路径（需 server）
//     "paths": ["M4 5h16v14H4z"]      // 左栏/「⋯」里的字形（24 格 viewBox 描边路径，1–8 条；缺省回退内置图标）
//   }],
//   "status_page": {                  // 插件页右侧详情里的状态面板（需 "page" 权限）
//     "id": "status", "label": "运行状态",
//     "src": "web/status.html"        // 静态页；也可用 url 指向插件服务器（需 server）
//   },
//   "settings": {                     // 设置中心注入（需 "settings" 权限）
//     "entries": [{ "id": "sync", "label": "同步设置", "description": "…", "kw": "同步 sync" }],
//     "page": { "id": "cfg", "label": "插件设置", "src": "web/settings.html" }  // 独立设置页
//   },
//   "chat_icons": [{                  // 对话页图标排注入（需 "chaticon" 权限，每插件最多 4 个）
//     "id": "kanban", "label": "看板", "label_en": "Kanban",
//     "paths": ["M4 6h16", "M4 12h10"],  // 24 格 viewBox 的描边路径；宿主按墨迹归一，与内置图标一般大
//     "action": "page",               // page=跳到本插件页面 | prompt=把 text 填进对话输入框
//     "page_key": "main",             // action=page：pages / settings.entries 的 id（留空=本插件唯一页面）
//     "text": "帮我看看今天的看板"      // action=prompt：要填进输入框的话
//   }],
//   "takeover": ["chat.voice"]        // 接管宿主内置入口（需 "takeover" 权限，数量不限）
//                                     // 可用槽位见 TAKEOVER_SLOTS：语音/预览/附件/计划/模板/联网/后台任务。
//                                     // 接管后内置按钮从界面消失，插件用自己的 chat_icons / pages 顶上；
//                                     // 设置中心永远不可接管，用户可在「设置 → 安全 → 插件接管」恢复内置。
// }
//
// ── 清单语法糖（同一字段多种写法，解析后完全等价）──
// 1) 列表字段接受单个对象："page": {...} 等价于 "pages": [{...}]；
//    tool / service / job / skill / chat_icon / interpreter / takeover 同理，单数别名一律认。
// 2) permissions 与 interpreters 可以写成一个字符串："exec, data"（逗号/空格/分号分隔）。
// 3) server 可以写成一行："node server.js"（空格前是运行环境 id）或 "server.js"。
// 4) "preset": "page|ui|server|service|ai|tool|device|full" 一次声明一组常用权限，
//    与手写的 permissions 取并集；bridge 不在 preset 里代填，令牌契约必须自己写出来。
// 5) "interpreters": ["node"] 把 exec.run 收窄到声明过的解释器（要跑 shell 命令得额外写
//    "shell"）；不写就维持 exec 权限本身的宽口径，既有插件行为不变。
// 6) "file_kind": {...} 单条也认；扩展名写 "ext"/"exts"、字符串或数组都认，统一洗成小写带点。
//    登记的文件类型只补核心解析不了的（抢 .pdf 会被拒），解析器指向本插件自己的工具。
//
// 进程侧 SDK（宿主物化在 toolhomes/node_modules/bit 与 toolhomes/py/bit.py）：
//   node 服务/自带服务器：const bit = require("bit") 或 import bit from "bit"
//   python 服务：import bit
//   解释器工具：只能用 require —— 工具源码被写进临时文件执行，ESM 的目录链在那儿不成立
//                （NODE_PATH 指向 toolhomes/node_modules，CJS 认它）
// 页面侧 SDK 是注入的 window.Bit，方法名与进程侧一致：
//   cap / can / info / caps / settings / data / fs / sessions / services / server /
//   exec / runtime / files / notify / chat / storage，外加 boot / on / once / sleep 的开局糖。
//
// 页面两种形态都跑在独立 iframe 里（主窗口 nodeIntegration:false，帧内无 node）：
// 静态页经插件 API 服务的 /p/<插件id>/<文件> 提供（相对资源可用，自动注入 SDK 脚本），
// 动态页直接指向插件自己服务器的 http://127.0.0.1:<port>/<url>。
// 两条通道共用同一枚令牌：宿主给每个启用插件现发一枚（BIT_PLUGIN_TOKEN，同时进帧地址的
// #bit_token= 与注入脚本），postMessage 每条消息与本机 HTTP 每个请求都必须带它——
// 光认 iframe 身份和源不够，令牌才是"这台机器上谁在跟我说话"的凭据，停用即收回。
// 能力都在 permissions 里明示，运行时逐条把关：见 KNOWN_PERMS。
//
// 启用开关存 config.disabled_plugins（不在插件包里），重扫不丢用户选择。
// 工具经 ToolKind::Interpreter/Script 走既有执行链（自动继承 toolhomes 环境与超时配置）。
use serde::{Deserialize, Serialize};
use chrono::Timelike;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

/// 插件声明的工具
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema 参数描述；缺省为无参
    #[serde(default)]
    pub parameters: serde_json::Value,
    /// interpreter（本机解释器）| script（Rhai 沙盒），默认 interpreter
    #[serde(default = "default_tool_kind")]
    pub kind: String,
    /// interpreter 模式必填：运行时 id（py/js/ps1/…）
    #[serde(default)]
    pub runtime: String,
    /// 内联源码
    #[serde(default)]
    pub code: Option<String>,
    /// 相对插件目录的源码文件（优先于 code）
    #[serde(default)]
    pub file: Option<String>,
}

fn default_tool_kind() -> String {
    "interpreter".into()
}

/// 插件声明的技能（注入技能列表，与自动提炼技能同构）
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginSkill {
    pub name: String,
    #[serde(default)]
    pub summary: String,
}

/// 插件声明的定时任务
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginJob {
    pub name: String,
    /// "every 30m" / "every 2h" / "every 90s" / "daily 09:00"
    pub schedule: String,
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    /// 结果要注入的会话 id（空 = 只记审计日志）
    #[serde(default)]
    pub session: Option<String>,
}

/// 插件声明的本机服务器（进程由 BIT 托管，复用 workwith 执行引擎）
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PluginServer {
    /// 运行环境 id（node/py/java/…）；空或 "custom" = program 即可执行文件
    #[serde(default)]
    pub runtime: String,
    /// 相对插件目录的程序路径
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 期望监听端口；0 = BIT 分配空闲端口（经 BIT_PLUGIN_PORT 环境变量下发）
    #[serde(default)]
    pub port: u16,
    /// 启用插件 / 应用启动时自动拉起
    #[serde(default)]
    pub auto_start: bool,
    /// url 型页面的基准路径（缺省 "/"）
    #[serde(default)]
    pub entry: Option<String>,
}

/// 插件声明的常驻服务条目（需 "workwith" 权限）。
/// 与 server 的区别：server 只有一条、是插件页面的后端；services 可以有多条，
/// 各自进 WorkWith 列表，供后台常驻任务或自带 MCP 服务器使用。
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PluginService {
    /// 服务名（同插件内唯一；拼成条目 id `psvc-<插件id>-<name>`）
    pub name: String,
    /// 展示名（缺省回退 name）
    #[serde(default)]
    pub label: String,
    /// 运行环境 id（node/py/java/…）；"custom" = program 即可执行文件
    #[serde(default)]
    pub runtime: String,
    /// 程序：相对插件目录；绝对路径直接采用
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 工作目录：相对插件目录或绝对路径（缺省插件目录）
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 期望监听端口；0 = BIT 分配空闲端口（经 BIT_PLUGIN_PORT 下发）
    #[serde(default)]
    pub port: u16,
    /// MCP 联动方式：空 / "http" / "stdio"（与 WorkWith 同一套语义）
    #[serde(default)]
    pub mcp_mode: String,
    /// 启用插件 / 应用启动时自动拉起
    #[serde(default)]
    pub auto_start: bool,
}

/// 插件声明的外部 MCP 连接（需 "net" 权限）：服务器不在本机、由插件之外的人在跑
/// （SaaS 网关、公司内网的 MCP 服务、另一台机器上的自建服务）。
/// 与 services[] 的分工：services 是"BIT 拉起进程"，connections 是"BIT 连上已有端点"。
/// URL 与头里的 `{setting:KEY}` 在连接当时从本插件自己的设置取值：
/// 令牌因此只存在于用户填的设置里，插件包里写什么都带不出密钥。
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PluginConnection {
    /// 连接名（同插件内唯一；拼成 MCP 条目 id `pmcp-<插件id>-<name>`）
    pub name: String,
    /// 展示名（缺省回退 name）
    #[serde(default)]
    pub label: String,
    /// Streamable HTTP 端点；可含 `{setting:KEY}` 占位（整段 URL 来自设置也允许）
    pub url: String,
    /// 随每次请求发出的头（认证靠这里）。值同样支持 `{setting:KEY}`
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// 启用插件 / 应用启动时自动连接（取不到设置值就跳过，等用户填好手动连）
    #[serde(default)]
    pub auto_connect: bool,
}

/// 对外桥接（页面 iframe / 自带服务器 / 设置页）的安全声明。/// 令牌本身由宿主现发、不落盘（写进插件包等于把钥匙交给每个能读文件的本机应用），
/// 这里声明的是契约：插件接受并强制校验宿主令牌，缺省即拒载。
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PluginBridge {
    /// 唯一合法值 "required"：桥接调用（postMessage 与 HTTP）必须携带本插件令牌
    #[serde(default)]
    pub token: String,
}

/// 插件在左栏注册的独立页面（沙箱 iframe，非宿主 React 组件）
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginPage {
    pub id: String,
    pub label: String,
    /// 相对插件目录的静态 HTML（由 BIT 插件服务托管）
    #[serde(default)]
    pub src: Option<String>,
    /// 插件服务器上的路径（与 src 二选一，需声明 server）
    #[serde(default)]
    pub url: Option<String>,
    /// 导航字形：24 格 viewBox 下的描边路径（1–8 条，与 chat_icons 同一套白名单）。
    /// 缺省时渲染层回退到内置图标，不会因为没配图标而加载失败。
    #[serde(default)]
    pub paths: Vec<String>,
    /// 图片图标（相对插件目录，png/jpg/jpeg/gif/webp/ico/svg）：与 paths 二选一的另一种画法。
    /// 两者都给时以 icon 为准——插件作者交的是位图，就别再拿描边归一化去套它。
    #[serde(default, alias = "icon_file", alias = "iconFile")]
    pub icon: String,
}

/// 一个本地插件包（plugin.json）
#[derive(Serialize, Deserialize, Clone)]
pub struct Plugin {
    /// 插件 id = 目录名（sync 时强制用目录名覆盖，故 manifest 里可不写此字段；
    /// 不加 default 会让按文档格式编写的 plugin.json 解析失败、整个插件被静默跳过）
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// 语法糖：单数 `tool` 也认，一个对象不必再套数组
    #[serde(default, alias = "tool", deserialize_with = "one_or_many")]
    pub tools: Vec<PluginTool>,
    #[serde(default, alias = "prompt", deserialize_with = "one_or_many")]
    pub prompts: Vec<String>,
    #[serde(default, alias = "skill", deserialize_with = "one_or_many")]
    pub skills: Vec<PluginSkill>,
    #[serde(default, alias = "memory", deserialize_with = "one_or_many")]
    pub memories: Vec<String>,
    #[serde(default, alias = "job", deserialize_with = "one_or_many")]
    pub jobs: Vec<PluginJob>,
    // ── 插件化加强（前后端统一插件包）──
    /// 权限声明（启用时向用户明示）。能力与权限位一一绑定：清单里声明了某项能力却没申请
    /// 对应权限位 = 校验失败、整体不加载；运行时每条能力调用也按这里放的位逐条把关。
    /// css=界面样式 js=界面脚本 invoke=后端命令 server=托管进程 page=独立页面 chat=对话 API
    /// settings=设置中心条目与独立设置页 session=读写会话 workwith=注册托管服务
    /// pagectl=唤醒/改名页面 events=订阅宿主事件 notify=系统通知 data=自己的数据目录
    /// storage=宿主代管的命名空间存储 chaticon=对话页图标位 takeover=接管内置入口
    /// exec=控制台执行程序 write=读写与修改任意文件/程序 files=认领文件类型与解析
    /// net=连接外部 MCP 服务器（把别处的工具接给 AI） all=声明全部权限（仍需明示、可逐项关闭）
    /// 语法糖：既接受数组，也接受 `"page, data"` 这样的逗号分隔字符串
    #[serde(default, alias = "permission", alias = "perms", deserialize_with = "str_or_list")]
    pub permissions: Vec<String>,
    /// 前端 UI 能力：css/js 均为相对插件目录的文件路径列表（按序加载）
    #[serde(default)]
    pub ui: Option<PluginUi>,
    /// 对外桥接的安全声明（声明了 server / pages / 设置页时必须写）
    #[serde(default)]
    pub bridge: Option<PluginBridge>,
    /// 插件自带的本机服务器（需 "server" 权限）。
    /// 语法糖：可以只写一个字符串——"node server.js" 或 "server.js"
    #[serde(default, deserialize_with = "opt_server")]
    pub server: Option<PluginServer>,
    /// 插件声明的常驻服务（需 "workwith" 权限）：登记进 WorkWith，可随插件启用自动拉起
    #[serde(default, alias = "service", deserialize_with = "one_or_many")]
    pub services: Vec<PluginService>,
    /// 插件声明的外部 MCP 连接（需 "net" 权限）：连的是别处已经在跑的 Streamable HTTP
    /// 服务器，宿主握手成功后把它接进 MCP 列表并导入工具。
    /// 语法糖：单数 `connection`、单个对象都认
    #[serde(default, alias = "connection", deserialize_with = "one_or_many")]
    pub connections: Vec<PluginConnection>,
    /// 插件独立页面（需 "page" 权限）；语法糖：单数 `page`、单个对象都认
    #[serde(default, alias = "page", deserialize_with = "one_or_many")]
    pub pages: Vec<PluginPage>,
    /// 插件页右侧详情里的状态面板（需 "page" 权限）：不注册左栏入口，
    /// 只在该插件的详情里按需加载，适合放实时指标、健康检查这类随插件运行变化的内容
    #[serde(default, alias = "statuspage")]
    pub status_page: Option<PluginPage>,
    /// 设置中心注入（需 "settings" 权限）：条目 + 独立设置页
    #[serde(default)]
    pub settings: Option<PluginSettings>,
    /// 对话页图标排注入（需 "chaticon" 权限）：用户可拖拽换位，停用插件即收回
    #[serde(default, alias = "chat_icon", alias = "chatIcon", deserialize_with = "one_or_many")]
    pub chat_icons: Vec<PluginChatIcon>,
    /// 申请接管的宿主内置入口（需 "takeover" 权限）：如 ["chat.voice"]。
    /// 接管生效时宿主隐藏对应内置按钮；设置入口不在可接管目录里，永远不受影响。
    #[serde(default, alias = "takeovers", deserialize_with = "one_or_many")]
    pub takeover: Vec<String>,
    /// 语法糖：一次性把常用权限组合声明完（见 PRESETS）。
    /// 只做加法：preset 展开的权限与手写的 permissions 取并集，不覆盖、不删。
    /// 桥接令牌契约不在 preset 里代填——`bridge.token` 必须自己写出来。
    #[serde(default)]
    pub preset: String,
    /// 解释器白名单（需 "exec" 权限）：声明后 exec.run 只允许跑这些解释器，
    /// 命令行走 shell 需额外写 "shell"。留空 = 不限制（沿用 exec 权限本身的宽口径）。
    /// 目的是让"敢声明只跑 node"的插件把高危权限收窄到实际用到的那一个。
    #[serde(default, alias = "interpreter", deserialize_with = "str_or_list")]
    pub interpreters: Vec<String>,
    /// 文件类型登记（需 "files" 权限）：自定义图标 + 可选的解析工具。
    /// 语法糖：单数 `file_kind`、单个对象、扩展名写字符串或逗号串都认
    #[serde(default, alias = "file_kind", alias = "fileKind", deserialize_with = "one_or_many")]
    pub file_kinds: Vec<PluginFileKind>,
}

/// 插件声明的界面能力（渲染进程侧加载）
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PluginUi {
    /// 样式文件（相对插件目录），注入 <style>
    #[serde(default)]
    pub css: Vec<String>,
    /// 界面脚本入口（相对插件目录，按序执行），拿到受限插件 API
    #[serde(default)]
    pub js: Vec<String>,
}

/// 设置中心里的一个插件条目（点开展示本插件的设置页）
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginSettingEntry {
    /// 条目 id（同一插件内唯一；设置中心导航与深链用它）
    pub id: String,
    /// 卡片标题
    pub label: String,
    /// 卡片下的一行说明（可选）
    #[serde(default)]
    pub description: String,
    /// 查找关键字（可选，喂给设置中心的搜索框）
    #[serde(default)]
    pub kw: String,
}

/// 插件的设置中心注入（需 "settings" 权限）
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PluginSettings {
    /// 注入设置中心左栏的条目；页由 page 提供，条目只是入口
    #[serde(default)]
    pub entries: Vec<PluginSettingEntry>,
    /// 独立设置页（src 静态 / url 动态，规则同 pages）。
    /// 不声明则条目只作为入口，设置中心展示插件的键值面板。
    #[serde(default)]
    pub page: Option<PluginPage>,
}

/// 对话页图标排上的一个插件入口（需 "chaticon" 权限）。
/// 图标只收 SVG 路径数据（`paths` 里每条是 24 格 viewBox 下的 path d），由宿主用
/// 统一的描边风格画出来：不接受任何 HTML/SVG 标记，插件就无从往宿主界面里塞脚本或样式。
/// 渲染尺寸由宿主按墨迹归一，和内置图标一般大；位置由用户拖拽决定，存在渲染层本地。
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginChatIcon {
    /// 图标 id（同一插件内唯一，与插件 id 拼成宿主侧的 key）
    pub id: String,
    /// 悬停名称（中文界面）
    pub label: String,
    /// 悬停名称（英文界面，缺省回退 label）
    #[serde(default)]
    pub label_en: String,
    /// 图标路径：24 格 viewBox 下的 path d 列表（1–8 条）
    #[serde(default)]
    pub paths: Vec<String>,
    /// 图片图标（相对插件目录）：与 paths 二选一，两者都缺才算声明错误
    #[serde(default, alias = "icon_file", alias = "iconFile")]
    pub icon: String,
    /// 点击行为：page=跳到本插件页面（缺省）| prompt=把 text 填进对话输入框
    #[serde(default)]
    pub action: String,
    /// action=page 时的目标：本插件 pages / settings.entries 的 id；留空取唯一页面
    #[serde(default)]
    pub page_key: String,
    /// action=prompt 时要填进输入框的文本
    #[serde(default)]
    pub text: String,
}

/// 插件登记的一种文件类型（需 "files" 权限）。
/// 图标与 pages/chat_icons 同一套口径：只收 24 格 viewBox 下的 `path d`，宿主按墨迹归一，
/// 插件塞不进任何 HTML/SVG 标记。解析器指向本插件自己声明的某个工具——
/// 核心认得的类型永远优先，插件只补核心解析不了的那些。
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginFileKind {
    /// 类型 id（同一插件内唯一，与插件 id 拼成宿主侧的 key）
    pub id: String,
    /// 类型名（中文界面，出现在文件 chip 的悬停与「查看详情」里）
    pub label: String,
    /// 类型名（英文界面，缺省回退 label）
    #[serde(default)]
    pub label_en: String,
    /// 命中的扩展名。语法糖：`".fz"` / `"fz"` / 数组 / 逗号串都认，统一洗成小写带点
    #[serde(default, alias = "ext", deserialize_with = "str_or_list")]
    pub exts: Vec<String>,
    /// 图标字形（1–8 条；缺省回退内置文档图标）
    #[serde(default)]
    pub paths: Vec<String>,
    /// 图片图标（相对插件目录）：与 paths 二选一，都有时以 icon 为准
    #[serde(default, alias = "icon_file", alias = "iconFile")]
    pub icon: String,
    /// 解析器：本插件某个工具的名字。留空 = 只登记图标，正文仍按内置规则处理
    #[serde(default)]
    pub tool: String,
}

/// 允许声明的权限位（未知权限 = 清单校验失败，插件不加载）。
/// 前六个是既有能力，后面把"插件可能用到的一切"也纳入明示申报：
/// 每一项都在运行时逐条把关，未声明的调用直接拒绝——连存储也不例外。
/// `all` 是唯一通配位：本身也必须写进清单，运行时展开成下面全部具体权限，
/// 用户仍可在设置中心把展开后的任意一项单独关掉。
pub const ALL_PERM: &str = "all";

pub const KNOWN_PERMS: &[&str] = &[
    "css", "js", "invoke", "server", "page", "chat", "settings", "session", "workwith", "pagectl",
    "events", "notify", "data", "storage", "chaticon", "takeover", "exec", "write", "files", "net",
];

/// 可被插件接管的宿主内置入口（槽位名是稳定契约，插件清单里原样引用）。
/// 只开放对话页这组可替换的按钮；设置中心 / 权限页这类「退路」永远不进目录——
/// 接管必须随时能撤销，否则插件出问题后用户连关掉它的入口都找不到。
pub const TAKEOVER_SLOTS: &[(&str, &str, &str)] = &[
    ("chat.voice", "语音输入", "Voice input"),
    ("chat.preview", "预览", "Preview"),
    ("chat.attach", "附件", "Attach"),
    ("chat.plan", "计划", "Plan"),
    ("chat.template", "模板", "Template"),
    ("chat.web", "联网", "Web"),
    ("chat.bgjobs", "后台任务", "Background jobs"),
];

/// 槽位是否在可接管目录里（清单校验与运行时同一份判定）
pub fn takeover_slot_known(slot: &str) -> bool {
    TAKEOVER_SLOTS.iter().any(|(id, _, _)| *id == slot)
}

/// 权限预设：一个词换一组常用权限位，省掉新手照着文档抄十几行。
/// 只做加法（见 apply_preset），并且**不代填 bridge**——令牌契约必须由作者亲口写出来，
/// 否则"用了 preset 就默认开了无凭据接口"这种事故没人能在评审里看出来。
pub const PRESETS: &[(&str, &[&str])] = &[
    ("page", &["page", "storage", "settings", "data", "events", "notify", "pagectl"]),
    ("ui", &["css", "js", "settings", "storage", "events", "notify", "data"]),
    ("server", &["server", "page", "data", "settings", "events", "notify"]),
    ("service", &["workwith", "data", "settings", "events", "notify"]),
    ("ai", &["chat", "session", "data", "settings", "notify"]),
    ("tool", &["data", "settings", "notify"]),
    ("device", &["invoke", "exec", "write", "data", "notify"]),
    // 外部连接类插件：连别人的 MCP 服务器 + 把自己的地址/令牌放在设置里给用户填
    ("connect", &["net", "settings", "data", "notify", "events"]),
    ("full", &[ALL_PERM]),
];

pub fn preset_known(name: &str) -> bool {
    PRESETS.iter().any(|(id, _)| *id == name)
}

/// 把 preset 展开进 permissions（并集、去重、保持声明顺序）
pub fn apply_preset(p: &mut Plugin) {
    let name = p.preset.trim().to_ascii_lowercase();
    if name.is_empty() {
        return;
    }
    p.preset = name.clone();
    let Some((_, perms)) = PRESETS.iter().find(|(id, _)| *id == name) else {
        return; // 未知预设交给 validate 报错，这里不静默吞掉
    };
    for perm in *perms {
        if !p.permissions.iter().any(|x| x == perm) {
            p.permissions.push((*perm).to_string());
        }
    }
}

/// 清一清清单里的空白与重复：permissions / interpreters 都按 trim + 小写 + 去重处理，
/// 让 " page , DATA " 和 ["page","data"] 这两种写法得到同一个结果
pub fn normalize_manifest(p: &mut Plugin) {
    p.permissions = dedupe_trim(&p.permissions);
    p.interpreters = dedupe_trim(&p.interpreters);
    // 扩展名统一成小写带点：作者写 "FZ"、".fz"、"fz, fzz" 都落到同一份口径，
    // 校验、注册表与界面匹配因此只用一种写法
    for fk in p.file_kinds.iter_mut() {
        fk.exts = normalize_exts(&fk.exts);
    }
}

/// 扩展名清洗：去空白、补前导点、转小写、去重（保持声明顺序）
fn normalize_exts(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in list {
        let t = raw.trim().to_ascii_lowercase();
        if t.is_empty() {
            continue;
        }
        let e = if t.starts_with('.') { t } else { format!(".{t}") };
        if !out.contains(&e) {
            out.push(e);
        }
    }
    out
}

fn dedupe_trim(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in list {
        let t = x.trim().to_ascii_lowercase();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

// ── 清单语法糖的反序列化：单对象=单元素数组、字符串=逗号分隔列表 ──

/// `deserialize_with`：一个对象、对象数组、null、缺省都接受。
/// 插件作者最常写的就是"我只有一个页面"，别让 schema 逼他套一层方括号。
fn one_or_many<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let v = serde_json::Value::deserialize(d)?;
    let items: Vec<serde_json::Value> = match v {
        serde_json::Value::Null => Vec::new(),
        serde_json::Value::Array(a) => a,
        single => vec![single],
    };
    items
        .into_iter()
        .map(|x| serde_json::from_value(x).map_err(serde::de::Error::custom))
        .collect()
}

/// 字符串或数组都能表达一个列表：permissions 用逗号串、interpreters 用一行写完 `"page, data"` / `"page data"` 这类字符串写法
fn str_or_list<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Null => Ok(Vec::new()),
        serde_json::Value::String(s) => Ok(s
            .split(|c| c == ',' || c == ';' || c == ' ' || c == '\n' || c == '\t')
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect()),
        serde_json::Value::Array(a) => a
            .into_iter()
            .map(|x| {
                x.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| serde::de::Error::custom("permissions 里每一项都必须是字符串"))
            })
            .collect(),
        _ => Err(serde::de::Error::custom("permissions 必须是字符串或字符串数组")),
    }
}

/// server：既收对象，也收 `"node server.js"` / `"server.js"` 这种一行写法
fn opt_server<'de, D>(d: D) -> Result<Option<PluginServer>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(s) => {
            let s = s.trim().to_string();
            if s.is_empty() {
                return Ok(None);
            }
            // 第一个空格前是运行环境 id，其余是程序路径；没写环境就留给 validate 提醒
            let (runtime, program) = match s.split_once(' ') {
                Some((r, p)) => (r.trim().to_string(), p.trim().to_string()),
                None => (String::new(), s),
            };
            Ok(Some(PluginServer { runtime, program, ..Default::default() }))
        }
        obj => serde_json::from_value(obj)
            .map(Some)
            .map_err(serde::de::Error::custom),
    }
}

/// 用户逐个撤回的接管槽位（config.plugin_denied_takeovers）。
/// 与权限位分开存：关掉 takeover 权限 = 整包停用接管，这里只撤回单个槽位，
/// 插件后续新增的槽位仍按默认生效。
pub fn denied_takeovers(ctx: &Arc<crate::state::Ctx>, id: &str) -> Vec<String> {
    ctx.config.lock().unwrap().plugin_denied_takeovers.get(id).cloned().unwrap_or_default()
}

/// 该插件是否申报了某权限位（清单校验与运行时闸门的统一问法）。
/// `all` 视为申报了全部具体权限；查询 `all` 本身则只看有没有原样写。
pub fn has_perm(p: &Plugin, perm: &str) -> bool {
    if perm == ALL_PERM {
        return p.permissions.iter().any(|x| x == ALL_PERM);
    }
    p.permissions.iter().any(|x| x == perm || x == ALL_PERM)
}

/// 清单申报的权限位展开后（`all` → 全部具体权限），保持 KNOWN_PERMS 的稳定顺序并去重。
/// 设置中心与 `get_plugin_ui` 都用这份列表：声明了 all 也能逐项展示、逐项关闭。
pub fn declared_perms(p: &Plugin) -> Vec<String> {
    if has_perm(p, ALL_PERM) {
        return KNOWN_PERMS.iter().map(|x| x.to_string()).collect();
    }
    let mut out: Vec<String> = Vec::new();
    for perm in &p.permissions {
        if !out.contains(perm) {
            out.push(perm.clone());
        }
    }
    out
}

/// 用户在插件详情里单独关掉的权限位（config.plugin_denied_perms）
pub fn denied_perms(ctx: &Arc<crate::state::Ctx>, id: &str) -> Vec<String> {
    ctx.config.lock().unwrap().plugin_denied_perms.get(id).cloned().unwrap_or_default()
}

/// 运行时真正生效的权限位 = 清单申报（all 展开）− 用户单独关闭
pub fn effective_perms(ctx: &Arc<crate::state::Ctx>, p: &Plugin) -> Vec<String> {
    let denied = denied_perms(ctx, &p.id);
    declared_perms(p).into_iter().filter(|x| !denied.contains(x)).collect()
}

/// 权限位是否在运行时生效：清单申报了，且用户没有单独关闭。
/// 清单校验仍只用 has_perm（申报了才能用）；这里的"用户开关"只影响运行时。
pub fn has_grant(ctx: &Arc<crate::state::Ctx>, p: &Plugin, perm: &str) -> bool {
    has_perm(p, perm) && !denied_perms(ctx, &p.id).iter().any(|x| x == perm)
}

/// 按 id 查启用且未篡改的插件
pub fn enabled_plugin(ctx: &Arc<crate::state::Ctx>, id: &str) -> Option<Plugin> {
    enabled_plugins(ctx).into_iter().find(|p| p.id == id)
}

/// 按 id 查启用、未篡改且该权限位仍被用户放行的插件（页面/对话等 HTTP 入口用）
pub fn enabled_granted(ctx: &Arc<crate::state::Ctx>, id: &str, perm: &str) -> Option<Plugin> {
    enabled_plugin(ctx, id).filter(|p| has_grant(ctx, p, perm))
}

pub fn dir(ctx: &Arc<crate::state::Ctx>) -> PathBuf {
    crate::toolenv::dir(ctx).join("plugins")
}

pub(crate) fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
}

/// 解析工具源码：file 相对插件目录优先，回退内联 code
fn resolve_code(plugin_dir: &std::path::Path, file: &Option<String>, code: &Option<String>) -> Option<String> {
    if let Some(f) = file {
        let p = plugin_dir.join(f);
        if let Ok(s) = fs::read_to_string(&p) {
            return Some(s);
        }
    }
    code.clone().filter(|s| !s.trim().is_empty())
}

/// 相对路径包含性检查：拒绝绝对路径与 `..` 逃逸（ui/css/js 文件读取的统一闸门）
pub(crate) fn safe_rel(raw: &str) -> Result<(), String> {
    let p = std::path::Path::new(raw);
    if p.is_absolute() {
        return Err(format!("absolute path not allowed: {raw}"));
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("path escapes plugin dir: {raw}"));
    }
    Ok(())
}

/// 自我安全校验：清单 schema + 权限位 + 路径包含性。
/// 不合格的插件整体不加载（scan 阶段拦截，错误进 errs 列表展示给用户）。
fn validate(p: &Plugin, pdir: &std::path::Path) -> Result<(), String> {
    if p.name.trim().is_empty() {
        return Err("name is required".into());
    }
    for perm in &p.permissions {
        if perm != ALL_PERM && !KNOWN_PERMS.contains(&perm.as_str()) {
            return Err(format!(
                "unknown permission: {perm} (known: {}, {ALL_PERM})",
                KNOWN_PERMS.join(", ")
            ));
        }
    }
    // preset 是权限组合的简写：写错了要当场说清有哪些可选，别默默当成"没声明权限"
    if !p.preset.trim().is_empty() && !preset_known(&p.preset) {
        return Err(format!(
            "unknown preset \"{}\" (known: {})",
            p.preset,
            PRESETS.iter().map(|(id, _)| *id).collect::<Vec<_>>().join(", ")
        ));
    }
    // 解释器白名单只在 exec 权限的语境里有意义：没申报 exec 却写了 interpreters，
    // 要么是多写的，要么是以为它能代替申报——两种都得当场纠正
    if !p.interpreters.is_empty() && !has_perm(p, "exec") {
        return Err("interpreters declared but missing permission \"exec\"".into());
    }
    for it in &p.interpreters {
        if it.trim().is_empty() {
            return Err("interpreters entries must be non-empty (use \"shell\" for command execution)".into());
        }
    }
    // 桥接面（页面 / 自带服务器 / 设置页）必须在清单里明示令牌契约：
    // 缺省不放行，避免"默认无凭据"的接口随插件静默上线。
    if let Some(b) = &p.bridge {
        if b.token.trim() != "required" {
            return Err(format!("bridge.token must be \"required\" (got \"{}\")", b.token.trim()));
        }
    }
    let publishes_bridge = p.server.is_some()
        || !p.pages.is_empty()
        || p.status_page.is_some()
        || p.settings.as_ref().and_then(|s| s.page.as_ref()).is_some();
    if publishes_bridge && p.bridge.is_none() {
        return Err(
            "server/pages/settings.page requires \"bridge\": {\"token\": \"required\"} in plugin.json".into(),
        );
    }
    // ui 能力必须有对应权限位声明（有文件无声明 = 拒绝，防"看起来无害"的插件夹带脚本）。
    // 判定统一走 has_perm：`all` 是"一次声明全部权限"的写法，清单级闸门不能只认字面量。
    if let Some(ui) = &p.ui {
        if !ui.css.is_empty() && !has_perm(p, "css") {
            return Err("ui.css declared but missing permission \"css\"".into());
        }
        if !ui.js.is_empty() && !has_perm(p, "js") {
            return Err("ui.js declared but missing permission \"js\"".into());
        }
        for f in ui.css.iter().chain(ui.js.iter()) {
            safe_rel(f)?;
            if !pdir.join(f).is_file() {
                return Err(format!("ui file not found: {f}"));
            }
        }
    }
    // interpreter 工具必须有运行时；工具源码文件同样过路径闸门
    for t in &p.tools {
        if t.kind != "script" && t.runtime.trim().is_empty() {
            return Err(format!("tool `{}`: interpreter kind requires runtime", t.name));
        }
        if let Some(f) = &t.file {
            safe_rel(f)?;
        }
    }
    for j in &p.jobs {
        if parse_schedule(&j.schedule).is_none() {
            return Err(format!("job `{}`: bad schedule `{}`", j.name, j.schedule));
        }
        if let Some(f) = &j.file {
            safe_rel(f)?;
        }
    }
    // 服务器：权限位 + 程序文件存在性（runtime 必填，"custom" = 直接执行 program）
    if let Some(sv) = &p.server {
        if !has_perm(p, "server") {
            return Err("server declared but missing permission \"server\"".into());
        }
        safe_rel(&sv.program)?;
        if !pdir.join(&sv.program).is_file() {
            return Err(format!("server program not found: {}", sv.program));
        }
        if sv.runtime.trim().is_empty() {
            return Err("server.runtime is required (use \"custom\" to exec the program directly)".into());
        }
    }
    // 托管服务：workwith 权限 + 名称唯一 + 程序/工作目录存在性 + MCP 取值。
    // 程序相对插件目录；绝对路径同样放行（清单已明示，运行时由 workwith 权限把关）。
    if !p.services.is_empty() {
        if !has_perm(p, "workwith") {
            return Err("services declared but missing permission \"workwith\"".into());
        }
        if p.services.len() > 16 {
            return Err(format!("too many services: {} (max 16)", p.services.len()));
        }
        let mut seen: Vec<String> = Vec::new();
        for sv in &p.services {
            let name = sv.name.trim();
            if name.is_empty() {
                return Err("service requires non-empty name".into());
            }
            let sid = sanitize(name);
            if sid.is_empty() {
                return Err(format!("service `{name}`: name has no usable characters"));
            }
            if seen.contains(&sid) {
                return Err(format!("service name duplicated: {name}"));
            }
            seen.push(sid);
            if sv.runtime.trim().is_empty() {
                return Err(format!(
                    "service `{name}`: runtime is required (use \"custom\" to exec the program directly)"
                ));
            }
            let prog = sv.program.trim();
            if prog.is_empty() {
                return Err(format!("service `{name}`: program is required"));
            }
            let pp = std::path::Path::new(prog);
            if !pp.is_absolute() {
                safe_rel(prog)?;
            }
            let program_abs = if pp.is_absolute() { pp.to_path_buf() } else { pdir.join(pp) };
            if !program_abs.is_file() {
                return Err(format!("service `{name}`: program not found: {prog}"));
            }
            let cwd = sv.cwd.trim();
            if !cwd.is_empty() {
                let cp = std::path::Path::new(cwd);
                if !cp.is_absolute() {
                    safe_rel(cwd)?;
                }
                let cwd_abs = if cp.is_absolute() { cp.to_path_buf() } else { pdir.join(cp) };
                if !cwd_abs.is_dir() {
                    return Err(format!("service `{name}`: cwd not found: {cwd}"));
                }
            }
            let mode = sv.mcp_mode.trim().to_lowercase();
            if !matches!(mode.as_str(), "" | "http" | "stdio") {
                return Err(format!(
                    "service `{name}`: mcp_mode only supports http / stdio (got \"{}\")",
                    sv.mcp_mode
                ));
            }
        }
    }
    // 外部连接：net 权限 + 地址口径 + 头名合法 + 数量上限（细规则见 netconn::validate）。
    // 地址含 {setting:KEY} 时扫描期只能查占位写法，scheme 一类的硬闸门在连接当时
    // 对展开后的值判——设置里填个 file:// 也照样拦得住。
    if !p.connections.is_empty() {
        if !has_perm(p, "net") {
            return Err("connections declared but missing permission \"net\"".into());
        }
        crate::netconn::validate(p, &p.connections)?;
    }
    // 页面：权限位 + src/url 二选一 + src 路径包含性与存在性
    if !p.pages.is_empty() && !has_perm(p, "page") {
        return Err("pages declared but missing permission \"page\"".into());
    }    for pg in &p.pages {
        validate_page(p, pg, pdir)?;
    }
    // 状态面板与独立页面同一套规则：不注册左栏入口，但仍是一条对外桥接通道
    if let Some(pg) = &p.status_page {
        if !has_perm(p, "page") {
            return Err("status_page declared but missing permission \"page\"".into());
        }
        validate_page(p, pg, pdir)?;
    }
    // 设置中心注入：声明了条目或设置页就必须申请 settings；条目 id 不得重复
    if let Some(st) = &p.settings {
        if (!st.entries.is_empty() || st.page.is_some()) && !has_perm(p, "settings") {
            return Err("settings declared but missing permission \"settings\"".into());
        }
        let mut seen: Vec<&str> = Vec::new();
        for en in &st.entries {
            if en.id.trim().is_empty() || en.label.trim().is_empty() {
                return Err("settings entry requires non-empty id and label".into());
            }
            if seen.contains(&en.id.as_str()) {
                return Err(format!("settings entry id duplicated: {}", en.id));
            }
            seen.push(en.id.as_str());
        }
        if let Some(pg) = &st.page {
            validate_page(p, pg, pdir)?;
        }
    }
    // 对话页图标：权限位 + 数量上限 + 路径数据白名单。
    // 白名单就是渲染时允许的全部字符：任何标记字符（< > " ' / &）都进不来，
    // 宿主只把这些字符串当 <path d> 用，插件无从往宿主界面里夹带脚本或样式。
    if !p.chat_icons.is_empty() {
        if !has_perm(p, "chaticon") {
            return Err("chat_icons declared but missing permission \"chaticon\"".into());
        }
        if p.chat_icons.len() > 4 {
            return Err(format!("too many chat_icons: {} (max 4)", p.chat_icons.len()));
        }
        let mut seen: Vec<&str> = Vec::new();
        for ic in &p.chat_icons {
            if ic.id.trim().is_empty() || ic.label.trim().is_empty() {
                return Err("chat icon requires non-empty id and label".into());
            }
            if seen.contains(&ic.id.as_str()) {
                return Err(format!("chat icon id duplicated: {}", ic.id));
            }
            seen.push(ic.id.as_str());
            // 图标两种画法任选其一，但必须给一个：对话页图标排上没有名字的空白按钮最没人认得出是谁
            if ic.paths.is_empty() && ic.icon.trim().is_empty() {
                return Err(format!("chat icon `{}`: requires paths or icon", ic.id));
            }
            if !ic.paths.is_empty() {
                validate_icon_paths("chat icon", &ic.id, &ic.paths)?;
            }
            if !ic.icon.trim().is_empty() {
                validate_icon_file("chat icon", &ic.id, &ic.icon, &pdir)?;
            }
            match ic.action.as_str() {
                "" | "page" => {
                    if ic.page_key.len() > 64 {
                        return Err(format!("chat icon `{}`: page_key too long", ic.id));
                    }
                }
                "prompt" => {
                    let n = ic.text.chars().count();
                    if ic.text.trim().is_empty() || n > 2000 {
                        return Err(format!("chat icon `{}`: action=prompt requires text (<=2000 chars)", ic.id));
                    }
                }
                other => return Err(format!("chat icon `{}`: unknown action `{other}` (page|prompt)", ic.id)),
            }
        }
    }
    // 文件类型登记：权限位 + 数量上限 + 扩展名口径 + 图标白名单 + 解析工具必须是自己声明的。
    // 内置已经解析得了的类型（.pdf/.xlsx/文本类…）不许抢：抢了会把用户已经习惯的解析结果
    // 换成插件实现，而插件随时能被停用——停用后这些文件就没人认了。
    if !p.file_kinds.is_empty() {
        if !has_perm(p, "files") {
            return Err("file_kinds declared but missing permission \"files\"".into());
        }
        if p.file_kinds.len() > 12 {
            return Err(format!("too many file_kinds: {} (max 12)", p.file_kinds.len()));
        }
        let mut seen_ids: Vec<&str> = Vec::new();
        let mut seen_exts: Vec<String> = Vec::new();
        for fk in &p.file_kinds {
            if fk.id.trim().is_empty() || fk.label.trim().is_empty() {
                return Err("file kind requires non-empty id and label".into());
            }
            if seen_ids.contains(&fk.id.as_str()) {
                return Err(format!("file kind id duplicated: {}", fk.id));
            }
            seen_ids.push(fk.id.as_str());
            if fk.exts.is_empty() {
                return Err(format!("file kind `{}`: exts required (e.g. [\".fz\"])", fk.id));
            }
            for e in &fk.exts {
                let body = e.trim_start_matches('.');
                if body.is_empty() || body.len() > 12 || !body.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Err(format!("file kind `{}`: bad extension `{e}` (1-12 letters/digits)", fk.id));
                }
                if seen_exts.contains(e) {
                    return Err(format!("file kind `{}`: extension {e} already declared", fk.id));
                }
                seen_exts.push(e.clone());
                if crate::extract::supports(&format!("probe{e}")) {
                    return Err(format!(
                        "file kind `{}`: {e} is already parsed by the host; plugins only add kinds the host cannot read",
                        fk.id
                    ));
                }
            }
            if !fk.paths.is_empty() {
                validate_icon_paths("file kind", &fk.id, &fk.paths)?;
            }
            if !fk.icon.trim().is_empty() {
                validate_icon_file("file kind", &fk.id, &fk.icon, pdir)?;
            }
            let tool = fk.tool.trim();
            if !tool.is_empty() && !p.tools.iter().any(|t| t.name.trim() == tool) {
                return Err(format!("file kind `{}`: tool `{tool}` is not declared by this plugin", fk.id));
            }
        }
    }
    // 接管：权限位 + 槽位目录 + 数量不限（只是同一槽位不能重复声明）。
    // 设置类槽位显式拒绝并给出人话：设置页是撤销接管的退路，不能被接管，
    // 否则插件把入口藏掉后用户就再也找不回来。
    if !p.takeover.is_empty() {
        if !has_perm(p, "takeover") {
            return Err("takeover declared but missing permission \"takeover\"".into());
        }
        let mut seen: Vec<&str> = Vec::new();
        for raw in &p.takeover {
            let slot = raw.trim();
            if slot.is_empty() {
                return Err("takeover slot must be non-empty".into());
            }
            if slot == "settings" || slot.starts_with("settings.") || slot.starts_with("settings:") {
                return Err(format!("`{slot}` cannot be taken over: settings must stay reachable"));
            }
            if !takeover_slot_known(slot) {
                let known: Vec<&str> = TAKEOVER_SLOTS.iter().map(|(id, _, _)| *id).collect();
                return Err(format!("unknown takeover slot `{slot}` (known: {})", known.join(", ")));
            }
            if seen.contains(&slot) {
                return Err(format!("takeover slot duplicated: {slot}"));
            }
            seen.push(slot);
        }
    }
    Ok(())
}

/// 图片图标允许的扩展名：位图与矢量都收，但只收"当图标画得出来"的那几样。
/// svg 也在列——它和位图走同一条静态路由，渲染层一律用 `<img>` 画，
/// 所以脚本型 svg 不会被执行（浏览器在 img 语境里不跑 svg 内的 script）。
pub const ICON_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "ico", "svg"];

/// 图标文件体积上限：图标常驻每一帧解码，几百 KB 的图不该混进来。
/// 静态路由另有 4MB 的总闸门，这里按"图标"而不是"资源文件"的口径收紧。
pub const MAX_ICON_BYTES: u64 = 512 * 1024;

/// 图片图标校验：扩展名白名单 + 相对路径闸门 + 文件必须真的在包里且不过大。
/// 声明了却找不到文件就直接拒收整包——图标是插件的门面，宁可装载失败也不要
/// 用户在导航栏里看见一块永远加载不出来的空白。
pub fn validate_icon_file(kind: &str, id: &str, rel: &str, pdir: &std::path::Path) -> Result<(), String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err(format!("{kind} `{id}`: icon is empty"));
    }
    safe_rel(rel).map_err(|e| format!("{kind} `{id}`: bad icon path: {e}"))?;
    let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
    if !ICON_EXTS.contains(&ext.as_str()) {
        return Err(format!("{kind} `{id}`: icon type not allowed: {ext} (need {})", ICON_EXTS.join("/")));
    }
    let p = pdir.join(rel);
    let meta = fs::metadata(&p).map_err(|_| format!("{kind} `{id}`: icon file not found: {rel}"))?;
    if !meta.is_file() {
        return Err(format!("{kind} `{id}`: icon is not a file: {rel}"));
    }
    if meta.len() > MAX_ICON_BYTES {
        return Err(format!(
            "{kind} `{id}`: icon too large: {} KB (max {} KB)",
            meta.len() / 1024,
            MAX_ICON_BYTES / 1024
        ));
    }
    Ok(())
}

/// 字形路径白名单：pages[].paths 与 chat_icons[].paths 共用。
/// 宿主只把字符串当 `<path d>` 用，所以标记字符（< > " ' / &）一律不收；
/// 数量与长度也在这里收口，避免插件往导航上塞超长路径拖慢每一帧。
fn validate_icon_paths(kind: &str, id: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 8 {
        return Err(format!("{kind} `{id}`: 1-8 paths required"));
    }
    for d in paths {
        if d.len() > 400
            || !d
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | ',' | '.' | '-' | '+'))
        {
            return Err(format!("{kind} `{id}`: bad path data (only path commands allowed)"));
        }
    }
    Ok(())
}

/// 一个页面声明的校验（导航页与设置页同一套规则）：id/label 非空、src 与 url 二选一、
/// src 过路径闸门且真实存在、url 型必须指向本插件的 server
fn validate_page(p: &Plugin, pg: &PluginPage, pdir: &std::path::Path) -> Result<(), String> {
    if pg.id.trim().is_empty() || pg.label.trim().is_empty() {
        return Err("page requires non-empty id and label".into());
    }
    // 图标可选；一旦声明了就必须是合法路径数据（缺省时渲染层回退内置图标）
    if !pg.paths.is_empty() {
        validate_icon_paths("page icon", &pg.id, &pg.paths)?;
    }
    if !pg.icon.trim().is_empty() {
        validate_icon_file("page icon", &pg.id, &pg.icon, pdir)?;
    }
    let has_src = pg.src.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    let has_url = pg.url.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    if has_src == has_url {
        return Err(format!("page `{}`: exactly one of src / url is required", pg.id));
    }
    if let Some(s) = pg.src.as_deref().filter(|s| !s.trim().is_empty()) {
        safe_rel(s)?;
        if !pdir.join(s).is_file() {
            return Err(format!("page src not found: {s}"));
        }
    }
    if let Some(u) = pg.url.as_deref().filter(|s| !s.trim().is_empty()) {
        if !u.starts_with('/') {
            return Err(format!("page url must start with '/': {u}"));
        }
        if p.server.is_none() {
            return Err(format!("page `{}` uses url but the plugin declares no server", pg.id));
        }
    }
    Ok(())
}

/// 扫描插件目录：读取全部 plugin.json（解析失败/校验不过的目录跳过并列出错误）
pub fn scan(ctx: &Arc<crate::state::Ctx>) -> (Vec<Plugin>, Vec<String>) {
    let mut out = Vec::new();
    let mut errs = Vec::new();
    let root = dir(ctx);
    // 顺手确保进程侧 SDK 就位：装完插件不重启应用也能立刻 require("bit")
    crate::plugin_sdk::ensure(ctx);
    let Ok(entries) = fs::read_dir(&root) else {
        return (out, errs);
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let Some(pid) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let manifest = path.join("plugin.json");
        match fs::read_to_string(&manifest) {
            Ok(text) => match serde_json::from_str::<Plugin>(&text) {
                Ok(mut p) => {
                    p.id = pid.to_string();
                    if p.name.trim().is_empty() {
                        p.name = pid.to_string();
                    }
                    // 语法糖先落地：preset 展开权限、权限/解释器列表清洗去重
                    apply_preset(&mut p);
                    normalize_manifest(&mut p);
                    // 自我安全校验（schema/权限/路径）：不过的插件不进加载列表
                    if let Err(e) = validate(&p, &path) {
                        errs.push(format!("{pid}: {e}"));
                        continue;
                    }
                    out.push(p);
                }
                Err(e) => errs.push(format!("{pid}: {e}")),
            },
            Err(_) => errs.push(format!("{pid}: plugin.json missing or unreadable")),
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    (out, errs)
}

// ---------- 自我安全校验：全文件 SHA-256 基线（防篡改）----------
//
// 首次启用插件时对插件目录全部文件算哈希基线（bit.db 文档 "plugin_baselines"），
// 此后每次 scan 对比：文件被改动/新增/删除 → 该插件按未启用处理（不注入任何能力），
// 错误进 errs 并记审计。用户在 UI 点「信任并启用」可重录基线（覆盖为当前内容）。

/// 递归计算插件目录内容哈希：路径（相对、正斜杠）+ 内容 逐条喂 sha256，
/// 顺序固定（目录遍历后排序），结果为 64 位 hex。
fn dir_fingerprint(pdir: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    fn walk(base: &std::path::Path, cur: &std::path::Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
        let entries = fs::read_dir(cur).map_err(|e| e.to_string())?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out)?;
            } else {
                let rel = p
                    .strip_prefix(base)
                    .map_err(|_| "strip_prefix failed".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, p));
            }
        }
        Ok(())
    }
    walk(pdir, pdir, &mut files)?;
    files.sort();
    let mut h = Sha256::new();
    for (rel, p) in &files {
        h.update(rel.as_bytes());
        h.update([0]);
        let bytes = fs::read(p).map_err(|e| format!("{rel}: {e}"))?;
        h.update(&(bytes.len() as u64).to_le_bytes());
        h.update(&bytes);
    }
    Ok(format!("{:x}", h.finalize()))
}

type Baselines = HashMap<String, String>;

fn load_baselines(ctx: &Arc<crate::state::Ctx>) -> Baselines {
    let db = ctx.db.lock().unwrap();
    crate::store::get_json::<Baselines>(&db, "plugin_baselines").unwrap_or_default()
}

fn save_baselines(ctx: &Arc<crate::state::Ctx>, st: &Baselines) {
    let db = ctx.db.lock().unwrap();
    crate::store::put_json(&db, "plugin_baselines", st);
}

/// 信任并启用：重录该插件的哈希基线（当前内容即信任基线）
pub fn record_baseline(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<(), String> {
    let fp = dir_fingerprint(&dir(ctx).join(id))?;
    let mut st = load_baselines(ctx);
    st.insert(id.to_string(), fp);
    save_baselines(ctx, &st);
    Ok(())
}

/// 校验单个插件：无基线 = 从未启用过（返回 Ok，首次启用时补录）；
/// 有基线且不匹配 = 篡改，返回差异说明
pub fn verify(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<(), String> {
    let Some(base) = load_baselines(ctx).get(id).cloned() else {
        return Ok(());
    };
    let now = dir_fingerprint(&dir(ctx).join(id))?;
    if now != base {
        return Err("内容与启用时基线不一致（文件被改动）".into());
    }
    Ok(())
}

/// 启用插件的基线核对（sync / prompt_fragment / scheduler 共用，幂等）：
/// 无基线 → 补录当前内容（首次启用/升级接入）；不匹配 → 进返回列表（篡改）。
/// 审计只在 sync 里记，避免非 sync 调用点重复刷审计流水。
pub fn tampered_ids(ctx: &Arc<crate::state::Ctx>, enabled: &[&Plugin]) -> Vec<String> {
    let mut out = Vec::new();
    let mut baselines = load_baselines(ctx);
    let mut dirty = false;
    for p in enabled {
        match dir_fingerprint(&dir(ctx).join(&p.id)) {
            Ok(now) => match baselines.get(&p.id) {
                Some(base) if *base != now => out.push(p.id.clone()),
                None => {
                    baselines.insert(p.id.clone(), now);
                    dirty = true;
                }
                _ => {}
            },
            Err(_) => out.push(p.id.clone()), // 读不出文件按不可信处理
        }
    }
    if dirty {
        save_baselines(ctx, &baselines);
    }
    out
}

/// 工具/技能/记忆 与插件状态的同步：
/// 先清掉旧的 plugin 来源条目，再按当前启用列表重新写入。
/// 幂等：重扫/开关后调用都安全。
/// 含自我安全校验：启用中的插件逐个过哈希基线，篡改的按未启用处理（不注入任何能力）。
pub fn sync(ctx: &Arc<crate::state::Ctx>) {
    let (plugins, mut errs) = scan(ctx);
    let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };

    // ---- 哈希基线校验（防篡改）----
    // 无基线的启用插件补录当前内容为基线；不匹配 = 篡改 → 按未启用处理 + errs + 审计。
    let enabled_refs: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
    let tampered = tampered_ids(ctx, &enabled_refs);
    for id in &tampered {
        errs.push(format!(
            "{id}: 安全校验失败 — 内容与启用时基线不一致，已停用（在工具页重新启用可信任当前内容）"
        ));
        // 篡改的插件立即失去通讯凭据：页面帧与服务器进程随后的每条调用都会被拒
        crate::plugin_api::revoke_token(id);
        crate::plugin_caps::stop_services(ctx, id);
        crate::audit::record(
            ctx,
            "system",
            "plugin.verify",
            id,
            serde_json::json!({ "ok": false, "reason": "baseline mismatch" }),
            false,
        );
    }
    let is_on = |p: &Plugin| !disabled.contains(&p.id) && !tampered.contains(&p.id);

    // ---- 工具 ----
    {
        let mut tools = ctx.tools.lock().unwrap();
        tools.retain(|t| !t.created_by.starts_with("plugin:"));
        for p in plugins.iter().filter(|p| is_on(p)) {
            let pdir = dir(ctx).join(&p.id);
            for t in &p.tools {
                let Some(code) = resolve_code(&pdir, &t.file, &t.code) else {
                    continue;
                };
                let kind = if t.kind == "script" {
                    crate::registry::ToolKind::Script { code }
                } else {
                    if t.runtime.trim().is_empty() {
                        continue; // interpreter 模式必须指定运行时
                    }
                    crate::registry::ToolKind::Interpreter { runtime: t.runtime.trim().to_string(), code }
                };
                let parameters = if t.parameters.is_null() {
                    serde_json::json!({ "type": "object", "properties": {} })
                } else {
                    t.parameters.clone()
                };
                tools.push(crate::registry::ToolDef {
                    id: format!("plugin::{}::{}", p.id, sanitize(&t.name)),
                    name: format!("p_{}_{}", sanitize(&p.id), sanitize(&t.name)),
                    description: if t.description.is_empty() {
                        format!("Plugin `{}` tool `{}`", p.name, t.name)
                    } else {
                        t.description.clone()
                    },
                    parameters,
                    kind,
                    created_by: format!("plugin:{}", p.id),
                    created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                    enabled: true,
                });
            }
        }
    }
    let _ = ctx.save_tools();

    // ---- 技能 / 记忆：来源标记 plugin:<id>，重扫时整体重建 ----
    {
        let mut skills = ctx.skills.lock().unwrap();
        skills.retain(|s| !s.source.starts_with("plugin:"));
        for p in plugins.iter().filter(|p| is_on(p)) {
            for sk in &p.skills {
                skills.push(crate::memory::Skill {
                    id: String::new(), // 注入型技能不参与 memory(id) 取回，空 id
                    ts: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                    name: sk.name.clone(),
                    summary: sk.summary.clone(),
                    source: format!("plugin:{}", p.id),
                });
            }
        }
    }
    {
        let mut memories = ctx.memories.lock().unwrap();
        memories.retain(|m| !m.source.starts_with("plugin:"));
        for p in plugins.iter().filter(|p| is_on(p)) {
            for content in &p.memories {
                memories.push(crate::memory::Memory {
                    id: String::new(),
                    ts: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                    kind: "raw".into(),
                    content: content.clone(),
                    source: format!("plugin:{}", p.id),
                });
            }
        }
    }
    // 持久化 skills/memories（统一走 bit.db，复用 memory::persist——原直写 JSON 文件与启动加载源分裂）
    crate::memory::persist(ctx);

    // 更新内存里的插件列表
    {
        let mut cur = ctx.plugins.lock().unwrap();
        *cur = plugins;
    }
    // 托管服务对账：清单 services[] 同步进 WorkWith（只登记/改配置/清残留，不自动拉起）
    sync_declared_services(ctx);
    // 外部连接对账：清单里删了这条、插件停用、net 位关掉 → MCP 条目与导入的工具当场收回
    crate::netconn::prune(ctx);
    // 文件类型注册表：图标与解析归属跟着这次扫描一起换（停用/关权限的插件当场让位）
    crate::filekinds::refresh(ctx);
    // 服务器对账：清单里已没有 server 的残留进程收掉（启动是用户明示动作，这里不擅自拉起）
    reconcile_stop_orphans(ctx);
    // 插件包被删掉后，旧 id 的异常灯也该熄灭
    prune_health(ctx);
    // 成功也留痕：出问题时可区分"没扫到目录/没插件"与"解析失败"（此前排查靠它定位 id 字段缺失 bug）
    let total_tools: usize = ctx.tools.lock().unwrap().iter().filter(|t| t.created_by.starts_with("plugin:")).count();
    crate::trace::event(
        "plugins",
        &format!(
            "sync: {} plugin(s), {} plugin tool(s), {} memory(ies), {} skill(s), {} err(s)",
            ctx.plugins.lock().unwrap().len(),
            total_tools,
            ctx.memories.lock().unwrap().iter().filter(|m| m.source.starts_with("plugin:")).count(),
            ctx.skills.lock().unwrap().iter().filter(|s| s.source.starts_with("plugin:")).count(),
            errs.len()
        ),
    );
    if !errs.is_empty() {
        crate::trace::event("plugins", &format!("scan errors: {}", errs.join("; ")));
    }
}

/// 启用插件注入的提示词片段（禁用/篡改插件不注入）。供 ai.rs 组装系统提示词时调用。
pub fn prompt_fragment(ctx: &Arc<crate::state::Ctx>) -> String {
    let plugins = ctx.plugins.lock().unwrap();
    let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };
    let enabled: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
    let tampered = tampered_ids(ctx, &enabled);
    let mut out = String::new();
    for p in enabled.into_iter().filter(|p| !tampered.contains(&p.id)) {
        for text in &p.prompts {
            if !text.trim().is_empty() {
                out.push_str(&format!("### Plugin `{}`\n{}\n", p.name, text.trim()));
            }
        }
    }
    if out.is_empty() {
        String::new()
    } else {
        format!("\n## Plugin instructions\n{out}")
    }
}

// ---------- 前端 UI 资源导出（供渲染进程插件加载器读取）----------

/// 导出启用且通过安全校验的插件 UI 资源（css/js 源文本）。
/// 只导出 permissions 里声明了对应权限位的内容；路径统一过 safe_rel 闸门。
/// 返回 [{ id, name, version, permissions, css: [{path, text}], js: [{path, text}] }]
pub fn ui_bundle(ctx: &Arc<crate::state::Ctx>) -> Vec<serde_json::Value> {
    let (plugins, _) = scan(ctx);
    let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };
    let enabled: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
    let tampered = tampered_ids(ctx, &enabled);
    let mut out = Vec::new();
    for p in enabled.into_iter().filter(|p| !tampered.contains(&p.id)) {
        let Some(ui) = &p.ui else { continue };
        let pdir = dir(ctx).join(&p.id);
        // 只导出用户仍放行的权限位：关掉 js/css 后资源不再下发，渲染层自然无从执行
        let perms = effective_perms(ctx, p);
        let read = |paths: &[String]| -> Vec<serde_json::Value> {
            let mut v = Vec::new();
            for f in paths {
                if safe_rel(f).is_err() {
                    continue;
                }
                if let Ok(text) = fs::read_to_string(pdir.join(f)) {
                    // 单文件 512KB 上限：防清单指个巨型文件把渲染层拖死
                    if text.len() <= 512 * 1024 {
                        v.push(serde_json::json!({ "path": f, "text": text }));
                    }
                }
            }
            v
        };
        let css = if perms.iter().any(|x| x == "css") { read(&ui.css) } else { Vec::new() };
        let js = if perms.iter().any(|x| x == "js") { read(&ui.js) } else { Vec::new() };
        if css.is_empty() && js.is_empty() {
            continue;
        }
        out.push(serde_json::json!({
            "id": p.id,
            "name": p.name,
            "version": p.version,
            "permissions": perms,
            "css": css,
            "js": js,
        }));
    }
    out
}

// ---------- 插件自带服务器（进程托管 / 端口 / 令牌）----------
// 令牌一枚通吃两条通道：服务器进程的 BIT_PLUGIN_TOKEN（HTTP Bearer）与页面帧的
// #bit_token=（postMessage），同一插件在同一应用会话内是同一个值。收回只发生在
// 停用与安全校验失败时——单纯停进程不动令牌，否则同一插件的静态页会跟着失声。

/// 服务器在 workwith 进程注册表里的键。前缀 plugin: 同时决定事件名与审计动作走插件口径，
/// 且不会被联动页列出（联动页只枚举持久化条目）。
pub fn server_key(id: &str) -> String {
    format!("plugin:{id}")
}

/// 插件托管服务在 WorkWith 里的条目前缀 / 固定 id。
/// 分隔符用 `-`：sanitize 只留字母数字和下划线，不会出现 `psvc-a-` 同时匹配 a 和 a_b。
/// 前缀本身单列一份：WorkWith 的退出监控要靠它认出「这条进程属于某个插件」。
pub const SERVICE_ID_MARK: &str = "psvc-";

pub fn service_prefix(plugin_id: &str) -> String {
    format!("{}{}-", SERVICE_ID_MARK, sanitize(plugin_id))
}

pub fn service_id(plugin_id: &str, name: &str) -> String {
    format!("{}{}", service_prefix(plugin_id), sanitize(name))
}

/// 运行期端口表：插件 id → 实际监听端口（拼接独立页面地址用；停止时移除）
fn ports() -> &'static std::sync::Mutex<HashMap<String, u16>> {
    static P: std::sync::OnceLock<std::sync::Mutex<HashMap<String, u16>>> = std::sync::OnceLock::new();
    P.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub fn server_port(id: &str) -> Option<u16> {
    ports().lock().unwrap().get(id).copied()
}

/// 分配空闲端口：bind :0 后立刻释放，把端口号交给插件进程去 bind。
/// 释放与插件 bind 之间有毫秒级窗口，理论上可被其它进程抢占——表现为端口探测超时，
/// 用户重启服务器即可（重绑已占端口没有更安全的答案，只能换端口）
pub(crate) fn alloc_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("分配端口失败: {e}"))?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    drop(l);
    Ok(port)
}

/// 启用且通过安全校验的插件列表（服务器/页面两条链路共用同一套判定）
pub fn enabled_plugins(ctx: &Arc<crate::state::Ctx>) -> Vec<Plugin> {
    let (plugins, _) = scan(ctx);
    let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };
    let enabled: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
    let tampered = tampered_ids(ctx, &enabled);
    enabled.into_iter().filter(|p| !tampered.contains(&p.id)).cloned().collect()
}

/// 启动插件服务器：解析清单 → 分配端口与令牌 → 交给 workwith 引擎托管 → 端口就绪探测
pub async fn start_server(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<serde_json::Value, String> {
    let key = server_key(id);
    if let Some((pid, _)) = crate::workwith::status_of(&key) {
        return Ok(serde_json::json!({ "id": id, "pid": pid, "status": "running", "already": true }));
    }
    let p = enabled_plugins(ctx).into_iter().find(|p| p.id == id).ok_or("插件未启用或安全校验未通过")?;
    // 逐权限开关关掉 server 后，即使清单还声明着也不许再拉起进程
    if !has_grant(ctx, &p, "server") {
        return Err("服务器权限已被单独关闭：在最下方「权限与安全」里重新打开后再启动".into());
    }
    let sv = p.server.clone().ok_or("该插件未声明 server")?;
    let pdir = dir(ctx).join(&id);
    let port = if sv.port > 0 { sv.port } else { alloc_port()? };
    let token = crate::plugin_api::token_for(id);
    let api_base = crate::plugin_api::base_url_ready(1500).await;
    let mut env = HashMap::from([
        ("BIT_PLUGIN_ID".to_string(), id.to_string()),
        ("BIT_PLUGIN_PORT".to_string(), port.to_string()),
        ("BIT_PLUGIN_TOKEN".to_string(), token),
        ("BIT_PLUGIN_API".to_string(), api_base),
        ("BIT_PLUGIN_DIR".to_string(), pdir.to_string_lossy().to_string()),
        // 生效权限一起给：进程自己就知道哪些能力可用（用户单独关掉的不会出现）
        ("BIT_PLUGIN_PERMS".to_string(), effective_perms(ctx, &p).join(",")),
    ]);
    // 让进程能 require("bit") / import bit / import bit（python）
    crate::plugin_sdk::apply_env(ctx, &mut env);
    let e = crate::workwith::WorkWithEntry {
        id: key.clone(),
        name: p.name.clone(),
        runtime_id: sv.runtime.trim().to_string(),
        program: pdir.join(&sv.program).to_string_lossy().to_string(),
        args: sv.args.clone(),
        cwd: pdir.to_string_lossy().to_string(),
        env,
        port,
        // 插件服务器一律按 http 口径托管（引擎调用传 mcp_link=false，此处只是把字段写实）
        mcp_mode: String::new(),
        auto_with_session: false,
        declared: false,
    };
    // mcp_link=false：插件服务器是页面/接口服务，不是 MCP 服务器，不做握手
    let r = match crate::workwith::start_entry(ctx, &e, false).await {
        Ok(v) => v,
        Err(err) => {
            // 拉起失败（运行环境缺失、程序不存在、spawn 报错）：页眉异常灯要能看见
            mark_unhealthy(ctx, id, &p.name, "start-failed", &err);
            return Err(err);
        }
    };
    // 进程已拉起：先撤掉上一次的异常；端口迟迟没就绪会在 wait_ready 里重新登记
    mark_healthy(ctx, id);
    ports().lock().unwrap().insert(id.to_string(), port);
    let pid = r.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
    crate::audit::record(
        ctx,
        "local-app",
        "plugin.server.listen",
        &format!("{id}"),
        serde_json::json!({ "pid": pid, "port": port, "runtime": e.runtime_id }),
        true,
    );
    let c2 = ctx.clone();
    let name = p.name.clone();
    let id2 = id.to_string();
    crate::task::spawn(async move { wait_ready(c2, id2, name, port).await });
    Ok(serde_json::json!({ "id": id, "pid": pid, "port": port, "status": "starting" }))
}

/// 端口就绪探测：只报状态，不接入 MCP（就绪事件里带上页面地址，前端据此开页）
async fn wait_ready(ctx: Arc<crate::state::Ctx>, id: String, name: String, port: u16) {
    // 等待预算与 WorkWith 同一口径（设置 svc_ready_secs），且同样按墙上时间算：
    // 按次数循环会被单次 connect 的阻塞拖长，设置里的秒数就成了幌子
    let secs = crate::workwith::tuning(&ctx).ready_secs;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(secs as u64);
    loop {
        // 进程中途退出 → 探测终止（退出事件由 workwith 监控发出，不重复报）
        if !crate::workwith::is_running(&server_key(&id)) {
            return;
        }
        if crate::workwith::probe_port(("127.0.0.1", port)).await {
            // 端口通了才算真正启动成功：此前登记的异常（上次崩溃/启动失败）就此解除
            mark_healthy(&ctx, &id);
            crate::workwith::note_steady(&server_key(&id));
            ctx.emit(
                "plugin-server",
                serde_json::json!({ "phase": "ready", "id": id, "name": name, "port": port }),
            );
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    mark_unhealthy(&ctx, &id, &name, "port-timeout", &format!("端口 {port} 在 {secs} 秒内未就绪"));
    ctx.emit("plugin-server", serde_json::json!({ "phase": "port-timeout", "id": id, "port": port, "wait_secs": secs }));
}

/// 停止插件服务器（幂等：未在运行也清理端口记录）
/// 不收回令牌：同一插件的静态页还在用它跟宿主说话，收回要等插件被停用（见 toggle_plugin）
pub async fn stop_server(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<serde_json::Value, String> {
    let key = server_key(id);
    let out = if crate::workwith::is_running(&key) {
        crate::workwith::stop(ctx, &key).await?
    } else {
        serde_json::json!({ "id": id, "status": "stopped" })
    };
    ports().lock().unwrap().remove(id);
    // 主动停止（或停用/收回权限时收进程）是用户明示动作，不算异常
    mark_healthy(ctx, id);
    Ok(out)
}

// ---------- 插件运行健康度（页眉异常灯）----------
// 只登记需要用户留意的运行异常：进程崩溃、启动失败、端口迟迟未就绪。
// 只存在内存里：进程随主程序结束，重启后由新的启动结果重新判定；
// 主动停止或启动成功即清除，不打扰正常使用。

fn health() -> &'static std::sync::Mutex<HashMap<String, serde_json::Value>> {
    static H: std::sync::OnceLock<std::sync::Mutex<HashMap<String, serde_json::Value>>> =
        std::sync::OnceLock::new();
    H.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 登记异常并广播：渲染层不用轮询，页眉灯跟着事件亮/灭
pub fn mark_unhealthy(ctx: &Arc<crate::state::Ctx>, id: &str, name: &str, phase: &str, message: &str) {
    let entry = serde_json::json!({
        "id": id, "name": name, "phase": phase, "message": message, "at": now_ms(),
    });
    health().lock().unwrap().insert(id.to_string(), entry.clone());
    crate::trace::event("plugins", &format!("health {id}: {phase} — {message}"));
    ctx.emit("plugin-health", entry);
}

/// 清除异常并广播；没有登记过就什么都不做（避免无意义的事件风暴）
pub fn mark_healthy(ctx: &Arc<crate::state::Ctx>, id: &str) {
    if health().lock().unwrap().remove(id).is_some() {
        ctx.emit("plugin-health", serde_json::json!({ "id": id, "phase": "ok" }));
    }
}

pub fn health_of(id: &str) -> Option<serde_json::Value> {
    health().lock().unwrap().get(id).cloned()
}

/// 当前全部异常（最新在前）；页眉挂载时一次性取回，之后靠 plugin-health 事件增量更新
pub fn health_snapshot() -> Vec<serde_json::Value> {
    let mut v: Vec<serde_json::Value> = health().lock().unwrap().values().cloned().collect();
    v.sort_by_key(|e| std::cmp::Reverse(e["at"].as_u64().unwrap_or(0)));
    v
}

/// 插件包被删掉/改名后，旧 id 的异常不再有意义：随重扫清掉
fn prune_health(ctx: &Arc<crate::state::Ctx>) {
    let ids: Vec<String> = ctx.plugins.lock().unwrap().iter().map(|p| p.id.clone()).collect();
    let stale: Vec<String> = health()
        .lock()
        .unwrap()
        .keys()
        .filter(|k| !ids.contains(k))
        .cloned()
        .collect();
    for id in stale {
        mark_healthy(ctx, &id);
    }
}

/// 插件服务器状态（进程态 + 端口 + 页面地址）
pub fn server_status(id: &str) -> serde_json::Value {
    let key = server_key(id);
    let (running, pid, uptime_ms) = match crate::workwith::status_of(&key) {
        Some((pid, up)) => (true, pid, up),
        None => (false, 0u32, 0u64),
    };
    let port = if running { server_port(id) } else { None };
    serde_json::json!({
        "running": running, "pid": pid, "uptime_ms": uptime_ms,
        "port": port, "url": port.map(|p| format!("http://127.0.0.1:{p}")),
    })
}

/// 退出前停掉全部插件服务器进程（插件服务器是用户显式启用的常驻进程，
/// 随主程序一起退出不留孤儿；workwith 持久化条目沿用各自的既有清理链路）
pub async fn stop_all_servers(ctx: &Arc<crate::state::Ctx>) {
    for key in crate::workwith::running_ids_with_prefix("plugin:") {
        let id = key.trim_start_matches("plugin:");
        let _ = stop_server(ctx, id).await;
    }
}

/// 运行环境探测在后台进行：未就绪先等，否则第一次拉起必然"找不到运行环境"
async fn wait_runtime(ctx: &Arc<crate::state::Ctx>, runtime: &str) {
    let rt = runtime.trim();
    for _ in 0..40 {
        let have = ctx.runtimes.lock().unwrap().iter().any(|r| r.id == rt || rt == "custom");
        if have {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// 组装清单声明服务的 WorkWith 条目：相对路径以插件目录为基准，
/// 端口在已有条目里复用（每次重扫都换端口会让上一轮进程与页面地址对不上）。
fn declared_service_entry(
    ctx: &Arc<crate::state::Ctx>,
    p: &Plugin,
    sv: &PluginService,
    old: Option<&crate::workwith::WorkWithEntry>,
) -> Result<crate::workwith::WorkWithEntry, String> {
    let pdir = dir(ctx).join(&p.id);
    let prog = sv.program.trim();
    let pp = std::path::Path::new(prog);
    let program_abs = if pp.is_absolute() { pp.to_path_buf() } else { pdir.join(pp) };
    let cwd = sv.cwd.trim();
    let cwd_abs = if cwd.is_empty() {
        pdir.clone()
    } else {
        let cp = std::path::Path::new(cwd);
        if cp.is_absolute() { cp.to_path_buf() } else { pdir.join(cp) }
    };
    let mode = sv.mcp_mode.trim().to_lowercase();
    let allocated = old
        .and_then(|e| e.env.get("BIT_PLUGIN_PORT"))
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| if sv.port > 0 { sv.port } else { alloc_port().unwrap_or(0) });
    if allocated == 0 {
        return Err(format!("service `{}`: 分配端口失败", sv.name));
    }
    // 端口只作为监听信息展示；mcp_mode=http 才让 WorkWith 在端口就绪后接入 MCP。
    // 普通 HTTP 服务即使没声明端口也拿到 BIT_PLUGIN_PORT，但不会走 MCP 握手。
    let entry_port = if sv.port > 0 || mode == "http" { allocated } else { 0 };
    let mut env = sv.env.clone();
    // 宿主注入的键覆盖清单同名项：插件不能伪造自己的 id / 令牌 / 生效权限
    env.insert("BIT_PLUGIN_ID".into(), p.id.clone());
    env.insert("BIT_PLUGIN_SERVICE".into(), sv.name.clone());
    env.insert("BIT_PLUGIN_PORT".into(), allocated.to_string());
    env.insert("BIT_PLUGIN_TOKEN".into(), crate::plugin_api::token_for(&p.id));
    env.insert("BIT_PLUGIN_API".into(), crate::plugin_api::base_url());
    env.insert("BIT_PLUGIN_DIR".into(), pdir.to_string_lossy().to_string());
    env.insert("BIT_PLUGIN_PERMS".into(), effective_perms(ctx, p).join(","));
    // SDK 搜索路径：服务进程里 require("bit") / import bit / python 的 import bit 都能落地
    crate::plugin_sdk::apply_env(ctx, &mut env);
    let label = if sv.label.trim().is_empty() { sv.name.trim() } else { sv.label.trim() };
    Ok(crate::workwith::WorkWithEntry {
        id: service_id(&p.id, &sv.name),
        name: format!("{} · {}", p.name, label),
        runtime_id: sv.runtime.trim().to_string(),
        program: program_abs.to_string_lossy().to_string(),
        args: sv.args.clone(),
        cwd: cwd_abs.to_string_lossy().to_string(),
        env,
        port: entry_port,
        mcp_mode: mode,
        auto_with_session: false,
        declared: true,
    })
}

/// 清单服务的持久化对账：启用的插件按当前清单覆盖声明式条目，
/// 清单里删掉的服务收掉进程并从 WorkWith 移除；运行中的条目保留原配置（改了也等下次重启）。
fn sync_declared_services(ctx: &Arc<crate::state::Ctx>) {
    let existing = crate::workwith::load_entries(ctx);
    let mut desired: Vec<crate::workwith::WorkWithEntry> = Vec::new();
    for p in enabled_plugins(ctx) {
        if !has_grant(ctx, &p, "workwith") {
            continue;
        }
        for sv in &p.services {
            let id = service_id(&p.id, &sv.name);
            let old = existing.iter().find(|e| e.id == id);
            match declared_service_entry(ctx, &p, sv, old) {
                Ok(e) => desired.push(e),
                Err(err) => {
                    crate::trace::event("plugins", &format!("service {} sync failed: {err}", sv.name));
                    // 组装失败（程序被删等）保留旧条目，交给下次启动报错，不静默丢配置
                    if let Some(e) = old {
                        desired.push(e.clone());
                    }
                }
            }
        }
    }
    let mut out: Vec<crate::workwith::WorkWithEntry> = Vec::new();
    for e in &existing {
        if !e.declared {
            out.push(e.clone());
            continue;
        }
        if !desired.iter().any(|d| d.id == e.id) {
            crate::workwith::kill_id(&e.id);
            continue;
        }
        if crate::workwith::is_running(&e.id) {
            out.push(e.clone());
        } else if let Some(ne) = desired.iter().find(|d| d.id == e.id) {
            out.push(ne.clone());
        } else {
            out.push(e.clone());
        }
    }
    for ne in desired {
        if !out.iter().any(|e| e.id == ne.id) {
            out.push(ne);
        }
    }
    if crate::workwith::replace_entries(ctx, &out) {
        ctx.emit("workwith", serde_json::json!({ "phase": "sync" }));
    }
}

/// 启动清单里的一条服务（插件页/脚本都可显式调用；auto_start 之外不擅自拉起）
pub async fn start_service(
    ctx: &Arc<crate::state::Ctx>,
    plugin_id: &str,
    name: &str,
) -> Result<serde_json::Value, String> {
    let p = enabled_plugins(ctx)
        .into_iter()
        .find(|p| p.id == plugin_id)
        .ok_or("插件未启用或安全校验未通过")?;
    if !has_grant(ctx, &p, "workwith") {
        return Err("托管服务权限已被单独关闭：在插件详情里重新打开后再启动".into());
    }
    let want = sanitize(name);
    let sv = p
        .services
        .iter()
        .find(|s| s.name == name || sanitize(&s.name) == want)
        .ok_or_else(|| format!("插件未声明服务 {name}"))?;
    let id = service_id(&p.id, &sv.name);
    if crate::workwith::is_running(&id) {
        return Ok(serde_json::json!({ "id": id, "status": "running", "already": true }));
    }
    let old = crate::workwith::load_entries(ctx).into_iter().find(|e| e.id == id);
    let mut e = declared_service_entry(ctx, &p, sv, old.as_ref())?;
    // 启动前刷新令牌与 API 基址：启动早期 sync 时插件 API 服务可能还没绑定端口
    e.env.insert("BIT_PLUGIN_API".into(), crate::plugin_api::base_url_ready(1500).await);
    e.env.insert("BIT_PLUGIN_TOKEN".into(), crate::plugin_api::token_for(&p.id));
    e.env.insert("BIT_PLUGIN_PERMS".into(), effective_perms(ctx, &p).join(","));
    crate::plugin_sdk::apply_env(ctx, &mut e.env);
    let v = serde_json::to_value(&e).map_err(|err| err.to_string())?;
    crate::workwith::save(ctx, v)?;
    crate::workwith::start(ctx, &id).await
}

/// 启用即拉起：一个插件的 server 与 services 里声明了 auto_start 且未在跑的进程，
/// 外加 connections 里 auto_connect 且设置齐了的外部 MCP
pub async fn auto_start_plugin(ctx: &Arc<crate::state::Ctx>, id: &str) {
    let Some(p) = enabled_plugins(ctx).into_iter().find(|p| p.id == id) else { return };
    if has_grant(ctx, &p, "server") {
        if let Some(sv) = p.server.clone().filter(|s| s.auto_start) {
            if !crate::workwith::is_running(&server_key(&p.id)) {
                wait_runtime(ctx, &sv.runtime).await;
                if let Err(e) = start_server(ctx, &p.id).await {
                    crate::trace::event("plugins", &format!("auto-start {0} failed: {e}", p.id));
                }
            }
        }
    }
    if has_grant(ctx, &p, "workwith") {
        for sv in p.services.iter().filter(|s| s.auto_start) {
            let sid = service_id(&p.id, &sv.name);
            if crate::workwith::is_running(&sid) {
                continue;
            }
            wait_runtime(ctx, &sv.runtime).await;
            if let Err(e) = start_service(ctx, &p.id, &sv.name).await {
                crate::trace::event("plugins", &format!("auto-start service {0} failed: {e}", sv.name));
            }
        }
    }
    // 外部连接不需要本机进程，权限位判在 netconn 内部（net 关掉即整组跳过）
    crate::netconn::auto_connect_plugin(ctx, &p.id).await;
}

/// 启用即拉起 / 应用启动恢复：清单里 auto_start 且未在跑的服务器与服务
pub async fn auto_start_servers(ctx: &Arc<crate::state::Ctx>) {
    for p in enabled_plugins(ctx) {
        auto_start_plugin(ctx, &p.id).await;
    }
}

/// 对账收尾：把"插件已停用/篡改/清单里删掉了 server"的残留进程收掉。
/// 只做停止不做启动——启动是用户明示动作（启用开关 / 应用启动），否则用户在插件页
/// 手动停止后，一次普通重扫就会把它偷偷拉回来。
fn reconcile_stop_orphans(ctx: &Arc<crate::state::Ctx>) {
    let c2 = ctx.clone();
    crate::task::spawn(async move {
        let running: Vec<String> = crate::workwith::running_ids_with_prefix("plugin:")
            .into_iter()
            .map(|k| k.trim_start_matches("plugin:").to_string())
            .collect();
        let declared: Vec<String> = enabled_plugins(&c2)
            .iter()
            .filter(|p| p.server.is_some() && has_grant(&c2, p, "server"))
            .map(|p| p.id.clone())
            .collect();
        for id in running {
            if !declared.contains(&id) {
                let _ = stop_server(&c2, &id).await;
            }
        }
    });
}

// ---------- 插件独立页面导出（渲染层 iframe 用）----------

/// 拼 iframe 地址并附上本插件的通讯令牌。
/// 静态页的令牌同时写进查询参数（服务端要校验后才发 HTML，防止扫端口直接抓走注入脚本）
/// 和片段（SDK 兼容旧路径）；动态页只给片段，不发给插件服务器。
/// 返回 (kind, frame)；动态页服务器没跑时 frame 为空。
fn page_frame(p: &Plugin, pg: &PluginPage) -> (&'static str, String) {
    let token = crate::plugin_api::token_for(&p.id);
    if let Some(src) = pg.src.as_deref().filter(|s| !s.trim().is_empty()) {
        let rel = src.trim_start_matches("./");
        let sep = if rel.contains('?') { "&" } else { "?" };
        (
            "static",
            format!(
                "{}/p/{}/{}{}bit_token={}#bit_token={}",
                crate::plugin_api::base_url(),
                p.id,
                rel,
                sep,
                token,
                token
            ),
        )
    } else {
        let path = pg.url.as_deref().unwrap_or("/");
        match server_port(&p.id) {
            Some(port) => ("server", format!("http://127.0.0.1:{port}{path}#bit_token={token}")),
            None => ("server", String::new()),
        }
    }
}

/// 一条页面帧的导出记录（导航页 / 设置页 / 状态面板共用同一套字段）。
/// 静态页由插件 API 服务托管文件（相对资源可用，HTML 自动注入 SDK）；
/// 动态页指向插件服务器端口，服务器未在跑时 frame 为空，由前端提示"先启动服务器"。
fn page_json(ctx: &Arc<crate::state::Ctx>, p: &Plugin, pg: &PluginPage, key: String) -> serde_json::Value {
    let (kind, frame) = page_frame(p, pg);
    serde_json::json!({
        "key": key,
        "plugin_id": p.id,
        "plugin_name": p.name,
        "id": pg.id,
        "label": pg.label,
        "kind": kind,
        "src": pg.src,
        "url": pg.url,
        "paths": pg.paths,
        "frame": frame,
        "token": crate::plugin_api::token_for(&p.id),
        // 帧内桥按生效权限放行：用户关掉的能力在页面里也调不动
        "permissions": effective_perms(ctx, p),
    })
}

/// 导出启用插件声明的导航页面：
/// [{ key, plugin_id, plugin_name, id, label, kind: static|server, src, url,
///    frame, token, permissions }]
pub fn pages_bundle(ctx: &Arc<crate::state::Ctx>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for p in enabled_plugins(ctx) {
        // 逐权限开关：关掉 page 后不再注册导航入口（已打开的帧随下一次重放摘除）
        if !has_grant(ctx, &p, "page") {
            continue;
        }
        for pg in &p.pages {
            out.push(page_json(ctx, &p, pg, format!("{}:{}", p.id, pg.id)));
        }
    }
    out
}

/// 导出启用插件声明的状态面板（插件页右侧详情用，不注册左栏入口）：
/// 与导航页同一套帧字段，key 固定为 "<插件id>:status"
pub fn status_bundle(ctx: &Arc<crate::state::Ctx>) -> Vec<serde_json::Value> {
    enabled_plugins(ctx)
        .into_iter()
        .filter(|p| has_grant(ctx, p, "page"))
        .filter_map(|p| p.status_page.as_ref().map(|pg| page_json(ctx, &p, pg, format!("{}:status", p.id))))
        .collect()
}

/// 设置中心的插件注入清单（渲染层 SettingsPage 用）：
/// [{ plugin_id, plugin_name, permissions,
///    entries: [{ key, id, label, description, kw }],
///    page: { key, id, label, kind, frame, token } | null }]
/// 条目只是入口，点开统一展示该插件的设置页；没声明 page 时前端退回键值面板，
/// 键值仍然走 settings 能力（Bit.settings），由宿主存在插件命名空间里。
pub fn settings_bundle(ctx: &Arc<crate::state::Ctx>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for p in enabled_plugins(ctx) {
        let Some(st) = &p.settings else { continue };
        if st.entries.is_empty() && st.page.is_none() {
            continue;
        }
        // 逐权限开关：关掉 settings 后设置中心不再注入条目与独立设置页
        if !has_grant(ctx, &p, "settings") {
            continue;
        }
        let page = st
            .page
            .as_ref()
            .map(|pg| page_json(ctx, &p, pg, format!("{}:settings:{}", p.id, pg.id)));
        let entries: Vec<serde_json::Value> = st
            .entries
            .iter()
            .map(|en| {
                serde_json::json!({
                    // 卡片 key 带插件前缀：不同插件的 "sync" 不会在设置中心撞车
                    "key": format!("{}:{}", p.id, en.id),
                    "id": en.id,
                    "label": en.label,
                    "description": en.description,
                    "kw": en.kw,
                })
            })
            .collect();
        out.push(serde_json::json!({
            "plugin_id": p.id,
            "plugin_name": p.name,
            "permissions": effective_perms(ctx, &p),
            "entries": entries,
            "page": page,
        }));
    }
    out
}

/// 插件设置页里托管文件的读取上限由静态路由把关；这里只给渲染层一条提示用的小工具
pub fn settings_declared(p: &Plugin) -> bool {
    p.settings.as_ref().map(|s| !s.entries.is_empty() || s.page.is_some()).unwrap_or(false)
}

/// 对话页图标清单（渲染层 ChatPage 用）：
/// [{ key, plugin_id, plugin_name, id, label, label_en, paths, action, page_key, text }]
/// key 带插件前缀（"<插件id>:<图标id>"），与设置卡片、页面 key 同一套命名，
/// 用户的拖拽存档因此能区分不同插件的同名图标。未申报 chaticon 权限的插件在这里直接
/// 跳过——校验阶段已经拦下一道，这里是第二道闸（清单改了尚未重扫也漏不出去）。
pub fn chat_icons_bundle(ctx: &Arc<crate::state::Ctx>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for p in enabled_plugins(ctx) {
        if !has_grant(ctx, &p, "chaticon") {
            continue;
        }
        for ic in &p.chat_icons {
            out.push(serde_json::json!({
                "key": format!("{}:{}", p.id, ic.id),
                "plugin_id": p.id,
                "plugin_name": p.name,
                "id": ic.id,
                "label": ic.label,
                "label_en": ic.label_en,
                "paths": ic.paths,
                "action": if ic.action.is_empty() { "page" } else { ic.action.as_str() },
                "page_key": ic.page_key,
                "text": ic.text,
            }));
        }
    }
    out
}

/// 生效中的文件类型登记（注册表与界面清单共用的唯一出处）：
/// 启用 + 未篡改 + `files` 权限位仍被用户放行，三者缺一即不出现。
/// 工具 id 与工具表同一套命名（`plugin::<插件id>::<sanitize(工具名)>`），
/// 解析时直接拿去 `registry::invoke`。
pub fn file_kinds_active(ctx: &Arc<crate::state::Ctx>) -> Vec<crate::filekinds::ActiveKind> {
    let mut out = Vec::new();
    for p in enabled_plugins(ctx) {
        if !has_grant(ctx, &p, "files") {
            continue;
        }
        for fk in &p.file_kinds {
            out.push(crate::filekinds::ActiveKind {
                key: format!("{}:{}", p.id, fk.id),
                plugin_id: p.id.clone(),
                plugin_name: p.name.clone(),
                label: fk.label.clone(),
                label_en: fk.label_en.clone(),
                exts: fk.exts.clone(),
                paths: fk.paths.clone(),
                tool_id: declared_tool_id(&p, &fk.tool),
            });
        }
    }
    out
}

/// 解析工具 → 宿主侧工具 id。工具表里找不到同名条目就返回 None（只登记图标）；
/// 停用或被拒的插件走不到这里（enabled_plugins 已经过滤过）。
fn declared_tool_id(p: &Plugin, tool: &str) -> Option<String> {
    let t = tool.trim();
    if t.is_empty() {
        return None;
    }
    p.tools
        .iter()
        .find(|x| x.name.trim() == t)
        .map(|x| format!("plugin::{}::{}", p.id, sanitize(&x.name)))
}

/// 生效中的接管清单（渲染层对话页与设置中心恢复面板共用）：
/// [{ slot, plugin_id, plugin_name, effective }]
/// 同一槽位被多个插件声明时按插件 id 字典序取第一个生效，其余标记 effective=false：
/// 结果可复现，插件扫描顺序不影响谁赢；恢复面板也能把冲突如实列给用户。
pub fn takeovers_bundle(ctx: &Arc<crate::state::Ctx>) -> Vec<serde_json::Value> {
    let mut plugins = enabled_plugins(ctx);
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    let mut owners: HashMap<String, String> = HashMap::new();
    let mut out = Vec::new();
    for p in plugins {
        if !has_grant(ctx, &p, "takeover") {
            continue;
        }
        let denied = denied_takeovers(ctx, &p.id);
        for raw in &p.takeover {
            let slot = raw.trim();
            if !takeover_slot_known(slot) {
                continue;
            }
            // 被用户撤回的槽位仍列出来（denied=true）：设置页要能把它重新交给插件，
            // 否则"恢复内置"就是一条单向操作。它不参与抢占，槽位顺延给后面的插件。
            let is_denied = denied.iter().any(|x| x == slot);
            let effective = !is_denied && !owners.contains_key(slot);
            if !is_denied {
                owners.entry(slot.to_string()).or_insert_with(|| p.id.clone());
            }
            out.push(serde_json::json!({
                "slot": slot,
                "plugin_id": p.id,
                "plugin_name": p.name,
                "effective": effective,
                "denied": is_denied,
            }));
        }
    }
    out
}

/// 可接管槽位目录（前端不再抄一份；英文名供英文界面用）
pub fn takeover_slots_bundle() -> Vec<serde_json::Value> {
    TAKEOVER_SLOTS
        .iter()
        .map(|(id, label, label_en)| serde_json::json!({ "id": id, "label": label, "label_en": label_en }))
        .collect()
}


/// 任务上次执行时间（bit.db documents "plugin_jobs"）：key = "<插件id>/<job名>"
/// 历史遗留：曾存 toolhomes/plugins/_jobs.json，启动时一次性迁移入库
type JobState = HashMap<String, String>;

fn jobs_legacy_path(ctx: &Arc<crate::state::Ctx>) -> PathBuf {
    dir(ctx).join("_jobs.json")
}

fn load_job_state(ctx: &Arc<crate::state::Ctx>) -> JobState {
    {
        let db = ctx.db.lock().unwrap();
        if let Some(st) = crate::store::get_json::<JobState>(&db, "plugin_jobs") {
            return st;
        }
    } // db 锁先释放
      // 一次性迁移遗留 _jobs.json（db 无该文档时）：导入后改名 .migrated 留档
    let p = jobs_legacy_path(ctx);
    if let Ok(raw) = fs::read_to_string(&p) {
        if let Ok(st) = serde_json::from_str::<JobState>(&raw) {
            {
                let db = ctx.db.lock().unwrap();
                crate::store::put_json(&db, "plugin_jobs", &st);
            }
            let _ = fs::rename(&p, p.with_extension("json.migrated"));
            return st;
        }
    }
    JobState::default()
}

fn save_job_state(ctx: &Arc<crate::state::Ctx>, st: &JobState) {
    let db = ctx.db.lock().unwrap();
    crate::store::put_json(&db, "plugin_jobs", st);
}

/// 解析 "every Ns/m/h" 与 "daily HH:MM"。
/// pub：待办计划（goal::schedule_task_set / schedule_todos_loop）复用同一文法与到点判定。
pub enum Sched {
    Every(std::time::Duration),
    Daily(u32, u32),
}

pub fn parse_schedule(s: &str) -> Option<Sched> {
    let s = s.trim().to_lowercase();
    if let Some(rest) = s.strip_prefix("every ") {
        let rest = rest.trim();
        let (num, unit) = rest.split_at(rest.len().saturating_sub(1));
        let n: u64 = num.trim().parse().ok()?;
        let secs = match unit {
            "s" => n,
            "m" => n * 60,
            "h" => n * 3600,
            _ => return None,
        };
        if secs == 0 {
            return None;
        }
        return Some(Sched::Every(std::time::Duration::from_secs(secs)));
    }
    if let Some(rest) = s.strip_prefix("daily ") {
        let parts: Vec<&str> = rest.trim().split(':').collect();
        if parts.len() == 2 {
            let h: u32 = parts[0].trim().parse().ok()?;
            let m: u32 = parts[1].trim().parse().ok()?;
            if h < 24 && m < 60 {
                return Some(Sched::Daily(h, m));
            }
        }
    }
    None
}

pub fn is_due(sched: &Sched, last: Option<&String>) -> bool {
    match sched {
        Sched::Every(d) => match last.and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()) {
            Some(t) => {
                let elapsed = chrono::Local::now().naive_local() - t;
                elapsed.to_std().map(|e| e >= *d).unwrap_or(true)
            }
            None => true,
        },
        Sched::Daily(h, m) => {
            let now = chrono::Local::now();
            // 今天没跑过 && 已到点（当天任意时刻错过则补跑一次）
            let ran_today = last
                .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
                .map(|t| t.date() == now.date_naive())
                .unwrap_or(false);
            !ran_today && (now.hour() > *h || (now.hour() == *h && now.minute() >= *m))
        }
    }
}

/// 执行一个插件任务：跑代码 → 审计 → 指定了 session 就复用后台 shell 唤回链路注入会话
async fn run_job(ctx: Arc<crate::state::Ctx>, pid: String, job: PluginJob) {
    let pdir = dir(&ctx).join(&pid);
    let Some(code) = resolve_code(&pdir, &job.file, &job.code) else {
        crate::audit::record(&ctx, "host", "plugin.job", &format!("{pid}/{}", job.name), serde_json::json!({ "error": "no code" }), false);
        return;
    };
    let runtime = if job.runtime.trim().is_empty() { "py".to_string() } else { job.runtime.trim().to_string() };
    let timeout = {
        let cfg = ctx.config.lock().unwrap();
        std::time::Duration::from_secs(cfg.tool_timeout_secs.clamp(1, 600) as u64)
    };
    let ctx2 = ctx.clone();
    let rt = runtime.clone();
    let code2 = code.clone();
    // 任务进程同样带本插件身份：脚本里 require("bit") / import bit 可回连能力
    let extra_env = crate::plugin_sdk::plugin_env(&ctx, &pid);
    let handle = crate::task::spawn_blocking(move || {
        crate::script_runtime::run_env(&ctx2, &rt, &code2, &serde_json::json!({}), timeout, &extra_env)
    });
    let out = tokio::time::timeout(std::time::Duration::from_secs(600), handle).await;
    let (ok, stdout, stderr) = match out {
        Ok(Ok(Ok(v))) => (true, serde_json::to_string_pretty(&v).unwrap_or_default(), String::new()),
        Ok(Ok(Err(e))) => (false, String::new(), e),
        Ok(Err(e)) => (false, String::new(), format!("task failed: {e}")),
        Err(_) => (false, String::new(), "job timed out (600s)".into()),
    };
    crate::audit::record(
        &ctx,
        "host",
        "plugin.job",
        &format!("{pid}/{}", job.name),
        serde_json::json!({ "ok": ok, "runtime": runtime }),
        ok,
    );
    // 有目标会话 → 结果作为后台任务产物唤回该会话的 AI（复用 shellbg 链路）
    if let Some(sid) = job.session.clone().filter(|s| !s.trim().is_empty()) {
        crate::shellbg::notify_session_result(
            &sid,
            &format!("plugin:{pid}/{}", job.name),
            &format!("定时任务 {}（插件 {pid}）", job.name),
            if ok { 0 } else { 1 },
            stdout,
            stderr,
            if ok { "done" } else { "timeout" },
        );
    }
}

/// 插件定时任务调度循环：每 30 秒检查一次到期任务。
/// 全程静默失败：单个任务出错不影响调度循环与其他插件。
pub async fn scheduler(ctx: Arc<crate::state::Ctx>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let plugins = ctx.plugins.lock().unwrap().clone();
        if plugins.is_empty() {
            continue;
        }
        let disabled: Vec<String> = { ctx.config.lock().unwrap().disabled_plugins.clone() };
        // 防篡改：篡改插件的定时任务不执行（校验顺便给新启用插件补录基线）
        let enabled: Vec<&Plugin> = plugins.iter().filter(|p| !disabled.contains(&p.id)).collect();
        let tampered = tampered_ids(&ctx, &enabled);
        let mut state = load_job_state(&ctx);
        let mut dirty = false;
        for p in enabled.into_iter().filter(|p| !tampered.contains(&p.id)) {
            for job in &p.jobs {
                let key = format!("{}/{}", p.id, job.name);
                let Some(sched) = parse_schedule(&job.schedule) else {
                    continue;
                };
                if !is_due(&sched, state.get(&key)) {
                    continue;
                }
                // 记录执行时间（先写后跑：同间隔长任务不会在每 tick 重复触发）
                state.insert(key, chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
                dirty = true;
                let jc = ctx.clone();
                let j = job.clone();
                let pid = p.id.clone();
                crate::task::spawn(async move { run_job(jc, pid, j).await });
            }
        }
        if dirty {
            save_job_state(&ctx, &state);
        }
    }
}

/// 测试专用：临时数据目录里的 Ctx（进程 id + 时间戳，避免上次残留的库污染断言）
#[cfg(test)]
pub(crate) fn test_ctx(tag: &str) -> Arc<crate::state::Ctx> {
    let dir = std::env::temp_dir().join(format!(
        "bit-plugin-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    crate::state::Ctx::load(crate::state::LoadOpts {
        data_dir: dir,
        emitter: Arc::new(crate::emitter::NoopEmitter),
        host: Arc::new(crate::emitter::NoopHost),
        app_version: "test".into(),
        worker_exe: None,
        app_exe: None,
        app_args: vec![],
    })
}

/// 测试专用：在插件目录里放一个包（清单 + 声明用到的静态文件），返回插件目录
#[cfg(test)]
pub(crate) fn write_test_plugin(
    ctx: &Arc<crate::state::Ctx>,
    id: &str,
    manifest: serde_json::Value,
    files: &[&str],
) -> PathBuf {
    let d = dir(ctx).join(id);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("plugin.json"), manifest.to_string()).unwrap();
    for f in files {
        let p = d.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "<html></html>").unwrap();
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_schedule_works() {
        assert!(matches!(parse_schedule("every 30m"), Some(Sched::Every(d)) if d.as_secs() == 1800));
        assert!(matches!(parse_schedule("every 2h"), Some(Sched::Every(d)) if d.as_secs() == 7200));
        assert!(matches!(parse_schedule("daily 09:00"), Some(Sched::Daily(9, 0))));
        assert!(parse_schedule("weekly").is_none());
        assert!(parse_schedule("every 0m").is_none());
    }

    #[test]
    fn sanitize_keeps_model_friendly_names() {
        assert_eq!(sanitize("我的-工具 v1"), "______v1");
        assert_eq!(sanitize("mouse_move"), "mouse_move");
    }

    /// `all` 是"一次声明全部权限"的写法：清单级闸门（ui.css / ui.js / server / pages）
    /// 必须和运行时闸门一样认它，否则通配位声明了却处处被判"缺权限"。
    /// 套件里 biz-heavy-tools 就是踩到这个坑才发现的：只写 all 的插件整体加载失败。
    #[test]
    fn all_perm_satisfies_every_manifest_gate() {
        let ctx = test_ctx("all-perm-gates");
        write_test_plugin(
            &ctx,
            "wide",
            json!({
                "name": "通配位插件",
                "bridge": { "token": "required" },
                "permissions": ["all"],
                "ui": { "css": ["a.css"], "js": ["a.js"] },
                "server": { "runtime": "custom", "program": "s.js" },
                "pages": [{ "id": "p", "label": "页", "src": "w.html" }],
                "status_page": { "id": "st", "label": "状态", "src": "w.html" },
                "settings": { "entries": [{ "id": "e", "label": "条目" }] },
                "chat_icons": [{ "id": "i", "label": "图标", "paths": ["M4 6 H20"], "action": "prompt", "text": "问一句" }],
                "takeover": ["chat.voice"]
            }),
            &["a.css", "a.js", "s.js", "w.html"],
        );
        let (list, errs) = scan(&ctx);
        assert!(errs.is_empty(), "只写 all 也应通过全部闸门：{errs:?}");
        assert_eq!(list.len(), 1);
        let p = &list[0];
        for perm in ["css", "js", "server", "page", "settings", "chaticon", "takeover"] {
            assert!(has_perm(p, perm), "all 应展开出 {perm}");
        }
        assert_eq!(p.permissions, vec!["all".to_string()], "清单原文保持诚实，展开只发生在判定侧");
    }

    /// 异常登记：登记后可查、清除后消失；页眉异常灯读的就是这份快照
    #[test]
    fn health_registry_marks_and_clears() {
        let ctx = test_ctx("health-registry");
        // 快照是全进程共享的：用独立 id，跑完清干净，别污染并行测试
        let id = "health-registry-demo";
        mark_unhealthy(&ctx, id, "健康演示", "crashed", "进程意外退出（退出码 1）");
        let me = health_snapshot()
            .into_iter()
            .find(|e| e["id"] == id)
            .expect("异常应出现在快照里");
        assert_eq!(me["phase"], "crashed");
        assert_eq!(me["name"], "健康演示");
        assert!(health_of(id).is_some());
        mark_healthy(&ctx, id);
        assert!(health_of(id).is_none());
        assert!(health_snapshot().iter().all(|e| e["id"] != id));
    }

    #[test]
    fn safe_rel_blocks_traversal_and_absolute() {
        assert!(safe_rel("page/index.html").is_ok());
        assert!(safe_rel("./index.html").is_ok());
        assert!(safe_rel("../outside.html").is_err());
        assert!(safe_rel("a/../../b.html").is_err());
        assert!(safe_rel("C:/Windows/system32/cmd.exe").is_err());
    }

    /// services[] 必须申报 workwith；程序/工作目录缺失、同名冲突都在扫描阶段拒载
    #[test]
    fn service_manifest_is_validated() {
        let ctx = test_ctx("service-validate");
        write_test_plugin(
            &ctx,
            "no-perm",
            json!({
                "name": "没申报",
                "permissions": [],
                "services": [{ "name": "tick", "runtime": "custom", "program": "svc.js" }]
            }),
            &["svc.js"],
        );
        let (list, errs) = scan(&ctx);
        assert!(list.is_empty());
        assert!(
            errs.iter().any(|e| e.contains("services declared but missing permission")),
            "错误里应点明缺 workwith：{errs:?}"
        );

        write_test_plugin(
            &ctx,
            "bad-program",
            json!({
                "name": "程序缺失",
                "permissions": ["workwith"],
                "services": [{ "name": "tick", "runtime": "custom", "program": "missing.js" }]
            }),
            &[],
        );
        let (list, errs) = scan(&ctx);
        assert!(list.is_empty());
        assert!(errs.iter().any(|e| e.contains("program not found")), "{errs:?}");

        write_test_plugin(
            &ctx,
            "dup-service",
            json!({
                "name": "重名",
                "permissions": ["workwith"],
                "services": [
                    { "name": "a-b", "runtime": "custom", "program": "svc.js" },
                    { "name": "a_b", "runtime": "custom", "program": "svc.js" }
                ]
            }),
            &["svc.js"],
        );
        let (list, errs) = scan(&ctx);
        assert!(list.is_empty());
        assert!(errs.iter().any(|e| e.contains("service name duplicated")), "{errs:?}");
    }

    /// 清单服务的同步：固定 id 落进 WorkWith，宿主注入环境；删掉声明后条目随之撤下
    #[tokio::test]
    async fn declared_services_sync_into_workwith_and_are_removed() {
        let ctx = test_ctx("service-sync");
        write_test_plugin(
            &ctx,
            "svc-demo",
            json!({
                "name": "服务演示",
                "permissions": ["workwith"],
                "services": [{
                    "name": "tick", "label": "心跳", "runtime": "custom",
                    "program": "svc.js", "args": ["--x"], "cwd": "svc",
                    "env": { "MODE": "local", "BIT_PLUGIN_TOKEN": "forged" },
                    "mcp_mode": "stdio", "auto_start": false
                }]
            }),
            &["svc.js", "svc/keep.txt"],
        );
        sync(&ctx);
        let entries = crate::workwith::load_entries(&ctx);
        let e = entries
            .iter()
            .find(|e| e.id == service_id("svc-demo", "tick"))
            .expect("声明服务应出现在 WorkWith 里");
        assert!(e.declared, "应标记为清单声明");
        assert_eq!(e.name, "服务演示 · 心跳");
        assert_eq!(e.runtime_id, "custom");
        assert!(e.cwd.ends_with("svc"));
        assert_eq!(e.env.get("MODE").map(String::as_str), Some("local"));
        assert_ne!(e.env.get("BIT_PLUGIN_TOKEN").map(String::as_str), Some("forged"), "宿主注入必须覆盖清单伪造项");
        assert_eq!(e.env.get("BIT_PLUGIN_ID").map(String::as_str), Some("svc-demo"));
        assert!(e.env.contains_key("BIT_PLUGIN_PORT"));
        assert_eq!(e.port, 0, "stdio 不按端口联动");

        // 清单删掉服务 → 下次同步撤下条目
        write_test_plugin(
            &ctx,
            "svc-demo",
            json!({ "name": "服务演示", "permissions": ["workwith"], "services": [] }),
            &[],
        );
        sync(&ctx);
        assert!(
            crate::workwith::load_entries(&ctx).iter().all(|e| e.id != service_id("svc-demo", "tick")),
            "声明已删除，条目应随对账撤下"
        );
    }

    /// 绝对程序路径在清单里同样可用（由清单明示，运行期仍受 workwith 权限把关）
    #[test]
    fn service_program_may_be_absolute() {
        let ctx = test_ctx("service-abs");
        let exe = std::env::current_exe().unwrap().to_string_lossy().to_string();
        write_test_plugin(
            &ctx,
            "abs-demo",
            json!({
                "name": "绝对路径",
                "permissions": ["workwith"],
                "services": [{ "name": "self", "runtime": "custom", "program": exe }]
            }),
            &[],
        );
        let (list, errs) = scan(&ctx);
        assert!(errs.is_empty(), "{errs:?}");
        assert_eq!(list.len(), 1);
    }

    /// 声明了设置中心注入却没申请 settings 权限：整体不加载（scan 报错）
    #[test]
    fn settings_injection_requires_the_settings_permission() {
        let ctx = test_ctx("perm-coupling");
        write_test_plugin(
            &ctx,
            "silent-inject",
            json!({
                "name": "偷偷注入",
                "permissions": [],
                "settings": { "entries": [{ "id": "sync", "label": "同步" }] }
            }),
            &[],
        );
        let (list, errs) = scan(&ctx);
        assert!(list.is_empty(), "不该加载：{:?}", list.iter().map(|p| p.id.clone()).collect::<Vec<_>>());
        assert!(
            errs.iter().any(|e| e.contains("settings declared but missing permission")),
            "错误里应点明缺权限：{errs:?}"
        );
        // 申报后即放行，且不再产生错误
        write_test_plugin(
            &ctx,
            "open-inject",
            json!({
                "name": "明示注入",
                "permissions": ["settings"],
                "settings": { "entries": [{ "id": "sync", "label": "同步" }] }
            }),
            &[],
        );
        let (list, errs2) = scan(&ctx);
        let ids = list.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
        assert!(ids.contains(&"open-inject".to_string()), "{ids:?}");
        assert!(!errs2.iter().any(|e| e.starts_with("open-inject")), "{errs2:?}");
    }

    /// 条目 id：非空、不重复；设置页的静态文件必须真的存在
    #[test]
    fn settings_entries_and_page_are_validated() {
        let ctx = test_ctx("entry-rules");
        write_test_plugin(
            &ctx,
            "dup",
            json!({
                "name": "重名条目",
                "permissions": ["settings"],
                "settings": { "entries": [{ "id": "sync", "label": "同步" }, { "id": "sync", "label": "同步2" }] }
            }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "blank",
            json!({
                "name": "空标题",
                "permissions": ["settings"],
                "settings": { "entries": [{ "id": "x", "label": "  " }] }
            }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "nopath",
            json!({
                "name": "页面文件不存在",
                "permissions": ["settings", "page"],
                "bridge": { "token": "required" },
                "settings": { "page": { "id": "cfg", "label": "配置", "src": "settings.html" } }
            }),
            &[],
        );
        let (_, errs) = scan(&ctx);
        assert!(errs.iter().any(|e| e.contains("duplicated: sync")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("non-empty id and label")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("page src not found: settings.html")), "{errs:?}");
    }

    /// 注入 bundle：卡片 key 带插件前缀，独立设置页的帧地址带本插件令牌
    #[test]
    fn settings_bundle_carries_scoped_keys_and_token() {
        let ctx = test_ctx("bundle");
        write_test_plugin(
            &ctx,
            "injector",
            json!({
                "name": "注入者",
                "version": "1.0",
                "permissions": ["settings", "page"],
                "bridge": { "token": "required" },
                "settings": {
                    "entries": [{ "id": "sync", "label": "同步", "description": "多久同步一次", "kw": "sync" }],
                    "page": { "id": "cfg", "label": "配置页", "src": "cfg.html" }
                }
            }),
            &["cfg.html"],
        );
        write_test_plugin(&ctx, "plain", json!({ "name": "没有设置项" }), &[]);
        let bundle = settings_bundle(&ctx);
        assert_eq!(bundle.len(), 1, "只有申报了 settings 的插件进 bundle：{bundle:?}");
        let me = &bundle[0];
        assert_eq!(me["plugin_id"], "injector");
        assert_eq!(me["entries"][0]["key"], "injector:sync");
        assert_eq!(me["page"]["key"], "injector:settings:cfg");
        let token = crate::plugin_api::token_for("injector");
        assert_eq!(me["page"]["token"], token.as_str());
        let frame = me["page"]["frame"].as_str().unwrap();
        // 静态页服务端要校验查询参数里的令牌，片段保留给页面 SDK 兼容旧路径
        assert!(frame.contains(&format!("?bit_token={token}#bit_token={token}")), "{frame}");
        assert!(!frame.contains("??"), "查询串不能出现双问号：{frame}");
        assert_eq!(me["page"]["kind"], "static");
    }

    /// 逐权限开关：关掉某个权限位后，对应运行时导出立即消失；重新打开即恢复。
    /// 清单本身不动，所以插件不会被判篡改。
    #[test]
    fn denied_permissions_are_removed_from_runtime_bundles() {
        let ctx = test_ctx("perm-switch");
        write_test_plugin(
            &ctx,
            "mixed",
            json!({
                "name": "混合能力",
                "permissions": ["css", "js", "page", "settings", "chaticon"],
                "bridge": { "token": "required" },
                "ui": { "css": ["ui.css"], "js": ["ui.js"] },
                "status_page": { "id": "status", "label": "状态", "src": "status.html" },
                "settings": { "entries": [{ "id": "cfg", "label": "配置" }] },
                "chat_icons": [{ "id": "go", "label": "去", "paths": ["M4 4h16"] }]
            }),
            &["ui.css", "ui.js", "status.html"],
        );
        assert_eq!(ui_bundle(&ctx).len(), 1);
        assert_eq!(settings_bundle(&ctx).len(), 1);
        assert_eq!(status_bundle(&ctx).len(), 1);
        assert_eq!(chat_icons_bundle(&ctx).len(), 1);

        ctx.config.lock().unwrap().plugin_denied_perms.insert("mixed".into(), vec!["settings".into(), "chaticon".into()]);
        assert_eq!(ui_bundle(&ctx)[0]["permissions"], json!(["css", "js", "page"]), "生效权限要扣除用户关闭项");
        assert!(settings_bundle(&ctx).is_empty(), "关掉 settings 后设置中心不再注入");
        assert!(chat_icons_bundle(&ctx).is_empty(), "关掉 chaticon 后图标排不再出现");
        assert_eq!(status_bundle(&ctx).len(), 1, "page 仍开着，状态面板继续下发");

        ctx.config.lock().unwrap().plugin_denied_perms.insert("mixed".into(), vec!["js".into(), "page".into()]);
        let ui = &ui_bundle(&ctx)[0];
        assert_eq!(ui["js"], json!([]), "关掉 js 后脚本源码不再下发");
        assert_eq!(ui["css"].as_array().unwrap().len(), 1);
        assert!(status_bundle(&ctx).is_empty(), "关掉 page 后状态面板也收回");
    }

    /// 状态面板：需 page 权限与 bridge 令牌契约，不注册成左栏导航页，
    /// bundle 帧地址带本插件令牌；src 不存在或动态页没 server 都拒载。
    #[test]
    fn status_page_is_validated_and_bundled_separately() {
        let ctx = test_ctx("status-page");
        write_test_plugin(
            &ctx,
            "no-perm",
            json!({
                "name": "没申请权限",
                "bridge": { "token": "required" },
                "status_page": { "id": "status", "label": "状态", "src": "status.html" }
            }),
            &["status.html"],
        );
        write_test_plugin(
            &ctx,
            "no-bridge",
            json!({
                "name": "没声明令牌",
                "permissions": ["page"],
                "status_page": { "id": "status", "label": "状态", "src": "status.html" }
            }),
            &["status.html"],
        );
        write_test_plugin(
            &ctx,
            "bad-src",
            json!({
                "name": "文件不存在",
                "permissions": ["page"],
                "bridge": { "token": "required" },
                "status_page": { "id": "status", "label": "状态", "src": "missing.html" }
            }),
            &[],
        );
        let (list, errs) = scan(&ctx);
        assert!(list.iter().all(|p| !["no-perm", "no-bridge", "bad-src"].contains(&p.id.as_str())), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("status_page declared but missing permission")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("no-bridge") && e.contains("bridge")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("page src not found: missing.html")), "{errs:?}");

        let ok = test_ctx("status-ok");
        write_test_plugin(
            &ok,
            "live",
            json!({
                "name": "状态面板",
                "permissions": ["page"],
                "bridge": { "token": "required" },
                "status_page": { "id": "status", "label": "运行状态", "src": "web/status.html" }
            }),
            &["web/status.html"],
        );
        let (list, errs) = scan(&ok);
        assert!(list.iter().any(|p| p.id == "live"), "{errs:?}");
        assert!(pages_bundle(&ok).is_empty(), "状态面板不该注册成左栏导航页");
        let bundle = status_bundle(&ok);
        assert_eq!(bundle.len(), 1, "{bundle:?}");
        assert_eq!(bundle[0]["key"], "live:status");
        assert_eq!(bundle[0]["label"], "运行状态");
        let token = crate::plugin_api::token_for("live");
        let frame = bundle[0]["frame"].as_str().unwrap();
        assert!(frame.contains(&format!("bit_token={token}")), "{frame}");
    }

    /// 桥接面必须在配置文件里声明令牌契约：页面 / 服务器 / 设置页缺这一节就整体拒载；
    /// 纯工具插件没有对外接口，不强制。
    #[test]
    fn bridge_surfaces_require_the_token_declaration() {
        let ctx = test_ctx("bridge-decl");
        let page = json!([{ "id": "main", "label": "主页", "src": "index.html" }]);
        write_test_plugin(
            &ctx,
            "no-decl",
            json!({ "name": "没声明", "permissions": ["page"], "pages": page.clone() }),
            &["index.html"],
        );
        write_test_plugin(
            &ctx,
            "declared",
            json!({
                "name": "声明了",
                "permissions": ["page"],
                "bridge": { "token": "required" },
                "pages": page
            }),
            &["index.html"],
        );
        write_test_plugin(
            &ctx,
            "server-no-decl",
            json!({
                "name": "服务器没声明",
                "permissions": ["server"],
                "server": { "runtime": "node", "program": "server.js" }
            }),
            &["server.js"],
        );
        write_test_plugin(&ctx, "tool-only", json!({ "name": "纯工具", "tools": [] }), &[]);

        let (list, errs) = scan(&ctx);
        let ids = list.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
        assert!(ids.contains(&"declared".to_string()), "{ids:?}");
        assert!(ids.contains(&"tool-only".to_string()), "纯工具不该被令牌声明拦住：{ids:?}");
        assert!(!ids.contains(&"no-decl".to_string()), "页面缺声明必须拒载：{ids:?}");
        assert!(!ids.contains(&"server-no-decl".to_string()), "服务器缺声明必须拒载：{ids:?}");
        assert!(
            errs.iter().any(|e| e.contains("no-decl") && e.contains("bridge")),
            "错误要点明补 bridge 声明：{errs:?}"
        );
    }

    /// 令牌契约为 "off"/空 之类 = 想关掉鉴权，直接拒载（不是返回警告）
    #[test]
    fn bridge_token_cannot_be_disabled() {
        let ctx = test_ctx("bridge-off");
        write_test_plugin(
            &ctx,
            "weak",
            json!({
                "name": "想裸奔",
                "permissions": ["page"],
                "bridge": { "token": "off" },
                "pages": [{ "id": "main", "label": "主页", "src": "index.html" }]
            }),
            &["index.html"],
        );
        let (list, errs) = scan(&ctx);
        assert!(list.is_empty(), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("bridge.token must be")), "{errs:?}");
    }

    /// 对话页图标：没申请 chaticon 就声明 = 整体不加载；申报后放行且 bundle 带前缀 key
    #[test]
    fn chat_icons_require_the_chaticon_permission() {
        let icon = json!({ "id": "kanban", "label": "看板", "paths": ["M4 6h16", "M4 12h10"] });
        let ctx = test_ctx("chaticon-perm");
        write_test_plugin(
            &ctx,
            "sneaky-icon",
            json!({ "name": "偷偷放图标", "permissions": [], "chat_icons": [icon.clone()] }),
            &[],
        );
        let (list, errs) = scan(&ctx);
        assert!(list.is_empty(), "缺权限不该加载：{errs:?}");
        assert!(
            errs.iter().any(|e| e.contains("chat_icons declared but missing permission")),
            "错误里应点明缺权限：{errs:?}"
        );
        write_test_plugin(
            &ctx,
            "open-icon",
            json!({ "name": "明示图标", "permissions": ["chaticon"], "chat_icons": [icon] }),
            &[],
        );
        let (list, errs2) = scan(&ctx);
        let ids = list.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
        assert!(ids.contains(&"open-icon".to_string()), "{ids:?} / {errs2:?}");
        let bundle = chat_icons_bundle(&ctx);
        assert_eq!(bundle.len(), 1, "只有申报权限的插件进 bundle：{bundle:?}");
        assert_eq!(bundle[0]["key"], "open-icon:kanban");
        assert_eq!(bundle[0]["plugin_id"], "open-icon");
        // action 缺省补成 page，前端不用再判空
        assert_eq!(bundle[0]["action"], "page");
        assert_eq!(bundle[0]["paths"].as_array().unwrap().len(), 2);
    }

    /// 接管：缺 takeover 权限、未知槽位、设置槽位、重复槽位都整体拒载；
    /// 合法声明进 bundle，槽位目录同时下发。
    #[test]
    fn takeover_declarations_are_validated() {
        let ctx = test_ctx("takeover-validate");
        write_test_plugin(
            &ctx,
            "no-perm",
            json!({ "name": "没申请权限", "permissions": [], "takeover": ["chat.voice"] }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "unknown",
            json!({ "name": "未知槽位", "permissions": ["takeover"], "takeover": ["chat.unknown"] }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "settings",
            json!({ "name": "想接管设置", "permissions": ["takeover"], "takeover": ["settings"] }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "dup",
            json!({ "name": "重复槽位", "permissions": ["takeover"], "takeover": ["chat.voice", "chat.voice"] }),
            &[],
        );
        let (list, errs) = scan(&ctx);
        assert!(list.is_empty(), "不该加载任何非法插件：{:?}", list.iter().map(|p| p.id.clone()).collect::<Vec<_>>());
        assert!(errs.iter().any(|e| e.contains("takeover declared but missing permission")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("unknown takeover slot `chat.unknown`")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("settings must stay reachable")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("takeover slot duplicated: chat.voice")), "{errs:?}");

        write_test_plugin(
            &ctx,
            "ok",
            json!({
                "name": "合法接管",
                "permissions": ["takeover"],
                "takeover": ["chat.voice", "chat.preview"]
            }),
            &[],
        );
        let (list, errs2) = scan(&ctx);
        assert!(list.iter().any(|p| p.id == "ok"), "{errs2:?}");
        let bundle = takeovers_bundle(&ctx);
        assert_eq!(bundle.len(), 2, "数量不限，但每个槽位各一条：{bundle:?}");
        assert!(bundle.iter().all(|c| c["plugin_id"] == "ok" && c["effective"] == true));
        assert_eq!(takeover_slots_bundle().len(), TAKEOVER_SLOTS.len());
    }

    /// 冲突按插件 id 字典序取第一个生效；用户撤回某个槽位后顺延给下一个插件；
    /// 关掉 takeover 权限整包不再参与接管。
    #[test]
    fn takeover_conflicts_are_deterministic_and_revocable() {
        let ctx = test_ctx("takeover-conflict");
        write_test_plugin(
            &ctx,
            "z-voice",
            json!({ "name": "Z 语音", "permissions": ["takeover"], "takeover": ["chat.voice"] }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "a-voice",
            json!({ "name": "A 语音", "permissions": ["takeover"], "takeover": ["chat.voice"] }),
            &[],
        );
        let bundle = takeovers_bundle(&ctx);
        assert_eq!(bundle.len(), 2, "两个声明都列出来，冲突才对用户透明：{bundle:?}");
        let a = bundle.iter().find(|c| c["plugin_id"] == "a-voice").unwrap();
        let z = bundle.iter().find(|c| c["plugin_id"] == "z-voice").unwrap();
        assert_eq!(a["effective"], true, "字典序靠前的插件生效");
        assert_eq!(z["effective"], false);

        // 逐槽位撤回 A：内置恢复，顺延给 Z
        ctx.config
            .lock()
            .unwrap()
            .plugin_denied_takeovers
            .insert("a-voice".into(), vec!["chat.voice".into()]);
        let bundle = takeovers_bundle(&ctx);
        assert_eq!(bundle.len(), 2, "撤回的声明仍要列出（denied），设置页才能重新交给插件：{bundle:?}");
        let a = bundle.iter().find(|c| c["plugin_id"] == "a-voice").unwrap();
        assert_eq!(a["effective"], false);
        assert_eq!(a["denied"], true);
        let z = bundle.iter().find(|c| c["plugin_id"] == "z-voice").unwrap();
        assert_eq!(z["effective"], true, "撤回 A 后槽位顺延给 Z");

        // 关掉 takeover 权限 = 整包退出接管
        ctx.config
            .lock()
            .unwrap()
            .plugin_denied_perms
            .insert("z-voice".into(), vec!["takeover".into()]);
        assert!(
            takeovers_bundle(&ctx).iter().all(|c| c["effective"] == false),
            "关掉权限后不再有生效中的接管（A 的已撤回声明仅作恢复入口保留）"
        );
    }

    /// 页面字形：可选声明；合法路径进 bundle，夹带标记或超过 8 条整包拒载
    #[test]
    fn page_icons_are_optional_but_validated_when_declared() {
        let ctx = test_ctx("page-icon-ok");
        write_test_plugin(
            &ctx,
            "page-icons",
            json!({
                "name": "字形页",
                "permissions": ["page"],
                "bridge": { "token": "required" },
                "pages": [
                    { "id": "board", "label": "看板", "src": "board.html", "paths": ["M4 5h16v14H4z", "M9 9h6"] },
                    { "id": "plain", "label": "无字形", "src": "plain.html" }
                ]
            }),
            &["board.html", "plain.html"],
        );
        let (list, errs) = scan(&ctx);
        assert!(list.iter().any(|p| p.id == "page-icons"), "{errs:?}");
        let bundle = pages_bundle(&ctx);
        let board = bundle.iter().find(|v| v["id"] == "board").expect("看板页应在 bundle 里");
        assert_eq!(board["paths"].as_array().unwrap().len(), 2);
        let plain = bundle.iter().find(|v| v["id"] == "plain").expect("无字形页也应在 bundle 里");
        assert_eq!(plain["paths"].as_array().unwrap().len(), 0);

        let bad = test_ctx("page-icon-bad");
        write_test_plugin(
            &bad,
            "bad-page-icon",
            json!({
                "name": "坏字形",
                "permissions": ["page"],
                "bridge": { "token": "required" },
                "pages": [{ "id": "x", "label": "X", "src": "x.html", "paths": ["M4 6h16\"><script>"] }]
            }),
            &["x.html"],
        );
        write_test_plugin(
            &bad,
            "many-page-icon",
            json!({
                "name": "字形太多",
                "permissions": ["page"],
                "bridge": { "token": "required" },
                "pages": [{ "id": "y", "label": "Y", "src": "y.html", "paths": [
                    "M1 1h1", "M2 2h1", "M3 3h1", "M4 4h1", "M5 5h1",
                    "M6 6h1", "M7 7h1", "M8 8h1", "M9 9h1"
                ] }]
            }),
            &["y.html"],
        );
        let (list, errs) = scan(&bad);
        assert!(list.iter().all(|p| p.id != "bad-page-icon" && p.id != "many-page-icon"), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("page icon `x`: bad path data")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("page icon `y`: 1-8 paths required")), "{errs:?}");
    }

    /// 图标声明本身的底线：路径只能是纯 path 数据（夹带标记就拒），数量与动作受限
    #[test]
    fn chat_icon_declarations_are_validated() {
        let ctx = test_ctx("chaticon-rules");
        write_test_plugin(
            &ctx,
            "xss",
            json!({
                "name": "路径里塞标记",
                "permissions": ["chaticon"],
                "chat_icons": [{ "id": "a", "label": "A", "paths": ["M4 6h16\"><script>alert(1)</script>"] }]
            }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "empty-paths",
            json!({
                "name": "没有路径",
                "permissions": ["chaticon"],
                "chat_icons": [{ "id": "b", "label": "B", "paths": [] }]
            }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "bad-action",
            json!({
                "name": "未知动作",
                "permissions": ["chaticon"],
                "chat_icons": [{ "id": "c", "label": "C", "paths": ["M4 6h16"], "action": "invoke" }]
            }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "prompt-no-text",
            json!({
                "name": "填词却没给词",
                "permissions": ["chaticon"],
                "chat_icons": [{ "id": "d", "label": "D", "paths": ["M4 6h16"], "action": "prompt" }]
            }),
            &[],
        );
        write_test_plugin(
            &ctx,
            "too-many",
            json!({
                "name": "图标太多",
                "permissions": ["chaticon"],
                "chat_icons": [
                    { "id": "1", "label": "一", "paths": ["M4 6h16"] },
                    { "id": "2", "label": "二", "paths": ["M4 6h16"] },
                    { "id": "3", "label": "三", "paths": ["M4 6h16"] },
                    { "id": "4", "label": "四", "paths": ["M4 6h16"] },
                    { "id": "5", "label": "五", "paths": ["M4 6h16"] }
                ]
            }),
            &[],
        );
        let (list, errs) = scan(&ctx);
        assert!(errs.iter().any(|e| e.contains("bad path data")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("requires paths or icon")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("unknown action `invoke`")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("action=prompt requires text")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("too many chat_icons")), "{errs:?}");
        assert!(list.is_empty(), "五个都该被拦下：{:?}", list.iter().map(|p| p.id.clone()).collect::<Vec<_>>());
    }

    /// 清单语法糖：单数别名、一个对象当一条、权限写成逗号串、server 写成一行
    #[test]
    fn manifest_sugar_accepts_singular_and_string_forms() {
        let p: Plugin = serde_json::from_value(json!({
            "name": "糖",
            "permission": "page, data",
            "page": { "id": "m", "label": "主页", "src": "web/i.html" },
            "server": "node server.js",
            "interpreters": "node, python",
            "bridge": { "token": "required" },
        }))
        .unwrap();
        assert_eq!(p.permissions, vec!["page", "data"]);
        assert_eq!(p.pages.len(), 1);
        assert_eq!(p.pages[0].id, "m");
        assert_eq!(p.server.as_ref().unwrap().runtime, "node");
        assert_eq!(p.server.as_ref().unwrap().program, "server.js");
        assert_eq!(p.interpreters, vec!["node", "python"]);
        // 老写法（数组 + 对象）必须原样可用
        let old: Plugin = serde_json::from_value(json!({
            "name": "旧",
            "permissions": ["page", "data"],
            "pages": [{ "id": "m", "label": "主页", "src": "web/i.html" }],
            "server": { "runtime": "node", "program": "s.js" },
        }))
        .unwrap();
        assert_eq!(old.permissions.len(), 2);
        assert_eq!(old.server.as_ref().unwrap().program, "s.js");
    }

    /// preset 只做加法；未知 preset 与缺 exec 的 interpreters 都要当场报错
    #[test]
    fn preset_and_interpreters_are_applied_and_validated() {
        let mut p: Plugin =
            serde_json::from_value(json!({ "name": "x", "permissions": ["chat"], "preset": "PAGE" })).unwrap();
        apply_preset(&mut p);
        normalize_manifest(&mut p);
        assert!(p.permissions.contains(&"chat".to_string()), "手写声明不能被 preset 覆盖：{:?}", p.permissions);
        assert!(p.permissions.contains(&"page".to_string()));
        assert!(p.permissions.contains(&"notify".to_string()));
        assert_eq!(p.preset, "page", "preset 名统一小写");

        let mut bad: Plugin = serde_json::from_value(json!({ "name": "x", "preset": "magic" })).unwrap();
        apply_preset(&mut bad);
        let e = validate(&bad, &PathBuf::from(".")).unwrap_err();
        assert!(e.contains("unknown preset \"magic\"") && e.contains("page, ui"), "{e}");

        let mut gated: Plugin =
            serde_json::from_value(json!({ "name": "x", "interpreters": ["node"] })).unwrap();
        normalize_manifest(&mut gated);
        assert_eq!(
            validate(&gated, &PathBuf::from(".")).unwrap_err(),
            "interpreters declared but missing permission \"exec\""
        );
        // 申报了 exec 就通过这一关
        let mut ok: Plugin =
            serde_json::from_value(json!({ "name": "x", "permissions": ["exec"], "interpreters": "node" })).unwrap();
        normalize_manifest(&mut ok);
        assert!(validate(&ok, &PathBuf::from(".")).is_ok());
    }

    /// scan 是语法糖唯一的落地时刻：preset 展开、清洗、校验都发生在进列表之前
    #[test]
    fn scan_expands_sugar_before_validating() {
        let ctx = test_ctx("sugar-scan");
        write_test_plugin(
            &ctx,
            "sweet",
            json!({
                "name": "甜",
                "preset": "page",
                "bridge": { "token": "required" },
                "page": { "id": "m", "label": "主页", "src": "web/i.html" },
            }),
            &["web/i.html"],
        );
        let (list, errs) = scan(&ctx);
        assert!(errs.is_empty(), "{errs:?}");
        let p = list.iter().find(|x| x.id == "sweet").expect("该被扫出来");
        assert!(p.permissions.contains(&"page".to_string()));
        assert!(p.permissions.contains(&"notify".to_string()), "preset 应展开成整组权限：{:?}", p.permissions);
        assert_eq!(p.pages.len(), 1);
    }

    #[test]
    fn unknown_preset_is_reported_through_scan() {
        let ctx = test_ctx("sugar-bad");
        write_test_plugin(&ctx, "sour", json!({ "name": "酸", "preset": "magic" }), &[]);
        let (list, errs) = scan(&ctx);
        assert!(list.is_empty());
        assert!(errs.iter().any(|e| e.contains("unknown preset \"magic\"")), "{errs:?}");
    }
}
