// life-circle.js 单元测试：纯离线。
//   node --test src/life-circle.test.mjs
//
// 重点覆盖**容易改坏**的四件事：
//   ① 衰减方向与速率；② 睡眠只认她自己的标记 + 关机，不看钟点；
//   ③ 恢复只认"一夜"；④ 饱腹照常掉（睡着也消化）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VALUES,
  ADD_LIMITS,
  DEFAULT_OFFLINE_AS_SLEEP_MS,
  settleCircle,
  addToCircle,
  normalizeCircle,
  circleExtras,
  describeCircle,
  defaultCircle
} from './life-circle.js';

const HOUR = 3600000;
const AWAKE = new Date('2026-11-23T15:00:00+08:00').getTime();

const makeCircle = (over = {}) => ({
  v: 1,
  ...DEFAULT_VALUES,
  lastTickedAt: AWAKE,
  ...over
});

test('settleCircle：饱腹/精力掉，第三项涨（方向相反）', () => {
  const c = makeCircle({ satiety: 80, energy: 80, desire: 40 });
  const after = settleCircle(c, AWAKE + 4 * HOUR);
  assert.ok(after.satiety < 80, '饱腹应当下降');
  assert.ok(after.energy < 80, '醒着精力应当下降');
  assert.ok(after.desire > 40, 'xingyu 是累积方向，应当上涨');
  // 4 小时 × 13.0 = 52
  assert.equal(Math.round(after.satiety), 28);
  // 4 小时 × 1.2 = 4.8
  assert.equal(Math.round(after.desire), 45);
});

test('settleCircle：**通宵不睡不会涨精力**（这个 bug 已经修过，别再放回来）', () => {
  // 凌晨 3 点还醒着 —— 旧实现会"到点就算睡着"，精力涨到 100。
  const start = new Date('2026-11-23T22:30:00+08:00').getTime();
  const c = { v: 1, satiety: 50, energy: 50, desire: 50, lastTickedAt: start, asleep: false };
  const after = settleCircle(c, new Date('2026-11-24T05:00:00+08:00').getTime());
  assert.ok(after.energy < 50, `通宵应当掉精力，实际 ${after.energy}`);
});

test('settleCircle：她自己说睡了 → 精力回升', () => {
  const start = new Date('2026-11-23T23:00:00+08:00').getTime();
  const c = { v: 1, satiety: 50, energy: 30, desire: 40, lastTickedAt: start, asleep: true };
  const after = settleCircle(c, start + 4 * HOUR);
  assert.equal(Math.round(after.energy), 62, '4 小时 × 8 = +32');
  // 睡觉也要消化
  assert.ok(after.satiety < 50, '睡着也应当掉饱腹');
});

test('settleCircle：没说自己睡，就算在夜里也不回血', () => {
  const start = new Date('2026-11-23T23:00:00+08:00').getTime();
  const c = { v: 1, satiety: 50, energy: 30, desire: 40, lastTickedAt: start };
  const after = settleCircle(c, start + 4 * HOUR);
  assert.ok(after.energy < 30, `不该凭空回血，实际 ${after.energy}`);
});

test('settleCircle：关机（离线超阈值）按休息算，精力回升', () => {
  const start = new Date('2026-11-20T22:30:00+08:00').getTime();
  const c = { v: 1, satiety: 60, energy: 20, desire: 40, lastTickedAt: start };
  // 离线 9 小时（超过 3 小时阈值）
  const after = settleCircle(c, start + 9 * HOUR, { gapMs: 9 * HOUR });
  assert.ok(after.energy > 20, `关机期间应当算休息，实际 ${after.energy}`);
});

test('settleCircle：离线但没超阈值，不算睡觉', () => {
  const start = new Date('2026-11-23T14:00:00+08:00').getTime();
  const c = { v: 1, satiety: 60, energy: 60, desire: 40, lastTickedAt: start };
  // 只过了 1 小时
  const after = settleCircle(c, start + HOUR, { gapMs: HOUR });
  assert.ok(after.energy < 60, `一小时空档不该算睡觉，实际 ${after.energy}`);
});

test('settleCircle：恢复只认一夜（关机一个月不会凭空满血）', () => {
  const start = new Date('2026-11-01T22:30:00+08:00').getTime();
  const end = start + 30 * 24 * HOUR;
  const c = { v: 1, satiety: 100, energy: 100, desire: 100, lastTickedAt: start };
  const after = settleCircle(c, end, { gapMs: 30 * 24 * HOUR });
  assert.ok(after.energy <= 100);
  assert.equal(Math.round(after.satiety), 0, '一个月不吃，饱腹必然贴底');
  // ⚠️ desire 是**累积**方向，和饱腹相反：关机一个月不接触 → 累积到顶，
  //    不是贴底。别照着饱腹的直觉改这条断言。
  assert.equal(Math.round(after.desire), 100, '一个月不管，xingyu 必然累积到顶');
});

