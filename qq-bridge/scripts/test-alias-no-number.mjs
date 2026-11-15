// 回归：别名表不能被「名字等于 QQ 号」的记录污染。
//
// 事故：私聊有人拍她 → 拍一拍消息的 sender 直接取 QQ 号（私聊分支不解析昵称）
//      → noteAliasV2(10001, '10001') 把 primary 写成号码
//      → displayNameOfV2 一直返回号码 → 群友印象面板显示一串数字。
import { bridgeHarness } from './audit-bridge-harness.mjs';

const G = 'group:20001';
const OWNER = '10001';
let fails = 0;
const ok = (l, c) => { if (!c) fails += 1; console.log(`${c ? '✅' : '❌'} ${l}`); };

const h = await bridgeHarness({
  config: {
    ownerQQ: Number(OWNER),
    allow: { private: ['10001'], groups: ['20001'] },
    socialV2: { sticker: { enabled: false } },
  },
});
h.setMode('reserved2');

try {
  // ① 先写入一个正常昵称
  h.socialV2.aliases = { [OWNER]: { names: ['Ap0LoG1zE'], primary: 'Ap0LoG1zE', lastAt: Date.now() } };

  // ② 模拟拍一拍把号码当名字写进来
  const changed = h.noteAliasV2(OWNER, OWNER);
  const rec = h.socialV2.aliases[OWNER];
  console.log('=== 尝试写入「名字=号码」 ===');
  console.log('  noteAliasV2 返回:', changed);
  console.log('  primary:', JSON.stringify(rec.primary));
  console.log('  names:', JSON.stringify(rec.names));

  ok('拒绝写入（返回 false）', changed === false);
  ok('primary 仍是正常昵称', rec.primary === 'Ap0LoG1zE');
  ok('names 里没有混进号码', !rec.names.includes(OWNER));

  // ③ 陌生号码（别名表里还没这个人）也不该被写成 primary=号码
  h.socialV2.aliases['999999999'] = undefined;
  delete h.socialV2.aliases['999999999'];
  const r2 = h.noteAliasV2('999999999', '999999999');
  console.log('\n=== 全新号码写入「名字=号码」 ===');
  console.log('  noteAliasV2 返回:', r2, '| 记录存在:', !!h.socialV2.aliases['999999999']);
  ok('新号码也不会建立这种记录', r2 === false && !h.socialV2.aliases['999999999']);

  // ④ 纯数字但不是同一个号（比如昵称就叫 "123456"）也应拒绝 ——
  //    它是"看起来像 QQ 号的字符串"，拿来当展示名只会让人混淆。
  const r3 = h.noteAliasV2(OWNER, '123456');
  console.log('\n=== 写入另一个纯数字名字 ===');
  console.log('  noteAliasV2 返回:', r3, '| primary:', JSON.stringify(h.socialV2.aliases[OWNER].primary));
  ok('纯数字名字也拒绝', r3 === false && h.socialV2.aliases[OWNER].primary === 'Ap0LoG1zE');

  // ⑤ 正常昵称仍可写入（并切换 primary）
  const r4 = h.noteAliasV2(OWNER, '主人');
  console.log('\n=== 写入正常昵称 ===');
  console.log('  noteAliasV2 返回:', r4, '| primary:', JSON.stringify(h.socialV2.aliases[OWNER].primary));
  ok('正常昵称能写入', r4 === true && h.socialV2.aliases[OWNER].primary === '主人');

  // ⑥ displayNameOfV2 返回的是名字，不是号码
  const shown = h.displayNameOfV2(OWNER, '');
  console.log('\n=== displayNameOfV2 ===');
  console.log('  返回:', JSON.stringify(shown));
  ok('返回昵称而不是号码', shown === '主人' && shown !== OWNER);
} catch (e) {
  console.log('❌ 异常:', e.message); fails += 1;
} finally {
  await h.close();
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
