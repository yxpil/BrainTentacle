// .fz 脚本 → Markdown 正文（宿主在用户拖入 .fz/.fzz 文件时调用，见清单 file_kinds）。
// 入参（stdin JSON）：{ filename, path?, base64?, size, kind, label }
// 出参（stdout JSON）：{ text } —— 正文由宿主统一封顶后进上下文。
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let p = {};
  try {
    p = JSON.parse(raw || "{}");
  } catch (e) {
    console.log(JSON.stringify({ text: "" }));
    return;
  }
  let src = "";
  if (p.path) {
    try {
      src = require("fs").readFileSync(p.path, "utf8");
    } catch (e) {
      console.log(JSON.stringify({ error: "读不到文件：" + e.message }));
      return;
    }
  } else if (p.base64) {
    src = Buffer.from(p.base64, "base64").toString("utf8");
  } else {
    console.log(JSON.stringify({ error: "既没有 path 也没有 base64" }));
    return;
  }

  const out = [];
  let steps = 0;
  let notes = 0;
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      notes += 1;
      out.push("> " + t.replace(/^#\s*/, ""));
      continue;
    }
    const i = t.indexOf(":");
    if (i > 0) {
      steps += 1;
      out.push(`- **${t.slice(0, i).trim()}** — ${t.slice(i + 1).trim()}`);
    } else {
      out.push(`  ${t}`);
    }
  }
  out.unshift(`【${p.filename || "未命名"} · ${p.label || "FZ 脚本"}】共 ${steps} 个步骤、${notes} 条说明。`);
  console.log(JSON.stringify({ text: out.join("\n") }));
});
