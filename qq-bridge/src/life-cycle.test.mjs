// life-cycle.js 单元测试：纯离线。
//   node --test src/life-cycle.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CYCLE_DAYS,
  MIN_CYCLE_DAYS,
  MAX_CYCLE_DAYS,
  PERIOD_ONE_DAY_PROB,
  PMS_LEAD_DAYS,
  PHASE_ENERGY_MEDIAN,
  DISCOMFORT_SPECS,
  floorDay,
  periodLengthFor,
  cycleAt,
  phaseAt,
  phaseEffect,
  rollDiscomfort,
  normalizeAnchor
} from './life-cycle.js';

const DAY = 86400000;
const D = (s) => Date.parse(`${s}T00:00:00Z`);
const ANCHOR = D('2026-11-01');

test('periodLengthFor：只返回 1 或 2', () => {
  for (let i = 0; i < 200; i += 1) {
    const n = periodLengthFor(ANCHOR + i * DAY);
    assert.ok(n === 1 || n === 2, `越界：${n}`);
  }
});

test('periodLengthFor：同一天永远同一个答案（不能用 Math.random）', () => {
  for (const d of ['2026-11-01', '2026-11-14', '2027-03-05']) {
    const a = periodLengthFor(D(d));
    const b = periodLengthFor(D(d));
    assert.equal(a, b, `${d} 两次结果不同`);
  }
});

test('periodLengthFor：大量样本里 1 天的比例接近 0.6', () => {
  let ones = 0;
  const n = 4000;
  for (let i = 0; i < n; i += 1) if (periodLengthFor(ANCHOR + i * DAY) === 1) ones += 1;
  const ratio = ones / n;
  assert.ok(Math.abs(ratio - PERIOD_ONE_DAY_PROB) < 0.05, `实际 ${ratio.toFixed(3)}`);
});

test('cycleAt：第 1 天正确', () => {
  const r = cycleAt(ANCHOR, ANCHOR, 28);
  assert.equal(r.dayInCycle, 1);
  assert.equal(r.cycleStart, ANCHOR);
});

test('cycleAt：跨轮正确推进', () => {
  // 第 29 天应当是新一轮的第 1 天
  const r = cycleAt(ANCHOR, ANCHOR + 28 * DAY, 28);
  assert.equal(r.dayInCycle, 1);
  assert.equal(r.cycleIndex, 1);
});

test('cycleAt：anchor 很久以前也不会卡在第 1 天', () => {
  // 90 天没更新
  const r = cycleAt(ANCHOR, ANCHOR + 90 * DAY, 28);
  assert.ok(r.dayInCycle >= 1 && r.dayInCycle <= 28, `dayInCycle=${r.dayInCycle}`);
  assert.equal(r.cycleIndex, Math.floor(90 / 28));
});

test('cycleAt：周期长度被夹在 21~35', () => {
  assert.ok(cycleAt(ANCHOR, ANCHOR + 30 * DAY, 5).dayInCycle >= 1);
  const tooLong = cycleAt(ANCHOR, ANCHOR + 30 * DAY, 999);
  assert.ok(tooLong.dayInCycle >= 1);
});

test('phaseAt：没有 anchor 时返回 none（不编一个第 1 天）', () => {
  const p = phaseAt(0, ANCHOR, 28);
  assert.equal(p.phase, 'none');
  assert.equal(phaseEffect(p).show, false);
});

test('phaseAt：六期序列正确（2026-11-24 从四期改六期）', () => {
  const at = (d) => phaseAt(ANCHOR, ANCHOR + (d - 1) * DAY, 28).phase;
  assert.equal(at(1), 'menstrual');
  assert.equal(at(6), 'follicular');
  assert.equal(at(13), 'pre_ovulation');
  assert.equal(at(15), 'ovulation');
  assert.equal(at(20), 'luteal');
  assert.equal(at(26), 'pms');
});

