// 共用会话（私聊 + 群共用一个 DSH 会话）下，冷启动提示**按会话算、不按 QQ key 算**。
//
// 这是 test-cold-start.mjs 的补充：那边测"发几次"，这边测"标记落在哪"。
// 前身是 test-bootstrap-sharing / test-double-bootstrap —— 它们断言的是
// bootstrapSent 的组级置位，那是【初始提示词】的判据；"要不要发那两句提示"
// 现在只看 coldStartRegistry（按 DSH sessionId）。旧断言已随旧实现一起废弃。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const P = 'private:10001';
const G = 'group:20001';

async function withShared(fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: ['20001'] },
      sessionSharing: { enabled: true, groups: { [P]: G }, preset: '' },
      socialV2: { sticker: { enabled: false } },
    },
    files: { 'state/current-role.json': JSON.stringify({ role: '角色A', mode: 'active' }) },
  });
  h.setMode('reserved2');
  try { return await fn(h); } finally { await h.close(); }
}

test('组内两个入口共用同一个 DSH 会话，因此共用同一份冷启动标记', async () => {
  await withShared(async (h) => {
    const sid = await h.ensureSession(G);
    // 私聊走复用分支，拿到同一个 sessionId
    const sid2 = await h.ensureSession(P);
    assert.equal(sid2, sid, '前置：共用组必须复用同一个会话');

    // 从任何一个 key 看，看到的都是同一条登记（全组一份，不可能各发一遍）
    assert.equal(h.coldStartStateOf(G).coldStart, true);
    assert.equal(h.coldStartStateOf(P).coldStart, true);
    assert.equal(h.coldStartStateOf(P).anchor, h.coldStartStateOf(G).anchor, '两侧看到的必须是同一次登记');
  });
});

test('复用已有会话不登记冷启动（上下文还在，不算"新会话"）', async () => {
  await withShared(async (h) => {
    const sid = await h.ensureSession(P);
    // 消费掉新建那次，模拟"已经提示过、正常聊了一阵"
    h.coldStartRegistry.get(sid).consumedAt = Date.now();
    assert.equal(h.coldStartStateOf(P).coldStart, false, '前置：已消费');

    const reused = await h.ensureSession(G);
    assert.equal(reused, sid, '前置：确实走了复用分支');
    assert.equal(h.coldStartStateOf(G).coldStart, false, '复用没有换会话，不该重新登记');
  });
});

test('未开共用会话时，两个 key 各自是独立会话，各自登记各自消费', async () => {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: ['20001'] },
      sessionSharing: { enabled: false, groups: {}, preset: '' },
      socialV2: { sticker: { enabled: false } },
    },
    files: { 'state/current-role.json': JSON.stringify({ role: '角色A', mode: 'active' }) },
  });
  h.setMode('reserved2');
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly', 'qq-chat-agent']);
  try {
    const gsid = await h.ensureSession(G);
    const psid = await h.ensureSession(P);
    assert.notEqual(gsid, psid, '没开共用就是两个 DSH 会话');
    assert.equal(h.coldStartStateOf(G).coldStart, true);
    assert.equal(h.coldStartStateOf(P).coldStart, true);
    // 消费其中一个不影响另一个 —— 它们确实是两份上下文。
    h.coldStartRegistry.get(gsid).consumedAt = Date.now();
    assert.equal(h.coldStartStateOf(G).coldStart, false);
    assert.equal(h.coldStartStateOf(P).coldStart, true);
  } finally {
    await h.close();
  }
});
