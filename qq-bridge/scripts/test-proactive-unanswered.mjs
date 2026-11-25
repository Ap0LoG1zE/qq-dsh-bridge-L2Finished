// 未回应记账的回归（2026-11-26）。
//
// 11-26 查出来的 bug：`resetUnansweredV2` 会把这笔账清零，
// 但**全库没有任何地方把它加过 1** —— `recordProactiveSentV2` 只写了
// `awaitingReplySince`，没有写 `unanswered[route].count`。
//
// 后果（三件事全恒为假）：
//   · `proactiveGapMsOf` 里"没回就拉长间隔"那一段永远乘 1.0
//   · `pickProactiveRouteV2` 里「对话延续」要求 unanswered > 0，永远进不去
//   · 面板上"因未回应 ×1.35"这类解释永远是 1.00
//
// 这里钉的是**整条链**：发一次 → 计数 +1 → 间隔变大 → 对方回来 → 清零。
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
  // tier3（偏爱，1000+）：unansweredWeight = 1.0，放大效果最明显。
  h.socialV2.affinities['10001'] = { score: 1100, count: 20, lastAt: Date.now() };
  // ⚠️ 时段计数是**全局**的，会在同一进程里跨 harness 残留：上一条用例
  // 发过一次消息就把它加成 late_night=1，接着"深夜已经发过一条"那条硬规则
  // 就会把间隔拉到 7.5–10.5 小时 —— 后面的用例于是被间隔门挡住，
  // 测出来的不是它想测的东西。这里显式清掉。
  h.proactiveState().daypartCounts = null;
  try { await fn(h); } finally { await h.close(); }
}

test('发出"等回应"的消息 → 未回应 +1；说些什么就算接上了 → 清零', async () => {
  await withBridge(async (h) => {
    const p = h.proactiveStateOf(KEY);
    assert.equal(h.proactiveUnansweredTotal(KEY), 0, '初始应当是 0');

    h.recordProactiveSentV2(KEY, 'continuation');
    assert.equal(h.proactiveUnansweredTotal(KEY), 1, '等回应的消息发出去，账上要 +1');
    assert.ok(p.awaitingReplySince > 0, '"在等回复"也要记下');

    h.recordProactiveSentV2(KEY, 'continuation');
    assert.equal(h.proactiveUnansweredTotal(KEY), 2, '再发一次就 +2');

    // 对方说话了 → 归零
    const st = h.getSocialV2State(KEY);
    st.lastIncomingAt = Date.now();
    h.resetUnansweredV2(KEY);
    assert.equal(h.proactiveUnansweredTotal(KEY), 0, '对方一开口，账就该清');
    assert.equal(p.awaitingReplySince, 0);
  });
});

test('只有"等回应"的路由才记账：curiosity 是"我自己想说"，不欠人情', async () => {
  await withBridge(async (h) => {
    h.recordProactiveSentV2(KEY, 'curiosity');
    assert.equal(h.proactiveUnansweredTotal(KEY), 0,
      '她自己想说的那种，对方不回不算她的账（照原作者的 response_expectation=none）');
    assert.equal(h.proactiveStateOf(KEY).awaitingReplySince, 0);
  });
});

test('未回应越多，间隔越长（线性、有封顶，不会一路涨到不开口）', async () => {
  await withBridge(async (h) => {
    const { policy, quota } = h.proactiveQuotaOf(KEY);
    const opts = { hour: 15, minute: 0, quota, usedToday: 0 };
    const g0 = h.proactiveGapMsOf(policy, 0, opts);
    const g2 = h.proactiveGapMsOf(policy, 2, opts);
    const g5 = h.proactiveGapMsOf(policy, 5, opts);
    const g20 = h.proactiveGapMsOf(policy, 20, opts);
    assert.ok(g2 > g0, '两次没回，间隔要变长');
    assert.ok(g5 > g2, '继续没回，继续变长');
    // 封顶：2.2 倍（tier3 的 unansweredWeight = 1.0，全额生效）
    const base = g0;
    assert.ok(g20 <= base * 2.2 + 1000,
      `未回应 20 次也不该超过 2.2 倍（实际 ${(g20 / base).toFixed(2)} 倍）`);
    // 到顶之后就持平，不再无限增长
    const g50 = h.proactiveGapMsOf(policy, 50, opts);
    assert.equal(g50, g20, '超过封顶后不再变化');
  });
});

test('「对话延续」这条路由真的能进得去（它要求 unanswered > 0）', async () => {
  await withBridge(async (h) => {
    const p = h.proactiveStateOf(KEY);
    const st = h.getSocialV2State(KEY);
    const now = Date.now();
    // 布置成"她开了口、你没回、宽限期已过、静默够久"。
    // ⚠️ 往前推 8 小时而不是 2 小时：间隔 = base(90min) × 时段权重
    //   （凌晨 2.0）× 额度压力 —— 夜里算出来能到 2.4 小时以上，
    //   2 小时会被间隔门挡下，测的就不是"延续"这条路由了。
    const back = 8 * 3600 * 1000;
    p.awaitingReplySince = now - back;
    p.lastProactiveAt = now - back;
    p.todayCount = 0;
    st.lastIncomingAt = now - back;
    st.lastAiReplyAt = 0;
    p.unanswered = {};   // 先清空

    // 没有未回应记录时，进不去延续
    let picked = h.pickProactiveRouteV2(KEY);
    assert.notEqual(picked?.route, 'continuation', '账上是 0 的时候不该走"延续"');

    // 真的发过一次之后就有了
    h.recordProactiveSentV2(KEY, 'continuation');
    // ⚠️ 发消息会顺手把 daypart 计数 +1（late_night=1），而"深夜已发过一条"
    //   是条**硬规则**，会把间隔直接拉到 7.5–10.5 小时 —— 比下面推的 8 小时
    //   还长，于是又被间隔门挡住。这条用例测的是"延续能不能进去"，
    //   不是深夜规则，所以把这一笔清掉。
    h.proactiveState().daypartCounts = null;
    p.awaitingReplySince = now - back;
    p.lastProactiveAt = now - back;
    picked = h.pickProactiveRouteV2(KEY);
    assert.equal(picked?.blocked, undefined, '这时不该被闸门挡住');
    assert.equal(picked?.route, 'continuation', '有未回应时应当走"对话延续"');
  });
});
