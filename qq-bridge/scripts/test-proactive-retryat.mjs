// 主动唤醒「不开口也要说什么时候再来」回归（2026-11-26 第二轮）。
//
// ── 背景：11-26 那晚的"每分钟重试"有三个残留出口 ──────────────────────────
//
// 第一轮修了五道闸（额度/间隔/静默/刚回过话/宽限），但 `pickProactiveRouteV2`
// 里还有三处**裸 return null**：
//   ① 睡着时：今天已经做过噩梦 或 还没睡够 1 小时
//   ② 噩梦没掷中（占 82.5%）
//   ③ 随机兜底也没中
//
// 调用方拿到 null → retryAt=0 → 按 `lastProactiveAt + gap` 排，而那个时刻
// 早已过去 → delay 被夹到 60 秒下限 → **每分钟空转一次**。
//
// 夜里尤其致命：`ambientFallbackCandidates` 在 00:00–09:00 返回空数组
// （实测 48 个半小时采样点里 19 个空），所以每天夜里必走这条路。
// 日志实证：23:44→23:50 连续 7 次「约 1min 后」。
//
// ── 本轮修的语义 ───────────────────────────────────────────────────────────
//
// **任何"这次不开口"的判定都必须回答"什么时候再来"。**
// 没有答案的出口 = 调用方只能瞎排 = 空转。这条测试锁死这个契约。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:10001';
const HOUR = 3600 * 1000;

/** 本地日期键（和 bridge 里的 todayKeyOf 同一口径）。 */
function todayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function withBridge(config, fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: [] },
      socialV2: { proactive: { enabled: true }, sticker: { enabled: false } },
      ...config
    }
  });
  h.setMode('reserved2');
  // tier 0（疏远/平淡）连定时器都不排 —— 先把她提到 tier 3（偏爱，1000+ 分），
  // 否则断言的是"没排"而不是"排得对不对"。
  h.socialV2.affinities['10001'] = { score: 1100, count: 20, lastAt: Date.now() };
  h.lifeCircleCacheReset();   // 清掉进程内缓存，确保读到我们写的
  try { await fn(h); } finally { await h.close(); }
}

/** 断言一次"不开口"的返回必须带未来的 retryAt。 */
function assertBlockedWithFuture(picked, label) {
  assert.ok(picked, `${label}：应当返回 blocked 对象而不是 null（裸 null = 每分钟空转）`);
  assert.equal(picked.blocked, true, `${label}：blocked 必须为 true`);
  assert.ok(String(picked.blockedBy || '').length > 0, `${label}：必须说明是哪道闸`);
  const retryAt = Number(picked.retryAt);
  assert.ok(Number.isFinite(retryAt) && retryAt > 0, `${label}：必须给 retryAt`);
  const waitMs = retryAt - Date.now();
  assert.ok(waitMs > 0, `${label}：retryAt 必须在未来（实际 ${waitMs}ms）`);
  // 关键：不能是"60 秒后再来"那种贴着下限的瞎排
  assert.ok(waitMs >= 5 * 60 * 1000,
    `${label}：等待时间太短（${Math.round(waitMs / 1000)}s）—— 那正是空转的特征值`);
}

test('睡着 + 今晚已经做过噩梦 → 带 retryAt，不是裸 null', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    h.writeLifeCircle({
      v: 2, energy: 40, desire: 50,
      asleep: true, asleepSince: now - 3 * HOUR, lastTickedAt: now
    });
    // ★ 2026-11-26：标记改成了「夜键」（nightKeyOf，18:00 分界），不再是日历日。
    //   同一夜跨过零点不该重置 —— 这正是原来那个 bug。
    h.proactiveState().nightmareNight = h.nightKeyOf(now);

    const picked = h.pickProactiveRouteV2(KEY);
    assertBlockedWithFuture(picked, '已做噩梦');
    assert.equal(picked.blockedBy, 'asleep-nightmared');
  });
});

test('睡着 + 还没睡够 1 小时 → 排到满 1 小时那一刻，不是 60 秒后', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    const sleptSince = now - 10 * 60 * 1000;   // 只睡了 10 分钟
    h.writeLifeCircle({
      v: 2, energy: 70, desire: 50,
      asleep: true, asleepSince: sleptSince, lastTickedAt: now
    });
    h.proactiveState().nightmareNight = '';

    const picked = h.pickProactiveRouteV2(KEY);
    assertBlockedWithFuture(picked, '睡太短');
    assert.equal(picked.blockedBy, 'asleep-too-short');
    // 应当正好排在"睡满 1 小时"，也就是入睡时刻 + 1h
    const expect = sleptSince + HOUR;
    assert.ok(Math.abs(picked.retryAt - expect) < 10000,
      `应当排在睡满 1 小时那一刻（期望约 ${Math.round((expect - Date.now()) / 1000)}s 后，实际 ${Math.round((picked.retryAt - Date.now()) / 1000)}s）`);
  });
});

