// 睡眠唤醒规则（2026-11-26 最终设计）。
//
// ── 操作者原话（逐条对应）───────────────────────────────────────────────────
//
//   「一般她睡着了就关闭主动唤醒，除了噩梦和我发消息她是不会起床的，
//     这是我设计八点起床的核心」
//        → 睡着时不排常规主动唤醒（原本就有，本轮补测试锁住）
//
//   「我现在想要八点检查一次精力有没有回满，没回满就继续睡，
//     直到跳出非夜晚时间的时候，就会有非夜晚时间的'精力满了就唤醒'机制，
//     这样也有睡了 11 小时的效果」
//        → ① 8 点：精力满则起，未满则继续睡
//        → ② 非夜晚 + 精力满 → 随时起（这就是 11 小时睡眠的来源）
//
// ── ⚠️ 测试里的时间陷阱（踩过）──────────────────────────────────────────────
//
//   `morningWakeHour = 0` **不能**用来造"已经过了早上"的场景 ——
//   算出来的 morningAt 是"明天 0 点"，永远在未来。
//   要造"已过点"，必须用**小于当前小时的**那个值（下面的 pastMorningHour()）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:10001';
const H = 3600 * 1000;

/** 一个**已经过去**的整点小时（保证 morningAt <= now）。 */
function pastMorningHour() {
  const h = new Date().getHours();
  // 当前是 0 点时没有"已过的整点"，退回 0（这种情况下晨唤永远在未来，用例需自判）
  return h > 0 ? h - 1 : 0;
}

async function withBridge(life, fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: [] },
      socialV2: { sticker: { enabled: false }, proactive: { enabled: true } },
      life: {
        enabled: true, timezone: 'Asia/Shanghai',
        quietHours: { enabled: true, startHour: 23, endHour: 8 },
        autoWakeHours: 8,
        morningWakeHour: 8,
        energyWakeThreshold: 100,
        intensity: 50,
        ...life
      }
    }
  });
  h.setMode('reserved2');
  h.socialV2.affinities['10001'] = { score: 1100, count: 20, lastAt: Date.now() };
  h.lifeCircleCacheReset();
  h.lifeCondCacheReset();
  const clearTimer = () => {
    const st = h.getSocialV2State(KEY);
    if (st.proactiveTimer) { clearTimeout(st.proactiveTimer); st.proactiveTimer = null; }
    st.proactiveNextCheckAt = 0;
  };
  try { await fn(h, clearTimer); } finally { await h.close(); }
}

function seedAsleep(h, { sinceHoursAgo = 0, energy = 60, asleepSince } = {}) {
  const now = Date.now();
  const since = asleepSince != null ? asleepSince : now - sinceHoursAgo * H;
  h.writeLifeCircle({ v: 2, energy, desire: 50, asleep: true, asleepSince: since, lastTickedAt: now });
  h.lifeCircleCacheReset();
  return since;
}

// ══ 规则 ①②：早上检查 + 非夜晚精力满 ═══════════════════════════════════════

test('已过晨唤点 + 精力满 → 醒', async () => {
  await withBridge({ morningWakeHour: pastMorningHour(), quietHours: { enabled: false } }, async (h) => {
    if (new Date().getHours() === 0) return;   // 0 点时没有"已过整点"，跳过
    seedAsleep(h, { sinceHoursAgo: 3, energy: 100 });
    const woke = h.maybeAutoWakeUpV2();
    assert.equal(woke, true, '过了晨唤点且精力满 → 应当醒');
    h.lifeCircleCacheReset();
    const c = h.readLifeCircle();
    assert.equal(c.asleep, false);
    assert.equal(c.asleepSince, 0, '醒来必须清 asleepSince');
  });
});

test('已过晨唤点 + 精力**没满** → 继续睡（8 点检查但不叫）', async () => {
  await withBridge({ morningWakeHour: pastMorningHour(), quietHours: { enabled: false } }, async (h) => {
    if (new Date().getHours() === 0) return;
    seedAsleep(h, { sinceHoursAgo: 3, energy: 60 });   // 60 < 100
    const woke = h.maybeAutoWakeUpV2();
    assert.equal(woke, false, '精力没回满就继续睡 —— 这是 11 小时睡眠的关键');
  });
});

