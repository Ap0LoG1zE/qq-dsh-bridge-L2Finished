// 验证：qq_send_poke 的 targetUserId 可以传昵称，桥接自动换成 QQ 号。
import { bridgeHarness } from './audit-bridge-harness.mjs';

const G = 'group:1128046235';
let fails = 0;
const ok = (l, c) => { if (!c) fails += 1; console.log(`${c ? '✅' : '❌'} ${l}`); };

const h = await bridgeHarness({
  config: {
    ownerQQ: 84420221,
    allow: { private: ['84420221'], groups: ['1128046235'] },
    socialV2: { sticker: { enabled: false }, tools: {} },
  },
});
h.setMode('reserved2');

try {
  // 造一个别名表：Ap0LoG1zE → 84420221
  h.socialV2.aliases = {
    84420221: { names: ['Ap0LoG1zE'], primary: 'Ap0LoG1zE', lastAt: Date.now() },
    2722156233: { names: ['7月1'], primary: '7月1', lastAt: Date.now() },
    111111111: { names: ['小明'], primary: '小明', lastAt: Date.now() },
    222222222: { names: ['小明同学'], primary: '小明同学', lastAt: Date.now() },
  };

  // ① lookupAliasV2 能把昵称换成号
  const hit = h.lookupAliasV2('Ap0LoG1zE');
  console.log('=== lookupAliasV2("Ap0LoG1zE") ===');
  console.log('  命中:', hit.length, '| userId:', hit[0]?.userId);
  ok('昵称能查到 QQ 号', hit.length === 1 && hit[0].userId === '84420221');

  // ② 精确匹配优先（"小明" 不该被 "小明同学" 干扰）
  const hit2 = h.lookupAliasV2('小明');
  console.log('\n=== lookupAliasV2("小明") ===');
  console.log('  命中:', hit2.length, '条:', hit2.map((r) => `${r.primary}/${r.userId}`).join(', '));
  const exact = hit2.filter((r) => r.primary === '小明');
  ok('「小明」能精确命中本人', exact.length === 1 && exact[0].userId === '111111111');

  // ③ 纯 QQ 号也能查
  const hit3 = h.lookupAliasV2('84420221');
  console.log('\n=== lookupAliasV2("84420221") ===');
  console.log('  命中:', hit3.length, '| primary:', hit3[0]?.primary);
  ok('传 QQ 号也能查到', hit3.length >= 1 && hit3[0].userId === '84420221');

  // ④ 查不到的人返回空
  const hit4 = h.lookupAliasV2('根本不存在的名字');
  console.log('\n=== lookupAliasV2("根本不存在的名字") ===');
  console.log('  命中:', hit4.length);
  ok('查不到就返回空（桥接会报错让她去 qq_get_userid）', hit4.length === 0);
} catch (e) {
  console.log('❌ 异常:', e.message); fails += 1;
} finally {
  await h.close();
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
