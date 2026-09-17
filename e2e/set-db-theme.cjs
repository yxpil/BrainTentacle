// 极简工具：读写库中主题标记（验证前端启动 sync 链路用）
// 用法：node e2e/set-db-theme.cjs dark|light|auto|get
const http = require("http");
const ws = require("ws");
const arg = process.argv[2] || "get";
http.get("http://127.0.0.1:9222/json", (r) => {
  let b = "";
  r.on("data", (d) => (b += d));
  r.on("end", () => {
    const ts = JSON.parse(b);
    const page = ts.find((t) => t.type === "page" && decodeURIComponent(t.url).includes("index.html"));
    if (!page) { console.log("MAIN_NOT_FOUND"); process.exit(2); }
    const c = new ws(page.webSocketDebuggerUrl);
    const expr = arg === "get"
      ? `window.__TAURI_INTERNALS__.invoke('get_theme', {}).then(v => 'DB=' + JSON.stringify(v) + ' | html.dark=' + document.documentElement.classList.contains('dark') + ' | store=' + localStorage.getItem('bit.theme.v1'))`
      : `window.__TAURI_INTERNALS__.invoke('set_theme', { theme: ${JSON.stringify(arg)} }).then(v => 'SET=' + JSON.stringify(v))`;
    c.on("open", () => c.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } })));
    c.on("message", (d) => { const m = JSON.parse(d); if (m.id === 1) { console.log(m.result?.result?.value ?? JSON.stringify(m.result)); c.close(); process.exit(0); } });
  });
});
