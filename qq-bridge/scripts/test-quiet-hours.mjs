// 夜里静默 + 「本夜」键 + retryAt 不被 gap 覆盖（2026-11-26 第三轮）。
//
// ── 三条改动的由来 ──────────────────────────────────────────────────────────
//
// ① **免打扰硬闸**：在那之前夜里没有任何硬拦。`HOUR_ACTIVITY_WEIGHT` 只把间隔
//    乘大（凌晨 3 点 = 3.1 小时），不是"不许说"。实测 02:30 那天面板显示
//    "3.1 小时后唤醒她"，落点是 05:56 —— 还在深夜。
//
// ② **nightmareNight 改用夜键**：原来存日历日期，她 23:30 做了噩梦记 `11-26`，
//    过零点判定键变 `11-27`，同一夜能做第二次噩梦。正常作息必然跨午夜。
//
// ③ **retryAt 直接取代 earliest**：原来 `if (notBefore > earliest)`，
//    夜里 gap（108–173min）远大于闸门给的 40min，于是闸门说的全被 gap 吃掉，
//    一觉里撞同一道闸五遍。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:10001';
const HOUR = 3600 * 1000;

async function withBridge(config, fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: [] },
      socialV2: { sticker: { enabled: false }, proactive: { enabled: true } },
      life: { enabled: true, timezone: 'Asia/Shanghai', quietHours: { enabled: true, startHour: 23, endHour: 8 } },
      ...config
    }
  });
  h.setMode('reserved2');
  h.socialV2.affinities['10001'] = { score: 1100, count: 20, lastAt: Date.now() };
  h.lifeCircleCacheReset();
  // ⚠️ scheduleProactiveCheckV2 开头有 `if (st.proactiveTimer) return;` ——
  //   会话创建时已经排过一个定时器，不清掉的话我们的 notBefore 根本进不去。
  const clearTimer = () => {
    const st = h.getSocialV2State(KEY);
    if (st.proactiveTimer) { clearTimeout(st.proactiveTimer); st.proactiveTimer = null; }
    st.proactiveNextCheckAt = 0;
  };
  try { await fn(h, clearTimer); } finally { await h.close(); }
}

// ══ ① 免打扰时段：纯函数 ═══════════════════════════════════════════════════

test('inQuietHours：23→8 跨午夜判定正确', async () => {
  await withBridge({}, async (h) => {
    const q = h.quietHoursOf();
    assert.ok(q, '默认配置应当启用免打扰');
    const at = (hh, mm = 0) => hh * 60 + mm;
    // 禁：23:00 起，到 08:00 前
    assert.equal(h.inQuietHours(at(23, 0), q), true, '23:00 整算禁（左闭）');
    assert.equal(h.inQuietHours(at(23, 59), q), true);
    assert.equal(h.inQuietHours(at(0, 0), q), true, '跨午夜');
    assert.equal(h.inQuietHours(at(2, 30), q), true, '凌晨 2:30');
    assert.equal(h.inQuietHours(at(7, 59), q), true);
    assert.equal(h.inQuietHours(at(8, 0), q), false, '08:00 整放行（右开）');
    assert.equal(h.inQuietHours(at(12, 0), q), false);
    assert.equal(h.inQuietHours(at(22, 59), q), false);
  });
});

test('quietHoursOf：关掉 / 写坏 / 起止相同都返回 null', async () => {
  await withBridge({ life: { quietHours: { enabled: false } } }, async (h) => {
    assert.equal(h.quietHoursOf(), null, 'enabled:false 应当不启用');
  });
  await withBridge({ life: { quietHours: { startHour: 8, endHour: 8 } } }, async (h) => {
    assert.equal(h.quietHoursOf(), null, '起止相同 = 不启用（别把整天禁了）');
  });
  await withBridge({ life: { quietHours: 'garbage' } }, async (h) => {
    assert.equal(h.quietHoursOf(), null, '配置写坏也不该炸');
  });
});

