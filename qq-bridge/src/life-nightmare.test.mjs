// 噩梦机制测试（2026-11-24）。
//
// 背景：睡觉时允许被主动唤醒，但**必须带"做噩梦"这个由头** ——
// 它同时解释"为什么醒"和"为什么来消息"。
//
// 三道限制（都是模拟实测校准出来的，别拍脑袋调）：
//   ① 概率 0.03（一晚约 40% 做一次噩梦）
//   ② 一夜最多一次
//   ③ 睡够 1 小时才可能做
//
// 这里测的是**判定逻辑**，不含 IO。

import test from 'node:test';
import assert from 'node:assert/strict';

import { NIGHTMARE_POOL, AFTERGLOW_POOL, pickFromPool } from './life-vitals.js';

const H = 3600000;

/** 复刻 bridge.js 里的噩梦判定。 */
function shouldNightmare({ asleep, now, asleepSince, nightmareNight, todayKey, probability = 0.03, rand = Math.random }) {
  if (asleep !== true) return { fire: false, reason: 'not-asleep' };
  if (nightmareNight === todayKey) return { fire: false, reason: 'already-tonight' };
  if (now - asleepSince < H) return { fire: false, reason: 'too-early' };
  if (rand() >= probability) return { fire: false, reason: 'miss' };
  return { fire: true, reason: 'hit' };
}

// ── ① 词表 ─────────────────────────────────────────────────────────────────

test('噩梦词表：每条都有 label / mood / 精力 / 时长', () => {
  assert.ok(NIGHTMARE_POOL.length >= 3, '词表太小');
  for (const spec of NIGHTMARE_POOL) {
    assert.ok(spec.label && spec.label.length > 6, `label 太短：${spec.label}`);
    assert.ok(spec.mood, `${spec.label} 缺 mood`);
    assert.ok(spec.energyDelta < 0, `${spec.label} 应当扣精力`);
    assert.ok(spec.hours > 0, `${spec.label} 缺时长`);
  }
});

test('噩梦词表：都是「不好的梦」，不是普通梦', () => {
  // 关键语义：平平无奇地做了个梦不会半夜发消息，**难受的梦**才会。
  // 2026-11-24 扩池后，判据改成"含负面情境词"而不是"含惊醒"——
  // 新加的「找出口走回原地」「牙齿松了」这类本身没有"惊醒"字样，但一样是噩梦。
  for (const spec of NIGHTMARE_POOL) {
    assert.ok(
      /追|跑不动|掉下去|找不到|回到原地|牙齿|考试|卷子|喊|发不出|忘了|到不了|赶不上|看不见脸|惊/.test(spec.label),
      `这条读起来不像噩梦：${spec.label}`
    );
  }
});

test('噩梦词表：mood 是中文感受词', () => {
  for (const spec of NIGHTMARE_POOL) {
    assert.match(spec.mood, /^[\u4e00-\u9fa5]+$/, `${spec.mood} 不是中文`);
  }
});

test('pickFromPool 能抽到每一条（无死条目）', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const p = pickFromPool(NIGHTMARE_POOL);
    if (p) seen.add(p.label);
  }
  assert.equal(seen.size, NIGHTMARE_POOL.length, `有 ${NIGHTMARE_POOL.length - seen.size} 条抽不到`);
});

// ── ② 判定闸门 ─────────────────────────────────────────────────────────────

const T0 = new Date('2026-11-24T23:30:00+08:00').getTime();
const always = () => 0;       // 必定命中
const never = () => 0.999;    // 必定不命中

test('醒着时不做噩梦', () => {
  const r = shouldNightmare({ asleep: false, now: T0 + 3 * H, asleepSince: T0, todayKey: '2026-11-24', rand: always });
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'not-asleep');
});

test('睡着 + 睡够 1 小时 + 掷中 → 做噩梦', () => {
  const r = shouldNightmare({ asleep: true, now: T0 + 3 * H, asleepSince: T0, todayKey: '2026-11-24', rand: always });
  assert.equal(r.fire, true);
});

test('刚躺下不到 1 小时不做梦（说不通）', () => {
  const r = shouldNightmare({ asleep: true, now: T0 + 20 * 60000, asleepSince: T0, todayKey: '2026-11-24', rand: always });
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'too-early');
});

test('一夜最多一次：今晚已经做过就不再', () => {
  const r = shouldNightmare({
    asleep: true, now: T0 + 5 * H, asleepSince: T0,
    nightmareNight: '2026-11-24', todayKey: '2026-11-24', rand: always
  });
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'already-tonight');
});

test('跨天后可以再做（昨天的记录不算）', () => {
  const r = shouldNightmare({
    asleep: true, now: T0 + 5 * H, asleepSince: T0,
    nightmareNight: '2026-11-23', todayKey: '2026-11-24', rand: always
  });
  assert.equal(r.fire, true);
});

test('概率 0.03：一晚 16 次机会里大约 40% 会醒一次', () => {
  // 用可复现的 LCG 模拟，避免测试偶发红。
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let nights = 0;
  const TRIALS = 4000;
  for (let t = 0; t < TRIALS; t += 1) {
    let fired = false;
    for (let k = 0; k < 16; k += 1) {
      const r = shouldNightmare({
        asleep: true, now: T0 + (k + 1) * 30 * 60000, asleepSince: T0,
        todayKey: '2026-11-24', nightmareNight: fired ? '2026-11-24' : '', rand: rnd
      });
      if (r.fire) { fired = true; break; }   // 一夜最多一次，命中就停
    }
    if (fired) nights += 1;
  }
  const ratio = nights / TRIALS;
  // 理论上 1-(1-0.03)^16 ≈ 0.39
  assert.ok(ratio > 0.30 && ratio < 0.50, `实测 ${(ratio * 100).toFixed(0)}%，应在 30%~50%`);
});

// ── ③ 与恢复尾声的关系 ─────────────────────────────────────────────────────

test('噩梦不是恢复尾声（它是独立 kind，有自己的 TTL）', () => {
  // 恢复尾声是 condition 到期后生成的；噩梦是独立触发的。
  // 混在 AFTERGLOW_POOL 里会让它被 dedupeByKind 吞掉。
  assert.ok(!Object.prototype.hasOwnProperty.call(AFTERGLOW_POOL, 'nightmare'));
});
