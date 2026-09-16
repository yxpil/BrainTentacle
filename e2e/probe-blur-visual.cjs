// 背景模糊视觉验证：备份 look → 渐变背景图 + blur24/blur0 各截屏 → 恢复
const http = require("http");
const fs = require("fs");
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
// 高频渐变测试图：模糊前后差异肉眼可辨
const SVG = "data:image/svg+xml;base64," + Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'>
     <defs><pattern id='p' width='40' height='40' patternUnits='userSpaceOnUse'>
       <rect width='40' height='40' fill='%23ffffff'/>
       <circle cx='20' cy='20' r='12' fill='%23dc2626'/>
     </pattern></defs>
     <rect width='400' height='400' fill='url(%23p)'/>
   </svg>`).toString("base64");
(async () => {
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  if (!page) { console.log("NO_MAIN"); process.exit(2); }
  const ws = require("ws");
  const m0 = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  await new Promise((r, j) => { m0.on("open", r); m0.on("error", j); });
  m0.on("message", d => {
    const x = JSON.parse(d);
    if (x.id && pend.has(x.id)) { pend.get(x.id)[0](x.result); pend.delete(x.id); }
    if (x.method === "Page.screencastFrame") {} // noop
  });
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pend.set(n, [res]); m0.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send("Runtime.enable"); await send("Page.enable");

  // 1. 备份并设置：背景图 + blur=24
  const backup = await evl(`(() => { const v = localStorage.getItem("bit.look.v1") || "{}"; localStorage.setItem("bit.look.v1.bak", v); return v; })()`);
  console.log("backup:", (backup || "").slice(0, 80));
  await evl(`(async () => {
    const look = JSON.parse(localStorage.getItem("bit.look.v1") || "{}");
    look.enabled = true; look.bgImage = ${JSON.stringify(SVG)}; look.bgOpacity = 1; look.bgBlur = 24;
    localStorage.setItem("bit.look.v1", JSON.stringify(look));
    location.reload(); return "ok";
  })()`);
  await new Promise(r => setTimeout(r, 4500));
  const shot24 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("e2e/blur-24.png", Buffer.from(shot24.data, "base64"));

  // 2. blur=0 对照组
  await evl(`(() => { const look = JSON.parse(localStorage.getItem("bit.look.v1")); look.bgBlur = 0; localStorage.setItem("bit.look.v1", JSON.stringify(look)); location.reload(); return "ok"; })()`);
  await new Promise(r => setTimeout(r, 4500));
  const shot0 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("e2e/blur-0.png", Buffer.from(shot0.data, "base64"));

  // 3. 恢复备份
  await evl(`(() => { localStorage.setItem("bit.look.v1", localStorage.getItem("bit.look.v1.bak")); localStorage.removeItem("bit.look.v1.bak"); location.reload(); return "ok"; })()`);
  await new Promise(r => setTimeout(r, 2500));
  console.log("done: e2e/blur-24.png e2e/blur-0.png");
  m0.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
