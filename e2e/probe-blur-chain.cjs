// 逐环检查：class / --app-bg-image / ::before backgroundImage / ::after backdropFilter
const http = require("http");
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const SVG = "data:image/svg+xml;base64," + Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'>
     <defs><pattern id='p' width='40' height='40' patternUnits='userSpaceOnUse'>
       <rect width='40' height='40' fill='#ffffff'/>
       <circle cx='20' cy='20' r='12' fill='#dc2626'/>
     </pattern></defs>
     <rect width='400' height='400' fill='url(#p)'/>
   </svg>`).toString("base64");
(async () => {
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  const ws = require("ws");
  const m0 = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  await new Promise((r, j) => { m0.on("open", r); m0.on("error", j); });
  m0.on("message", d => { const x = JSON.parse(d); if (x.id && pend.has(x.id)) { pend.get(x.id)[0](x.result); pend.delete(x.id); } });
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pend.set(n, [res]); m0.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send("Runtime.enable"); await send("Page.enable");
  await evl(`(() => { const v = localStorage.getItem("bit.look.v1") || "{}"; localStorage.setItem("bit.look.v1.bak", v); return v.length; })()`);
  const BLUR = process.argv[2] || "24";
  await evl(`(async () => {
    const look = JSON.parse(localStorage.getItem("bit.look.v1") || "{}");
    look.enabled = true; look.bgImage = ${JSON.stringify(SVG)}; look.bgOpacity = 100; look.bgBlur = ${BLUR};
    localStorage.setItem("bit.look.v1", JSON.stringify(look));
    location.reload(); return "ok";
  })()`);
  await new Promise(r => setTimeout(r, 4500));
  const st = await evl(`(() => {
    const h = document.documentElement;
    const root = document.getElementById("root");
    const before = getComputedStyle(root, "::before");
    const after = getComputedStyle(root, "::after");
    return JSON.stringify({
      dark: h.classList.contains("dark"),
      hasBgImage: h.classList.contains("has-bg-image"),
      hasBgBlur: h.classList.contains("has-bg-blur"),
      imgVar: (root.style.getPropertyValue("--app-bg-image") || "").slice(0, 40),
      beforeImage: before.backgroundImage.slice(0, 40),
      afterBlur: after.backdropFilter || "none",
      beforeOpacity: before.opacity,
    });
  })()`);
  console.log(st);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  require("fs").writeFileSync(`e2e/blur-check-${BLUR}.png`, Buffer.from(shot.data, "base64"));
  // 恢复
  await evl(`(() => { localStorage.setItem("bit.look.v1", localStorage.getItem("bit.look.v1.bak")); localStorage.removeItem("bit.look.v1.bak"); location.reload(); return "ok"; })()`);
  m0.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
