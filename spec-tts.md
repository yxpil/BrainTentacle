# Spec：TTS 语音合成（本地 sherpa 系 + 在线四家）

## 目标（用户确认口径，2026-10-30 多轮追加）

1. 设置页新增「语音合成」，引擎可选、选择持久化；使用场景 = **设置页试听**（不做聊天朗读）
2. **本地方案（用户选定）**：全部走 **sherpa-onnx 官方预编译 `sherpa-onnx-offline-tts` CLI**（osx-arm64 已实测；win-x64 有同源预编译），按需下载模型：
   - Supertonic 3（129MB，31 语种**无中文**）— **实测 PASS**
   - KittenTTS nano（31MB，英文）
   - matcha-icefall-zh-baker（75MB，**中文**）+ vocos-22khz-univ.onnx（vocoder）
   - ZipVoice-distill-zh-en-emilia（109MB，**中英**）+ vocos_24khz.onnx
   - Pocket-TTS int8（98MB，英文，质量高）
   - **Kokoro-int8-en-v0_19（103MB，英文）= 用户要的"开源低代价本地部署"代表**（Apache-2.0、sherpa 原生支持、CPU 实时；`kokoro-multi-lang-v1_0` 350MB **超 300MB 红线砍掉**）
   - Piper zh_CN-huayan-medium（67MB，**中文轻量**）+ Piper en_US-amy-low（67MB，英文）
3. **在线方案（用户选定四家）**：
   - **EdgeTTS**：免 key — **实测 PASS**（322 音色、429 需退避）
   - **gTTS 谷歌**：免 key — **本机 `translate.google.com` 实测超时不通**（集成照做，e2e 无法本机验证，如实边界）
   - **SiliconFlow 硅基流动**：需 API key — 网络探活通（401 需 key），无 key 无法 e2e（等用户提供）
   - **OpenAI TTS**：需 API key — **本机 `api.openai.com` 实测超时不通**（同 gTTS 边界）
4. **模型红线 >300MB 不做**（用户指令）：VoxCPM 3.55GB 已砍、已下文件已删；**本地中文由 matcha-zh-baker / Piper-huayan 承担**（不再依赖在线）
5. **模型不默认内置，用户启用哪个引擎才下载哪个**（用户指令）；下载幂等、进度可见、字节/哈希校验、复用 voice.rs 下载链路
6. 不做自定义 API 模板（固定四家在线内置即可）

## 接口契约（双端钉死，仿 voice 三件套）

- `ttsStatus()` → `{engine, engines:{...每引擎:{ready,dir?,bytes?,totalBytes?}}, keys:{siliconflow,openai}已配置布尔, downloading, progress, error}`；在线引擎 ready=依赖/网络探活，无下载
- `ttsPrepare(engine)` → 本地引擎后台下载该引擎全部文件（模型+vocoder+lexicon，幂等、200ms 节流进度、`tts-progress` 事件）；在线直接返回就绪
- `ttsSpeak(text, opts?)` → opts `{engine?, voice?, speed?, pitch?, volume?}` → `{audioBase64, sampleRate, format}`；本地 = sherpa CLI 子进程（按 assets.json 参数模板，`--speed`）；在线 = tts-worker HTTP 分支（429/5xx 退避）；缺 key / 断网 / 中文走英文引擎 → 中文错误提示
- **可调维度按引擎能力走（用户要求"音色之类的也要支持调节"）**：
  | 引擎 | 音色 | 语速 | 音调 pitch | 音量 volume |
  |---|---|---|---|---|
  | EdgeTTS | 322 自动拉取按语言分组 | rate ±50% | **SSML ±50Hz** | **SSML 0-100%** |
  | SiliconFlow | 内置固定音色表 | speed 0.5-2.0 | — | — |
  | OpenAI | 内置 6 音色 | speed 0.25-4.0 | — | — |
  | gTTS | 单音色 | — | — | — |
  | 本地 sherpa 系 | 模型默认/`--sid`（多说话人模型） | `--speed` | — | — |
  不支持的维度前端隐藏（按当前引擎动态显示），不做的维度传入即忽略
- **本地引擎逐模型可调参数（用户要求"每个模型可以调节的选项也加入"）**：`assets.json` 每引擎定义 `tunables` 模板（`{key, flag, type:range|select|text, min/max/step 或 options, default, label}`），前端按当前引擎渲染控件，`ttsSpeak` opts 透传 `extra:{key:val}`，后端**白名单内**拼 CLI flag。逐引擎清单（实测自 `--help`）：
  | 引擎 | 可调项 |
  |---|---|
  | Supertonic | **lang 下拉（31 语种）**、num-steps（1-16，质量/耗时，含语音化默认 8）、**sid 音色**（voice.bin 0..N-1）、silence-scale |
  | KittenTTS | length-scale（语速反比）、**sid 音色**（voices.bin） |
  | matcha-zh-baker | length-scale、noise-scale（0-1，音色随机度） |
  | ZipVoice | **num-steps（默认 4）**、guidance-scale（CFG 1-8）、t-shift、target-rms、**reference-text + reference-audio 零样本音色克隆**（默认用模型自带 test_wavs，可换用户本地文件） |
  | Pocket | **num-steps**、**reference-audio 音色克隆**（同上） |
  | Kokoro | length-scale、**lang 下拉（en/es/fr/hi/it/pt-br）** |
  | Piper/VITS | length-scale、noise-scale（0-1）、noise-scale-w（0-1）、sid（多说话人包） |
  | 全部通用 | speed 或 length-scale（语速）、silence-scale（停顿 0.01-10）、num-threads（1-8） |
  在线引擎沿用上表（edge: rate/pitch/volume；sf: speed；openai: speed）
