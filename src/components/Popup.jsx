/**
 * 图标自带的弹层：菜单 / 面板 / 浮窗 / 提示。
 *
 * 原来这些浮层写死 `absolute bottom-11 left-0`（对话页）或 `absolute top-7 right-0`（页眉），
 * 只按自己那一排算位置。同一颗按钮现在可能被拖到左栏、页眉、输入框工具栏或会话列表底下任何一排：
 * 页眉的按钮一旦挪到窗口下沿，菜单照旧往下开就整块开出屏外，用户点不到任何东西；
 * 对话页的按钮一旦挪进 208px 宽的侧栏，照 left-0 摊开又被侧栏横向裁掉。
 *
 * 这里不看宿主在哪一排，只看视口：优先开在按钮上方，上方塞不下才翻到下方；
 * 左右一律夹进视口内（靠右的按钮保持右对齐）。高度按剩余空间收住并内部滚动。
 * 锚点是父元素（那颗按钮所在的 relative 容器）。
 * 另外补上「点外面 / Esc 就收」——原来只有按钮自己会关，几颗挨着点会叠好几层。
 */
import { useEffect, useLayoutEffect, useRef } from "react";

const EDGE = 8; // 离视口边缘留的缝
const GAP = 8; // 和按钮之间的间隙

export default function Popup({ children, className = "", align = "start", onDismiss, ...rest }) {
  const ref = useRef(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const alignRef = useRef(align);
  alignRef.current = align;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const write = (prop, value) => {
      if (el.style[prop] !== value) el.style[prop] = value;
    };
    const place = () => {
      const host = el.parentElement;
      if (!host) return;
      const r = host.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      write("position", "fixed");
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      // 靠右的按钮保持右对齐（原来写 right-0 的那些），否则一律左对齐
      const start = alignRef.current === "end" ? r.right - w : r.left;
      const left = Math.min(Math.max(EDGE, start), Math.max(EDGE, vw - w - EDGE));
      let top = r.top - GAP - h; // 优先往上开
      if (top < EDGE) top = Math.min(Math.max(EDGE, vh - h - EDGE), r.bottom + GAP); // 上面塞不下才往下
      write("left", `${Math.round(left)}px`);
      write("top", `${Math.round(top)}px`);
      write("maxHeight", `${Math.max(80, Math.round(vh - top - EDGE))}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, []);

  useEffect(() => {
    const onDown = (e) => {
      const el = ref.current;
      if (!el || !dismissRef.current) return;
      if (el.contains(e.target)) return;
      const host = el.parentElement;
      if (host && host.contains(e.target)) return; // 按钮自己负责开关
      dismissRef.current();
    };
    const onKey = (e) => {
      if (e.key === "Escape" && dismissRef.current) dismissRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div ref={ref} className={`z-50 overflow-y-auto ${className}`} {...rest}>
      {children}
    </div>
  );
}