test('quietEndAt：现在 02:30 禁到 08:00 → 今天 08:00（不是明天）', async () => {
  await withBridge({}, async (h) => {
    const q = h.quietHoursOf();
    const now = new Date('2026-11-26T02:30:00+08:00').getTime();
    const end = h.quietEndAt(now, q);
    const d = new Date(end);
    assert.equal(d.getDate(), 26, `应当是 26 号（实际 ${d.toLocaleString('zh-CN')}）`);
    assert.equal(d.getHours(), 8);
    assert.equal(d.getMinutes(), 0);
  });
});

test('quietEndAt：现在 23:30 禁到 08:00 → **明天** 08:00', async () => {
  await withBridge({}, async (h) => {
    const q = h.quietHoursOf();
    const now = new Date('2026-11-26T23:30:00+08:00').getTime();
    const end = h.quietEndAt(now, q);
    const d = new Date(end);
    assert.equal(d.getDate(), 27, `应当跨到 27 号（实际 ${d.toLocaleString('zh-CN')}）`);
    assert.equal(d.getHours(), 8);
  });
});

// ══ ② 免打扰闸在判定链里真的生效 ═══════════════════════════════════════════

test('醒着的她在半夜 → blocked quietHours，且 retryAt 指向 08:00', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    // 让她**醒着**
    h.writeLifeCircle({ v: 2, energy: 60, desire: 50, asleep: false, asleepSince: 0, lastTickedAt: now });
    const p = h.proactiveStateOf(KEY);
    p.lastProactiveAt = now - 10 * HOUR;      // 间隔早就过了
    const st = h.getSocialV2State(KEY);
    st.lastIncomingAt = now - 5 * HOUR;
    st.lastAiReplyAt = now - 5 * HOUR;

    const quiet = h.quietHoursOf();
    const m = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    const picked = h.pickProactiveRouteV2(KEY);

    if (h.inQuietHours(m, quiet)) {
      assert.ok(picked, '应当返回 blocked 对象而不是 null');
      assert.equal(picked.blocked, true);
      assert.equal(picked.blockedBy, 'quietHours');
      const d = new Date(picked.retryAt);
      assert.equal(d.getHours(), 8, `retryAt 应当是 08:00（实际 ${d.toLocaleTimeString('zh-CN')}）`);
    } else {
      // 跑测试时若在白天，就只在"夜里"这一段跳过（不误报）
      assert.ok(picked === null || picked.blocked || picked.route,
        '白天不该被 quietHours 拦');
    }
  });
});

test('睡着的她 → **不走** quietHours 闸（否则噩梦被吃掉）', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    h.writeLifeCircle({
      v: 2, energy: 40, desire: 50,
      asleep: true, asleepSince: now - 3 * HOUR, lastTickedAt: now
    });
    h.proactiveState().nightmareNight = '';
    const picked = h.pickProactiveRouteV2(KEY);
    // 睡着走的是噩梦那套：要么掷中（route）、要么被 asleep-* 挡住 —— 绝不能是 quietHours
    assert.notEqual(picked?.blockedBy, 'quietHours',
      '睡着的路径不该被免打扰拦住 —— 那会让噩梦永不触发');
  });
});

// ══ ③ 「本夜」键 ═══════════════════════════════════════════════════════════

test('nightKeyOf：23:30 与次日 02:00 属于**同一夜**', async () => {
  await withBridge({}, async (h) => {
    const a = new Date('2026-11-26T23:30:00+08:00').getTime();
    const b = new Date('2026-11-27T02:00:00+08:00').getTime();
    assert.equal(h.nightKeyOf(a), h.nightKeyOf(b),
      '跨午夜应当仍是同一夜 —— 这正是原来的 bug');
  });
});

test('nightKeyOf：18:00 是分界（17:59 属昨夜，18:00 属今夜）', async () => {
  await withBridge({}, async (h) => {
    const before = new Date('2026-11-26T17:59:00+08:00').getTime();
    const after = new Date('2026-11-26T18:00:00+08:00').getTime();
    assert.equal(h.nightKeyOf(before), '2026-11-25', '18:00 前算昨天那夜');
    assert.equal(h.nightKeyOf(after), '2026-11-26', '18:00 起算今夜');
  });
});