test('settleCircle：时钟回拨不结算', () => {
  const c = makeCircle({ satiety: 50, energy: 50, desire: 50 });
  const after = settleCircle(c, AWAKE - 5 * HOUR);
  assert.equal(after.satiety, 50);
  assert.equal(after.lastTickedAt, AWAKE - 5 * HOUR, '时间戳要对齐，否则会反复重算');
});

test('settleCircle：不改入参', () => {
  const c = makeCircle({ satiety: 80 });
  const snapshot = { ...c };
  settleCircle(c, AWAKE + 6 * HOUR);
  assert.deepEqual(c, snapshot);
});

test('addToCircle：先结算再加（离线后说刚吃完，数字对得上）', () => {
  const c = makeCircle({ satiety: 80 });
  const settledOnly = settleCircle(c, AWAKE + 10 * HOUR);
  const after = addToCircle(c, { satiety: 40 }, AWAKE + 10 * HOUR);
  const expected = Math.min(100, settledOnly.satiety + 40);
  assert.equal(Math.round(after.satiety), Math.round(expected));
});

test('addToCircle：能切换睡眠标记', () => {
  const c = makeCircle({ energy: 60 });
  const sleeping = addToCircle(c, {}, AWAKE + 60000, { asleep: true });
  assert.equal(sleeping.asleep, true);
  const woke = addToCircle(sleeping, {}, AWAKE + 120000, { asleep: false });
  assert.equal(woke.asleep, false);
  // 不传就保持原状
  const stay = addToCircle({ ...c, asleep: true }, {}, AWAKE + 180000);
  assert.equal(stay.asleep, true);
});

test('addToCircle：单次上限生效，负数被当 0', () => {
  const c = makeCircle({ satiety: 10, energy: 10, desire: 10 });
  const after = addToCircle(c, { satiety: 999, energy: -50, desire: -1 }, AWAKE + 60000);
  assert.ok(after.satiety <= 10 + ADD_LIMITS.satiety.max + 1);
  assert.ok(after.energy >= 9 && after.energy <= 10, `energy=${after.energy}`);
});

test('normalizeCircle：脏数据被修好而不是崩掉', () => {
  assert.equal(normalizeCircle(null).satiety, DEFAULT_VALUES.satiety);
  assert.equal(normalizeCircle({ satiety: 'abc' }).satiety, DEFAULT_VALUES.satiety);
  assert.equal(normalizeCircle({ satiety: 999 }).satiety, 100);
  assert.equal(normalizeCircle({ satiety: -5 }).satiety, 0);
  assert.equal(normalizeCircle({ asleep: 'yes' }).asleep, false, '非 true 一律当没在睡');
  assert.ok(normalizeCircle({}).lastTickedAt > 0);
});

test('一天完整曲线：每顿前都饿，饭后饱，醒来饿', () => {
  const T = (s) => new Date(s).getTime();
  let c = defaultCircle(T('2026-11-23T07:30:00+08:00'));
  const adv = (iso, add, opts) => {
    const t = T(iso);
    c = settleCircle(c, t, opts);
    // opts 里的 asleep 也要能单独生效（add 为 null 时只切睡眠、不加值）。
    if (add || opts?.asleep !== undefined) c = addToCircle(c, add, t, opts);
  };
  adv('2026-11-23T08:00:00+08:00', { satiety: 70 });
  assert.ok(c.satiety >= 99, `早饭吃到满，实际 ${c.satiety}`);
  adv('2026-11-23T12:30:00+08:00');
  assert.ok(c.satiety < 50, `午饭前应当饿，实际 ${c.satiety}`);
  adv('2026-11-23T12:40:00+08:00', { satiety: 70 });
  adv('2026-11-23T18:30:00+08:00');
  assert.ok(c.satiety < 50, `晚饭前应当饿，实际 ${c.satiety}`);
  adv('2026-11-23T18:40:00+08:00', { satiety: 70 });
  // 22:30 说睡了，睡到 07:30
  adv('2026-11-23T22:30:00+08:00', null, { asleep: true });
  adv('2026-11-24T07:30:00+08:00');
  assert.ok(c.satiety < 20, `一夜之后应当饿，实际 ${c.satiety}`);
  assert.ok(c.energy > 85, `睡一夜精力应当很足，实际 ${c.energy}`);
  const words = circleExtras(c);
  assert.ok(words.some((s) => s.includes('饿')), `醒来应当贴「饿」，实际 ${JSON.stringify(words)}`);
});
test('circleExtras：饥饿和精力恒在；精力带「精力：」前缀，饥饿不带', () => {
  // 2026-11-23（操作者要求）：饥饿不要前缀，精力保留「精力：」——
  // 「还好」单独一个词说不清是什么还好。
  const out = circleExtras(defaultCircle(AWAKE));
  assert.equal(out.length, 2, `应当恒有两项：${JSON.stringify(out)}`);
  assert.ok(!out[0].includes('：'), `饥饿不该有标签：${out[0]}`);
  assert.ok(out[1].startsWith('精力：'), `精力应带前缀：${out[1]}`);
});

