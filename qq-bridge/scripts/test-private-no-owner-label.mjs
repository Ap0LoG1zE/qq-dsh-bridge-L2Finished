// 回归：私聊里不该出现「主人」这个称呼（唤醒词 + 工具返回）。
//
// 背景（操作者 2026-11-20）：她私聊里每条消息都显示"主人·15:23：…"，
// 而且 qq_affinity 返回里也写「主人」，她会照着这个称呼说话。
// 要求：私聊里用真实昵称，不要这个特殊称呼。
//
// 注意：buildWakePromptV2 **不含**消息快照 —— 快照是在投递时由
// renderWakeSnapshotV2 拼上去的（见 deliverPromptNow 第 12328 行）。
// 所以这里要分别测：sender 名（v2SenderLabelFor）+ 快照渲染。
import { bridgeHarness } from './audit-bridge-harness.mjs';

const P = 'private:84420221';
const G = 'group:993578160';
const OWNER = '84420221';
let fails = 0;
const ok = (l, c) => { if (!c) fails += 1; console.log(`${c ? '✅' : '❌'} ${l}`); };

const h = await bridgeHarness({
  config: {
    ownerQQ: Number(OWNER),
    allow: { private: [OWNER], groups: ['993578160'] },
    socialV2: { sticker: { enabled: false } },
  },
  files: { 'state/current-role.json': JSON.stringify({ role: '若叶睦', mode: 'active' }) },
});
h.setMode('reserved2');

const mkMsg = (seq, isOwner, sender) => ({
  seq,
  messageId: String(5000 + seq),
  sender: sender === undefined ? 'Ap0LoG1zE' : sender,
  userId: OWNER,
  text: '今天吃白饭',
  plain: '今天吃白饭',
  quoteTargetIsSelf: false,
  isOwner,
  ownerLabel: isOwner ? '管理员' : '',
  isSelf: false,
  media: [], hasMedia: false, forwardIds: [], hasForward: false,
  time: Date.now(),
});

try {
  h.socialV2.aliases = {
    [OWNER]: { names: ['Ap0LoG1zE'], primary: 'Ap0LoG1zE', lastAt: Date.now() },
  };

  // ── ① 私聊快照：不带「（主人）」
  console.log('=== 私聊快照 ===');
  const pSt = h.getSocialV2State(P);
  pSt.unread = [mkMsg(1, true)];
  const pSnap = h.buildWakeSnapshotV2(P);
  const pText = h.renderWakeSnapshotV2(pSnap, P);
  const pLine = pText.split('\n').find((l) => l.includes('今天吃白饭')) || '';
  console.log('  消息行:', pLine.trim());
  ok('私聊不出现「（主人）」', !pText.includes('（主人）'));
  ok('私聊消息行正常渲染', pLine.includes('今天吃白饭'));

  // ── ② 群聊快照：仍带标记，但内容是「（Ap0）」不是「（主人）」
  console.log('\n=== 群聊快照 ===');
  const gSt = h.getSocialV2State(G);
  gSt.unread = [mkMsg(2, true)];
  const gSnap = h.buildWakeSnapshotV2(G);
  const gText = h.renderWakeSnapshotV2(gSnap, G);
  const gLine = gText.split('\n').find((l) => l.includes('今天吃白饭')) || '';
  console.log('  消息行:', gLine.trim());
  ok('群聊仍标主人', gText.includes('（Ap0）'));
  ok('群聊不再写「（主人）」', !gText.includes('（主人）'));

  // ── ③ v2SenderLabelFor：私聊不再返回「主人」
  console.log('\n=== v2SenderLabelFor ===');
  const lblBare = h.v2SenderLabelFor(P, 'private', { user_id: OWNER, sender: {} });
  console.log('  无昵称 →', JSON.stringify(lblBare));
  ok('私聊无昵称退回别名/号码，不是「主人」', lblBare !== '主人' && lblBare.length > 0);

  const lblNick = h.v2SenderLabelFor(P, 'private', { user_id: OWNER, sender: { nickname: 'Ap0LoG1zE' } });
  console.log('  有昵称 →', JSON.stringify(lblNick));
  ok('私聊用真实昵称', lblNick === 'Ap0LoG1zE');

  // ── ④ 私聊消息 sender 为空时，快照行也不该写「主人」
  console.log('\n=== 私聊 sender 为空 ===');
  const pSt2 = h.getSocialV2State(P);
  pSt2.unread = [mkMsg(3, true, '')];
  const pSnap2 = h.buildWakeSnapshotV2(P);
  const pText2 = h.renderWakeSnapshotV2(pSnap2, P);
  const line2 = pText2.split('\n').find((l) => l.includes('今天吃白饭')) || '';
  console.log('  消息行:', line2.trim());
  ok('sender 为空时不写「主人」', !line2.includes('主人'));
} catch (e) {
  console.log('❌ 异常:', e.message, (e.stack || '').split('\n')[1] || '');
  fails += 1;
} finally {
  await h.close();
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
