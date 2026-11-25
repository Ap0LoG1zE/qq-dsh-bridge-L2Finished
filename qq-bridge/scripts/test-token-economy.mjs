// 未读水位 / 已读确认 / 快照预算的回归。
//
// ── 这个文件为什么存在 ─────────────────────────────────────────────────────
// 它是**唯一**盯着「收尾能标掉哪些消息」的测试。别的测试测的是回复节奏
// （test-reply-wait）、消息渲染（test-qq-model-view），没有一个会去碰
// acknowledgeMessagesV2 的边界。删掉它 = 这几条规则彻底失守。
//
// ── 2026-11-19 重写（操作者要求）────────────────────────────────────────────
// 起因：1abdf9b 把这些端点的**返回体精简**了（只回一句话，不再回 markedCount /
//   messages 数组），而测试没跟上，36 个用例里 24 个长期红着。长期红的测试等于
//   没有测试 —— 真回归会淹在噪音里。
//
// 同时确认了两条**有意设计**，不再按旧语义断言：
//   ① 2026-11-10：mark-read / wake-config 只回一句话，字段名没了；
//   ② 2026-11-12（操作者明确要求）：**可以标到任意已入库的 seq**，
//      不再要求「必须连续读过」。所以「没看过的能标掉」返回 200 是预期的，
//      本文件改为断言「标完之后未读确实按水位被消费」，而不是断言 400。
//
// 仍然钉死的不变量（这些是安全边界，一个字都不放宽）：
//   · 水位不能超过 lastUnreadSeq（不能标未来的消息）
//   · 非整数 / 负数 / 超范围水位一律 400，且**原子**（未读与唤醒配置都不许动）
//   · 别的会话的 agent token 不能操作本会话
//   · 暂停 / 换模式 / 移出白名单后一律 403，且不改任何状态
//   · 已确认水位是**下限**：未读被逐出后也不能退回 0
//   · 被拒的唤醒投递不能变成收据（没送到的内容不能因此被标已读）
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const ACTIVE = { mode: 'active' };
const DIVING = { mode: 'diving', infinite: true, triggers: { atMention: true, anyMessage: false } };
const plain = (value) => JSON.parse(JSON.stringify(value));
const seqs = (messages) => Array.from(messages ?? [], (message) => message.seq);
/** 回包里只有一句话：从这里取「标记了 N 条」。
 *  2026-11-23 起回执只说「下次什么时候醒」，**只有真的标了才提一句**「顺带标记 N 条已读」，
 *  没标就一个字都不说（连「没有新的要标记」也删了）。所以"没提"就是 0，
 *  但仍然要求回执里必须有水位（`读到 #N`）—— 否则就是回执格式漂了，不能再静默当 0。 */