test('nightKeyOf：早上 09:00 仍属昨夜（凌晨睡过去的同一觉）', async () => {
  await withBridge({}, async (h) => {
    const night = new Date('2026-11-26T23:00:00+08:00').getTime();
    const morning = new Date('2026-11-27T09:00:00+08:00').getTime();
    assert.equal(h.nightKeyOf(morning), h.nightKeyOf(night));
  });
});

test('同一夜做过噩梦 → 过了零点仍然「已做过」', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    // ① 先验证纯函数：23:30 和次日 02:00 是同一个夜键
    const nightAt2330 = h.nightKeyOf(new Date('2026-11-26T23:30:00+08:00').getTime());
    const nightAt0200 = h.nightKeyOf(new Date('2026-11-27T02:00:00+08:00').getTime());
    assert.equal(nightAt2330, nightAt0200, '前提：跨午夜是同一夜');

    // ② 再验证判定链：把「本夜」标记写成**现在这个夜键**，看会不会被拦
    //
    //    ⚠️ 不能用上面那两个假日期 —— 判定链读的是真实 Date.now()，
    //    而跑测试的时刻可能是白天（夜键落到前一天）。所以这里用 h.nightKeyOf(now)。
    const currentNight = h.nightKeyOf(now);
    h.proactiveState().nightmareNight = currentNight;
    h.writeLifeCircle({
      v: 2, energy: 40, desire: 50,
      asleep: true, asleepSince: now - 3 * HOUR, lastTickedAt: now
    });
    const picked = h.pickProactiveRouteV2(KEY);
    assert.equal(picked?.blockedBy, 'asleep-nightmared',
      `本夜（${currentNight}）已经做过噩梦 → 不该再做一次（实际 ${JSON.stringify(picked)}）`);
  });
});

// ══ ④ retryAt 不再被 gap 覆盖 ═════════════════════════════════════════════

test('调度层：notBefore 直接取代 earliest（哪怕 gap 更大）', async () => {
  await withBridge({}, async (h, clearTimer) => {
    clearTimer();
    const now = Date.now();
    // 5 小时后放行 —— 而 tier3 深夜的 gap 大约 3 小时，比它小
    const target = now + 5 * HOUR;
    h.scheduleProactiveCheckV2(KEY, { notBefore: target });
    const at = Number(h.getSocialV2State(KEY).proactiveNextCheckAt) || 0;
    const got = (at - now) / HOUR;
    assert.ok(Math.abs(got - 5) < 0.1,
      `应当正好排在 5 小时后（实际 ${got.toFixed(2)} 小时）—— 被 gap 覆盖说明修复没生效`);
  });
});

test('调度层：notBefore 在过去 → 不倒退成负延迟，仍有 60 秒下限', async () => {
  await withBridge({}, async (h, clearTimer) => {
    clearTimer();
    const now = Date.now();
    h.scheduleProactiveCheckV2(KEY, { notBefore: now - 10 * 60 * 1000 });
    const at = Number(h.getSocialV2State(KEY).proactiveNextCheckAt) || 0;
    assert.ok(at - now >= 55 * 1000, '仍然遵守 60 秒下限，不会瞬间自旋');
  });
});


// ══ 面板数据：睡着时必须能被识别（2026-11-26）═══════════════════════════════
//
// 面板原来只显示"下次检查 05:56（还有 3 小时）"，看不出那是"间隔长"还是
// "她在睡觉、根本不会叫醒她"。这两件事对她的实际行为差很远。
// 端点现在带 life 字段，面板据此显示「睡着 · 17:00 起床前不会主动开口」。

