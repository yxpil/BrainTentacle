/**
 * 插件清单声明的字形：24 格 viewBox 下的 path d 列表，描边风格与内置图标一致。
 * 作为 icon 组件交给 InkGlyph 做墨迹归一；后端已按白名单过滤路径，这里只画纯路径。
 */
export default function PluginGlyph({ paths = [], size = 24, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
