// 每 5 分钟一次的心跳任务：把「我还在跑」写进 toolhomes，
// 看板的运行时长与 last_snapshot 工具都读这份文件，任务与工具因此形成闭环。
const fs = require("node:fs");
const path = require("node:path");

const home = process.cwd(); // 宿主把解释器的工作目录设为 BIT toolhomes
const file = path.join(home, "biz_pricewatch_heartbeat.json");

let runs = 0;
try {
  const prev = JSON.parse(fs.readFileSync(file, "utf8"));
  runs = Number(prev.runs) || 0;
} catch {
  /* 第一次跑：没有历史文件 */
}

runs += 1;
const snap = {
  runs,
  at: new Date().toISOString(),
  pid: process.pid,
  node: process.version,
  cwd: home,
};
fs.writeFileSync(file, JSON.stringify(snap, null, 2), "utf8");
process.stdout.write(JSON.stringify({ ok: true, summary: `第 ${runs} 次心跳`, ...snap }));
