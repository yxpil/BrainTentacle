# Spec：语音输入（移植 dsh SenseVoice 离线识别插件）

## 目标

1. 对话页输入区加麦克风按钮：录音 → 本地离线转写 → 文字**插入草稿**（绝不自动发送、不进模型上下文）
2. 识别模型（约 241MB）首次使用时按需下载，SHA-256 校验，进度可见、幂等
3. 设置页可开关语音输入按钮（localStorage 持久化，默认开）
4. 平台：macOS + Windows（sherpa-onnx 双平台原生包）

## 依据（dsh 调查结论）

- 插件 `@deepseek-ai/dsh-experimental-voice-input-bundle` 及其依赖共 4 包，**MIT 协议**
- 可搬核心：`speech-to-text-sensevoice/lib/worker.js`（249 行）——Node 子进程，`argv[2]` JSON 配置 + env `DSH_SPEECH_TOKEN`（64hex）+ 就绪 stdout `{"port":N}\n` + `POST /transcribe`（Bearer，timingSafeEqual）收 16kHz 单声道 PCM16 WAV，返回 `{text, audioSeconds, inferenceSeconds}`
- 搬不动：client-ui（深度绑定 Cordis）→ 前端录音 UI 全部自写
- 模型清单 `runtime/assets.json`：`model.int8.onnx` 239,233,841B、`tokens.txt` 315,894B、`silero_vad.onnx` 1,807,522B，各带 SHA-256，huggingface.co 固定 revision 路径，hf-mirror.com 镜像

## 接口契约（双端钉死）

Rust → 前端（`src/api.js` 对象方法，四层链 commands_api → bridge.rs → src-tauri → api.js）：

- `voiceStatus()` → `{ready, downloading, modelDir, progress:{done,total}|null, workerRunning, error}`
- `voicePrepare()` → 触发后台下载（幂等；进行中重复调用直接返回）
- `voiceTranscribe(wavBase64, language?)` → `{text, audioSeconds, inferenceSeconds}`；language ∈ auto/zh/en/yue/ja/ko，默认 auto
- 事件：`ctx.emit("voice-progress", {done, total, file})`，前端 `listen("voice-progress")`
- 前端开关：`localStorage["bit.voiceInput"]`（'1' 显 '0' 隐），事件 `bit-voice-input` + `storage` 兜底（仿 `bit.todoClock` 模式）

## 变更清单（精确到文件）

### 后端（新建 + 接线）

| 文件 | 变更 |
|---|---|
| `voice-bridge/voice-worker.mjs` | 新建。worker.js 移植版：http/crypto 鉴权服务 + sherpa OfflineRecognizer + Silero VAD 分段；去 zod 改手写配置校验；中文注释 |
| `voice-bridge/package.json` | 新建。唯一依赖 `sherpa-onnx-node@1.13.8` |
| `voice-bridge/assets.json` | 新建。拷 sensevoice runtime/assets.json（sha256/size/url） |
| `crates/bit-core/src/voice.rs` | 新建。`status_impl`（三文件存在+字节数对齐 = ready）、`prepare_impl`（reqwest 流式下载→sha2 校验→原子 rename，200ms 节流 emit 进度，hf 主源失败回退 hf-mirror）、`transcribe_impl`（语言白名单→base64 解码→确保 worker→Bearer POST，失败重启重试一次）、worker 单例（`Mutex<Option<WorkerHandle>>` + STARTING 单飞；`find_worker_script` 仿 dsh 三段路径探测 + `CARGO_MANIFEST_DIR/../../voice-bridge` 开发回退；spawn `current_exe` + `ELECTRON_RUN_AS_NODE=1`，30s 超时）；错误信息中文 |
| `crates/bit-core/src/lib.rs` | 加 `pub mod voice` |
| `crates/bit-core/src/commands_api.rs` | 注册 `voice_status` / `voice_prepare` / `voice_transcribe` |
| bit-napi `bridge.rs` | dispatch 加同名三分支 |
| `src-tauri/commands.rs` + `main.rs` | 三个 `#[tauri::command]` + generate_handler |
| `src/api.js` | L166-170 加 `voiceStatus` / `voicePrepare` / `voiceTranscribe` 三个方法 |
| `electron-builder.yml` | `files` + `asarUnpack` 加 `voice-bridge/**`（保持磁盘真实文件，仿 dsh-bridge） |
| `package.json` | postinstall 并列加 `npm --prefix voice-bridge install` |
| `electron/main.cjs` | `setPermissionRequestHandler` 放行 `media`（麦克风） |

### 前端

| 文件 | 变更 |
|---|---|
| `src/components/Icons.jsx` | 新增 `IconMic`（24x24 stroke，对齐现有风格） |
| `src/pages/ChatPage.jsx` | 麦克风按钮（受 `bit.voiceInput` 控制）；录音：`getUserMedia` + `AudioContext({sampleRate:16000})` + ScriptProcessor（不支持则默认采样率 JS 线性重采样）；停止后释放 track/AudioContext → Float32→Int16 → 手写 16kHz 单声道 PCM16 WAV → 分块 btoa base64 → `api.voiceTranscribe(wav,"auto")` → 文本追加草稿末尾（非空补空格，焦点回输入框）；空结果「未识别到语音」；失败内联红字提示；录音期间禁发送/Enter；未就绪点击弹确认（241MB 文案）→ `voicePrepare()` → 订阅 voice-progress + 1.5s 轮询 voiceStatus 显示进度，完成提示就绪 |
| `src/pages/AiSettingsPage.jsx` | 「语音输入」PillSwitch 卡片（写 `bit.voiceInput` + dispatch `bit-voice-input`）+ 模型状态行（探测中/未下载+下载按钮/下载中 %/已就绪，1.2s 轮询） |
| `src/i18n.js` | zh/en 成对 18 个 key（chat.voice*、settings.voiceInput*、voice.download*） |

