// 回归：【之前】里不能出现她自己发的消息。
// 两条路径都要测：
//   · 共享会话（collectSharedMessagesV2 → buildWakeSnapshotV2 的 shared 分支）
//   · 非共享会话（buildWakeSnapshotV2 的普通分支）
import { bridgeHarness } from './audit-bridge-harness.mjs';

const P = 'private:10001';
const G = 'group:20001';
let fails = 0;
const ok = (l, c) => { if (!c) fails += 1; console.log(`${c ? '✅' : '❌'} ${l}`); };

// ── ① 共享会话 ──────────────────────────────────────────────
{
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: ['20001'] },
      sessionSharing: { enabled: true, groups: { [P]: G }, preset: '' },
      socialV2: { sticker: { enabled: false } },
    },
  });
  h.setMode('reserved2');
  try {
    // 造历史：群友说一句、她自己说一句、群友再说一句
    h.appendSocialV2Message(G, '鹿', '你们没人觉得这个打气筒很奇怪吗', '你们没人觉得这个打气筒很奇怪吗', false, false, 'm1', [], '3380569062', []);
    h.recordSentMessagesV2(G, ['我觉得还挺正常的']);
    h.appendSocialV2Message(G, '7月1', '打气筒是什么梗', '打气筒是什么梗', false, false, 'm2', [], '2722156233', []);

    // 清未读，让所有消息都进【之前】
    h.getSocialV2State(G).unread = [];

    const snap = h.buildWakeSnapshotV2(G);
    const past = (snap.recent || []).map((r) => r.message);
    const texts = past.map((m) => String(m.text || ''));
    console.log('\n══ 共享会话【之前】内容 ══');
    for (const t of texts) console.log('  ', t);

    ok('共享会话：不含她自己说的', !texts.some((t) => t.includes('我觉得还挺正常的')));
    ok('共享会话：含群友消息', texts.some((t) => t.includes('打气筒')));

    // 渲染那一步走 buildWakePromptV2（它会内部调用 renderWakeSnapshotV2）。
    // renderWakeSnapshotV2 本身没暴露给 harness，不必为了断言它去改 harness。
    const prompt = h.buildWakePromptV2(G, 'private');
    const beforeIdx = prompt.indexOf('【之前】');
    const beforePart = beforeIdx >= 0 ? prompt.slice(beforeIdx) : '';
    ok('共享会话：渲染出的【之前】段不含自己的话', !beforePart.includes('我觉得还挺正常的'));
  } finally {
    await h.close();
  }
}

// ── ② 非共享会话 ────────────────────────────────────────────
{
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: ['20001'] },
      socialV2: { sticker: { enabled: false } },
    },
  });
  h.setMode('reserved2');
  try {
    h.appendSocialV2Message(G, '鹿', '第一句群友的话', '第一句群友的话', false, false, 'n1', [], '3380569062', []);
    h.recordSentMessagesV2(G, ['我自己回的一句']);
    h.appendSocialV2Message(G, '7月1', '第二句群友的话', '第二句群友的话', false, false, 'n2', [], '2722156233', []);
    h.getSocialV2State(G).unread = [];

    const snap = h.buildWakeSnapshotV2(G);
    const texts = (snap.recent || []).map((m) => String(m.text || ''));
    console.log('\n══ 非共享会话【之前】内容 ══');
    for (const t of texts) console.log('  ', t);

    ok('非共享会话：不含她自己说的', !texts.some((t) => t.includes('我自己回的一句')));
    ok('非共享会话：含群友消息', texts.some((t) => t.includes('群友的话')));
  } finally {
    await h.close();
  }
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
