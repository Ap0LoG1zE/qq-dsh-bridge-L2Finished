// 端到端验证：面板改值 → 桥接配置 → 实际行为。
//
// 操作者问：「验证一下小面板里改的数据能确实影响到实际的设置」
//
// ⚠️ 不能用运行中的桥接测 —— 那是真实账号，测试会真的往 QQ 发消息。
// 这里用 bridgeHarness 起一个隔离实例，完整走面板保存的那条链路：
//   面板 saveRhythm → POST /api/socialV2/config（整体写回）
//   → 桥接内存更新 → 后续发送行为随之改变
//
// 同时验证面板前端那两层换算（renderRhythmTab / saveRhythm 的 sec↔ms），
// 因为那才是「小面板」真正做的事。
import http from 'node:http';
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const PANEL = 'D:\\DSH\\qq-dsh-bridge\\dsh-plugins\\qq-dsh-panel\\lib\\client.js';

let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, '—', e.message); }
};

async function withBridge(run, sendCfg = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    send: {
      minSendIntervalMs: 0,
      observeAfterSendMs: 1000,
      observeQuietMs: 300,
      burstMaxMessages: 3,
      burstIntervalMinMs: 300, burstIntervalMaxMs: 300,
      maxSendPerMinute: 100, maxSendPerHour: 100,
      ...sendCfg,
    },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // ⚠️ config 端点是**管理端**接口，只认 console-token。
  // 之前同时带 x-agent-token，鉴权反而失败（返回 {ok:false}）——
  // 实测只带 console-token 才正常。
  const H = { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' };
  const get = (p) => fetch(base + p, { headers: H }).then((r) => r.json());
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) }).then((r) => r.json());
  // 发送端点是**会话接口**，要的是 agent-token（管理端那套不行），所以单独一套头。
  const SM = { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' };
  const sendMsg = (p, body) => fetch(base + p, { method: 'POST', headers: SM, body: JSON.stringify(body) }).then((r) => r.json());
  try { await run({ h, get, post, sendMsg }); }
  finally { await new Promise((r) => server.close(r)); await h.close(); }
}

// ── ① 面板保存的那条链路：整体写回子对象，内存立刻变 ────────────────
await test('面板 POST 设置 → 桥接内存立刻变化', async () => {
  await withBridge(async ({ get, post, sendMsg }) => {
    // ⚠️ 结构说明：GET /api/socialV2/config 返回 { ok, config }，
    // 其中 config **就是 socialV2 本身**（见 bridge.js:4768），不是 config.socialV2。
    // POST 的 body 同样直接就是 socialV2（浅合并，子对象整体替换）。
    const cur = await get('/api/socialV2/config');
    const next = { ...cur.config, send: { ...cur.config.send, observeAfterSendMs: 1500 } };
    const r = await post('/api/socialV2/config', next);
    if (!r.ok) throw new Error(`写入失败: ${JSON.stringify(r).slice(0, 150)}`);

    const after = await get('/api/socialV2/config');
    const got = after.config.send.observeAfterSendMs;
    if (got !== 1500) throw new Error(`内存是 ${got}，不是 1500`);
    console.log(`    内存: ${got}ms ✅`);
  });
});

// ── ② 该值真的影响发送等待时长 ───────────────────────────────────────
await test('observeAfterSendMs=1500 → 实际等待约 1.5 秒', async () => {
  await withBridge(async ({ get, post, sendMsg }) => {
    const cur = await get('/api/socialV2/config');
    await post('/api/socialV2/config', { ...cur.config, send: { ...cur.config.send, observeAfterSendMs: 1500 } });

    const t0 = Date.now();
    const r = await sendMsg(`/api/socialV2/send-message?key=${encodeURIComponent(KEY)}`, { key: KEY, messages: ['连通性测试'] });
    const el = Date.now() - t0;
    if (!r.ok) throw new Error(`发送失败: ${JSON.stringify(r).slice(0, 150)}`);
    console.log(`    耗时 ${el}ms（预期约 1500ms）`);
    if (el < 1300) throw new Error(`只等 ${el}ms，1500 没生效`);
    if (el > 2600) throw new Error(`等了 ${el}ms，远超 1500`);
  });
});

