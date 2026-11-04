// 诊断：列出主窗口按钮 title，定位 WorkWith 导航项
const http = require("http");
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
  if (!page) { console.log("NO PAGE"); process.exit(1); }
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
  const r = await send("Runtime.evaluate", {
    expression: `(() => {
      const src = [...document.querySelectorAll("script")].map((s) => s.src).join("|");
      return JSON.stringify({ url: location.href, src, navCount: document.querySelectorAll("nav button,aside button").length });
    })()`,
    returnByValue: true,
  });
  console.log("RESULT:", r.result.value);
  ws.close();
  process.exit(0);
}).catch((e) => { console.error("ERR", e.message); process.exit(1); });
