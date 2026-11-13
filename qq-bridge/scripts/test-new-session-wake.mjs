// 新建 DSH 会话后，下一次唤醒必须重新"想起来"一次（记忆 + 人格卡提示）。
//
// 2026-11-11 实测事故（这个文件最初就是为它写的）：
//   23:58:30 操作者清了「群」的上下文
//   23:58:39 唤醒 private（reason=private，不是 bootstrap）
//   23:58:47 新会话 private -> session-0a2b85fb
//   结果：唤醒包里既没有记忆提示，也没有人格卡提示 —— 新会话第一轮等于什么都没注入。
//   根因：引导标记还是 true，而 reset 的"连带清理"只比对同一个 oldSessionId，
//        共用组里各 key 的 sessionId 本来就不同，那个条件永远不成立。
//
// 2026-11-13 重建后，这里钉的是**新链路**的两条契约：
//   ① 换会话 = 换 sessionId = 登记冷启动（不看 reason、不看旧标记）；
//   ② 清上下文（删映射后重建）同样会登记 —— 那次也是"上下文没了"。
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
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly', 'qq-chat-agent']);
  try { return await fn(h); } finally { await h.close(); }
}

test('新建会话就登记冷启动（与 reason 无关）', async () => {
  await withShared(async (h) => {
    const sid = await h.ensureSession(P);
    const state = h.coldStartStateOf(P);
    assert.equal(state.coldStart, true, '新会话必须登记，否则第一轮什么都注入不了');
    assert.equal(state.kind, 'new');
    // 组内另一个入口搭上同一份会话后，看到的必须是同一条（共用会话 = 同一份上下文）
    const gsid = await h.ensureSession(G);
    assert.equal(gsid, sid, '前置：共用组复用同一个会话');
    assert.equal(h.coldStartStateOf(G).anchor, state.anchor, '两个入口必须看到同一次登记');
  });
});

test('会话被重建（清过上下文）后，标记会重新挂上', async () => {
  await withShared(async (h) => {
    const sid1 = await h.ensureSession(P);
    h.coldStartRegistry.get(sid1).consumedAt = Date.now(); // 模拟已经提示过
    assert.equal(h.coldStartStateOf(P).coldStart, false);

    // 清掉映射 = 下次 ensureSession 会建新会话（新 sessionId）
    delete h.state.sessions[P];
    delete h.state.sessions[G];
    const sid2 = await h.ensureSession(P);
    assert.notEqual(sid2, sid1, '前置：确实换了会话');
    assert.equal(h.coldStartStateOf(P).coldStart, true, '新会话必须重新登记');
  });
});

test('同一次冷启动只消费一次：第二轮不再提示', async () => {
  await withShared(async (h) => {
    const sid = await h.ensureSession(P);
    assert.equal(h.coldStartStateOf(P).coldStart, true);
    // 直接按投递出口的语义消费（真实投递路径的覆盖在 test-cold-start.mjs）
    h.commitColdStart(sid, h.coldStartStateOf(P).anchor);
    assert.equal(h.coldStartStateOf(P).coldStart, false, '消费后不该再算冷启动');
    // 再登记一次（模拟又压了一轮）→ 又能命中
    h.markColdStart(sid, 'compacted', 'test');
    assert.equal(h.coldStartStateOf(P).coldStart, true);
  });
});