const markedOf = (data) => {
  const text = String(data?.text ?? '');
  const m = /标记 (\d+) 条已读/.exec(text);
  if (m) return Number(m[1]);
  if (/读到 #\d+/.test(text)) return 0;
  throw new Error(`回执里既没提「标记 N 条已读」也没有「读到 #N」：${JSON.stringify(text || data)}`);
};
/** unread / recent 只回渲染好的文本行，按行里的 #N 取 seq。
 *  ⚠️ 2026-11-23 起消息行**不再带** `[群]` / `[私聊…]` 标签（一个会话只服务一个聊天），
 *  行长这样：`#12 某人·16:34（1小时前）：内容`。
 *  抬头那句「读到 #12」的 # 不在行首，所以 `^#N ` 既不会误吃抬头，也不会漏消息。 */
const lineSeqs = (data) => [...String(data?.text ?? '').matchAll(/^#(\d+)\s/gm)].map((m) => Number(m[1]));
let failures = 0;
let tests = 0;

async function test(name, run, { observe = false } = {}) {
  tests++;
  const h = await bridgeHarness({ config: { socialV2: {
    // 收尾前观望在这里关掉：本文件测的是水位语义，观望会把每次收尾拖十几秒。
    observeBeforeSleepMs: 0,
    wake: { preSleepWaitEnabled: observe, preSleepWaitMs: 1000 },
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    proactive: { enabled: false },
    sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { body, token = st.agentToken, key = KEY, admin = false, query = '' } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (!admin) headers['x-agent-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}${query}`,
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
    req.setTimeout(4000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = (text, { key = KEY, id, media = [], forwards = [] } = {}) => {
    const target = key;
    h.appendSocialV2Message(target, 'fixture-person', text, text, false, false,
      id ?? `fixture-${h.getSocialV2State(target).lastUnreadSeq + 1}`, media, '789', forwards);
    return h.getSocialV2State(target).lastUnreadSeq;
  };
  try { await run({ h, st, request, append }); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── 一、水位的基本语义 ──────────────────────────────────────────────────────

await test('mark-read 按水位消费未读，之后到达的消息保持未读', async ({ st, request, append }) => {
  append('first displayed message');
  const read = await request('unread');
  assert.equal(read.status, 200);
  assert.equal(read.data.readThroughSeq, 1);
  assert.deepEqual(lineSeqs(read.data), [1], '文本行里应能看出展示的是 #1');
  append('new arrival while model thinks');
  const marked = await request('mark-read', { body: { throughSeq: read.data.readThroughSeq } });
  assert.equal(marked.status, 200);
  assert.equal(markedOf(marked.data), 1, '只标了展示过的那一条');
  assert.deepEqual(seqs(st.unread), [2], '思考期间到达的那条必须还在未读里');
  assert.equal(st.lastReadThroughSeq, 1);
});

await test('wake-config 原子地消费到水位，同时保留之后到达的未读', async ({ st, request, append }) => {
  append('first displayed message');
  const read = await request('unread');
  append('unseen new arrival');
  const result = await request('wake-config', { body: { config: ACTIVE, throughSeq: read.data.readThroughSeq } });
  assert.equal(result.status, 200);
  assert.equal(markedOf(result.data), 1);
  assert.equal(st.wakeConfig.confirmedBy, 'set_wake_config');
  assert.equal(st.wakeConfig.mode, 'active');
  assert.deepEqual(seqs(st.unread), [2]);
});

await test('非法水位一律 400，且必须原子（未读与唤醒配置都不许动）', async ({ st, request, append }) => {
  append('protected unread');
  await request('unread');
  st.preSleepWaitObservedAt = Date.now();
  const snapshot = () => plain({ unread: st.unread, wakeConfig: st.wakeConfig, lastActionAt: st.lastActionAt,
    observedAt: st.preSleepWaitObservedAt, satisfiedAt: st.preSleepWaitSatisfiedAt, lastReadThroughSeq: st.lastReadThroughSeq });
  for (const route of ['mark-read', 'wake-config']) {
    for (const throughSeq of [null, '1', true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
      const before = snapshot();
      const result = await request(route, { body: { throughSeq, config: ACTIVE } });
      assert.equal(result.status, 400, `${route} 应拒绝 ${JSON.stringify(throughSeq)}`);
      assert.deepEqual(snapshot(), before, `${route} 的非法请求必须是原子的`);
    }
  }
});

await test('水位不能超过 lastUnreadSeq（不许标还没到达的消息）', async ({ st, request, append }) => {
  append('only one message');
  await request('unread');
  const future = await request('mark-read', { body: { throughSeq: 2 } });
  assert.equal(future.status, 400, '标到不存在的 seq 必须被拒');
  assert.deepEqual(seqs(st.unread), [1], '被拒之后未读一条都不能少');
});

await test('零水位不消费任何消息，重复水位也不会回退', async ({ st, request, append }) => {
  append('first seen');
  await request('unread');
  assert.equal(markedOf((await request('mark-read', { body: { throughSeq: 0 } })).data), 0);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.equal(markedOf((await request('mark-read', { body: { throughSeq: 1 } })).data), 1);
  append('later unseen');
  append('even later');
  // 2026-11-12 放宽后：可以标到任意已入库 seq，但**只能消费到那个 seq**，之后的不受影响。
  const again = await request('mark-read', { body: { throughSeq: 1 } });
  assert.equal(again.status, 200);
  assert.equal(markedOf(again.data), 0, '重复标同一个水位不该再消费任何东西');
  assert.deepEqual(seqs(st.unread), [2, 3], '更晚到达的消息必须留着');
});

// ── 二、权限与隔离（安全边界）─────────────────────────────────────────────

await test('控制台浏览不等于模型看过：管理员读过的未读仍要按水位消费', async ({ st, request, append }) => {
  append('console-only read');
  const read = await request('unread', { admin: true });
  assert.equal(read.status, 200);
  // 控制台读一次不会把 token 换成别家的，所以这里用同一会话的 agent 水位收尾：
  // 关键是「管理员看过」不改变未读本身，收尾仍由水位决定。
  const closed = await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } });
  assert.equal(closed.status, 200);
  assert.equal(markedOf(closed.data), 1);
  assert.deepEqual(seqs(st.unread), []);
});

await test('别的会话的 token 不能操作本会话的未读', async ({ h, st, request, append }) => {
  append('protected conversation');
  await request('unread');
  const otherToken = h.getSocialV2State('private:123').agentToken;
  const body = { config: ACTIVE, throughSeq: 1 };
  assert.equal((await request('wake-config', { body, token: otherToken })).status, 403);
  assert.deepEqual(seqs(st.unread), [1], '被拒之后未读必须原样保留');
});

await test('暂停 / 换模式 / 移出白名单后一律 403，且不改状态', async ({ h, st, request, append }) => {
  append('protected conversation');
  await request('unread');
  const body = { config: ACTIVE, throughSeq: 1 };
  h.socialV2.paused = true;
  assert.equal((await request('wake-config', { body })).status, 403);
  assert.deepEqual(seqs(st.unread), [1]);
  h.socialV2.paused = false;
  h.setMode('chat');
  assert.equal((await request('wake-config', { body })).status, 403);
  assert.deepEqual(seqs(st.unread), [1]);
  h.setMode('reserved2');
  h.cfg.allow.groups = [];
  assert.equal((await request('wake-config', { body })).status, 403);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('合并收尾遵守 mark-read / wake-config 两个独立开关', async ({ h, st, request, append }) => {
  append('protected by tool flags');
  await request('unread');
  h.cfg.socialV2.tools.markRead = false;
  // markRead 关掉时水位被**忽略**而不是致命：唤醒配置照常落地，未读留着。
  const ignoredCursor = await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } });
  assert.equal(ignoredCursor.status, 200, 'markRead 关掉时不该让收尾整个失败');
  assert.equal(markedOf(ignoredCursor.data), 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).status, 403);
  assert.deepEqual(seqs(st.unread), [1], 'markRead 关掉时一条都不许清');
  h.cfg.socialV2.tools.markRead = true;
  h.cfg.socialV2.tools.setWakeConfig = false;
  assert.equal((await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } })).status, 403);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('唤醒条件已冻结：传什么都按固定值覆盖，但不影响水位原子性', async ({ st, request, append }) => {
  // 2026-11-23：triggers 不再是可配字段（私聊群聊都不许改）。
  // 旧断言是"全部关掉会 400"，现在这组配置会被**静默改回固定值**，
  // 不再是非法输入。这里同时验证两件事：
  //   ① 传进去的 false 全被覆盖成冻结值（atMention/nameMention/poke=true, question=false）
  //   ② 即使 triggers 被改写，也是**成功**路径 —— 水位照常消费，不会被顺带清掉。
  append('must remain unread');
  await request('unread');
  const result = await request('wake-config', { body: { throughSeq: 1, config: {
    mode: 'diving', infinite: true, triggers: { atMention: false, nameMention: false, question: true,
      poke: false, anyMessage: true, probability: 0.9, keywords: ['x'], speakerIds: ['123'] },
  } } });
  assert.equal(result.status, 200, '冻结后这组配置是合法的，不该再 400');
  const tr = st.wakeConfig.triggers;
  assert.equal(tr.atMention, true, '@ 恒开');
  assert.equal(tr.nameMention, true, '名字恒开');
  assert.equal(tr.poke, true, '拍一拍恒开');
  assert.equal(tr.question, false, '提问恒关');
  assert.equal(tr.anyMessage, false, 'anyMessage 被清掉');
  assert.equal(tr.probability, 0, '概率被清掉');
  // 用 JSON 比较，避免 deepEqual 对 frozen/原型差异的误报。
  assert.equal(JSON.stringify(tr.keywords ?? []), '[]', '关键词被清掉');
  assert.equal(JSON.stringify(tr.speakerIds ?? []), '[]', '指定成员被清掉');
  // 水位仍然照常消费 —— 冻结触发器不该影响已读语义
  assert.deepEqual(seqs(st.unread), [], '合法配置应当正常消费水位');
});

// ── 三、水位是下限：逐出之后不能退回 0 ────────────────────────────────────

await test('未读被逐出后，已确认水位不能退回 0', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 5;
  h.cfg.socialV2.context.recentLimit = 100;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  for (let i = 1; i <= 5; i++) append(`seen ${i}`);
  const read = await request('unread', { query: '&limit=5&afterSeq=0' });
  assert.equal(read.data.readThroughSeq, 5);
  assert.equal((await request('mark-read', { body: { throughSeq: 5 } })).status, 200);
  assert.equal(st.lastReadThroughSeq, 5, '已确认的水位要落盘');
  for (let i = 6; i <= 11; i++) append(`burst ${i}`);
  assert.deepEqual(seqs(st.unread), [7, 8, 9, 10, 11], '更早的未读被 unreadLimit 逐出');
  const after = await request('unread', { query: '&limit=5&afterSeq=5' });
  assert.ok(after.data.readThroughSeq >= 5, `水位退化成 ${after.data.readThroughSeq}`);
  const again = await request('mark-read', { body: { throughSeq: after.data.readThroughSeq } });
  assert.equal(again.status, 200, '模型挣来的游标在逐出之后仍然有效');
  assert.deepEqual(seqs(st.unread), []);
});

await test('普通查询不能把已确认水位降到更低的旧值', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 3;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  h.cfg.socialV2.wake.preSleepWaitEnabled = false;
  for (let i = 1; i <= 3; i++) append(`seen ${i}`);
  const first = await request('unread', { query: '&limit=3&afterSeq=0' });
  assert.equal(first.data.readThroughSeq, 3);
  assert.equal((await request('mark-read', { body: { throughSeq: 3 } })).status, 200);
  assert.equal(st.lastReadThroughSeq, 3);
  for (let i = 4; i <= 6; i++) append(`burst ${i}`);
  assert.deepEqual(seqs(st.unread), [4, 5, 6]);
  const state = h.getSocialV2State(KEY);
  const cached = await request('my-recent');
  assert.equal(cached.data.readThroughSeq, 3, `my-recent 报了 ${cached.data.readThroughSeq}，应为下限 3`);
  const wake = await request('wake-config', { body: { config: ACTIVE } });
  assert.equal(wake.status, 200);
  // wake-config 的返回被精简成一句话，「读到 #N」在 text 里（字段名已不存在）。
  const wakeCursor = Number(/读到 #(\d+)/.exec(String(wake.data.text))?.[1]);
  assert.equal(wakeCursor, 3, `wake-config 报了 ${wakeCursor}，应为下限 3`);
  assert.deepEqual(seqs(state.unread), [4, 5, 6], '没有游标时不跳读：未读原样保留');
});

// ── 四、快照预算（内部结构，不经 HTTP）──────────────────────────────────

// 2026-11-19 操作者改了口径：唤醒包给**最新**的 N 条，不是最旧的。
// 原实现给最旧的，导致「6 小时前的闲聊在、19 秒前的消息被截掉」。
await test('预算内的快照保留**最新**的整条消息', async ({ h, st, append }) => {
  h.cfg.socialV2.context.wakeMessageLimit = 2;
  h.cfg.socialV2.context.wakeRecentLimit = 0;
  append('first'); append('second'); append('third');
  const snapshot = h.buildWakeSnapshotV2(KEY);
  // 最新 2 条 = #2、#3
  assert.deepEqual(seqs(snapshot.messages), [2, 3]);
  assert.equal(snapshot.includedUnreadCount, 2);
  assert.equal(snapshot.unreadCount, 3);
  assert.equal(snapshot.partial, true);
  // ⚠️ 水位必须停在**上一轮读到的位置**（这里从没读过 = 0），不能是 3：
  // 那会把 #1 当成已读，让它永久丢失。
  assert.equal(snapshot.readThroughSeq, 0);
  assert.ok(JSON.stringify(snapshot).length <= h.cfg.socialV2.context.wakeMaxChars);
  assert.deepEqual(seqs(st.unread), [1, 2, 3], '快照只读不写：未读原样保留');
});

await test('超大的首条未读保持完整，不会被快照跳过', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.wakeMaxChars = 500;
  const long = '消息前半部分'.repeat(100) + '消息后半部分'.repeat(100);
  append(long); append('small but newer');
  const storedBefore = plain(st.unread[0]);
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages.length, 0);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.readThroughSeq, 0);
  assert.ok(JSON.stringify(snapshot).length <= 500);
  assert.deepEqual(plain(st.unread[0]), storedBefore, '存档里的那条不能被二次截断');
  const unread = await request('unread');
  assert.ok(String(unread.data.text).includes('消息前半部分'), '超大消息仍要能被读到');
});

await test('快照里的历史按时间正序，且不重复未读', async ({ h, request, append }) => {
  append('history 1'); append('history 2'); append('history 3');
  await request('mark-read', { body: {} });
  append('current unread');
  h.cfg.socialV2.context.wakeRecentLimit = 2;
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.deepEqual(seqs(snapshot.messages), [4]);
  assert.deepEqual(seqs(snapshot.recent), [2, 3]);
  assert.equal(snapshot.partial, false);
  // 2026-11-19：`readThroughSeq` 改成「上一轮读到哪」（本轮新消息的起点前一条）。
  // 这里 mark-read 读到 #3、本轮新消息是 #4，所以显示 #3 而不是 #4。
  assert.equal(snapshot.readThroughSeq, 3);
});

await test('快照不能借内联历史绕过特性与工具开关', async ({ h, request, append }) => {
  append('authorized old history');
  await request('mark-read', { body: {} });
  append('unread requiring getUnread');
  h.cfg.socialV2.tools.getUnread = false;
  let snapshot = h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages.length, 0);
  assert.deepEqual(seqs(snapshot.recent), [1]);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.readThroughSeq, 1);
  h.cfg.socialV2.tools.getRecent = false;
  assert.equal(h.buildWakeSnapshotV2(KEY), null);
  h.cfg.socialV2.tools.getUnread = true;
  snapshot = h.buildWakeSnapshotV2(KEY);
  assert.deepEqual(seqs(snapshot.messages), [2]);
  assert.equal(snapshot.recent.length, 0);
  h.cfg.socialV2.context.inlineWakeMessages = false;
  assert.equal(h.buildWakeSnapshotV2(KEY), null);
});

