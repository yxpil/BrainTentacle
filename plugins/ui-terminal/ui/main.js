// 运维速记台（JS 型插件）：拿的是宿主给的受限 api，React 实例必须用 api.React，
// 否则 hooks 挂在另一份 React 上会直接崩。这里注册一个导航页 + 一页设置，
// 顺带把宿主事件（events 权限）接进来做成流水，作为「插件确实在跑」的现场证据。
const { createElement: h, useState, useEffect, useRef } = api.React;

const NOTE_FILE = "notes.log";
const PAGE_ID = "ops";
const SETTINGS_ID = "cfg";

// 页面本体：左输入右流水，所有状态都落在插件自己的数据目录 / 命名空间存储里
function OpsPage() {
  const [notes, setNotes] = useState([]);
  const [events, setEvents] = useState([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("准备中");
  const box = useRef(null);

  useEffect(() => {
    let alive = true;
    api
      .data.read(NOTE_FILE)
      .then((text) => {
        if (!alive) return;
        setNotes(String(text || "").split("\n").filter(Boolean));
        setStatus(`已读 ${NOTE_FILE}`);
      })
      .catch((e) => setStatus("读取失败：" + (e.message || e)));
    // 宿主事件白名单转发：申报了 events 才有内容进来
    const off = api.onEvent((name, payload) => {
      if (!alive) return;
      setEvents((prev) => [...prev.slice(-9), `${name} ${JSON.stringify(payload).slice(0, 60)}`]);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const add = async () => {
    const line = `${new Date().toISOString().slice(11, 19)} ${draft.trim()}`;
    if (!line.trim()) return;
    const next = [...notes, line];
    setNotes(next);
    setDraft("");
    try {
      await api.data.write(NOTE_FILE, next.join("\n") + "\n");
      setStatus(`已写 ${next.length} 行`);
    } catch (e) {
      setStatus("写入失败：" + (e.message || e));
    }
  };

  return h(
    "div",
    { className: "bit-term" },
    h(
      "header",
      { className: "bit-term-head" },
      h("h1", null, "运维速记台"),
      h("span", { className: "bit-term-status", "data-bit-term-status": "" }, status)
    ),
    h(
      "div",
      { className: "bit-term-bar" },
      h("input", {
        className: "bit-term-input",
        placeholder: "记一条运维笔记，回车即存",
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        onKeyDown: (e) => e.key === "Enter" && add(),
      }),
      h("button", { className: "bit-term-btn", onClick: add }, "记下"),
      h(
        "button",
        {
          className: "bit-term-btn",
          onClick: () => api.notify("速记台", `当前 ${notes.length} 条笔记`),
        },
        "发通知"
      ),
      h(
        "button",
        {
          className: "bit-term-btn",
          onClick: () => api.openPage("settings", "plugins"),
        },
        "去设置中心"
      )
    ),
    h(
      "div",
      { className: "bit-term-cols" },
      h(
        "section",
        { className: "bit-term-col" },
        h("h2", null, `笔记（${notes.length}）`),
        h("ul", { ref: box }, notes.map((n, i) => h("li", { key: i }, n)))
      ),
      h(
        "section",
        { className: "bit-term-col" },
        h("h2", null, "宿主事件流水"),
        h("ul", null, events.length ? events.map((e, i) => h("li", { key: i }, e)) : h("li", null, "（还没有事件进来）"))
      )
    )
  );
}

// 设置页：值存在宿主（settings 权限），和 iframe 型插件读写的是同一份键空间
function SettingsPage() {
  const [prefix, setPrefix] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.settings.get("note_prefix").then((v) => setPrefix(String(v || "")));
    setDraftKey(String(api.storage.get("last") || ""));
  }, []);

  return h(
    "div",
    { className: "bit-term" },
    h("h1", null, "速记台设置"),
    h(
      "label",
      null,
      "笔记前缀",
      h("input", { value: prefix, onChange: (e) => setPrefix(e.target.value), placeholder: "例：[夜班]" })
    ),
    h(
      "button",
      {
        className: "bit-term-btn",
        onClick: async () => {
          await api.settings.set("note_prefix", prefix);
          api.storage.set("last", prefix);
          setMsg("已保存 note_prefix");
        },
      },
      "保存"
    ),
    h("p", { className: "bit-term-status" }, msg || `命名空间草稿键：${draftKey || "（空）"}`)
  );
}

api.registerPage({ id: PAGE_ID, label: "速记台", component: OpsPage });
api.registerSettingsPage({
  id: SETTINGS_ID,
  label: "速记台设置",
  description: "笔记前缀与命名空间草稿",
  kw: "速记 运维 笔记 terminal",
  component: SettingsPage,
});
api.log("已注册页面", PAGE_ID, "与设置页", SETTINGS_ID);