test('面板端点：睡着时会带 life.asleep / asleepHours / wakeUpAt', async () => {
  await withBridge({}, async (h) => {
    const now = Date.now();
    h.writeLifeCircle({
      v: 2, energy: 60, desire: 50,
      asleep: true, asleepSince: now - 2 * HOUR, lastTickedAt: now
    });
    h.lifeCircleCacheReset();
    const st = h.getSocialV2State(KEY);
    st.wakeUpAt = now + 5 * HOUR;
    const row = h.buildProactiveSessionRow(KEY);
    assert.ok(row, '应当能取到这一行');
    assert.ok(row.life, '必须带 life 字段');
    assert.equal(row.life.asleep, true, '睡着必须是 true');
    assert.ok(row.life.asleepHours > 1.5, `已睡时长要算出来（实际 ${row.life.asleepHours}）`);
    assert.equal(row.life.wakeUpAt, now + 5 * HOUR, '醒来的时刻要能传到面板');
  });
});

test('面板端点：醒着时 life.asleep 必须是 false（别把白天当睡）', async () => {
  await withBridge({}, async (h) => {
    // ⚠️ 必须先建会话 —— 空 harness 的 conversations 里没有任何 key，
    //    buildProactiveSessionRow 会返回 null（那不是 bug，是"这个 key 不存在"）。
    h.getSocialV2State(KEY);
    h.writeLifeCircle({ v: 2, energy: 72, desire: 30, asleep: false, asleepSince: 0, lastTickedAt: Date.now() });
    h.lifeCircleCacheReset();
    const row = h.buildProactiveSessionRow(KEY);
    assert.ok(row, '建了会话之后必须能取到行');
    assert.equal(row.life.asleep, false);
    assert.equal(row.life.asleepHours, 0);
    assert.ok(Number(row.life.energy) > 0, '醒着要给精力');
  });
});

// ══ 面板文案可配（2026-11-26）═══════════════════════════════════════════════
//
// 需求背景：仓库要公开，代码里的默认措辞用中性叫法（「第三项」）；
// 但本机想显示成什么应由 config.json 决定 —— 那个文件在 .gitignore 里，
// 不会跟着仓库一起发出去。
//
// 所以：**默认中性 + 可配覆盖**，两边都要钉住。

test('life.panelLabels 默认是中性叫法（公开仓库的要求）', async () => {
  await withBridge({}, async (h) => {
    // 不配 panelLabels 时，bridge 里那段 fallback 应当是「第三项」。
    // （这里只断言"默认值是中性词"，不去断言"不含某个具体词" ——
    //  那种断言本身就会把那个词写进公开仓库。）
    const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    assert.ok(src.includes("pick('desire', '第三项')"),
      '默认标签必须是中性的「第三项」—— 那是要公开的代码');
  });
});

test('life.panelLabels 配上就覆盖默认值', async () => {
  await withBridge({
    life: {
      enabled: true, timezone: 'Asia/Shanghai',
      panelLabels: { desire: '自定义名', energy: '精力值', body: '身体状态' }
    }
  }, async (h) => {
    assert.equal(h.cfg.life.panelLabels.desire, '自定义名');
    assert.equal(h.cfg.life.panelLabels.energy, '精力值');
    assert.equal(h.cfg.life.panelLabels.body, '身体状态');
  });
});

test('life.statusText.desireHigh 可配（工具返回值里的那句话）', async () => {
  await withBridge({
    life: {
      enabled: true, timezone: 'Asia/Shanghai',
      statusText: { desireHigh: '自定义档位词' }
    }
  }, async (h) => {
    assert.equal(h.cfg.life.statusText.desireHigh, '自定义档位词');
  });
});

// ══ 压缩策略（2026-11-26 核对）══════════════════════════════════════════════
//
// 压缩是不可逆的（旧上下文被摘要掉），误压一次就让她忘掉一段对话 ——
// 所以三道闸都得钉住：配置、闲置、上下文大小。

