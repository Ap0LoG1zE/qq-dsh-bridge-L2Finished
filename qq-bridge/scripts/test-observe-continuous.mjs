// 锁定操作者 2026-11-17 定的观望语义：
//
//   「总预算 = 发送那几秒 + 20 秒；期间我发了消息就重置为 10 秒倒计时，
//     无最长，直到 10 秒倒计时结束才贴给她」
//
// 三个必须同时成立的契约：
//   ① 总预算**包含**发送耗时（不是"发完再等 20 秒"）
//   ② 来一条消息 → 安静计时重置为 10 秒（不是从第一条开始一路计到 10 秒）
//   ③ 无额外上限：只要还在 10 秒内来消息，就一直不返回
//
// 这里用很短的时间参数来测（不真等 20 秒），但比例关系一致。
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const BUDGET_MS = 1200;   // 模拟"发送几秒 + 20 秒"里的那段预算
const QUIET_MS = 500;     // 模拟 10 秒安静窗
// ⚠️ 间隔不是想设多少就多少：clampGapV2 会把间距夹到
// [burstIntervalMinMs, maxGapMs]，默认下界是 300ms。
// 设 200 实际会用 300 —— 算发送耗时必须按 300 算，否则断言会误判。
const GAP_MS = 300;
const GAP_MIN_MS = 300;

let failures = 0;
let tests = 0;

async function withBridge(run) {
  const h = await bridgeHarness({ config: { socialV2: {
    send: {
      minSendIntervalMs: 0,
      observeAfterSendMs: BUDGET_MS,
      observeQuietMs: QUIET_MS,
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
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '—', e?.stack ?? e); }
}

// ── ② 来一条就重置安静计时（核心）────────────────────────────────────
await test('连续来消息时，每条都把 10 秒安静窗顶回起点（不会攒到 10 秒就返回）', async () => {
  await withBridge(async ({ request, append, sleep }) => {
    const t0 = Date.now();
    const p = request('send-message', { messages: ['A', 'B'], gapMode: 'fixed', gapMs: GAP_MS });

    // 在安静窗快到期（QUIET_MS 的 80%）时再补一条，模拟"对方还在聊"
    // 若实现没有重置，这里会直接返回，第三条就没机会被带到。
    await sleep(QUIET_MS * 0.8);
    append('第一条补充');
    await sleep(QUIET_MS * 0.8);
    append('第二条补充');

    const r = await p;
    const elapsed = Date.now() - t0;
    const text = String(r.data.text ?? '');

    // 关键断言：两条补充都必须在同一次返回里
    if (!/第一条补充/.test(text)) throw new Error(`第一条补充丢了：\n${text || '(无 text)'}`);
    if (!/第二条补充/.test(text)) throw new Error(`第二条补充丢了（说明没有重置安静窗）：\n${text}`);
    // 而且实际耗时应当明显超过单个安静窗 —— 这正是"被重置过"的证据
    if (elapsed < QUIET_MS * 1.5) {
      throw new Error(`耗时 ${elapsed}ms 太短，说明安静窗没有被重置（应为 >${QUIET_MS * 1.5}ms）`);
    }
    console.log(`    耗时 ${elapsed}ms，两条补充都带回`);
  });
});

// ── ① 总预算包含发送耗时 ─────────────────────────────────────────────
await test('发送本身耗时算进总预算（不是发完再等满预算）', async () => {
  await withBridge(async ({ request, sleep }) => {
    // 发 4 条、每条间隔 200ms ⇒ 发送要花约 600ms，占 BUDGET_MS(1200) 的一半
    const t0 = Date.now();
    const p = request('send-message', { messages: ['1', '2', '3', '4'], gapMode: 'fixed', gapMs: GAP_MS });
    const r = await p;
    const elapsed = Date.now() - t0;
    const sendCost = GAP_MIN_MS * 3;   // 4 条 = 3 个间隔，每个按钳制后的最小值算

    // 没人说话时，总耗时 ≈ 发送耗时 + 剩余预算（BUDGET - sendCost）≈ BUDGET
    // 若实现是"发完再等满 BUDGET"，总耗时会接近 sendCost + BUDGET
    const naive = sendCost + BUDGET_MS;
    const budgetOnly = BUDGET_MS;
    // 判据：应当明显短于"发完再等满"，并且接近"总预算"本身
    if (elapsed > naive - 300) {
      throw new Error(`总耗时 ${elapsed}ms 接近"发完再等满预算"(${naive}ms)，说明发送耗时没从预算里扣`);
    }
    if (elapsed > budgetOnly + 600) {
      throw new Error(`总耗时 ${elapsed}ms 明显超过总预算 ${budgetOnly}ms，预算没生效`);
    }
    console.log(`    发送 ${sendCost}ms + 观望，总耗时 ${elapsed}ms（预算 ${budgetOnly}ms，未叠满 ✅）`);
    void r;
    void sleep;
  });
});

// ── ③ 无额外上限：一直在聊就一直等 ────────────────────────────────────
await test('对方持续发言时不因"到点"提前返回（只由安静窗结束）', async () => {
  await withBridge(async ({ request, append, sleep }) => {
    const p = request('send-message', { messages: ['一句话'] });

    // 每隔安静窗 60% 就发一条，连发 4 轮 —— 总时长会超过 BUDGET_MS
    // 若存在旧的 20 秒硬顶那种"到点就收"逻辑，中途就会返回、后面的消息带不回
    for (let i = 1; i <= 4; i += 1) {
      await sleep(QUIET_MS * 0.6);
      append(`第 ${i} 轮发言`);
    }

    const r = await p;
    const text = String(r.data.text ?? '');
    for (let i = 1; i <= 4; i += 1) {
      if (!new RegExp(`第 ${i} 轮发言`).test(text)) {
        throw new Error(`第 ${i} 轮丢了 —— 说明中途被上限截断了：\n${text || '(无 text)'}`);
      }
    }
    console.log('    4 轮发言全部带回（期间超过预算也没被截断）');
  });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
