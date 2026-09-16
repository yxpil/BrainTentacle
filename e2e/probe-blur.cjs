// 背景模糊遮罩验证：设置 look.bgBlur=24 → 查 html class / CSS 变量 / ::before 的 backdrop-filter
const http = require("http");
const getTargets = () => new Promise((res, rej) => http.get("http://127.0.0.1:9222/json", r => { let b = ""; r.on("data", d => b += d); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
(async () => {
  const targets = await getTargets();
  const page = targets.find(t => t.type === "page" && t.title && !t.title.includes("任务面板"));
  if (!page) { console.log("NO_MAIN"); process.exit(2); }
  const ws = require("ws");
  const main = new ws(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((r, j) => { main.on("open", r); main.on("error", j); });
  main.on("message", d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)[0](m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, [res]); main.send(JSON.stringify({ id: n, method, params })); });
  const evl = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  const out = await evl(`(() => {
    const root = document.documentElement;
    // 模拟用户在主题页调滑块：直接改 localStorage 并触发 applyLook 等价逻辑不可行（模块内部），
    // 改为验证 CSS 规则存在 + 手动挂 class/变量后样式生效
    const probe1 = [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.selectorText && r.selectorText.includes('.has-bg-blur')); } catch { return false; } });
    root.classList.add('has-bg-blur');
    root.style.setProperty('--look-bg-blur', '24px');
    const before = getComputedStyle(document.getElementById('root'), '::before');
    const applied = before.backdropFilter || before.webkitBackdropFilter;
    root.classList.remove('has-bg-blur');
    root.style.removeProperty('--look-bg-blur');
    return JSON.stringify({ ruleExists: probe1, backdropApplied: applied });
  })()`);
  console.log(out);
  main.close();
})();