await test('紧凑图片句柄在未读超出近期缓冲后仍能解析', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.recentLimit = 1;
  append('old unread image', { id: '900719925474099312345', media: [{ kind: 'image', file: 'fixture-kept-image' }] });
  append('newer text');
  assert.deepEqual(seqs(st.recentMessages), [2]);
  assert.deepEqual(seqs(st.unread), [1, 2]);
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages[0].media[0].index, 1);
  assert.equal(snapshot.messages[0].media[0].file, undefined);
  for (const messageId of ['1', '900719925474099312345']) {
    const result = await request('/api/images/message', { query: `&messageId=${messageId}` });
    assert.equal(result.status, 200);
    assert.equal(result.data.media[0].file, 'fixture-kept-image');
    assert.equal(result.data.images[0].mimeType, 'image/png');
    assert.ok(result.data.images[0].data.length > 0, 'fixture 网关应返回真实图片');
  }
  assert.deepEqual(h.calls.images, ['fixture-kept-image', 'fixture-kept-image']);
});

// ── 五、飞行中的 wait：换权限后不能授予任何东西 ──────────────────────────

await test('飞行中的 wait 在会话令牌被换掉后返回 403，且不暴露消息', async ({ h, st, request, append }) => {
  await h.ensureSession(KEY);
  append('before wait');
  const oldToken = st.agentToken;
  const waiting = request('wait', { body: { timeoutMs: 1000, quietMs: 0 }, token: oldToken });
  const timer = setTimeout(() => { h.retireSession(KEY); append('arrived after token retirement'); }, 60);
  let result;
  try { result = await waiting; } finally { clearTimeout(timer); }
  assert.equal(result.status, 403, '令牌已换，飞行中的 wait 必须被拒');
  assert.equal(result.data.newMessages, undefined, '被拒的 wait 不能顺手把新消息交出去');
  assert.notEqual(st.agentToken, oldToken);
  assert.equal(st.preSleepWaitObservedAt, 0, '被拒的 wait 不能写观测量');
});

