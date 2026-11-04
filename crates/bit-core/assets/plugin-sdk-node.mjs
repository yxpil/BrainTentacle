// yxpil · 插件进程侧 SDK 的 ESM 出口
//
// Node 的 ESM 解析不认 NODE_PATH，只按目录往上找 node_modules——所以插件包
// （toolhomes/plugins/<id>/**）里的 `import "bit"` 会落到这里。
// 实现只有一份（index.cjs），这个文件负责把同一份东西以 ESM 形状交出去，
// 具名导出与默认导出都给全，避免"能 require 不能 import"这种半吊子。
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const bit = require("./index.cjs");

export const {
  VERSION,
  BitError,
  env,
  cap,
  can,
  chat,
  history,
  info,
  caps,
  settings,
  data,
  fs,
  sessions,
  services,
  server,
  net,
  exec,
  runtime,
  notify,
  sleep,
  log,
  warn,
  error,
} = bit;

export default bit;