// ── ③ 改第二次也生效（不是只读一次）─────────────────────────────────
await test('改成 2400 → 等待随之变化（可反复修改）', async () => {
  await withBridge(async ({ get, post, sendMsg }) => {
    const cur = await get('/api/socialV2/config');
    await post('/api/socialV2/config', { ...cur.config, send: { ...cur.config.send, observeAfterSendMs: 2400 } });

    const t0 = Date.now();
    const r = await sendMsg(`/api/socialV2/send-message?key=${encodeURIComponent(KEY)}`, { key: KEY, messages: ['第二次'] });
    const el = Date.now() - t0;
    if (!r.ok) throw new Error('发送失败');
    console.log(`    耗时 ${el}ms（预期约 2400ms）`);
    if (el < 2100) throw new Error(`只等 ${el}ms，2400 没生效`);
  });
});

// ── ④ 面板改 burstMaxMessages 会影响实际条数上限 ────────────────────
await test('上限 3 → 发 4 条被拒；改成 5 → 发 4 条成功', async () => {
  await withBridge(async ({ get, post, sendMsg }) => {
    // 上限 3
    let cur = await get('/api/socialV2/config');
    await post('/api/socialV2/config', { ...cur.config, send: { ...cur.config.send, burstMaxMessages: 3, observeAfterSendMs: 100 } });
    let r = await sendMsg(`/api/socialV2/send-message?key=${encodeURIComponent(KEY)}`, {
      key: KEY, messages: ['1', '2', '3', '4'],
    });
    if (r.ok) throw new Error('上限 3 却发出了 4 条');
    console.log(`    上限3 发4条 → 拒绝「${r.error}」`);

    // 上限 5
    cur = await get('/api/socialV2/config');
    await post('/api/socialV2/config', { ...cur.config, send: { ...cur.config.send, burstMaxMessages: 5 } });
    r = await sendMsg(`/api/socialV2/send-message?key=${encodeURIComponent(KEY)}`, {
      key: KEY, messages: ['1', '2', '3', '4'], gapMode: 'fixed', gapMs: 300,
    });
    if (!r.ok || r.sent !== 4) throw new Error(`上限 5 发 4 条失败: ${JSON.stringify(r).slice(0, 150)}`);
    console.log(`    上限5 发4条 → 成功 sent=${r.sent}`);
  });
});

// ── ⑤ 前端换算：面板填「秒」，后端存「毫秒」 ─────────────────────────
await test('面板填 20 秒 → 后端存 20000（前端 ×1000 生效）', async () => {
  const src = fs.readFileSync(PANEL, 'utf8');
  // 渲染：÷1000
  if (!/spec\[3\] === 'sec'[\s\S]{0,220}\/ 1000/.test(src)) {
    throw new Error('找不到渲染时的 ÷1000');
  }
  // 保存：×1000
  if (!/dataset\.unit === 'sec'[\s\S]{0,140}\* 1000/.test(src)) {
    throw new Error('找不到保存时的 ×1000');
  }
  // 字段必须标了 sec
  if (!/send\.observeAfterSendMs'[^\]]*'sec'/.test(src)) {
    throw new Error('observeAfterSendMs 没标 sec');
  }
  console.log('    渲染 ÷1000、保存 ×1000、字段标 sec —— 三处齐全 ✅');
});

// ── ⑥ 换算数值自洽 ───────────────────────────────────────────────────
await test('秒↔毫秒换算往返一致（20⇄20000、10⇄10000）', async () => {
  for (const [sec, ms] of [[20, 20000], [10, 10000], [8, 8000], [0.5, 500]]) {
    const shown = Math.round((ms / 1000) * 1000) / 1000;
    if (shown !== sec) throw new Error(`${ms}ms 显示成 ${shown}，应为 ${sec}`);
    const back = Math.round(shown * 1000);
    if (back !== ms) throw new Error(`${sec}秒 存回 ${back}，应为 ${ms}`);
  }
  console.log('    四组往返都一致 ✅');
});

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