test('phaseAt：一个完整周期里必然出现全部六期', () => {
  const seen = new Set();
  for (let i = 0; i < 28; i += 1) seen.add(phaseAt(ANCHOR, ANCHOR + i * DAY, 28).phase);
  for (const need of ['menstrual', 'follicular', 'pre_ovulation', 'ovulation', 'luteal', 'pms']) {
    assert.ok(seen.has(need), `缺阶段 ${need}，实际 ${[...seen].join(',')}`);
  }
});

test('phaseAt：only menstrual 算"经期"，pms 不算', () => {
  // 桥接用它决定要不要压掉第三项：pms 时人还在，只是烦躁，照常显示。
  assert.equal(phaseAt(ANCHOR, ANCHOR, 28).phase, 'menstrual');
  assert.equal(phaseAt(ANCHOR, ANCHOR + 23 * DAY, 28).phase, 'pms');
});

test('精力中位数：必须先升后降（luteal 是正的，别改回负数）', () => {
  const med = {
    menstrual: -12, follicular: 0, pre_ovulation: 8,
    ovulation: 9, luteal: 5, pms: -8
  };
  for (const [phase, want] of Object.entries(med)) {
    assert.equal(PHASE_ENERGY_MEDIAN[phase], want, `${phase} 中位数应为 ${want}`);
  }
  // 关键：黄体期是 +5 不是负数 —— 真正难受的是末尾的 pms。
  assert.ok(PHASE_ENERGY_MEDIAN.luteal > 0, 'luteal 不该为负');
  assert.ok(PHASE_ENERGY_MEDIAN.ovulation > PHASE_ENERGY_MEDIAN.pre_ovulation, '排卵期应当最高');
});

test('phaseEffect：经期最累，且要显示；note 必须写出"表现"', () => {
  const e = phaseEffect({ phase: 'menstrual' });
  assert.ok(e.energyDelta < 0);
  assert.equal(e.show, true);
  assert.ok(e.note.length > 4, `note 太短：${e.note}`);
  // 2026-11-24：文案改成原作者那种说明式口吻（「处于月经期，身体更容易疲倦…」）。
  // 断言跟着钉**当前文案里承载"表现"的那部分**，不要再钉第一人称短句。
  assert.ok(/疲倦|敏锐|累|难受/.test(e.note), `note 缺少表现：${e.note}`);
});

test('phaseEffect：PMS 要显示，但措辞和经期不同', () => {
  const e = phaseEffect({ phase: 'pms' });
  assert.equal(e.show, true);
  assert.match(e.note, /PMS/);
  assert.notEqual(e.note, phaseEffect({ phase: 'menstrual' }).note);
});

test('phaseEffect：文案可覆盖', () => {
  const e = phaseEffect({ phase: 'menstrual' }, { text: { cycleLabel: 'L', cyclePeriod: 'P' } });
  assert.equal(e.label, 'L');
  assert.equal(e.note, 'P');
});

test('phaseEffect：只有 menstrual / pms 显示，其余都不显示', () => {
  for (const p of ['follicular', 'pre_ovulation', 'ovulation', 'luteal', 'none']) {
    assert.equal(phaseEffect({ phase: p }).show, false, `${p} 不该显示`);
  }
});

test('phaseEffect：排卵前后精力为正', () => {
  assert.ok(phaseEffect({ phase: 'ovulation' }).energyDelta > 0);
  assert.ok(phaseEffect({ phase: 'pre_ovulation' }).energyDelta > 0);
});

test('rollDiscomfort：同一天不重掷', () => {
  const r = rollDiscomfort({ phase: 'menstrual', todayKey: '2026-11-24', lastRollKey: '2026-11-24', rand: () => 0 });
  assert.equal(r.roll, false);
  assert.equal(r.reason, 'already-rolled-today');
});

test('rollDiscomfort：已有活跃不适时不掷', () => {
  const r = rollDiscomfort({ phase: 'menstrual', todayKey: '2026-11-24', hasActive: true, rand: () => 0 });
  assert.equal(r.roll, false);
  assert.equal(r.reason, 'already-active');
});

