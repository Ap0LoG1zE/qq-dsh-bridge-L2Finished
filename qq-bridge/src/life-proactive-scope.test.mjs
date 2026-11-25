// 主动状态「按人隔离」的测试（2026-11-24）。
//
// 改造前的四个全局单例，导致的实际问题：
//   · todayCount 全局 1 条 → 面板显示「鹿姐 1/12」，但那 1 条是给别人发的
//   · lastProactiveAt 全局 → 给 A 发过之后，B 也要等同样的间隔
//   · sentCandidateIds 全局 → 私聊 A 说了"早安"，私聊 B 当天就说不出来
//   · unanswered / awaitingReplySince 全局 → 别人没回也影响她
//
// 这里复刻改造后的逻辑，逐条验证隔离性。

import test from 'node:test';
import assert from 'node:assert/strict';

/** 复刻 proactiveState / proactiveStateOf 的结构。 */
function makeStore() {
  return { v: 2, byKey: {}, daypartCounts: null, nightmareNight: '' };
}

function stateOf(store, key) {
  const k = String(key || '');
  if (!k) return null;
  let rec = store.byKey[k];
  if (!rec) {
    rec = {
      todayKey: '', todayCount: 0, lastProactiveAt: 0, lastRoute: '',
      unanswered: {}, awaitingReplySince: 0, routeSentCounts: {},
      quotaOfDay: null, sentCandidateIds: [],
      proactiveJitterFor: 0, proactiveJitter: 0
    };
    store.byKey[k] = rec;
  }
  return rec;
}

function todayCountOf(store, key, today) {
  const p = stateOf(store, key);
  if (!p) return 0;
  if (p.todayKey !== today) { p.todayKey = today; p.todayCount = 0; }
  return Number(p.todayCount) || 0;
}

function recordSent(store, key, today, route = 'curiosity') {
  const p = stateOf(store, key);
  if (!p) return;
  todayCountOf(store, key, today);
  p.todayCount += 1;
  p.lastProactiveAt = Date.now();
  p.lastRoute = route;
  p.routeSentCounts[route] = (p.routeSentCounts[route] || 0) + 1;
}

function unansweredTotalOf(store, key) {
  const p = stateOf(store, key);
  if (!p) return 0;
  let n = 0;
  for (const it of Object.values(p.unanswered)) n += Math.max(0, Number(it?.count) || 0);
  return n;
}

function resetUnanswered(store, key) {
  const p = stateOf(store, key);
  if (!p) return;
  for (const it of Object.values(p.unanswered)) if (it && typeof it === 'object') it.count = 0;
  p.awaitingReplySince = 0;
}

const A = 'private:84420221';     // 鹿姐（1186 分）
const B = 'private:3380569062';
const G = 'group:993578160';
const TODAY = '2026-11-24';

// ── ① todayCount 隔离 ──────────────────────────────────────────────────────

test('给 A 发一条，B 的计数仍是 0', () => {
  const s = makeStore();
  recordSent(s, A, TODAY);
  assert.equal(todayCountOf(s, A, TODAY), 1);
  assert.equal(todayCountOf(s, B, TODAY), 0, 'B 不该被 A 的发送影响');
});

test('两个会话各自计数，互不干扰', () => {
  const s = makeStore();
  recordSent(s, A, TODAY);
  recordSent(s, A, TODAY);
  recordSent(s, A, TODAY);
  recordSent(s, B, TODAY);
  assert.equal(todayCountOf(s, A, TODAY), 3);
  assert.equal(todayCountOf(s, B, TODAY), 1);
});

test('群聊与私聊也隔离', () => {
  const s = makeStore();
  recordSent(s, G, TODAY);
  assert.equal(todayCountOf(s, G, TODAY), 1);
  assert.equal(todayCountOf(s, A, TODAY), 0);
});

test('跨天各自归零', () => {
  const s = makeStore();
  recordSent(s, A, '2026-11-23');
  recordSent(s, B, '2026-11-23');
  assert.equal(todayCountOf(s, A, TODAY), 0);
  assert.equal(todayCountOf(s, B, TODAY), 0);
});

// ── ② lastProactiveAt 隔离 ─────────────────────────────────────────────────

test('给 A 发过之后，B 的 lastProactiveAt 仍是 0', () => {
  const s = makeStore();
  recordSent(s, A, TODAY);
  assert.ok(stateOf(s, A).lastProactiveAt > 0);
  assert.equal(stateOf(s, B).lastProactiveAt, 0, 'B 不该被 A 的发送挡住');
});

// ── ③ 未回应隔离 ───────────────────────────────────────────────────────────

test('未回应计数按会话隔离', () => {
  const s = makeStore();
  stateOf(s, A).unanswered.curiosity = { count: 3, since: 1 };
  stateOf(s, B).unanswered.curiosity = { count: 1, since: 2 };
  assert.equal(unansweredTotalOf(s, A), 3);
  assert.equal(unansweredTotalOf(s, B), 1);
});

