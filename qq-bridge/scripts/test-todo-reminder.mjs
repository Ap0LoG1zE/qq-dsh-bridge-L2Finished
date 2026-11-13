// 验证：写 todo 时自动排定时唤醒，到点用「（待办到点了：XXX）」唤醒。
import { bridgeHarness } from './audit-bridge-harness.mjs';

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
  const g = h.getSocialV2State('global');
  g.todos = [];

  // ① 写一条 500ms 后到点的待办
  h.appendMemoryV2(g, 'todo', '六点提醒他拿快递', { sessionKey: G, dueAtMs: 500 });
  const t = h.getSocialV2State('global').todos[0];

  console.log('=== 写入后的 todo ===');
  console.log('  text:', t.text);
  console.log('  wakeKey:', t.wakeKey);
  console.log('  notifiedAt:', t.notifiedAt);
  console.log('  expiresAt:', new Date(t.expiresAt).toLocaleTimeString('zh-CN', { hour12: false }));

  ok('记住了是哪个会话写的', t.wakeKey === G);
  ok('初始 notifiedAt 为 0', !t.notifiedAt);

  // ② 等它到点，看唤醒原因
  await new Promise((r) => setTimeout(r, 1200));

  const st = h.getSocialV2State(G);
  const reason = st.pendingWakeReason || '(无)';
  console.log('\n=== 到点后的唤醒 ===');
  console.log('  pendingWakeReason:', reason);
  console.log('  notifiedAt:', h.getSocialV2State('global').todos[0]?.notifiedAt ? '已标记' : '未标记');

  ok('到点触发了唤醒', st.pendingWakeReason != null);
  ok('唤醒原因带 todo 前缀', String(reason).startsWith('todo:'));
  ok('原因里带上了待办内容', String(reason).includes('六点提醒他拿快递'));
  ok('已标记 notifiedAt（不会重复提醒）', !!h.getSocialV2State('global').todos[0]?.notifiedAt);

  // ③ 唤醒词里的提示语
  const prompt = h.buildWakePromptV2(G, reason);
  const line = prompt.split('\n').find((l) => l.includes('待办')) || '';
  console.log('\n=== 唤醒词里的那句 ===');
  console.log(' ', line.trim());
  ok('唤醒词说「待办到点了」', /待办到点了/.test(prompt));
  ok('唤醒词带上了待办内容', prompt.includes('六点提醒他拿快递'));

  // ④ 已完成的待办不该排定时器
  g.todos = [{ text: '做完的事', createdAt: Date.now(), expiresAt: Date.now() + 1000, done: true, wakeKey: G, notifiedAt: 0 }];
  const due = (() => {
    // 直接问内部函数：没有导出就跳过这条
    return typeof h.nextDueTodoFor === 'function' ? h.nextDueTodoFor(G) : null;
  })();
  if (typeof h.nextDueTodoFor === 'function') {
    ok('已完成的待办不参与排期', due === null);
  } else {
    console.log('⏭  跳过「已完成不排期」检查（nextDueTodoFor 未导出）');
  }
} catch (e) {
  console.log('❌ 异常:', e.message); fails += 1;
} finally {
  await h.close();
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