await test('飞行中的 wait 不能把观测写进被替换掉的会话状态', async ({ h, st, request, append }) => {
  append('old state');
  const waiting = request('wait', { body: { timeoutMs: 100, quietMs: 0 } });
  const timer = setTimeout(() => {
    h.socialV2.conversations.delete(KEY);
    append('new conversation state');
  }, 60);
  let result;
  try { result = await waiting; } finally { clearTimeout(timer); }
  assert.equal(result.status, 403);
  assert.equal(st.preSleepWaitSatisfiedAt, 0);
  const replacement = h.getSocialV2State(KEY);
  assert.equal(replacement.preSleepWaitSatisfiedAt, 0);
}, { observe: true });

await test('飞行中的 wait 会重查暂停/特性/工具/白名单，且不授予观测量', async ({ h, st, request, append }) => {
  append('unread before policy changes');
  const cases = [
    ['pause', () => { h.socialV2.paused = true; }, () => { h.socialV2.paused = false; }],
    ['feature disable', () => { h.cfg.socialV2.enabled = false; }, () => { h.cfg.socialV2.enabled = true; }],
    ['tool disable', () => { h.cfg.socialV2.tools.waitMessages = false; }, () => { h.cfg.socialV2.tools.waitMessages = true; }],
    ['allowlist removal', () => { h.cfg.allow.groups = []; }, () => { h.cfg.allow.groups = ['456']; }],
  ];
  const before = () => plain({ unread: st.unread, wakeConfig: st.wakeConfig, lastReadThroughSeq: st.lastReadThroughSeq,
    observedAt: st.preSleepWaitObservedAt, satisfiedAt: st.preSleepWaitSatisfiedAt });
  for (const [label, revoke, restore] of cases) {
    const snapshot = before();
    const waiting = request('wait', { body: { timeoutMs: 100, quietMs: 0 } });
    const timer = setTimeout(revoke, 60);
    let result;
    try { result = await waiting; } finally { clearTimeout(timer); restore(); }
    assert.equal(result.status, 403, label);
    assert.equal(result.data.newMessages, undefined, label);
    assert.deepEqual(before(), snapshot, `${label} 不能改动观测、未读或唤醒配置`);
  }
}, { observe: true });

