# Tasks：TTS 语音合成（本地 sherpa 系 8 引擎 + 在线四家）

- [ ] T1 可行性实测
  - [x] T1a sherpa 运行时：node addon 不接 TTS → **官方预编译 osx-arm64-shared（20MB）+ offline-tts CLI** 实测可用
  - [x] T1b EdgeTTS **PASS**：中/英合成非静音（RMS 3372/2415）、voices/list 322 音色、429 需退避
  - [x] T1c Supertonic **PASS**：英文 4.09s、RTF 0.703、RMS 1500 非静音
  - [x] T1d VoxCPM 砍（>300MB 红线）+ kokoro-multi-lang 砍（350MB）；GGUF 已删
  - [x] T1e 网络探活：SiliconFlow 通(401需key)；**gTTS / api.openai.com 本机超时不通**（如实边界）
  - [ ] T1f 其余本地引擎合成实测：KittenTTS / matcha-zh-baker / ZipVoice / Pocket / Kokoro / Piper-zh / Piper-en（模型串行下载中：fetch-all.sh）
- [x] T2 `crates/bit-core/src/tts.rs`（bit.db "tts" 含 keys + status/prepare/speak 分派，下载复用 voice 链路→已抽 download.rs）+ lib.rs 挂载
- [x] T3 四层命令注册：commands_api.rs / bridge.rs / src-tauri commands.rs+main.rs / api.js + tts-progress 事件（另加 tts_voices 供 Edge 音色下拉）
- [x] T4 `voice-bridge/tts-worker.mjs`（在线四分支 edge/gtts/siliconflow/openai + 退避 + GET /voices）+ `node-edge-tts` 依赖 + assets.json 8 引擎分区（含每引擎 `tunables`）
- [x] T5 sherpa 预编译落位 `voice-bridge/tts-bin/` + 本地引擎 speak_impl 走 CLI + 打包接线
- [x] T6 前端 AiSettingsPage「语音合成」卡（引擎下拉本地/在线分组、下载进度、key 输入、参数区动态渲染 + tunables 控件、试听播放）+ i18n zh/en
- [x] T7 静态验证：cargo check 0 error / tts 单测 4 passed / npm run lint 0 error / npm run build 通过
- [ ] T8 真实试听 e2e：本地 8 引擎各一段 + EdgeTTS 中英（gTTS/OpenAI 未验证标注、SiliconFlow 等 key）
- [ ] T9 纯本地模型闭环：TTS 合成 wav → 本地 ASR 转写 → 与原文比对
- [ ] T10 全量验证复跑 + 边界如实汇报（未 commit / 未重打包 / win 未验 / gTTS·OpenAI 本机不可达 / 需 key 引擎未 e2e / 模型按需下载）