test('circleExtras：低值给具体说法，正常档给中性词', () => {
  const low = circleExtras({ satiety: 10, energy: 10, desire: 10 });
  assert.equal(low.length, 2);
  assert.ok(/饿/.test(low[0]), JSON.stringify(low));
  assert.ok(/困/.test(low[1]), JSON.stringify(low));

  const ok = circleExtras({ satiety: 80, energy: 70, desire: 30 });
  assert.equal(ok.length, 2, '正常档也不能整项消失（否则她以为自己没身体）');
  // ⚠️ 别用 /饿/ 断言 —— 「不饿」里也有个饿字，宽匹配会漏掉真正的 bug。
  assert.equal(ok[0], '不饿');
  assert.equal(ok[1], '精力：还好');
});

test('circleExtras：精力最低一档时**不显示第三项**（和经期抑制同理）', () => {
  // 人都困到不行了还"性欲高涨"是自相矛盾的，两个标记会打架。
  const sleepy = circleExtras({ satiety: 80, energy: 10, desire: 95 }, { includeDesire: true });
  assert.equal(sleepy.length, 2, `精力最低档不该显示第三项：${JSON.stringify(sleepy)}`);
  // 精力刚过线就恢复显示
  const rested = circleExtras({ satiety: 80, energy: 25, desire: 95 }, { includeDesire: true });
  assert.equal(rested.length, 3, JSON.stringify(rested));
});

test('circleExtras：第三项默认完全隐形，必须显式开启', () => {
  // 0~79 一律不露；80 起才露。而且**只有 includeDesire===true** 才可能露。
  for (const v of [0, 50, 79]) {
    const out = circleExtras({ satiety: 80, energy: 60, desire: v }, { includeDesire: true });
    assert.equal(out.length, 2, `desire=${v} 不该出现：${JSON.stringify(out)}`);
  }
  const high = circleExtras({ satiety: 80, energy: 60, desire: 80 }, { includeDesire: true });
  assert.equal(high.length, 3, JSON.stringify(high));
  // 不开启就永远只有两项
  const closed = circleExtras({ satiety: 80, energy: 60, desire: 95 });
  assert.equal(closed.length, 2, JSON.stringify(closed));
});

test('circleExtras：文案可覆盖（换词不用改代码）', () => {
  const out = circleExtras(
    { satiety: 10, energy: 10, desire: 90 },
    { includeDesire: true, text: { satietyLow: '咕咕叫', desireHigh: 'Y', satietyOk: 'Z', energyOk: 'W' } }
  );
  assert.ok(out.includes('咕咕叫'), JSON.stringify(out));
  // 精力 10 是最低档，会被 energyLow 命中；而且能量最低时第三项被抑制 ——
  // 所以这里用高精力验证 desireHigh 能覆盖。
  const withDesire = circleExtras(
    { satiety: 10, energy: 70, desire: 90 },
    { includeDesire: true, text: { desireHigh: 'Y' } }
  );
  assert.ok(withDesire.includes('Y'), JSON.stringify(withDesire));
});

test('describeCircle：**不带任何数字**（2026-11-24 改）', () => {
  // 原来是 `饥饿 15/100（有点饿） · 精力 90/100（正常） · 第三项 50/100（正常）`。
  // 操作者否了：她不需要知道分数，只需要知道"我现在有点饿"。
  // 数字还会让她开始算账（"我 30 分，还能再撑一会儿"），那不像人。
  const text = describeCircle({ satiety: 15, energy: 90, desire: 50 });
  assert.ok(!/\d/.test(text), `不该出现任何数字：${text}`);
  assert.ok(!text.includes('/100'), `不该出现满分制：${text}`);
  assert.ok(!text.includes('第三项'), `「第三项」这种代号也不该给她看：${text}`);
});

test('describeCircle：读起来像一句话，不是字段列表', () => {
  const text = describeCircle({ satiety: 15, energy: 90, desire: 50 });
  assert.match(text, /饿了/, text);
  assert.match(text, /精神很好/, text);
  assert.ok(text.endsWith('。'), `该以句号收尾：${text}`);
});

test('describeCircle：正常档给中性词（不饿 / 还好），不是空', () => {
  const text = describeCircle({ satiety: 70, energy: 61, desire: 3 });
  assert.match(text, /不饿/, text);
  assert.match(text, /精力：还好/, text);
});

test('describeCircle：睡着时说一句', () => {
  const text = describeCircle({ satiety: 70, energy: 61, desire: 3, asleep: true });
  assert.match(text, /正在睡/, text);
});

test('describeCircle：性欲到 80 才提', () => {
  assert.ok(!describeCircle({ satiety: 70, energy: 61, desire: 79 }).includes('性欲'));
  assert.ok(describeCircle({ satiety: 70, energy: 61, desire: 80 }).includes('性欲高涨'));
});

test('defaultCircle：开局不是满血，不是睡着', () => {
  const c = defaultCircle(AWAKE);
  assert.ok(c.energy < 100 && c.satiety < 100);
  assert.equal(c.asleep, false);
});

test('离线阈值是 3 小时', () => {
  assert.equal(DEFAULT_OFFLINE_AS_SLEEP_MS, 3 * HOUR);
});