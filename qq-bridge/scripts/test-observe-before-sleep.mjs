// 发送后观望（paceAfterSendV2）+ 收尾不观望 的回归（2026-11-15 定稿）。
//
// 历史：这个文件原来测的是「收尾前观望」（qq_mark_read / qq_set_wake_config
// 各自空转 10~20 秒盯新消息）。操作者在 2026-11-15 要求把那两个观望**整个删掉**：
//
//   「如果在两个工具中间发了消息，就进到 unread 里了，得下一次等待才能一起发给她」
//
// 也就是说观望根本覆盖不了真正的空隙 —— 它只盯着"收尾这一瞬间"，
// 而消息落在两次工具调用之间时照样要等到下一次才被看见，却每次都要白等 10 秒。
//
// 现在的契约：
//   ① `qq_mark_read` / `qq_set_wake_config` **不空转**，尽快返回；
//      没读的消息照旧用 uncovered 拦截分支贴出来（这条没变）。
//   ② `qq_send_message` 发完之后**等满 minSendIntervalMs（20 秒）**看对方接不接；
//      期间来消息就带回去（安静窗合并），没来就正常返回。
//   ③ 观望期间压住唤醒调度，避免同一批消息被处理两遍。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const seqs = (messages) => Array.from(messages ?? [], (m) => m.seq);
let failures = 0;
let tests = 0;

// 时间参数压到百毫秒级，不让单个用例等 20 秒。
const SEND_OBSERVE_MS = 600;   // 发送后空转多久（= send.observeAfterSendMs）
const SEND_QUIET_MS = 300;     // 来消息后等安静多久

