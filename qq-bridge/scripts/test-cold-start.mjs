// 冷启动引导（新会话 / 刚压缩过 → 那两句提示）的唯一链路回归测试。
//
// 2026-11-13 重建。这个文件替换了四个各测一个角落的旧测试
// （test-bootstrap-dedup / test-guide-vs-memo / test-memory-injection 的冷启动部分 /
//  test-new-session-wake 的提示部分）—— 它们全都只调 buildWakePromptV2 断言，
// 而真正的 bug 恰恰在"渲染之后、投递之前"：
//
//   旧实现里 sendWakePromptV2 渲一次（丢弃）、deliverPromptNow 又渲一次（真发）。
//   于是所有对着 buildWakePromptV2 的断言都是绿的，而实际发出去的内容：
//     · 压缩后那句 —— 第一遍渲染就把 memNeedsSync 清了，第二遍什么都不挂 ⇒ **从没发出去过**；
//     · 新会话那句 —— 第二遍按原始 bootstrap 重渲，降级判定失效 ⇒ **同一会话发了两遍**。
//
// 所以这里的每一条断言都**只认投递出口**（h.calls.prompts）：DSH 真收到什么，就断言什么。
// 直接断言渲染函数的写法在这个文件里一律不许再出现。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const P = 'private:10001';
const G = 'group:20001';
// 那两句提示各自的判据标记。
const MEM_HINT = /qq_memory_query/;
const ROLE_HINT = /你的完整人设不在上下文里/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withBridge(fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: ['20001'] },
      // 开共用会话：这是最容易出"同一会话里发两遍"的配置，必须测这套。
      sessionSharing: { enabled: true, groups: { [P]: G }, preset: '' },
      socialV2: {
        sticker: { enabled: false },
        // 限频关掉：限频会延后重试，让"投递了几个 prompt"变得不可预测。
        wake: { maxWakePerMinute: 0, maxWakePerHour: 0 }
      }
    },
    files: { 'state/current-role.json': JSON.stringify({ role: '角色A', mode: 'active' }) },
  });
  h.setMode('reserved2');
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly', 'qq-chat-agent']);
  // 记忆库里有点东西 —— 空库时提示会退化成不带工具名的那句，测不到重点。
  h.getSocialV2State('global').selfNotes = [{ text: '自我认知', at: Date.now() }];
  try { await fn(h); } finally { await h.close(); }
}

/** 最后一次真正投递出去的唤醒词正文。 */
function deliveredText(h) {
  return h.calls.prompts.at(-1)?.content?.map((c) => c.text || '').join('') || '';
}

/**
 * 投递一次唤醒，返回 { delivered, text }。
 *
 * 投递完必须模拟"这一轮真的跑完了"（turn/start + turn/end + 解除在途租约），
 * 否则第二次唤醒会被 isConversationBusyV2 判忙、压根不投递 ——
 * 那时断言"没有重复提示"是假绿（读到的是上一条留下的旧 prompt）。
 */
