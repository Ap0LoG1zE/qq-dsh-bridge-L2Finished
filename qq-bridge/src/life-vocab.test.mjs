// 词表一致性测试（2026-11-24）。
//
// 这个文件的存在原因很具体：改六期时 `isPeriodPhaseV2()` 漏改阶段名，
// 导致「经期抑制性欲」从那天起失效，而**当时没有任何测试会红**。
// 所以这里把几类"改名/换词会静默漂移"的地方全部钉死。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CYCLE_PHASES,
  PHASE_ENERGY_MEDIAN,
  DISCOMFORT_SPECS,
  phaseAt,
  phaseEffect
} from './life-cycle.js';
import { SLEEP_POOL, HEALTH_POOL, CARE_POOL, AFTERGLOW_POOL } from './life-vitals.js';

const DAY = 86400000;
const D = (s) => Date.parse(`${s}T00:00:00Z`);
const ANCHOR = D('2026-11-01');

// ── ① 阶段名纪律：所有比较都必须用 CYCLE_PHASES 里的值 ──────────────────────

test('CYCLE_PHASES 的六期名与 phaseAt 实际返回的名字完全一致', () => {
  const seen = new Set();
  for (let i = 0; i < 28; i += 1) seen.add(phaseAt(ANCHOR, ANCHOR + i * DAY, 28).phase);
  for (const p of seen) {
    assert.ok(CYCLE_PHASES.includes(p), `phaseAt 返回了 CYCLE_PHASES 里没有的阶段名：${p}`);
  }
  for (const p of CYCLE_PHASES) {
    assert.ok(seen.has(p), `CYCLE_PHASES 声明了 ${p}，但一个周期里从未出现`);
  }
});

test('旧的阶段名 period 不再被当作经期（这条锁住过一次真 bug）', () => {
  // 改六期时把 menstrual 写成 period 的漏改，让"经期抑制性欲"静默失效。
  // 这个断言的作用是：任何人再想用 'period' 表示经期，都会立刻红。
  assert.ok(!CYCLE_PHASES.includes('period'), '经期阶段名是 menstrual，不是 period');
  assert.equal(phaseAt(ANCHOR, ANCHOR, 28).phase, 'menstrual');
});

test('阶段名里不能出现中文或大驼峰（防止有人手滑写成 月经期）', () => {
  for (const p of CYCLE_PHASES) {
    assert.match(p, /^[a-z_]+$/, `阶段名必须是 snake_case：${p}`);
  }
});

// ── ② 心情词纪律：必须是中文感受词 ──────────────────────────────────────────

test('所有 mood 都必须是中文（不能残留英文常量）', () => {
  const all = [
    ...SLEEP_POOL.map((x) => x.mood),
    ...HEALTH_POOL.map((x) => x.mood),
    ...CARE_POOL.map((x) => x.mood),
    ...Object.values(AFTERGLOW_POOL).map((x) => x.mood),
    ...Object.values(DISCOMFORT_SPECS).map((x) => x.mood),
    ...CYCLE_PHASES.map((p) => phaseEffect({ phase: p }).mood)
  ].filter(Boolean);
  for (const m of all) {
    assert.match(m, /^[\u4e00-\u9fa5]+$/, `mood 必须是中文感受词，实际：${m}`);
  }
});

test('mood 里不能出现纯生理描述词', () => {
  // 2026-11-24 操作者拍板：**「迟钝」可以留** —— 它是"没睡醒那种反应慢"，
  // 在轻小说语感里是成立的，读者不会觉得别扭。
  // 但「困倦」仍是纯生理描述（困就是困，不是心情），不放 mood。
  const banned = ['困倦'];
  const all = [
    ...SLEEP_POOL.map((x) => x.mood),
    ...HEALTH_POOL.map((x) => x.mood),
    ...CARE_POOL.map((x) => x.mood),
    ...Object.values(AFTERGLOW_POOL).map((x) => x.mood),
    ...Object.values(DISCOMFORT_SPECS).map((x) => x.mood),
    ...CYCLE_PHASES.map((p) => phaseEffect({ phase: p }).mood)
  ].filter(Boolean);
  for (const m of all) {
    assert.ok(!banned.includes(m), `「${m}」是状态描述不是心情，别放进 mood`);
  }
});