test('rollDiscomfort：不允的期不消耗当天机会', () => {
  // follicular 没有任何不适候选 → 不掷，也不该记"今天掷过了"
  const r = rollDiscomfort({ phase: 'follicular', todayKey: '2026-11-24', rand: () => 0 });
  assert.equal(r.roll, false);
  assert.equal(r.reason, 'no-candidate');
});

test('rollDiscomfort：命中时按权重抽，且只在该期允许的类型里', () => {
  const r = rollDiscomfort({ phase: 'menstrual', todayKey: '2026-11-24', rand: () => 0.99 });
  assert.equal(r.roll, true);
  if (r.type) {
    assert.ok(DISCOMFORT_SPECS[r.type].phases.includes('menstrual'), `${r.type} 不该出现在月经期`);
  }
});

test('rollDiscomfort：chance=0 永不命中', () => {
  for (let i = 0; i < 20; i += 1) {
    const r = rollDiscomfort({ phase: 'menstrual', todayKey: 'd', chance: 0, rand: Math.random });
    assert.equal(r.type, null);
  }
});

test('DISCOMFORT_SPECS：六种齐全且权重合理', () => {
  const names = Object.keys(DISCOMFORT_SPECS);
  assert.equal(names.length, 6);
  // 痛经和乏力权重最高（最常见的两种）
  assert.equal(DISCOMFORT_SPECS['痛经'].weight, 4);
  assert.equal(DISCOMFORT_SPECS['乏力'].weight, 4);
  assert.equal(DISCOMFORT_SPECS['恶心'].weight, 1);
  for (const [name, spec] of Object.entries(DISCOMFORT_SPECS)) {
    assert.ok(Array.isArray(spec.phases) && spec.phases.length, `${name} 缺 phases`);
    assert.ok(spec.energyDelta < 0, `${name} 应当扣精力`);
  }
});
test('normalizeAnchor：把 anchor 推进到最近一轮', () => {
  const r = normalizeAnchor(ANCHOR, ANCHOR + 90 * DAY, 28);
  assert.equal(r.changed, true);
  assert.ok(r.anchorDay > ANCHOR);
  assert.ok(r.anchorDay <= ANCHOR + 90 * DAY);
  // 推进后算出来的天数应当在 1~28
  const p = phaseAt(r.anchorDay, ANCHOR + 90 * DAY, 28);
  assert.ok(p.dayInCycle >= 1 && p.dayInCycle <= 28);
});

test('normalizeAnchor：anchor 为 0 时保持 0', () => {
  assert.deepEqual(normalizeAnchor(0, ANCHOR, 28), { anchorDay: 0, changed: false });
});

test('floorDay：把时刻落到当天 0 点', () => {
  const noon = Date.parse('2026-11-23T12:34:56+08:00');
  const floored = floorDay(noon, 'Asia/Shanghai');
  assert.equal(floored, Date.UTC(2026, 10, 23));
  // 同一天的不同时刻落到同一个值
  const early = Date.parse('2026-11-23T00:00:01+08:00');
  assert.equal(floorDay(early, 'Asia/Shanghai'), floored);
});

test('floorDay：跨时区按目标时区的日历日算', () => {
  // UTC 的 11-23T17:00 = 北京时间 11-24 01:00
  const t = Date.parse('2026-11-23T17:00:00Z');
  assert.equal(floorDay(t, 'Asia/Shanghai'), Date.UTC(2026, 10, 24));
  assert.equal(floorDay(t, 'UTC'), Date.UTC(2026, 10, 23));
});

test('常量：默认 28 天，范围 21~35', () => {
  assert.equal(DEFAULT_CYCLE_DAYS, 28);
  assert.equal(MIN_CYCLE_DAYS, 21);
  assert.equal(MAX_CYCLE_DAYS, 35);
});