async function wake(h, sessionId, key, reason) {
  const before = h.calls.prompts.length;
  await h.sendWakePromptV2(key, reason);
  await sleep(60);
  const delivered = h.calls.prompts.length > before;
  if (delivered) {
    const turn = h.calls.prompts.length; // 递增即可，只用来配对 start/end
    h.trackTurnEvent(sessionId, { type: 'turn/start', data: { turn } });
    h.trackTurnEvent(sessionId, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  }
  h.pendingWakeKeys.delete(key);
  h.disarmPendingWakeLease(key);
  return { delivered, text: deliveredText(h) };
}

test('新会话第一轮：两句提示都要真的投递出去', async () => {
  await withBridge(async (h) => {
    const sid = await h.ensureSession(G);
    const r = await wake(h, sid, G, 'anyMessage');
    assert.ok(r.delivered, '第一轮必须投递');
    assert.match(r.text, MEM_HINT, '记忆提示要出现在真正投递的正文里');
    assert.match(r.text, ROLE_HINT, '人格卡提示要出现在真正投递的正文里');
  });
});

test('新会话之后：同一个会话不再重复提示（这是压缩后必须只发一次的前提）', async () => {
  await withBridge(async (h) => {
    const sid = await h.ensureSession(G);
    await wake(h, sid, G, 'anyMessage');
    for (const reason of ['anyMessage', 'atMention', 'timeout']) {
      const r = await wake(h, sid, G, reason);
      assert.ok(r.delivered, `${reason} 这一轮应当照常投递`);
      assert.doesNotMatch(r.text, MEM_HINT, `${reason} 不该再带记忆提示`);
      assert.doesNotMatch(r.text, ROLE_HINT, `${reason} 不该再带人格卡提示`);
    }
  });
});

test('共用会话：私聊入口不会把冷启动提示再发一遍（按 DSH 会话记，不按 QQ key）', async () => {
  await withBridge(async (h) => {
    const sid = await h.ensureSession(G);
    await wake(h, sid, G, 'anyMessage');
    const r = await wake(h, sid, P, 'private');
    assert.ok(r.delivered, '私聊这一轮必须投递（只是不带冷启动提示）');
    assert.doesNotMatch(r.text, MEM_HINT, '群那一轮已经提示过了，私聊不该再来一遍');
    assert.doesNotMatch(r.text, ROLE_HINT);
  });
});

test('刚压缩过：下一轮投递里必须有那两句，且只此一轮', async () => {
  await withBridge(async (h) => {
    const sid = await h.ensureSession(G);
    await wake(h, sid, G, 'anyMessage'); // 先让新会话那次消费掉
    // 模拟 DSH 推来 compaction/end
    h.markColdStart(sid, 'compacted', 'test:compaction/end');

    const afterCompact = await wake(h, sid, G, 'timeout');
    assert.ok(afterCompact.delivered);
    assert.match(afterCompact.text, MEM_HINT, '压缩后必须提示去查记忆（旧实现这里永远是空的）');
    assert.match(afterCompact.text, ROLE_HINT, '压缩后必须提示重读人格卡');

    const next = await wake(h, sid, G, 'anyMessage');
    assert.doesNotMatch(next.text, MEM_HINT, '压缩提示只发一轮');
    assert.doesNotMatch(next.text, ROLE_HINT);
  });
});

test('投递失败不消费标记：下次补投仍然带着提示（提示不能跟着失败一起消失）', async () => {
  await withBridge(async (h) => {
    const sid = await h.ensureSession(G);
    // 让 DSH 拒绝这一次投递
    const original = h.api.sessions.prompt;
    let rejectOnce = true;
    h.api.sessions.prompt = async (params) => {
      if (rejectOnce) {
        rejectOnce = false;
        return { result: { ok: false, error: { code: 'fixture', message: '模拟拒绝' } } };
      }
      return original(params);
    };
    try {
      const first = await wake(h, sid, G, 'anyMessage');
      assert.equal(first.delivered, false, '这一次应当被拒');
      assert.equal(h.coldStartStateOf(G).coldStart, true, '被拒之后标记必须还在');
      const retry = await wake(h, sid, G, 'anyMessage');
      assert.match(retry.text, MEM_HINT, '补投的那次必须仍然带着提示');
    } finally {
      h.api.sessions.prompt = original;
    }
  });
});

test('记忆库为空：不点名 qq_memory_query（点名了她会白调一次）', async () => {
  await withBridge(async (h) => {
    const g = h.getSocialV2State('global');
    g.selfNotes = [];
    g.memberImpressions = {};
    const sid = await h.ensureSession(G);
    const r = await wake(h, sid, G, 'anyMessage');
    assert.match(r.text, /新会话或上下文刚压缩过/, '通用那句还是要给');
    assert.doesNotMatch(r.text, MEM_HINT, '库里没东西时不该点名工具');
    // 人格卡提示与记忆库无关，任何冷启动都该有。
    assert.match(r.text, ROLE_HINT);
  });
});

test('没有登记过的会话：一个字都不提示（判据只认登记表，不认 reason）', async () => {
  await withBridge(async (h) => {
    const sid = await h.ensureSession(G);
    await wake(h, sid, G, 'anyMessage'); // 消费掉新会话标记
    // reason 写成 bootstrap 也没用 —— 提示不由 reason 决定。
    const r = await wake(h, sid, G, 'bootstrap');
    assert.doesNotMatch(r.text, MEM_HINT, 'reason=bootstrap 不是发提示的理由');
    assert.doesNotMatch(r.text, ROLE_HINT);
  });
});
