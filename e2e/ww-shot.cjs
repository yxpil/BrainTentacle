// 截图：打开「服务」页并截取主窗口（供用户确认 UI）
const http = require("http");
const fs = require("fs");
new Promise((res, rej) => {
  const r = http.request({ host: "127.0.0.1", port: 9222, path: "/json", method: "GET" }, (x) => {
    let b = "";
    x.on("data", (c) => (b += c));
    x.on("end", () => res(JSON.parse(b)));
  });
  r.on("error", rej);
  r.end();
}).then(async (ts) => {
  const page = ts.find((t) => t.type === "page" && (t.url || "").includes("dist/index.html"));
  const WebSocket = (await import("ws")).default;
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const send = (m, p) => new Promise((res2) => {
    const i = ++id;
    ws.on("message", function h(raw) {
      const d = JSON.parse(raw);
      if (d.id === i) { ws.off("message", h); res2(d.result); }
    });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  await send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll("button")].find((b) => b.title === "服务" || b.title === "Services")?.click()`,
  });
  await new Promise((r) => setTimeout(r, 800));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("e2e/ww-page.png", Buffer.from(shot.data, "base64"));
  console.log("SAVED e2e/ww-page.png");
  ws.close();
  process.exit(0);
}).catch((e) => { console.error("ERR", e.message); process.exit(1); });
