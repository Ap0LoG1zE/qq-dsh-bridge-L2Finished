// life-circle.js 单元测试：纯离线。
//   node --test src/life-circle.test.mjs
//
// 重点覆盖**容易改坏**的五件事：
//   ① 衰减方向与速率；② 睡眠只认她自己的标记 + 关机，不看钟点；
//   ③ 恢复只认"一夜"；④ asleepSince 不被结算推进（2026-11-26 新增）；
//   ⑤ 饥饿值已删除（v1 → v2 升级时不炸、不复活）。
//
// ⚠️ 2026-11-26：**satiety 整项删除**，相关断言一并移除。
//    现在身体只有两维：energy（掉）与 desire（涨）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VALUES,
  ADD_LIMITS,
  DEFAULT_OFFLINE_AS_SLEEP_MS,
  DECAY_PER_HOUR,
  ENERGY_RECOVER_PER_HOUR,
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
  v: 2,
  ...DEFAULT_VALUES,
  lastTickedAt: AWAKE,
  ...over
});

// ── ① 衰减方向 ──────────────────────────────────────────────────────────────

test('settleCircle：精力掉，第三项涨（方向相反）', () => {
  const c = makeCircle({ energy: 80, desire: 40 });
  const after = settleCircle(c, AWAKE + 4 * HOUR);
  assert.ok(after.energy < 80, '醒着精力应当下降');
  assert.ok(after.desire > 40, 'desire 是累积方向，应当上涨');
  // 4 小时 × 3.0 = 12
  assert.equal(Math.round(after.energy), 68);
  // 4 小时 × 1.2 = 4.8
  assert.equal(Math.round(after.desire), 45);
});

test('settleCircle：**饥饿值已经不存在**（删干净了，别偷偷加回来）', () => {
  const c = makeCircle({ energy: 80, desire: 40 });
  const after = settleCircle(c, AWAKE + 4 * HOUR);
  assert.equal(after.satiety, undefined, 'v2 不该再有 satiety 字段');
  assert.equal(DEFAULT_VALUES.satiety, undefined, 'DEFAULT_VALUES 也不该有');
  assert.equal(ADD_LIMITS.satiety, undefined, 'ADD_LIMITS 也不该有');
});

test('settleCircle：**通宵不睡不会涨精力**（这个 bug 已经修过，别再放回来）', () => {
  // 凌晨 3 点还醒着 —— 旧实现会"到点就算睡着"，精力涨到 100。
  const start = new Date('2026-11-23T22:30:00+08:00').getTime();
  const c = { v: 2, energy: 50, desire: 50, lastTickedAt: start, asleep: false };
  const after = settleCircle(c, new Date('2026-11-24T05:00:00+08:00').getTime());
  assert.ok(after.energy < 50, `通宵应当掉精力，实际 ${after.energy}`);
});

test('settleCircle：她自己说睡了 → 精力回升', () => {
  const start = new Date('2026-11-23T23:00:00+08:00').getTime();
  const c = { v: 2, energy: 30, desire: 40, lastTickedAt: start, asleep: true, asleepSince: start };
  const after = settleCircle(c, start + 4 * HOUR);
  assert.equal(Math.round(after.energy), 62, '4 小时 × 8 = +32');
});

test('settleCircle：没说自己睡，就算在夜里也不回血', () => {
  const start = new Date('2026-11-23T23:00:00+08:00').getTime();
  const c = { v: 2, energy: 30, desire: 40, lastTickedAt: start };
  const after = settleCircle(c, start + 4 * HOUR);
  assert.ok(after.energy < 30, `不该凭空回血，实际 ${after.energy}`);
});

test('settleCircle：关机（离线超阈值）按休息算，精力回升', () => {
  const start = new Date('2026-11-20T22:30:00+08:00').getTime();
  const c = { v: 2, energy: 20, desire: 40, lastTickedAt: start };
  // 离线 9 小时（超过 3 小时阈值）
  const after = settleCircle(c, start + 9 * HOUR, { gapMs: 9 * HOUR });
  assert.ok(after.energy > 20, `关机期间应当算休息，实际 ${after.energy}`);
});

