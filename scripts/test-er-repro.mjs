// 决定性实验：erDiagram 真实内容 × 新旧渲染算法，定位 [object Object] 的产生路径
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import Markdown from "../src/components/Markdown.jsx";

const ER =
  "先给你画一个**通用电商系统**的 ER 图作示例（用户 / 商品 / 订单这条主线）：\n\nerDiagram\n" +
  '    USER      ||--o{ ADDRESS    : "收货地址"\n    USER      ||--o{ ORDER      : "下单"\n' +
  '    USER      ||--o{ REVIEW     : "评价"\n    CATEGORY  ||--o{ PRODUCT   : "分类归属"\n' +
  '    CATEGORY  |o--o{ CATEGORY   : "父分类"\n    PRODUCT   ||--o{ REVIEW    : "被评价"\n' +
  '    PRODUCT   ||--o{ STOCK      : "库存"\n    WAREHOUSE ||--o{ STOCK     : "持有库存"\n' +
  '    ORDER     ||--|{ ORDER_ITEM : "包含明细"\n    PRODUCT   ||--o{ ORDER_ITEM: "被购买"\n' +
  '    ORDER     ||--o{ PAYMENT    : "支付流水"\n    COUPON    |o--o{ ORDER     : "使用优惠券"\n\n' +
  "    USER {\n        bigint   id PK\n        string   username\n    }\n\n" +
  "N）；`|o--o{` = 右侧可关联。要不要我按你的实际业务改一版？";

// ---- 0.6.12 旧算法（String(children) + 旧 rescue：空行截断、无 ER 支持）----
const OLD_FIRST =
  /^\s*(flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|quadrant|requirementDiagram|gitGraph|graph\s+(TB|TD|BT|RL|LR)\b|C4(Context|Container|Component|Dynamic|Deployment)\b|sankey(-beta)?|xychart(-beta)?|block(-beta)?|zenuml)\b/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
function oldRescue(src) {
  const lines = src.split("\n");
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (!inFence && OLD_FIRST.test(line)) {
      out.push("```mermaid");
      out.push(line);
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !FENCE.test(lines[i])) { out.push(lines[i]); i++; }
      if (i < lines.length && FENCE.test(lines[i])) {
        i++;
        while (i < lines.length && !FENCE.test(lines[i])) { out.push(lines[i]); i++; }
        if (i < lines.length) i++;
      }
      out.push("```");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), "svg", "g", "path", "rect", "text"],
  attributes: { ...defaultSchema.attributes, "*": [...(defaultSchema.attributes?.["*"] || []), "class", "id", "d", "fill"] },
};

function pipeline(src, codeImpl) {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath, remarkBreaks],
        rehypePlugins: [rehypeRaw, [rehypeSanitize, sanitizeSchema], [rehypeKatex, { throwOnError: false }]],
        components: { code: codeImpl },
      },
      src,
    ),
  );
}

const oldCodeImpl = ({ node, inline, className, children, ...p }) => {
  const lang = /language-(\w+)/.exec(className || "")?.[1];
  const text = String(children); // ← 0.6.12 的写法
  if (!inline && (lang === "mermaid" || (!lang && OLD_FIRST.test(text.split("\n", 1)[0])))) {
    return React.createElement("div", { "data-mermaid": "yes" }, "[MERMAID:" + text.slice(0, 40) + "]");
  }
  return React.createElement("code", null, text);
};

for (const [name, src, impl] of [
  ["旧算法(0.6.12) × ER内容", oldRescue(ER), oldCodeImpl],
  ["新算法(0.6.13) × ER内容", ER, null],
]) {
  try {
    const html = impl ? pipeline(src, impl) : renderToStaticMarkup(React.createElement(Markdown, null, src));
    console.log(`===== ${name} =====`);
    console.log("含[object Object]:", html.includes("[object Object]"));
    console.log("含mermaid标记:", html.includes("mermaid 渲染中") || html.includes("data-mermaid"));
    console.log(html.slice(0, 500).replace(/</g, "\n<").split("\n").filter((l) => l.includes("object") || l.includes("mermaid") || l.includes("code")).slice(0, 6).join("\n"));
  } catch (e) {
    console.log(`===== ${name} ===== 渲染异常: ${e.message}`);
  }
  console.log();
}
