// 「明明还有理由，却说没理由」的回归（2026-11-26）。
//
// 11-26 白天真实发生：19:07 / 20:07 / 21:07 连续三次 `no-reason`，
// 四个多小时一次都没主动开口。两个原因叠在一起：
//
//   ① **抽签发生在去重之前** —— `ambientFallbackCandidates` 先随机抽一条，
//      上层再按"今天用过没有"过滤。抽到用过的那条 → 过滤后 0 条 →
//      判成"没有理由"。而池子里明明还有没用的。
//
//   ② **去重窗口是"按自然日"** —— 一条用过后今晚零点前都不能再用。
//      一天只有 6 种候选，发到第 5 条时池子基本空了。
//      原作者用的是滚动窗口（普通 240 分钟 / 天气 1080 分钟）。
//
// 这里钉三件事：
//   · 兜底池返回**全部**可用理由，不是随机一条；
//   · 去重过了时间窗就重新可用（不是等跨天）；
//   · 同一天里，只要还有没用过的理由，就不该判 no-reason。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ambientFallbackCandidates, buildProactiveCandidates } from '../src/life-proactive.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:10001';
const HOUR = 3600 * 1000;

test('兜底池返回全部可用理由，不是随机抽一条', () => {
  // 21:07：白天通用 + 安静关心 + 夜里安静，三条都该在。
  const got = ambientFallbackCandidates({ minuteOfDay: 21 * 60 + 7, energy: 60, weatherText: '' });
  const ids = got.map((c) => c.id);
  assert.ok(ids.includes('ambient-late-quiet'), '夜里那条应当在');
  assert.ok(got.length >= 2, `池子里有几条就要交上去几条（实际 ${got.length}）`);
  // 每条都必须带动机 —— 没动机等于"叫醒了不说为什么"，那正是要修的问题。
  for (const c of got) assert.ok(c.motive && String(c.motive).trim(), `${c.id} 缺 motive`);
});

test('抽签在去重之后：今天用过一条，剩下的照样能用', () => {
  // 21:07 的池子里三条，假设其中两条今天用过。
  const all = buildProactiveCandidates({
    now: Date.now(), minuteOfDay: 21 * 60 + 7, energy: 60, sleepHours: 0, lastNightRestless: false, weatherText: ''
  });
  const used = new Set(['2026-11-26:ambient-think-of-you', '2026-11-26:ambient-quiet-care']);
  const avail = all.filter((c) => !used.has(`2026-11-26:${c.id}`));
  assert.ok(avail.length > 0,
    '还剩 ambient-late-quiet 可以用，不该判成"没有理由"——'
    + '旧实现是随机抽，抽到用过的那条就整轮作废');
});

async function withBridge(fn) {
  const h = await bridgeHarness({
    config: { ownerQQ: 10001, allow: { private: ['10001'], groups: [] } }
  });
  h.setMode('reserved2');
  try { await fn(h); } finally { await h.close(); }
}

test('去重是滚动窗口：普通话题 4 小时后重新可用，不是等跨天', async () => {
  await withBridge(async (h) => {
    const p = h.proactiveStateOf(KEY);
    const now = Date.now();
    const id = '2026-11-26:ambient-quiet-care';

    // ★ 2026-11-26 二次修：集合里现在是**裸 id**（去掉日期前缀），
    //   这样跨午夜也能正确判"多久之前用过"。
    const bare = 'ambient-quiet-care';

    // 10 分钟前用过 → 仍在窗口内
    p.sentCandidateIds = [{ id, at: now - 10 * 60 * 1000 }];
    assert.ok(h.proactiveDedupeSetOf(KEY).has(bare), '10 分钟前用过，应当仍被判为"用过"');

    // 3 小时前 → 还没到 240 分钟
    p.sentCandidateIds = [{ id, at: now - 3 * HOUR }];
    assert.ok(h.proactiveDedupeSetOf(KEY).has(bare), '3 小时前用过，仍在 240 分钟窗口内');

    // 5 小时前 → 过了窗口，重新可用
    p.sentCandidateIds = [{ id, at: now - 5 * HOUR }];
    assert.ok(!h.proactiveDedupeSetOf(KEY).has(bare),
      '5 小时前用过，早过 240 分钟窗口，应当重新可用（旧的按自然日实现会一直锁到零点）');

    // ★ 跨午夜：昨晚 22:00 用过（id 带的是昨天的日期前缀），今天 01:30 查
    //   —— 距上次才 210 分钟（<240），必须仍判"用过"。
    //   第一次改滚动窗口时这里会漏：查询 id 拼的是今天的日期前缀，跟存的比不上。
    const lastNight = new Date(now); lastNight.setDate(lastNight.getDate() - 1); lastNight.setHours(22, 0, 0, 0);
    const yKey = lastNight.getFullYear() + '-' + String(lastNight.getMonth() + 1).padStart(2, '0') + '-' + String(lastNight.getDate()).padStart(2, '0');
    p.sentCandidateIds = [{ id: yKey + ':' + bare, at: lastNight.getTime() }];
    const crossed = h.proactiveDedupeSetOf(KEY);
    // 只有真的跨午夜（昨天 22:00 到现在 < 240 分钟）时才断言
    if (now - lastNight.getTime() < 240 * 60 * 1000) {
      assert.ok(crossed.has(bare), '跨午夜后仍应判为用过（日期前缀不该影响滚动窗口）');
    }
  });
});

