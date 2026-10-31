// 上下文自动压缩配置 e2e：compact_config 读写往返
import { createRequire } from "node:module";
const b = createRequire("/tmp/bt-clone/crates/bit-napi/noop.js")("/tmp/bt-clone/crates/bit-napi/bit_napi.node");
b.hostStart();
await new Promise((r) => setTimeout(r, 1500));
console.log("get(default):", JSON.stringify(await b.invoke("compact_config_get", {})));
console.log("set(30000):", JSON.stringify(await b.invoke("compact_config_set", { auto: true, chars: 30000, provider: "" })));
await b.invoke("compact_config_set", { auto: false, chars: 24000, provider: "" });
console.log("restored:", JSON.stringify(await b.invoke("compact_config_get", {})));
process.exit(0);
