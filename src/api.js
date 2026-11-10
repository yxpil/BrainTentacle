import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const api = {
  overview: () => invoke("get_overview"),
  listTools: () => invoke("list_tools"),
  registerTool: (name, description, url) => invoke("register_tool", { name, description, url }),
  registerScriptTool: (name, description, runtime, code) =>
    invoke("register_script_tool", { name, description, runtime, code }),
  removeTool: (id) => invoke("remove_tool", { id }),
  setToolEnabled: (id, enabled) => invoke("set_tool_enabled", { id, enabled }),
  invokeTool: (id, params) => invoke("invoke_tool", { id, params }),
  listRuntimes: () => invoke("list_runtimes"),
  refreshRuntimes: () => invoke("refresh_runtimes"),
  addRuntime: (id, name, path, lang) => invoke("add_runtime", { id, name, path, lang }),
  removeRuntime: (id) => invoke("remove_runtime", { id }),
  setRuntimeEnabled: (id, enabled) => invoke("set_runtime_enabled", { id, enabled }),
  runScript: (runtime, code, params) => invoke("run_script", { runtime, code, params }),
  listAudit: () => invoke("list_audit"),
  clearAudit: () => invoke("clear_audit"),
  deleteAuditEntry: (id) => invoke("delete_audit_entry", { id }),
  getRemoteConfig: () => invoke("get_remote_config"),
  // 检测独立 CLI（npm 全局包 BrainTentacle_cli）是否已安装
  detectCli: () => invoke("detect_cli"),
  // 安装/卸载 npm 全局包（braintentacle_cli），完成后前端重新 detectCli 刷新状态
  installCli: () => invoke("install_cli"),
  uninstallCli: () => invoke("uninstall_cli"),
  saveRemoteConfig: (remote_enabled, host, port) =>
    // Tauri v2 按 camelCase 匹配 Rust 多词参数：remote_enabled → remoteEnabled
    invoke("save_remote_config", { remoteEnabled: remote_enabled, host, port }),
  regenerateClientKey: () => invoke("regenerate_client_key"),
  saveAccessPassword: (password, password_enabled) =>
    invoke("save_access_password", { password, passwordEnabled: password_enabled }),
  regenerateAccessPassword: () => invoke("regenerate_access_password"),
  testConnectivity: () => invoke("test_connectivity"),
  // 幻觉防护阈值：单回复词重复上限 / 单回合工具轮上限（0=关闭）
  getGuardLimits: () => invoke("get_guard_limits"),
  setGuardLimits: (word_repeat_max, tool_loop_max) =>
    invoke("set_guard_limits", { wordRepeatMax: word_repeat_max, toolLoopMax: tool_loop_max }),
  // 工具环境：自定义工具超时（秒）+ 默认 shell（空=自动识别，列表来自本机探测）
  getToolEnvSettings: () => invoke("get_tool_env_settings"),
  setToolEnvSettings: (tool_timeout_secs, default_shell) =>
    invoke("set_tool_env_settings", { toolTimeoutSecs: tool_timeout_secs, defaultShell: default_shell }),
  // 托管服务生命周期（启动延时/就绪上限/重试次数/停止宽限/日志行数）：
  // 只传要改的项，缺省项由核心保持原值；核心钳制后回显真正生效的一组数
  getServiceTuning: () => invoke("get_service_tuning", {}),
  setServiceTuning: (patch) =>
    invoke(
      "set_service_tuning",
      Object.fromEntries(
        Object.entries(patch || {}).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]),
      ),
    ),
  // 出网代理（企业内网）：模式 system/direct/custom；设置成功后 core 立刻改本进程口径
  getProxyConfig: () => invoke("get_proxy_config"),
  setProxyConfig: (mode, url, user, pass, bypass, exportEnv, failOpen, caFile, insecure) =>
    invoke("set_proxy_config", { mode, url, user, pass, bypass, exportEnv, failOpen, caFile, insecure }),
  // 连通性检测：target 留空 = 探当前激活提供方的端点
  testProxy: (target) => invoke("test_proxy", { target: target || "" }),
  // 本机常见代理客户端端口（Clash / v2rayN / Squid…）探活，省得用户猜端口
  probeLocalProxy: () => invoke("probe_local_proxy"),
  // 工具按需加载：只常驻 skill 的 schema，其余工具由 AI 用 skill(action=load_tool) 现场调取
  getToolLoading: () => invoke("get_tool_loading"),
  setToolLoading: (lazy_tools) => invoke("set_tool_loading", { lazyTools: lazy_tools }),
  // 本地插件（toolhomes/plugins/*/plugin.json）
  listPlugins: () => invoke("list_plugins"),
  togglePlugin: (id, enabled) => invoke("toggle_plugin", { id, enabled }),
  // 逐权限开关：只影响运行时，不改插件包与哈希基线
  setPluginPermission: (id, perm, granted) => invoke("set_plugin_permission", { id, perm, granted }),
  refreshPlugins: () => invoke("refresh_plugins"),
  // 插件运行异常（崩溃 / 启动失败 / 端口未就绪）：页眉异常灯的数据源
  pluginHealth: () => invoke("plugin_health"),
  // 插件 UI 资源包：启用且通过安全校验的插件 css/js（渲染层插件加载器读取）
  getPluginUi: () => invoke("get_plugin_ui"),
  // 插件独立页面清单（iframe）+ 插件本机服务基址
  getPluginPages: () => invoke("get_plugin_pages"),
  // 插件登记到对话页图标排的入口（需 chaticon 权限）
  getPluginChatIcons: () => invoke("get_plugin_chat_icons"),
  // 插件接管的宿主内置入口（需 takeover 权限；设置槽位不可接管）
  getPluginTakeovers: () => invoke("get_plugin_takeovers"),
  setPluginTakeover: (id, slot, granted) => invoke("set_plugin_takeover", { id, slot, granted }),
  // 插件自带服务器：状态在 list_plugins 的 server 字段里，这里只管启停与日志
  startPluginServer: (id) => invoke("start_plugin_server", { id }),
  // 插件清单 connections[] 声明的外部 MCP 连接：手动连/断（状态随 list_plugins 一起下发）
  connectPluginNet: (id, name) => invoke("connect_plugin_net", { id, name }),
  disconnectPluginNet: (id, name) => invoke("disconnect_plugin_net", { id, name }),
  stopPluginServer: (id) => invoke("stop_plugin_server", { id }),
  pluginServerLogs: (id, tail) => invoke("plugin_server_logs", { id, tail: tail || null }),
  // 用户自定义提示词/人设
  getCustomPrompt: () => invoke("get_custom_prompt"),
  setCustomPrompt: (custom_prompt) => invoke("set_custom_prompt", { customPrompt: custom_prompt }),
  getSystemPrompt: () => invoke("get_system_prompt"),
  setSystemPrompt: (system_prompt) => invoke("set_system_prompt", { systemPrompt: system_prompt }),
  getBehaviorSettings: () => invoke("get_behavior_settings"),
  // 安全中心：HiddenCode 敏感信息脱敏
  getHiddenCodes: () => invoke("get_hidden_codes"),
  addHiddenCode: (kind, value, as_pattern, alias) =>
    invoke("add_hidden_code", { kind, value, asPattern: as_pattern, alias: alias || "" }),
  removeHiddenCode: (id) => invoke("remove_hidden_code", { id }),
  setHiddenCodeEnabled: (id, enabled) => invoke("set_hidden_code_enabled", { id, enabled }),
  scanHiddenCandidates: (text) => invoke("scan_hidden_candidates", { text }),
  // 安全中心：HiddenCode / L2 PASS 总开关与审核 provider
  getSecuritySettings: () => invoke("get_security_settings"),
  setSecuritySettings: (hidden_code_enabled, l2pass_enabled, l2pass_provider_id, l2pass_cover_auto, l2pass_prompt) =>
    invoke("set_security_settings", {
      hiddenCodeEnabled: hidden_code_enabled,
      l2passEnabled: l2pass_enabled,
      l2passProviderId: l2pass_provider_id,
      l2passCoverAuto: l2pass_cover_auto,
      l2passPrompt: l2pass_prompt,
    }),
  // blocked_words 敏感词表：传数组=整体替换；传 [] = 恢复内置默认；不传 = 保持原值
  setBehaviorSettings: (auto_drive, tool_approval, moderation_enabled, auto_delegate, compat_mode, subagent_max, blocked_words) =>
    invoke("set_behavior_settings", {
      autoDrive: auto_drive,
      toolApproval: tool_approval,
      moderationEnabled: moderation_enabled,
      autoDelegate: auto_delegate,
      compatMode: compat_mode,
      subagentMax: subagent_max ?? 3,
      blockedWords: blocked_words,
    }),
  // 子代理（宿主调度）：模型侧无此工具，只有宿主/用户能派生
  spawnSubagent: (task, title, session_id) =>
    invoke("subagent_spawn", { task, title: title || null, sessionId: session_id || null }),
  subagentRunning: () => invoke("subagent_running"),
  stopSubagent: (session_id) => invoke("stop_subagent", { sessionId: session_id }),
  cancelShell: (job_id) => invoke("cancel_shell", { jobId: job_id }),
  listRunningShells: () => invoke("list_running_shells"),
  getShellDetail: (job_id) => invoke("get_shell_detail", { jobId: job_id }),
  // 远程二维码：网络探测（LAN/公网候选 + NAT 粗判）→ 返回 { payload, svg }
  getRemoteQr: () => invoke("get_remote_qr"),
  getLanInfo: () => invoke("get_lan_info"),
  // 云中继地址（对称 NAT 时手机端改连），空串清除
  saveCloudRelay: (url) => invoke("save_cloud_relay", { url }),
  // 自定 STUN 列表（NAT 探测数据源），空数组恢复内置默认
  saveStunServers: (servers) => invoke("save_stun_servers", { servers }),
  listProviders: () => invoke("list_providers"),
  addProvider: (name, protocol, base_url, api_key, model, profile, tool_mode, continue_nudges, stream_idle_secs, temperature, reasoning_effort, max_output_tokens, request_timeout_secs) =>
    invoke("add_provider", {
      name,
      protocol,
      baseUrl: base_url,
      apiKey: api_key,
      model,
      profile: profile || null,
      toolMode: tool_mode || null,
      continueNudges: continue_nudges || null,
      streamIdleSecs: stream_idle_secs || null,
      temperature: temperature ?? null,
      reasoningEffort: reasoning_effort || null,
      maxOutputTokens: max_output_tokens || null,
      requestTimeoutSecs: request_timeout_secs || null,
    }),
  updateProvider: (id, name, protocol, base_url, api_key, model, profile, tool_mode, continue_nudges, stream_idle_secs, temperature, reasoning_effort, max_output_tokens, request_timeout_secs) =>
    invoke("update_provider", {
      id,
      name,
      protocol,
      baseUrl: base_url,
      apiKey: api_key,
      model,
      profile: profile || null,
      toolMode: tool_mode || null,
      continueNudges: continue_nudges || null,
      streamIdleSecs: stream_idle_secs || null,
      temperature: temperature ?? null,
      reasoningEffort: reasoning_effort || null,
      maxOutputTokens: max_output_tokens || null,
      requestTimeoutSecs: request_timeout_secs || null,
    }),
  removeProvider: (id) => invoke("remove_provider", { id }),
  setProviderActive: (id, active) => invoke("set_provider_active", { id, active }),
  // 模型采样参数：temperature null=默认（0-2）；reasoningEffort ""=默认 / low / medium / high
  getAiParams: () => invoke("get_ai_params"),
  setAiParams: (temperature, reasoning_effort) =>
    invoke("set_ai_params", { temperature, reasoningEffort: reasoning_effort }),
  // 模型名别名表（文本域：一行 `关键词 = 档位 [/ 协议]`）
  setModelAliases: (text) => invoke("set_model_aliases", { text }),
  // 按表单值回显当前生效档位/协议/上限/超时/采样（Rust 单一真源，不落盘）
  aiEffectiveProfile: (form) => invoke("ai_effective_profile", { form: form || {} }),
  // 最近一次真正发出的请求原文（无记录返回 null）
  aiLastRequest: () => invoke("ai_last_request"),
  // 从提供方 API 拉取可用模型列表（OpenAI /models、Gemini /v1beta/models、Claude /v1/models）
  listProviderModels: (protocol, base_url, api_key) =>
    invoke("list_provider_models", { protocol, baseUrl: base_url, apiKey: api_key }),
  chat: (session_id, message, images) =>
    invoke("chat", { sessionId: session_id, message, images: images || null }),
  // 重新生成 / 编辑重发：删尾 assistant（edit_text 非空时先改写最后一条 user），只跑模型回合。
  // 流式事件与 chat_stream 同款；返回最终完整消息列表
  regenerateStream: async (session_id, event_name, onEvent, edit_text) => {
    const ev = event_name || `regen-${Date.now()}`;
    const unlisten = await listen(ev, (e) => onEvent?.(e.payload));
    try {
      return await invoke("regenerate_last", {
        sessionId: session_id,
        eventName: ev,
        editText: edit_text ?? null,
      });
    } finally {
      unlisten();
    }
  },
  // 提示词模板：[{id,title,text}]；get 未保存过时返回内置默认，set 空数组=恢复默认
  promptTemplatesGet: () => invoke("prompt_templates_get"),
  promptTemplatesSet: (templates) => invoke("prompt_templates_set", { templates }),
  // 应用级扩展快捷键（Electron 宿主拦截）：截图提问 / 全局语音听写（空串=关闭）
  getAppHotkeys: () => invoke("get_app_hotkeys"),
  // 聊天工具栏剪刀按钮：macOS screencapture 框选 → 剪贴板 → 挂输入框附件（Electron 专属）
  screenshotRegion: () => invoke("screenshot_region"),
  // 内嵌网页截图：按 webview 的 webContentsId 截当前视口，PNG 走 screenshot-capture 事件附到输入框
  webCapture: (web_contents_id) => invoke("web_capture", { webContentsId: web_contents_id }),
  setAppHotkeys: (screenshot, voice) => invoke("set_app_hotkeys", { screenshot: screenshot ?? null, voice: voice ?? null }),
  // 全局语音转写结果粘贴回原前台应用（macOS osascript；Windows 按 HWND 抢回前台再注入）
  pasteTextToForeground: (text, bundleId, hwnd) =>
    invoke("paste_text_to_foreground", { text, bundleId: bundleId || null, hwnd: hwnd || null }),
  // 流式对话：过程通过 Tauri 事件 event_name 推送增量，onEvent 收到 {type, ...} payload。
  // images 为可选的图片 base64 data URL 数组，仅随当前用户轮发给多模态模型。
  // 返回一个 Promise，resolve 为最终完整消息列表；调用方应先订阅事件再 await。
  chatStream: async (session_id, message, event_name, onEvent, images) => {
    const ev = event_name || `chat-stream-${Date.now()}`;
    const unlisten = await listen(ev, (e) => onEvent?.(e.payload));
    try {
      return await invoke("chat_stream", {
        sessionId: session_id,
        message,
        eventName: ev,
        images: images || null,
      });
    } finally {
      unlisten();
    }
  },
  // 解析上传文件：Excel→Markdown 表格 / Word(.docx)→纯文本 / CSV→原文。data 为 base64（可含 data:URL 前缀）
  extractFile: (filename, data, path) => invoke("extract_file", { filename, data, ...(path ? { path } : {}) }),
  // 只有绝对路径的文件（侧栏预览、AI 发来的文件卡片）走这条：核心读盘解析，界面不搬字节
  extractPath: (path) => invoke("extract_path", { path }),
  // 文件基本信息（大小/修改时间/能不能解析）：右键「查看详情」用，不读内容
  statPath: (path) => invoke("stat_path", { path }),
  // 用系统默认程序打开文件；reveal=true 时打开所在文件夹并定位
  openPath: (path, reveal) => invoke("open_path", { path, reveal: !!reveal }),
  // 另存为：原生保存对话框，path 支持本地路径或 data:URL；返回保存路径（取消 null）
  saveFileAs: (path, suggestedName) => invoke("save_file_as", { path, suggestedName: suggestedName || null }),
  // 右侧预览面板编辑后回写（宿主侧命令，非 Rust）
  fsWriteText: (path, content) => invoke("fs_write_text", { path, content }),
  // 抓取网页正文，返回 { title, text }
  fetchWebpage: (url) => invoke("fetch_webpage", { url }),
  // 端口冲突检测：返回 { available, addr, reason? }
  checkPort: (host, port) => invoke("check_port", { host, port }),
  // 手动压缩会话：AI 总结全部历史为一条摘要，返回新消息列表
  // providerId: 指定压缩用模型 id（空 = 当前激活模型）；compact*：自动压缩配置
  compressSession: (session_id, providerId) => invoke("compress_session", { sessionId: session_id || "", providerId: providerId || null }),
  compactConfigGet: () => invoke("compact_config_get"),
  compactConfigSet: (auto, chars, provider) => invoke("compact_config_set", { auto, chars: chars ?? null, provider: provider ?? null }),

  // ── MCP（Model Context Protocol）接入 ──
  mcpDiscover: (host, start, end) => invoke("mcp_discover", { host, start, end }),
  mcpConnect: (url) => invoke("mcp_connect", { url }),
  // stdio 接入：spawn 本地命令并 initialize 握手（如 python -m mcp_server_fetch）
  mcpAddStdio: (name, command, args, env) => invoke("mcp_add_stdio", { name, command, args, env }),
  mcpList: () => invoke("mcp_list"),
  mcpToggle: (id, enabled) => invoke("mcp_toggle", { id, enabled }),
  mcpRemove: (id) => invoke("mcp_remove", { id }),
  mcpImport: (id) => invoke("mcp_import", { id }),

  // ── DeepSeek Harness (dsh) 插件桥 ──
  // 状态：插件列表 + MCP 桥注册情况 + 技能根目录
  dshStatus: () => invoke("dsh_status"),
  // 把 dsh 插件生态里的技能一键导入本机技能库
  dshImportSkills: () => invoke("dsh_import_skills"),
  // 启用桥接：确保目录存在 + 注册 MCP 桥，成功即代表插件工具可经 MCP 接入
  dshSetupBridge: () => invoke("dsh_setup_bridge"),
  // 单个 dsh 插件的启用 / 停用
  dshTogglePlugin: (name, enabled) => invoke("dsh_toggle_plugin", { name, enabled }),

  // ── 语音输入（多模型选一，本地离线识别）──
  // 状态：当前模型 variant + 全变体清单（含就绪/体积）+ 下载进度（voice-progress 事件）+ 识别进程状态 + 错误
  voiceStatus: () => invoke("voice_status"),
  // 选择识别模型：写配置并热切换识别进程；未下载时返回状态（前端引导先下载）
  voiceSelect: (variant) => invoke("voice_select", { variant }),
  // 下载/校验离线识别模型到数据目录 voice/<variant>/（幂等，进度走 voice-progress 事件）
  voicePrepare: () => invoke("voice_prepare"),
  // 语音唤醒：开关/灵敏度（写配置并重建识别进程）；下载唤醒模型（幂等）
  // keywords: [{word,pinyin}] 自定义唤醒词（null=不改，[]=清空回内置词表）
  voiceKwsSet: (enabled, score, keywords) => invoke("voice_kws_set", { enabled, score: score ?? null, keywords: keywords ?? null }),
  voiceKwsPrepare: () => invoke("voice_kws_prepare"),
  // WAV（base64）转写 → { text, audioSeconds, inferenceSeconds}；language 可省略（auto/zh/en/yue/ja/ko）
  voiceTranscribe: (wavBase64, language) =>
    invoke("voice_transcribe", { wavBase64, language: language || null }),

  // ── 语音合成（本地 sherpa 8 引擎 + 在线四家）──
  // 状态：逐引擎就绪/体积/缺失文件 + key 配置 + 下载进度（tts-progress 事件）+ 错误。
  // patch 可选：{engine, voice, speed, pitch, volume, extra, keys:{siliconflow, openai}}，传入即保存
  ttsStatus: (patch) => invoke("tts_status", { patch: patch || null }),
  // 准备引擎：本地引擎后台下载该引擎全部文件（幂等，进度走 tts-progress）；在线直接返回就绪
  ttsPrepare: (engine) => invoke("tts_prepare", { engine }),
  // 合成语音：text + opts {engine?, voice?, speed?, pitch?, volume?, extra?{...tunables}}
  // → { audioBase64, sampleRate, format }（本地 wav / 在线 mp3）
  ttsSpeak: (text, opts) => invoke("tts_speak", { text, opts: opts || null }),
  // 在线引擎音色列表（仅 EdgeTTS）：{engine, groups:[{language, label, voices:[{name, label}]}]}
  ttsVoices: (engine) => invoke("tts_voices", { engine: engine || "edge" }),

  // ── WorkWith 本地服务托管 ──
  listWorkwith: () => invoke("list_workwith"),
  saveWorkwith: (entry) => invoke("save_workwith", { entry }),
  removeWorkwith: (id) => invoke("remove_workwith", { id }),
  startWorkwith: (id) => invoke("start_workwith", { id }),
  stopWorkwith: (id) => invoke("stop_workwith", { id }),
  workwithLogs: (id, tail) => invoke("workwith_logs", { id, tail: tail ?? null }),

  // ── 中断 / 工具审批 / 上下文预览 ──
  chatInterrupt: (session_id) => invoke("chat_interrupt", { sessionId: session_id || "" }),
  // 回合真相：核心此刻确实有回合在跑的会话 id（渲染层的忙表靠它纠偏）
  getRunningTurns: () => invoke("running_turns", {}),
  toolApprove: (id, allow) => invoke("tool_approve", { id, allow }),
  setToolApproval: (mode) => invoke("set_tool_approval", { mode }),
  getToolApproval: () => invoke("get_tool_approval"),
  askAnswer: (id, choices, supplement) => invoke("ask_answer", { id, choices, supplement }),
  getAutostart: () => invoke("get_autostart"),
  setAutostart: (enabled) => invoke("set_autostart", { enabled }),
  // 阻止系统休眠（Electron powerSaveBlocker）：长任务期间不让系统睡眠，屏幕仍可关闭
  getPreventSleep: () => invoke("get_prevent_sleep"),
  setPreventSleep: (enabled) => invoke("set_prevent_sleep", { enabled }),
  // 任务完成提示音：档位 default/custom/error-only + 音量（0–100）+ 自定义音频文件
  getNotifySound: () => invoke("get_notify_sound"),
  setNotifySound: (mode, volume) => invoke("set_notify_sound", { mode, volume }),
  setCustomSound: (name, data) => invoke("set_custom_sound", { name, data }),
  // 托盘悬浮预览：鼠标停在托盘图标上多久才弹状态小窗（0 = 关闭）
  getTrayHover: () => invoke("get_tray_hover"),
  setTrayHover: (delay) => invoke("set_tray_hover", { delay }),
  // 全局快捷键：唤出主界面（空 = 关闭）
  getHotkey: () => invoke("get_hotkey"),
  setHotkey: (hotkey) => invoke("set_hotkey", { hotkey }),
  // 本机操控开关（screen/mouse/keyboard/draw_diagram/view_image，实验性；默认全关）
  getDesktopTools: () => invoke("get_desktop_tools"),
  setDesktopTools: (screen, mouse, keyboard, diagram, viewimage) => invoke("set_desktop_tools", { screen, mouse, keyboard, diagram, viewimage }),
  // 写文件后轻量语法检查（json/js/py）：出错提醒模型与用户
  getSyntaxCheck: () => invoke("get_syntax_check"),
  setSyntaxCheck: (enabled) => invoke("set_syntax_check", { enabled }),
  getElevation: () => invoke("get_elevation"),
  setElevation: (enabled) => invoke("set_elevation", { enabled }),
  // 自动运行：后台自主循环（记忆总结 / 技能提炼 / 目标行动），AI 设置里的圆钮开关
  toggleAutopilot: () => invoke("toggle_autopilot"),
  // ── 版本更新：检查 / 后台下载（进度走 update-progress 事件）/ 换装重启 ──
  checkUpdates: () => invoke("check_updates"),
  getAutoUpdate: () => invoke("get_auto_update"),
  setAutoUpdate: (enabled) => invoke("set_auto_update", { enabled }),
  updateDownload: () => invoke("update_download"),
  updateApply: () => invoke("update_apply"),
  getToolStats: () => invoke("get_tool_stats"),
  getDiagnostics: () => invoke("get_diagnostics"),
  contextPreview: (session_id) => invoke("context_preview", { sessionId: session_id || "" }),
  contextMetrics: (session_id) => invoke("context_metrics", { sessionId: session_id || "" }),
  listSessions: () => invoke("list_sessions"),
  // 会话搜索：标题 + 消息正文（core 侧扫内存 SessionStore，返回 id 与命中片段）
  searchSessions: (query) => invoke("search_sessions", { query }),
  getSession: (session_id) => invoke("get_session", { sessionId: session_id || "" }),
  createSession: (title) => invoke("create_session", { title: title || "" }),
  // 从某条消息分叉：复制到该条（含）的历史到新会话，并激活它
  forkSession: (session_id, message_index) =>
    invoke("fork_session", { sessionId: session_id, messageIndex: message_index }),
  // 从此处回退：删除这条之后的消息，并恢复这些步骤改过的文件（只支持最近 10 条）
  rollbackSession: (session_id, message_index) =>
    invoke("rollback_session", { sessionId: session_id, messageIndex: message_index }),
  setActiveSession: (session_id) => invoke("set_active_session", { sessionId: session_id }),
  renameSession: (session_id, title) => invoke("rename_session", { sessionId: session_id, title }),
  deleteSession: (session_id) => invoke("delete_session", { sessionId: session_id }),
  deleteSessions: (session_ids) => invoke("delete_sessions", { sessionIds: session_ids }),
  setSessionFavorite: (session_id, favorite) =>
    invoke("set_session_favorite", { sessionId: session_id, favorite }),
  setSessionColor: (session_id, color) => invoke("set_session_color", { sessionId: session_id, color }),
  // 会话分组：空串 = 移出分组；分组只存在会话上的名字里，不单独建表
  setSessionGroup: (session_id, group) => invoke("set_session_group", { sessionId: session_id, group }),
  renameSessionGroup: (from, to) => invoke("rename_session_group", { from, to }),
  clearSession: (session_id) => invoke("clear_session", { sessionId: session_id || "" }),
  listMemories: () => invoke("list_memories"),
  addMemory: (content) => invoke("add_memory", { content }),
  deleteMemories: (ids) => invoke("delete_memories", { ids }),
  listSkills: () => invoke("list_skills"),
  addSkill: (name, summary) => invoke("add_skill", { name, summary }),
  deleteSkills: (ids) => invoke("delete_skills", { ids }),
  listGoals: () => invoke("list_goals"),
  createGoal: (title, detail) => invoke("create_goal", { title, detail }),
  updateGoalStatus: (id, status) => invoke("update_goal_status", { id, status }),
  removeGoal: (id) => invoke("remove_goal", { id }),
  listTodos: () => invoke("list_todos"),
  addTodo: (content, goal_id) => invoke("add_todo", { content, goalId: goal_id }),
  updateTodoStatus: (id, status) => invoke("update_todo_status", { id, status }),
  removeTodo: (id) => invoke("remove_todo", { id }),
  scheduleTodo: (id, action, scheduled_at, schedule) =>
    invoke("schedule_todo", { id, action, scheduledAt: scheduled_at ?? null, schedule: schedule ?? null }),
  quitApp: () => invoke("quit_app"),
};
