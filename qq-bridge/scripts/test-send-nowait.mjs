// 验证 noWait（2026-11-19 操作者要求）。
//
// 语义：她传 noWait:true 后，**不是跳过空转**，而是只等"句末那一截"：
//   句间实际消耗 + 末尾再随机一段（与句间**同一套随机逻辑**），然后返回，
//   因此可以马上再调一次 qq_send_message。
// 期间来的消息不刷新计时，空转结束后一次性贴回。
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const BUDGET_MS = 3000;    // 正常空转的完整预算（要足够长，才能看出 noWait 明显更短）
const QUIET_MS = 800;
const GAP_MS = 300;

let pass = 0;
let fail = 0;

async function withBridge(run) {
  const h = await bridgeHarness({ config: { socialV2: {
    send: {
      minSendIntervalMs: 0,
      observeAfterSendMs: BUDGET_MS,
      observeQuietMs: QUIET_MS,
      burstIntervalMinMs: GAP_MS,
      burstIntervalMaxMs: GAP_MS,   // 钉死随机区间 → 句末那截可预测 300ms
      maxSendPerMinute: 100, maxSendPerHour: 100,
    },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));

  const request = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(KEY)}`,
      method: 'POST',
      headers: {
        'x-console-token': 'fixture-console-token',
        'x-agent-token': st.agentToken,
        'content-type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end(JSON.stringify({ key: KEY, ...body }));
  });

  const append = (text) => {
    const cur = h.getSocialV2State(KEY);
    const seq = cur.lastUnreadSeq + 1;
    h.appendSocialV2Message(KEY, 'fixture-person', text, text, false, false, `fx-${seq}`, [], '789');
    return seq;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try { await run({ h, request, append, sleep }); }
  finally { await new Promise((r) => server.close(r)); await h.close(); }
}

async function test(name, run) {
  try { await run(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, '—', e.message); }
}

// ── ① noWait 明显比正常空转短 ────────────────────────────────────────
await test('noWait:true 只等句末一截，不等完整预算', async () => {
  await withBridge(async ({ request }) => {
    const t0 = Date.now();
    const r = await request('send-message', { messages: ['一句话'], noWait: true });
    const elapsed = Date.now() - t0;
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    // 句末那截钉死在 300ms；完整预算 3000ms。留足余量。
    if (elapsed >= BUDGET_MS) {
      throw new Error(`耗时 ${elapsed}ms 不小于完整预算 ${BUDGET_MS}ms，noWait 没生效`);
    }
    console.log(`    耗时 ${elapsed}ms（完整预算 ${BUDGET_MS}ms）`);
  });
});

// ── ② 不传 noWait 时行为不变（防回归）────────────────────────────────
await test('不传 noWait 仍然等完整预算', async () => {
  await withBridge(async ({ request }) => {
    const t0 = Date.now();
    await request('send-message', { messages: ['一句话'] });
    const elapsed = Date.now() - t0;
    if (elapsed < BUDGET_MS - 200) {
      throw new Error(`耗时 ${elapsed}ms 少于预算 ${BUDGET_MS}ms，默认路径被改坏了`);
    }
    console.log(`    耗时 ${elapsed}ms（仍等满预算 ✅）`);
  });
});

// ── ③ noWait 之后能立刻再调一次（核心目的）──────────────────────────
await test('noWait 之后可以马上再调一次发送', async () => {
  await withBridge(async ({ request }) => {
    const t0 = Date.now();
    const r1 = await request('send-message', { messages: ['第一段'], noWait: true });
    const afterFirst = Date.now() - t0;
    const r2 = await request('send-message', { messages: ['第二段'], noWait: true });
    const total = Date.now() - t0;
    if (r1.status !== 200 || r2.status !== 200) throw new Error(`状态 ${r1.status}/${r2.status}`);
    if (Number(r2.data?.sent) !== 1) throw new Error(`第二次没发出去：${JSON.stringify(r2.data)}`);
    // 两次都只等句末一截 ⇒ 总耗时约 2×300ms，远小于一个完整预算
    if (total >= BUDGET_MS) {
      throw new Error(`两次共 ${total}ms，不该超过一个完整预算 ${BUDGET_MS}ms`);
    }
    console.log(`    第一次 ${afterFirst}ms，两次共 ${total}ms —— 可以连着发 ✅`);
  });
});

// ── ④ 句末那截与句间用同一套随机逻辑 ─────────────────────────────────
await test('句末那一截与句间间隔同区间（把区间钉死即可验证）', async () => {
  await withBridge(async ({ request }) => {
    const t0 = Date.now();
    // 发 2 条：句间 1 个 300ms 间隔 + 句末 1 个 300ms
    await request('send-message', { messages: ['甲', '乙'], gapMode: 'fixed', gapMs: GAP_MS, noWait: true });
    const elapsed = Date.now() - t0;
    // 语义是 300(句间) + ~300(句末)，而不是 300 或 300+3000
    if (elapsed < GAP_MS * 1.5) {
      throw new Error(`耗时 ${elapsed}ms 太短，句末那截没等`);
    }
    if (elapsed > BUDGET_MS) {
      throw new Error(`耗时 ${elapsed}ms 太长，等成了完整预算`);
    }
    console.log(`    耗时 ${elapsed}ms ≈ 句间 ${GAP_MS} + 句末 ${GAP_MS} ✅`);
  });
});

// ── ⑤ 期间来的消息仍然被带回（不刷新计时）───────────────────────────
await test('noWait 期间来的消息在结束后一次性贴回', async () => {
  await withBridge(async ({ request, append, sleep }) => {
    const p = request('send-message', { messages: ['一句话'], noWait: true });
    await sleep(120);
    append('空转期间插的话');
    const r = await p;
    const text = String(r.data?.text ?? '');
    if (!/空转期间插的话/.test(text)) {
      throw new Error(`消息没带回：\n${text || '(无 text)'}`);
    }
    console.log('    消息已带回 ✅');
  });
});

// ── ⑥ 传 noWait:false 等价于不传 ────────────────────────────────────
await test('noWait:false 与不传等价（仍等完整预算）', async () => {
  await withBridge(async ({ request }) => {
    const t0 = Date.now();
    await request('send-message', { messages: ['一句话'], noWait: false });
    const elapsed = Date.now() - t0;
    if (elapsed < BUDGET_MS - 200) {
      throw new Error(`耗时 ${elapsed}ms，noWait:false 不该缩短空转`);
    }
    console.log(`    耗时 ${elapsed}ms ✅`);
  });
});

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
