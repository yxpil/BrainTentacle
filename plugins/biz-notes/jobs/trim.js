// 每 24 小时一次的整理任务：只统计与写报告，不删用户的便签（真要清理得在页面上按目录手动来）。
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join("plugin_data", "biz-notes");
const DAY = 86400000;

function walk(dir, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out);
    else if (it.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const now = Date.now();
const stale = files.filter((f) => now - fs.statSync(f).mtimeMs > 30 * DAY);
const report = {
  at: new Date().toISOString(),
  scanned: files.length,
  stale_over_30d: stale.length,
  dry_run: true,
  note: stale.length ? "这些便签超过 30 天没动过，可在页面上归档" : "没有陈年便签",
};
fs.writeFileSync(path.join(process.cwd(), "biz_notes_trim.json"), JSON.stringify(report, null, 2), "utf8");
process.stdout.write(JSON.stringify({ ok: true, summary: `扫到 ${report.scanned} 张便签，${report.stale_over_30d} 张超过 30 天`, ...report }));
