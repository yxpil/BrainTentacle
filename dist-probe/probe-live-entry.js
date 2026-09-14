import { JSDOM } from "jsdom";
import fs from "node:fs";
import React from "react";
import { createRoot } from "react-dom/client";
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.Node = dom.window.Node;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
const logs = [];
const origErr = console.error;
console.error = (...a) => {
  logs.push(a.map(String).join(" ").slice(0, 200));
  origErr(...a);
};
async function main() {
  const Markdown = (await import("./assets/Markdown-NMKpoQgW.js")).default;
  const msg = fs.readFileSync("ermsg.txt", "utf8");
  const { execSync } = await import("node:child_process");
  const root = createRoot(document.getElementById("root"));
  root.render(React.createElement(Markdown, null, msg));
  await new Promise((r) => setTimeout(r, 6e3));
  const html = document.getElementById("root").innerHTML;
  console.log("=== 结果 ===");
  console.log("含 <svg:", html.includes("<svg"));
  console.log("结构摘要:", html.slice(0, 300).replace(/\s+/g, " "));
  if (logs.length) console.log("console.error 捕获", logs.length, "条:\n" + logs.slice(0, 4).join("\n---\n"));
  process.exit(0);
}
main();
