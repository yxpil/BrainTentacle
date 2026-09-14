var _a;
import { jsx } from "react/jsx-runtime";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { useState, useEffect } from "react";
const SVG_TAGS = [
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "marker",
  "pattern",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
  "filter",
  "feGaussianBlur",
  "feOffset",
  "feBlend",
  "feFlood",
  "feComposite"
];
const SVG_ATTRS = [
  "class",
  "id",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "xmlns",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "opacity",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "dx",
  "dy",
  "rotate",
  "gradientUnits",
  "offset",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "patternUnits",
  "filter",
  "in",
  "in2",
  "stdDeviation",
  "result",
  "mode"
];
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames || [], ...SVG_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...((_a = defaultSchema.attributes) == null ? void 0 : _a["*"]) || [], ...SVG_ATTRS]
  }
};
let mermaidSeq = 0;
let mermaidInited = false;
let mermaidInitedDark = null;
const mermaidSvgCache = /* @__PURE__ */ new Map();
let mermaidChain = Promise.resolve();
function Mermaid({ code, dark }) {
  const cacheKey = `${dark ? "d" : "l"}:${code}`;
  const [svg, setSvg] = useState(() => mermaidSvgCache.get(cacheKey) || "");
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (mermaidSvgCache.has(cacheKey)) {
      setSvg(mermaidSvgCache.get(cacheKey));
      setErr(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      (async () => {
        var _a2, _b;
        try {
          console.error("[mmd-step] 开始: code长度", code.length);
          const mermaid = (await import("mermaid")).default;
          console.error("[mmd-step] import 完成");
          if (!mermaidInited || mermaidInitedDark !== dark) {
            mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
            mermaidInited = true;
            mermaidInitedDark = dark;
          }
          const valid = await mermaid.parse(code, { suppressErrors: true });
          console.error("[mmd-step] parse:", valid ? "OK" : "FAIL");
          if (!valid) {
            if (alive) setErr(true);
            return;
          }
          const run = () => mermaid.render(`mmd-${++mermaidSeq}`, code);
          const task = mermaidChain.then(run, run);
          mermaidChain = task.catch(() => {
          });
          const out = await task;
          console.error("[mmd-step] render:", out ? "OK(" + out.length + "字符)" : "空");
          if (alive) {
            mermaidSvgCache.set(cacheKey, out);
            setSvg(out);
            setErr(false);
          }
        } catch {
          console.error("[mmd-step] 异常:", (_b = (_a2 = new Error().stack) == null ? void 0 : _a2.split("\n")[1]) == null ? void 0 : _b.trim());
          document.querySelectorAll("[id^='dmermaid'], [id^='dmmd-']").forEach((n) => n.remove());
          if (alive) setErr(true);
        }
      })();
    }, 450);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [cacheKey]);
  if (!svg) return /* @__PURE__ */ jsx("pre", { className: "my-1.5 overflow-x-auto rounded-lg bg-neutral-100 p-2.5 text-[0.85em] dark:bg-black/40", children: /* @__PURE__ */ jsx("code", { className: "font-mono text-[0.85em]", children: code }) });
  return /* @__PURE__ */ jsx("div", { className: "my-2 overflow-x-auto", dangerouslySetInnerHTML: { __html: svg } });
}
const MERMAID_FIRST_LINE = /^\s*(flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|quadrant|requirementDiagram|gitGraph|graph\s+(TB|TD|BT|RL|LR)\b|C4(Context|Container|Component|Dynamic|Deployment)\b|sankey(-beta)?|xychart(-beta)?|block(-beta)?|zenuml)\b/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const DIAGRAM_LINE = /^\s*(autonumber\b|participant\s|actor\s|note\s|alt\b|else\b|opt\b|loop\b|par\b|and\b|critical\b|option\b|break\b|rect\b|title\s|legend\s|end\b)|->>|-->>|-\)|--\)|-->|-\.|==|--o\{|--\|\{|\|o--|\|--/;
const ENTITY_OPEN = /^\s*[\w"']+\s*\{\s*$/;
function rescueMermaid(src) {
  const lines = src.split("\n");
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && MERMAID_FIRST_LINE.test(line)) {
      out.push("```mermaid");
      out.push(line);
      i++;
      let blank = 0;
      let inEntity = false;
      while (i < lines.length) {
        const l = lines[i];
        if (FENCE_RE.test(l)) break;
        if (l.trim() === "") {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === "") j++;
          if (j >= lines.length || !DIAGRAM_LINE.test(lines[j]) && !ENTITY_OPEN.test(lines[j]) && !inEntity) break;
          out.push(l);
          blank++;
          if (blank > 30) break;
          i++;
          continue;
        }
        if (inEntity) {
          out.push(l);
          if (l.includes("}")) inEntity = false;
          i++;
          continue;
        }
        if (!DIAGRAM_LINE.test(l)) {
          if (ENTITY_OPEN.test(l)) {
            inEntity = true;
            out.push(l);
            i++;
            continue;
          }
          break;
        }
        out.push(l);
        i++;
      }
      {
        let j = i;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length && FENCE_RE.test(lines[j])) {
          let k = j + 1;
          while (k < lines.length && !FENCE_RE.test(lines[k])) {
            out.push(lines[k]);
            k++;
          }
          i = k < lines.length ? k + 1 : k;
        }
      }
      out.push("```");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
function Markdown({ children }) {
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return /* @__PURE__ */ jsx("div", { className: "md text-sm leading-relaxed", children: /* @__PURE__ */ jsx(
    ReactMarkdown,
    {
      remarkPlugins: [remarkGfm, remarkMath, remarkBreaks],
      rehypePlugins: [rehypeRaw, [rehypeSanitize, sanitizeSchema], [rehypeKatex, { throwOnError: false }]],
      components: {
        // 段落之间留出间距
        p: ({ node, ...p }) => /* @__PURE__ */ jsx("p", { className: "my-1.5 first:mt-0 last:mb-0", ...p }),
        // 列表
        ul: ({ node, ...p }) => /* @__PURE__ */ jsx("ul", { className: "my-1.5 list-disc space-y-1 pl-5", ...p }),
        ol: ({ node, ...p }) => /* @__PURE__ */ jsx("ol", { className: "my-1.5 list-decimal space-y-1 pl-5", ...p }),
        li: ({ node, ...p }) => /* @__PURE__ */ jsx("li", { className: "marker:text-neutral-400", ...p }),
        // 标题
        h1: ({ node, ...p }) => /* @__PURE__ */ jsx("h1", { className: "mb-1.5 mt-2 text-base font-semibold first:mt-0", ...p }),
        h2: ({ node, ...p }) => /* @__PURE__ */ jsx("h2", { className: "mb-1.5 mt-2 text-[15px] font-semibold first:mt-0", ...p }),
        h3: ({ node, ...p }) => /* @__PURE__ */ jsx("h3", { className: "mb-1 mt-2 text-sm font-semibold first:mt-0", ...p }),
        // 强调
        strong: ({ node, ...p }) => /* @__PURE__ */ jsx("strong", { className: "font-semibold", ...p }),
        em: ({ node, ...p }) => /* @__PURE__ */ jsx("em", { className: "italic", ...p }),
        a: ({ node, ...p }) => /* @__PURE__ */ jsx("a", { className: "underline underline-offset-2 hover:opacity-80", target: "_blank", rel: "noreferrer", ...p }),
        // 引用
        blockquote: ({ node, ...p }) => /* @__PURE__ */ jsx(
          "blockquote",
          {
            className: "my-1.5 border-l-2 border-neutral-300 pl-3 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400",
            ...p
          }
        ),
        hr: ({ node, ...p }) => /* @__PURE__ */ jsx("hr", { className: "my-2 border-neutral-200 dark:border-neutral-800", ...p }),
        // 行内代码 / 代码块（mermaid 特判渲染成图）
        code: ({ node, inline, className, children: children2, ...p }) => {
          var _a2;
          const lang = (_a2 = /language-(\w+)/.exec(className || "")) == null ? void 0 : _a2[1];
          const text = Array.isArray(children2) ? children2.filter((c) => typeof c === "string").join("") : typeof children2 === "string" ? children2 : "";
          if (!inline && lang === "mermaid") return /* @__PURE__ */ jsx(Mermaid, { code: text.trim(), dark });
          const firstLine = text.split("\n", 1)[0];
          if (!inline && (!lang || /^(text|txt|diag)$/i.test(lang)) && MERMAID_FIRST_LINE.test(firstLine)) {
            return /* @__PURE__ */ jsx(Mermaid, { code: text.trim(), dark });
          }
          return inline ? /* @__PURE__ */ jsx(
            "code",
            {
              className: "rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-800",
              ...p,
              children: children2
            }
          ) : /* @__PURE__ */ jsx("code", { className: "font-mono text-[0.85em]", ...p, children: children2 });
        },
        pre: ({ node, ...p }) => /* @__PURE__ */ jsx(
          "pre",
          {
            className: "my-1.5 overflow-x-auto rounded-lg bg-neutral-100 p-2.5 text-[0.85em] leading-relaxed dark:bg-black/40",
            ...p
          }
        ),
        // 表格（GFM）
        table: ({ node, ...p }) => /* @__PURE__ */ jsx("div", { className: "my-1.5 overflow-x-auto", children: /* @__PURE__ */ jsx("table", { className: "w-full border-collapse text-[0.9em]", ...p }) }),
        th: ({ node, ...p }) => /* @__PURE__ */ jsx(
          "th",
          {
            className: "border border-neutral-200 bg-neutral-100 px-2 py-1 text-left font-semibold dark:border-neutral-800 dark:bg-neutral-900",
            ...p
          }
        ),
        td: ({ node, ...p }) => /* @__PURE__ */ jsx("td", { className: "border border-neutral-200 px-2 py-1 dark:border-neutral-800", ...p })
      },
      children: rescueMermaid(children || "")
    }
  ) });
}
export {
  Markdown as default
};