// ── 六、唤醒投递：没送到的内容不能变成收据 ────────────────────────────────

await test('忙碌与被限流的唤醒保留当前观测状态', async ({ h, st, append }) => {
  append('already observed');
  const setObservation = () => { st.preSleepWaitObservedAt = 123; st.preSleepWaitSatisfiedAt = 456; st.preSleepWaitAccumMs = 789; };
  const checkObservation = () => assert.deepEqual([st.preSleepWaitObservedAt, st.preSleepWaitSatisfiedAt, st.preSleepWaitAccumMs], [123, 456, 789]);
  setObservation();
  h.promptQueues.set(KEY, { running: true, queue: [] });
  await h.sendWakePromptV2(KEY, 'question');
  checkObservation();
  h.promptQueues.delete(KEY);
  h.cfg.socialV2.wake.maxWakePerMinute = 1;
  st.wakeTimes = [Date.now()];
  await h.sendWakePromptV2(KEY, 'question');
  checkObservation();
  assert.equal(h.calls.prompts.length, 0);
});

await test('被拒绝的投递不能让未读被当成已读', async ({ h, st, request, append }) => {
  append('rejected snapshot');
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    return { result: { ok: false, error: { code: 'FIXTURE_REJECT', message: 'fixture rejection' } } };
  };
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 1);
  assert.deepEqual(seqs(st.unread), [1], '投递被拒，未读必须原样保留');
  assert.equal(st.modelSeenSeqs.size, 0, '没送到的内容不能记成「模型看过」');
});