test('settleCircle：离线但没超阈值，不算睡觉', () => {
  const start = new Date('2026-11-23T14:00:00+08:00').getTime();
  const c = { v: 2, energy: 60, desire: 40, lastTickedAt: start };
  // 只过了 1 小时
  const after = settleCircle(c, start + HOUR, { gapMs: HOUR });
  assert.ok(after.energy < 60, `一小时空档不该算睡觉，实际 ${after.energy}`);
});

test('settleCircle：恢复只认一夜（关机一个月不会凭空满血）', () => {
  const start = new Date('2026-11-01T22:30:00+08:00').getTime();
  const end = start + 30 * 24 * HOUR;
  const c = { v: 2, energy: 100, desire: 100, lastTickedAt: start };
  const after = settleCircle(c, end, { gapMs: 30 * 24 * HOUR });
  assert.ok(after.energy <= 100);
  // ⚠️ desire 是**累积**方向，和精力相反：关机一个月不接触 → 累积到顶。
  assert.equal(Math.round(after.desire), 100, '一个月不管，xingyu 必然累积到顶');
});

test('settleCircle：时钟回拨不结算', () => {
  const c = makeCircle({ energy: 50, desire: 50 });
  const after = settleCircle(c, AWAKE - 5 * HOUR);
  assert.equal(after.energy, 50);
  assert.equal(after.lastTickedAt, AWAKE - 5 * HOUR, '时间戳要对齐，否则会反复重算');
});

test('settleCircle：不改入参', () => {
  const c = makeCircle({ energy: 80 });
  const snapshot = { ...c };
  settleCircle(c, AWAKE + 6 * HOUR);
  assert.deepEqual(c, snapshot);
});

// ── ④ asleepSince：结算不许推进它（2026-11-26 的新契约）───────────────────

test('asleepSince：结算**绝不**改它（这是修「自动醒永不触发」的关键）', () => {
  const sleptAt = AWAKE;
  const c = { v: 2, energy: 40, desire: 50, lastTickedAt: sleptAt, asleep: true, asleepSince: sleptAt };
  // 每半小时结算一次，模拟面板轮询 / 每轮唤醒
  let cur = c;
  for (let i = 1; i <= 16; i += 1) {
    cur = settleCircle(cur, sleptAt + i * 0.5 * HOUR, { gapMs: 0.5 * HOUR });
  }
  assert.equal(cur.asleepSince, sleptAt, 'asleepSince 必须还停在入睡那一刻');
  assert.equal(cur.lastTickedAt, sleptAt + 8 * HOUR, 'lastTickedAt 会一路推到最新');
  // 这就是修复的意义：真实睡满 8 小时，从 asleepSince 算得出来。
  assert.equal(Math.round((cur.lastTickedAt - cur.asleepSince) / HOUR), 8);
});

test('asleepSince：从醒到睡那一下才记起点，重复调 asleep=true 不重置', () => {
  const c = makeCircle({ energy: 60 });
  const asleep1 = addToCircle(c, {}, AWAKE + 1000, { asleep: true });
  assert.equal(asleep1.asleepSince, AWAKE + 1000);
  // 一小时后又说了一次"我要睡了" —— 不该把起点往后推
  const asleep2 = addToCircle(asleep1, {}, AWAKE + 1000 + HOUR, { asleep: true });
  assert.equal(asleep2.asleepSince, AWAKE + 1000, '重复声明不重置入睡时刻');
});

test('asleepSince：醒来必须清零', () => {
  const c = makeCircle({ energy: 60 });
  const asleep = addToCircle(c, {}, AWAKE + 1000, { asleep: true });
  const woke = addToCircle(asleep, {}, AWAKE + 9 * HOUR, { asleep: false });
  assert.equal(woke.asleep, false);
  assert.equal(woke.asleepSince, 0, '不清就会让下次"睡了多久"从上一次入睡算起');
});

test('asleepSince：老数据（v1，没有这个字段）退化成 lastTickedAt，不崩', () => {
  const legacy = { v: 1, satiety: 70, energy: 50, desire: 40, lastTickedAt: AWAKE, asleep: true };
  const norm = normalizeCircle(legacy);
  assert.equal(norm.v, 2, '老文件升级到 v2');
  assert.equal(norm.asleepSince, AWAKE, '没有 asleepSince 就拿 lastTickedAt 兜底');
  assert.equal(norm.satiety, undefined, 'v1 的 satiety 被丢弃');
  assert.equal(norm.energy, 50);
});