test('睡得浅会带「迟钝」（操作者认可这个语感）', () => {
  // 2026-11-24 操作者拍板：迟钝可以留 —— 是"没睡醒那种反应慢"，
  // 不是描述脑子笨。但默认那条「睡得还行」不该带 mood（平淡不出声）。
  const shallow = SLEEP_POOL.find((x) => /浅/.test(x.label));
  assert.ok(shallow, '找不到"睡得浅"那条');
  assert.equal(shallow.mood, '迟钝');
  assert.equal(SLEEP_POOL[0].mood, '', '平淡项不该有 mood');
});

// ── ③ 周期文案：原作者口吻 ─────────────────────────────────────────────────

test('经期文案用说明式口吻（照 AstrBot 那套）', () => {
  const e = phaseEffect({ phase: 'menstrual' });
  assert.match(e.note, /处于月经期/, `应当照原作者口吻，实际：${e.note}`);
  assert.match(e.note, /疲倦|敏锐/, '应当写出具体感受');
});

test('PMS 文案同样用说明式', () => {
  const e = phaseEffect({ phase: 'pms' });
  assert.match(e.note, /PMS/, `实际：${e.note}`);
});

test('经期与 PMS 的 mood 都是"敏感"（同一档情绪）', () => {
  assert.equal(phaseEffect({ phase: 'menstrual' }).mood, phaseEffect({ phase: 'pms' }).mood);
});

// ── ④ 精力中位数：六个期都必须有定义 ───────────────────────────────────────

test('每个阶段都有精力中位数（缺一个会静默变成 0）', () => {
  for (const p of CYCLE_PHASES) {
    assert.equal(typeof PHASE_ENERGY_MEDIAN[p], 'number', `缺 ${p} 的中位数`);
    assert.ok(Number.isFinite(PHASE_ENERGY_MEDIAN[p]));
  }
});

test('只有 menstrual 和 pms 是中位数负的（其余阶段不该低于 0）', () => {
  for (const p of CYCLE_PHASES) {
    if (p === 'menstrual' || p === 'pms') {
      assert.ok(PHASE_ENERGY_MEDIAN[p] < 0, `${p} 应当为负`);
    } else {
      assert.ok(PHASE_ENERGY_MEDIAN[p] >= 0, `${p} 不该为负（真实情况是人没那么难受）`);
    }
  }
});

// ── ⑤ 不适类型：phases 必须引用合法阶段名 ──────────────────────────────────

test('DISCOMFORT_SPECS 的 phases 只能引用 CYCLE_PHASES 里的名字', () => {
  for (const [name, spec] of Object.entries(DISCOMFORT_SPECS)) {
    for (const p of spec.phases) {
      assert.ok(CYCLE_PHASES.includes(p), `${name} 引用了非法阶段名：${p}`);
    }
  }
});

test('DISCOMFORT_SPECS 每条都有完整字段', () => {
  for (const [name, spec] of Object.entries(DISCOMFORT_SPECS)) {
    assert.ok(spec.label && spec.label.length > 4, `${name} 缺 label`);
    assert.ok(spec.mood, `${name} 缺 mood`);
    assert.ok(spec.energyDelta < 0, `${name} 应当扣精力`);
    assert.ok(spec.durationHours > 0, `${name} 缺时长`);
    assert.ok(spec.weight > 0, `${name} 缺权重`);
  }
});

// ── ⑥ 尾声不能反向描述 ─────────────────────────────────────────────────────

test('sleep_rebound 的文案不断言睡得深还是浅', () => {
  // 它由"睡得浅"触发，如果写成"睡得太沉了"就自相矛盾。
  const spec = AFTERGLOW_POOL.sleep_rebound;
  assert.ok(!/太沉|很沉/.test(spec.label), `不能断言睡得沉：${spec.label}`);
  assert.ok(!/太浅|很浅/.test(spec.label), `也不能断言睡得浅：${spec.label}`);
});

test('尾声的 mood 要么为空要么是感受词', () => {
  for (const [kind, spec] of Object.entries(AFTERGLOW_POOL)) {
    if (spec.mood) {
      assert.match(spec.mood, /^[\u4e00-\u9fa5]+$/, `${kind} 的 mood 不是中文：${spec.mood}`);
    }
  }
});
