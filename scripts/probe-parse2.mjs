// 把 ermsg 经 rescue 后的围栏代码抽出来，交给真实 mermaid.parse 验证
import { JSDOM } from "jsdom";
import fs from "node:fs";

const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.Node = dom.window.Node;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

async function main() {
  // rescue 同源：直接跑 SSR 管线拿到围栏产物（复用 probe-er 的算法副本）
  execSyncGuard();
  function execSyncGuard() {}
  const rescued = fs.readFileSync("rescued2.txt", "utf8");
  const m = rescued.match(/```mermaid\n([\s\S]*?)```/);
  if (!m) { console.log("无围栏"); return; }
  const code = m[1];
  fs.writeFileSync("er-code2.txt", code);
  console.log("围栏代码", code.split("\n").length, "行，首行:", JSON.stringify(code.split("\n")[0]), "末行:", JSON.stringify(code.split("\n").slice(-2)));
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  try {
    const r = await mermaid.parse(code, { suppressErrors: false });
    console.log("PARSE OK", JSON.stringify(r));
  } catch (e) {
    console.log("PARSE FAIL:", String(e.message || e).slice(0, 600));
  }
}
main();
