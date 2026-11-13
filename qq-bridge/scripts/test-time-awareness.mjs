// 时间观念回归：沉睡很久后被唤醒，模型必须看得出「这条是旧账」。
//
// 真实故障（操作者报告 + 会话实证）：
//   有人发消息时 AI 正在沉睡；很久以后被唤醒，看到那条旧消息仍然当成"刚发的"去回复，
//   甚至抢进早已散场的话题。两个根因：
//     ① 模型看到的时间是裸 epoch（`time:1792294529471`），算不出"这是 38 分钟前"；
//     ② 提示词里没有一条规则说"旧消息不该按实时对话接"。
//
// 2026-11-13 调整（重要）：
//   上面②的规则段现在**只在人格卡里**有一份
//   （preset 的【时间感：先看消息多旧，再决定怎么开口】）。
//   桥接侧原来会拼一段【时间感】规则 + 「旧账」警告，已按省 token 的理由删除 ——
//   同一套规则写两处，改一处忘一处，而且两份措辞迟早漂移（历史上真实发生过）。
//
//   所以本文件现在分两半，边界很清楚：
//     · 桥接的职责：把**数值**给全（at / ago / newestAgo），一个都不许缺；
//     · 预设的职责：把这些数值翻译成"该不该接话"的判断。
//   旧版本断言桥接拼出「旧账」「60 分钟以内：正常接」这类**规则文案**，
//   那等于在客户端复刻服务端规则，两边一不同步就假绿 —— 那些断言已删除。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { compactModelMessage, compactModelData, describeAge, serializeModelData } from '../src/qq-model-view.js';

const KEY = 'group:456';
const MIN = 60000;
let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 固定 now 便于断言：2026-10-18 11:31:05 本地时间
const NOW = new Date(2026, 9, 18, 11, 31, 5).getTime();

// ── 1. 模型视图：epoch → at / ago ───────────────────────────────────────────
await test('compactModelMessage 把 epoch 换成 at/ago，并去掉裸 time', () => {
  const compact = compactModelMessage(
    { seq: 7, sender: '小明', text: '在吗', time: NOW - 38 * MIN },
    { now: NOW }
  );
  assert.equal(compact.time, undefined, '裸 epoch 不该再出现在模型视图里');
  assert.equal(compact.ago, '38m');
  assert.equal(compact.at, '10:53');
  assert.equal(compact.text, '在吗');
});

await test('ago 单位：秒/分/时/天，未来时间夹到 0s', () => {
  assert.equal(describeAge(NOW - 3000, NOW), '3s');
  assert.equal(describeAge(NOW - 59 * 1000, NOW), '59s');
  assert.equal(describeAge(NOW - 18 * MIN, NOW), '18m');
  assert.equal(describeAge(NOW - 5 * 60 * MIN, NOW), '5h');
  assert.equal(describeAge(NOW - 3 * 24 * 60 * MIN, NOW), '3d');
  assert.equal(describeAge(NOW + 5 * MIN, NOW), '0s', '未来时间不能显示成负数');
});

await test('跨天的消息 at 带日期（否则"23:40"会被误读成今天）', () => {
  const compact = compactModelMessage({ text: '晚安', time: new Date(2026, 9, 16, 23, 40).getTime() }, { now: NOW });
  assert.equal(compact.at, '10-16 23:40');
  // 10-16 23:40 → 10-18 11:31 约 36 小时，按天向下取整 = 1d
  assert.equal(compact.ago, '1d');
});

await test('time 缺失/为 0 时保持原样（不把"没有时间"伪装成"刚刚"）', () => {
  assert.deepEqual(compactModelMessage({ text: '好', time: 0 }, { now: NOW }), { text: '好', time: 0 });
  assert.deepEqual(compactModelMessage({ text: '好' }, { now: NOW }), { text: '好' });
});

await test('一次序列化共用一个 now：同批消息的 ago 不会跨分钟自相矛盾', () => {
  const data = {
    messages: [
      { seq: 1, text: 'a', time: NOW - 70 * 1000 },
      { seq: 2, text: 'b', time: NOW - 10 * 1000 }
    ]
  };
  const out = JSON.parse(serializeModelData(data, { now: NOW }));
  assert.equal(out.messages[0].ago, '1m');
  assert.equal(out.messages[1].ago, '10s');
  // compactModelData 也要把 now 透传下去
  assert.equal(compactModelData(data, { now: NOW }).messages[1].ago, '10s');
});

// ── 2. 唤醒提示：桥接只提供**数值**，分档规则在人格卡里 ─────────────────────
async function withBridge(run, config = {}) {
  const h = await bridgeHarness({ config: { socialV2: { sticker: { enabled: false }, ...config } } });
  h.setMode('reserved2');
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly', 'qq-chat-agent']);
  try { await run(h); } finally { await h.close(); }
}

const append = (h, text, { ageMs = 0, sender = '小明' } = {}) => {
  const st = h.getSocialV2State(KEY);
  const seq = st.lastUnreadSeq + 1;
  h.appendSocialV2Message(KEY, sender, text, text, false, false, `fixture-${seq}`, [], '789');
  if (ageMs > 0) {
    // 模拟"消息是 40 分钟前发的"：把存储层的时间戳往前推（模拟沉睡期间堆积）
    const stored = st.unread.find((m) => m.seq === seq);
    if (stored) stored.time = Date.now() - ageMs;
  }
  return seq;
};

