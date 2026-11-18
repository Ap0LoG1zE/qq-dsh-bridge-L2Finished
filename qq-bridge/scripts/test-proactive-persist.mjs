// 回归：主动机会的会话级开关必须能**存下来**。
//
// 事故（2026-11-18 实测）：面板上关掉，当下有效；桥接重启后开关自己变回"开启"。
// 原因：saveSocialV2State / loadSocialV2State 都是**白名单**拷贝，
//      新加的 proactiveDisabled 三处（新建默认 / 读 / 写）只有"写内存"那一处，
//       落盘和读回都漏了 → 内存里 true，文件里没有，重启就丢。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import fs from 'node:fs';

const G = 'group:993578160';
let fails = 0;
const ok = (l, c) => { if (!c) fails += 1; console.log(`${c ? '✅' : '❌'} ${l}`); };

const h = await bridgeHarness({
  config: {
    ownerQQ: 84420221,
    allow: { private: ['84420221'], groups: ['993578160'] },
    socialV2: { sticker: { enabled: false }, proactive: { enabled: true } },
  },
});
h.setMode('reserved2');

let savedJson = '';
try {
  const st = h.getSocialV2State(G);

  // ① 新建会话默认是「不禁止」
  console.log('=== 默认值 ===');
  console.log('  proactiveDisabled:', st.proactiveDisabled);
  ok('新建会话默认 false（不禁止）', st.proactiveDisabled === false);

  // ② 关掉 → 落盘必须带这个字段
  st.proactiveDisabled = true;
  h.saveSocialV2State();
  savedJson = fs.readFileSync(h.paths.socialV2File, 'utf8');  const parsed = JSON.parse(savedJson);
  const saved = parsed.conversations?.[G];
  console.log('\n=== 写入磁盘 ===');
  console.log('  文件里的 proactiveDisabled:', saved?.proactiveDisabled);
  ok('关掉后落盘含 proactiveDisabled=true', saved?.proactiveDisabled === true);

  // ③ 关键：能读回来（重启后的第一件事）
  console.log('\n=== 读回（模拟重启）===');
  ok('测试钩子可用（harness 暴露了 load/save）',
    typeof h.saveSocialV2State === 'function' && typeof h.loadSocialV2State === 'function');
  if (typeof h.loadSocialV2State === 'function') {
    // 先清掉内存里的会话，模拟"进程刚起来、什么都没加载"
    h.socialV2.conversations.clear();
    h.loadSocialV2State();
    const st2 = h.getSocialV2State(G);
    console.log('  读回的 proactiveDisabled:', st2?.proactiveDisabled);
    ok('重启后仍是关闭状态', st2?.proactiveDisabled === true);
  }

  // ④ 打开 → 落盘是 false（不是"字段消失"）
  //    注意：上一步 loadSocialV2State 重建了会话对象，这里必须**重新取一次**，
  //    不能继续用最早那个 st（它已经和 socialV2.conversations 里的对象脱钩了）。
  const st3 = h.getSocialV2State(G);
  st3.proactiveDisabled = false;
  h.saveSocialV2State();
  const parsed2 = JSON.parse(fs.readFileSync(h.paths.socialV2File, 'utf8'));
  console.log('\n=== 重新开启 ===');
  console.log('  文件里的 proactiveDisabled:', parsed2.conversations?.[G]?.proactiveDisabled);
  ok('打开后落盘是 false', parsed2.conversations?.[G]?.proactiveDisabled === false);
} catch (e) {
  console.log('❌ 异常:', e.message);
  fails += 1;
} finally {
  await h.close();
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
