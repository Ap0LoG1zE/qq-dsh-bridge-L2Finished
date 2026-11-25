// 噩梦与普通梦的**互斥**测试（2026-11-24）。
//
// 起因（操作者实测发现）：一条唤醒词里同时出现
//   （醒了，睡得还行　梦见吃到很好吃的东西，醒来还在回味）   ← 普通梦
//   （刚做了个不太好的梦，惊醒了。）                        ← 噩梦
// 一夜既做好梦又做噩梦、还都记得 —— 这不对。
//
// 根因：两条路径完全独立。
//   半夜噩梦 → 写 nightmare condition + p.nightmareNight
//   早上自动醒 → rollDreamOnWakeV2() 不知道做过噩梦，又抽一条普通梦
//
// 修法：双向互斥。

import test from 'node:test';
import assert from 'node:assert/strict';

import { NIGHTMARE_POOL, DREAM_POOL, pickWithDefault } from './life-vitals.js';

/**
 * 复刻 bridge.js 里的互斥逻辑。
 * @returns {{dream: string, nightmare: string, log: string[]}}
 */
function simulateNight({ seedInit = 1, timeline }) {
  let seed = seedInit;
  // ⚠️ 这个 rand **必须一直返回 0**（即必定掷中），否则测试会随种子飘。
  //    第一版用 LCG，结果 specialChance=0.99 时阈值是 0.495，
  //    而 LCG 首次值可能 > 0.495 → 掷不中 → 断言红。
  //    这里要测的是**互斥逻辑**，不是概率，所以固定成"必中"。
  const rnd = () => 0;

  let pendingDream = null;
  let pendingNightmare = null;
  let nightmareNight = '';
  const log = [];

  for (const step of timeline) {
    const todayKey = step.dayKey || '2026-11-24';

    if (step.kind === 'auto-wake') {
      // 普通梦：今晚做过噩梦就不抽
      if (nightmareNight === todayKey) {
        log.push(`${step.at} 自动醒 → 跳过普通梦（今晚已噩梦）`);
        continue;
      }
      const picked = pickWithDefault(DREAM_POOL, { rand: rnd, specialChance: 0.99 });   // 必定命中
      if (!picked.isDefault && picked.spec.label) {
        pendingDream = picked.spec.label;
        log.push(`${step.at} 自动醒 → 抽到普通梦：${picked.spec.label}`);
      }
    }

    if (step.kind === 'nightmare') {
      if (nightmareNight === todayKey) {
        log.push(`${step.at} 噩梦 → 跳过（今晚已做过）`);
        continue;
      }
      const picked = pickWithDefault(NIGHTMARE_POOL, { rand: rnd, specialChance: 0.99 });  // 必定命中
      if (!picked.isDefault && picked.spec) {
        nightmareNight = todayKey;
        pendingNightmare = picked.spec.label;
        log.push(`${step.at} 噩梦惊醒：${picked.spec.label}`);
        // 反向互斥：丢掉已抽到的普通梦
        if (pendingDream) {
          log.push('   → 丢弃已抽到的普通梦');
          pendingDream = null;
        }
      }
    }
  }
  return { dream: pendingDream, nightmare: pendingNightmare, log };
}

// ── ① 先普通梦、后噩梦 ─────────────────────────────────────────────────────

test('先抽普通梦、后做噩梦 → 普通梦被丢弃', () => {
  const r = simulateNight({
    seedInit: 5,
    timeline: [
      { at: '07:00', kind: 'auto-wake' },
      { at: '23:30', kind: 'nightmare' }
    ]
  });
  assert.ok(r.nightmare, '应当有噩梦');
  assert.equal(r.dream, null, '普通梦应当被清掉');
  assert.ok(r.log.some((l) => l.includes('丢弃')), '日志里应当有丢弃记录');
});

// ── ② 先噩梦、后自动醒 ────────────────────────────────────────────────────

test('先做噩梦、后自动醒 → 不再抽普通梦', () => {
  const r = simulateNight({
    seedInit: 7,
    timeline: [
      { at: '02:00', kind: 'nightmare' },
      { at: '08:00', kind: 'auto-wake' }
    ]
  });
  assert.ok(r.nightmare, '应当有噩梦');
  assert.equal(r.dream, null, '不该再抽普通梦');
  assert.ok(r.log.some((l) => l.includes('跳过普通梦')), '日志里应当有跳过记录');
});

// ── ③ 两种都不能同时存在 ───────────────────────────────────────────────────

test('**任何顺序下，两个都不能同时有值**', () => {
  // 这是核心断言：跑一遍所有组合，看是否会出现两者并存。
  const orders = [
    ['auto-wake', 'nightmare'],
    ['nightmare', 'auto-wake'],
    ['auto-wake', 'auto-wake', 'nightmare'],
    ['nightmare', 'auto-wake', 'auto-wake'],
  ];
  for (const seq of orders) {
    for (let seed = 1; seed <= 20; seed += 1) {
      const timeline = seq.map((kind, i) => ({ at: `T${i}`, kind }));
      const r = simulateNight({ seedInit: seed, timeline });
      assert.ok(
        !(r.dream && r.nightmare),
        `seq=${seq.join('>')} seed=${seed}：梦与噩梦并存了（dream=${r.dream} nm=${r.nightmare}）`
      );
    }
  }
});

// ── ④ 没有噩梦的夜晚，普通梦照常 ──────────────────────────────────────────

test('没做噩梦的夜晚，普通梦正常工作', () => {
  const r = simulateNight({
    seedInit: 11,
    timeline: [{ at: '08:00', kind: 'auto-wake' }]
  });
  assert.ok(r.dream, '应当抽到普通梦');
  assert.equal(r.nightmare, null);
});

// ── ⑤ 跨天后互斥解除 ───────────────────────────────────────────────────────

test('跨天后互斥解除（昨天噩梦不影响今天普通梦）', () => {
  const r = simulateNight({
    seedInit: 13,
    timeline: [
      { at: '02:00', kind: 'nightmare', dayKey: '2026-11-24' },
      { at: '08:00', kind: 'auto-wake', dayKey: '2026-11-25' }
    ]
  });
  assert.ok(r.nightmare, '昨晚有噩梦');
  assert.ok(r.dream, '今天应当能抽普通梦');
});

// ── ⑥ 词表本身不能有重叠 ───────────────────────────────────────────────────

test('两池的 label 不重复（防止同一条内容以两种身份出现）', () => {
  const nm = new Set(NIGHTMARE_POOL.map((s) => s.label));
  for (const d of DREAM_POOL) {
    if (!d.label) continue;
    assert.ok(!nm.has(d.label), `两池重复：${d.label}`);
  }
});
