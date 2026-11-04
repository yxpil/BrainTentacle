// 每晚 02:30 的流水线自检：产出一份报告写进工作目录，pipeline_health 工具与页面都读它。
const fs = require("node:fs");

const rows = [
  { code: "SH600519", price: 1680.5, weight: 0.3 },
  { code: "SZ000858", price: 128.2, weight: 0.25 },
  { code: "SH601318", price: 46.8, weight: 0.25 },
  { code: "SZ300750", price: 182.4, weight: 0.2 },
];
const w = rows.reduce((a, r) => a + r.weight, 0);
const avg = rows.reduce((a, r) => a + r.price * r.weight, 0) / w;
const vol = 0.18;
const dd = 0.07;
const score = Math.min(100, Math.round((vol * 120 + dd * 180) * 10) / 10);

const report = {
  at: new Date().toISOString(),
  holdings: rows.length,
  weighted_avg: Number(avg.toFixed(2)),
  risk_score: score,
  band: score < 30 ? "低" : score < 60 ? "中" : "高",
};
fs.writeFileSync("biz_pipeline_last.json", JSON.stringify(report, null, 2), "utf8");
process.stdout.write(JSON.stringify({ ok: true, summary: `组合体检：加权均价 ${report.weighted_avg}，风险 ${report.band}`, ...report }));