// ── addToCircle ─────────────────────────────────────────────────────────────

test('addToCircle：先结算再加（离线后说刚休息过，数字对得上）', () => {
  const c = makeCircle({ energy: 80 });
  const settledOnly = settleCircle(c, AWAKE + 10 * HOUR);
  const after = addToCircle(c, { energy: 40 }, AWAKE + 10 * HOUR);
  const expected = Math.min(100, settledOnly.energy + 40);
  assert.equal(Math.round(after.energy), Math.round(expected));
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
  const c = makeCircle({ energy: 10, desire: 10 });
  const after = addToCircle(c, { energy: 999, desire: -1, satiety: 999 }, AWAKE + 60000);
  assert.ok(after.energy <= 10 + ADD_LIMITS.energy.max + 1, `energy=${after.energy}`);
  // satiety 传了也没用 —— 它不是维度了
  assert.equal(after.satiety, undefined);
});

test('addToCircle：desire 是**减**（释放），energy 是加', () => {
  const c = makeCircle({ energy: 50, desire: 80 });
  const after = addToCircle(c, { energy: 10, desire: 20 }, AWAKE + 60000);
  assert.ok(after.desire < 80, `desire 被满足应当往下，实际 ${after.desire}`);
  assert.ok(after.energy > 50, `energy 应当往上，实际 ${after.energy}`);
});

// ── normalizeCircle ─────────────────────────────────────────────────────────

test('normalizeCircle：脏数据被修好而不是崩掉', () => {
  assert.equal(normalizeCircle(null).energy, DEFAULT_VALUES.energy);
  assert.equal(normalizeCircle({ energy: 'abc' }).energy, DEFAULT_VALUES.energy);
  assert.equal(normalizeCircle({ energy: 999 }).energy, 100);
  assert.equal(normalizeCircle({ energy: -5 }).energy, 0);
  assert.equal(normalizeCircle({ asleep: 'yes' }).asleep, false, '非 true 一律当没在睡');
  assert.ok(normalizeCircle({}).lastTickedAt > 0);
});

// ── 一天完整曲线（只剩精力）─────────────────────────────────────────────────

test('一天完整曲线：醒着掉精力，睡一夜回满', () => {
  const T = (s) => new Date(s).getTime();
  let c = defaultCircle(T('2026-11-23T07:30:00+08:00'));
  const adv = (iso, add, opts) => {
    const t = T(iso);
    c = settleCircle(c, t, opts);
    if (add || opts?.asleep !== undefined) c = addToCircle(c, add, t, opts);
  };
  adv('2026-11-23T12:30:00+08:00');
  assert.ok(c.energy < 70, `上午跑半天精力该掉了，实际 ${c.energy}`);
  // 22:30 说睡了，睡到 07:30
  adv('2026-11-23T22:30:00+08:00', null, { asleep: true });
  adv('2026-11-24T07:30:00+08:00');
  assert.ok(c.energy > 85, `睡一夜精力应当很足，实际 ${c.energy}`);
  // ★ 关键：这一觉真的睡了 9 小时（从 asleepSince 算）
  assert.equal(Math.round((T('2026-11-24T07:30:00+08:00') - c.asleepSince) / HOUR), 9,
    'asleepSince 应当还在 22:30 那一刻');
});

// ── circleExtras ────────────────────────────────────────────────────────────

test('circleExtras：只出精力一项（饥饿项已删除）', () => {
  // ★ 2026-11-26：原来恒有两项（饥饿 + 精力），现在只剩精力。
  const out = circleExtras(defaultCircle(AWAKE));
  assert.equal(out.length, 1, `应当只有精力一项：${JSON.stringify(out)}`);
  assert.ok(out[0].startsWith('精力：'), `精力应带前缀：${out[0]}`);
});

test('circleExtras：低值给具体说法，正常档给中性词', () => {
  const low = circleExtras({ energy: 10, desire: 10 });
  assert.equal(low.length, 1);
  assert.ok(/困/.test(low[0]), JSON.stringify(low));

  const ok = circleExtras({ energy: 70, desire: 30 });
  assert.equal(ok.length, 1, '正常档也不能整项消失（否则她以为自己没身体）');
  assert.equal(ok[0], '精力：还好');
});

