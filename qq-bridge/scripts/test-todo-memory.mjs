// 验证 todo 类：写入、到期、formatMemoryV2 展示、全局归属。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import assert from 'node:assert/strict';

const P = 'private:10001';
const G = 'group:20001';

let fails = 0;
const ok = (l, c) => { if (!c) fails += 1; console.log(`${c ? '✅' : '❌'} ${l}`); };

const h = await bridgeHarness({
  config: {
    ownerQQ: 10001,
    allow: { private: ['10001'], groups: ['20001'] },
    socialV2: { sticker: { enabled: false } },
  },
});
h.setMode('reserved2');

try {
  // ① 归属：todo 必须全局
  ok('todo 归全局', h.memoryKeyFor('todo', P) === 'global');
  ok('todo 从群问也归全局', h.memoryKeyFor('todo', G) === 'global');
  ok('activeTopic 仍按会话', h.memoryKeyFor('activeTopic', P) === P);
  ok('pendingThought 仍按会话', h.memoryKeyFor('pendingThought', G) === G);

  // ② 写入
  const g = h.getSocialV2State('global');
  g.todos = [];
  h.appendMemoryV2(g, 'todo', '明天讲那张刀子卡片', { sessionKey: P });
  ok('写进全局 todos', (h.getSocialV2State('global').todos || []).length === 1);

  // ③ 默认 TTL 48h
  const t = h.getSocialV2State('global').todos[0];
  const hours = Math.round((t.expiresAt - Date.now()) / 3600000);
  ok(`默认 48 小时到期（实际 ${hours}h）`, hours === 48);

  // ④ 自定义到期：2 小时
  h.appendMemoryV2(g, 'todo', '六点十分提醒他拿快递', { sessionKey: P, dueAtMs: 2 * 3600000 });
  const t2 = h.getSocialV2State('global').todos.find((x) => x.text.includes('快递'));
  const h2 = Math.round((t2.expiresAt - Date.now()) / 3600000);
  ok(`可指定到期（实际 ${h2}h）`, h2 === 2);

  // ⑤ 重复写同一件事：延后到期，不新增
  const before = h.getSocialV2State('global').todos.length;
  h.appendMemoryV2(g, 'todo', '六点十分提醒他拿快递', { sessionKey: P, dueAtMs: 5 * 3600000 });
  const after = h.getSocialV2State('global').todos.length;
  const t3 = h.getSocialV2State('global').todos.find((x) => x.text.includes('快递'));
  const h3 = Math.round((t3.expiresAt - Date.now()) / 3600000);
  ok('重复写不新增条目', before === after);
  ok(`重复写会延后到期（${h2}h → ${h3}h）`, h3 === 5);

  // ⑥ 过期自动消失
  h.appendMemoryV2(g, 'todo', '已经过期的事', { sessionKey: P, dueAtMs: 1 });
  const beforeExpire = h.getSocialV2State('global').todos.length;
  await new Promise((r) => setTimeout(r, 30));
  h.appendMemoryV2(g, 'todo', '触发一次清理', { sessionKey: P });
  const afterExpire = h.getSocialV2State('global').todos.length;
  ok('过期条目在下一次写入时被清掉', !h.getSocialV2State('global').todos.some((x) => x.text === '已经过期的事'));

  // ⑦ formatMemoryV2 展示
  const text = h.formatMemoryV2({
    activeTopics: [],
    pendingThoughts: [],
    todos: h.getSocialV2State('global').todos,
    memberImpressions: {},
    selfNotes: [],
  }, P);
  console.log('\n--- formatMemoryV2 输出 ---');
  console.log(text);
  console.log('--- end ---\n');
  ok('有【待办】段', text.includes('【待办】'));
  ok('显示剩余时间', /还剩\s*\d+\s*(小时|天)/.test(text));

  // ⑧ 空库也要有【待办】行（不能消失）
  const empty = h.formatMemoryV2({ activeTopics: [], pendingThoughts: [], todos: [], memberImpressions: {}, selfNotes: [] }, P);
  ok('空库时【待办】仍在', empty.includes('【待办】还没有内容'));
} finally {
  await h.close();
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
