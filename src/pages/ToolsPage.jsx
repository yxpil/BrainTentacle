import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api.js";
import PillSwitch from "../components/PillSwitch.jsx";
import { useLang } from "../i18n.js";
import { confirmDialog } from "../components/ConfirmHost.jsx";
import SectionNav, { Section, makePart } from "../components/SectionNav.jsx";
import {
  IconPlus,
  IconTrash,
  IconPlay,
  IconTool,
  IconServer,
  IconTerminal,
  IconCode,
  IconRefresh,
  IconGlobe,
  IconPuzzle,
  IconX,
} from "../components/Icons.jsx";

// stdio JSON 配置 textarea 的 placeholder：Cherry Studio 风格示例（代码示例不做翻译）
const STDIO_JSON_EXAMPLE = `// 示例：
// {
//   "mcpServers": {
//     "example-server": {
//       "command": "npx",
//       "args": ["-y", "mcp-server-example"]
//     }
//   }
// }`;

// 去掉 JSON 文本中的 // 注释（跳过字符串字面量内部，避免误伤 URL 等）
const stripJsonComments = (text) => {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inStr = false;
      }
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else {
      out += ch;
    }
  }
  return out;
};

// 兼容三种输入：mcpServers 包裹 / 单 server 对象 {command,args} / 裸映射 {名字: {command,...}}
const entriesFromStdioJson = (parsed) => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)) {
    return Object.entries(parsed.mcpServers);
  }
  if (typeof parsed.command === "string") {
    return [[typeof parsed.name === "string" ? parsed.name : "", parsed]];
  }
  const vals = Object.values(parsed);
  if (vals.length > 0 && vals.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
    return Object.entries(parsed);
  }
  return null;
};

// 语言默认脚手架：读 stdin 的 JSON，把结果写 stdout
const SCAFFOLD = {
  js: `// 从 stdin 读取参数 JSON，把结果打印到 stdout
const p = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
console.log(JSON.stringify({ echo: p, ts: Date.now() }));`,
  py: `# 从 stdin 读取参数 JSON，把结果打印到 stdout
import sys, json
p = json.loads(sys.stdin.read() or '{}')
print(json.dumps({ 'echo': p }))`,
  ts: `const raw = await new Response(Deno.stdin.readable).text();
const p = JSON.parse(raw || '{}');
console.log(JSON.stringify({ echo: p }));`,
  // Java：JDK 11+ 单文件源码直跑，从 stdin 读、stdout 写
  java: `import java.util.Scanner;
public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    StringBuilder in = new StringBuilder();
    while (sc.hasNextLine()) in.append(sc.nextLine());
    // 简单回显；如需解析 JSON 可自行引入库或手写
    System.out.println("{\\"echo\\": " + (in.length() == 0 ? "{}" : in) + "}");
  }
}`,
  // Rust：rustc 临时编译后运行，从 stdin 读、stdout 写
  rs: `use std::io::Read;
fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).ok();
    let body = if s.trim().is_empty() { "{}".to_string() } else { s.trim().to_string() };
    println!("{{\\"echo\\": {}}}", body);
}`,
  // Go：go run 单文件，从 stdin 读、stdout 写
  go: `package main
import ("bufio"; "fmt"; "os"; "strings")
func main() {
    r := bufio.NewReader(os.Stdin)
    var b strings.Builder
    buf := make([]byte, 4096)
    for { n, _ := r.Read(buf); if n == 0 { break }; b.Write(buf[:n]) }
    body := strings.TrimSpace(b.String()); if body == "" { body = "{}" }
    fmt.Printf("{\\"echo\\": %s}", body)
}`,
  // C：gcc 编译后运行，从 stdin 读、stdout 写
  c: `#include <stdio.h>
int main(){ char buf[65536]; size_t n=fread(buf,1,sizeof(buf)-1,stdin); buf[n]=0;
  printf("{\\"echo\\": %s}", n? buf : "{}"); return 0; }`,
  // Lua：从 stdin 读、stdout 写
  lua: `local s = io.read("*a") or ""
if s == "" then s = "{}" end
io.write('{"echo": ' .. s .. '}')`,
  exe: "",
};

const TOOL_SEC_KEY = "bit.toolsec";