test('circleExtras：精力最低一档时**不显示第三项**（和经期抑制同理）', () => {
  // 人都困到不行了还"欲望高涨"是自相矛盾的，两个标记会打架。
  const sleepy = circleExtras({ energy: 10, desire: 95 }, { includeDesire: true });
  assert.equal(sleepy.length, 1, `精力最低档不该显示第三项：${JSON.stringify(sleepy)}`);
  // 精力刚过线就恢复显示
  const rested = circleExtras({ energy: 25, desire: 95 }, { includeDesire: true });
  assert.equal(rested.length, 2, JSON.stringify(rested));
});

test('circleExtras：第三项默认完全隐形，必须显式开启', () => {
  // 0~79 一律不露；80 起才露。而且**只有 includeDesire===true** 才可能露。
  for (const v of [0, 50, 79]) {
    const out = circleExtras({ energy: 60, desire: v }, { includeDesire: true });
    assert.equal(out.length, 1, `desire=${v} 不该出现：${JSON.stringify(out)}`);
  }
  const high = circleExtras({ energy: 60, desire: 80 }, { includeDesire: true });
  assert.equal(high.length, 2, JSON.stringify(high));
  // 不开启就永远只有一项
  const closed = circleExtras({ energy: 60, desire: 95 });
  assert.equal(closed.length, 1, JSON.stringify(closed));
});

test('circleExtras：文案可覆盖（换词不用改代码）', () => {
  const out = circleExtras(
    { energy: 10, desire: 90 },
    { includeDesire: true, text: { energyLow: '咕咕叫', desireHigh: 'Y' } }
  );
  assert.ok(out.includes('咕咕叫'), JSON.stringify(out));
  const withDesire = circleExtras(
    { energy: 70, desire: 90 },
    { includeDesire: true, text: { desireHigh: 'Y' } }
  );
  assert.ok(withDesire.includes('Y'), JSON.stringify(withDesire));
});

// ── describeCircle ──────────────────────────────────────────────────────────

test('describeCircle：**不带任何数字**（2026-11-24 改）', () => {
  // 她不需要知道分数，只需要知道"我现在有点累"。
  // 数字还会让她开始算账（"我 30 分，还能再撑一会儿"），那不像人。
  const text = describeCircle({ energy: 90, desire: 50 });
  assert.ok(!/\d/.test(text), `不该出现任何数字：${text}`);
  assert.ok(!text.includes('/100'), `不该出现满分制：${text}`);
  assert.ok(!text.includes('第三项'), `「第三项」这种代号也不该给她看：${text}`);
});

test('describeCircle：读起来像一句话，不是字段列表', () => {
  const text = describeCircle({ energy: 90, desire: 50 });
  assert.match(text, /精神很好/, text);
  assert.ok(text.endsWith('。'), `该以句号收尾：${text}`);
});

test('describeCircle：正常档给中性词（还好），不是空', () => {
  const text = describeCircle({ energy: 61, desire: 3 });
  assert.match(text, /精力：还好/, text);
});

test('describeCircle：睡着时说一句', () => {
  const text = describeCircle({ energy: 61, desire: 3, asleep: true });
  assert.match(text, /正在睡/, text);
});

test('describeCircle：第三项到 80 才提', () => {
  assert.ok(!describeCircle({ energy: 61, desire: 79 }).includes('第三项'));
  assert.ok(describeCircle({ energy: 61, desire: 80 }).includes('欲望高涨'));
});

test('describeCircle：**不再提饥饿**（删干净了）', () => {
  const text = describeCircle({ energy: 61, desire: 50 });
  assert.ok(!/饿/.test(text), `不该出现饥饿：${text}`);
});

// ── 常量 ────────────────────────────────────────────────────────────────────

test('defaultCircle：开局不是满血，不是睡着', () => {
  const c = defaultCircle(AWAKE);
  assert.ok(c.energy < 100, '开局不该满血');
  assert.equal(c.asleep, false);
  assert.equal(c.asleepSince, 0);
  assert.equal(c.v, 2);
});

test('离线阈值是 3 小时', () => {
  assert.equal(DEFAULT_OFFLINE_AS_SLEEP_MS, 3 * HOUR);
});

test('速率常量与注释一致', () => {
  assert.equal(DECAY_PER_HOUR.energy, 3.0);
  assert.equal(ENERGY_RECOVER_PER_HOUR, 8.0);
});