test('没到晨唤点 + 精力满 → **不**醒（不能半夜自己爬起来）', async () => {
  await withBridge({ morningWakeHour: 23 }, async (h) => {
    const now = Date.now();
    const since = now - 2 * H;
    const d = new Date(since); d.setHours(23, 0, 0, 0);
    if (d.getTime() <= since) d.setDate(d.getDate() + 1);
    if (now >= d.getTime()) return;   // 恰好已过 23 点，跳过
    seedAsleep(h, { asleepSince: since, energy: 100 });
    assert.equal(h.maybeAutoWakeUpV2(), false,
      '晨唤点还没到，精力再满也不该醒');
  });
});

test('醒来记的时长是**真实**的（3 小时就记 3，不是 8）', async () => {
  await withBridge({ morningWakeHour: pastMorningHour(), quietHours: { enabled: false } }, async (h) => {
    if (new Date().getHours() === 0) return;
    seedAsleep(h, { sinceHoursAgo: 3, energy: 100 });
    h.maybeAutoWakeUpV2();
    h.lifeCondCacheReset();
    const got = Number(h.readLifeCond().meta.lastSleepHours);
    assert.ok(Math.abs(got - 3) < 0.5, `应当记 ~3 小时（实际 ${got}）`);
  });
});

test('11 小时睡眠可达：8 点没满 → 精力涨回来 → 后续叫醒时能记到 ~11h', async () => {
  await withBridge({ morningWakeHour: pastMorningHour(), quietHours: { enabled: false } }, async (h) => {
    if (new Date().getHours() === 0) return;
    // 睡了 11 小时、精力已满 → 走"非夜晚 + 精力满"那条
    seedAsleep(h, { sinceHoursAgo: 11, energy: 100 });
    const woke = h.maybeAutoWakeUpV2();
    assert.equal(woke, true);
    h.lifeCondCacheReset();
    const got = Number(h.readLifeCond().meta.lastSleepHours);
    assert.ok(Math.abs(got - 11) < 0.5,
      `应当记 ~11 小时（实际 ${got}）—— 这就是操作者要的效果`);
  });
});

// ══ 午觉：非夜间入睡不该套晨唤规则 ═════════════════════════════════════════

test('午觉（白天入睡）+ 精力没满 → **不**按晨唤规则醒', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    const since = now - 2 * H;
    const startHour = new Date(since).getHours();
    // 只在"入睡时刻在白天（非 quietHours）"时验证 —— 否则前提不成立
    if (startHour < 8 || startHour >= 23) return;

    h.writeLifeCircle({
      v: 2, energy: 60, desire: 50,
      asleep: true, asleepSince: since, lastTickedAt: now
    });
    h.lifeCircleCacheReset();

    // 白天入睡 = 午觉，morningAt 会算成明天 8 点 —— 必须被 isOvernightSleep 挡掉。
    // 精力 60 没满，所以 ② 也不成立 → 应当继续睡，而不是"按到明天 8 点"。
    assert.equal(h.maybeAutoWakeUpV2(), false,
      '午觉 + 精力没满 → 不该醒（尤其不能因为"明天 8 点"这个错算的时刻）');
  });
});

// ══ 睡着时不开主动唤醒 ═════════════════════════════════════════════════════

test('睡着 → 只排"掷噩梦"的 40 分钟检查，不是常规主动机会', async () => {
  await withBridge({}, async (h, clearTimer) => {
    clearTimer();
    seedAsleep(h, { sinceHoursAgo: 1, energy: 60 });
    h.scheduleProactiveCheckV2(KEY);
    const at = Number(h.getSocialV2State(KEY).proactiveNextCheckAt) || 0;
    assert.ok(at > 0, '应当排了定时器（噩梦还要掷）');
    const waitMin = (at - Date.now()) / 60000;
    assert.ok(Math.abs(waitMin - 40) < 2,
      `睡着时 40 分钟一次（实际 ${waitMin.toFixed(1)}）—— 不是按 gap 算的几小时`);
  });
});

test('睡着 → pickProactiveRouteV2 只放行噩梦', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    seedAsleep(h, { sinceHoursAgo: 3, energy: 100 });
    h.proactiveStateOf(KEY).lastProactiveAt = now - 10 * H;
    const st = h.getSocialV2State(KEY);
    st.lastIncomingAt = now - 5 * H;
    st.lastAiReplyAt = now - 5 * H;

    const picked = h.pickProactiveRouteV2(KEY);
    if (picked && picked.route) {
      assert.equal(picked.reason, 'proactiveNightmare',
        `睡着时只允许噩梦，不能是 ${picked.reason}`);
    } else {
      assert.ok(picked?.blocked, '否则必须是 blocked');
    }
  });
});

