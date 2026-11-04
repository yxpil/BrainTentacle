// yxpil · 开发糖示例的解释器工具（CommonJS）
//
// 工具源码会被宿主写进临时文件再执行，工作目录是 toolhomes、NODE_PATH 指向
// toolhomes/node_modules——所以这里用 require("bit")（ESM 不认 NODE_PATH，
// 只有落在插件目录里的服务/服务器两种写法都能用）。
// 约定：stdin 收 JSON 参数，stdout 出 JSON 结果；日志一律走 stderr。
const bit = require("bit");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  let params = {};
  try {
    params = JSON.parse(raw || "{}");
  } catch (e) {
    process.stderr.write("参数不是 JSON，按空对象处理\n");
  }
  const out = { tool: "sdk_probe", echo_keys: Object.keys(params), steps: [], error: "" };
  try {
    const info = await bit.info();
    out.identity = { id: info.plugin_id, name: info.plugin_name, perms: info.permissions };
    out.env = { id: bit.env.id, service: bit.env.service, api: bit.env.api, dir_seen: !!bit.env.dir };
    out.can = { data: bit.can("data"), exec: bit.can("exec"), nope: bit.can("root") };
    const runtimes = await bit.runtime.list();
    out.runtimes = runtimes.map((r) => r.id).slice(0, 12);
    // 写一次自己的数据目录：证明工具进程也带着可用凭据
    await bit.data.writeJSON("tool-proof.json", { at: new Date().toISOString(), runtimes: out.runtimes.length });
    out.data_written = true;
    // 未申报的能力必须被宿主拒绝（这个插件没申报 session）
    try {
      await bit.cap("session.list", {});
      out.undeclared = "not-refused";
    } catch (e) {
      out.undeclared = String(e.message).slice(0, 80);
      out.undeclared_status = e.status;
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  process.stdout.write(JSON.stringify(out));
});
