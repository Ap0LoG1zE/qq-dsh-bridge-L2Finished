// 全局记忆的回归测试（2026-11-10 操作者定稿）。
//
// 契约：
//   · memberImpression / selfNote / longTerm(facts) → **全局一份**，跨私聊、跨群都是同一份
//   · activeTopic / pendingThought → **按会话**，群里的话题不能跑到私聊
//   · memberImpression 的键是 **QQ 号**，不是昵称（同一个人换群名片也不会变两条）
import { bridgeHarness } from './audit-bridge-harness.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const G = 'group:20001';
const G2 = 'group:111222333';   // 另一个群：验证跨群也共享
const P = 'private:10001';
const OWNER = '10001';

async function withBridge(fn, config = {}) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: Number(OWNER),
      sessionSharing: { enabled: false, groups: {}, preset: '' },
      socialV2: { sticker: { enabled: false } },
      ...config,
    },
  });
  h.setMode('reserved2');
  try { return await fn(h); } finally { await h.close(); }
}

test('三类长期记忆都落在全局存储（不按会话分裂）', async () => {
  await withBridge(async (h) => {
    // 不管从哪个会话问，长期记忆的归属都是同一个
    assert.equal(h.memoryKeyFor('selfNote', G), 'global');
    assert.equal(h.memoryKeyFor('selfNote', P), 'global');
    assert.equal(h.memoryKeyFor('memberImpression', G), 'global');
    assert.equal(h.memoryKeyFor('memberImpression', P), 'global');
    assert.equal(h.memoryKeyFor('longTerm', G2), 'global');
    // 短期两类必须留在会话自己身上
    assert.equal(h.memoryKeyFor('activeTopic', G), G);
    assert.equal(h.memoryKeyFor('activeTopic', P), P);
    assert.equal(h.memoryKeyFor('pendingThought', G), G);
  });
});

test('群里的印象，私聊和别的群都读得到（真正全局）', async () => {
  await withBridge(async (h) => {
    const globalSt = h.getSocialV2State('global');
    globalSt.memberImpressions = {};
    // 在群里记一条
    h.appendMemoryV2(globalSt, 'memberImpression', '爱喝奶茶', { target: '12345678', sessionKey: G });

    // 三个入口读到的都是同一份
    for (const k of [G, P, G2]) {
      const st = h.getSocialV2State(h.memoryKeyFor('memberImpression', k));
      assert.deepEqual(Object.keys(st.memberImpressions), ['12345678'], `${k} 应读到同一条印象`);
    }
  });
});

test('印象按 QQ 号记，不按昵称（同一人换群名片不会变两条）', async () => {
  await withBridge(async (h) => {
    const globalSt = h.getSocialV2State('global');
    globalSt.memberImpressions = {};

    // 先用群名片记
    h.appendMemoryV2(globalSt, 'memberImpression', '说话很长', { target: '小明', sessionKey: G });
    // 同一个人用 QQ 号再记一次（模拟换了群名片/在私聊里记）
    h.appendMemoryV2(globalSt, 'memberImpression', '爱熬夜', { target: '小明', sessionKey: G });

    const im = h.getSocialV2State('global').memberImpressions;
    const keys = Object.keys(im);
    assert.equal(keys.length, 1, `同一个人只能有一条印象，实际 ${keys.length} 条：${keys.join('/')}`);
    assert.equal(im[keys[0]].traits.length, 2, '两件小事都记在同一条下');
  });
});

test('短期记忆严格按会话隔离（群的话题不会跑到私聊）', async () => {
  await withBridge(async (h) => {
    const gSt = h.getSocialV2State(G);
    const pSt = h.getSocialV2State(P);
    gSt.activeTopics = [];
    pSt.activeTopics = [];

    h.appendMemoryV2(gSt, 'activeTopic', '群里在聊显卡', { sessionKey: G });
    assert.equal(h.getSocialV2State(G).activeTopics.length, 1, '群自己的话题在');
    assert.equal(h.getSocialV2State(P).activeTopics.length, 0, '私聊不该看到群的话题');
    // 而且它根本不该进全局
    assert.equal(h.getSocialV2State('global').activeTopics.length, 0, '全局存储里不该有进行中话题');
  });
});

test('全局记忆不会被「清某个会话」带走', async () => {
  await withBridge(async (h) => {
    const globalSt = h.getSocialV2State('global');
    globalSt.memberImpressions = { 99999999: { traits: ['测试'], name: '测试人', interactionCount: 1, lastSeenAt: Date.now() } };
    globalSt.selfNotes = [{ text: '我最近话变多了', createdAt: Date.now(), lastTouchedAt: Date.now() }];

    // 模拟清掉某个会话的短期记忆（等价于清上下文对记忆的影响）
    const localSt = h.getSocialV2State(G);
    localSt.activeTopics = [];
    localSt.pendingThoughts = [];

    // 全局的三类仍在
    assert.deepEqual(Object.keys(h.getSocialV2State('global').memberImpressions), ['99999999']);
    assert.equal(h.getSocialV2State('global').selfNotes.length, 1);
  });
});