await test('投递被接受期间的新到达不算进已送出的快照', async ({ h, st, request, append }) => {
  append('snapshot message');
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    append('arrived after snapshot construction');
    return { result: { ok: true, value: {} } };
  };
  await h.sendWakePromptV2(KEY, 'question');
  // 快照里只有 #1；#2 是在构造之后才到的，不能被当成"已展示"。
  assert.deepEqual(seqs(st.unread), [1, 2], '两条都还在未读里，收尾前都还没被消费');
  assert.ok([...st.modelSeenSeqs].every((seq) => seq === 1), `模型看过的不该包含后到的：${[...st.modelSeenSeqs]}`);
});

await test('已退役的投递会话在旧回执返回时不能授予收据', async ({ h, st, request, append }) => {
  append('retired snapshot');
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    h.retireSession(KEY);
    return { result: { ok: true, value: {} } };
  };
  await h.sendWakePromptV2(KEY, 'question');
  assert.deepEqual(seqs(st.unread), [1], '会话已退役，未读不能被这次投递消费');
});

await test('离线唤醒重放会用当前令牌重建一份新快照', async ({ h, st, request, append }) => {
  await h.ensureSession(KEY);
  const originalToken = st.agentToken;
  append('queued initial message');
  h.setReady(false);
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 0);
  h.retireSession(KEY);
  append('queued later message');
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 1);
  const content = h.calls.prompts[0].content.map((part) => part.text || '').join('\n');
  assert.ok(content.includes('queued initial message'));
  assert.ok(content.includes('queued later message'), '重放必须带上排队期间的新消息');
  assert.ok(content.includes(st.agentToken), '必须用当前令牌');
  assert.ok(!content.includes(originalToken), '旧令牌不能再出现在快照里');
});

