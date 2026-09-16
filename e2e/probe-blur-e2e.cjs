// 背景模糊链路验证：写 look.bgBlur=24 → reload → 查 class/变量/计算样式 → 恢复 0
const http = require("http");
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
const fs = require("fs");
const STEP = process.argv[2] || "set";
(async () => {
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  if (!page) { console.log("NO_MAIN"); process.exit(2); }
  const ws = require("ws");
  const m0 = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  await new Promise((r, j) => { m0.on("open", r); m0.on("error", j); });
  m0.on("message", d => { const x = JSON.parse(d); if (x.id && pend.has(x.id)) { pend.get(x.id)[0](x.result); pend.delete(x.id); } });
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pend.set(n, [res]); m0.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send("Runtime.enable");
  if (STEP === "set") {
    console.log(await evl(`(async () => {
      const look = JSON.parse(localStorage.getItem("bit.look.v1") || "{}");
      look.bgBlur = 24;
      localStorage.setItem("bit.look.v1", JSON.stringify(look));
      location.reload();
      return "reloading";
    })()`));
  } else if (STEP === "check") {
    console.log(await evl(`(() => {
      const root = document.documentElement;
      const before = getComputedStyle(document.getElementById("root"), "::before");
      return JSON.stringify({
        hasClass: root.classList.contains("has-bg-blur"),
        blurVar: root.style.getPropertyValue("--look-bg-blur"),
        applied: before.backdropFilter || "none",
      });
    })()`));
  } else if (STEP === "reset") {
    console.log(await evl(`(async () => {
      const look = JSON.parse(localStorage.getItem("bit.look.v1") || "{}");
      look.bgBlur = 0;
      localStorage.setItem("bit.look.v1", JSON.stringify(look));
      location.reload();
      return "resetting";
    })()`));
  }
  m0.close();
})().catch(e => { console.error("ERR", e.message); process.exit(2); });
