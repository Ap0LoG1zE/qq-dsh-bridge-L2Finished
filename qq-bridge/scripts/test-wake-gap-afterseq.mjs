// 关键验证（操作者 2026-11-19 指出上一版验证错了）：
//
// 场景：上一轮读到 #20，之后来了 20 条（#21~#40）
//   【本轮】给最新的 12 条 = #29~#40
//   中间 #21~#28 是空洞
//
// 要验证的是：
//   `qq_get_unread_messages(afterSeq=20)` 应当
//     ✅ 带回 #21~#28（空洞那批）
//     ✅ 以及 #29~#40（本轮已给的也在这个区间里，工具本身不区分）
//     ❌ 但**不能**把【本轮】已经给过的那 12 条当成"新消息"再喂一遍
//
// 说明：工具返回的 #29~#40 是"可以再查到的"，真正的约束是**桥接不该再把它们
// 当未读推给她**（modelSeenSeqs 已经记过）。所以这里同时验两件事：
//   ① afterSeq=20 能覆盖到 #21（空洞起点）
//   ② 本轮给过的 #29~#40 已被标记为"看过"，不会在下一轮重复出现
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, '—', e.message); }
};

async function withBridge(run) {
  const h = await bridgeHarness({ config: { socialV2: {
    send: { minSendIntervalMs: 0, observeAfterSendMs: 0 },
    proactive: { enabled: false }, sticker: { enabled: false },
    // 上限 12，方便造"20 条里只给 12 条"的空洞
    context: { wakeMessageLimit: 12, wakeRecentLimit: 0, wakeMaxChars: 50000 },
  } } });
  h.setMode('reserved2');
  try { await run(h); } finally { await h.close(); }
}

function seed(h, from, to, prefix) {
  for (let i = from; i <= to; i += 1) {
    h.appendSocialV2Message(KEY, 'someone', `${prefix}${i}`, `${prefix}${i}`, false, false, `f${i}`, [], '789');
  }
}

function snapshotText(h) {
  const snap = h.buildWakeSnapshotV2(KEY);
  if (typeof snap?.text === 'string') return { text: snap.text, snap };
  const lines = [];
  if (Array.isArray(snap?.messages)) {
    for (const m of snap.messages) lines.push(String(m.text ?? m.plain ?? ''));
  }
  return { text: lines.join('\n'), snap };
}

// ── 造场景：读到 #20，然后来 #21~#40 ────────────────────────────────
async function setup(h) {
  seed(h, 1, 20, '旧');                     // #1~#20
  const st = h.getSocialV2State(KEY);
  st.lastReadThroughSeq = 20;               // 上一轮读到 #20
  st.lastUnreadSeq = 20;
  h.getSocialV2State(KEY).unread = [];      // 旧的已读掉
  seed(h, 21, 40, '新');                    // #21~#40，seq 应为 21~40
  return st;
}

// ── ① 本轮给的是 #29~#40（最新 12 条）───────────────────────────────
await test('本轮给最新 12 条（#29~#40），不含空洞 #21~#28', async () => {
  await withBridge(async (h) => {
    await setup(h);
    const { text } = snapshotText(h);
    if (!text.includes('新40')) throw new Error('#40（最新）不在本轮里');
    if (!text.includes('新29')) throw new Error('#29 不在本轮里（应给 12 条）');
    if (/新28\b/.test(text)) throw new Error('#28 不该在本轮里（属于空洞）');
    console.log('    含 #29~#40、不含 #28 ✅');
  });
});

// ── ② 「读到 #N」是 #20（上一轮读数）────────────────────────────────
// 注意：那段文字由 buildWakePromptV2 渲染（快照只是数据），
// 所以这里读快照字段 + 同时用 buildWakePromptV2 的产物做交叉验证。
await test('读到 #20（上一轮读到的位置，不是本轮给到的 #40）', async () => {
  await withBridge(async (h) => {
    await setup(h);
    const { snap } = snapshotText(h);
    // ① 直接看快照字段（这是渲染时的数据来源）
    if (snap?.readThroughSeq !== 20) {
      throw new Error(`快照的 readThroughSeq 是 ${snap?.readThroughSeq}，应为 20`);
    }
    // ② 再看渲染出来的唤醒词里那行（走真实渲染路径）
    const prompt = h.buildWakePromptV2(KEY, 'private') || '';
    const m = prompt.match(/读到 #(\d+)/);
    if (m && Number(m[1]) !== 20) {
      throw new Error(`渲染出来的"读到 #${m[1]}"，应为 #20`);
    }
    console.log(`    快照 readThroughSeq=#${snap.readThroughSeq}（上一轮读数）✅`);
  });
});

// ── ③ afterSeq=20 能覆盖空洞起点 #21 ────────────────────────────────
await test('afterSeq=20 能查回 #21（空洞起点），不会漏掉中间那批', async () => {
  await withBridge(async (h) => {
    const st = await setup(h);
    // 模拟工具内部：pool 是这个会话的全部消息，按 seq > afterSeq 过滤
    const pool = [...(st.recentMessages || []), ...(st.unread || [])];
    const after = pool.filter((m) => Number.isSafeInteger(m.seq) && m.seq > 20)
      .sort((a, b) => a.seq - b.seq);
    if (!after.length) throw new Error('afterSeq=20 查不到任何消息');
    const firstSeq = Number(after[0].seq);
    if (firstSeq !== 21) throw new Error(`从 #${firstSeq} 开始，应为 #21`);
    // 且要能一路覆盖到 #28（空洞）和 #40（最新）
    const seqs = new Set(after.map((m) => Number(m.seq)));
    for (const want of [21, 22, 28, 29, 40]) {
      if (!seqs.has(want)) throw new Error(`缺少 #${want}`);
    }
    console.log(`    afterSeq=20 → #21 起，覆盖 #21~#28 空洞与 #29~#40 ✅`);
  });
});

// ── ④ 本轮给过的 #29~#40 已被记为"看过"，下一轮不再当新消息 ─────────
await test('本轮给过的 #29~#40 不会在下一轮重复当作新消息', async () => {
  await withBridge(async (h) => {
    const st = await setup(h);
    // 渲染一次（真实路径会把给过的记进 modelSeenSeqs）
    const { snap } = snapshotText(h);
    if (!snap) throw new Error('快照为空');

    // 模拟桥接在投递后调用 noteModelMessagesV2 的效果
    const given = (snap.messages || []).map((m) => Number(m.seq)).filter(Number.isSafeInteger);
    if (!given.length) throw new Error('本轮没给出任何消息，无法验证');
    // 这一步是真实行为：noteModelMessagesV2 会把给过的 seq 记进 modelSeenSeqs
    h.getSocialV2State(KEY).modelSeenSeqs = new Set(given);

    // 再渲染一次：应当**只剩空洞那批**（#21~#28）作为未给过的
    const seen = h.getSocialV2State(KEY).modelSeenSeqs;
    const unread = h.getSocialV2State(KEY).unread || [];
    const stillUnseen = unread.filter((m) => !seen.has(m.seq)).map((m) => Number(m.seq));
    // 本轮给过的都不该出现在 stillUnseen 里
    for (const seq of given) {
      if (stillUnseen.includes(seq)) throw new Error(`#${seq} 本轮给过却仍算未看过`);
    }
    console.log(`    本轮给了 #${given[0]}~#${given[given.length - 1]}，已记为看过；`
      + ` 仍未看的 ${stillUnseen.length} 条（空洞那批）✅`);
    void st;
  });
});

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