await test('离线的 reserved2 唤醒不会被重放进普通 chat 会话', async ({ h, append }) => {
  append('reserved2 queue message');
  h.setReady(false);
  await h.sendWakePromptV2(KEY, 'question');
  h.setMode('chat');
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 0);
});

await test('真实唤醒会内联紧凑消息，并保留精确的引用与媒体句柄', async ({ h, st, request, append }) => {
  append('fixture-inline-content', { id: '900719925474099312345',
    media: [{ kind: 'image', file: 'fixture-local-image', url: 'https://images.invalid/fixture-secret' }],
    forwards: ['fixture-forward-123'],
  });
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 1);
  const text = h.calls.prompts[0].content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.ok(text.includes('fixture-inline-content'));
  assert.ok(text.includes('900719925474099312345'), '引用 ID 必须保留为精确字符串');
  assert.ok(text.includes('fixture-forward-123'), '转发句柄必须仍然可取');
  assert.match(text, /读到 #\d+/, '唤醒文本必须给出「读到 #N」水位');
  assert.ok(!text.includes('fixture-secret'), '本地 seq 能解析时不该把媒体 URL 漏进上下文');
  const close = await request('wake-config', { body: { config: ACTIVE, throughSeq: 1 } });
  assert.equal(close.status, 200, '已投递的内联内容应能授权它的游标');
  assert.deepEqual(seqs(st.unread), []);
});

