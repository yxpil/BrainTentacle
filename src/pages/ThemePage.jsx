import { useRef, useState } from "react";
import { useTheme, DEFAULT_LOOK, compressBgImage, railItemPx } from "../useTheme.js";
import { useLang } from "../i18n.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import PillSwitch from "../components/PillSwitch.jsx";
import { IconImage, IconTrash } from "../components/Icons.jsx";
import { dragEnabled, setDragEnabled, resetAllIconLayouts } from "../iconLayout.js";

/**
 * ThemePage —— 主题定制页
 *  - 背景色（亮色/暗色各自一套）
 *  - 背景透明度滑块
 *  - 卡片透明度滑块（默认跟随背景，可独立固定）
 *  - 背景图片上传（本地文件 → data URL）
 *  - 边框 / 阴影开关
 *  - 卡片圆角滑块
 *  - 一键恢复默认
 */
export default function ThemePage({ group }) {
  // group = 设置中心左栏当前卡片对应的组；其余组只藏不卸载，切卡不丢在途改动
  const gstyle = (id) => (group && group !== id ? { display: "none" } : undefined);
  const { look, setLook, accent, setAccent, setMode } = useTheme();
  const { t } = useLang();
  const fileRef = useRef(null);
  const importRef = useRef(null);
  // 全站图标位拖拽：与外观同属偏好，开关状态由 iconLayout 持久化并广播
  const [toolDrag, setToolDrag] = useState(dragEnabled);
  const toggleToolDrag = () => {
    const next = !toolDrag;
    setToolDrag(next);
    setDragEnabled(next);
  };

  const ACCENT_PRESETS = [
    { color: null, label: "default" },
    { color: "#e11d48", label: "rose" },
    { color: "#ea580c", label: "orange" },
    { color: "#f59e0b", label: "amber" },
    { color: "#16a34a", label: "green" },
    { color: "#0891b2", label: "cyan" },
    { color: "#2563eb", label: "blue" },
    { color: "#7c3aed", label: "violet" },
    { color: "#db2777", label: "pink" },
  ];

  // 浅拷贝避免直接修改原对象
  const patch = (partial) =>
    setLook((l) => ({ ...l, ...partial, enabled: true }));

  // 卡片透明度：未单独设置时跟随背景（背景+15%，与 useTheme 兜底公式一致）
  const cardOp =
    look.cardOpacity ??
    Math.min(100, Math.max(30, (look.bgOpacity ?? 100) + 15));

  const reset = () => setLook({ ...DEFAULT_LOOK });

  const onPickFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // 限制 5MB（原生 alert 换成应用内提示弹窗）
    if (f.size > 5 * 1024 * 1024) {
      confirmDialog({ title: t("theme.imageTooLarge"), alert: true });
      return;
    }
    const reader = new FileReader();
    // 先转码到 CSS 变量 2MB 上限内再入状态（否则超限图片写进 --app-bg-image 会被整体拒收）
    reader.onload = async () =>
      patch({ bgImage: await compressBgImage(reader.result) });
    reader.readAsDataURL(f);
    e.target.value = "";
  };

  // ── 主题导入 / 导出：accent + 深浅模式 + look 全量打包 JSON；图片 data URL 直接内嵌 ──

  const exportTheme = () => {
    const data = {
      app: "BIT",
      version: 1,
      exportedAt: new Date().toISOString(),
      theme: localStorage.getItem("bit.theme.v1") || "dark",
      accent,
      look,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `BIT-theme-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  const onImportFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      confirmDialog({
        title: t("theme.importTooLarge", "主题文件过大（≤5MB）"),
        alert: true,
      });
      return;
    }
    let obj;
    try {
      obj = JSON.parse(await f.text());
    } catch {
      confirmDialog({
        title: t("theme.importBad", "主题文件解析失败"),
        alert: true,
      });
      return;
    }
    if (!obj || typeof obj.look !== "object" || obj.look === null) {
      confirmDialog({
        title: t("theme.importBad", "不是有效的主题文件"),
        alert: true,
      });
      return;
    }
    if (
      !(await confirmDialog({
        title: t("theme.importConfirm", "导入将覆盖当前外观配置，继续？"),
      }))
    )
      return;
    // 缺省键回退默认；背景图（全局/输入框/聊天框）超 CSS 变量 2MB 上限时自动转码
    const incoming = { ...DEFAULT_LOOK, ...obj.look, enabled: true };
    for (const k of ["bgImage", "fieldBgImage", "chatBgImage"]) {
      if (typeof incoming[k] === "string" && incoming[k].startsWith("data:")) {
        incoming[k] = await compressBgImage(incoming[k]);
      }
    }
    setLook(incoming);
    if (typeof obj.accent === "string") setAccent(obj.accent);
    if (obj.theme === "light" || obj.theme === "dark" || obj.theme === "auto")
      setMode(obj.theme);
  };

  const PRESET_COLORS = [
    "#ffffff",
    "#fafafa",
    "#f5f5f5",
    "#faf5f0",
    "#f0f7ff",
    "#fffbeb",
    "#0a0a0a",
    "#171717",
    "#1c1917",
    "#0f172a",
    "#1e1b4b",
    "#18181b",
  ];

  return (
    <div className="page">
      {/* 开关总控 + 主题导入导出/恢复默认：同属「外观总控」这张卡 */}
      <section className="set-group" id="set-theme-master" style={gstyle("theme-master")}>
        <div className="set-grid">
          <div className="card flex items-center justify-between">
            <div>
              <div className="font-medium">{t("theme.enable", "启用外观定制")}</div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                {t("theme.enableHint", "关闭后恢复默认黑白胶囊风格")}
              </div>
            </div>
            <PillSwitch
              checked={look.enabled}
              onChange={(v) => setLook((l) => ({ ...l, enabled: v }))}
            />
          </div>
          {/* 导入 / 导出 / 恢复默认：与总开关同属"外观总控"，按钮不再悬空在无标题面板里 */}
          <div className="card flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("theme.filesTitle", "主题文件")}</div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                {t("theme.filesHint", "导入或导出整份外观配置；恢复默认会一并清空背景图与自定义颜色。")}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                onChange={onImportFile}
                className="hidden"
              />
              <button
                onClick={() => importRef.current?.click()}
                className="pill-outline pill-hover text-xs"
              >
                {t("theme.import", "导入主题")}
              </button>
              <button onClick={exportTheme} className="pill-outline pill-hover text-xs">
                {t("theme.export", "导出主题")}
              </button>
              <button onClick={reset} className="pill text-xs" title={t("theme.reset", "恢复默认外观")}>
                {t("theme.reset", "恢复默认")}
              </button>
            </div>
          </div>
        </div>
      </section>

      <div
        className={`flex flex-col gap-3 ${!look.enabled ? "opacity-40 pointer-events-none" : ""}`}
      >
        <section className="set-group" id="set-theme-accent" style={gstyle("theme-accent")}>
          <div className="set-grid">
            {/* ==== 主题色（Accent） ==== */}
            <div className="card">
              <div className="mb-3 flex flex-wrap gap-2">
                {ACCENT_PRESETS.map(({ color, label }) => (
                  <button
                    key={label}
                    title={color || t("theme.reset", "默认")}
                    onClick={() => setAccent(color || "")}
                    className={`h-7 w-7 rounded-full border-2 transition-transform duration-200 hover:scale-110 ${
                      (accent || "") === (color || "") &&
                      (accent || label) === (color || label)
                        ? "scale-110 border-neutral-900 dark:border-white"
                        : "border-transparent"
                    }`}
                    style={{
                      background:
                        color ||
                        "conic-gradient(#ef4444,#f59e0b,#22c55e,#06b6d4,#6366f1,#d946ef,#ef4444)",
                    }}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={accent || "#2563eb"}
                  onChange={(e) => setAccent(e.target.value)}
                  className="h-8 w-12 cursor-pointer rounded-lg border border-neutral-200 bg-transparent p-0.5 dark:border-neutral-700"
                />
                <span className="text-xs text-neutral-400">
                  {t("theme.custom", "自定义颜色")}
                </span>
                <span className="ml-auto font-mono text-xs text-neutral-500 dark:text-neutral-400">
                  {accent || "default"}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="set-group" id="set-theme-bg" style={gstyle("theme-bg")}>
          <div className="set-grid">
            {/* ==== 背景色 ==== */}
            <div className="card space-y-4">
              <div className="font-medium">
                {t("theme.bgColor", "背景颜色")}
              </div>

              {/* 亮色背景 */}
              <div>
                <label className="mb-2 flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
                  <span>{t("theme.bgLight", "亮色背景")}</span>
                  <span className="font-mono">{look.bgColorLight}</span>
                </label>
                <ColorInput
                  value={look.bgColorLight}
                  onChange={(v) => patch({ bgColorLight: v })}
                  presets={PRESET_COLORS.slice(0, 6)}
                />
              </div>

              {/* 暗色背景 */}
              <div>
                <label className="mb-2 flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
                  <span>{t("theme.bgDark", "暗色背景")}</span>
                  <span className="font-mono">{look.bgColorDark}</span>
                </label>
                <ColorInput
                  value={look.bgColorDark}
                  onChange={(v) => patch({ bgColorDark: v })}
                  presets={PRESET_COLORS.slice(6)}
                />
              </div>
            </div>

            {/* ==== 背景透明度 ==== */}
            <div className="card">
              <label className="mb-3 flex items-center justify-between">
                <span className="font-medium">
                  {t("theme.bgOpacity", "背景透明度")}
                </span>
                <span className="font-mono text-sm text-neutral-500 dark:text-neutral-400">
                  {look.bgOpacity}%
                </span>
              </label>
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={look.bgOpacity}
                onChange={(e) => patch({ bgOpacity: Number(e.target.value) })}
                className="w-full accent-[var(--accent)]"
              />
              <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                <span>{t("theme.bgTransparent", "更透明")}</span>
                <span>{t("theme.bgOpaque", "完全不透明")}</span>
              </div>
            </div>

            {/* ==== 卡片透明度（卡片/胶囊/输入域等；默认跟随背景，可独立固定） ==== */}
            <div className="card">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-medium">
                  {t("theme.cardOpacity", "卡片透明度")}
                </span>
                <span className="flex items-center gap-2">
                  {look.cardOpacity != null && (
                    <button
                      type="button"
                      onClick={() => patch({ cardOpacity: undefined })}
                      className="pill-outline text-[11px]"
                    >
                      {t("theme.cardFollowBg", "跟随背景")}
                    </button>
                  )}
                  <span className="font-mono text-sm text-neutral-500 dark:text-neutral-400">
                    {cardOp}%
                  </span>
                </span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={cardOp}
                aria-label={t("theme.cardOpacity", "卡片透明度")}
                onChange={(e) => patch({ cardOpacity: Number(e.target.value) })}
                className="w-full accent-[var(--accent)]"
              />
              <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                <span>{t("theme.bgTransparent", "更透明")}</span>
                <span>{t("theme.bgOpaque", "完全不透明")}</span>
              </div>
              <div className="mt-1 text-[11px] text-neutral-400">
                {t(
                  "theme.cardOpacityHint",
                  "作用于设置卡片、胶囊按钮和输入域；默认自动跟随背景透明度",
                )}
              </div>
            </div>

            {/* ==== 背景图片 ==== */}
            <div className="card">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">
                    {t("theme.bgImage", "背景图片")}
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t("theme.bgImageHint", "支持 JPG / PNG / WEBP，≤5MB")}
                  </div>
                </div>
                {look.bgImage && (
                  <button
                    onClick={() => patch({ bgImage: "" })}
                    className="icon-btn"
                    title={t("theme.removeImage", "移除图片")}
                  >
                    <IconTrash size={14} />
                  </button>
                )}
              </div>

              {look.bgImage ? (
                <div className="relative h-40 w-full overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
                  <img
                    src={look.bgImage}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  <div className="absolute bottom-2 right-2 rounded-full bg-black/50 px-2 py-0.5 text-[11px] text-white">
                    {t("theme.imageApplied", "已应用")}
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex h-32 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-neutral-300 text-neutral-500 transition-colors hover:border-neutral-500 hover:text-neutral-700 dark:border-neutral-700 dark:hover:border-neutral-400 dark:hover:text-neutral-200"
                >
                  <IconImage size={20} />
                  <span>{t("theme.uploadImage", "点击上传背景图片")}</span>
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={onPickFile}
                className="hidden"
              />
              {/* 遮罩浓度：默认 0 = 原图原色无色差；图过亮压不住文字时再调 */}
              {look.bgImage && (
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t("theme.bgScrim", "遮罩浓度")}
                    </span>
                    <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
                      {look.bgScrim ?? 0}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="60"
                    step="5"
                    value={look.bgScrim ?? 0}
                    aria-label={t("theme.bgScrim", "遮罩浓度")}
                    onChange={(e) => patch({ bgScrim: Number(e.target.value) })}
                    className="w-full accent-[var(--accent)]"
                  />
                  <div className="mt-1 text-[11px] text-neutral-400">
                    {t(
                      "theme.bgScrimHint",
                      "0 = 保持原图色彩；背景图太亮影响文字可读时可适当加深",
                    )}
                  </div>
                </div>
              )}
            </div>
            {/* 面板专属背景：消息区 / 输入区各一张，独立于全局背景（拆分时被漏掉，补回） */}
            <PanelBgCard
              title={t("theme.chatBg")}
              hint={t("theme.chatBgHint")}
              imgKey="chatBgImage"
              alphaKey="chatBgOpacity"
              look={look}
              patch={patch}
            />
            <PanelBgCard
              title={t("theme.inputBg")}
              hint={t("theme.inputBgHint")}
              imgKey="fieldBgImage"
              alphaKey="fieldBgOpacity"
              look={look}
              patch={patch}
            />
          </div>
        </section>

        <section className="set-group" id="set-theme-details" style={gstyle("theme-details")}>
          <div className="set-grid">
            {/* ==== 外观细节开关（页头已给出本页标题，卡里不再重复） ==== */}
            <div className="card space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">{t("theme.border", "显示边框")}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t("theme.borderHint", "去除卡片 / 按钮的描边")}
                  </div>
                </div>
                <PillSwitch
                  checked={look.borderOn}
                  onChange={(v) => patch({ borderOn: v })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">{t("theme.shadow", "显示阴影")}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t("theme.shadowHint", "去除卡片投影")}
                  </div>
                </div>
                <PillSwitch
                  checked={look.shadowOn}
                  onChange={(v) => patch({ shadowOn: v })}
                />
              </div>

              {/* 图标栏 tooltip 开关：只影响左侧圆片，页眉工具按钮的名称提示不受控 */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">{t("theme.navLabel")}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t("theme.navLabelHint")}
                  </div>
                </div>
                <PillSwitch
                  checked={look.navLabelOn !== false}
                  onChange={(v) => patch({ navLabelOn: v })}
                />
              </div>

              {/* 图标位拖拽：总开关 + 一键恢复各组默认顺序 */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">{t("settings.toolDrag")}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t("settings.toolDragHint")}
                  </div>
                </div>
                <PillSwitch checked={toolDrag} onChange={toggleToolDrag} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">
                  {t("settings.toolLayoutResetHint")}
                </p>
                <button onClick={() => resetAllIconLayouts()} className="pill pill-hover shrink-0 text-xs">
                  {t("settings.toolLayoutReset")}
                </button>
              </div>

              {/* 图标栏大小：圆片边长 + 图标 + 整条栏宽一起等比走（App.jsx 读同一个 look.navSize） */}
              <div>
                <label className="mb-2 flex items-center justify-between text-sm">
                  <span>{t("theme.navSize", "图标栏大小")}</span>
                  <span className="font-mono text-neutral-500 dark:text-neutral-400">
                    {railItemPx(look)}px
                  </span>
                </label>
                <input
                  type="range"
                  min="20"
                  max="48"
                  step="2"
                  value={railItemPx(look)}
                  onChange={(e) => patch({ navSize: Number(e.target.value) })}
                  className="w-full accent-[var(--accent)]"
                />
                <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                  <span>{t("theme.navCompact", "紧凑")}</span>
                  <span>{t("theme.navLarge", "较大")}</span>
                </div>
                <div className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {t("theme.navSizeHint", "圆片边长，整条栏宽跟着缩放")}
                </div>
              </div>

              {/* 搜索控件样式：一处开关，三处生效（设置 / 会话列表 / Ctrl K 悬浮面板）的放大镜着色 */}
              <div>
                <div className="mb-2 text-sm">{t("theme.searchStyle")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    ["auto", t("theme.searchAuto")],
                    ["accent", t("theme.searchAccent")],
                    ["ghost", t("theme.searchGhost")],
                  ].map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => patch({ searchStyle: v })}
                      className={`pill-hover px-3 py-1 text-xs ${
                        (look.searchStyle || "auto") === v
                          ? "pill"
                          : "pill-outline"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {t("theme.searchStyleHint")}
                </div>
              </div>

              <div>
                <label className="mb-2 flex items-center justify-between text-sm">
                  <span>{t("theme.cardRadius", "卡片圆角")}</span>
                  <span className="font-mono text-neutral-500 dark:text-neutral-400">
                    {look.cardRadius}px
                  </span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="48"
                  step="4"
                  value={look.cardRadius}
                  onChange={(e) =>
                    patch({ cardRadius: Number(e.target.value) })
                  }
                  className="w-full accent-[var(--accent)]"
                />
                <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                  <span>{t("theme.square", "直角")}</span>
                  <span>{t("theme.rounded", "圆润")}</span>
                </div>
              </div>

              <div>
                <label className="mb-2 flex items-center justify-between text-sm">
                  <span>{t("theme.uiRadius", "输入框/对话圆角")}</span>
                  <span className="font-mono text-neutral-500 dark:text-neutral-400">
                    {(look.uiRadius ?? 0) === 0
                      ? t("theme.uiDefault", "默认")
                      : `${look.uiRadius}px`}
                  </span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="40"
                  step="2"
                  value={look.uiRadius ?? 0}
                  onChange={(e) => patch({ uiRadius: Number(e.target.value) })}
                  className="w-full accent-[var(--accent)]"
                />
                <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                  <span>{t("theme.uiDefault", "默认")}</span>
                  <span>{t("theme.rounded", "圆润")}</span>
                </div>
              </div>

              <div>
                <label className="mb-2 flex items-center justify-between text-sm">
                  <span>{t("theme.winRadius", "窗口外圆角")}</span>
                  <span className="font-mono text-neutral-500 dark:text-neutral-400">
                    {look.winRadius ?? 0}px
                  </span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="32"
                  step="2"
                  value={look.winRadius ?? 0}
                  onChange={(e) => patch({ winRadius: Number(e.target.value) })}
                  className="w-full accent-[var(--accent)]"
                />
                <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                  <span>{t("theme.square", "直角")}</span>
                  <span>{t("theme.rounded", "圆润")}</span>
                </div>
              </div>

              <div>
                <label className="mb-2 flex items-center justify-between text-sm">
                  <span>{t("theme.fontScale", "字体大小")}</span>
                  <span className="font-mono text-neutral-500 dark:text-neutral-400">
                    {Math.round(
                      Math.min(1.2, Math.max(0.85, look.fontScale ?? 1)) * 100,
                    )}
                    %
                  </span>
                </label>
                <input
                  type="range"
                  min="0.85"
                  max="1.2"
                  step="0.05"
                  value={Math.min(1.2, Math.max(0.85, look.fontScale ?? 1))}
                  onChange={(e) => patch({ fontScale: Number(e.target.value) })}
                  className="w-full accent-[var(--accent)]"
                />
                <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                  <span>{t("theme.fontSmall", "小")}</span>
                  <span>{t("theme.fontLarge", "大")}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

    </div>
  );
}

/** 输入框 / 聊天框专属背景卡片：背景图上传 + 独立透明度滑块（无图且 100% = 原样式） */
function PanelBgCard({ title, hint, imgKey, alphaKey, look, patch }) {
  const { t } = useLang();
  const fileRef = useRef(null);

  const onPickFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      confirmDialog({ title: t("theme.imageTooLarge"), alert: true });
      return;
    }
    const reader = new FileReader();
    // 与全局背景图一致：先转码到 CSS 变量 2MB 上限内再入状态
    reader.onload = async () =>
      patch({ [imgKey]: await compressBgImage(reader.result) });
    reader.readAsDataURL(f);
    e.target.value = "";
  };

  const alpha = look[alphaKey] ?? 100;

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            {hint}
          </div>
        </div>
        {look[imgKey] && (
          <button
            onClick={() => patch({ [imgKey]: "" })}
            className="icon-btn"
            title={t("theme.removeImage")}
          >
            <IconTrash size={14} />
          </button>
        )}
      </div>

      {look[imgKey] ? (
        <div className="relative mb-4 h-28 w-full overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
          <img
            src={look[imgKey]}
            alt=""
            className="h-full w-full object-cover"
          />
          <div className="absolute bottom-2 right-2 rounded-full bg-black/50 px-2 py-0.5 text-[11px] text-white">
            {t("theme.imageApplied")}
          </div>
        </div>
      ) : (
        <button
          onClick={() => fileRef.current?.click()}
          className="mb-4 flex h-24 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-neutral-300 text-neutral-500 transition-colors hover:border-neutral-500 hover:text-neutral-700 dark:border-neutral-700 dark:hover:border-neutral-400 dark:hover:text-neutral-200"
        >
          <IconImage size={18} />
          <span>{t("theme.uploadImage")}</span>
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={onPickFile}
        className="hidden"
      />

      <label className="mb-2 flex items-center justify-between text-sm">
        <span>{t("theme.bgOpacity")}</span>
        <span className="font-mono text-neutral-500 dark:text-neutral-400">
          {alpha}%
        </span>
      </label>
      <input
        type="range"
        min="10"
        max="100"
        step="5"
        value={alpha}
        onChange={(e) => patch({ [alphaKey]: Number(e.target.value) })}
        className="w-full accent-[var(--accent)]"
      />
      <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
        <span>{t("theme.bgTransparent")}</span>
        <span>{t("theme.bgOpaque")}</span>
      </div>
    </div>
  );
}

/** 颜色输入：preset 色点 + 原生 color picker */
function ColorInput({ value, onChange, presets }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-9 cursor-pointer rounded-lg border border-neutral-200 bg-transparent p-0.5 dark:border-neutral-700"
      />
      <div className="flex flex-wrap gap-1.5">
        {presets.map((c) => (
          <button
            key={c}
            onClick={() => onChange(c)}
            className={`h-6 w-6 rounded-md border transition-transform duration-200 hover:scale-110 ${
              value.toLowerCase() === c.toLowerCase()
                ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/30"
                : "border-neutral-200 dark:border-neutral-700"
            }`}
            style={{ backgroundColor: c }}
            title={c}
          />
        ))}
      </div>
    </div>
  );
}
