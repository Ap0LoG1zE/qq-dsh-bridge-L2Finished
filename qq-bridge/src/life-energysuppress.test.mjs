// 「精力：精神很好」与负面状态互斥的测试（2026-11-24）。
//
// 实测发现的矛盾：
//   精力基础值 98、扣掉感冒的 12 还剩 86 → 显示「精力：精神很好」，
//   而同一行里有「心情：疲惫」。感冒的人不会说自己精神很好。
//
// 修法：**有负面 condition 时不播报「精神很好」**，
// 把显示值压到「正常档」（留白），但**不改真实数据**。
// 因为数值是真实算出来的（她体力确实还在），只是不该拿它来夸口。

import test from 'node:test';
import assert from 'node:assert/strict';

import { circleExtras, STATUS_TEXT } from './life-circle.js';

const base = { satiety: 80, desire: 50 };

test('无负面条件时，精力 >= 85 照常播报「精神很好」', () => {
  const out = circleExtras({ ...base, energy: 86 }, { includeDesire: true });
  assert.ok(out.some((s) => s.includes('精神')), JSON.stringify(out));
});

test('有负面条件时，精力 86 **不**播报「精神很好」', () => {
  const out = circleExtras({ ...base, energy: 86 }, { includeDesire: true, suppressHighEnergy: true });
  assert.ok(!out.some((s) => s.includes('精神')), `不该出现「精神」：${JSON.stringify(out)}`);
});

test('有负面条件时，精力 95 也压制（不只卡 85 边界）', () => {
  const out = circleExtras({ ...base, energy: 95 }, { includeDesire: true, suppressHighEnergy: true });
  assert.ok(!out.some((s) => s.includes('精神')), JSON.stringify(out));
});

test('有负面条件时，高精力仍输出一个中性词（不整项消失）', () => {
  // 不能因为压制就让「精力」这一项整个不见 —— 那样她会以为自己没身体。
  const out = circleExtras({ ...base, energy: 95 }, { includeDesire: true, suppressHighEnergy: true });
  assert.ok(out.some((s) => s.startsWith('精力')), JSON.stringify(out));
  assert.ok(out.some((s) => s === '精力：还好'), JSON.stringify(out));
});

test('压制**不影响低精力档位**', () => {
  // 压制只针对「高值夸口」，低值该怎么说还怎么说。
  const sleepy = circleExtras({ ...base, energy: 10 }, { includeDesire: true, suppressHighEnergy: true });
  assert.ok(sleepy.some((s) => s.includes('困')), JSON.stringify(sleepy));

  const tired = circleExtras({ ...base, energy: 30 }, { includeDesire: true, suppressHighEnergy: true });
  assert.ok(tired.some((s) => s.includes('累')), JSON.stringify(tired));
});

test('压制**不改真实数值**（只影响显示）', () => {
  // 这条是给以后的人看的：压制的实现是 `Math.min(e, 84)`，不是改 circle.energy。
  // 如果哪天有人把压制写成"改数值"，下面这个用例会红。
  const before = { ...base, energy: 95 };
  const snapshot = { ...before };
  circleExtras(before, { includeDesire: true, suppressHighEnergy: true });
  assert.deepEqual(before, snapshot, 'circleExtras 不该改入参');
});

test('压制不影响饱腹与第三项', () => {
  const out = circleExtras({ satiety: 10, energy: 95, desire: 90 },
    { includeDesire: true, suppressHighEnergy: true });
  assert.ok(out.some((s) => s.includes('饿')), JSON.stringify(out));
  assert.ok(out.some((s) => s.includes('性欲')), JSON.stringify(out));
});

test('阈值：84 是压制的上界（85 起才叫「精神很好」）', () => {
  // 压制实现是 Math.min(e, 84)，而 energyHigh 的阈值是 v >= 85。
  // 84 落在「还好」（留白），85 才是「精神很好」。
  assert.equal(circleExtras({ ...base, energy: 84 }, { includeDesire: false })
    .some((s) => s.includes('精神')), false);
  assert.equal(circleExtras({ ...base, energy: 85 }, { includeDesire: false })
    .some((s) => s.includes('精神')), true);
});

test('STATUS_TEXT.energyHigh 带「精力：」前缀（这是设计，不是 bug）', () => {
  // 饥饿不带标签（「不饿」已经够明确），精力带标签 ——
  // 光一个「还好」说不清是什么还好。两条规则不一样，别顺手"统一"。
  assert.match(STATUS_TEXT.energyHigh, /^精力：/);
  assert.ok(!STATUS_TEXT.satietyOk.includes('：'), '饥饿不该带标签');
});
