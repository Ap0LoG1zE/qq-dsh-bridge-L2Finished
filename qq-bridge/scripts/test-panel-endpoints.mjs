// 验证 DSH 面板的三个数据端点：自我 / 群友印象 / 待办。
// 之前 self-notes 和 impressions 按会话遍历、读不到全局数据，面板永远空白。
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
const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'x-console-token': TOKEN } }).then((r) => r.json());

try {
  const g = h.getSocialV2State('global');
  g.selfNotes = [
    { text: '我不太敢认关系变好这件事', createdAt: 1000, lastTouchedAt: 1000 },
    { text: '他问我睡没睡的时候我会停顿一下', createdAt: 2000, lastTouchedAt: 2000 },
  ];
  // 2026-11-12：名字不再存在 impression 里 —— 唯一真相是别名表（桥接每条消息都写）。
  // 所以这里只放 traits，名字靠下面的 aliases 提供。
  g.memberImpressions = {
    10001: { traits: ['爱把话绕回笨蛋', '半夜还在调提示词'], interactionCount: 5, lastSeenAt: 3000 },
    2722156233: { traits: ['会@我骂猪'], interactionCount: 2, lastSeenAt: 2000 },
    999999999: { traits: ['别名表里也没有这个人'], interactionCount: 1, lastSeenAt: 1000 },
  };
  h.socialV2.aliases = {
    10001: { primary: 'Ap0LoG1zE', names: ['Ap0LoG1zE'], lastAt: Date.now() },
    2722156233: { primary: '7月1', names: ['7月1'], lastAt: Date.now() },
  };
  g.todos = [
    { text: '明天讲那张卡片', createdAt: 1000, expiresAt: Date.now() + 20 * 3600000, done: false },
    { text: '六点提醒他拿快递', createdAt: 1000, expiresAt: Date.now() + 2 * 3600000, done: false },
    { text: '已经过期的', createdAt: 1000, expiresAt: Date.now() - 1000, done: false },
    { text: '做完的事', createdAt: 1000, expiresAt: Date.now() + 30 * 3600000, done: true },
  ];

  // ① 自我
  const sn = await get('/api/socialV2/self-notes');
  console.log('\n=== /self-notes ===');
  console.log('total:', sn.total);
  for (const n of sn.notes || []) console.log('  -', n.text);
  ok('自我认知能读到（原来恒为 0）', sn.total === 2);
  ok('按时间正序', sn.notes[0].createdAt < sn.notes[1].createdAt);

  // ② 印象
  const im = await get('/api/socialV2/impressions');
  console.log('\n=== /impressions ===');
  console.log('total:', im.total);
  for (const x of im.impressions || []) console.log(`  - ${x.name}（${x.userId}）: ${x.traits.join('、')}`);
  ok('群友印象能读到（原来恒为 0）', im.total === 3);
  ok('有别名的显示名字', (im.impressions || []).some((x) => x.name === 'Ap0LoG1zE'));
  ok('别名表里没有的退回 QQ 号', (im.impressions || []).some((x) => x.userId === '999999999' && x.name === '999999999'));
  ok('带 userId 字段（面板改名/删除要用）', (im.impressions || []).every((x) => x.userId));

  // ③ 待办
  const td = await get('/api/socialV2/todos');
  console.log('\n=== /todos ===');
  console.log('total:', td.total);
  for (const t of td.todos || []) {
    const left = Math.round((t.expiresAt - Date.now()) / 3600000);
    console.log(`  - ${t.text}（${t.done ? '已完成' : `还剩 ${left} 小时`}）`);
  }
  ok('待办端点存在', td.ok === true);
  ok('过滤掉过期条目', !(td.todos || []).some((t) => t.text === '已经过期的'));
  ok('保留 3 条（2 未完成 + 1 已完成）', td.total === 3);
  ok('未完成的排在前面', (td.todos || [])[0].done === false);
  ok('未完成里按到期近的在前', (td.todos || [])[0].text === '六点提醒他拿快递');
} catch (e) {
  console.log('❌ 异常:', e.message); fails += 1;
} finally {
  await h.close();
  try { srv.close(); } catch {}
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
