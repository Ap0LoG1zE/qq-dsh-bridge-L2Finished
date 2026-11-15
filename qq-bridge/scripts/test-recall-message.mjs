// qq_recall_message 的回归（2026-11-15）。
//
// 契约（操作者定的）：
//   ① **按原文撤回**：她把自己刚说过的那句话传进来，桥接自动匹配。
//      —— 她自己的消息**没有 seq**（那是入站未读水位的编号），
//         也不该让她记 message_id，所以「按原文」是唯一自然的方式。
//   ② 只能撤**自己刚发的**：别人的消息 / 没说过的话一律拒绝。
//   ③ **超过 2 分钟不管**：QQ 撤回时限就是 2 分钟，提前拦下省一次往返。
//   ④ 输入输出精简：成功一句 `✅ 已撤回`，失败一句中文原因。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
let failures = 0;
let tests = 0;

async function withBridge(run) {
  const h = await bridgeHarness({ config: { socialV2: {
    // 发送后空转关掉：本文件只关心撤回，不想为每次发送等 20 秒。
    send: { minSendIntervalMs: 0, observeAfterSendMs: 0, maxSendPerMinute: 100, maxSendPerHour: 100 },
    proactive: { enabled: false },
    sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(KEY)}`,
      method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end(JSON.stringify({ key: KEY, ...body }));
  });
  const append = (text) => {
    const cur = h.getSocialV2State(KEY);
    const seq = cur.lastUnreadSeq + 1;
    h.appendSocialV2Message(KEY, 'fixture-person', text, text, false, false, `fx-${seq}`, [], '789');
    return seq;
  };
  try { await run({ h, st, request, append }); }
  finally { await new Promise((r) => server.close(r)); await h.close(); }
}

async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '—', e?.stack ?? e); }
}

// 发送并用返回里的 ids 建立回执（harness 的 fake fetch 会给 message_id）
async function sendAndGetReceipts(ctx, ...texts) {
  const { st, request } = ctx;
  for (const t of texts) {
    const r = await request('send-message', { messages: [t] });
    assert.equal(r.status, 200, `发送失败：${JSON.stringify(r.data)}`);
  }
  return st.sentReceipts || [];
}

// ── 1. 自己的消息**不带 seq**（操作者明确要求）─────────────────────────────
await test('自己发出的消息不带 seq（那是入站未读水位的编号）', async () => {
  await withBridge(async (ctx) => {
    const { st, request } = ctx;
    await request('send-message', { messages: ['我发的'] });
    const mine = st.recentMessages.filter((m) => m.isSelf);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].seq, undefined,
      `自己的消息不该有 seq，实际 ${mine[0].seq} —— 会和未读水位混成两套编号`);
  });
});

// ── 2. 按原文撤回成功 ────────────────────────────────────────────────────
await test('按原文撤回成功，回执被清掉（不能重复撤）', async () => {
  await withBridge(async (ctx) => {
    const { st, request } = ctx;
    await sendAndGetReceipts(ctx, '这条要撤回');

    const r1 = await request('recall-message', { text: '这条要撤回' });
    assert.equal(r1.status, 200, `撤回应成功，实际：${JSON.stringify(r1.data)}`);
    assert.equal(r1.data.ok, true);
    assert.equal(r1.data.text, '✅ 已撤回', '输出要精简成一句话');

    // 回执已删 → 再撤一次必须说"没找到"
    const r2 = await request('recall-message', { text: '这条要撤回' });
    assert.equal(r2.status, 400, '同一句不能撤两次');
    assert.match(String(r2.data.error ?? ''), /没找到这句/);
  });
});

// ── 3. 只给原文的一段也能命中 ────────────────────────────────────────────
await test('只传原文的一段也能命中', async () => {
  await withBridge(async (ctx) => {
    const { request } = ctx;
    await sendAndGetReceipts(ctx, '我其实想说那个事情来着');
    const r = await request('recall-message', { text: '其实想说' });
    assert.equal(r.status, 200, `片段应能匹配，实际：${JSON.stringify(r.data)}`);
  });
});

// ── 4. 多条命中时撤**最新**那条 ──────────────────────────────────────────
await test('同一段话发过多次时，撤最新那条', async () => {
  await withBridge(async (ctx) => {
    const { st, request } = ctx;
    await sendAndGetReceipts(ctx, '嗯');
    const firstAt = st.sentReceipts[st.sentReceipts.length - 1].at;
    await new Promise((r) => setTimeout(r, 30));
    await sendAndGetReceipts(ctx, '嗯');

    const before = st.sentReceipts.length;
    const r = await request('recall-message', { text: '嗯' });
    assert.equal(r.status, 200, `实际：${JSON.stringify(r.data)}`);
    assert.equal(st.sentReceipts.length, before - 1, '只该撤掉一条');
    // 剩下那条应当是**较早**的（最新的被撤了）
    const left = st.sentReceipts.find((x) => String(x.text).trim() === '嗯');
    assert.ok(left, '较早那条应还在');
    assert.equal(left.at, firstAt, '撤掉的应当是最新那条');
  });
});

// ── 5. 别人的消息撤不了 ──────────────────────────────────────────────────
await test('别人说的话撤不了（没发过就没有回执）', async () => {
  await withBridge(async (ctx) => {
    const { request, append } = ctx;
    append('对方说的这句话');
    const r = await request('recall-message', { text: '对方说的这句话' });
    assert.equal(r.status, 400, '不能撤别人的消息');
    assert.match(String(r.data.error ?? ''), /没找到这句/);
  });
});

// ── 6. 超 2 分钟直接拦下，不做网络尝试 ───────────────────────────────────
await test('超过 2 分钟直接拒绝，不尝试撤回', async () => {
  await withBridge(async (ctx) => {
    const { h, st, request } = ctx;
    await sendAndGetReceipts(ctx, '三分钟前说的');
    // 把回执时刻往前拨 3 分钟
    st.sentReceipts[st.sentReceipts.length - 1].at = Date.now() - 3 * 60 * 1000;

    const r = await request('recall-message', { text: '三分钟前说的' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, '超过 2 分钟，撤不回了');
    assert.ok(h.calls.http.every((c) => !String(c.url).includes('delete_msg')),
      '超时的不该发起 delete_msg 请求');
  });
});

// ── 7. 空原文 / 超长原文 ─────────────────────────────────────────────────
await test('空原文与超长原文都被明确拒绝', async () => {
  await withBridge(async (ctx) => {
    const { request } = ctx;
    for (const bad of ['', '   ']) {
      const r = await request('recall-message', { text: bad });
      assert.equal(r.status, 400, `text=${JSON.stringify(bad)} 应被拒`);
      assert.match(String(r.data.error ?? ''), /要撤回哪句/);
    }
    const r = await request('recall-message', { text: 'x'.repeat(600) });
    assert.equal(r.status, 400);
    assert.match(String(r.data.error ?? ''), /原文太长/);
  });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