- 配置持久化 bit.db `"tts"` → `{engine, voice, speed, pitch, volume, keys:{siliconflow:""}, openai:""}`；key 由设置卡输入，不上传
- 模型清单 `voice-bridge/assets.json`：8 本地引擎分区，每文件 name/url/bytes/sha256（GitHub 有则记）

## 变更清单（精确到文件）

### 后端

| 文件 | 变更 |
|---|---|
| `crates/bit-core/src/tts.rs` | 新建。配置读写（含 keys）、`status_impl`（逐引擎探测）、`prepare_impl`（复用 voice 下载链路）、`speak_impl`（sherpa CLI / tts-worker HTTP 分派），错误中文 |
| `crates/bit-core/src/lib.rs` | `pub mod tts` |
| `crates/bit-core/src/commands_api.rs` | 注册 `tts_status` / `tts_prepare` / `tts_speak` |
| bit-napi `bridge.rs` | dispatch 加同名三分支 |
| `src-tauri/commands.rs` + `main.rs` | 三个 `#[tauri::command]` + generate_handler |
| `src/api.js` | `ttsStatus` / `ttsPrepare` / `ttsSpeak` |
| `voice-bridge/tts-worker.mjs` | 新建。stdout `{"port":N}` + `POST /synthesize`（Bearer）：**在线四分支**（edge=node-edge-tts+退避；gtts=fetch translate TTS；siliconflow/openai=fetch v1/audio/speech+key）+ `GET /voices`（edge 音色拉取/缓存）；本地引擎不走 worker（直接 CLI） |
| `voice-bridge/package.json` | 加 `node-edge-tts@1.2.12`（MIT） |
| `voice-bridge/assets.json` | 8 本地引擎分区：每文件 name/url/bytes/sha256 + **`tunables` 可调参数模板**（flag/类型/范围/默认，含 zipvoice·pocket 的 reference-text/audio 克隆项） |
| `voice-bridge/tts-bin/`（新） | sherpa 预编译 `bin/sherpa-onnx-offline-tts` + `lib/` 落位（osx-arm64 20MB 包；win-x64 同源预编译打包时取用） |
| `electron-builder.yml` + `package.json` | tts-bin、`node_modules`（node-edge-tts）进 files/asarUnpack |

### 前端

| 文件 | 变更 |
|---|---|
| `src/pages/AiSettingsPage.jsx` | 「语音合成」卡：引擎下拉**分「本地/在线」两组**（本地标注语言+体积，在线标注 免key/需key）；本地引擎状态行（未下载+下载按钮/进度%/已就绪，1.2s 轮询）；SiliconFlow/OpenAI 的 **API key 输入框**；**参数区按引擎动态显示：音色下拉（edge 自动拉取 322 分组 / siliconflow·openai 内置表 / 本地默认）、语速滑条 0.5-2.0、音调滑条（仅 EdgeTTS，±50Hz）、音量滑条（仅 EdgeTTS，0-100%），外加按 assets.json `tunables` 模板渲染的引擎专属控件**（range 滑条 / select 下拉 / 克隆 reference-text+音频选择）、试听播放 |
| `src/i18n.js` | zh/en 成对 key（settings.tts*） |

## 验证

1. `cargo check --all-targets` 0 error；`cargo test -p bit-core --lib tts` 全过
2. `npm run lint` 0 error（基线 141 warning 不增）；`npm run build` 通过
3. **本地引擎 e2e**：Supertonic / KittenTTS / matcha-zh-baker / ZipVoice / Pocket / Kokoro / Piper-zh 各合成一段（模型校验、音频非静音）
4. **在线 e2e**：EdgeTTS 中英 PASS（已过）；gTTS/OpenAI 本机网络不通 → 如实标"未验证"；SiliconFlow 无 key → 等 key 或标"未验证"
5. **纯本地模型闭环**：TTS 合成 → 本地 ASR（sense-voice 已 PASS）转写 → 与原文比对
6. 全量 `cargo test -p bit-core --lib`（预期既有 2 个平台失败不变）

## 边界（如实汇报）

- 不 commit、不重打包 `/Applications/BIT.app`（等用户指示）
- **gTTS 与 OpenAI 端点本机网络超时不可达**：集成可做但本机无法 e2e 验证；SiliconFlow 通但需用户 key 才能验
- 在线引擎均为非官方/直连 API 使用，微软/谷歌/厂商侧限流（Edge 429 已实测）与协议变化风险不可控
- sherpa 预编译仅 macOS arm64 实测；Windows 用同源 win-x64 预编译（未本机验证，与语音输入同口径）
- 体积红线 300MB：kokoro-multi-lang（350MB）砍掉 → Kokoro 仅英文；中文本地 = matcha/Piper-huayan
- CLI 每次合成重载模型（约数秒），试听场景可接受；模型不默认内置、按需下载
- sherpa CLI 在 win arm64/x64 的预编译包存在但未本机验证
