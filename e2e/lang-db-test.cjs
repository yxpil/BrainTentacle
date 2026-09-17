// 验证语言标记入库 + 托盘面板双语联动：
// A) set_language 落库 → get_language 读回
// B) 主界面 html.lang=en（preload 观察源）→ 面板快照 lang=en + 英文文案
// C) 还原 zh
const http = require("http");

function cdpList() {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 9222, path: "/json", method: "GET" }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(JSON.parse(b)));
    });
    req.on("error", reject);
    req.end();
  });
}

let wsId = 1;
function attach(ws) {
  return (method, params) =>
    new Promise((resolve, reject) => {
      const id = wsId++;
      const onMsg = (raw) => {
        const m = JSON.parse(raw);
        if (m.id === id) {
          ws.off("message", onMsg);
          m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const WebSocket = (await import("ws")).default;
  // 主界面 = dist/index.html 的 page（托盘面板 tray-status.html 没有 __TAURI_INTERNALS__ shim）
  const findMain = (list) => list.find((t) => t.type === "page" && decodeURIComponent(t.url).includes("dist/index.html"));
  const page = findMain(await cdpList());
  if (!page) throw new Error("main window target not found");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on("open", r));
  const send = attach(ws);
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

  // A. 语言入库
  const setR = await evalJs(`window.__TAURI_INTERNALS__.invoke("set_language", { language: "en" })`);
  const db1 = await evalJs(`window.__TAURI_INTERNALS__.invoke("get_language", {})`);
  console.log("SET:", JSON.stringify(setR), "DB_AFTER_SET_EN:", JSON.stringify(db1));

  // B. 先开面板，再 html.lang=en（模拟 i18n.applyDom → preload observer → 主进程 → 面板）
  await evalJs(`window.__TAURI_INTERNALS__.invoke("plugin:window|open-status", {})`);
  let panel = null;
  for (let i = 0; i < 10 && !panel; i++) {
    await sleep(1000);
    const list = await cdpList();
    panel = list.find((t) => t.type === "page" && decodeURIComponent(t.url).includes("tray-status"));
  }
  await evalJs(`document.documentElement.lang = "en"; "ok"`);
  await sleep(1500); // observer → 主进程 → 快照推送
  if (!panel) {
    console.log("PANEL_TARGET_NOT_FOUND; targets:", (await cdpList()).map((t) => t.type + ":" + t.url).join(", "));
  }
  let panelLang = null, panelTitle = null;
  if (panel) {
    const ws2 = new WebSocket(panel.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r) => ws2.on("open", r));
    const send2 = attach(ws2);
    const ev2 = async (expr) => (await send2("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
    panelLang = await ev2(`(typeof snap !== 'undefined' && snap.lang) || null`);
    panelTitle = await ev2(`document.querySelector('#btn-show')?.textContent`);
    ws2.close();
  }
  console.log("PANEL_LANG:", panelLang, "PANEL_SHOW_BTN:", JSON.stringify(panelTitle));

  // C. 还原 zh
  await evalJs(`window.__TAURI_INTERNALS__.invoke("set_language", { language: "zh" })`);
  await evalJs(`document.documentElement.lang = "zh"; "ok"`);
  const db2 = await evalJs(`window.__TAURI_INTERNALS__.invoke("get_language", {})`);
  console.log("DB_AFTER_SET_ZH:", JSON.stringify(db2));

  const ok = db1?.language === "en" && panelLang === "en" && panelTitle === "Show main window" && db2?.language === "zh";
  console.log(ok ? "PASS" : "FAIL");
  ws.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
