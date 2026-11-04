// 每晚 22:30 的盘点任务：把一份"实盘结果"写进 toolhomes，白天 stock_check 工具与看板都用它。
const fs = require("node:fs");
const path = require("node:path");

const SYSTEM = [
  { sku: "K-01", qty: 120 },
  { sku: "K-02", qty: 45 },
  { sku: "K-07", qty: 300 },
  { sku: "P-11", qty: 8 },
  { sku: "P-19", qty: 64 },
];

// 每次跑引入一点随机差异，模拟人工实盘
const counted = SYSTEM.map((s) => ({ sku: s.sku, qty: Math.max(0, s.qty - Math.floor(Math.random() * 7)) }));
const diff = SYSTEM.reduce((acc, s, i) => acc + Math.abs(s.qty - counted[i].qty), 0);

const out = { at: new Date().toISOString(), items: SYSTEM.length, total_diff: diff, counted };
fs.writeFileSync(path.join(process.cwd(), "biz_inventory_last.json"), JSON.stringify(out, null, 2), "utf8");
process.stdout.write(JSON.stringify({ ok: true, summary: `盘点 ${out.items} 项，总差异 ${diff} 件`, ...out }));
