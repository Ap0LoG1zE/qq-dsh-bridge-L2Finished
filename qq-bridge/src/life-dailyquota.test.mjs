// 日额度「日历日」判定的单元测试（2026-11-24）。
//
// 起因：QQ 空间的每日上限原来用 `now - t < 86400000` 的**滚动 24 小时**窗口，
// 于是"每天最多 2 条"实际变成"任意 24 小时内最多 2 条"——
// 早上 8 点发的，到第二天早上 8 点前还算今天，跨天时会突然卡住。
//
// 改成 AstrBot 的 `sent_day` 做法：存日期字符串，跨天整体归零。
//
// 这里测的是**判定函数本身**（不含 HTTP 调用）。

import test from 'node:test';
import assert from 'node:assert/strict';

/** 复刻 bridge.js 里的日额度判定。 */
function bumpDailyQuota(state, { today, max, now }) {
  if (state.sentDay !== today) {
    state.sentDay = today;
    state.sentCount = 0;
  }
  const used = Number(state.sentCount) || 0;
  if (used >= max) return { ok: false, used, reason: 'quota' };
  state.sentCount = used + 1;
  return { ok: true, used: used + 1, at: now };
}

test('跨天归零：昨天的计数不带进今天', () => {
  const st = { sentDay: '2026-11-23', sentCount: 2 };
  const r = bumpDailyQuota(st, { today: '2026-11-24', max: 2, now: 1 });
  assert.equal(r.ok, true, '新的一天应当有额度');
  assert.equal(st.sentCount, 1, '从 0 起算后 +1');
  assert.equal(st.sentDay, '2026-11-24');
});

test('同一天内额度用完就拒绝', () => {
  const st = { sentDay: '2026-11-24', sentCount: 2 };
  const r = bumpDailyQuota(st, { today: '2026-11-24', max: 2, now: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quota');
  assert.equal(st.sentCount, 2, '拒绝时不该加计数');
});

test('同一天内可以连续发到上限', () => {
  const st = { sentDay: '', sentCount: 0 };
  const today = '2026-11-24';
  assert.equal(bumpDailyQuota(st, { today, max: 3, now: 1 }).ok, true);
  assert.equal(bumpDailyQuota(st, { today, max: 3, now: 2 }).ok, true);
  assert.equal(bumpDailyQuota(st, { today, max: 3, now: 3 }).ok, true);
  assert.equal(bumpDailyQuota(st, { today, max: 3, now: 4 }).ok, false);
});

test('日历日 vs 滚动 24h：这是这次改动的核心差异', () => {
  // 场景：23:59 发了一条，00:01 再发。
  //   · 滚动 24h：两条相距 2 分钟，算"同一窗口"，第 2 条被拒。
  //   · 日历日：已经是新的一天，应当放行。
  const st = { sentDay: '2026-11-23', sentCount: 2 };
  const r = bumpDailyQuota(st, { today: '2026-11-24', max: 2, now: 1 });
  assert.equal(r.ok, true, '跨过零点就是新的一天，该放行');
});

test('反过来：早上 8 点发的，当晚还算今天', () => {
  // 这是日历日的代价：一天内发得多，到零点才重置。
  const st = { sentDay: '2026-11-24', sentCount: 2 };
  // 同一天 23:00 再发 → 拒绝
  assert.equal(bumpDailyQuota(st, { today: '2026-11-24', max: 2, now: 2 }).ok, false);
  // 第二天 00:00 → 放行
  assert.equal(bumpDailyQuota(st, { today: '2026-11-25', max: 2, now: 3 }).ok, true);
});

test('状态字段缺失时不崩（老数据/首次运行）', () => {
  const st = {};
  const r = bumpDailyQuota(st, { today: '2026-11-24', max: 2, now: 1 });
  assert.equal(r.ok, true);
  assert.equal(st.sentCount, 1);
});

test('计数被写成字符串也能正确比较', () => {
  // 从 JSON 读回来的数字可能是字符串，Number() 要能兜住。
  const st = { sentDay: '2026-11-24', sentCount: '2' };
  const r = bumpDailyQuota(st, { today: '2026-11-24', max: 2, now: 1 });
  assert.equal(r.ok, false);
});