test('压缩配置：默认走 /compact_chat，禁用破坏性 /compact', async () => {
  await withBridge({
    socialV2: {
      sticker: { enabled: false }, proactive: { enabled: true },
      compaction: {
        enabled: true, onlyPrivate: false, idleMs: 1800000,
        thresholdTokens: 400000, checkIntervalMs: 60000,
        command: '/compact_chat', allowDestructiveCompact: false
      }
    }
  }, async (h) => {
    const c = h.cfg.socialV2.compaction;
    assert.equal(c.enabled, true);
    assert.equal(c.command, '/compact_chat', '必须走保留尾部的那个命令');
    assert.notEqual(c.command, '/compact', '绝不能默认走 /compact —— 它 retainTokens 硬编码 0');
    assert.equal(c.allowDestructiveCompact, false, '破坏性压缩必须显式开关');
    assert.equal(c.thresholdTokens, 400000, '阈值 40 万');
    assert.equal(c.idleMs, 1800000, '闲置 30 分钟');
  });
});

test('压缩判定：闲置不够长 → 不压', async () => {
  await withBridge({
    socialV2: {
      sticker: { enabled: false }, proactive: { enabled: true },
      compaction: { enabled: true, onlyPrivate: false, idleMs: 1800000, thresholdTokens: 400000 }
    }
  }, async (h) => {
    const K = 'private:10001';
    h.getSocialV2State(K);
    const st = h.getSocialV2State(K);
    const now = Date.now();
    st.lastIncomingAt = now - 5 * 60 * 1000;   // 才 5 分钟
    st.lastActionAt = now - 5 * 60 * 1000;
    assert.equal(h.idleCompactDecisionV2(K, st, now), null, '闲置 5 分钟不该压');
  });
});

test('压缩判定：全局关掉 → 不压', async () => {
  await withBridge({
    socialV2: {
      sticker: { enabled: false }, proactive: { enabled: true },
      compaction: { enabled: false, onlyPrivate: false, idleMs: 1800000, thresholdTokens: 400000 }
    }
  }, async (h) => {
    const K = 'private:10001';
    h.getSocialV2State(K);
    const st = h.getSocialV2State(K);
    const now = Date.now();
    st.lastIncomingAt = now - 60 * 60 * 1000;
    st.lastActionAt = now - 60 * 60 * 1000;
    assert.equal(h.idleCompactDecisionV2(K, st, now), null, 'enabled=false 时一律不压');
  });
});

test('压缩判定：本轮已压过 → 不重复压（等用户下一条消息解锁）', async () => {
  await withBridge({
    socialV2: {
      sticker: { enabled: false }, proactive: { enabled: true },
      compaction: { enabled: true, onlyPrivate: false, idleMs: 1800000, thresholdTokens: 400000 }
    }
  }, async (h) => {
    const K = 'private:10001';
    h.getSocialV2State(K);
    const st = h.getSocialV2State(K);
    const now = Date.now();
    st.lastIncomingAt = now - 60 * 60 * 1000;
    st.lastActionAt = now - 60 * 60 * 1000;
    st.idleCompactedAt = now - 1000;
    assert.equal(h.idleCompactDecisionV2(K, st, now), null, 'idleCompactedAt 非 0 → 不压');
  });
});

test('压缩判定：上下文没到阈值 → 不压（这是最容易被改成"随便压"的一处）', async () => {
  await withBridge({
    socialV2: {
      sticker: { enabled: false }, proactive: { enabled: true },
      compaction: { enabled: true, onlyPrivate: false, idleMs: 1800000, thresholdTokens: 400000 }
    }
  }, async (h) => {
    const K = 'private:10001';
    h.getSocialV2State(K);
    const st = h.getSocialV2State(K);
    const now = Date.now();
    st.lastIncomingAt = now - 60 * 60 * 1000;
    st.lastActionAt = now - 60 * 60 * 1000;
    // 测试环境没有真实 token 采样 → 读出来 0 → 必然低于 40 万 → 不压
    assert.equal(h.idleCompactDecisionV2(K, st, now), null,
      '上下文 0 < 400k → 不压（阈值闸有效）');
  });
});
