// yxpil · 开发糖示例的常驻服务（CommonJS）
//
// 与 server.mjs 同一份 SDK，只是走 require：证明两种模块系统都能拿到。
// 这个服务不开端口，只把心跳写进插件自己的数据目录，验收探针从宿主侧读回来看。
const bit = require("bit");

async function beat() {
  const info = await bit.info();
  const runtimes = await bit.runtime.list();
  await bit.data.writeJSON("cjs-proof.json", {
    from: "svc/cjs.js",
    module: "commonjs",
    plugin_id: info.plugin_id,
    service: bit.env.service,
    perms: bit.env.perms,
    runtime_ids: runtimes.map((r) => r.id),
    at: new Date().toISOString(),
  });
  bit.log("心跳已写入 cjs-proof.json");
}

beat()
  .then(() => {
    // 之后每 30 秒一次：探针晚点到也能看见最新时间
    setInterval(() => beat().catch((e) => bit.warn("心跳失败", e.message)), 30000);
  })
  .catch((e) => bit.error("常驻服务起不来:", e.name, e.message));
