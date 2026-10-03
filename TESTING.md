# BrainTentacle（路 BIT）测试说明

- 测试完成：是（2026-10-04）
- 测试日期：2026-10-04
- 测试内容：单元测试（bit-core 各模块：agent/ai 协议解析、http_api 鉴权、hidden_code 脱敏、securefile 加密、store 存储、guardian 等）；集成测试 `crates/bit-core/tests/security_integration.rs`（加密往返/篡改、HMAC、Plugin 清单、监听主机归一化、路径清洗，共 12 例）；注入测试 5（sandbox `../` 路径穿越 4 + `config::normalize_host` 拒绝路径穿越/命令注入 1）；钩子测试 7（plugins `resolve_code` 文件优先/回退/空值 3 + 清单缺 id/垃圾容错 4）。
- 运行命令：`cargo test -p bit-core --no-fail-fast`（全 workspace：`cargo test --workspace`）
- 测试框架：Rust `#[cfg(test)]` + 外部 `tests/` 集成测试
- 模型：豆包（Doubao）生成

BrainTentacle 是一个 Cargo **workspace**，三个成员：

- `crates/bit-core` — 框架无关核心库（agent 引擎 / 工具注册 / 存储与加密 / worker / TUI），同时带一个 `bit-cli` bin。
- `crates/bit-napi` — napi-rs cdylib（Electron 主进程加载）。
- `src-tauri` — Tauri 过渡壳。

本仓库的测试集中在 **`crates/bit-core`**：它是真正的 `lib` target（`bit_core`），因此既有各模块内 `#[cfg(test)]` 单元测试，也有根级 `tests/` 集成测试。

## 如何运行

在仓库根目录：

```powershell
# 只跑核心库（单元 + 集成）—— 日常使用
cargo test -p bit-core --no-fail-fast

# 跑整个 workspace 全部成员
cargo test --workspace --no-fail-fast
```

只跑某类：

```powershell
cargo test -p bit-core sandbox::        # 沙箱路径
cargo test -p bit-core plugins::       # 插件/钩子
cargo test -p bit-core securefile::    # 加密存储
cargo test -p bit-core security_integration   # tests/ 集成
```

首次编译会拉取并编译大量依赖（rusqlite bundled、axum、reqwest、calamine、rhai、scraper、jieba-rs、ratatui …），耗时约 1.5 分钟；之后增量约 30–60 秒。

> 无 GUI / musl 目标如需跳过本机操控与 TUI：`cargo test -p bit-core --no-default-features`（`desktop_ctl`/`tui-ui` 功能会退化为 stub）。

## 测了什么

- **协议解析**（`agent.rs`）：OpenAI/函数式/数组式工具调用解析、残缺 JSON 修复与截断、字符串内花括号不误判。
- **模型响应适配**（`ai.rs`）：OpenAI/Claude/Gemini/Responses API 多段文本、tool_call 载荷不泄露、瞬时网络错误分类、SSE 跨 chunk 切分。
- **HTTP API 鉴权**（`http_api.rs`）：bearer/query client key 接受与拒绝、未配置 client key 时拒绝全部、debug 端点双因子、health 旁路、worker IP 前缀语义。
- **MCP**（`mcp.rs`）：JSON/RPC/SSE body 解析、非 MCP server 拒绝、UTF-8 边界截断。
- **敏感信息脱敏**（`hidden_code.rs`）：手机号/邮箱/API key 正则探测与掩码、嵌套 JSON 深度还原、hash 前缀冲突升级。
- **安全/加密**（`securefile.rs` / `security.rs`）：BITENC1 加密往返、随机盐不泄露明文、MAC 篡改与错误密钥检测、明文/密文透明兼容、bitsign/bitcrypt 往返与篡改、HMAC 已知向量、nonce 重放/过期。
- **沙箱路径**（`sandbox.rs`）：`normalize` 消解 `.`/`..`，`../` 逃逸被拒，相互抵消的 `src/../src` 仍在根内。
- **插件/钩子**（`plugins.rs`）：`parse_schedule` 定时表达式、`sanitize` 命名、`resolve_code` 文件优先于内联 code、缺失 id 的 `plugin.json` 仍可解析、非法 JSON 被收集为错误而非 panic。
- **存储**（`store.rs`）：文档往返与重开、legacy JSON 导入幂等与备份、加密文档双层往返、篡改的密文文档返回 None 不 panic。
- **其它**：guardian 事件日志/签名轮换、session 预览与归一、update 受信 host 白名单与回滚、repetition 循环检测、shell `&` 检测、console_codec GBK/UTF-8 编码往返、l2pass/osprotect 防护解析。

## 集成测试（crates/bit-core/tests/security_integration.rs）

黑盒视角，仅用 `bit_core` 公共 API，共 12 个用例：

- **加密存储**：往返 + 随机盐不泄露明文、密文翻转一位被 `BadMac` 拒绝、错误密钥 `BadMac`、非密文 `NotEncrypted`、坏 base64 `BadBase64`。
- **加密 JSON 文件**：有 key 写密文/读回还原、无 key 写明文且标记 `was_legacy`、缺失文件返回 None 不 panic。
- **HMAC**：同 key 同消息稳定、不同 key 摘要不同、长度 32。
- **插件清单容错**：缺 `id` 的 manifest 仍可解析（`kind` 默认 `interpreter`、`jobs` 空）、非法 JSON 与数组形态被拒。
- **监听主机归一化**：`127.0.0.1/../../etc/passwd`、`evil.com; rm -rf /`、空串、纯空白均被拒；`[::1]` 剥括号、`localhost`/域名合法。
- **路径清洗**：去成对引号、展开 `~`。

## 注入测试（不可信输入）

- **路径穿越**（`sandbox.rs` 单元）：`../../../etc/passwd` 规范化后不以根为前缀 → 拒绝；`././a/./b.txt` 折叠；根目录本身合法。
- **监听主机注入**（`config::normalize_host`，集成）：含 `/`、`;`、空白的输入（路径穿越/命令注入特征）一律 `Err`。
- **XSS/明文密钥泄露**（`securefile.rs`）：密文不包含明文 `sk-...` 片段；MAC 校验拦截任何密文篡改。

注入测试数：**5**（sandbox 路径穿越单元 4 + normalize_host 注入拒绝集成 1）。

## 钩子测试（插件机制）

- **插件代码解析**（`plugins.rs` 单元）：`resolve_code` 文件优先于内联 code、文件缺失回退内联、空白/缺失内联返回 None（不注册空工具）。
- **清单容错**（`plugins.rs` 单元 + 集成）：缺 `id` 的 `plugin.json` 仍解析（sync 时用目录名覆盖）、非法 JSON 被 `scan` 收集为错误列表而非 panic。

钩子测试数：**7**（resolve_code/file/empty 3 + manifest 缺 id/垃圾拒绝 2 + 集成 manifest 2）。

> 说明：插件实际 `scan`/`sync` 需构造运行时 `Arc<Ctx>`（含 workspace_root/config/状态），属集成态，未在单元测试中拉起；此处覆盖其纯函数（代码解析、清单容错、定时/命名规范化）。

## 预期结果

`cargo test -p bit-core` 全绿：**lib 单元 233 + 集成 12 = 245 passed / 0 failed**（基线 lib 单元 224 + 本次新增单元 9 + 集成 12）。
