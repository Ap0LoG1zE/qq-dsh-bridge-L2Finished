// life-vitals.js 单元测试：纯离线。
//   node --test src/life-vitals.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SLEEP_POOL,
  HEALTH_POOL,
  CARE_POOL,
  AFTERGLOW_POOL,
  buildHealthCauses,
  healthChance,
  pickFromPool,
  sleepVerdict,
  makeAfterglow
} from './life-vitals.js';

const H = 3600000;

test('healthChance：0 条基线 12%，每条 +10%，封顶 42%', () => {
  assert.equal(Math.round(healthChance(0) * 100), 12);
  assert.equal(Math.round(healthChance(1) * 100), 22);
  assert.equal(Math.round(healthChance(2) * 100), 32);
  assert.equal(Math.round(healthChance(3) * 100), 42);
  // 封顶：再多原因也不会往上走
  assert.equal(Math.round(healthChance(10) * 100), 42);
});

test('healthChance：intensity 只影响斜率，不改基线', () => {
  assert.equal(Math.round(healthChance(0, 1) * 100), 12, '基线不受人设强度影响');
  assert.ok(healthChance(2, 1) > healthChance(2, 0.5), '强度高时同样原因更容易生病');
});

test('buildHealthCauses：晴暖睡好 → 没有原因', () => {
  assert.deepEqual(buildHealthCauses({ sleepLabel: '睡得还行', weatherText: '晴', tempC: 20 }), []);
});

test('buildHealthCauses：雨 + 冷 + 没睡好 → 三条', () => {
  const causes = buildHealthCauses({ sleepLabel: '睡得有点浅', weatherText: '小雨', tempC: 8 });
  assert.equal(causes.length, 3);
  assert.ok(causes.includes('没睡好'));
  assert.ok(causes.includes('太冷'));
});

test('buildHealthCauses：高温也算', () => {
  assert.ok(buildHealthCauses({ tempC: 33 }).includes('太热'));
  assert.ok(!buildHealthCauses({ tempC: 25 }).length);
});

test('buildHealthCauses：缺数据不编', () => {
  assert.deepEqual(buildHealthCauses({}), []);
  assert.deepEqual(buildHealthCauses(), []);
});

test('pickFromPool：注入 rand 可精确控制', () => {
  const pool = [{ a: 1 }, { a: 2 }, { a: 3 }];
  assert.equal(pickFromPool(pool, () => 0).a, 1);
  assert.equal(pickFromPool(pool, () => 0.5).a, 2);
  assert.equal(pickFromPool(pool, () => 0.999999).a, 3);
  assert.equal(pickFromPool([], () => 0), null);
});

test('sleepVerdict：睡得太少 → 落到差的那几条', () => {
  assert.match(sleepVerdict({ sleepHours: 3, rand: () => 0 }).label, /很晚|浅|翻来覆去/);
  assert.equal(sleepVerdict({ sleepHours: 9, rand: () => 0.9 }).label, '睡得还行');
});

test('sleepVerdict：没有数据 → 空 label，一个字都不编', () => {
  // ★ 2026-11-26 改：原来是"返回默认那条"，但默认那条的 label 就是
  //   「睡得还行」—— 等于没数据也照样说一句起床语。11-26 00:01 那次
  //   她根本没说自己睡过，唤醒词里却有「（醒了，睡得还行）」。
  //   现在契约是**空 label**（调用方见空串就什么都不写）。
  assert.equal(sleepVerdict({}).label, '');
  assert.equal(sleepVerdict({ sleepHours: 0 }).label, '');
  assert.equal(sleepVerdict({ sleepHours: NaN }).label, '');
  // 数值照旧是平淡项：不编文字，也不该顺手扣/加精力。
  assert.equal(sleepVerdict({}).energyDelta, 0);
  assert.equal(sleepVerdict({}).mood, '');
  // 有数据时必须给得出话（别把整条路径改死了）。
  assert.equal(sleepVerdict({ sleepHours: 8, rand: () => 0.9 }).label, '睡得还行');
});

test('词表：第一条是平淡项（默认策略：默认无聊、偶尔有事）', () => {
  // 这是刻意的设计，别把"特殊项"挪到第一位 —— 那会让每天都异常。
  assert.equal(SLEEP_POOL[0].energyDelta, 0);
  assert.equal(SLEEP_POOL[0].mood, '');
});

test('词表：health 全是负影响', () => {
  for (const spec of HEALTH_POOL) {
    assert.ok(spec.energyDelta < 0, `${spec.label} 应当扣精力`);
  }
});

test('词表：care 是正影响', () => {
  for (const spec of CARE_POOL) {
    assert.ok(spec.energyDelta > 0);
  }
});

test('makeAfterglow：生成合法的 condition 草稿', () => {
  const now = new Date('2026-11-24T12:00:00+08:00').getTime();
  for (const kind of Object.keys(AFTERGLOW_POOL)) {
    const cond = makeAfterglow(kind, now);
    assert.ok(cond, `${kind} 应当能生成`);
    assert.equal(cond.startTs, now);
    assert.ok(cond.endTs > now);
    assert.equal(cond.onEndTransition, '', '尾声不该再挂尾声（否则会无限套娃）');
    assert.equal(cond.transitionDone, false);
  }
});

test('makeAfterglow：未知类型返回 null', () => {
  assert.equal(makeAfterglow('nope', Date.now()), null);
  assert.equal(makeAfterglow('', Date.now()), null);
});

test('makeAfterglow：尾声时长与词表一致', () => {
  const now = Date.now();
  const cond = makeAfterglow('health_relief', now);
  assert.equal(cond.endTs - cond.startTs, AFTERGLOW_POOL.health_relief.hours * H);
});
