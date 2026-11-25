// 饭点心情 / 正向心情测试（2026-11-24）。
//
// 起因：我们原来只有一堆负面心情（疲惫/虚弱/低落），正向只有"柔和"一个。
// 原作者靠**饭点窗口**提供了柔软/走神/粘人/松散四个中性偏正的词，
// 这里把那套规则钉死。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEAL_MOODS,
  SLEEP_AFTERGLOW_SPEC,
  CYCLE_RECOVERY_SPEC,
  AFTERGLOW_POOL,
  mealMoodAt
} from './life-vitals.js';

const H = 60;   // 分钟
const at = (hh, mm = 0) => hh * H + mm;

// ── ① 五个窗口齐全，且不重叠 ───────────────────────────────────────────────

test('MEAL_MOODS 五个窗口齐全', () => {
  const ids = MEAL_MOODS.map((w) => w.id);
  assert.deepEqual(ids, ['breakfast', 'lunch', 'afternoon', 'dinner', 'late_snack']);
});

test('窗口之间不重叠（重叠会导致同一时刻抽到两条）', () => {
  const sorted = [...MEAL_MOODS].sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].startMin >= sorted[i - 1].endMin,
      `${sorted[i - 1].id} 与 ${sorted[i].id} 重叠了`);
  }
});

test('每个窗口都带心情词，且是中文', () => {
  for (const w of MEAL_MOODS) {
    assert.ok(w.mood, `${w.id} 缺 mood`);
    assert.match(w.mood, /^[\u4e00-\u9fa5]+$/, `${w.id} 的 mood 不是中文：${w.mood}`);
  }
});

test('四个心情词与原作者一致（柔软/走神/粘人/松散）', () => {
  const byId = Object.fromEntries(MEAL_MOODS.map((w) => [w.id, w.mood]));
  assert.equal(byId.breakfast, '柔软');
  assert.equal(byId.lunch, '走神');
  assert.equal(byId.afternoon, '柔软');
  assert.equal(byId.dinner, '粘人');
  assert.equal(byId.late_snack, '松散');
});

// ── ② 必须有正向窗口 ───────────────────────────────────────────────────────

test('至少有一个正向窗口（想吃甜的是馋，不是饿）', () => {
  const positive = MEAL_MOODS.filter((w) => w.energyDelta > 0);
  assert.ok(positive.length >= 1, '一个正向窗口都没有，那就全是负面了');
  assert.equal(positive[0].id, 'afternoon');
  assert.equal(positive[0].sweet, true);
});

// ── ③ 饿了才给 ─────────────────────────────────────────────────────────────

test('mealMoodAt：午饭窗口 + 饿了 → 走神', () => {
  const r = mealMoodAt(at(12), { satiety: 20 });
  assert.equal(r.mood, '走神');
});

test('mealMoodAt：午饭窗口但刚吃完 → 不给（不能刚吃完就说走神）', () => {
  assert.equal(mealMoodAt(at(12), { satiety: 90 }), null);
  assert.equal(mealMoodAt(at(12), { satiety: 60 }), null);
});

test('mealMoodAt：甜食窗口不要求饿（那是馋）', () => {
  const r = mealMoodAt(at(16), { satiety: 95 });
  assert.ok(r, '下午想吃甜的应当随时成立');
  assert.equal(r.mood, '柔软');
});

test('mealMoodAt：窗口外返回 null', () => {
  assert.equal(mealMoodAt(at(3), { satiety: 10 }), null);
  assert.equal(mealMoodAt(at(14), { satiety: 10 }), null);
});

test('mealMoodAt：没传 satiety 时不卡饿的门槛', () => {
  // 拿不到饥饿值时宁可给（信息不全时不要静默吞掉），
  // 否则一次读取失败就整天没有饭点心情。
  const r = mealMoodAt(at(18));
  assert.ok(r);
  assert.equal(r.mood, '粘人');
});

test('mealMoodAt：边界是左闭右开', () => {
  assert.ok(mealMoodAt(at(11, 0), { satiety: 10 }), '11:00 算午饭窗口起点');
  assert.equal(mealMoodAt(at(13, 41), { satiety: 10 }), null, '13:41 出窗口');
});

// ── ④ 正向尾声 ─────────────────────────────────────────────────────────────

test('SLEEP_AFTERGLOW_SPEC 是正向的，mood 为「轻松」', () => {
  assert.ok(SLEEP_AFTERGLOW_SPEC.energyDelta > 0, '睡意回升必须是正的');
  assert.equal(SLEEP_AFTERGLOW_SPEC.mood, '轻松');
});

test('CYCLE_RECOVERY_SPEC 用「松弛」', () => {
  assert.equal(CYCLE_RECOVERY_SPEC.mood, '松弛');
  assert.match(CYCLE_RECOVERY_SPEC.label, /生理期后/);
});

test('病后尾声用「平缓」而不是「迟钝」', () => {
  // 「迟钝」留给"没睡醒反应慢"；病好之后是"整体好转但还虚"。
  assert.equal(AFTERGLOW_POOL.health_relief.mood, '平缓');
});

// ── ⑤ 心情词整体覆盖度 ─────────────────────────────────────────────────────

test('心情词里有正向词，不是清一色负面', () => {
  const positive = new Set([
    ...MEAL_MOODS.filter((w) => w.energyDelta > 0).map((w) => w.mood),
    SLEEP_AFTERGLOW_SPEC.mood,
    CYCLE_RECOVERY_SPEC.mood
  ]);
  for (const need of ['轻松', '松弛']) {
    assert.ok(positive.has(need), `缺正向心情 ${need}`);
  }
});

// ── 饥饿只出一个来源（2026-11-25 修）──────────────────────────────────────
//
// 实测：`【状态】饿了，想吃东西　精力：还好　心情：走神　饿了，想吃东西`
//   前面那个来自 satiety 数值，后面那个来自 meal 的 label —— 同一件事说两遍。
// 按原作者：有饭点判断就用它（更具体），没有才回落到数值档位。

import { circleExtras } from './life-circle.js';

test('有 meal condition 时，不再由 satiety 数值出饥饿词', () => {
  const c = { satiety: 33, energy: 82, desire: 40 };
  const withMeal = circleExtras(c, { includeDesire: true, hasMealCondition: true });
  assert.ok(!withMeal.some((s) => s.includes('饿')), `不该出现饥饿词：${JSON.stringify(withMeal)}`);
  assert.equal(withMeal[0], '精力：还好');
});

test('没有 meal condition 时，回落用数值档位', () => {
  const c = { satiety: 33, energy: 82, desire: 40 };
  const noMeal = circleExtras(c, { includeDesire: true });
  assert.equal(noMeal[0], '有点饿');
});

test('数值更低时同样是「有 meal 就不出」', () => {
  // satiety 10 本来会出「饿了，想吃东西」，有 meal 时也压掉，
  // 因为 meal 的 label 已经在说同一件事。
  const c = { satiety: 10, energy: 82, desire: 40 };
  const withMeal = circleExtras(c, { includeDesire: true, hasMealCondition: true });
  assert.ok(!withMeal.some((s) => s.includes('饿')), JSON.stringify(withMeal));
  // 没 meal 时它照常出
  const noMeal = circleExtras(c, { includeDesire: true });
  assert.equal(noMeal[0], '饿了，想吃东西');
});