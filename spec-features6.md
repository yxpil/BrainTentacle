# 六功能批（用户已批准「全部都做」）

仓库：/tmp/bt-clone（Electron + bit-napi(dylib) + bit-core(Rust) 四层命令架构：bit-core commands_api.rs → bit-napi bridge.rs → src-tauri commands.rs+main.rs → 前端 src/api.js）
编译：`cargo build -p bit-napi --release && cp target/release/libbit_napi.dylib crates/bit-napi/bit_napi.node` + **codesign -f -s - 重签**（release dylib 签名会失效导致 SIGKILL）+ `npx vite build`。启动：`npx electron electron/main.cjs`（托管后台，不要 pkill 用户正在用的实例；bit.db 独占——e2e 前先停 Electron）。
i18n：src/i18n.js（zh+en 双份）。图标：src/components/Icons.jsx（描边风格统一）。

## F4 重新生成 / 编辑重发（纯聊天层，最先做）
- bit-core agent.rs：chat_turn 内部应有「写 user 消息→跑回合」两段；找出可复用的「只跑回合不写 user」切口。若无，在 engine/agent 加 `respond_only(ctx, session_id, ev)`。
- 新命令 `regenerate_last(session_id, event_name, edit_text: Option<String>)`：
  1. 锁 sessions：从尾删最后一条 assistant；找它前面的最后一条 user（无则报「没有可重发的消息」）；edit_text 非空则更新该 user content；persist
  2. 跑回合（流式，走 chat_stream 同款事件）返回 messages
- 前端 ChatPage：assistant 气泡按钮组（CopyBtn/SpeakBtn 旁，仅最后一条 assistant 显示重生成）+ 最后一条 user 气泡加「编辑」按钮（弹 textarea 改完走同命令）。i18n：chat.regenerate/regenerateTip/editResend/save/cancel。

## F5 提示词模板库
- store 键 `ai.promptTemplates`：[{id,title,text}]。新命令 `prompt_templates_get` / `prompt_templates_set(templates)`（四层接线照 compact_config 模式）。
- 设置页 AI 设置卡「提示词模板」：列表（title+textarea）增/删/改，保存按钮。
- ChatPage 输入框左工具栏加模板按钮（IconBookmark 之类）→ 小浮层列出 title，点击插入文本框。

## F1 免手对话模式
- 设置页语音唤醒卡加「免手对话」开关（localStorage bit.freehand，默认关；语音唤醒开启时才显示/生效）。
- ChatPage 状态机：KWS 命中→开麦→转写完成→若 freehand 开：自动 sendMessage(转写文本)→回复完成（busy 边沿，已有自动朗读 effect）→speakText 朗读→朗读结束或打断→恢复 KWS 监听。
- 关键：KWS 监听恢复条件加「!speaking」；朗读期间 KWS 保持监听（服务 F2）。

## F2 朗读打断（barge-in）
- 朗读（speaking）期间 KWS 命中唤醒词 → stopTts() + 停朗读状态（不开新麦，避免误触；用户再按麦克风或下轮唤醒继续）。
- ChatPage kws 命中回调里先判 speaking。语音 worker 侧无需改（KWS 在朗读期间不暂停）。

## F6 截图提问（v1 macOS）
- Electron 主进程：globalShortcut（复用 hotkey 机制模式）注册「截图提问」快捷键（设置页加配置，默认 Ctrl+Shift+A 之类）→ `screencapture -i -c`（框选到剪贴板）→ clipboard.readImage().toDataURL() → webContents.send("screenshot-capture", dataUrl)。
- ChatPage 监听事件：dataUrl 挂进图片附件预览（已有 images 通道），聚焦输入框。
- Linux：留 TODO（gnome-screenshot/xwd 后续）。

## F3 全局语音快捷键（v1 macOS）
- 快捷键注册同 F6 机制。触发=模拟按麦克风按钮（webContents.send("global-voice")→ChatPage toggleVoice）。
- 转写完成后写入当前前台应用：文本放剪贴板 → `osascript -e 'tell application "System Events" to keystroke "v" using command down'`（需辅助功能权限，失败 toast 提示授权）。保留并恢复原剪贴板内容。

## 顺序与验证
F4 → F5 → F1+F2（同改 ChatPage 语音流）→ F6 → F3。每项完成即 cargo build（重签）+ vite build + eslint；最后一次性重启 Electron 供用户验收。e2e：F4 用 API 直调 regenerate_last；F5 get/set 往返；F1-F3 以 UI 验收为主（需要真实麦克风/权限）。
npm 0.0.2 平台包后台上传仍在进行，勿动 /tmp/bt-clone/package.json 与 npm 相关文件。
