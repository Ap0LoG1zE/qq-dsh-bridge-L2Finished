// 验证印象的删除/编辑：之前按会话查，永远 404。
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

const post = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
  method: 'POST',
  headers: { 'x-console-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

try {
  // 建两条印象，并按桥接的方式写别名
  const g = h.getSocialV2State('global');
  g.memberImpressions = {
    70001: { traits: ['会@我骂猪'], interactionCount: 2, lastSeenAt: Date.now() },
    10001: { traits: ['爱把话绕回笨蛋'], interactionCount: 5, lastSeenAt: Date.now() },
  };
  // 别名表（名字的唯一真相）。桥接每收到一条消息都会写它；测试里直接注入等价数据。
  h.socialV2.aliases = {
    70001: { primary: '7月1', names: ['7月1'], lastAt: Date.now() },
    10001: { primary: 'Ap0LoG1zE', names: ['Ap0LoG1zE'], lastAt: Date.now() },
  };

  // ① 用**展示名**删（面板传的就是这个）
  const r1 = await post('/api/socialV2/impression-remove', { key: G, name: '7月1' });
  console.log('① 按展示名删「7月1」→', r1.status, JSON.stringify(r1.body).slice(0, 120));
  ok('按展示名能删掉', r1.status === 200 && r1.body.ok === true);
  ok('全局里真的少了', !h.getSocialV2State('global').memberImpressions['70001']);
  ok('另一条没被误删', !!h.getSocialV2State('global').memberImpressions['10001']);

  // ② 用 QQ 号删
  const r2 = await post('/api/socialV2/impression-remove', { key: G, name: '10001' });
  console.log('② 按 QQ 号删 →', r2.status, JSON.stringify(r2.body).slice(0, 120));
  ok('按 QQ 号也能删', r2.status === 200 && r2.body.ok === true);
  ok('全局清空了', Object.keys(h.getSocialV2State('global').memberImpressions).length === 0);

  // ③ 不存在的名字要 404（不能静默成功）
  const r3 = await post('/api/socialV2/impression-remove', { key: G, name: '查无此人' });
  ok('不存在时返回 404', r3.status === 404);

  // ④ 编辑：改 trait
  h.getSocialV2State('global').memberImpressions = {
    70001: { traits: ['旧内容'], interactionCount: 1, lastSeenAt: Date.now() },
  };
  const r4 = await post('/api/socialV2/impression-update', { key: G, name: '7月1', traitIndex: 0, text: '新内容' });
  console.log('④ 按展示名编辑 →', r4.status, JSON.stringify(r4.body).slice(0, 120));
  ok('按展示名能编辑', r4.status === 200 && r4.body.ok === true);
  ok('trait 真的改了', h.getSocialV2State('global').memberImpressions['70001'].traits[0] === '新内容');

  // ⑤ 改名**不支持**（操作者确认不需要）：名字归别名表管，印象编辑只改 traits。
  // 传 newName 应该被忽略、不影响 traits。
  const before = JSON.stringify(h.getSocialV2State('global').memberImpressions['70001'].traits);
  const r5 = await post('/api/socialV2/impression-update', { key: G, name: '7月1', newName: '七月一号' });
  console.log('⑤ 传 newName（应被忽略） →', r5.status);
  ok('不报错（忽略掉这个名字参数）', r5.status === 200);
  ok('traits 没被改坏', JSON.stringify(h.getSocialV2State('global').memberImpressions['70001'].traits) === before);
  ok('别名表没被改', String(h.socialV2.aliases['70001']?.primary || '') === '7月1');
} catch (e) {
  console.log('❌ 异常:', e.message); fails += 1;
} finally {
  await h.close();
  try { srv.close(); } catch {}
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
