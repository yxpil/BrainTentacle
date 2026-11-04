/**
 * 一条图标排：按 iconLayout 给的顺序画出来，外加两件本体没有的事——
 * ① 放不下时把尾部折进「⋯」，窗口拉宽 / 摘掉几个再自己摊回来；
 * ② 右键图标 = 把它从这一排摘掉（进本组的图标库），右键这一排的空白 = 从图标库里补一个回来。
 *
 * 顺序、隐藏位、拖拽开关都在 iconLayout.js，这里只管画和交互；
 * 对话页两排、页眉工具簇都用它，左栏导航因为要挂圆片指示器所以自己画、只借 IconMenu。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n.js";
import { LiveIcon, iconNode, iconText } from "../iconSpace.jsx";
import { ZONE_LABEL_KEYS } from "../iconLayout.js";
import { IconMore } from "./Icons.jsx";
import { InkGlyph, GLYPH_INK } from "./InkGlyph.jsx";

const GAP = 4; // 图标之间的间隙 + 一点余量，用来估「还塞得下下一个吗」
const SLACK = 2; // 摊回时多要的两像素：临界宽度上有点亚像素误差也别来回打摆

/**
 * 一排被宿主用 max-height 限住时，「可用高度」是那条上限本身，不是折完后的实际高度——
 * 拿 clientHeight 量，一折就跟着缩，摊回的判据永远追不上。
 * Chrome 对百分比 max-height 只返回 "45%"，所以按父容器（侧栏那一列）的内容高现算。
 */
function capHeight(el, cs) {
  const mh = cs.maxHeight;
  if (!mh || mh === "none") return Infinity;
  const n = parseFloat(mh);
  if (!Number.isFinite(n)) return Infinity;
  if (!mh.endsWith("%")) return n;
  const p = el.parentElement;
  if (!p) return Infinity;
  const pcs = getComputedStyle(p);
  const h =
    p.getBoundingClientRect().height -
    (parseFloat(pcs.paddingTop) || 0) -
    (parseFloat(pcs.paddingBottom) || 0) -
    (parseFloat(pcs.borderTopWidth) || 0) -
    (parseFloat(pcs.borderBottomWidth) || 0);
  return h > 0 ? (h * n) / 100 : Infinity;
}

