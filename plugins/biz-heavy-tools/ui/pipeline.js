// all 通配位放行 css/js/invoke/session…，这里用 JS 侧能力再注册一页：
// 统计本插件注入到工具表里的工具数量（invoke 权限），并留一个可被验收脚本读到的标记。
const { createElement: h, useState, useEffect } = api.React;

function LivePage() {
  const [state, setState] = useState({ tools: [], note: "读取中" });

  useEffect(() => {
    let alive = true;
    api
      .invoke("list_tools", {})
      .then((r) => {
        if (!alive) return;
        const all = Array.isArray(r) ? r : (r && (r.tools || r.list)) || [];
        const mine = all.filter((t) => String(t.id || "").startsWith(`plugin:${api.plugin.id}::`));
        setState({ tools: mine.map((t) => t.name), note: `注入 ${mine.length} 个工具` });
      })
      .catch((e) => alive && setState({ tools: [], note: "invoke 被拒：" + (e.message || e) }));
    return () => {
      alive = false;
    };
  }, []);

  return h(
    "div",
    { className: "bit-flow", "data-bit-flow-live": "" },
    h("h1", null, "流水线实时页"),
    h("div", { className: "lede" }, state.note),
    h("span", { className: "stat" }, `插件 ${api.plugin.id}`),
    h("span", { className: "stat" }, `版本 ${api.plugin.version}`),
    h(
      "ul",
      null,
      state.tools.map((n) => h("li", { key: n }, n))
    )
  );
}

api.registerPage({ id: "live", label: "流水线实时", component: LivePage });
// 标记：验收脚本读这个属性就能确认「js 权限确实执行过」，而不只是文件被读了
document.documentElement.setAttribute("data-bit-plugin-heavy-tools", "loaded");
api.log("JS 入口执行完成，已注册实时页");