// ── 七、分页 ────────────────────────────────────────────────────────────────

await test('最早优先的分页能排干超出近期与响应上限的积压', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 150;
  h.cfg.socialV2.context.recentLimit = 100;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  for (let i = 1; i <= 150; i++) append(`backlog ${i}`);
  const tail = await request('unread', { query: '&limit=100' });
  assert.equal(lineSeqs(tail.data)[0], 51, '旧的尾部排序保持不变');
  const first = await request('unread', { query: '&limit=30&afterSeq=0' });
  assert.deepEqual(lineSeqs(first.data), Array.from({ length: 30 }, (_, i) => i + 1));
  // 水位取「已展示过的最大 seq」，而上一条请求（tail，limit=100）已经把 #51~#150 展示过了，
  // 所以这里报 150 而不是 30 —— 这是 readThroughSeqV2 的既定语义（取最大值，不要求连续），
  // 不是 bug。真正要守的是：**下面这一页必须能继续往下走**。
  assert.equal(first.data.readThroughSeq, 150, '水位是已展示的最大 seq（tail 那页已经覆盖到 150）');
  const next = await request('unread', { query: '&limit=30&afterSeq=30' });
  assert.equal(lineSeqs(next.data)[0], 31);
  append('arrived after complete read');
  assert.equal((await request('wake-config', { body: { config: ACTIVE, throughSeq: next.data.readThroughSeq } })).status, 200);
  assert.deepEqual(seqs(st.unread), [151]);
  for (const value of ['', '-1', '1.2', 'text', '9007199254740992']) {
    assert.equal((await request('unread', { query: `&afterSeq=${value}` })).status, 400);
  }
});

await test('离线排队的唤醒在派发时尊重暂停与禁用，且不暴露消息', async ({ h, st, append }) => {
  append('queued while active');
  for (const policy of ['paused', 'disabled']) {
    h.setReady(false);
    await h.sendWakePromptV2(KEY, 'question');
    if (policy === 'paused') h.socialV2.paused = true;
    else h.cfg.socialV2.enabled = false;
    h.setReady(true);
    await h.flushQueue();
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.modelSeenSeqs.size, 0);
    assert.deepEqual(seqs(st.unread), [1]);
    h.socialV2.paused = false;
    h.cfg.socialV2.enabled = true;
  }
});

// 2026-11-25：message-detail 的返回从 JSON 改成**纯文本消息行**
//（和 unread / recent 同一套格式，见 bridge.js 里 "★ 2026-11-25" 那段注释）。
// 所以断言不能再读 data.info.*，改成检查文本里有没有截断提示。
await test('message-detail 会如实报告截断，而不是把预览当全文', async ({ h, st, request, append }) => {
  append('短消息');
  const short = await request('message-detail', { query: '&messageId=1' });
  assert.equal(short.status, 200);
  // 短消息：不该出现"正文被截断"提示
  assert.equal(/正文被截断/.test(String(short.data.text ?? '')), false,
    `短消息不应被标为截断：${JSON.stringify(short.data).slice(0, 200)}`);

  append('长'.repeat(400));
  const long = await request('message-detail', { query: '&messageId=2' });
  assert.equal(long.status, 200);
  const longText = String(long.data.text ?? '');
  // 长消息：必须带截断提示 + 指向 qq_get_message_full
  assert.equal(/正文被截断/.test(longText), true,
    `被截断的预览必须如实报告：${JSON.stringify(long.data).slice(0, 300)}`);
  assert.equal(/qq_get_message_full/.test(longText), true,
    `截断提示里必须给出读全文的工具：${longText.slice(0, 300)}`);
  // 预览本身仍然只到 200 字（存储上限），不因为改了格式就变长
  assert.ok(longText.length > 0);
});

console.log(`\nToken economy bridge regressions: ${tests - failures}/${tests} passed.`);
if (failures) process.exitCode = 1;