// 工具中心：解释器注册 + 让 AI/用户写一段脚本变成工具 + 工具列表
export default function ToolsPage({ onStats, visible }) {
  const { t } = useLang();
  const [tools, setTools] = useState([]);
  const [runtimes, setRuntimes] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [sec, setSec] = useState(() => localStorage.getItem(TOOL_SEC_KEY) || "runtimes");
  const [query, setQuery] = useState("");

  // 脚本工具编辑器
  const [runtime, setRuntime] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [code, setCode] = useState(SCAFFOLD.js);
  const [testParams, setTestParams] = useState('{ "a": 1, "b": 2 }');
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // 手动添加解释器
  const [showAddRt, setShowAddRt] = useState(false);
  const [rtId, setRtId] = useState("");
  const [rtName, setRtName] = useState("");
  const [rtPath, setRtPath] = useState("");
  const [rtLang, setRtLang] = useState("js");

  // MCP 服务器：自动发现 + 接入 + 暂停/继续
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpFound, setMcpFound] = useState(null);
  const [mcpHost, setMcpHost] = useState("127.0.0.1");
  const [mcpStart, setMcpStart] = useState("8000");
  const [mcpEnd, setMcpEnd] = useState("8100");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpMsg, setMcpMsg] = useState("");
  // stdio 接入弹窗：本地命令子进程（如 python -m mcp_server_fetch）
  const [showStdioModal, setShowStdioModal] = useState(false);
  const [stdioMode, setStdioMode] = useState("json"); // json | form
  const [stdioName, setStdioName] = useState("");
  const [stdioCmd, setStdioCmd] = useState("");
  const [stdioArgs, setStdioArgs] = useState("");
  const [stdioEnv, setStdioEnv] = useState("");
  const [stdioJson, setStdioJson] = useState("");
  const [stdioErrs, setStdioErrs] = useState([]); // 弹窗内失败项：{ name, err }
  // 工具质量统计：tool_id → { recent_rate, recent_n, fail, last_err, avg_ms }
  const [stats, setStats] = useState({});
  // 插件 id → 展示名：给「来自插件声明」的 MCP 行写出人话名字，null = 还没需要过
  const [pluginNames, setPluginNames] = useState(null);

  // DeepSeek Harness (dsh) 插件桥：状态（插件列表 + 桥注册）/ 操作互斥 / 结果与错误
  const [dsh, setDsh] = useState(null); // dshStatus() 结果，进页面自动拉取
  const [dshBusy, setDshBusy] = useState(false);
  const [dshMsg, setDshMsg] = useState(""); // 操作结果提示（如导入统计），下次操作时清掉
  const [dshErr, setDshErr] = useState(""); // 失败原因（页面既有红色错误样式）

  const reload = async () => {
    const [t, r, m, s] = await Promise.all([api.listTools(), api.listRuntimes(), api.mcpList(), api.getToolStats().catch(() => [])]);
    setTools(t.tools || []);
    setRuntimes(r.runtimes || []);
    const servers = m.servers || [];
    setMcpServers(servers);
    setStats(Object.fromEntries((Array.isArray(s) ? s : []).map((x) => [x.id, x])));
    if (!runtime && r.runtimes?.length) setRuntime(r.runtimes[0].id);
    // 插件声明的外部连接那行要写清「来自插件 X」：只有真出现这类条目才多拉一次插件列表
    if (!pluginNames && servers.some((x) => x.plugin_id)) {
      api
        .listPlugins()
        .then((r2) => {
          const map = {};
          (r2.plugins || []).forEach((p) => {
            map[p.id] = p.name;
          });
          setPluginNames(map);
        })
        .catch(() => {});
    }
  };
  useEffect(() => {
    reload();
    // dsh 插件桥：进页面自动拉一次状态（桥注册情况 + 插件列表）
    loadDsh();
    // 启动时解释器在后台探测，完成后刷新列表
    const un = listen("runtimes-updated", () => reload());
    // 热加载：AI 注册/更新/删除工具或 MCP 接入后即时刷新清单（免重启）
    const un2 = listen("tools-updated", () => reload());
    return () => {
      un.then((f) => f());
      un2.then((f) => f());
    };
  }, []);

  // 标签页是保活渲染（切走只 display:none），而桥的运行态会在别处变：WorkWith 页启停、
  // 会话联动自动拉起。回到本页重拉一次，并趁页面可见时跟着 workwith 事件走，
  // 否则会出现「进程明明在跑，卡片还写着未运行」「MCP 行还停在暂停态」。
  useEffect(() => {
    if (!visible) return;
    const pull = () => {
      loadDsh();
      reload();
    };
    pull();
    let un;
    listen("workwith", pull)
      .then((f) => (un = f))
      .catch(() => {});
    return () => un && un();
  }, [visible]);

  const refreshRt = async () => {
    setRefreshing(true);
    try {
      const r = await api.refreshRuntimes();
      setRuntimes(r.runtimes || []);
      if (r.runtimes?.length && !r.runtimes.some((x) => x.id === runtime)) {
        setRuntime(r.runtimes[0].id);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const langOf = (id) => runtimes.find((r) => r.id === id)?.lang || "js";

  const onPickRuntime = (id) => {
    setRuntime(id);
    // 若代码还是空/默认脚手架，换成对应语言脚手架
    const lang = langOf(id);
    setCode(SCAFFOLD[lang] || SCAFFOLD.js);
  };

  const parseParams = () => {
    try {
      return JSON.parse(testParams || "{}");
    } catch {
      throw new Error(t("tools.badTestParams"));
    }
  };

  // 先测试再保存：验证脚本可通讯
  const test = async () => {
    setError("");
    setResult({ loading: true });
    try {
      const params = parseParams();
      const r = await api.runScript(runtime, code, params);
      setResult({ ok: true, data: r });
    } catch (e) {
      setResult({ ok: false, data: String(e) });
    }
  };

  const save = async () => {
    setError("");
    if (!name.trim()) return setError(t("tools.errNameRequired"));
    if (!runtime) return setError(t("tools.errRuntimeRequired"));
    try {
      await api.registerScriptTool(name, description, runtime, code);
      setName("");
      setDescription("");
      setResult(null);
      await reload();
      onStats?.();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (id) => {
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("common.confirmDelete"),
        danger: true,
      }))
    )
      return;
    await api.removeTool(id);
    await reload();
    onStats?.();
  };

  // 暂停 / 启用工具：暂停后 AI 与远程都不能调用，但保留定义。
  // 闸门关着（设置页本机操控开关）时点击 = 直接把闸门打开，两层状态一次点清
  const GATE_NAMES = ["screen", "mouse", "keyboard", "draw_diagram", "view_image"];
  const toggle = async (t) => {
    if (t.gate_enabled === false && GATE_NAMES.includes(t.name)) {
      const cur = await api.getDesktopTools();
      const key = { screen: "screen", mouse: "mouse", keyboard: "keyboard", draw_diagram: "diagram", view_image: "viewimage" }[t.name];
      const next = {
        screen: !!cur.screen,
        mouse: !!cur.mouse,
        keyboard: !!cur.keyboard,
        diagram: !!cur.diagram,
        viewimage: !!cur.viewimage,
        ...{ [key]: true },
      };
      await api.setDesktopTools(next.screen, next.mouse, next.keyboard, next.diagram, next.viewimage);
      await reload();
      return;
    }
    await api.setToolEnabled(t.id, !(t.enabled ?? true));
    await reload();
    onStats?.();
  };

  const addRuntime = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await api.addRuntime(rtId, rtName, rtPath, rtLang);
      setRtId("");
      setRtName("");
      setRtPath("");
      setShowAddRt(false);
      await reload();
    } catch (err) {
      setError(String(err));
    }
  };

  const removeRuntime = async (id) => {
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("tools.confirmRemoveRuntime"),
        danger: true,
      }))
    )
      return;
    await api.removeRuntime(id);
    await reload();
  };

  // 暂停 / 启用解释器：暂停后 AI 不能用它执行代码或注册工具
  const toggleRuntime = async (r) => {
    await api.setRuntimeEnabled(r.id, !(r.enabled ?? true));
    await reload();
  };

  // ── MCP：扫描 / 接入 / 开关 / 导入 / 移除 ──
  const scanMcp = async () => {
    setMcpBusy(true);
    setMcpMsg("");
    setMcpFound(null);
    try {
      const r = await api.mcpDiscover(mcpHost.trim() || "127.0.0.1", parseInt(mcpStart) || 8000, parseInt(mcpEnd) || 8100);
      setMcpFound(r.servers || []);
    } catch (e) {
      setMcpMsg(String(e));
    } finally {
      setMcpBusy(false);
    }
  };

  // 接入 = MCP 握手保存 + 立即导入工具清单到注册中心
  const connectMcp = async (url) => {
    setMcpBusy(true);
    setMcpMsg("");
    try {
      const r = await api.mcpConnect(url);
      const imp = await api.mcpImport(r.id);
      setMcpMsg(`${r.server.name}: ${t("tools.mcpImported")} ${imp.imported} · ${t("tools.mcpSkipped")} ${imp.skipped}`);
      setMcpUrl("");
      setMcpFound(null);
      await reload();
      onStats?.();
    } catch (e) {
      setMcpMsg(String(e));
    } finally {
      setMcpBusy(false);
    }
  };

  const toggleMcp = async (s) => {
    await api.mcpToggle(s.id, !(s.enabled ?? true));
    await reload();
  };

  const removeMcp = async (id) => {
    if (
      !(await confirmDialog({
        title: t("dialog.deleteTitle"),
        message: t("tools.confirmRemoveMcp"),
        danger: true,
      }))
    )
      return;
    await api.mcpRemove(id);
    await reload();
    onStats?.();
  };

  const reimportMcp = async (s) => {
    setMcpBusy(true);
    setMcpMsg("");
    try {
      const imp = await api.mcpImport(s.id);
      setMcpMsg(`${s.name}: ${t("tools.mcpImported")} ${imp.imported} · ${t("tools.mcpSkipped")} ${imp.skipped}`);
      await reload();
      onStats?.();
    } catch (e) {
      setMcpMsg(String(e));
    } finally {
      setMcpBusy(false);
    }
  };

  // ── dsh：状态拉取 / 启用桥接 / 插件开关 / 技能导入 ──
  // 拉取 dsh 状态：插件列表 + 桥注册情况（进页面自动调用，操作成功后重刷）
  const loadDsh = async () => {
    try {
      setDsh(await api.dshStatus());
      setDshErr("");
    } catch (e) {
      setDshErr(String(e));
    }
  };

  // 启用桥接 = 确保 dsh 目录存在 + 建/更新 WorkWith 条目（stdio 联动）并启动；成功后重刷
  const enableDshBridge = async () => {
    setDshBusy(true);
    setDshErr("");
    setDshMsg("");
    try {
      await api.dshSetupBridge();
      await loadDsh();
    } catch (e) {
      setDshErr(String(e));
    } finally {
      setDshBusy(false);
    }
  };

  // 桥进程归 WorkWith 托管：这里的启停就是 workwith_stop / workwith_start（条目 id 由后端给）
  const toggleDshBridge = async (bridge) => {
    setDshBusy(true);
    setDshErr("");
    setDshMsg("");
    try {
      if (bridge.running) await api.stopWorkwith(bridge.entry_id);
      else await api.startWorkwith(bridge.entry_id);
      await loadDsh();
    } catch (e) {
      setDshErr(String(e));
    } finally {
      setDshBusy(false);
    }
  };

  // 单个 dsh 插件启用 / 停用：切换后重刷状态
  const toggleDshPlugin = async (p) => {
    setDshBusy(true);
    setDshErr("");
    setDshMsg("");
    try {
      await api.dshTogglePlugin(p.name, !(p.enabled ?? true));
      await loadDsh();
    } catch (e) {
      setDshErr(String(e));
    } finally {
      setDshBusy(false);
    }
  };

  // 一键导入 dsh 技能：完成后展示"已导入 X，跳过 Y"，保持到下次操作
  const importDshSkills = async () => {
    setDshBusy(true);
    setDshErr("");
    setDshMsg("");
    try {
      const r = await api.dshImportSkills();
      setDshMsg(t("tools.dshImported", { imported: r?.imported ?? 0, skipped: r?.skipped ?? 0 }));
    } catch (e) {
      setDshErr(String(e));
    } finally {
      setDshBusy(false);
    }
  };

  // stdio 接入弹窗：打开 / 关闭（Esc 与点遮罩同走 closeStdioModal）
  const openStdioModal = () => {
    setStdioErrs([]);
    setStdioMode("json");
    setShowStdioModal(true);
  };
  const closeStdioModal = () => {
    if (mcpBusy) return;
    setShowStdioModal(false);
    setStdioErrs([]);
  };
  useEffect(() => {
    if (!showStdioModal) return;
    const onKey = (e) => {
      if (e.key === "Escape") closeStdioModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showStdioModal, mcpBusy]);

  // 表单模式提交：spawn 本地命令 + 握手保存 + 导入工具清单；失败留在弹窗内展示
  const submitStdioForm = async () => {
    if (!stdioCmd.trim()) {
      setStdioErrs([{ name: "-", err: t("tools.mcpStdioNeedCommand") }]);
      return;
    }
    setMcpBusy(true);
    setStdioErrs([]);
    try {
      const args = stdioArgs.split("\n").map((l) => l.trim()).filter(Boolean);
      const env = {};
      stdioEnv.split("\n").map((l) => l.trim()).filter(Boolean).forEach((l) => {
        const i = l.indexOf("=");
        if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      });
      const r = await api.mcpAddStdio(stdioName.trim(), stdioCmd.trim(), args, env);
      const imp = await api.mcpImport(r.id);
      setMcpMsg(`${r.server.name}: ${t("tools.mcpImported")} ${imp.imported} · ${t("tools.mcpSkipped")} ${imp.skipped}`);
      setStdioName("");
      setStdioCmd("");
      setStdioArgs("");
      setStdioEnv("");
      setShowStdioModal(false);
      await reload();
      onStats?.();
    } catch (e) {
      setStdioErrs([{ name: stdioCmd.trim(), err: String(e) }]);
    } finally {
      setMcpBusy(false);
    }
  };

  // JSON 模式提交：兼容 mcpServers 包裹 / 单对象 / 裸映射；部分失败列出失败项，成功的照常导入
  const submitStdioJson = async () => {
    setMcpBusy(true);
    setStdioErrs([]);
    try {
      let parsed;
      try {
        parsed = JSON.parse(stripJsonComments(stdioJson));
      } catch {
        setStdioErrs([{ name: "JSON", err: t("tools.mcpStdioBadJson") }]);
        return;
      }
      const entries = entriesFromStdioJson(parsed);
      if (!entries || entries.length === 0) {
        setStdioErrs([{ name: "JSON", err: t("tools.mcpStdioBadJson") }]);
        return;
      }
      const oks = [];
      const errs = [];
      for (const [key, s] of entries) {
        const label = String(key || s?.command || "server");
        if (!s || typeof s.command !== "string" || !s.command.trim()) {
          errs.push({ name: label, err: t("tools.mcpStdioNeedCommand") });
          continue;
        }
        const env = {};
        if (s.env && typeof s.env === "object") {
          for (const [k, v] of Object.entries(s.env)) {
            if (typeof v === "string") env[k] = v;
            else if (typeof v === "number" || typeof v === "boolean") env[k] = String(v);
          }
        }
        try {
          const r = await api.mcpAddStdio(String(key || ""), s.command.trim(), Array.isArray(s.args) ? s.args.map(String) : [], env);
          const imp = await api.mcpImport(r.id);
          oks.push(`${r.server.name}: ${t("tools.mcpImported")} ${imp.imported || 0} · ${t("tools.mcpSkipped")} ${imp.skipped || 0}`);
        } catch (e) {
          errs.push({ name: label, err: String(e) });
        }
      }
      if (oks.length > 0) {
        setMcpMsg(oks.join(" · "));
        await reload();
        onStats?.();
      }
      if (errs.length > 0) {
        setStdioErrs(errs); // 保留弹窗展示失败项
      } else {
        setStdioJson("");
        setShowStdioModal(false);
      }
    } finally {
      setMcpBusy(false);
    }
  };

  const kindTag = (kind) => {
    switch (kind?.kind) {
      case "builtin":
        return { text: t("tools.kindBuiltin"), cls: "accent-solid" };
      case "remote":
        return { text: t("tools.kindRemote"), cls: "" };
      case "script":
        return { text: t("tools.kindScript"), cls: "" };
      case "interpreter":
        return { text: kind.runtime, cls: "border-neutral-900 dark:border-white" };
      case "mcp":
        return { text: "MCP", cls: "" };
      default:
        return { text: t("tools.kindTool"), cls: "" };
    }
  };

  // 左栏分区表：一条目对应右栏一块分组面板，与设置中心同构
  const NAV = [
    { key: "local", head: t("tools.groupLocal"), HeadIcon: IconTool, ids: ["runtimes", "script", "registered"] },
    { key: "conn", head: t("tools.groupConn"), HeadIcon: IconGlobe, ids: ["mcp", "dsh"] },
  ];
  const meta = {
    runtimes: { label: t("tools.runtimesTitle"), icon: IconServer },
    script: { label: t("tools.scriptShort"), icon: IconCode },
    registered: { label: t("tools.registeredTitle"), icon: IconTool },
    mcp: { label: t("tools.mcpShort"), icon: IconGlobe },
    dsh: { label: t("tools.dshShort"), icon: IconPuzzle },
  };
  const flat = new Map();
  for (const g of NAV) for (const id of g.ids) flat.set(id, { id, label: meta[id].label, head: g.head });
  const activeItem = flat.get(sec) || flat.get("runtimes");
  const pickSec = (id) => {
    setSec(id);
    localStorage.setItem(TOOL_SEC_KEY, id);
  };

  const q = query.trim().toLowerCase();
  /** 同自动化页：没搜索词只看选中区，有词则摊开命中条目所在的区 */
  const part = makePart(activeItem.id, q, flat);
  const P = {
    runtimes: part("runtimes", runtimes, (r) => [r.id, r.name, r.path, r.lang, r.version]),
    script: part("script", []),
    registered: part("registered", tools, (x) => [x.name, x.description]),
    mcp: part("mcp", mcpServers, (s) => [s.name, s.url, s.command]),
    dsh: part("dsh", dsh?.plugins || [], (p) => [p.name, p.version]),
  };
  const counts = {
    runtimes: runtimes.length,
    registered: tools.length,
    mcp: mcpServers.length,
    dsh: (dsh?.plugins || []).length,
  };
  // hits：这一区有没有内容命中，左栏要跟着摊开，别出现「正文有结果、左栏说没找到」
  const groups = NAV.map((g) => ({
    ...g,
    items: g.ids.map((id) => ({ id, ...meta[id], count: counts[id], hits: P[id].show })),
  }));
  const anyShow = Object.values(P).some((p) => p.show);
  const { runtimes: pRt, script: pScript, registered: pReg, mcp: pMcp, dsh: pDsh } = P;

  const descOf = {
    runtimes: t("tools.runtimesDesc"),
    script: t("tools.scriptDesc"),
    registered: t("tools.registeredDesc"),
    mcp: t("tools.mcpDesc"),
    dsh: t("tools.dshDesc"),
  }[activeItem.id];

  // 分区级动作：解释器那一区需要重扫与手动登记，别的区动作都在面板里
  const headActions =
    activeItem.id === "runtimes" ? (
      <>
        <button onClick={refreshRt} className="pill pill-outline pill-hover shrink-0" disabled={refreshing}>
          <IconRefresh size={14} />
          {refreshing ? t("tools.probing") : t("tools.refreshDetect")}
        </button>
        <button onClick={() => setShowAddRt((v) => !v)} className="pill pill-outline pill-hover shrink-0">
          <IconPlus size={14} />
          {t("tools.addManual")}
        </button>
      </>
    ) : null;

  return (
    <SectionNav
      eyebrow={`${t("nav.tools")} · ${activeItem.head}`}
      title={activeItem.label}
      desc={descOf}
      actions={headActions}
      groups={groups}
      active={activeItem.id}
      onSelect={pickSec}
      query={query}
      onQuery={setQuery}
      searchPlaceholder={t("tools.find")}
      emptyText={t("common.noMatch")}
    >
      {/* ── 解释器注册 ── */}
      <Section show={pRt.show}>
        {showAddRt && (
          <form onSubmit={addRuntime} className="card grid grid-cols-4 gap-2">
            <input className="field" placeholder={t("tools.rtIdPlaceholder")} value={rtId} onChange={(e) => setRtId(e.target.value)} required />
            <input className="field" placeholder={t("tools.rtPathPlaceholder")} value={rtPath} onChange={(e) => setRtPath(e.target.value)} required />
            <input className="field" placeholder={t("tools.rtNamePlaceholder")} value={rtName} onChange={(e) => setRtName(e.target.value)} />
            <select className="field" value={rtLang} onChange={(e) => setRtLang(e.target.value)}>
              <option value="js">js</option>
              <option value="py">py</option>
              <option value="ts">ts</option>
              <option value="php">php</option>
              <option value="rb">rb</option>
              <option value="pl">pl{t("tools.suffixPerl")}</option>
              <option value="lua">lua</option>
              <option value="r">r</option>
              <option value="jl">jl{t("tools.suffixJulia")}</option>
              <option value="ps1">ps1</option>
              <option value="java">java{t("tools.suffixCompile")}</option>
              <option value="rs">rs{t("tools.suffixCompile")}</option>
              <option value="go">go{t("tools.suffixCompile")}</option>
              <option value="c">c{t("tools.suffixCompile")}</option>
              <option value="cpp">cpp{t("tools.suffixCompile")}</option>
              <option value="cs">cs{t("tools.suffixCompile")}</option>
              <option value="kt">kt{t("tools.suffixCompile")}</option>
              <option value="exe">exe{t("tools.suffixExecutable")}</option>
            </select>
            <div className="col-span-4 flex justify-end">
              <button type="submit" className="pill pill-hover">{t("common.add")}</button>
            </div>
          </form>
        )}

        <div className="card flex flex-col">
          {pRt.items.map((r) => {
            const on = r.enabled ?? true;
            return (
              <div key={r.id} className="flex items-center gap-3 border-b border-neutral-200/60 py-2.5 last:border-0 dark:border-neutral-800/60">
                <div className={`flex min-w-0 flex-1 items-center gap-3 transition-opacity ${on ? "" : "opacity-45"}`}>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-900">
                    <IconTerminal size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{r.id}</span>
                      <span className="chip">{r.lang}</span>
                      {r.mode === "compile" && <span className="chip">{t("tools.chipCompile")}</span>}
                      {r.mode === "exec" && <span className="chip">{t("tools.chipExec")}</span>}
                      {r.manual && <span className="chip">{t("tools.chipManual")}</span>}
                    </div>
                    <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {r.version} · {r.path}
                    </p>
                  </div>
                </div>
                <PillSwitch
                  checked={on}
                  onChange={() => toggleRuntime(r)}
                  title={on ? t("tools.rtEnabledTitle") : t("tools.pausedTitle")}
                />
                <button onClick={() => removeRuntime(r.id)} className="icon-btn shrink-0" title={t("common.remove")}>
                  <IconTrash size={13} />
                </button>
              </div>
            );
          })}
          {pRt.items.length === 0 && (
            <p className="py-4 text-center text-sm text-neutral-400">
              {t("tools.noRuntimes")}
            </p>
          )}
        </div>
      </Section>

      {/* ── MCP 服务器：自动发现 + 接入 ── */}
      <Section show={pMcp.show}>
        {/* 扫描行：host + 端口范围 + 手动 URL */}
        <div className="card grid grid-cols-6 gap-2">
          <input className="field font-mono" title="Host" value={mcpHost} onChange={(e) => setMcpHost(e.target.value)} />
          <input className="field font-mono" placeholder={t("tools.mcpFrom")} value={mcpStart} onChange={(e) => setMcpStart(e.target.value)} inputMode="numeric" />
          <input className="field font-mono" placeholder={t("tools.mcpTo")} value={mcpEnd} onChange={(e) => setMcpEnd(e.target.value)} inputMode="numeric" />
          <button onClick={scanMcp} className="pill pill-outline pill-hover" disabled={mcpBusy}>
            <IconRefresh size={14} />
            {mcpBusy ? t("tools.mcpScanning") : t("tools.mcpScan")}
          </button>
          <input
            className="field col-span-2 font-mono"
            placeholder={t("tools.mcpManualUrl")}
            value={mcpUrl}
            onChange={(e) => setMcpUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && mcpUrl.trim() && connectMcp(mcpUrl.trim())}
          />
        </div>

        {/* stdio 接入：弹窗式手动配置（JSON / 表单双模式） */}
        <div className="card flex justify-end">
          <button onClick={openStdioModal} className="pill pill-outline pill-hover" disabled={mcpBusy}>
            <IconPlus size={14} />
            {t("tools.mcpStdioAdd")}
          </button>
        </div>

        {mcpMsg && <p className="card text-xs text-neutral-500 dark:text-neutral-400">{mcpMsg}</p>}

        {/* 扫描结果 */}
        {mcpFound && mcpFound.length > 0 && (
          <div className="card flex flex-col gap-2">
            {mcpFound.map((d) => (
              <div key={d.url} className="flex items-center gap-3 rounded-2xl border border-dashed border-neutral-300 px-4 py-2.5 dark:border-neutral-700">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-900">
                  <IconGlobe size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{d.name}</span>
                    <span className="chip">{d.version || "MCP"}</span>
                  </div>
                  <p className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">{d.url}</p>
                </div>
                <button onClick={() => connectMcp(d.url)} className="pill pill-hover" disabled={mcpBusy}>
                  <IconPlus size={14} />
                  {t("tools.mcpConnect")}
                </button>
              </div>
            ))}
          </div>
        )}
        {mcpFound && mcpFound.length === 0 && (
          <p className="mb-3 rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400 dark:border-neutral-700">{t("tools.mcpNone")}</p>
        )}

        {/* 已接入列表：圆片开关（暂停/继续）+ 重新导入 + 移除 */}
        <div className="card flex flex-col">
          {pMcp.items.map((s) => {
            const on = s.enabled ?? true;
            const toolCount = tools.filter(
              (tl) => tl.kind?.kind === "mcp" && tl.kind?.server_id === s.id
            ).length;
            return (
              <div key={s.id} data-bit-mcp-row={s.id} className="flex items-center gap-3 border-b border-neutral-200/60 py-2.5 last:border-0 dark:border-neutral-800/60">
                <div className={`flex min-w-0 flex-1 items-center gap-3 transition-opacity ${on ? "" : "opacity-45"}`}>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-900">
                    <IconGlobe size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{s.name}</span>
                      <span className="chip">{s.transport === "stdio" ? "stdio" : "MCP"}</span>
                      {/* ww- 前缀 = 这一行是 WorkWith 托管条目联动出来的，进程归服务页管 */}
                      {s.id.startsWith("ww-") && <span className="chip">{t("tools.mcpHostedByWw")}</span>}
                      {/* plugin_id 有值 = 插件清单 connections[] 声明的外部连接，生命周期归插件页管 */}
                      {s.plugin_id && (
                        <span className="chip" title={t("tools.mcpPluginHint")}>
                          {t("tools.mcpFromPlugin", { name: pluginNames?.[s.plugin_id] || s.plugin_id })}
                        </span>
                      )}
                      <span className="chip">{toolCount} {t("tools.mcpTools")}</span>
                    </div>
                    <p className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
                      {s.transport === "stdio" ? [s.command, ...(s.args || [])].join(" ") : s.url}
                    </p>
                  </div>
                </div>
                {s.plugin_id ? (
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent("bit-open-page", { detail: { page: "plugins", plugin: s.plugin_id } }))}
                    className="btn btn-ghost shrink-0 text-xs"
                    title={t("tools.mcpManageInPlugin")}
                  >
                    {t("tools.mcpManageInPlugin")}
                  </button>
                ) : (
                  <>
                    <button onClick={() => reimportMcp(s)} className="icon-btn shrink-0" title={t("tools.mcpImport")} disabled={mcpBusy}>
                      <IconRefresh size={13} />
                    </button>
                    <PillSwitch
                      checked={on}
                      onChange={() => toggleMcp(s)}
                      title={on ? t("tools.mcpEnabledTitle") : t("tools.pausedTitle")}
                    />
                    <button onClick={() => removeMcp(s.id)} className="icon-btn shrink-0" title={t("common.remove")}>
                      <IconTrash size={13} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {pMcp.items.length === 0 && (
            <p className="py-4 text-center text-sm text-neutral-400">{t("tools.mcpEmpty")}</p>
          )}
        </div>
      </Section>

      {/* ── DeepSeek Harness (dsh) 插件：桥接后插件工具经 MCP 接入，技能可一键导入 ── */}
      <Section show={pDsh.show}>
        {/* 状态行：桥由 WorkWith 托管，注册（条目存在）与运行（进程活着）是两回事 */}
        <div className="card flex flex-wrap items-center gap-3">
          {dshBusy && <span className="text-xs text-neutral-500">…</span>}
          {dsh?.bridge?.registered && (
            <span className={`pill-outline ${dsh.bridge.running ? "text-emerald-600" : "text-neutral-500"}`}>
              {dsh.bridge.running ? t("tools.dshBridgeOn") : t("tools.dshBridgeStopped")}
            </span>
          )}
          {dsh?.bridge?.registered && (
            <button
              onClick={() => toggleDshBridge(dsh.bridge)}
              className="pill pill-outline pill-hover"
              disabled={dshBusy}
            >
              {dsh.bridge.running ? t("tools.dshBridgeStop") : t("tools.dshBridgeStart")}
            </button>
          )}
          {dsh?.bridge?.registered && (
            <span className="text-xs text-neutral-400">{t("tools.dshHosted")}</span>
          )}
          {dsh && !dsh.bridge?.registered && (
            <>
              <span className="pill-outline text-neutral-500">{t("tools.dshBridgeOff")}</span>
              <button onClick={enableDshBridge} className="pill pill-hover" disabled={dshBusy}>
                {t("tools.dshEnable")}
              </button>
            </>
          )}
        </div>

        {/* 结果提示（导入统计）与失败原因（沿用本页红色错误样式） */}
        {dshMsg && <p className="card text-xs text-neutral-500 dark:text-neutral-400">{dshMsg}</p>}
        {dshErr && <p className="card break-all text-xs text-red-600">{dshErr}</p>}

        {/* 插件列表：name + 版本灰字 + 圆片开关（切换即 dsh_toggle_plugin 后重刷） */}
        <div className="card flex flex-col">
          {pDsh.items.map((p) => {
            const on = p.enabled ?? true;
            return (
              <div key={p.name} className="flex items-center gap-3 border-b border-neutral-200/60 py-2.5 last:border-0 dark:border-neutral-800/60">
                <div className={`flex min-w-0 flex-1 items-center gap-3 transition-opacity ${on ? "" : "opacity-45"}`}>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-900">
                    <IconTool size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{p.name}</span>
                      {/* 版本灰字，没版本就不占位 */}
                      {p.version && <span className="text-xs text-neutral-400">{p.version}</span>}
                    </div>
                  </div>
                </div>
                <PillSwitch
                  checked={on}
                  onChange={() => toggleDshPlugin(p)}
                  disabled={dshBusy}
                  title={on ? t("tools.dshPluginOn") : t("tools.dshPluginOff")}
                />
              </div>
            );
          })}
          {/* 空列表：等状态拉到后再提示，避免加载瞬间闪"空" */}
          {dsh && pDsh.items.length === 0 && (
            <p className="py-4 text-center text-sm text-neutral-400">{t("tools.dshEmpty")}</p>
          )}
        </div>

        {/* 底部：一键导入 dsh 插件生态里的技能 */}
        <div className="card flex justify-end">
          <button onClick={importDshSkills} className="pill pill-outline pill-hover" disabled={dshBusy}>
            <IconRefresh size={14} />
            {t("tools.dshImportSkills")}
          </button>
        </div>
      </Section>

      <Section show={pScript.show}>
        <div className="card">
        <div className="mb-2 grid grid-cols-3 gap-2">
          <select className="field" value={runtime} onChange={(e) => onPickRuntime(e.target.value)}>
            {runtimes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}{t("tools.parenOpen")}{r.lang}{t("tools.parenClose")}
              </option>
            ))}
          </select>
          <input className="field" placeholder={t("tools.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
          <input className="field" placeholder={t("tools.descPlaceholder")} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <textarea
          className="field h-44 rounded-[var(--look-ui-radius,1rem)] p-3 font-mono text-xs"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
        />

        <div className="mt-2 grid grid-cols-3 gap-2">
          <input
            className="field col-span-3 font-mono"
            placeholder={t("tools.testParamsPlaceholder")}
            value={testParams}
            onChange={(e) => setTestParams(e.target.value)}
          />
        </div>

        {error && <p className="mt-2 px-2 text-xs text-red-600">{error}</p>}

        <div className="mt-3 flex justify-end gap-2">
          <button onClick={test} className="pill pill-outline pill-hover" disabled={!runtime}>
            <IconPlay size={14} />
            {t("tools.testRun")}
          </button>
          <button onClick={save} className="pill pill-hover" disabled={!runtime}>
            <IconTool size={14} />
            {t("tools.saveAsTool")}
          </button>
        </div>

        {result && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-xs font-semibold">{t("tools.runResult")}</span>
              <span className={`chip ${result.ok ? "accent-solid" : "text-red-600"}`}>
                {result.loading ? t("common.running") : result.ok ? t("common.success") : t("common.failed")}
              </span>
            </div>
            <textarea
              className="field h-28 rounded-[var(--look-ui-radius,1rem)] p-3 font-mono text-xs"
              readOnly
              value={result.loading ? "…" : JSON.stringify(result.data, null, 2)}
            />
          </div>
        )}
        </div>
      </Section>

      <Section show={pReg.show}>

        {pReg.items.length > 0 && (
          <div className="card flex items-center gap-3 pb-1 text-[11px] font-medium text-neutral-400">
            <span className="flex-1">{t("tools.colName")}</span>
            <span className="w-16 text-center">{t("tools.colEnabled")}</span>
            <span className="w-8 text-center">{t("tools.colActions")}</span>
          </div>
        )}

        <div className="card flex flex-col">
          {pReg.items.map((tool) => {
            const k = kindTag(tool.kind);
            const on = tool.enabled ?? true;
            // gate_enabled：设置页"本机操控"闸门（screen/mouse/keyboard/draw_diagram/view_image）。
            // 关闭时工具对 AI 不可见——此处同步呈现为停用，避免与设置页状态分裂
            const gated = tool.gate_enabled === false;
            const effOn = on && !gated;
            return (
              <div
                key={tool.id}
                className="flex items-center gap-3 border-b border-neutral-200/60 py-3 last:border-0 dark:border-neutral-800/60"
              >
                <div className={`min-w-0 flex-1 transition-opacity ${effOn ? "" : "opacity-45"}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{tool.name}</span>
                    <span className={`chip ${k.cls}`}>{k.text}</span>
                    <span className="chip">{tool.created_by}</span>
                    {gated && (
                      <span className="chip text-amber-600 dark:text-amber-400" title={t("tools.gatedTip")}>
                        {t("tools.gated")}
                      </span>
                    )}
                    {/* 质量徽章：近期成功率（≥80% 绿 / 50-80% 灰 / <50% 黄），悬停看最近失败原因 */}
                    {stats[tool.id]?.recent_n > 0 &&
                      (() => {
                        const st = stats[tool.id];
                        const pct = Math.round((st.recent_rate || 0) * 100);
                        const cls =
                          pct >= 80
                            ? "text-emerald-600 dark:text-emerald-400"
                            : pct >= 50
                              ? "text-neutral-500 dark:text-neutral-400"
                              : "text-amber-600 dark:text-amber-400";
                        return (
                          <span
                            className={`chip ${cls}`}
                            title={
                              (st.last_err
                                ? `${t("tools.lastErr")}: ${st.last_err} · `
                                : "") +
                              `${t("tools.avgMs")}: ${st.avg_ms}ms · ${t("tools.failCount")}: ${st.fail}`
                            }
                          >
                            {t("tools.successRate")} {pct}% ({st.recent_n})
                          </span>
                        );
                      })()}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {tool.description || t("tools.noDesc")}
                  </p>
                </div>
                <div className="flex w-16 justify-center">
                  <PillSwitch
                    checked={effOn}
                    onChange={() => toggle(tool)}
                    title={gated ? t("tools.gatedTip") : effOn ? t("tools.enabledTitle") : t("tools.pausedTitle")}
                  />
                </div>
                <div className="flex w-8 justify-center">
                  {tool.kind?.kind !== "builtin" && (
                    <button onClick={() => remove(tool.id)} className="icon-btn shrink-0" title={t("common.delete")}>
                      <IconTrash size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {pReg.items.length === 0 && (
            <p className="py-4 text-center text-sm text-neutral-400">{t("tools.empty")}</p>
          )}
        </div>
      </Section>

      {q && !anyShow && (
        <p className="rounded-2xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
          {t("common.noMatch")}
        </p>
      )}

      {/* ── stdio 手动配置弹窗：JSON / 表单双模式，Esc 或点遮罩关闭 ── */}
      {showStdioModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={closeStdioModal}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="card flex max-h-[85vh] flex-col overflow-hidden shadow-[inset_0_2px_14px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_2px_14px_rgba(0,0,0,0.45)]"
            style={{ width: "min(90vw, 720px)" }}
          >
            {/* 头部：标题 + 模式切换 + 关闭 */}
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">{t("tools.mcpStdioConfigure")}</h3>
              <div className="mx-auto flex items-center gap-0.5 rounded-full bg-neutral-100 p-0.5 dark:bg-neutral-900">
                {[
                  ["json", t("tools.mcpStdioRaw")],
                  ["form", t("tools.mcpStdioForm")],
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setStdioMode(mode)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-200 ${
                      stdioMode === mode ? "accent-solid" : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button onClick={closeStdioModal} className="icon-btn shrink-0" title={t("common.close")} disabled={mcpBusy}>
                <IconX size={14} />
              </button>
            </div>

            {/* 主体：JSON 大输入框 或 表单字段 */}
            <div className="mt-3 flex-1 overflow-y-auto">
              {stdioMode === "json" ? (
                <textarea
                  className="field rounded-[var(--look-ui-radius,1rem)] min-h-[300px] w-full resize-y font-mono text-xs"
                  value={stdioJson}
                  onChange={(e) => setStdioJson(e.target.value)}
                  placeholder={STDIO_JSON_EXAMPLE}
                  spellCheck={false}
                />
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  <input className="field" placeholder={t("tools.mcpStdioName")} value={stdioName} onChange={(e) => setStdioName(e.target.value)} />
                  <input className="field col-span-3 font-mono" placeholder={t("tools.mcpStdioCommand")} value={stdioCmd} onChange={(e) => setStdioCmd(e.target.value)} />
                  <textarea className="field col-span-2 rounded-[var(--look-ui-radius,1rem)] font-mono" rows={4} placeholder={t("tools.mcpStdioArgs")} value={stdioArgs} onChange={(e) => setStdioArgs(e.target.value)} />
                  <textarea className="field col-span-2 rounded-[var(--look-ui-radius,1rem)] font-mono" rows={4} placeholder={t("tools.mcpStdioEnv")} value={stdioEnv} onChange={(e) => setStdioEnv(e.target.value)} />
                </div>
              )}
              {stdioErrs.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {stdioErrs.map((f, i) => (
                    <p key={i} className="text-xs text-red-500 dark:text-red-400">
                      <span className="font-semibold">{f.name}</span> · {f.err}
                    </p>
                  ))}
                </div>
              )}
            </div>

            {/* 底部：风险提示 + 取消/确认 */}
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="flex min-w-0 items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                {t("tools.mcpStdioRisk")}
              </p>
              <div className="flex shrink-0 gap-2">
                <button onClick={closeStdioModal} className="pill pill-outline pill-hover" disabled={mcpBusy}>
                  {t("tools.mcpStdioCancel")}
                </button>
                <button
                  onClick={stdioMode === "json" ? submitStdioJson : submitStdioForm}
                  className="pill pill-hover"
                  disabled={mcpBusy}
                >
                  {t("tools.mcpStdioConfirm")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </SectionNav>
  );
}
