// 受控诊断：主界面 html.lang 切换 → 面板 snap.lang 是否跟随
const http = require("http");
const cdpList = () =>
  new Promise((res, rej) => {
    http.get("http://127.0.0.1:9222/json", (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res(JSON.parse(b)));
    }).on("error", rej);
  });
const cdp = () =>
  new Promise((res, rej) => {
    http.get("http://127.0.0.1:9222/json", (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res(JSON.parse(b)));
    }).on("error", rej);
  });
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
  const findMain = (list) => list.find((t) => t.type === "page" && decodeURIComponent(t.url).includes("dist/index.html"));
  const findPanel = (list) => list.find((t) => t.type === "page" && decodeURIComponent(t.url).includes("tray-status"));
  const main = findMain(await cdpList());
  const panel = findPanel(await cdpList());
  if (!main || !panel) { console.log("targets:", main ? "main" : "no-main", panel ? "panel" : "no-panel"); process.exit(1); }
  const wm = new WebSocket(main.webSocketDebuggerUrl, { perMessageDeflate: false });
  const wp = new WebSocket(panel.webSocketDebuggerUrl, { perMessageDeflate: false });
  await Promise.all([new Promise((r) => wm.on("open", r)), new Promise((r) => wp.on("open", r))]);
  const sm = attach(wm), sp = attach(wp);
  const evm = async (e) => (await sm("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  const evp = async (e) => (await sp("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;

  console.log("0. panel.lang=", JSON.stringify(await evp(`JSON.stringify({snap: (typeof snap !== "undefined") ? snap.lang : null, dom: document.documentElement.lang, btn: document.querySelector("#btn-show")?.textContent})`)));

  // 主界面：html.lang -> en（模拟 i18n 切换）
  console.log("1. set main html.lang=en:", await evm(`document.documentElement.lang = "en"; "done"`));
  await sleep(1500);
  console.log("2. after:", JSON.stringify(await evp(`JSON.stringify({snap: (typeof snap !== "undefined") ? snap.lang : null, dom: document.documentElement.lang, btn: document.querySelector("#btn-show")?.textContent})`)));

  // 还原
  await evm(`document.documentElement.lang = "zh"; "done"`);
  await sleep(800);
  console.log("3. restored:", JSON.stringify(await evp(`JSON.stringify({snap: (typeof snap !== "undefined") ? snap.lang : null, btn: document.querySelector("#btn-show")?.textContent})`)));
  wm.close(); wp.close();
  process.exit(0);
})();
