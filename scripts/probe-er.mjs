// 用真实 Chrome + mermaid UMD 实测：救援产物能否 parse/render
import { execSync } from "node:child_process";
import fs from "node:fs";

// 1) 复刻前端 rescue（与 Markdown.jsx 同算法，含 ER 实体块支持）——直接用 vite 把组件管线跑一遍
//    这里走轻量路：把 Markdown.jsx 的 rescue 单独 SSR 不方便，改在页面里引入同一份逻辑太绕，
//    所以本脚本把 rescue 算法内联（与 Markdown.jsx 逐行同步，改动时两处都要改）。
const src = fs.readFileSync("src/components/Markdown.jsx", "utf8");
// 校验算法同步：组件里必须已含 ER 支持（--o{ 与 ENTITY_OPEN）
if (!src.includes("--o{") || !src.includes("ENTITY_OPEN")) {
  throw new Error("Markdown.jsx 缺 ER 支持，先同步算法");
}

const MERMAID_FIRST_LINE =
  /^\s*(flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|quadrant|requirementDiagram|gitGraph|graph\s+(TB|TD|BT|RL|LR)\b|C4(Context|Container|Component|Dynamic|Deployment)\b|sankey(-beta)?|xychart(-beta)?|block(-beta)?|zenuml)\b/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const DIAGRAM_LINE =
  /^\s*(autonumber\b|participant\s|actor\s|note\s|alt\b|else\b|opt\b|loop\b|par\b|and\b|critical\b|option\b|break\b|rect\b|title\s|legend\s|end\b)|->>|-->>|-\)|--\)|-->|-\.|==|--o\{|--\|\{|\|o--|\|--/;
const ENTITY_OPEN = /^\s*[\w"']+\s*\{\s*$/;

function rescue(srcText) {
  const lines = srcText.split("\n");
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
          if (j >= lines.length || (!DIAGRAM_LINE.test(lines[j]) && !ENTITY_OPEN.test(lines[j]) && !inEntity)) break;
          out.push(l);
          if (++blank > 30) break;
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
      out.push("```");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// 2) 取落盘 ER 消息 → rescue → 提取围栏内代码
const msg = fs.readFileSync("ermsg.txt", "utf8");
const rescued = rescue(msg);
fs.writeFileSync("rescued.txt", rescued);
const m = rescued.match(/```mermaid\n([\s\S]*?)```/);
if (!m) { console.error("rescue 未产生 mermaid 围栏！rescued.txt 前 300 字：\n" + rescued.slice(0, 300)); process.exit(1); }
const code = m[1];
fs.writeFileSync("er-code.txt", code);
console.log("围栏代码行数:", code.split("\n").length);
console.log("前 3 行:", JSON.stringify(code.split("\n").slice(0, 3)));
console.log("后 3 行:", JSON.stringify(code.split("\n").slice(-3)));