await test('新消息（几秒前）也给出明确年龄，不能省略', async () => {
  await withBridge(async (h) => {
    append(h, '在吗');
    const snapshot = h.buildWakeSnapshotV2(KEY);
    assert.equal(snapshot.newestAgo, '0s', '刚发的消息同样要有年龄，"没有数值"会被误当成"刚刚"');
    assert.match(snapshot.now, /^\d{2}:\d{2}$/, '绝对时间也要给，否则跨天时算不出来');
  });
});

await test('40 分钟前的消息：快照头 newestAgo 必须是 40m', async () => {
  await withBridge(async (h) => {
    append(h, '晚上开黑吗', { ageMs: 40 * MIN });
    const snapshot = h.buildWakeSnapshotV2(KEY);
    assert.equal(snapshot.newestAgo, '40m', '沉睡后被唤醒，"这条已经 40 分钟了"必须一眼可见');
    // 每条消息自己也要带 at/ago（换一批消息时头部的 newestAgo 会跟着变，
    // 但模型回看某一条时仍然需要它自己的年龄）。
    for (const message of snapshot.messages) {
      assert.equal(message.time, undefined, '快照里不该再有裸 epoch');
      assert.match(message.at, /^\d{2}:\d{2}$/);
      assert.match(message.ago, /^\d+[smhd]$/);
    }
  });
});

await test('几小时前的消息：newestAgo 用小时单位', async () => {
  await withBridge(async (h) => {
    append(h, '有人吗', { ageMs: 5 * 60 * MIN });
    assert.equal(h.buildWakeSnapshotV2(KEY).newestAgo, '5h');
  });
});

await test('没有消息时不编造 newestAgo（定时/引导唤醒）', async () => {
  await withBridge(async (h) => {
    const snapshot = h.buildWakeSnapshotV2(KEY);
    if (snapshot) assert.equal(snapshot.newestAgo, undefined, '没有可判断的消息时不该给一个假的年龄');
  });
});

await test('共用会话分支也必须带 newestAgo（当前生产就是这套配置）', async () => {
  // 共用会话（私聊 + 群复用同一个 DSH 会话）走的是 buildWakeSnapshotV2 里
  // 另一个提前 return 的分支。那个分支曾经漏掉 newestAgo：两个聊天的消息混排时
  // "刚刚"和"三小时前"在渲染上完全一样，只剩每条自己的 ago 可看，
  // 而 persona 明确写着"会给出最新一条消息是多久以前"。
  const P2 = 'private:10001';
  const G2 = 'group:20001';
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: ['20001'] },
      sessionSharing: { enabled: true, groups: { [P2]: G2 }, preset: '' },
      socialV2: { sticker: { enabled: false } }
    }
  });
  h.setMode('reserved2');
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly', 'qq-chat-agent']);
  try {
    const st = h.getSocialV2State(G2);
    const seq = st.lastUnreadSeq + 1;
    h.appendSocialV2Message(G2, '小明', '群里那条', '群里那条', false, false, `fx-${seq}`, [], '789');
    const stored = st.unread.find((m) => m.seq === seq);
    if (stored) stored.time = Date.now() - 40 * MIN;
    const snapshot = h.buildWakeSnapshotV2(G2);
    assert.equal(snapshot.shared, true, '前置：确认走的是共用分支');
    assert.equal(snapshot.newestAgo, '40m', '共用会话同样要给出最新一条有多旧');
    assert.match(snapshot.now, /^\d{2}:\d{2}$/);
  } finally {
    await h.close();
  }
});

await test('桥接不再渲染分档规则（规则只在 preset，避免两份措辞漂移）', async () => {
  // 以前桥接会把 staleChatMinutes / staleSilentMinutes 拼成两档 warning，
  // 并打出「旧账」「60 分钟以内：正常接」这类字样。现在规则统一在 preset。
  // 这里钉住"不要又写回来" —— 同一套规则写两处，改一处忘一处是历史事故来源。
  await withBridge(async (h) => {
    append(h, '刚刚那条', { ageMs: 12 * MIN });
    const prompt = h.buildWakePromptV2(KEY, 'atMention@seq1');
    assert.doesNotMatch(prompt, /【时间感/, '规则段归 preset，桥接不该再拼一份');
    assert.doesNotMatch(prompt, /旧账/, '旧账警告已移除');
  }, { wake: { staleChatMinutes: 60 } });
});

// ── 3. 工具结果也走同一套视图（MCP 与桥接共用 qq-model-view） ───────────────
await test('serializeModelData 对 messages/newMessages 同时生效（工具结果同口径）', () => {
  const data = { ok: true, unreadCount: 1, messages: [{ seq: 3, text: 'x', time: NOW - 90 * 1000 }], newMessages: [{ seq: 4, text: 'y', time: NOW - 5 * MIN }] };
  const out = JSON.parse(serializeModelData(data, { now: NOW }));
  assert.equal(out.messages[0].ago, '1m');
  assert.equal(out.newMessages[0].ago, '5m');
  assert.equal(out.unreadCount, 1, '信封字段不受影响');
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
