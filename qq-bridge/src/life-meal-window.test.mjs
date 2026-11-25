// 饭点条件「不跨窗口」测试（2026-11-24）。
//
// 起因（实测 18:08 的一条唤醒词）：
//   【状态】饿了，想吃东西　精力：还好　心情：柔软　想吃甜的　饿了，想吃点热的
//   —— 同一条里既"想吃甜的"又"饿了，想吃点热的"，自相矛盾。
//
// 根因：条件时长写死 spec.hours（下午茶 2h），但窗口 17:00 就结束了。
//   16:47 生成的下午茶活到 18:47，和 17:30 开始的晚饭必然重叠。
//
// 修法：时长 = min(spec.hours, 距离窗口结束还剩多少分钟)。
//
// 这里测的是**时长计算规则本身**（纯函数），不依赖 bridge 的调度。

import test from 'node:test';
import assert from 'node:assert/strict';

import { MEAL_MOODS } from './life-vitals.js';

/**
 * 复刻 bridge.js 里的时长计算，供测试。
 * @param {object} spec MEAL_MOODS 的一条
 * @param {number} minuteOfDay 当前分钟数
 * @returns {number} 时长（小时）
 */
function durationOf(spec, minuteOfDay) {
  const endMin = Number(spec.endMin);
  const minutesLeft = Number.isFinite(endMin) ? Math.max(0, endMin - minuteOfDay) : Number(spec.hours) * 60;
  return Math.max(1 / 60, Math.min(Number(spec.hours) || 1, minutesLeft / 60));
}

const spec = (id) => MEAL_MOODS.find((w) => w.id === id);
const at = (h, m = 0) => h * 60 + m;

test('窗口刚打开时，用完整的 spec.hours（受窗口长度约束）', () => {
  // ⚠️ 原作者的 spec.hours **本来就不等于窗口长度**：
  //   breakfast 2.5h 窗口 / hours=2
  //   lunch     2.67h 窗口 / hours=2
  //   dinner    2.5h 窗口 / hours=3  ← 比窗口还长
  // 所以「窗口刚打开时一定拿到完整 hours」并不成立 —— 晚饭会被截到 2.5。
  // 断言要按**两者取小**来算，别钉死 spec.hours。
  assert.equal(durationOf(spec('afternoon'), at(15)), 2, '窗口 2h / hours 2 → 2');
  assert.equal(durationOf(spec('dinner'), at(17, 30)), 2.5, '窗口 2.5h / hours 3 → 取窗口 2.5');
});

test('窗口快结束时，被截断到剩余时间', () => {
  // 下午茶 15:00-17:00，16:47 只剩 13 分钟
  assert.equal(durationOf(spec('afternoon'), at(16, 47)), 13 / 60);
  // 晚饭 17:30-20:00，19:50 只剩 10 分钟
  assert.equal(durationOf(spec('dinner'), at(19, 50)), 10 / 60);
});

test('**关键回归**：16:47 的下午茶不能在 17:00 之后还活着', () => {
  const d = durationOf(spec('afternoon'), at(16, 47));
  const startsAt = 16 * 60 + 47;
  const endsAt = startsAt + d * 60;
  assert.ok(endsAt <= 17 * 60, `实际结束于 ${endsAt} 分，不该超过 17:00（1020）`);
});

test('**关键回归**：任意时刻生成的 meal 都不会跨过自己窗口的结束点', () => {
  for (const s of MEAL_MOODS) {
    // 在窗口内的每一分钟都试一遍（步长 5 分钟够密了）
    for (let m = s.startMin; m < s.endMin; m += 5) {
      const d = durationOf(s, m);
      const endsAt = m + d * 60;
      assert.ok(endsAt <= s.endMin + 0.01,
        `${s.id} 在 ${m} 分生成，结束于 ${endsAt.toFixed(1)}，超过了窗口终点 ${s.endMin}`);
    }
  }
});

test('窗口最后一分钟生成时，至少有 1 分钟寿命', () => {
  // 不然会「生成即过期」，下一轮又重建，无限循环。
  const d = durationOf(spec('afternoon'), at(16, 59) + 0.99);
  assert.ok(d >= 1 / 60 - 1e-9, `时长 ${d}h 太短`);
});

test('相邻窗口之间不会重叠（这是本次修复的核心保证）', () => {
  // 把每个窗口按 5 分钟采样，算出「这条 meal 的存活区间」，
  // 断言任意两条不同窗口的存活区间都不相交。
  const intervals = [];
  for (const s of MEAL_MOODS) {
    for (let m = s.startMin; m < s.endMin; m += 5) {
      intervals.push({ id: s.id, from: m, to: m + durationOf(s, m) * 60 });
    }
  }
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const a = intervals[i];
      const b = intervals[j];
      if (a.id === b.id) continue;
      const overlap = Math.min(a.to, b.to) - Math.max(a.from, b.from);
      assert.ok(overlap <= 0.01,
        `${a.id}(${a.from}→${a.to.toFixed(0)}) 与 ${b.id}(${b.from}→${b.to.toFixed(0)}) 重叠 ${overlap.toFixed(1)} 分钟`);
    }
  }
});
