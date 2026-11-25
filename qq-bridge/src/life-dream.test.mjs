// 梦机制测试（2026-11-24 重做后）。
//
// 分两池：
//   NIGHTMARE_POOL - 噩梦，**会唤醒**
//   DREAM_POOL     - 普通梦，**不唤醒**，醒来后才给她看
//
// 权重照原作者 daily_state.py 的 pick —— **两段式**：
//   ① 先掷"今晚有没有事"（0.35 × max(0.2, intensity)，默认 17.5%）
//   ② 掷中了才从 pool[1:] 里均分

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NIGHTMARE_POOL,
  DREAM_POOL,
  AFTERGLOW_POOL,
  pickFromPool,
  pickWithDefault
} from './life-vitals.js';

const alwaysHit = () => 0;      // roll=0，必定 ≤ 阈值
const alwaysMiss = () => 0.999; // roll 极大，必定 > 阈值

// ── ① 两池的形状 ───────────────────────────────────────────────────────────

test('普通梦池：第一条是默认项（没有记住梦，空 label）', () => {
  assert.equal(DREAM_POOL[0].label, '');
  assert.equal(DREAM_POOL[0].energyDelta, 0);
});

test('普通梦池：有正向的梦（不能全是负的）', () => {
  const positive = DREAM_POOL.filter((d) => d.energyDelta > 0);
  assert.ok(positive.length >= 2, `正向梦只有 ${positive.length} 条`);
});

test('噩梦池：没有默认项（每条都该是具体的梦）', () => {
  for (const spec of NIGHTMARE_POOL) {
    assert.ok(spec.label && spec.label.length > 6, `噩梦不该有空 label：${spec.label}`);
  }
});

test('噩梦池：mood 至少四种（原来五条全是"恍惚"）', () => {
  const moods = new Set(NIGHTMARE_POOL.map((s) => s.mood));
  assert.ok(moods.size >= 4, `mood 只有 ${moods.size} 种：${[...moods].join('/')}`);
});

test('噩梦池：覆盖心理学里公认的高频主题', () => {
  // 被追 / 坠落 / 找出口 / 牙齿 / 考试 / 发不出声 / 当众出丑 / 赶不上车
  const all = NIGHTMARE_POOL.map((s) => s.label).join(' ');
  for (const [name, re] of [
    ['被追赶', /追/],
    ['坠落', /掉下去|脚下/],
    ['迷路', /出口|找不到|回到原地/],
    ['牙齿', /牙齿/],
    ['考试', /考试|卷子/],
    ['失声', /发不出声音/],
    ['当众出丑', /一群人面前/],
    ['赶不上', /赶不上的车/],
  ]) {
    assert.match(all, re, `缺少「${name}」这一类`);
  }
});

test('噩梦池：都是负面精力', () => {
  for (const spec of NIGHTMARE_POOL) {
    assert.ok(spec.energyDelta < 0, `${spec.label} 应当扣精力`);
  }
});

test('梦池的 mood 都是中文', () => {
  for (const spec of [...NIGHTMARE_POOL, ...DREAM_POOL]) {
    if (!spec.mood) continue;
    assert.match(spec.mood, /^[\u4e00-\u9fa5]+$/, `${spec.mood} 不是中文`);
  }
});

// ── ② 两段式抽取 ───────────────────────────────────────────────────────────

test('pickWithDefault：roll 超过阈值 → 返回默认项', () => {
  const r = pickWithDefault(DREAM_POOL, { rand: alwaysMiss });
  assert.equal(r.isDefault, true);
  assert.equal(r.spec.label, '');
});

test('pickWithDefault：roll 低于阈值 → 从特殊项里抽', () => {
  const r = pickWithDefault(DREAM_POOL, { rand: alwaysHit });
  assert.equal(r.isDefault, false);
  assert.ok(r.spec.label, '特殊项必须有内容');
});

test('pickWithDefault：默认阈值是 0.35 × 0.5 = 0.175', () => {
  const r = pickWithDefault(DREAM_POOL, { rand: alwaysHit });
  assert.ok(Math.abs(r.threshold - 0.175) < 1e-9, `阈值 ${r.threshold}`);
});

test('pickWithDefault：intensity 缩放阈值，但有 0.2 的下限', () => {
  // intensity=1.0 → 0.35
  assert.ok(Math.abs(pickWithDefault(DREAM_POOL, { intensity: 1, rand: alwaysHit }).threshold - 0.35) < 1e-9);
  // intensity=0.1 → 0.35 × max(0.2, 0.1) = 0.07（不是 0.035）
  assert.ok(Math.abs(pickWithDefault(DREAM_POOL, { intensity: 0.1, rand: alwaysHit }).threshold - 0.07) < 1e-9);
});

test('pickWithDefault：特殊项是均分的（原作者没有逐条权重）', () => {
  const rest = DREAM_POOL.length - 1;
  const seen = new Map();
  for (let i = 0; i < 3000; i += 1) {
    // 第一次 roll 必定命中（0），第二次 roll 用序列扫
    let call = 0;
    const rnd = () => (call++ === 0 ? 0 : i / 3000);
    const r = pickWithDefault(DREAM_POOL, { rand: rnd });
    seen.set(r.spec.label, (seen.get(r.spec.label) || 0) + 1);
  }
  assert.equal(seen.size, rest, `应当能抽到全部 ${rest} 条特殊项`);
});

test('pickWithDefault：空池/单元素池不崩', () => {
  assert.equal(pickWithDefault([]).spec, null);
  const single = pickWithDefault([{ label: 'only' }], { rand: alwaysHit });
  assert.equal(single.isDefault, true, '只有一个元素时只能返回它');
});

test('pickFromPool：仍然是均分（旧接口保留给 care_warmth 用）', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const p = pickFromPool(NIGHTMARE_POOL);
    if (p) seen.add(p.label);
  }
  assert.equal(seen.size, NIGHTMARE_POOL.length);
});

// ── ③ 两池不能混 ───────────────────────────────────────────────────────────

test('噩梦不是恢复尾声（独立 kind，不能被 dedupeByKind 吞掉）', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(AFTERGLOW_POOL, 'nightmare'));
});

test('噩梦池与普通梦池没有重复条目', () => {
  const a = new Set(NIGHTMARE_POOL.map((s) => s.label));
  for (const spec of DREAM_POOL) {
    if (!spec.label) continue;
    assert.ok(!a.has(spec.label), `两池重复：${spec.label}`);
  }
});

// ── ④ 一晚概率 ─────────────────────────────────────────────────────────────

test('一晚 16 次检查里，"记住梦"的概率约 95%（含"没有记住梦"那次）', () => {
  // 注意：这里算的是"掷中特殊项至少一次"。
  // 但真正的语义是：掷中才有一条具体的梦；没掷中就是"没记住梦"（空）。
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let anyDream = 0;
  const TRIALS = 3000;
  for (let t = 0; t < TRIALS; t += 1) {
    let got = false;
    for (let k = 0; k < 16; k += 1) {
      const r = pickWithDefault(DREAM_POOL, { rand: rnd });
      if (!r.isDefault && r.spec.label) { got = true; break; }
    }
    if (got) anyDream += 1;
  }
  const ratio = anyDream / TRIALS;
  // 1-(1-0.175)^16 ≈ 0.953
  assert.ok(ratio > 0.90 && ratio < 0.99, `实测 ${(ratio * 100).toFixed(0)}%`);
});
