import { useLayoutEffect, useRef } from "react";

/// 全站图标栏共用的墨迹归一样式：页眉 / 左栏 / 对话页两排统一按这一档画图标。
export const GLYPH_INK = 13.5;

/// 墨迹归一：同一个 size 的 svg，实际墨迹在 24 格画布里只占 12~20 格，一排看过去能差三成。
/// 这里量一次 bbox，把 viewBox 收成「墨迹最长边 = ink 像素」的窗口并居中，描边同步换算成
/// 渲染后 ~1.35px——于是任意图标都和邻居一般大、线条一样粗。量不到（空路径 / 异常）就按原样画。
export function InkGlyph({ icon: Icon, size = GLYPH_INK, ink = GLYPH_INK, className }) {
  const ref = useRef(null);
  // 盒子不能比墨迹小，否则 viewBox 窗口小于墨迹，图标会被裁掉一圈
  const box = Math.max(size, ink);
  useLayoutEffect(() => {
    const svg = ref.current?.querySelector("svg");
    if (!svg) return;
    try {
      let x = Infinity;
      let y = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      for (const s of svg.querySelectorAll("path,circle,rect,line,polyline,polygon,ellipse")) {
        const b = s.getBBox();
        x = Math.min(x, b.x);
        y = Math.min(y, b.y);
        x2 = Math.max(x2, b.x + b.width);
        y2 = Math.max(y2, b.y + b.height);
      }
      const m = Math.max(x2 - x, y2 - y);
      if (!(m >= 0.01)) return;
      const v = (m * box) / ink; // 窗口 / 墨迹 = box / ink，墨迹正好落成 ink px
      svg.setAttribute("viewBox", `${(x + x2 - v) / 2} ${(y + y2 - v) / 2} ${v} ${v}`);
      svg.setAttribute("stroke-width", (m * 0.1).toFixed(3));
    } catch {
      /* 量不到就不归一，宁可大小不齐也别不画 */
    }
  }, [Icon, box, ink]);
  return (
    <span ref={ref} className="contents">
      <Icon size={box} className={className} />
    </span>
  );
}