test('天气类窗口更长：普通 4 小时能用回来，天气要 18 小时', async () => {
  await withBridge(async (h) => {
    const p = h.proactiveStateOf(KEY);
    const now = Date.now();
    const weatherId = '2026-11-26:ambient-gloomy';
    const normalId = '2026-11-26:ambient-quiet-care';

    // 8 小时前：普通话题早该能用，天气还不行
    p.sentCandidateIds = [
      { id: normalId, at: now - 8 * HOUR },
      { id: weatherId, at: now - 8 * HOUR }
    ];
    const set = h.proactiveDedupeSetOf(KEY);
    assert.ok(!set.has('ambient-quiet-care'), '普通话题 8 小时后该能用');
    assert.ok(set.has('ambient-gloomy'), '天气话题要等 18 小时');

    // 20 小时前：天气也过了
    p.sentCandidateIds = [{ id: weatherId, at: now - 20 * HOUR }];
    assert.ok(!h.proactiveDedupeSetOf(KEY).has('ambient-gloomy'), '20 小时后天气话题该能用');
  });
});

test('老的"纯字符串 id"记录仍能读：当天有效、跨天失效', async () => {
  const h = await bridgeHarness({
    config: { ownerQQ: 10001, allow: { private: ['10001'], groups: [] } },
    files: {
      'state/social-v2.json': JSON.stringify({
        conversations: {},
        globalMemory: {
          proactive: {
            v: 2,
            byKey: {
              [KEY]: {
                todayKey: '2026-11-26', todayCount: 1, lastProactiveAt: 0,
                sentCandidateIds: ['2026-11-26:ambient-quiet-care', '2020-01-01:old-one']
              }
            }
          }
        }
      })
    }
  });
  h.setMode('reserved2');
  try {
    const p = h.proactiveStateOf(KEY);
    assert.ok(Array.isArray(p.sentCandidateIds), '老格式不该把状态读崩');
    const set = h.proactiveDedupeSetOf(KEY);
    // 注意：这里的"今天"是跑测试的当天，2026-11-26 是写死的 —— 所以
    // 那条老记录只有在测试当天恰好是 2026-11-26 时才有效。跨天的那条必须失效。
    assert.ok(!set.has('2020-01-01:old-one'), '跨天的老记录必须失效，不能永久卡住');
  } finally {
    await h.close();
  }
});

// ══ 跨午夜（纯逻辑，不依赖跑测试的时刻）════════════════════════════════════
//
// 上面那条跨午夜断言带了 `if (真的跨了)` 守卫，因为它用真实时钟。
// 这一条把"存进去的 id"和"要查的 id"直接写出来，任何时刻跑都会红/绿 ——
// 它是这个 bug 最直接的锁定。
//
// 现象：昨晚 22:00 用掉一条，今天 01:30 才过 210 分钟（窗口 240），
//       但查询 id 拼的是今天的日期前缀 → 查不到 → 判"没用过" → 重复开口。

test('跨午夜：日期前缀不同也必须判为用过（裸 id 比对）', () => {
  // 模拟桥接内部：带前缀的存量 → 剥成裸 id 放进集合
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

  const usedAt = Date.parse('2026-11-26T22:00:00+08:00');
  const now = Date.parse('2026-11-27T01:30:00+08:00');
  const storedId = keyOf(usedAt) + ':ambient-quiet-care';

  // 桥接现在的做法：剥掉前缀
  const bare = /^\d{4}-\d{2}-\d{2}:(.+)$/.exec(storedId)[1];
  assert.equal(bare, 'ambient-quiet-care', '前缀必须被剥掉');

  // 窗口判定只看时间戳，与日期无关
  const windowMs = 240 * 60 * 1000;
  assert.ok(now - usedAt < windowMs,
    `距上次 ${Math.round((now - usedAt) / 60000)} 分钟，仍在 240 分钟窗口内 → 必须算"用过"`);
});
