// 终极实证：jsdom + React 客户端渲染 + 真实 Markdown 组件 + 真实动态 import("mermaid")
// 复刻应用内的完整链路：rescue → ReactMarkdown → Mermaid 组件 → debounce → parse → render
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
console.error = (...a) => { logs.push(a.map(String).join(" ").slice(0, 200)); origErr(...a); };

// react-dom/client 需要 createRoot 挂在 jsdom 的元素上 —— 用 window 里的 React？同一份即可
const Markdown = (await import("../src/components/Markdown.jsx")).default;
const msg = fs.readFileSync("ermsg.txt", "utf8");

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(Markdown, null, msg));

// 等防抖(450ms) + 动态 import + parse + render
await new Promise((r) => setTimeout(r, 6000));

const html = document.getElementById("root").innerHTML;
console.log("=== 结果 ===");
console.log("含 <svg:", html.includes("<svg"));
console.log("含 [object Object]:", html.includes("[object Object]"));
console.log("HTML 长度:", html.length);
console.log("结构摘要:", html.slice(0, 400).replace(/\s+/g, " "));
if (logs.length) console.log("console.error 捕获", logs.length, "条:\n" + logs.slice(0, 5).join("\n---\n"));
process.exit(0);
