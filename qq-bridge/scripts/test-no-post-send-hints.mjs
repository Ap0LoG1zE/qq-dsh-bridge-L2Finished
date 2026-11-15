// 回归：发送工具**不再回任何发送后提示**（2026-11-14 操作者要求）。
//
// 被砍掉的两条：
//   ① findSplitBoundaryWarning → 「第 1、2 条之间像是把同一句话拆开了；…」
//   ② findCjkSpaceWarning      → 「第 N 条消息内部有中文空格，真人一般不这么打；…」
//
// 操作者的理由：**消息已经发出去了，提示既撤不回也改不了，纯占上下文。**
//
// 本文件用"一定会触发旧检测"的输入去撞，断言返回里既没有 text 提示字段、
// 也没有 warn / splitWarn，只有一句「✅ 已发出 N 条」。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
let failures = 0;
let tests = 0;

async function withBridge(run) {
  const h = await bridgeHarness({ config: { socialV2: {
    // 关掉观望：本文件只关心返回字段，不想为每次发送等 5~10 秒。
    observeBeforeSleepMs: 0,
    observeQuietMs: 0,
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
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.end(JSON.stringify({ key: KEY, ...body }));
  });
  try { await run({ h, st, request }); }
  finally { await new Promise((r) => server.close(r)); await h.close(); }
}

async function test(name, run) {
  tests++;
  // run 拿到的是 withBridge 里的上下文；所以在这之前必须先起桥接。
  // 之前写漏了这一步，于是回调拿到 undefined —— 见下方每个用例外的 withBridge 包裹。
  try { await run(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '—', e?.stack ?? e); }
}

// 让用例写法保持 `({ st, request }) => {...}`：这里统一起桥接再跑。
async function testWithBridge(name, run) {
  await test(name, () => withBridge(run));
}

// 这三组都是**旧实现一定会报警**的输入。
const TRIGGERS = [
  { label: '拆句（上一条以"的"结尾、下一条接中文）', messages: ['我今天想说的其实是', '那个事情'] },
  { label: '拆句（上一条以逗号结尾）', messages: ['其实我是想说，', '你别生气'] },
  { label: '中文之间带空格', messages: ['我 今天 有点 累'] },
];

for (const { label, messages } of TRIGGERS) {
  await testWithBridge(`qq_send_message 不再回提示：${label}`, async ({ st, request }) => {
    const r = await request('send-message', { messages });
    assert.equal(r.status, 200, `发送应成功，实际：${JSON.stringify(r.data)}`);
    assert.equal(r.data.ok, true);
    // 核心断言：这三个字段必须完全不存在。
    assert.equal(r.data.warn, undefined, `不该再有 warn 字段，拿到：${JSON.stringify(r.data.warn)}`);
    assert.equal(r.data.splitWarn, undefined, `不该再有 splitWarn 字段，拿到：${JSON.stringify(r.data.splitWarn)}`);
    assert.equal(r.data.hint, undefined, `不该再有 hint 字段，拿到：${JSON.stringify(r.data.hint)}`);
    assert.equal(r.data.text, undefined, `没有新消息时不该有 text，拿到：${JSON.stringify(r.data.text)}`);
    assert.equal(r.data.sent, messages.length);
  });
}

// burst 走同一个内部发送逻辑，单独一条用例撞它的返回形状
await testWithBridge('send-burst 路径也不带 warn / splitWarn', async ({ request }) => {
  const r = await request('send-burst', { messages: ['其实我是想说，', '你别生气'] });
  assert.equal(r.status, 200, `实际：${JSON.stringify(r.data)}`);
  assert.equal(r.data.warn, undefined);
  assert.equal(r.data.splitWarn, undefined);
  assert.equal(r.data.hint, undefined);
});

// 关键反向验证：观望期间来了新消息时，`text` **仍然要有**（那是她真正需要的）
await test('观望来的新消息照旧要回（别把 text 一起砍了）', async () => {
  const h = await bridgeHarness({ config: { socialV2: {
    // 发送后观望的时长由 minSendIntervalMs 决定（paceAfterSendV2 用它算 waitMs），
    // 不是 observeBeforeSleepMs —— 这里必须留出窗口，否则观望直接短路、什么都不会贴。
    observeBeforeSleepMs: 0,
    observeQuietMs: 300,
    observeHardCapMs: 1500,
    send: { minSendIntervalMs: 0, observeAfterSendMs: 800, observeQuietMs: 300, maxSendPerMinute: 100, maxSendPerHour: 100 },
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
  try {
    const p = request('send-message', { messages: ['我先去忙一下'] });
    await new Promise((r) => setTimeout(r, 150));
    h.appendSocialV2Message(KEY, 'fixture-person', '那你忙完叫我', '那你忙完叫我', false, false, 'fx-1', [], '789');
    const r = await p;
    assert.equal(r.status, 200);
    // 诊断：把实际返回打出来，断言失败时能看清到底是没贴、还是字段名变了。
    if (!/条新消息/.test(String(r.data.text ?? ''))) {
      console.error('    实际返回:', JSON.stringify(r.data));
    }
    assert.match(String(r.data.text ?? ''), /条新消息/, '观望来的新消息必须照旧贴回来');
    assert.match(String(r.data.text ?? ''), /忙完叫我/);
    assert.equal(r.data.warn, undefined);
    assert.equal(r.data.splitWarn, undefined);
  } finally { await new Promise((r) => server.close(r)); await h.close(); }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);

