// 主动机会记账的**落盘往返**回归（2026-11-26）。
//
// 为什么单独立一个文件：11-26 00:01 那次"她莫名被叫醒"的根因，
// 不是判定逻辑写错了，而是**存盘时漏了一整块字段**——
// `lastProactiveAt`（上次主动开口的时间）和 `todayCount`（今天已经开口几次）
// 在内存里按会话分开记着，写文件时却只写了旧版的全局字段，
// 于是每次重启读回来都是 0。
//
// 后果链条（真实发生过）：
//   0 → 间隔门算不出"最早什么时候能说" → 排的检查时刻永远是"现在 + 60 秒"
//   → 每分钟重试一次 → 静默门槛和"刚回过话"两道闸一过就叫醒她
//
// 这里同时钉三件事：
//   ① 存 → 读 往返后，按会话的账（时间 / 条数 / 当天用过的理由）必须还在；
//   ② 跨会话隔离：A 的账不能串到 B；
//   ③ 时段分桶与"今晚做过噩梦"这种**跨会话**的事实也要活下来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const A = 'private:10001';
const B = 'private:10002';

async function withBridge(fn, opts = {}) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001', '10002'], groups: [] },
      socialV2: { proactive: { enabled: true }, sticker: { enabled: false } },
      ...opts.config
    },
    files: opts.files
  });
  h.setMode('reserved2');
  try { await fn(h); } finally { await h.close(); }
}

test('存盘往返：按会话的主动机会记账必须还在（这是每分钟重试的根因）', async () => {
  await withBridge(async (h) => {
    const when = Date.now() - 30 * 60 * 1000;
    const p = h.proactiveStateOf(A);
    assert.ok(p, '会话应当有主动机会记账');
    p.lastProactiveAt = when;
    p.todayCount = 3;
    p.todayKey = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    p.sentCandidateIds = [`${p.todayKey}:weather-rain`, `${p.todayKey}:morning-fresh`, '2020-01-01:old-one'];
    p.awaitingReplySince = when;
    p.unanswered = { curiosity: { count: 2 } };
    h.saveSocialV2State();

    // 先确认**真的写进文件了**（不是只改内存）—— 这一条才是本次 bug 的靶心。
    const onDisk = JSON.parse(fs.readFileSync(h.paths.socialV2File, 'utf8'));
    const disk = onDisk?.globalMemory?.proactive?.byKey?.[A];
    assert.ok(disk, '按会话的记账必须真的写进文件（内存对、文件没有 = 静默故障）');
    assert.equal(disk.lastProactiveAt, when, '「上次主动开口」没落盘 → 重启后间隔门失效');
    assert.equal(disk.todayCount, 3, '「今天已开口几次」没落盘');

    // 再真的重新读一遍文件（不是接着读内存）
    h.loadSocialV2State();
    const back = h.proactiveStateOf(A);
    assert.equal(back.lastProactiveAt, when, '"上次主动开口"必须活过重启');
    assert.equal(back.todayCount, 3);
    assert.equal(back.awaitingReplySince, when, '"在等回复"必须活过重启');
    // ⚠️ 用 JSON 比，不用 deepEqual：桥接跑在 vm context 里，
    // 它的对象原型和测试进程的不是同一个，deepStrictEqual 会以
    // "same structure but not reference-equal" 失败（跟字段有没有存下来无关）。
    assert.equal(JSON.stringify(back.unanswered), JSON.stringify({ curiosity: { count: 2 } }));
    // 当天用过的理由要留着（否则同一天把"外面在下雨"说两遍），跨天的要裁掉。
    assert.equal(back.sentCandidateIds.length, 2, '跨天的去重记录应当被裁掉');
    assert.ok(back.sentCandidateIds.every((id) => !String(id).startsWith('2020-')));
  });
});

test('跨会话隔离：A 的账不能串到 B，也不会被 B 覆盖', async () => {
  await withBridge(async (h) => {
    const pa = h.proactiveStateOf(A);
    const pb = h.proactiveStateOf(B);
    assert.notEqual(pa, pb, '两个会话必须是两份独立记账');
    const t1 = Date.now() - 3600 * 1000;
    const t2 = Date.now() - 120 * 1000;
    pa.lastProactiveAt = t1;
    pa.todayCount = 5;
    pb.lastProactiveAt = t2;
    pb.todayCount = 1;
    h.saveSocialV2State();
    h.loadSocialV2State();
    assert.equal(h.proactiveStateOf(A).lastProactiveAt, t1);
    assert.equal(h.proactiveStateOf(B).lastProactiveAt, t2);
    assert.equal(h.proactiveStateOf(A).todayCount, 5);
    assert.equal(h.proactiveStateOf(B).todayCount, 1);
  });
});

test('跨会话的事实：时段分桶与「今晚做过噩梦」也要活过重启', async () => {
  await withBridge(async (h) => {
    // 这两项是**她身体/作息**层面的事实，不分人 —— 给 A 发过之后不该再给 B 来一遍。
    const p = h.proactiveState();
    p.daypartCounts = { date: '2026-11-26', counts: { late_night: 1, evening: 2 } };
    p.nightmareNight = '2026-11-26';
    h.saveSocialV2State();
    h.loadSocialV2State();
    const back = h.proactiveState();
    // 同上：跨 vm context 的对象只能用 JSON 比较。
    assert.equal(JSON.stringify(back.daypartCounts),
      JSON.stringify({ date: '2026-11-26', counts: { late_night: 1, evening: 2 } }));
    assert.equal(back.nightmareNight, '2026-11-26', '噩梦一夜一次，丢了同一晚会被惊醒两回');
  });
});

test('老文件（v1 全局账）能读、不炸，且不会把别人的账算到某个人头上', async () => {
  await withBridge(async (h) => {
    const p = h.proactiveStateOf(A);
    assert.equal(p.lastProactiveAt, 0, '老账分不出是谁的，宁可重算也不能乱记');
    assert.equal(p.todayCount, 0);
    // 不炸、还能正常写出去。
    h.saveSocialV2State();
    h.loadSocialV2State();
    assert.equal(h.proactiveStateOf(A).lastProactiveAt, 0);
  }, {
    // 模拟 11-24 之前的老存档：只有全局单例字段，没有 byKey。
    files: {
      'state/social-v2.json': JSON.stringify({
        conversations: {
          [A]: { agentToken: 'fixture-token-a', wakeConfig: { mode: 'diving', infinite: true }, recentMessages: [], unread: [] }
        },
        globalMemory: {
          proactive: { v: 1, todayKey: '2026-11-24', todayCount: 4, lastProactiveAt: 1795464227582, lastRoute: 'curiosity' }
        }
      })
    }
  });
});
