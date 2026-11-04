# Tasks：语音输入移植

- [x] T1 `voice-bridge/` 三件套（voice-worker.mjs 移植 / package.json / assets.json）+ `npm --prefix voice-bridge install`（sherpa-onnx-node@1.13.8 + darwin-arm64 就位）
- [x] T2 `crates/bit-core/src/voice.rs`（status/prepare/transcribe + worker 单例管理）+ lib.rs 挂载
- [x] T3 四层命令注册：commands_api.rs / bridge.rs / src-tauri commands.rs+main.rs / api.js（`voiceStatus` `voicePrepare` `voiceTranscribe`）
- [x] T4 打包与权限接线：electron-builder.yml files+asarUnpack `voice-bridge/**`、package.json postinstall、electron/main.cjs setPermissionRequestHandler 放行 media
- [x] T5 前端 ChatPage：IconMic、录音→重采样→WAV→base64→转写→插草稿、录音态/转写态/下载引导/进度
- [x] T6 AiSettingsPage「语音输入」卡片 + 模型状态行；i18n zh/en 18 key
- [x] T7 静态验证：`cargo check` 0 error、`cargo test -p bit-core --lib voice` 5 过、`npm run lint` 0 error、`npm run build` 通过
- [ ] T8 真实 e2e：模型下载（SHA-256 校验）+ `say` 测试语音转写比对
- [ ] T9 全量验证复跑 + 边界如实汇报（未 commit / 未重打包 / win 打包未验）
- [x] T10（用户批准的增补）`voice.rs` 下载链路加 Range 断点续传（残件续传 + 前缀喂 SHA + 超长/SHA 不符作废 + 网络错误保留 .part）与 HEAD 探活排序；新增离线测试 `resume_download_completes_partial`（本地 Range 服务器：先半路断、再续完校验）通过
