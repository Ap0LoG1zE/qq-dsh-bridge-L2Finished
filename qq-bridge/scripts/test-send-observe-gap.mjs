// 回归：多条数组发送期间到达的消息不能被漏掉（2026-11-17 操作者实测）。
//
// 真实故障（session-772b7a56）：
//   20:53:50  她调 qq_send_message，messages 是 3 条数组
//   20:54:01  [pace] 开始观望 已有未读=1     ← 11 秒后才开始观望
//   20:54:21  观望结束，带回 2 条
//   操作者在 20:53:50~20:54:01 之间发的消息进了盲区：既不算"观望期间新到"，
//   也不会被带回去。
//
// 根因：sendMessagesV2 按数组间隔逐条发（1~3 秒/条），3 条约 5~10 秒。
// 那期间没有任何等待机制在跑，等 paceAfterSendV2 拍快照时那些消息已经算
// "已有未读"。
//
// 修法：发送**之前**拍快照（snapshotUnreadBeforeSendV2），传给
// paceAfterSendV2 当基线 —— 发送期间 + 观望期间到达的都算 fresh。
//
// 本文件锁住这个契约。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
let failures = 0;
let tests = 0;

// 时间压到百毫秒级，避免每个用例等 30 秒
const SEND_OBSERVE_MS = 800;   // 发送后观望多久
const QUIET_MS = 400;          // 来了消息后等安静多久
const GAP_MS = 300;            // 数组内每条之间的间隔

async function withBridge(run) {
  const h = await bridgeHarness({ config: { socialV2: {
    send: {
      minSendIntervalMs: 0,
      observeAfterSendMs: SEND_OBSERVE_MS,
      observeQuietMs: QUIET_MS,
      maxSendPerMinute: 100, maxSendPerHour: 100,
    },
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
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.end(JSON.stringify({ key: KEY, ...body }));
  });
  const append = (text) => {
    const cur = h.getSocialV2State(KEY);
    const seq = cur.lastUnreadSeq + 1;
    h.appendSocialV2Message(KEY, 'fixture-person', text, text, false, false, `fx-${seq}`, [], '789');
    return seq;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try { await run({ h, st, request, append, sleep }); }
  finally { await new Promise((r) => server.close(r)); await h.close(); }
}

async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '—', e?.stack ?? e); }
}

// ── 核心：数组发送期间到达的消息必须被带回去 ────────────────────────────
await test('3 条数组逐条发送期间到达的消息，必须在返回里带回去', async () => {
  await withBridge(async ({ request, append, sleep }) => {
    const t0 = Date.now();
    // 发 3 条，固定 300ms 间隔 —— 发送本身约 600ms
    const p = request('send-message', { messages: ['第一条', '第二条', '第三条'], gapMode: 'fixed', gapMs: GAP_MS });

    // 在"逐条发送"进行中插一句话（这是原来的盲区）
    await sleep(Math.round(GAP_MS * 1.2));   // 约 360ms，第 2 条刚发完
    const midSeq = append('发送期间插的话');
    console.log(`    发送期间插入 #${midSeq}`);

    const r = await p;
    const elapsed = Date.now() - t0;

    assert.equal(r.status, 200, `实际：${JSON.stringify(r.data)}`);
    const text = String(r.data.text ?? '');
    assert.match(text, /发送期间插的话/,
      `发送期间到达的消息必须被带回去（盲区修复），实际返回：\n${text || '(无 text)'}`);
    assert.match(text, /条新消息/, '应当按【N 条新消息】格式贴出');
    console.log(`    耗时 ${elapsed}ms，返回里带回了 1 条`);
  });
});

// ── 发送期间 + 观望期间各来一条，两条都要带 ────────────────────────────
await test('发送期间与观望期间各到一条，两条都要带回', async () => {
  await withBridge(async ({ request, append, sleep }) => {
    const p = request('send-message', { messages: ['A', 'B', 'C'], gapMode: 'fixed', gapMs: GAP_MS });

    // ① 发送期间
    await sleep(Math.round(GAP_MS * 1.2));
    append('发送中来的一条');

    // ② 观望期间（发送完成之后）
    await sleep(GAP_MS * 2 + 200);
    append('观望中来的一条');

    const r = await p;
    const text = String(r.data.text ?? '');
    assert.match(text, /发送中来的一条/, `发送期间那条没带回：\n${text}`);
    assert.match(text, /观望中来的一条/, `观望期间那条没带回：\n${text}`);
    assert.match(text, /2 条新消息/, `应当合计 2 条：\n${text}`);
  });
});

// ── 发送前就存在的未读，不该被当成 fresh 重复贴 ─────────────────────────
await test('发送前已在 unread 里的旧消息，不应被当成新消息贴出', async () => {
  await withBridge(async ({ request, append }) => {
    // 先放一条，且不让它进 modelSeenSeqs
    const oldSeq = append('发送前就有的旧消息');
    await new Promise((r) => setTimeout(r, 50));

    const r = await request('send-message', { messages: ['一句话'] });
    assert.equal(r.status, 200, `实际：${JSON.stringify(r.data)}`);
    const text = String(r.data.text ?? '');
    assert.doesNotMatch(text, /发送前就有的旧消息/,
      `旧消息不该被当成 fresh 重复贴：\n${text}`);
    void oldSeq;
  });
});

// ── 单条发送不受影响（不回归）──────────────────────────────────────────
await test('单条发送后观望仍正常工作', async () => {
  await withBridge(async ({ request, append, sleep }) => {
    const p = request('send-message', { messages: ['就一句'] });
    await sleep(150);
    append('对方接了一句');
    const r = await p;
    assert.match(String(r.data.text ?? ''), /对方接了一句/, '单条路径也要能带回消息');
  });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