test('A 回来了只清 A 的账，不影响 B', () => {
  const s = makeStore();
  stateOf(s, A).unanswered.curiosity = { count: 3, since: 1 };
  stateOf(s, B).unanswered.curiosity = { count: 2, since: 1 };
  stateOf(s, A).awaitingReplySince = 111;
  stateOf(s, B).awaitingReplySince = 222;

  resetUnanswered(s, A);

  assert.equal(unansweredTotalOf(s, A), 0, 'A 的账该清了');
  assert.equal(stateOf(s, A).awaitingReplySince, 0);
  assert.equal(unansweredTotalOf(s, B), 2, 'B 的账不该被清');
  assert.equal(stateOf(s, B).awaitingReplySince, 222, 'B 的等待不该被清');
});

// ── ④ 候选去重隔离 ─────────────────────────────────────────────────────────

test('A 用掉「早安」之后，B 还能用', () => {
  const s = makeStore();
  stateOf(s, A).sentCandidateIds = [`${TODAY}:morning-plain`];
  const usedA = new Set(stateOf(s, A).sentCandidateIds.filter((id) => id.startsWith(TODAY)));
  const usedB = new Set(stateOf(s, B).sentCandidateIds.filter((id) => id.startsWith(TODAY)));
  assert.ok(usedA.has(`${TODAY}:morning-plain`), 'A 用过');
  assert.ok(!usedB.has(`${TODAY}:morning-plain`), 'B 不该受影响');
});

test('候选去重跨天自动失效', () => {
  const s = makeStore();
  stateOf(s, A).sentCandidateIds = ['2026-11-23:morning-plain'];
  const used = new Set(stateOf(s, A).sentCandidateIds.filter((id) => id.startsWith(TODAY)));
  assert.equal(used.size, 0, '昨天的记录今天不算');
});

// ── ⑤ 额度缓存隔离 ─────────────────────────────────────────────────────────

test('quotaOfDay 按会话存（A 的 12 条不该被 B 读到）', () => {
  const s = makeStore();
  stateOf(s, A).quotaOfDay = { date: TODAY, tier: 3, quota: 12, score: 1186 };
  stateOf(s, B).quotaOfDay = { date: TODAY, tier: 1, quota: 2, score: 150 };
  assert.equal(stateOf(s, A).quotaOfDay.quota, 12);
  assert.equal(stateOf(s, B).quotaOfDay.quota, 2);
});

// ── ⑥ 仍是全局的字段 ───────────────────────────────────────────────────────

test('nightmareNight 是全局的（她只有一副身体、只睡一次觉）', () => {
  const s = makeStore();
  s.nightmareNight = TODAY;
  // 不管哪个会话来问，答案都一样 —— 同一晚不该惊两次
  assert.equal(s.nightmareNight, TODAY);
  assert.ok(!('nightmareNight' in stateOf(s, A)), '按人的记录里不该有它');
});

test('daypartCounts 是全局的（深夜发过一条就是发过了）', () => {
  const s = makeStore();
  assert.equal(s.daypartCounts, null, '初始为空');
  // 它挂在 store 上而不是 stateOf(key) 上
  assert.ok(!('daypartCounts' in stateOf(s, A)));
});

// ── ⑦ 空 key 防御 ──────────────────────────────────────────────────────────

test('空 key 返回 null，不创建记录', () => {
  const s = makeStore();
  assert.equal(stateOf(s, ''), null);
  assert.equal(stateOf(s, null), null);
  assert.equal(stateOf(s, undefined), null);
  assert.equal(Object.keys(s.byKey).length, 0, '不该因为空 key 建出空记录');
});

test('空 key 的计数查询返回 0（不抛错）', () => {
  const s = makeStore();
  assert.equal(todayCountOf(s, '', TODAY), 0);
  assert.equal(unansweredTotalOf(s, ''), 0);
});

// ── ⑧ 老数据迁移 ───────────────────────────────────────────────────────────

test('v1 老数据迁移后 quotaOfDay 被清空（旧值按 tier 缓存，是错的）', () => {
  // 复刻迁移逻辑
  const p = { v: 1, todayKey: TODAY, todayCount: 1, quotaOfDay: { date: TODAY, tier: 3, quota: 9 } };
  if (Number(p.v) < 2) {
    p.v = 2;
    p.migratedToV2At = Date.now();
    p.quotaOfDay = null;
  }
  assert.equal(p.v, 2);
  assert.equal(p.quotaOfDay, null, '旧的 9 条必须清掉，让新逻辑按分数重算');
});

test('迁移后老字段仍在顶层（当只读历史，不参与新逻辑）', () => {
  const p = { v: 1, todayCount: 1, lastProactiveAt: 123 };
  if (Number(p.v) < 2) { p.v = 2; p.quotaOfDay = null; }
  // 老字段没被删是**故意的**：删了没法排查，留着不会影响 byKey 逻辑
  assert.equal(p.todayCount, 1);
  assert.equal(p.lastProactiveAt, 123);
});
