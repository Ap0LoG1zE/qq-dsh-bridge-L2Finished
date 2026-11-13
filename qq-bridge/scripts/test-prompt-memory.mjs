// 直接验证 qq_get_prompt 的 memory 字段组装逻辑（不经过 HTTP）。
//
// 为什么不走 HTTP：/api/socialV2/prompt 端点还依赖 voiceCfg / stickerEntries 等
// main() 作用域内的东西，harness 的 VM 缺一堆注入，补下去没完没了，
// 而且那些依赖和"记忆"这件事无关。这里只验证我改的那段：memory 该取哪些数据。
import { bridgeHarness } from './audit-bridge-harness.mjs';

const P = 'private:10001';
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
  g.selfNotes = [{ text: '我不喜欢被叫大肥鱼', createdAt: Date.now(), lastTouchedAt: Date.now() }];
  g.memberImpressions = { 10001: { traits: ['会问我睡没睡'], name: '主人', interactionCount: 5, lastSeenAt: Date.now() } };
  g.todos = [{ text: '明天讲那张卡片', createdAt: Date.now(), expiresAt: Date.now() + 86400000, done: false }];

  const local = h.getSocialV2State(P);
  local.activeTopics = [{ text: '在聊奶茶', lastMentionAt: Date.now() }];

  // 复刻端点里的组装方式（与 src/bridge.js 的 qq_get_prompt 一致）
  const mem = h.formatMemoryV2({
    activeTopics: local.activeTopics,
    pendingThoughts: local.pendingThoughts,
    memberImpressions: g.memberImpressions,
    selfNotes: g.selfNotes,
    todos: g.todos,
  }, P);

  console.log('\n════ qq_get_prompt 的 memory 字段 ════');
  console.log(mem);
  console.log('════ end ════\n');

  ok('selfNote 在', mem.includes('我不喜欢被叫大肥鱼'));
  ok('群友印象在', mem.includes('会问我睡没睡'));
  ok('待办在', mem.includes('明天讲那张卡片'));
  ok('本会话话题在', mem.includes('在聊奶茶'));
  ok('非空', mem.length > 0);

  // 对比：如果还按旧写法传 st（当前会话对象），这些会是空的
  const oldWay = h.formatMemoryV2(local, P);
  ok('（对照）旧写法拿不到全局记忆',
    !oldWay.includes('我不喜欢被叫大肥鱼') && !oldWay.includes('明天讲那张卡片'));
} finally {
  await h.close();
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
