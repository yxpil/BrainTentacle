// 真实 mermaid.parse 实证（jsdom 环境）——看救援产物到底为什么不渲染
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

const code = fs.readFileSync("er-code.txt", "utf8");
try {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
  try {
    const r = await mermaid.parse(code, { suppressErrors: false });
    console.log("PARSE OK:", JSON.stringify(r));
  } catch (e) {
    console.log("PARSE FAIL:", String((e && e.message) || e).slice(0, 800));
  }
} catch (e) {
  console.log("IMPORT/INIT FAIL:", String((e && e.stack) || e).slice(0, 1200));
}
