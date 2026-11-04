# 验收清单：自动化任务（计划执行时间 + 待办时钟）

- [x] Todo 结构含 `scheduled_at` / `schedule` / `last_run` 三个 `Option<String>`（serde default），旧数据反序列化无报错
- [x] SQLite todos 表已有三列（老库经幂等 ALTER 补列），SELECT/INSERT/导入路径列清单同步
- [x] `schedule_task` 工具实现 set/clear，校验 `YYYY-MM-DD HH:MM` 格式，set 时重置 `last_run`
- [x] `schedule_task` 已在 registry 注册，默认 enabled=false（新装/重启后默认不进提示词）
- [x] 用户在工具页开启 `schedule_task` 后，重启仍保持开启（内置工具开关持久化）
- [x] `schedule_todos_loop` 每 30s tick：到点待办有关联会话 → `notify_session_result` 唤回；无会话 → 标记 `overdue`
- [x] spawn 点在 api.rs `bootstrap_services` 与 plugins scheduler 相邻
- [x] 对话页待办行左侧显示时钟图标 + 计划时间，到点未完成变红
- [x] 设置中「待办时钟」开关可关闭/打开时钟渲染，且重启后保持
- [x] i18n 中英 key 齐全（todoClock / scheduleTask / 到点文案）
- [x] 工具页可见 `schedule_task` 且可开关启停
- [x] `cargo check -p bit-core -p bit-napi` 通过
- [x] `npm run lint`（eslint src）0 error；`npm run build` 通过
- [x] 工具页关闭 `schedule_task` 后，系统提示词/工具表不含该工具

# 验收清单：语音输入（移植 dsh SenseVoice 离线识别）

- [x] `voice-bridge/` 三件套就位（voice-worker.mjs / package.json / assets.json），sherpa-onnx-node darwin-arm64 已安装
- [x] 四层命令注册齐全：commands_api.rs → bridge.rs → src-tauri commands+main → api.js（`voiceStatus`/`voicePrepare`/`voiceTranscribe`）
- [x] 前端麦克风按钮 → 录音 → 16k WAV → base64 → 转写 → 插草稿不自动发送（ChatPage 逐行核验）
- [x] 设置页语音输入开关 + 模型状态/下载卡片；i18n zh/en 18 key 成对
- [x] 打包接线：electron-builder files+asarUnpack `voice-bridge/**`、postinstall 装依赖、麦克风权限放行
- [x] `cargo check -p bit-core --all-targets` 0 error
- [x] `cargo test -p bit-core --lib` 246 passed（含新增断点续传测试）/ 2 failed 为既有平台失败 / 1 ignored 为 e2e
- [x] `npm run lint` 0 error（141 warning = 基线 140 + IconMic import 同类噪音）；`npm run build` 通过
- [x] 断点续传 + HEAD 探活（用户批准增补）：离线测试 `resume_download_completes_partial` 通过（先半路断保留 .part，再续完 SHA 对、落位）
- [ ] 真实 e2e：模型下载（SHA-256 校验）+ macOS `say` 中文语音转写文本比对
- [ ] 边界如实汇报（未 commit / 未重打包 BIT.app / win 打包未本机验证）
