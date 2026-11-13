// 复现刚才那次失败，验证"顶层 target"现在能用。
//
// 原始失败输入（模型实际发的）：
//   { category: 'memberImpression', content: '…', key: 'group:20001',
//     target: 'Ap0LoG1zE', token: '…' }        ← target 在顶层
// 报错：memberImpression 需要 extra.target 指定群友名字
//
// 现在两端都收：MCP 侧把顶层 target 并进 extra；桥接侧也认 body.target。
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

try {
  // 先放一条群消息，让 target 反查能拿到 QQ 号
  h.appendSocialV2Message(G, 'Ap0LoG1zE', '你是人是鬼', '你是人是鬼', false, true, 'm1', [], '10001', []);
  const token = h.getSocialV2State(G).agentToken;

  const post = async (payload) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/memory-append`, {
      method: 'POST',
      headers: { 'x-agent-token': token, 'x-console-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ key: G, token, ...payload }),
    });
    return { status: res.status, body: await res.json() };
  };

  const CONTENT = '在群里被问「你是人是鬼」，回了一句就罢。他总爱把话绕回"笨蛋"，绕完又自己说不管。';

  // ① 顶层 target（就是刚才失败的那种写法）
  const r1 = await post({ category: 'memberImpression', content: CONTENT, target: 'Ap0LoG1zE' });
  console.log('\n① 顶层 target →', r1.status, JSON.stringify(r1.body).slice(0, 150));
  ok('顶层 target 能写入', r1.status === 200 && r1.body.ok === true);

  // ② 老写法 extra.target 仍然可用
  const r2 = await post({ category: 'memberImpression', content: '第二条观察', extra: { target: 'Ap0LoG1zE' } });
  console.log('② extra.target →', r2.status, JSON.stringify(r2.body).slice(0, 150));
  ok('extra.target 老写法仍可用', r2.status === 200 && r2.body.ok === true);

  // ③ 什么都没给 → 仍应报错，且提示要清楚
  const r3 = await post({ category: 'memberImpression', content: '没有 target 的' });
  console.log('③ 缺 target →', r3.status, JSON.stringify(r3.body).slice(0, 200));
  ok('缺 target 仍报错（不静默吞掉）', r3.status === 400);
  ok('报错信息提到两种写法', /顶层 target|extra\.target/.test(String(r3.body.error)));

  // ④ 落库检查：两条都记在同一个人名下
  const im = h.getSocialV2State('global').memberImpressions;
  const keys = Object.keys(im);
  console.log('\n全局印象表:', keys.map((k) => `${k}(${im[k].traits?.length}条)`).join(', '));
  ok('按 QQ 号归并成一条', keys.length === 1);
  ok('两条观察都在', (im[keys[0]]?.traits || []).length === 2);
} catch (e) {
  console.log('❌ 异常:', e.message); fails += 1;
} finally {
  await h.close();
  try { srv.close(); } catch {}
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
