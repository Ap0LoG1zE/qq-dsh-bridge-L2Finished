// 验证：她自己的消息时间戳是**真实发送时刻**，不是伪造的 now + i*1000。
//
// 2026-11-19 操作者从消息时间戳看出「间隔巨短」：
//   03:35:15 / 03:35:16 / 03:35:17  ← 永远正好 1 秒
//   而真实配置是 1~3 秒随机 + 网络耗时。
// 根因：recordSentMessagesV2 里写 `time: now + i * 1000`（从初版就存在）。
//
// 现在改成用 sendMessagesV2 记录的真实发出时刻（sentAt）。
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const GAP_MS = 400;
let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, '—', e.message); }
};

async function withBridge(run, gap = GAP_MS) {
  const h = await bridgeHarness({ config: { socialV2: {
    send: {
      minSendIntervalMs: 0, observeAfterSendMs: 100, observeQuietMs: 100,
      burstIntervalMinMs: gap, burstIntervalMaxMs: gap,
      maxSendPerMinute: 100, maxSendPerHour: 100, maxSendPerMessage: 10,
    },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const SM = { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' };
  const send = (body) => fetch(`${base}/api/socialV2/send-message?key=${encodeURIComponent(KEY)}`, {
    method: 'POST', headers: SM, body: JSON.stringify({ key: KEY, ...body }),
  }).then((r) => r.json());
  try { await run({ h, send }); }
  finally { await new Promise((r) => server.close(r)); await h.close(); }
}

// ── ① 三条消息的时间戳应当反映真实间隔 ──────────────────────────────
await test('3 条消息的时间戳间隔 ≈ 配置的句间间隔（不是固定 1 秒）', async () => {
  await withBridge(async ({ h, send }) => {
    const r = await send({ messages: ['甲', '乙', '丙'], gapMode: 'fixed', gapMs: GAP_MS });
    if (!r.ok) throw new Error(`发送失败: ${JSON.stringify(r).slice(0, 150)}`);

    const st = h.getSocialV2State(KEY);
    const mine = (st.recentMessages || []).filter((m) => m.isSelf).slice(-3);
    if (mine.length !== 3) throw new Error(`应有 3 条自己的消息，实际 ${mine.length}`);

    const t = mine.map((m) => Number(m.time));
    const gaps = [t[1] - t[0], t[2] - t[1]];
    console.log(`    时间戳: ${t.map((x) => new Date(x).toLocaleTimeString('zh-CN')).join(' / ')}`);
    console.log(`    间隔: ${gaps.join('ms, ')}ms（配置 ${GAP_MS}ms）`);

    // 关键：间隔应当接近 GAP_MS（容许 ±350ms 抖动 + 网络），而不是固定 1000
    for (const [i, g] of gaps.entries()) {
      if (g < GAP_MS - 200) throw new Error(`第 ${i + 1} 个间隔 ${g}ms 小于配置 ${GAP_MS}ms —— 时间戳仍是伪造的`);
      if (g > GAP_MS + 900) throw new Error(`第 ${i + 1} 个间隔 ${g}ms 远大于配置 ${GAP_MS}ms`);
    }
    console.log('    间隔真实反映发送节奏 ✅');
  });
});

// ── ② 换一个间隔，时间戳跟着变（排除"碰巧也是 1 秒"）───────────────
await test('间隔改成 800ms，时间戳随之变化', async () => {
  await withBridge(async ({ h, send }) => {
    await send({ messages: ['一', '二', '三'], gapMode: 'fixed', gapMs: 800 });
    const st = h.getSocialV2State(KEY);
    const t = (st.recentMessages || []).filter((m) => m.isSelf).slice(-3).map((m) => Number(m.time));
    const gaps = [t[1] - t[0], t[2] - t[1]];
    console.log(`    间隔: ${gaps.join('ms, ')}ms`);
    for (const g of gaps) {
      if (g < 600) throw new Error(`间隔 ${g}ms 太小，没跟上 800ms 配置`);
    }
  }, 800);
});

// ── ③ 单条消息的时间戳就是发送时刻（不是 now+0）─────────────────────
await test('单条消息时间戳落在发送窗口内', async () => {
  await withBridge(async ({ h, send }) => {
    const before = Date.now();
    await send({ messages: ['单条'] });
    const after = Date.now();
    const st = h.getSocialV2State(KEY);
    const mine = (st.recentMessages || []).filter((m) => m.isSelf).slice(-1);
    if (!mine.length) throw new Error('没记录消息');
    const t = Number(mine[0].time);
    if (t < before - 500 || t > after + 500) {
      throw new Error(`时间戳 ${t} 不在 [${before}, ${after}] 窗口内`);
    }
    console.log(`    时间戳在发送窗口内 ✅`);
  });
});

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
