// yxpil · 设置项目录
// 设置中心左栏和页眉全局搜索共用同一份「分组 / 卡片名 / 搜索关键词」。
// 这里只放纯数据与图标，不挂页面组件：全局搜索只需要知道点过去落到哪张卡，
// 至于渲染哪个设置页，仍由设置中心自己决定。
import {
  IconSettings,
  IconShirt,
  IconShield,
  IconGlobe,
  IconLang,
  IconServer,
} from "./components/Icons.jsx";

export const DOMAIN_META = {
  ai: { label: "ai.title", icon: IconSettings },
  theme: { label: "theme.title", icon: IconShirt },
  i18n: { label: "i18n.title", icon: IconLang },
  security: { label: "nav.security", icon: IconShield },
  remote: { label: "remote.title", icon: IconGlobe },
  // 插件域没有固定页面：卡片内容跟着清单走
  plugin: { label: "nav.plugins", icon: IconServer },
};

// 卡片顺序即设置顺序：先接上模型，再调参数与行为，最后外观/安全/远程。
// kw 只喂搜索、不上界面：卡片名都是四五个字，光搜卡片名会出现「明明有这项却搜不到」，
// 中英都写一遍，切了英文界面也还能用中文词找。
export const CARDS = [
  { id: "ai-providers", domain: "ai", label: "ai.groupProviders", kw: "提供方 provider api key 密钥 base url 协议 protocol openai claude gemini" },
  { id: "ai-proxy", domain: "ai", label: "ai.groupProxy", kw: "代理 proxy 网络 出网 企业 内网 公司 http https socks socks5 认证 账号 密码 白名单 bypass no_proxy 直连 无法连接 超时 network 更新下载 mcp 证书 cert ca tls 校验 验证 中间人 不安全 忽略 insecure 探测 本机 clash v2rayn squid privoxy 环境变量 子进程 继承 pac 系统代理 回退 fail" },
  { id: "ai-model", domain: "ai", label: "ai.groupModel", kw: "思考强度 reasoning 温度 temperature 采样 sampling 上下文上限 context limit max_context" },
  { id: "ai-exec", domain: "ai", label: "ai.groupExec", kw: "幻觉 熔断 超时 shell 截屏 鼠标 键盘 语法 自主能力 guard timeout 托管服务 workwith 服务 启动 延时 就绪 重试 崩溃 退避 停止 日志 生命周期 lifecycle service startup retry backoff" },
  { id: "ai-behavior", domain: "ai", label: "ai.groupBehavior", kw: "审批 approval 自动 auto 压缩 compact 内容审核 moderation 待办 todo clock 兼容 自主执行 委派 子代理 并发 delegation subagent" },
  { id: "ai-voice", domain: "ai", label: "ai.groupVoice", kw: "语音 朗读 音色 语速 识别 tts asr speech voice 提示音 完成 提醒 音量 试听 自定义音频 chime sound notify volume" },
  { id: "ai-prompt", domain: "ai", label: "ai.groupPrompt", kw: "系统提示词 system prompt 人设 角色 persona" },
  { id: "ai-launch", domain: "ai", label: "ai.groupLaunch", kw: "开机自启 autostart 快捷键 hotkey 录入 按下 record press 托盘 tray 休眠 睡眠 阻止 sleep power awake prevent 悬浮 hover 预览 preview 延迟 delay 任务面板 popup" },
  { id: "theme-master", domain: "theme", label: "theme.groupMaster", kw: "启用外观 导入 导出 恢复默认 preset import export reset" },
  { id: "theme-accent", domain: "theme", label: "theme.groupAccent", kw: "主题色 accent 配色 颜色 color" },
  { id: "theme-bg", domain: "theme", label: "theme.groupBackground", kw: "背景 图片 壁纸 透明度 opacity background" },
  { id: "theme-details", domain: "theme", label: "theme.groupDetails", kw: "圆角 radius 字号 字体 边框 阴影 border shadow font 悬停 名称 导航 tooltip 提示 图标栏 大小 侧栏 宽度 icon rail size" },
  { id: "i18n-lang", domain: "i18n", label: "i18n.groupLang", kw: "语言 界面语言 多语言 国际化 i18n language locale 中文 英文 日语" },
  { id: "i18n-engine", domain: "i18n", label: "i18n.groupEngine", kw: "翻译 引擎 语言扩展 扩展 语言包 index translate 模型 并发 生成 词典 译文 缓存 translate engine packs" },
  { id: "sec-hidden", domain: "security", label: "sec.groupHidden", kw: "脱敏 密钥 手机号 邮箱 正则 占位符 hiddencode mask secret" },
  { id: "sec-l2", domain: "security", label: "sec.groupL2", kw: "审核 二级 l2pass 放行 review" },
  { id: "sec-takeover", domain: "security", label: "sec.groupTakeover", kw: "插件 接管 屏蔽 内置 入口 语音 voice takeover override plugin" },
  { id: "plugin-perms", domain: "plugin", label: "plugin.permsPage", kw: "插件权限 permission 权限开关 每个插件 app 应用 能力 capability 精准开关" },
  { id: "remote-access", domain: "remote", label: "remote.groupAccess", kw: "端口 port 监听 密码 password client key 密钥 二维码 qr nat 中继 relay stun" },
  { id: "remote-api", domain: "remote", label: "remote.groupApi", kw: "接口 api openai mcp curl 端点 endpoint" },
];

export const firstCardOf = (domain, cards) => cards.find((c) => c.domain === domain)?.id;

/** 内置卡片 + 插件注入卡片：后者 id 形如 "<插件id>:<条目id>"，天然撞不上内置 id */
export function settingsCards(pluginCards = []) {
  return [
    ...CARDS,
    ...pluginCards.map((c) => ({
      id: c.key,
      domain: "plugin",
      label: c.label,
      kw: `${c.plugin_name || ""} ${c.kw || ""} ${c.description || ""}`.trim(),
    })),
  ];
}

/** 关键词命中：卡片名 + 隐藏关键词 + 所属分组名，中英一起匹配；空词返回全部 */
export function matchSettings(cards, term, t) {
  const q = String(term || "").trim().toLowerCase();
  if (!q) return cards;
  return cards.filter((c) =>
    `${t(c.label)} ${c.kw} ${t(DOMAIN_META[c.domain]?.label || "")}`.toLowerCase().includes(q)
  );
}