/** 弹层菜单：右键图标 / 右键空白 / 「⋯」都用这一张 */
export function IconMenu({ x, y, items, onClose }) {
  useEffect(() => {
    const k = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const w = 216;
  // 图标库 + 其它区的图标可能很多：菜单按视口高度封顶后内部滚动，别顶出屏幕
  const maxH = Math.max(160, window.innerHeight - 12);
  const h = Math.min(
    items.reduce((n, it) => n + (it.hint ? 46 : 28), 8),
    maxH,
  );
  const left = Math.max(6, Math.min(x, window.innerWidth - w - 6));
  const top = Math.max(6, Math.min(y, window.innerHeight - h - 6));
  return (
    <>
      <div className="fixed inset-0 z-[70]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        data-bit-menu="1"
        className="card anim-pop fixed z-[71] flex flex-col gap-0.5 overflow-y-auto p-1"
        style={{ left, top, width: w, maxHeight: maxH }}
      >
        {items.map((it) =>
          it.disabled ? (
            <div key={it.key} className="px-2.5 py-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
              {it.label}
            </div>
          ) : (
            <button
              key={it.key}
              type="button"
              onClick={() => {
                onClose();
                it.onSelect?.();
              }}
              className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-neutral-700 transition-colors hover:bg-neutral-900/5 dark:text-neutral-200 dark:hover:bg-white/10"
            >
              <span>{it.label}</span>
              {it.hint && <span className="text-[10px] text-neutral-400 dark:text-neutral-500">{it.hint}</span>}
            </button>
          ),
        )}
      </div>
    </>
  );
}

/**
 * @param layout    useIconLayout() 的返回值
 * @param zone      这一排对应的区名
 * @param nodes     id -> 图标节点；没有节点的上不了屏（比如截图位在当前平台不可用）
 * @param className 排本身的样式（flex 方向、宽度上限、min-height 这些宿主定）
 * @param slotClass id -> 格子附加样式（图标自己带弹层时要 relative）
 * @param maxLines  换行排允许几行，超出才折进「⋯」
 * @param fitHeight 换行排按宿主给的 max-height 判折叠（侧栏底栏那种「能排几行就排几行」）；
 *                  行数上限是个拍脑袋的数，会把明明还有竖向空间的一排提前折掉
 * @param nowrap    不换行的排（页眉只有 36px 高）：按「还能往左长多少」判折叠
 * @param minGap    nowrap 排与左边兄弟至少留出的间隙（页眉留给仪表盘文字）
 * @param fitPx     从别的表面拖来的图标，按这一排的格子尺寸收拢（各排按钮本就大小不一）
 * @param maxVisible 这一排最多露几颗，超出的不论宽度够不够都收进「⋯」
 * @param popClass  「⋯」浮层的挂法（默认往左上挂，页眉那种要往右下挂）
 * @param addMenuRef 宿主借出去的一只手：有些排紧贴图标就没了空白（页眉那一簇），
 *                    把这只 ref 交给宿主，让宿主拿自己页面上的空白（页眉中间的拖动区）
 *                    去弹同一张图标库菜单
 */
export default function IconRow({
  layout,
  zone,
  nodes,
  labels,
  className = "",
  slotClass,
  maxLines = 1,
  fitHeight = false,
  nowrap = false,
  shrinkSlots = false,
  minGap = 0,
  fitPx = 0,
  maxVisible = 0,
  popClass = "bottom-8 left-0",
  addMenuRef,
  style,
  children,
}) {
  // 节点可能来自别的表面（拖动互通的图标），所以先在注册表里找，再退回宿主给的表
  const nodeOf = (id) => iconNode(id) || nodes[id];
  const ids = layout.order(zone).filter((id) => nodeOf(id));
  const idKey = ids.join("|");
  const [fold, setFold] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  // 布局锁定时，浮层里的图标开了内联弹层，就把浮层撑开而不是收掉（见 pickFolded）
  const [nested, setNested] = useState(false);
  const [menu, setMenu] = useState(null); // {x, y, items}
  const rowRef = useRef(null);
  const tightAt = useRef({ ids: "", avail: -1 }); // 在哪个可用宽度上曾经折过一次（见折叠判分处）

  // 上限之外的固定折起，和按宽度量出来的 fold 叠加：fold 只记「装不下多折了几颗」
  const capFold = maxVisible > 0 ? Math.max(0, ids.length - maxVisible) : 0;
  const totalFold = Math.max(fold, capFold);
  const keep = totalFold > 0 ? Math.max(1, ids.length - totalFold) : ids.length;
  const shown = ids.slice(0, keep);
  const folded = ids.slice(keep);

  // 折叠数量靠量出来的：一次折一个 / 一次摊回一个，配合 ResizeObserver 迭代收敛。
  // 展开要留出「一个图标」的余量才动，否则临界宽度上会一帧折一帧摊地抖。
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const run = () => {
      const slots = [...el.querySelectorAll(":scope > [data-bit-icon-id], :scope > [data-bit-icon-more]")];
      const more = el.querySelector(":scope > [data-bit-icon-more]");
      const rects = slots.map((k) => k.getBoundingClientRect());
      const iconRects = more ? rects.slice(0, -1) : rects;
      // 能不能折看的是「这一排一共有几个图标」，不是屏上露了几个：
      // 折到只剩一颗时屏上只有 1 个格子 + 「⋯」，按屏上数量判会把折叠清掉，
      // 清掉又立刻放不下——两条规则对着打，就变成 setState 死循环。
      if (ids.length < 2 || iconRects.length === 0) {
        setFold((f) => (f ? 0 : f));
        return;
      }
      const r = el.getBoundingClientRect();
      // 「⋯」永远画在露出的图标后面，所以最后一格要么是它、要么是最后一颗图标
      const lastIcon = iconRects[iconRects.length - 1];
      const moreRect = more ? rects[rects.length - 1] : null;
      // 摊回一颗图标的净增宽：还继续折着时「⋯」原地不动，就多出一个图标 + 一道间隙；
      // 只有这一步恰好摊平（fold 1 → 0），「⋯」让位给图标，才把它占的扣回来。
      // 少算这一格就会在临界宽度上一帧折一帧摊地对打（ResizeObserver 会把循环拉到无限）。
      const backW = lastIcon.width + GAP - (totalFold === 1 && moreRect ? moreRect.width + GAP : 0);
      const used = rects[rects.length - 1].right - r.left;
      let over; // 现在这样已经放不下了
      let fits; // 摊回一个也还放得下
      let avail; // 这一排当下可用的宽度
      if (nowrap) {
        // 这种排贴着右边界、左边是弹性兄弟：能占的宽度要从「右边还有多少固定兄弟（窗口按钮）」
        // 量到「左边兄弟的左边界」。只看自己的 r.right 不行——窄窗口下这一排会把后面的
        // 窗口按钮顶出视口，自己成了最右元素，就永远量不出「放不下」。
        const sib = el.previousElementSibling;
        const parent = el.parentElement;
        const padR = parseFloat(getComputedStyle(parent).paddingRight) || 0;
        let bound = parent.getBoundingClientRect().right - padR;
        for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
          const nb = n.getBoundingClientRect();
          if (nb.width > 0) bound = Math.min(bound, nb.left);
        }
        avail = bound - (sib ? sib.getBoundingClientRect().left : el.getBoundingClientRect().left) - minGap;
        over = used > avail;
        fits = used + backW + SLACK <= avail;
      } else {
        // 分行按「格子的垂直中心」聚：同一行的格子被 items-center 居中，
        // 高矮不一样（图标 34、「⋯」24）顶边就会差几像素——拿 top 判会凭空多出一行，
        // 于是怎么折都「放不下」，一路折到只剩一颗。
        const cs = getComputedStyle(el);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        const availW = r.width - padL - padR;
        const lastRight = rects[rects.length - 1].right - r.left - padL;
        if (fitHeight) {
          // 能换行、高度由宿主 max-height 限住：折多少看「还剩多高」。
          // 不能再按行数封顶——侧栏底栏明明还有大半截空着，凑到第三行就折是没有道理的。
          avail = capHeight(el, cs);
          over = el.scrollHeight > avail + 1;
          const lineH = Math.max(...rects.map((x) => x.height)) + (parseFloat(cs.rowGap) || 0);
          const wraps = lastIcon.width + GAP > availW - lastRight;
          fits = !wraps || el.scrollHeight + lineH <= avail + 1;
        } else {
          const mids = rects.map((x) => x.top + x.height / 2).sort((a, b) => a - b);
          let lines = 1;
          for (let i = 1; i < mids.length; i++) if (mids[i] - mids[i - 1] > 10) lines++;
          const lastMid = mids[mids.length - 1];
          const rightMost = Math.max(...rects.filter((x) => Math.abs(x.top + x.height / 2 - lastMid) <= 10).map((x) => x.right));
          avail = availW;
          over = lines > maxLines;
          fits = rightMost - r.left - padL + backW + SLACK <= avail;
        }
      }
      // 图标增减（右键摘掉 / 插件装卸）后前面那条「这个宽度放不下」就作废，
      // 否则摘掉一颗也会因为可用宽度没变而赖在折叠态不走。
      if (tightAt.ids !== idKey) {
        tightAt.ids = idKey;
        tightAt.avail = -1;
      }
      if (over) {
        tightAt.avail = Math.max(tightAt.avail, avail);
        // 上限已经折着的时候，从上限再往外折，别让 fold 从 0 一颗颗追（那几帧画面上没变化）
        setFold((f) => {
          const base = Math.max(f, capFold);
          return base >= ids.length - 1 ? base : Math.min(base + 1, ids.length - 1);
        });
      } else if (fold > 0 && fits && avail > tightAt.avail) {
        setFold((f) => Math.max(0, f - 1));
      }
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(el);
    // fitHeight 的判据在父容器的高度上；nowrap 的可用宽度取决于父容器与右侧兄弟的位置。
    // 只盯自己时，缩窗后这一排尺寸不变，就永远等不到重算。
    if (fitHeight || nowrap) {
      if (el.parentElement) ro.observe(el.parentElement);
    }
    return () => ro.disconnect();
  }, [idKey, fold, capFold, maxLines, fitHeight, nowrap, minGap]);

  const labelOf = (id) => labels?.[id] || iconText(id);

  /**
   * 点「⋯」里的图标：节点自带内联弹层（附件菜单 / 后台任务面板 / 模型列表…）时，
   * 先把这颗图标挪回排上的可见位置，再收浮层——浮层一卸，节点连同弹层都会跟着消失。
   * 普通动作（预览 / 网页 / 主题…）点完照旧只收浮层，不动排位。
   * 布局锁定时挪不动，就地把浮层撑开，弹层至少还能用。
   */
  const pickFolded = (e, id) => {
    const el = e.currentTarget;
    // 点击前的 DOM：节点要等 iconSpace 那一帧通知才重画，此刻读到的还是旧一帧
    const had = !!el.querySelector(".card");
    let tries = 0;
    const decide = () => {
      if (!el.isConnected) return; // 浮层已经自己关了，不必再动
      const has = !!el.querySelector(".card");
      if (has && !had) {
        // 刚打开了内联弹层
        if (!layout.enabled) {
          setNested(true); // 布局锁定、挪不动：浮层不收，就地让弹层露出来
          return;
        }
        layout.move(id, zone, Math.max(0, keep - 1));
        setMoreOpen(false);
        return;
      }
      if (!has && had) {
        setMoreOpen(false); // 这点下去是把已开的弹层收掉
        return;
      }
      // 节点还没重画（或本来就没有弹层）：再等几帧，普通动作等满后照旧收浮层
      if (++tries < 6) setTimeout(decide, 30);
      else setMoreOpen(false);
    };
    requestAnimationFrame(decide);
  };

  const hideMenu = (e, id) => {
    if (!layout.enabled) return; // 总开关关掉 = 这一排只读
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items: [{ key: "hide", label: t("icon.hide"), hint: labelOf(id), onSelect: () => layout.hide(id) }] });
  };

  const addMenu = (e) => {
    if (!layout.enabled) return;
    if (e.target.closest("[data-bit-icon-id]") || e.target.closest("[data-bit-icon-more]")) return;
    e.preventDefault();
    // 全站每颗图标只有一份：先从别区挪（挪完原处消失），再补图标库里被摘掉的。
    // 两个清单都只列已知节点，插件卸载后残留的 id 不会以空按钮混进来。
    const moves = layout.elsewhere(zone).filter((id) => nodeOf(id));
    const lib = layout.library().filter((id) => nodeOf(id));
    const items = [];
    if (moves.length) {
      items.push({ key: "move-head", label: t("icon.moveTitle"), disabled: true });
      for (const id of moves) {
        const zk = ZONE_LABEL_KEYS[layout.zoneOf(id)];
        items.push({
          key: "move:" + id,
          label: labelOf(id),
          hint: zk ? t(zk) : undefined,
          onSelect: () => layout.show(id, zone),
        });
      }
    }
    if (lib.length) {
      items.push({ key: "lib-head", label: t("icon.addTitle"), disabled: true });
      for (const id of lib) items.push({ key: "lib:" + id, label: labelOf(id), onSelect: () => layout.show(id, zone) });
    }
    if (!items.length) items.push({ key: "none", label: t("icon.addEmpty"), disabled: true });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // 宿主页面上的空白（比如页眉中间那块拖动区）也借这一只手点开同一张图标库菜单
  useEffect(() => {
    if (addMenuRef) addMenuRef.current = addMenu;
  });

  useEffect(() => {
    if (!moreOpen) setNested(false);
  }, [moreOpen]);

  // 浮层里的图标被拖到别区后，源节点会随列表重排先被摘掉，dragend 落不到它身上，
  // 浮层就收不回去了；补一个 window 级 drop/dragend，拖完落在哪都收。
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    window.addEventListener("drop", close);
    window.addEventListener("dragend", close);
    return () => {
      window.removeEventListener("drop", close);
      window.removeEventListener("dragend", close);
    };
  }, [moreOpen]);

  const isForeign = (id) => fitPx > 0 && !nodes[id] && !!iconNode(id);
  const foreignCls =
    "items-center [&>*]:h-full [&>*]:w-full [&>button]:h-full [&>button]:w-full [&>div>button]:h-full [&>div>button]:w-full";
  const slot = (id) => {
    const sp = layout.slotProps(zone, id);
    const cls = shrinkSlots ? sp.className.replace("shrink-0", "min-w-0") : sp.className;
    // 别区来的图标自带原来的格子尺寸（页眉 24 / 对话页 34），在这一排里要收成同一号
    if (!isForeign(id)) return { ...sp, className: `${cls} ${slotClass?.(id) || ""}`.trim() };
    return {
      ...sp,
      style: { width: fitPx, height: fitPx },
      className: `${cls} ${foreignCls} ${slotClass?.(id) || ""}`.trim(),
    };
  };
  const fitStyle = (id) => (isForeign(id) ? { width: fitPx, height: fitPx } : undefined);

  return (
    <div
      ref={rowRef}
      className={`flex items-center gap-0.5 ${nowrap ? "" : "flex-wrap"} ${className}`}
      style={style}
      onContextMenu={addMenu}
      {...layout.zoneProps(zone)}
    >
      {shown.map((id) => (
        <div key={id} {...slot(id)} onContextMenu={(e) => hideMenu(e, id)}>
          <LiveIcon id={id} node={nodes[id]} />
        </div>
      ))}
      {folded.length > 0 && (
        <div data-bit-icon-more className={`relative shrink-0 ${nowrap ? "min-w-0" : ""}`}>
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            title={t("icon.moreHint", { n: folded.length })}
            aria-label={t("icon.more")}
            className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
              moreOpen
                ? "bg-neutral-900/10 text-neutral-900 dark:bg-white/10 dark:text-white"
                : "text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-white"
            }`}
          >
            <InkGlyph icon={IconMore} size={14} ink={GLYPH_INK} />
          </button>
          {moreOpen && (
            <>
              {/* 拖拽时让开点击背板，不然浮层盖住的区域接不到 dragover */}
              <div className={`fixed inset-0 z-40 ${layout.draggingId ? "pointer-events-none" : ""}`} onClick={() => setMoreOpen(false)} />
              <div className={`card anim-pop absolute z-50 flex max-h-72 flex-wrap items-start gap-0.5 p-1.5 ${nested ? "overflow-visible" : "overflow-y-auto"} ${popClass}`}>
                {folded.map((id) => {
                  // pin：悬停不落位，松手才搬。浮层里的节点一旦被挪回排上就会卸载，拖拽源随之丢失
                  const sp = layout.slotProps(zone, id, null, true);
                  return (
                    <div
                      key={id}
                      {...sp}
                      style={fitStyle(id)}
                      className={`${sp.className} ${slotClass?.(id) || ""} ${isForeign(id) ? foreignCls : ""}`.trim()}
                      onClick={(e) => pickFolded(e, id)}
                      onDragEnd={(e) => {
                        sp.onDragEnd(e);
                        setMoreOpen(false);
                      }}
                      onContextMenu={(e) => hideMenu(e, id)}
                    >
                      <LiveIcon id={id} node={nodes[id]} />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
      {children}
      {menu && <IconMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
