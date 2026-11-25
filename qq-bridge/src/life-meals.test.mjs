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

// ── ③ 纯时段判定（2026-11-26 改：饥饿值已删除）─────────────────────────────

test('mealMoodAt：午饭窗口 → 走神', () => {
  const r = mealMoodAt(at(12));
  assert.equal(r.mood, '走神');
});

test('mealMoodAt：**不再看饥饿值**（那个参数已经没有了）', () => {
  // ★ 2026-11-26：连续饥饿值整项删除，mealMoodAt 变成纯时段函数。
  // 原来"刚吃完就不给走神"那条规则随之失效 —— 它依赖一个已经不存在的数值。
  // 替代机制：她真吃过时调 qq_life_circle(ate=true)，饭点 condition 会被清掉。
  const r = mealMoodAt(at(12));
  assert.ok(r, '午饭窗口就该给，不再问"她饿不饿"');
  // 传了多余参数也不该炸（老调用方的兼容）
  assert.ok(mealMoodAt(at(12), { satiety: 90 }), '多余的 satiety 参数被忽略，不影响结果');
});

test('mealMoodAt：甜食窗口（下午）照常给', () => {
  const r = mealMoodAt(at(16));
  assert.ok(r, '下午想吃甜的应当成立');
  assert.equal(r.mood, '柔软');
  assert.equal(r.sweet, true);
});

test('mealMoodAt：窗口外返回 null', () => {
  assert.equal(mealMoodAt(at(3)), null);
  assert.equal(mealMoodAt(at(14)), null);
});

test('mealMoodAt：晚饭窗口给「粘人」', () => {
  const r = mealMoodAt(at(18));
  assert.ok(r);
  assert.equal(r.mood, '粘人');
});

test('mealMoodAt：边界是左闭右开', () => {
  assert.ok(mealMoodAt(at(11, 0)), '11:00 算午饭窗口起点');
  assert.equal(mealMoodAt(at(13, 41)), null, '13:41 出窗口');
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

// ── 饥饿只由一个来源出（2026-11-25 提出，11-26 彻底解决）─────────────────────
//
// 实测过：`【状态】饿了，想吃东西　精力：还好　心情：走神　饿了，想吃东西`
//   前面那个来自 satiety 数值，后面那个来自 meal 的 label —— 同一件事说两遍。
//
// ★ 2026-11-26：**直接删掉数值那一路**，问题从根上没了。
//   现在 circleExtras 里根本没有饥饿项，饥饿只有 meal label 一个来源。

import { circleExtras } from './life-circle.js';

test('circleExtras **永远不出饥饿词**（那件事已经完全交给饭点 condition）', () => {
  const c = { energy: 82, desire: 40 };
  const out = circleExtras(c, { includeDesire: true });
  assert.ok(!out.some((s) => s.includes('饿')), `不该出现饥饿词：${JSON.stringify(out)}`);
  assert.equal(out[0], '精力：还好');
});

test('就算传了旧的 hasMealCondition 参数也不炸（向后兼容）', () => {
  // 老调用方可能还在传；参数被忽略即可，不该抛错、也不该改变输出。
  const c = { energy: 82, desire: 40 };
  const withFlag = circleExtras(c, { includeDesire: true, hasMealCondition: true });
  const without = circleExtras(c, { includeDesire: true });
  assert.deepEqual(withFlag, without, '这个参数已经没有意义了');
});

test('饥饿只由 meal 的 label 表达（端到端语义）', () => {
  // 午饭窗口 → mealMoodAt 给出「饿了，想吃东西」，这才是唤醒词里唯一那句"饿"。
  const spec = mealMoodAt(at(12));
  assert.match(spec.label, /饿/, `午饭窗口的 label 应当提到饿：${spec.label}`);
});