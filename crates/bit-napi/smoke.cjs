// yxpil · BIT napi 冒烟测试（M1-e）
// 验证链路：hostStart（Ctx 装载 + tokio 运行时）→ invoke 白名单命令 → TSFN UI 事件回流。
// 运行：node crates/bit-napi/smoke.cjs
// 用临时数据目录，不碰真实数据。
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const mod = { exports: {} };
process.dlopen(mod, path.join(__dirname, 'bit_napi.node'));
const bit = mod.exports;

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
};

(async () => {
  // 0. 导出面检查：只允许四个入口，密钥/解密原语绝不暴露
  const fns = Object.keys(bit).sort();
  assert(
    JSON.stringify(fns) === JSON.stringify(['hostStart', 'invoke', 'onHostExit', 'onUiEvent']),
    `导出面 = ${fns.join(', ')}`
  );

  // 1. 临时数据目录
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-napi-smoke-'));
  console.log(`数据目录: ${dataDir}`);

  // 2. UI 事件回调：计数 + 记录
  const events = [];
  bit.onUiEvent((e) => {
    events.push(e);
  });
  assert(true, 'onUiEvent 注册成功');

  // 2.5 退出回调注册（quit_app 链路用；此处验证可注册不崩）
  bit.onHostExit(() => {});
  assert(true, 'onHostExit 注册成功');

  // 3. 宿主点火（Ctx 装载 + bit.db 初始化；worker_exe/app_exe 走 None 路径）
  await bit.hostStart(dataDir, '0.6.23-smoke', null, null);
  assert(true, 'hostStart 完成');

  // 4. invoke 白名单命令
  const overview = await bit.invoke('get_overview');
  assert(
    typeof overview.tool_count === 'number' && 'ai_configured' in overview,
    `get_overview → tools=${overview.tool_count} ai=${overview.ai_configured}`
  );

  const mem = await bit.invoke('mem_usage');
  assert(mem.bytes > 0, `mem_usage → ${(mem.bytes / 1024 / 1024).toFixed(1)} MB`);

  const headless = await bit.invoke('is_headless');
  assert(typeof headless.headless === 'boolean', `is_headless → ${headless.headless}`);

  const tools = await bit.invoke('list_tools');
  assert(Array.isArray(tools.tools) && tools.tools.length > 0, `list_tools → ${tools.tools.length} 个工具`);

  // 5. 白名单外拒绝
  let rejected = false;
  try {
    await bit.invoke('__no_such_cmd__');
  } catch (e) {
    rejected = /未知命令/.test(String(e.message || e));
  }
  assert(rejected, '未知命令被拒绝（白名单生效）');

  // 6. TSFN 事件回流：ui_mounted 应触发一条 audit 相关事件流（无事件也算通过——
  //    事件经 NoopEmitter 之外的路径，这里只验证回调通路不崩）
  await bit.invoke('ui_mounted');
  await new Promise((r) => setTimeout(r, 300));
  console.log(`TSFN 事件数: ${events.length}`);
  assert(true, 'TSFN 通路无崩溃');

  // 7. hostStart 幂等：重复点火不崩
  await bit.hostStart(dataDir, '0.6.23-smoke', null, null);
  assert(true, 'hostStart 幂等');

  console.log('\n全部冒烟通过 ✔');
  process.exit(0);
})().catch((e) => {
  console.error('冒烟失败:', e);
  process.exit(1);
});
