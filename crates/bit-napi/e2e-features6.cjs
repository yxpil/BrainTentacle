// 六功能 e2e（F4 重生成手术 / F5 提示词模板）：直调 bit_napi.node，临时数据目录不碰真实数据
// 运行：node crates/bit-napi/e2e-features6.cjs
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const mod = { exports: {} };
process.dlopen(mod, path.join(__dirname, 'bit_napi.node'));
const bit = mod.exports;

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    failed = true;
    console.error(`✗ ${msg}`);
  } else {
    console.log(`✓ ${msg}`);
  }
};

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-e2e-f6-'));
  console.log(`数据目录: ${dataDir}`);
  bit.onUiEvent(() => {});
  bit.onHostExit(() => {});
  await bit.hostStart(dataDir, '0.6.24-e2e', null, null);
  console.log('✓ hostStart 完成');

  // ---------- F5 提示词模板 ----------
  let r = await bit.invoke('prompt_templates_get');
  assert(Array.isArray(r.templates) && r.templates.length === 5, `内置模板 5 条 → ${r.templates.length}`);
  assert(r.templates.some((t) => t.id === 'translate'), '内置含 translate');

  await bit.invoke('prompt_templates_set', {
    templates: [
      { id: 'a', title: '测试A', text: '把下面的内容改写成小红书风格：' },
      { id: '', title: '   ', text: '   ' }, // 空模板应被丢弃
      { title: '测试B', text: '总结要点：' }, // 无 id 自动补
    ],
  });
  r = await bit.invoke('prompt_templates_get');
  assert(
    r.templates.length === 2 && r.templates[0].title === '测试A' && r.templates[1].title === '测试B',
    `自定义保存（去空/补 id）→ [${r.templates.map((t) => t.title).join(', ')}]`
  );

  await bit.invoke('prompt_templates_set', { templates: [] });
  r = await bit.invoke('prompt_templates_get');
  assert(r.templates.length === 5, `空列表恢复内置默认 → ${r.templates.length}`);

  // ---------- F4 regenerate_last ----------
  // 空会话 → 明确报错
  const s = await bit.invoke('create_session', { title: 'e2e重发' });
  const sid = s.id;
  assert(!!sid, `create_session → ${sid}`);
  let err = '';
  try {
    await bit.invoke('regenerate_last', { session_id: sid, event_name: 'e2e-regen' });
  } catch (e) {
    err = String(e?.message || e);
  }
  assert(/没有可重发的消息/.test(err), `空会话重发报错 → ${err}`);

  // 直写 sessions 表造一条两回合历史，验证手术：pop 尾部 assistant + edit_text 改写最后一条 user
  const dbFile = fs.readdirSync(dataDir).find((f) => f.endsWith('.db'));
  assert(!!dbFile, `找到数据库 ${dbFile}`);
  const now = '2099-01-01 00:00:00';
  const data = JSON.stringify({
    id: sid,
    title: 'e2e重发',
    created: now,
    updated: now,
    favorite: false,
    color: '',
    messages: [
      { role: 'user', content: '原始问题' },
      { role: 'assistant', content: '回答A' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '回答B' },
    ],
  }).replace(/'/g, "''");
  execFileSync(
    'sqlite3',
    [path.join(dataDir, dbFile), `INSERT OR REPLACE INTO sessions(id, ord, updated, data) VALUES('${sid}', 999, '${now}', '${data}');`]
  );
  // bump 会话版本计数器（merge_from_disk 的 rev 守卫据此判定库侧有新写入）
  execFileSync(
    'sqlite3',
    [path.join(dataDir, dbFile), `INSERT OR REPLACE INTO meta(key, value) VALUES('sessions_rev', '99999');`]
  );

  // 读前刷新（list_sessions 内部 refresh_from_disk）把库侧行并入内存
  await bit.invoke('list_sessions');

  // AI 未配置 → 手术后流式报错，但消息手术已持久化
  let err2 = '';
  try {
    await bit.invoke('regenerate_last', {
      session_id: sid,
      event_name: 'e2e-regen',
      edit_text: '修改后的第二问',
    });
  } catch (e) {
    err2 = String(e?.message || e);
  }
  assert(err2.length > 0 && !/没有可重发的消息/.test(err2), `重发执行报错（AI 未配置属预期）→ ${err2.slice(0, 60)}`);

  const g = await bit.invoke('get_session', { session_id: sid });
  const msgs = g.messages || [];
  assert(msgs.length === 3, `尾部 assistant 已弹出：4 → ${msgs.length}`);
  assert(
    msgs[0].content === '原始问题' && msgs[1].content === '回答A' && msgs[2].content === '修改后的第二问',
    `手术+改写正确 → [${msgs.map((m) => `${m.role}:${m.content}`).join(' | ')}]`
  );

  // 清理临时目录
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failed ? '\n存在失败项 ✗' : '\n六功能 e2e 全部通过 ✔');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('e2e 失败:', e);
  process.exit(1);
});