## 验证

1. `cargo check` 0 error（已过）；`cargo test -p bit-core --lib voice` 5 过
2. `npm run lint` 0 error（基线 140 既有 warning，新增 IconMic import 同类 warning 不修）
3. `npm run build` 通过
4. **真实 e2e**：`voiceStatus` → 触发/直接落位模型下载（三件 SHA-256 校验过）→ macOS `say` 生成中文测试语音 → 转 16k WAV → 起 worker 转写 → 返回文本与源句匹配
5. 全量 `cargo test -p bit-core --lib`（预期 2 个既有平台失败，与本任务无关）

## 边界（如实汇报）

- 不 commit、不 release（等用户指示）
- 不重打包替换 `/Applications/BIT.app`
- 打包产物（win-x64 sherpa 包）不在本机验证

## 批准后增补（用户确认：加断点续传 + 探活）

背景：huggingface.co 被 DNS 污染、hf-mirror.com 间歇可达且速度差，实测 e2e 下到 5MB 即断（拆包确认 dsh 用的同为 HF/hf-mirror 两源、同样没有续传，且本机 `~/.dsh` 也从未下成）。经用户选择，在 `voice.rs` 下载链路补两处（不改接口契约）：

- **HTTP Range 断点续传**：`.part` 在清单长度内则带 `Range` 续传；已有前缀先喂进 SHA-256 再追加；服务器回 200 则覆盖重来；超长/SHA 不符的残件作废，网络类错误保留 `.part`
- **HEAD 探活排序**（学 dsh）：并发 HEAD 探候选源，活源优先（省掉每次撞被污染主源的 15s 超时），失败源仍留作回退

## 批准后执行方式

实现已完成（后端/前端两 agent 交付），批准后按 tasks.md 逐项核验勾选，重点执行 T7-T9（全量验证 + e2e + 边界汇报）。

## 增补需求（2026-10-30 用户口头确认，待排期）

1. **ASR 多引擎**：本地 sherpa SenseVoice 之外，加「OpenAI 兼容在线转写」引擎（POST /v1/audio/transcriptions，base_url/key 用户可配，SiliconFlow 等兼容服务同协议可用）；设置页选引擎，本地模型默认**不下载**（首次启用才拉）
2. **语音唤醒**：sherpa-onnx 关键词唤醒（KWS，中文 wenetspeech kws 模型数 MB）+ openWakeWord 模型（hey_jarvis 等，英文）；用户提的 "snowman" 疑指 Snowboy（已停维护）——先按 KWS + openWakeWord 双引擎落地，唤醒后自动进入录音→转写链路；开关在设置页，模型同样按需下载

   **KWS 实现细节（T-kws，2026-10-31 定稿）**
   - 模型：`kws-models/sherpa-onnx-kws-kwzipformer-wenetspeech-3.3M-2024-01-01.tar.bz2`（GitHub，31MB，已验证 200）；内含 encoder/decoder/joiner int8 + tokens.txt + keywords.txt（每行 `词 @音素分数`）
   - assets.json 新增 `kws.variants`：`kws-zh`（上述包，keywords.txt 可被用户自定义文件覆盖）；后续可加英文
   - voice.rs：新增 kws 资产（name/url/bytes/sha256 可空）→ 复用 download；状态并入 voice_status（`kws: {ready, downloading, progress}`）；开关存 bit.db `voice.kwsOn`、灵敏度 `voice.kwsScore`（默认 1.5，写 keywords.txt 每行 `词@阈值` 的 score 字段，运行时替换）
   - voice-worker.mjs 新增 KWS 模式：启动参数 `kws:{...}` 时额外建 KeywordSpotter；HTTP 端点 `POST /kws/start`（建 stream，开始累积）、`POST /kws/feed`（body= PCM16 16k 原始字节，增量 accept_waveform + is_ready→decode），命中返回 `{hit:"你好小鑫"}`（也广播 stdout JSON 行）；`POST /kws/stop`（重置 stream）；复用现有 Bearer 鉴权
   - 前端：设置页「语音唤醒」卡（开关 + 模型选择 + 灵敏度滑条）；开关开启时主进程/渲染层常驻 getUserMedia 16k 采集（复用现有音频管线，ScriptProcessor 4096 块），逐块 POST /kws/feed；命中 → 停止喂流 → 自动触发现有 toggleVoice 录音→转写链路（唤醒即开麦）；关闭开关 → /kws/stop + 停采集
   - 默认关键词取包内 keywords.txt（含「你好小鑫」等）；用户自定义后续做（写 data_dir/voice/kws_keywords.txt 覆盖）
3. **集成原则**：所有语音能力（输入/TTS/唤醒）统一为「设置页可安装、可开关，默认不装模型」
4. **Linux 全功能**：语音输入/TTS/唤醒在 Linux 可用（sherpa-onnx 有 linux 原生包；electron-builder 已有 linux 工作流，打包时带上 voice-bridge 与 CLI 预编译产物）
