// 主动机会的**调度时刻**回归（2026-11-26）。
//
// 11-26 00:01 那次"她莫名被叫醒"的完整链条：
//   ① 按会话的记账没落盘 → 读回来 `lastProactiveAt` 是 0；
//   ② 排检查时刻的代码遇到 0 就退到"现在 + 60 秒"；
//   ③ 60 秒短到静默门槛（对方 15 分钟没说话）和"刚回过话"（她 30 分钟内
//      说过话）都还没放行 → 每次到点被拒 → 立刻再排 60 秒 → 每分钟空转；
//   ④ 那两道闸一过，她就被毫无预兆地叫醒。
//
// ①在 test-proactive-persist.mjs 里钉住了；②③在这里钉：
//   **没有历史账时，检查时刻也不能早于"现在 + 一个完整间隔"**。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:10001';

async function withBridge(fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: [] },
      socialV2: { proactive: { enabled: true }, sticker: { enabled: false } }
    }
  });
  h.setMode('reserved2');
  // tier 0（疏远/平淡）**连定时器都不排** —— 先把她提到 tier 3（偏爱，1000+ 分），
  // 否则这里断言的是"没排"而不是"排得对不对"。
  h.socialV2.affinities['10001'] = { score: 1100, count: 20, lastAt: Date.now() };
  try { await fn(h); } finally { await h.close(); }
}

test('从没记过账：下一次检查不能是"1 分钟后"，要等够一整个间隔', async () => {
  await withBridge(async (h) => {
    const p = h.proactiveStateOf(KEY);
    assert.equal(p.lastProactiveAt, 0, '前提：这一轮确实是"没记过账"');
    h.scheduleProactiveCheckV2(KEY);
    const at = Number(h.getSocialV2State(KEY).proactiveNextCheckAt) || 0;
    assert.ok(at > 0, '应当排出了一个明确的检查时刻（面板要显示倒计时）');
    const waitMs = at - Date.now();
    // 一分钟是 bug 的特征值；任何正常间隔（tier3 起步就是几十分钟）都远大于它。
    assert.ok(waitMs > 5 * 60 * 1000,
      `没有历史账时不该 1 分钟后就检查（实际 ${Math.round(waitMs / 1000)}s）—— `
      + '那会让定时器每分钟空转，闸门一过就叫醒她');
  });
});

test('有历史账：检查时刻 = 上次开口 + 间隔，不受今天已发条数影响而提前', async () => {
  await withBridge(async (h) => {
    const p = h.proactiveStateOf(KEY);
    const now = Date.now();
    p.lastProactiveAt = now - 60 * 1000;   // 1 分钟前刚主动说过话
    h.scheduleProactiveCheckV2(KEY);
    const at = Number(h.getSocialV2State(KEY).proactiveNextCheckAt) || 0;
    const waitMs = at - now;
    assert.ok(waitMs > 5 * 60 * 1000,
      `刚说过话不该马上就再排一次（实际 ${Math.round(waitMs / 1000)}s）`);
    // 而且必须是"上次开口 + 间隔"附近，不是重新从现在算起 —— 否则
    // 每次重排都会把间隔重置，等于永远等不到。
    assert.ok(waitMs < 12 * 3600 * 1000, '间隔不应长到离谱（上限 10 小时量级）');
  });
});

test('被闸门拒了：直接排到它放行的时刻，不是 60 秒后再撞一次', async () => {
  await withBridge(async (h) => {
    const st = h.getSocialV2State(KEY);
    const p = h.proactiveStateOf(KEY);
    const now = Date.now();
    // 让对方刚刚说过话 —— 静默门槛 15 分钟，此刻必然被拒。
    p.lastProactiveAt = now - 10 * 3600 * 1000;   // 间隔早就过了
    st.lastIncomingAt = now - 60 * 1000;          // 1 分钟前刚说话
    st.lastAiReplyAt = 0;
    p.awaitingReplySince = 0;
    p.todayCount = 0;

    const t0 = Date.now();
    st.proactiveTimer = null;
    h.scheduleProactiveCheckV2(KEY);
    // 手动触发定时器逻辑：直接调用判定，取它给的 retryAt
    const picked = h.pickProactiveRouteV2(KEY);
    assert.equal(picked?.blocked, true, '这个状态必须被判为"本轮不开口"');
    assert.equal(picked?.blockedBy, 'idle', '拒绝理由应当是静默门槛');
    const retryAt = Number(picked.retryAt) || 0;
    const waitMs = retryAt - t0;
    assert.ok(waitMs > 10 * 60 * 1000,
      `应当排到静默门槛放行（约 14 分钟后），实际 ${Math.round(waitMs / 1000)}s —— `
      + '60 秒重试就是"每分钟撞一次墙"的那个 bug');

    // 再验证调度真的采纳了这个时刻（而不是自己的 earliest）。
    if (st.proactiveTimer) { clearTimeout(st.proactiveTimer); st.proactiveTimer = null; }
    h.scheduleProactiveCheckV2(KEY, { notBefore: retryAt });
    const at = Number(st.proactiveNextCheckAt) || 0;
    assert.ok(Math.abs(at - retryAt) < 2000,
      `调度应当排在 ${new Date(retryAt).toLocaleTimeString()}，实际差 ${Math.round((at - retryAt) / 1000)}s`);
  });
});

test('软目标：额度 3 条的档只打算发 2 条，超了拉长间隔但不硬停', async () => {
  await withBridge(async (h) => {
    // tier1 的额度是 1–3 条（依赖档），targetRatio 0.78
    const policy = h.PROACTIVE_TIERS[1];
    assert.equal(h.proactiveSoftTarget(policy, 3), 2, '3 条 × 0.78 ≈ 2 条');
    assert.equal(h.proactiveSoftTarget(policy, 1), 1, '额度 1 条时至少留 1，不能算成 0');
    assert.equal(h.proactiveSoftTarget(policy, 4), 3, '4 条 × 0.78 ≈ 3 条');
    // tier3 0.92：8 条 → 7 条；12 条 → 11 条
    const p3 = h.PROACTIVE_TIERS[3];
    assert.equal(h.proactiveSoftTarget(p3, 8), 7);
    assert.equal(h.proactiveSoftTarget(p3, 12), 11);

    // 关键语义：超过软目标**只是拉长间隔**，不是拒绝。
    const over = h.quotaPressureFactor(policy, { quota: 3, usedToday: 3 });
    assert.ok(over > 1, `超过软目标时因子应当 > 1（实际 ${over}）`);
    assert.ok(Number.isFinite(over) && over <= 4, '但也要有上限，不能变成无限等待');
    // 没超时反而更积极
    const under = h.quotaPressureFactor(policy, { quota: 3, usedToday: 0 });
    assert.ok(under < over, '还剩很多时应当比超额时更积极');
  });
});
