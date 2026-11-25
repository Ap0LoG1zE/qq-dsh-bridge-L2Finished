// follow-up 链的纯逻辑测试（2026-11-24）。
//
// 调度器本身在 bridge.js 里（依赖定时器与全局状态），不便直接单测；
// 这里测试**可以被单测的部分**：链结构、步骤取值、以及"什么时候该跳过"的判定。
//
// 判定规则（照原作者 + 操作者口径「不回复＝没读」）：
//   ① 对方在这之后说过话 → 跳过（接上了）
//   ② 她自己又主动说过话 → 跳过（会变成连发）
//   ③ 今日额度用完       → 跳过
//   ④ 会话不允许/繁忙    → 跳过

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  morningCandidates,
  daypartCandidates,
  hasChain,
  chainStepAt
} from './life-proactive.js';

const at = (h, m = 0) => h * 60 + m;
const yes = () => 0;

// ── 复刻 bridge.js 里的跳过判定，供测试 ────────────────────────────────────
function shouldSkipFollowUp({ sentAt, lastIncomingAt, lastProactiveAt, usedToday, quota, allowed = true, busy = false }) {
  if (Number(lastIncomingAt) > Number(sentAt)) return 'replied';
  if (Number(lastProactiveAt) > Number(sentAt)) return 'self-active';
  if (Number(usedToday) >= Number(quota)) return 'quota';
  if (!allowed) return 'not-allowed';
  if (busy) return 'busy';
  return '';
}

test('早晨候选带三级链，且能按序取到每一步', () => {
  const c = morningCandidates({ minuteOfDay: at(9), energy: 80, sleepHours: 5, rand: yes })[0];
  assert.equal(hasChain(c), true);
  const s0 = chainStepAt(c.chain, 0);
  const s1 = chainStepAt(c.chain, 1);
  const s2 = chainStepAt(c.chain, 2);
  assert.equal(s0.kind, 'name_only_opener');
  assert.equal(s1.kind, 'if_no_reply');
  assert.equal(s2.kind, 'if_still_no_reply');
  // 第四级必须是 null —— 原作者的链最多三级，绝不多追。
  assert.equal(chainStepAt(c.chain, 3), null);
});

test('链的 after_minutes 是递增的（下一级等更久）', () => {
  const c = morningCandidates({ minuteOfDay: at(9), energy: 80, sleepHours: 5, rand: yes })[0];
  const a = c.chain[1].after_minutes;
  const b = c.chain[2].after_minutes;
  assert.ok(b > a, `第二级(${b})应当比第一级(${a})晚`);
});

test('白天候选没有链（不需要追）', () => {
  const c = daypartCandidates({ minuteOfDay: at(12, 30), energy: 50, rand: yes })[0];
  assert.equal(hasChain(c), false);
});

// ── 跳过判定 ───────────────────────────────────────────────────────────────

test('对方回话了 → 整条链作废', () => {
  assert.equal(shouldSkipFollowUp({
    sentAt: 1000, lastIncomingAt: 2000, lastProactiveAt: 0, usedToday: 0, quota: 5
  }), 'replied');
});

test('没回话 → 继续追', () => {
  assert.equal(shouldSkipFollowUp({
    sentAt: 2000, lastIncomingAt: 1000, lastProactiveAt: 0, usedToday: 0, quota: 5
  }), '');
});

test('这期间她自己又主动说过 → 不追（避免连发）', () => {
  assert.equal(shouldSkipFollowUp({
    sentAt: 1000, lastIncomingAt: 0, lastProactiveAt: 1500, usedToday: 0, quota: 5
  }), 'self-active');
});

test('额度用完 → 不追', () => {
  assert.equal(shouldSkipFollowUp({
    sentAt: 1000, lastIncomingAt: 0, lastProactiveAt: 0, usedToday: 5, quota: 5
  }), 'quota');
});

test('会话不允许 / 繁忙 → 不追', () => {
  assert.equal(shouldSkipFollowUp({
    sentAt: 1000, lastIncomingAt: 0, lastProactiveAt: 0, usedToday: 0, quota: 5, allowed: false
  }), 'not-allowed');
  assert.equal(shouldSkipFollowUp({
    sentAt: 1000, lastIncomingAt: 0, lastProactiveAt: 0, usedToday: 0, quota: 5, busy: true
  }), 'busy');
});

test('判定顺序：回话优先于额度（先判断最重要的）', () => {
  // 同时满足"回话了"和"额度用完"时，应当报 replied —— 因为那是最直接的原因。
  assert.equal(shouldSkipFollowUp({
    sentAt: 1000, lastIncomingAt: 2000, lastProactiveAt: 0, usedToday: 9, quota: 5
  }), 'replied');
});

test('时间戳相等不算"回过了"（必须是严格大于）', () => {
  // 边界：她发出去的那一刻对方正好也发了一条，不该判成 replied。
  assert.equal(shouldSkipFollowUp({
    sentAt: 1000, lastIncomingAt: 1000, lastProactiveAt: 0, usedToday: 0, quota: 5
  }), '');
});
