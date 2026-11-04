// yxpil · 开发糖示例的自带服务器（ESM）
//
// 这一份证明的是：插件服务在 toolhomes/plugins/<id>/ 里，Node 沿目录往上找
// node_modules 就能看到宿主物化的 toolhomes/node_modules/bit，
// 所以 `import bit from "bit"` 与 `require("bit")` 都不需要插件自己配路径。
// 凭据来自宿主注入的 BIT_PLUGIN_* 环境变量，进程不需要知道端口从哪儿来。
import http from "http";
import bit, { cap } from "bit";

const PORT = bit.env.port || Number(process.env.BIT_PLUGIN_PORT || 0);

// 开局把这条链路能做的事各跑一遍，结果挂在 /api/sugar 上给验收探针读
const proof = { ok: false, started_at: new Date().toISOString(), steps: [], errors: [] };

function step(name, value) {
  proof.steps.push({ name, value });
  bit.log(name, JSON.stringify(value).slice(0, 160));
}

async function main() {
  const info = await cap("info");
  step("info", { id: info.plugin_id, name: info.plugin_name, perms: info.permissions });
  step("can", { exec: bit.can("exec"), rootkit: bit.can("root") });
  step("sdk", { version: bit.VERSION, api: bit.env.api, service: bit.env.service, dir: bit.env.dir });

  const runtimes = await bit.runtime.list();
  step("runtime_list", { count: runtimes.length, ids: runtimes.map((r) => r.id).slice(0, 12) });

  await bit.data.writeJSON("sugar-esm.json", { from: "server.mjs", at: Date.now() });
  const back = await bit.data.readJSON("sugar-esm.json");
  step("data_roundtrip", { from: back && back.from, bytes: JSON.stringify(back || {}).length });

  await bit.settings.set("last_boot", new Date().toISOString());
  step("settings_roundtrip", { key: "last_boot", got: String(await bit.settings.get("last_boot")).slice(0, 32) });

  // 解释器白名单：清单里只声明了 node，所以 exec.node 可用、shell 命令应当被拒
  const nodeRun = await bit.exec.node(["-e", "console.log('from-bit-sdk')"]);
  step("exec_node", { code: nodeRun.code, out: String(nodeRun.stdout || "").trim() });
  let shellDenied = "";
  try {
    await bit.exec.run("echo should-be-denied");
    shellDenied = "not-denied";
  } catch (e) {
    shellDenied = String(e.message).slice(0, 120);
  }
  step("exec_shell_denied", shellDenied);

  proof.ok = true;
}

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, plugin: bit.env.id }));
    return;
  }
  if (req.url === "/api/sugar") {
    res.end(JSON.stringify({ ...proof, errors: proof.errors }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  bit.log(`开发糖服务器在听 ${PORT}`);
  main().catch((e) => {
    proof.errors.push(String((e && e.message) || e));
    bit.warn("开局自检失败:", (e && e.name) || "", String((e && e.message) || e));
  });
});