test('睡着 + 噩梦没掷中 → 至少隔几十分钟再掷，不是每分钟', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    h.writeLifeCircle({
      v: 2, energy: 40, desire: 50,
      asleep: true, asleepSince: now - 3 * HOUR, lastTickedAt: now
    });
    h.proactiveState().nightmareNight = '';
    // 强制"没掷中"：specialChance = 0 → 必然返回默认项
    h.cfg.socialV2.proactive.nightmareSpecialChance = 0;

    const picked = h.pickProactiveRouteV2(KEY);
    assertBlockedWithFuture(picked, '噩梦未中');
    assert.equal(picked.blockedBy, 'asleep-no-nightmare');
  });
});

test('醒着：要么有动机地开口，要么 blocked + retryAt —— **绝不允许裸 proactiveCheck**', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    // 醒着、额度充足、间隔已过、对方早就没说话、她也没刚回过话
    h.writeLifeCircle({
      v: 2, energy: 60, desire: 50,
      asleep: false, asleepSince: 0, lastTickedAt: now
    });
    h.proactiveState().lastProactiveAt = now - 10 * HOUR;
    const st = h.getSocialV2State(KEY);
    st.lastIncomingAt = now - 5 * HOUR;
    st.lastAiReplyAt = now - 5 * HOUR;

    const picked = h.pickProactiveRouteV2(KEY);
    if (picked && picked.route) {
      // 有具体路由 → 必须有动机（candidate.motive），或至少不是裸的 proactiveCheck
      assert.notEqual(picked.reason, 'proactiveCheck',
        '不再允许"没有动机"的裸 proactiveCheck —— 那正是 00:01:30 那次');
      if (picked.candidate) {
        assert.ok(String(picked.candidate.motive || '').length > 0,
          '带候选时必须有动机，否则她醒来看见屏幕不知道自己在干什么');
      }
    } else {
      assert.ok(picked?.blocked, '没候选时必须是 blocked 对象，不能是 null');
      assertBlockedWithFuture(picked, '无候选');
    }
  });
});

test('调度层：notBefore 必须被采纳（不能回退成 60 秒）', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    h.proactiveStateOf(KEY).lastProactiveAt = 0;
    h.scheduleProactiveCheckV2(KEY, { notBefore: now + 40 * 60 * 1000 });
    const at = Number(h.getSocialV2State(KEY).proactiveNextCheckAt) || 0;
    assert.ok(at > 0, '应当排出一个明确的检查时刻');
    assert.ok(at - Date.now() > 5 * 60 * 1000,
      `notBefore 必须被采纳（实际 ${Math.round((at - Date.now()) / 60000)}min 后）`);
  });
});

test('抖动缓存落在 proactiveStateOf 里（读写的必须是同一个容器）', async () => {
  await withBridge({}, async (h) => {
    h.scheduleProactiveCheckV2(KEY);
    const p = h.proactiveStateOf(KEY);
    // ★ 容器必须是 byKey 那条记录，不是 getSocialV2State 的会话对象。
    //   原来写会话对象、而落盘白名单里放的是 byKey —— 两个不同的容器，
    //   结果是「进程内能用、重启就没有」，注释还写着"存了会让旧间隔粘着"。
    assert.ok(Number(p.proactiveJitterFor) > 0,
      'proactiveJitterFor 应当写进 proactiveStateOf(key)，不是会话对象');
    assert.ok(Number.isFinite(Number(p.proactiveJitter)),
      'proactiveJitter 应当写进 proactiveStateOf(key)');
    // 会话对象上不该再被当作抖动缓存用
    const st = h.getSocialV2State(KEY);
    assert.equal(st.proactiveJitterFor, undefined,
      '会话对象上不该再有这个字段（它不在落盘白名单里，只会误导）');
  });
});

test('抖动**刻意不落盘**：重启后重摇一次，不影响行为', async () => {
  await withBridge({}, async (h) => {
    h.scheduleProactiveCheckV2(KEY);
    h.saveSocialV2State();
    const raw = JSON.parse(fs.readFileSync(h.paths.socialV2File, 'utf8'));
    const rec = raw?.globalMemory?.proactive?.byKey?.[KEY];
    assert.ok(rec, 'byKey 记录必须存在（否则重启后账全丢，那是 11-26 的根因）');
    // 记账字段必须在
    assert.ok('lastProactiveAt' in rec, 'lastProactiveAt 必须落盘');
    assert.ok('todayCount' in rec, 'todayCount 必须落盘');
    assert.ok('sentCandidateIds' in rec, 'sentCandidateIds 必须落盘');
    // 抖动刻意不在 —— 它只是"面板刷新时数字别跳"，重启重摇一次没有任何行为影响。
    assert.equal(rec.proactiveJitterFor, undefined,
      '抖动缓存刻意不落盘（见 saveSocialV2State 里的说明）');
  });
});