async function withBridge(run, { wakeConfig, config = {} } = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    send: {
      minSendIntervalMs: 100, observeAfterSendMs: SEND_OBSERVE_MS,
      observeQuietMs: SEND_QUIET_MS,
      maxSendPerMinute: 100, maxSendPerHour: 100,
    },
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    proactive: { enabled: false },
    sticker: { enabled: false },
    ...config
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  if (wakeConfig) st.wakeConfig = { ...st.wakeConfig, ...wakeConfig };
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { body, token = st.agentToken, key = KEY } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (token) headers['x-agent-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}`,
      method: body === undefined ? 'GET' : 'POST', headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = (text) => {
    const cur = h.getSocialV2State(KEY);
    const seq = cur.lastUnreadSeq + 1;
    h.appendSocialV2Message(KEY, 'fixture-person', text, text, false, false, `fixture-${seq}`, [], '789');
    return seq;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try { await run({ h, st, request, append, sleep }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

async function test(name, run, opts) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 1. 收尾不再空转（核心新契约）─────────────────────────────────────────
await test('mark_read 不再空转：潜水会话下立即返回，不再白等', async () => {
  await withBridge(async ({ st, request, append }) => {
    append('先来一句');
    await request('unread'); // 她看过了
    st.wakeConfig = { ...st.wakeConfig, mode: 'diving', infinite: true,
      triggers: { ...st.wakeConfig.triggers, anyMessage: false } };

    const t0 = Date.now();
    const r = await request('mark-read', { body: { throughSeq: 1 } });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200, `应正常收尾，实际：${JSON.stringify(r.data)}`);
    // 旧实现这里会先等 10~20 秒。现在必须几乎立刻返回。
    assert.ok(elapsed < SEND_OBSERVE_MS, `不该再有空转，实际耗时 ${elapsed}ms`);
  });
});

await test('set_wake_config 不再空转：立刻设置完成', async () => {
  await withBridge(async ({ st, request, append }) => {
    append('先来一句');
    await request('unread');
    const t0 = Date.now();
    const r = await request('wake-config', { body: { config: { mode: 'diving', infinite: true,
      triggers: { atMention: true } } } });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200, `实际：${JSON.stringify(r.data)}`);
    assert.ok(elapsed < SEND_OBSERVE_MS, `不该再有空转，实际耗时 ${elapsed}ms`);
  });
});

// ── 2. 没读的消息照旧贴出来（这条语义没被删观望带走）──────────────────────
await test('还有没读的消息时，收尾仍然把它贴出来（不是静默标已读）', async () => {
  await withBridge(async ({ st, request, append }) => {
    append('她没看过的一条');
    // 故意不给水位、也不调 unread —— 这条从未展示给她
    st.wakeConfig = { ...st.wakeConfig, mode: 'diving', infinite: true,
      triggers: { ...st.wakeConfig.triggers, anyMessage: false } };
    const r = await request('mark-read', { body: {} });
    assert.equal(r.status, 400, '没读过就必须拦，不能静默标已读');
    assert.match(String(r.data.text ?? ''), /她没看过的一条/);
    assert.deepEqual(seqs(st.unread), [1], '拦下来时不能标掉');
  });
});

// ── 3. 发送后等 20 秒（这里按比例压到 600ms）────────────────────────────
await test('send_message 发完会停下来等：期间来消息就带回去', async () => {
  await withBridge(async ({ st, request, append, sleep }) => {
    const t0 = Date.now();
    const p = request('send-message', { body: { messages: ['我先去忙一下'] } });
    await sleep(150);
    append('那你忙完叫我');
    const r = await p;
    const elapsed = Date.now() - t0;

    assert.equal(r.status, 200, `实际：${JSON.stringify(r.data)}`);
    assert.match(String(r.data.text ?? ''), /条新消息/, '期间来的消息必须贴回来');
    assert.match(String(r.data.text ?? ''), /忙完叫我/);
    // 至少要过安静窗，说明它真的等了而不是立刻返回。
    assert.ok(elapsed >= SEND_QUIET_MS, `应当等过安静窗，实际 ${elapsed}ms`);
  });
});

await test('send_message 期间没人说话：等满 observeAfterSendMs 后正常返回', async () => {
  await withBridge(async ({ request }) => {
    const t0 = Date.now();
    const r = await request('send-message', { body: { messages: ['一句话'] } });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200, `实际：${JSON.stringify(r.data)}`);
    assert.equal(r.data.text, undefined, '没人说话时不该有 text');
    assert.ok(elapsed >= SEND_OBSERVE_MS, `应当等满 ${SEND_OBSERVE_MS}ms，实际 ${elapsed}ms`);
  });
});

// ── 5. 连发合并：安静窗内又来一条，要一起贴、而且计时器重置 ───────────────
//
// 操作者的实际诉求（2026-11-15）：「我每次聊天得发很快才能卡在 5 秒内，太短了」。
// 也就是说他在连发几句，而窗口太短的话第一句就被单独贴回去、后面几句变成下一轮。
// 这条断言两件事：① 两条都进同一次返回；② 计时器确实被第二条重置（总耗时 > 一个安静窗）。
await test('安静窗内连发两条：合并成一次贴回，且计时器被重置', async () => {
  await withBridge(async ({ request, append, sleep }) => {
    const t0 = Date.now();
    const p = request('send-message', { body: { messages: ['我先说一句'] } });
    await sleep(120);
    append('第一句');                              // 落进观望
    await sleep(Math.round(SEND_QUIET_MS * 0.5));  // 仍在安静窗内
    append('第二句');                              // 应当把计时器往后推
    const r = await p;
    const elapsed = Date.now() - t0;

    assert.equal(r.status, 200, `实际：${JSON.stringify(r.data)}`);
    const text = String(r.data.text ?? '');
    assert.match(text, /第一句/, '第一句要在');
    assert.match(text, /第二句/, '第二句也要一起在（不能被切到下一轮）');
    assert.match(text, /2 条新消息/, `必须合并成一次两条，实际：${text}`);
    // 重置证据：如果没重置，它会在 120+quietMs 就返回；重置后要再等一个 quietMs。
    assert.ok(elapsed >= SEND_QUIET_MS * 1.5,
      `计时器应被第二条重置（总耗时 ≥ 1.5 个安静窗），实际 ${elapsed}ms`);
  });
});

// ── 6. 20 秒是"发完之后额外等"，不是数组内部间隔的替代 ────────────────────
//
// 操作者澄清的语义：`空转时间 = Σ(数组内间隔) + 20秒`。
// 数组间隔由 sendMessagesV2 真的 sleep 掉（见那边的 sendChain.then(sleep)），
// 所以 paceAfterSendV2 只需要补那 20 秒。
// 这条用例确认：3 条数组时，总耗时 ≈ 间隔之和 + observeAfterSendMs，而不是只有 20 秒。
await test('多条数组：发送耗时算进总预算，不是发完再等满', async () => {
    await withBridge(async ({ request }) => {
      const t0 = Date.now();
      const r = await request('send-message', { body: { messages: ['一', '二', '三'], gapMode: 'fixed', gapMs: 300 } });
      const elapsed = Date.now() - t0;
      assert.equal(r.status, 200, `实际：${JSON.stringify(r.data)}`);
      // 2026-11-17 操作者改了口径：「总预算 = 发送那几秒 + 20 秒」——
      // 发送耗时**包含在**预算里，不是"发完再额外等满"。
      const sendCost = 300 * 2;                    // 2 个间隔
      const naiveSum = sendCost + SEND_OBSERVE_MS; // 旧语义下的总耗时
      assert.ok(elapsed < naiveSum - 100,
        `总耗时 ${elapsed}ms 接近"发完再等满"(${naiveSum}ms)，说明发送耗时没被算进预算`);
      assert.ok(elapsed >= SEND_OBSERVE_MS - 150,
        `总耗时 ${elapsed}ms 太短，预算 ${SEND_OBSERVE_MS}ms 没生效`);
    });
  });

await test('单条消息：没有数组间隔，只等 observeAfterSendMs', async () => {
  await withBridge(async ({ request }) => {
    const t0 = Date.now();
    await request('send-message', { body: { messages: ['一句话'] } });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= SEND_OBSERVE_MS,
      `单条也应等满 ${SEND_OBSERVE_MS}ms，实际 ${elapsed}ms`);
  });
});

// ── 5. 观望期间压住唤醒（避免同一批处理两遍）─────────────────────────────
await test('发送后观望进行中不排唤醒', async () => {
  await withBridge(async ({ h, st, request, append, sleep }) => {
    st.pendingWakeTimer = null;
    const p = request('send-message', { body: { messages: ['说一句'] } });
    await sleep(120);
    append('观望中来的');
    h.scheduleWakeV2(KEY, 'message');
    const duringObserve = st.pendingWakeTimer;
    await p;
    assert.equal(duringObserve, null,
      '观望进行中不应挂唤醒定时器 —— 否则那批消息会在观望内、观望后各处理一遍');
  });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);