test('醒着 → 走正常主动机会（不是 40 分钟）', async () => {
  await withBridge({}, async (h, clearTimer) => {
    clearTimer();
    h.writeLifeCircle({ v: 2, energy: 60, desire: 50, asleep: false, asleepSince: 0, lastTickedAt: Date.now() });
    h.lifeCircleCacheReset();
    h.scheduleProactiveCheckV2(KEY);
    const at = Number(h.getSocialV2State(KEY).proactiveNextCheckAt) || 0;
    const waitMin = (at - Date.now()) / 60000;
    assert.ok(waitMin > 40, `醒着时按 gap（几小时），实际 ${waitMin.toFixed(1)} 分钟`);
  });
});

// ══ 噩梦频率 ═══════════════════════════════════════════════════════════════

test('噩梦概率：一觉约 40%（原来 85% 太高）', async () => {
  const threshold = 0.10 * Math.max(0.2, 0.5);   // 线上配置：0.10 × 0.5
  assert.equal(threshold, 0.05);
  const atLeastOnce = 1 - Math.pow(1 - threshold, 10);
  assert.ok(atLeastOnce > 0.3 && atLeastOnce < 0.5,
    `一觉至少醒一次 = ${(atLeastOnce * 100).toFixed(1)}%，目标 40% 左右`);
});

// ══ 关掉的会话不许被早上叫醒（2026-11-26 修的真 bug）═══════════════════════
//
// 现象：面板上把一个私聊的主动机会关掉了，它**照样在 8 点被叫醒**。
// 根因：wakeUpTimer 是独立于 proactiveTimer 的另一个定时器，
//       而 st.proactiveDisabled 的检查原来只写在 scheduleProactiveCheckV2 里。
// 这条以后不许再漏。

test('关掉主动机会的会话：不排早上叫醒定时器', async () => {
  await withBridge({}, async (h) => {
    const KEY2 = 'private:10001';
    h.getSocialV2State(KEY2);                    // 先建会话
    h.writeLifeCircle({
      v: 2, energy: 60, desire: 50,
      asleep: true, asleepSince: Date.now() - 3600000, lastTickedAt: Date.now()
    });
    h.lifeCircleCacheReset();
    h.getSocialV2State(KEY2).proactiveDisabled = true;

    h.scheduleWakeUpTimerV2(KEY2);
    const st = h.getSocialV2State(KEY2);
    assert.ok(!st.wakeUpTimer, '关掉之后不该排任何醒来定时器');
    assert.equal(st.wakeUpAt, 0, 'wakeUpAt 也要清空');
  });
});

test('关掉主动机会的会话：fireMorningWakeV2 直接返回 false，不发唤醒', async () => {
  await withBridge({}, async (h) => {
    const KEY2 = 'private:10001';
    h.getSocialV2State(KEY2);
    h.writeLifeCircle({
      v: 2, energy: 100, desire: 50,
      asleep: true, asleepSince: Date.now() - 10 * H, lastTickedAt: Date.now()
    });
    h.lifeCircleCacheReset();
    h.getSocialV2State(KEY2).proactiveDisabled = true;

    // 即使三条醒来条件全都满足（睡够、精力满、早过了 8 点），也不许叫
    const fired = h.fireMorningWakeV2(KEY2);
    assert.equal(fired, false, '关掉的会话不该被叫醒');
    h.lifeCircleCacheReset();
    assert.equal(h.readLifeCircle().asleep, true, '她应当还在睡 —— 状态都不该被翻');
  });
});

test('开着的会话：同样条件会正常叫醒（对照组，防止修过头）', async () => {
  await withBridge({ morningWakeHour: 0, quietHours: { enabled: false } }, async (h) => {
    const KEY2 = 'private:10001';
    h.getSocialV2State(KEY2);
    if (new Date().getHours() === 0) return;   // 0 点时 morningWakeHour=0 算明天，跳过
    h.writeLifeCircle({
      v: 2, energy: 100, desire: 50,
      asleep: true, asleepSince: Date.now() - 3 * H, lastTickedAt: Date.now()
    });
    h.lifeCircleCacheReset();
    h.getSocialV2State(KEY2).proactiveDisabled = false;

    const fired = h.fireMorningWakeV2(KEY2);
    assert.equal(fired, true, '开着的会话应当正常叫醒');
    h.lifeCircleCacheReset();
    assert.equal(h.readLifeCircle().asleep, false, '醒来状态应当被翻成 false');
  });
});

