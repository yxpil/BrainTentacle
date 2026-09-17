// 检查主窗口 html[lang] 与 localStorage 是否与数据库一致（syncLangFromDb 生效验证）
const http = require("http");
const ws = require("ws");
http.get("http://127.0.0.1:9222/json", (r) => {
  let b = "";
  r.on("data", (d) => (b += d));
  r.on("end", () => {
    const ts = JSON.parse(b);
    const page = ts.find((t) => t.type === "page" && decodeURIComponent(t.url).includes("index.html"));
    if (!page) { console.log("MAIN_NOT_FOUND"); process.exit(2); }
    const c = new ws(page.webSocketDebuggerUrl);
    c.on("open", () => c.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `document.documentElement.lang + "|" + (localStorage.getItem("bit.lang.v1") || "")`, returnByValue: true } })));
    c.on("message", (d) => { const m = JSON.parse(d); if (m.id === 1) { console.log("MAIN_LANG|STORE:", m.result.result.value); c.close(); process.exit(0); } });
  });
});
