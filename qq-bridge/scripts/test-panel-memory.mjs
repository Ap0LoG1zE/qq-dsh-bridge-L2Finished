// 验证小面板能拿到并展示：印象（带名字）、selfNote、todo。
// 走真实 HTTP，模拟面板的调用（/api/socialV2/memory?key=…，不带 category）。
import { bridgeHarness } from './audit-bridge-harness.mjs';

const G = 'group:20001';
const TOKEN = 'fixture-console-token';
let fails = 0;
const ok = (l, c) => { if (!c) fails += 1; console.log(`${c ? '✅' : '❌'} ${l}`); };

const h = await bridgeHarness({
  config: {
    ownerQQ: 10001, consolePort: 0, consoleToken: TOKEN,
    allow: { private: ['10001'], groups: ['20001'] },
    socialV2: { sticker: { enabled: false } },
  },
});
h.setMode('reserved2');
const srv = await h.startConsoleServer();
await new Promise((res, rej) => {
  if (srv.listening) return res();
  srv.once('listening', res); srv.once('error', rej);
  setTimeout(() => rej(new Error('listen timeout')), 10000);
});
const { port } = srv.address();
const api = (p, opt) => fetch(`http://127.0.0.1:${port}${p}`, opt);

try {
  const g = h.getSocialV2State('global');
  g.memberImpressions = {
    10001: { traits: ['爱把话绕回笨蛋'], name: 'Ap0LoG1zE', interactionCount: 5, lastSeenAt: Date.now() },
    2722156233: { traits: ['会@我骂猪'], name: '7月1', interactionCount: 2, lastSeenAt: Date.now() },
    // 旧数据：没有 name 字段
    999999999: { traits: ['老数据没有 name'], interactionCount: 1, lastSeenAt: Date.now() },
  };
  g.selfNotes = [{ text: '我不太敢认关系变好这件事', createdAt: Date.now(), lastTouchedAt: Date.now() }];
  g.todos = [{ text: '明天讲那张卡片', createdAt: Date.now(), expiresAt: Date.now() + 20 * 3600000, done: false }];

  const res = await api(`/api/socialV2/memory?key=${encodeURIComponent(G)}`, {
    headers: { 'x-console-token': TOKEN },
  });
  const body = await res.json();

  console.log('=== 面板拿到的 raw ===');
  console.log('印象人数:', Object.keys(body.raw?.memberImpressions || {}).length);
  console.log('selfNote 条数:', (body.raw?.selfNotes || []).length);
  console.log('todo 条数:', (body.raw?.todos || []).length);
  console.log('');

  ok('raw.memberImpressions 有 3 人', Object.keys(body.raw?.memberImpressions || {}).length === 3);
  ok('raw.selfNotes 有内容', (body.raw?.selfNotes || []).length === 1);
  ok('raw.todos 有内容', (body.raw?.todos || []).length === 1);

  // 模拟前端渲染时用的取名逻辑
  const im = body.raw.memberImpressions;
  const labelOf = (k) => String(im[k]?.name || '').trim() || k;
  console.log('\n=== 前端会怎么显示 ===');
  for (const k of Object.keys(im)) {
    console.log(`  👤 ${labelOf(k)}（${k}）：${(im[k].traits || []).join('、')}`);
  }
  ok('有 name 的显示名字', labelOf('10001') === 'Ap0LoG1zE');
  ok('没有 name 的退回号码（不崩）', labelOf('999999999') === '999999999');

  // 清空 selfNote / todo 要真的生效
  const c1 = await api('/api/socialV2/memory-clear', {
    method: 'POST',
    headers: { 'x-console-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ key: G, category: 'selfNote' }),
  }).then((r) => r.json());
  ok('清空 selfNote 生效', c1.ok === true && (h.getSocialV2State('global').selfNotes || []).length === 0);

  const c2 = await api('/api/socialV2/memory-clear', {
    method: 'POST',
    headers: { 'x-console-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ key: G, category: 'todo' }),
  }).then((r) => r.json());
  ok('清空 todo 生效', c2.ok === true && (h.getSocialV2State('global').todos || []).length === 0);

  // 删除单条 todo
  g.todos = [{ text: '单条待办', createdAt: Date.now(), expiresAt: Date.now() + 3600000, done: false }];
  const r3 = await api('/api/socialV2/memory-remove', {
    method: 'POST',
    headers: { 'x-console-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ key: G, category: 'todo', content: '单条待办' }),
  }).then((r) => r.json());
  ok('删除单条 todo 生效', r3.ok === true && (h.getSocialV2State('global').todos || []).length === 0);
} catch (e) {
  console.log('❌ 异常:', e.message); fails += 1;
} finally {
  await h.close();
  try { srv.close(); } catch {}
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
