// 验证：set_wake_config 不传 keywords 时，原有 keywords 会不会被保留。
// 这是 23:15 那一轮误走 probability 的关键 —— 如果 keywords 丢了，
// 「宝宝」就匹配不到。
import { bridgeHarness } from './audit-bridge-harness.mjs';

const G = 'group:20001';
let fails = 0;
const ok = (l, c) => { if (!c) fails += 1; console.log(`${c ? '✅' : '❌'} ${l}`); };

const h = await bridgeHarness({
  config: {
    ownerQQ: 10001, consolePort: 0, consoleToken: 'fixture-console-token',
    allow: { private: ['10001'], groups: ['20001'] },
    socialV2: { sticker: { enabled: false } },
  },
});
h.setMode('reserved2');

try {
  const st = h.getSocialV2State(G);
  // 先设成有 keywords 的状态
  st.wakeConfig = {
    mode: 'diving', infinite: true, sleepUntil: null, batchWindowMs: 8000,
    triggers: {
      atMention: true, nameMention: true, speakers: [],
      keywords: ['睦', '角色A', '宝宝'],
      question: true, poke: true, anyMessage: false, probability: 0.05,
    },
  };
  h.saveSocialV2State?.();

  // 复刻 23:12:46 那次调用：只传 mode/infinite/四个 trigger，不传 keywords
  const payload = {
    mode: 'diving', infinite: true,
    triggers: { atMention: true, nameMention: true, poke: true, question: true },
  };

  // 直接调端点
  const srv = await h.startConsoleServer();
  await new Promise((res, rej) => {
    if (srv.listening) return res();
    srv.once('listening', res); srv.once('error', rej);
    setTimeout(() => rej(new Error('listen timeout')), 10000);
  });
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}/api/socialV2/wake-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
    body: JSON.stringify({ key: G, config: payload }),
  }).then((x) => x.json());
  console.log('更新结果:', r.ok, r.error || '');

  const after = h.getSocialV2State(G).wakeConfig;
  console.log('\n更新后的 triggers:');
  console.log(JSON.stringify(after.triggers, null, 1));

  ok('keywords 被保留', Array.isArray(after.triggers.keywords) && after.triggers.keywords.includes('宝宝'));

  // 再测：keywords 能正确触发吗
  const reason = h.evaluateWakeTriggerV2
    ? h.evaluateWakeTriggerV2(G, h.getSocialV2State(G), { message: [], self_id: '30001' }, 'group', '@zzz345 可以 那私发给我吧宝宝', '@zzz345 可以 那私发给我吧宝宝', false)
    : null;
  console.log('\n对「…那私发给我吧宝宝」的判定:', reason || '(evaluateWakeTriggerV2 未暴露)');
  if (reason !== null) ok('命中关键词而不是 probability', String(reason).startsWith('keyword'));
} catch (e) {
  console.log('❌', e.message); fails += 1;
} finally {
  await h.close();
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
