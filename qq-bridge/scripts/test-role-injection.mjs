// 角色行的两种口吻：
//   · 冷启动（新会话 / 刚压缩过）→ 明确催她调 qq_get_prompt
//   · 普通轮次 → 只报名字，不催
//
// 2026-11-13：判据从 `reason === 'bootstrap' || st.memNeedsSync` 换成 coldStartRegistry，
// 断言也从"渲染出来长什么样"改成"真的投递出去长什么样"。
// 旧版本直接调 buildWakePromptV2 断言，于是"压缩后也要求调 qq_get_prompt"这条
// 在旧实现里是绿的，而实际投递的那一份根本没有这句话（第二遍渲染时标记已清）。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const P = 'private:10001';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withBridge(fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: ['20001'] },
      socialV2: { sticker: { enabled: false }, wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } },
    },
    files: { 'state/current-role.json': JSON.stringify({ role: '角色A', mode: 'active' }) },
  });
  h.setMode('reserved2');
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly', 'qq-chat-agent']);
  h.getSocialV2State('global').selfNotes = [{ text: '测试用自我认知', at: Date.now() }];
  try { return await fn(h); } finally { await h.close(); }
}

/** 角色的那一行（投递正文里找）。 */
const roleLineOf = (text) => text.split('\n').find((l) => l.includes('【当前角色】')) || '';

/** 投递一次唤醒并返回真正的正文；顺带解除在途租约，方便连续唤醒。 */
async function deliverWake(h, key, reason) {
  const before = h.calls.prompts.length;
  await h.sendWakePromptV2(key, reason);
  await sleep(60);
  const delivered = h.calls.prompts.length > before;
  h.pendingWakeKeys.delete(key);
  h.disarmPendingWakeLease(key);
  return { delivered, text: delivered ? h.calls.prompts.at(-1).content.map((c) => c.text || '').join('') : '' };
}

test('冷启动（新会话）：角色行明确要求调 qq_get_prompt，且同时催记忆', async () => {
  await withBridge(async (h) => {
    await h.ensureSession(P);
    const r = await deliverWake(h, P, 'anyMessage');
    assert.ok(r.delivered);
    const line = roleLineOf(r.text);
    assert.match(line, /先调 qq_get_prompt/, `冷启动的角色行要催，实际：${line}`);
    assert.match(r.text, /qq_memory_query/, '冷启动要同时提示查记忆');
  });
});

test('冷启动（刚压缩过）：同样要求调 qq_get_prompt', async () => {
  await withBridge(async (h) => {
    const sid = await h.ensureSession(P);
    await deliverWake(h, P, 'anyMessage'); // 先消费掉新会话那次
    h.markColdStart(sid, 'compacted', 'test');
    const r = await deliverWake(h, P, 'timeout');
    assert.match(roleLineOf(r.text), /先调 qq_get_prompt/, '压缩后人格卡也不在上下文里，必须催');
  });
});

test('普通轮次：只报名字，不催', async () => {
  await withBridge(async (h) => {
    await h.ensureSession(P);
    await deliverWake(h, P, 'anyMessage');
    const r = await deliverWake(h, P, 'private');
    const line = roleLineOf(r.text);
    assert.ok(!/先调 qq_get_prompt/.test(line), `普通轮次不该催，实际：${line}`);
    assert.match(line, /角色A/, '普通轮次仍保留角色名');
  });
});

test('reason=bootstrap 本身不再触发催办（判据只看登记表）', async () => {
  await withBridge(async (h) => {
    await h.ensureSession(P);
    await deliverWake(h, P, 'anyMessage');
    const r = await deliverWake(h, P, 'bootstrap');
    assert.ok(!/先调 qq_get_prompt/.test(roleLineOf(r.text)),
      '没有冷启动登记时，reason 叫什么都不该催 —— 否则状态就会从 reason 漏进来');
  });
});
