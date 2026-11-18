// 验证：唤醒包给**最新**的 N 条未读，且水位不会跳过中间空洞。
//
// 操作者要的语义（2026-11-19）：
//   上次读到 #20，之后来了 20 条（#21~#40）
//   【本轮】给最新的 12 条（#29~#40）
//   中间 8 条（#21~#28）没给，让她调 qq_get_unread_messages 查
//   工具本身有 100 条上限，够用
//
// 两个必须同时成立的断言：
//   ① 【本轮】里是**最新**的那批（含最后一条）
//   ② readThroughSeq **不越过空洞**（否则中间那 8 条永久丢失）
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, '—', e.message); }
};

async function withBridge(run, cfg = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    send: { minSendIntervalMs: 0, observeAfterSendMs: 0 },
    proactive: { enabled: false }, sticker: { enabled: false },
    context: { wakeMessageLimit: 12, wakeRecentLimit: 0, wakeMaxChars: 20000, ...cfg },
  } } });
  h.setMode('reserved2');
  try { await run(h); } finally { await h.close(); }
}

// 造 n 条未读，前缀用于断言
function seed(h, n, prefix = '消息') {
  for (let i = 1; i <= n; i += 1) {
    h.appendSocialV2Message(KEY, 'someone', `${prefix}${i}`, `${prefix}${i}`, false, false, `f${i}`, [], '789');
  }
}

// buildWakePromptV2 给的是「唤醒词」（全是指令，没有消息正文）。
// 消息快照要用 buildWakeSnapshotV2，它的 .text 才是【本轮消息】那段。
function snapshotText(h) {
  const snap = h.buildWakeSnapshotV2(KEY);
  if (!snap) throw new Error('buildWakeSnapshotV2 返回空');
  if (typeof snap.text === 'string') return snap.text;
  // 有些版本返回 { messages, recent, ... } 由上层拼文本，这里做兜底拼接
  const lines = [];
  if (Array.isArray(snap.messages)) {
    lines.push(`【本轮消息】${snap.unreadCount ?? snap.messages.length} 条未读，读到 #${snap.readThroughSeq ?? '?'}`);
    for (const m of snap.messages) lines.push(String(m.text ?? m.plain ?? ''));
  }
  if (Array.isArray(snap.recent) && snap.recent.length) {
    lines.push('【之前】');
    for (const m of snap.recent) lines.push(String(m.text ?? m.plain ?? ''));
  }
  return lines.join('\n');
}

// ── ① 20 条未读 → 给最新 12 条 ──────────────────────────────────────
await test('20 条未读 → 【本轮】给最新 12 条（#9~#20）', async () => {
  await withBridge(async (h) => {
    seed(h, 20);
    const prompt = snapshotText(h);
    if (!prompt.includes('消息20')) throw new Error(`最新的 #20 不在里面：\n${prompt.slice(0, 400)}`);
    if (!prompt.includes('消息9')) throw new Error(`#9 不在（没给够 12 条）：\n${prompt.slice(0, 400)}`);
    if (prompt.includes('消息8\n') || /消息8$/.test(prompt)) {
      throw new Error('不该包含 #8（应只给最新 12 条）');
    }
    console.log('    含 #9~#20（最新 12 条）✅');
  });
});

// ── ② 水位不能跳过空洞 ───────────────────────────────────────────────
await test('水位停在空洞之前（≤#8），不是 #20', async () => {
  await withBridge(async (h) => {
    seed(h, 20);
    const prompt = snapshotText(h);
    const m = prompt.match(/读到 #(\d+)/);
    if (!m) throw new Error(`找不到"读到 #N"：\n${prompt.slice(0, 300)}`);
    const through = Number(m[1]);
    if (through > 8) {
      throw new Error(`水位 #${through} 越过了空洞（应 ≤8），#1~#8 会永久丢失`);
    }
    console.log(`    水位 #${through} ≤ 空洞前 #8 ✅`);
  });
});

// ── ③ 有缺口时要有补看提示 ───────────────────────────────────────────
await test('有缺口时给出 afterSeq 补看提示', async () => {
  await withBridge(async (h) => {
    seed(h, 20);
    const prompt = snapshotText(h);
    // 提示可能来自快照的 partial 标记，也可能由上层拼（两条路径都认）
    const snap = h.buildWakeSnapshotV2(KEY);
    const hasPartial = snap?.partial === true || /前面还有没显示|还有消息没显示/.test(prompt);
    if (!hasPartial) throw new Error(`没有缺口标记/提示：\n${prompt.slice(0, 400)}`);
    console.log(`    partial=${snap?.partial} ✅`);
  });
});

// ── ④ 未读少于上限 → 全给、无缺口 ───────────────────────────────────
await test('只有 5 条未读（< 12）→ 全给，且无缺口', async () => {
  await withBridge(async (h) => {
    seed(h, 5, '短');
    const prompt = snapshotText(h);
    for (let i = 1; i <= 5; i += 1) {
      if (!prompt.includes(`短${i}`)) throw new Error(`短${i} 没给：\n${prompt.slice(0, 300)}`);
    }
    const snap = h.buildWakeSnapshotV2(KEY);
    if (snap?.partial === true) throw new Error('没有缺口却标了 partial');
    const m = prompt.match(/读到 #(\d+)/);
    if (!m || Number(m[1]) !== 5) throw new Error(`水位应 #5，实际 ${m ? m[1] : '(无)'}`);
    console.log('    5 条全给、水位 #5、无缺口 ✅');
  });
});

// ── ⑤ 恰好等于上限 → 全给、无缺口 ───────────────────────────────────
await test('恰好 12 条 → 全给、水位到头、无缺口', async () => {
  await withBridge(async (h) => {
    seed(h, 12, '满');
    const prompt = snapshotText(h);
    for (let i = 1; i <= 12; i += 1) {
      if (!prompt.includes(`满${i}`)) throw new Error(`满${i} 没给：\n${prompt.slice(0, 300)}`);
    }
    const snap = h.buildWakeSnapshotV2(KEY);
    if (snap?.partial === true) throw new Error('刚好 12 条却标了 partial');
    const m = prompt.match(/读到 #(\d+)/);
    if (!m || Number(m[1]) !== 12) throw new Error(`水位应 #12，实际 ${m ? m[1] : '(无)'}`);
    console.log('    12 条全给、水位 #12、无缺口 ✅');
  });
});

// ── ⑥ 上一轮读到 #20，之后来 20 条 → 水位仍是 #20 ────────────────────
await test('上一轮读到 #20，再来 20 条 → 给最新 12 条、水位停在 #20', async () => {
  await withBridge(async (h) => {
    // 先造 20 条并"让她读过"（推进水位到 20）
    seed(h, 20, '旧');
    const st0 = h.getSocialV2State(KEY);
    st0.lastReadThroughSeq = 20;
    // 再造成 20 条新的（#21~#40）
    for (let i = 21; i <= 40; i += 1) {
      h.appendSocialV2Message(KEY, 'someone', `新${i}`, `新${i}`, false, false, `n${i}`, [], '789');
    }

    const prompt = snapshotText(h);
    const m = prompt.match(/读到 #(\d+)/);
    if (!m) throw new Error(`找不到"读到 #N"：\n${prompt.slice(0, 300)}`);
    const through = Number(m[1]);
    // 关键断言：水位必须仍是 #20（上一轮读到的），不是 #40
    if (through !== 20) {
      throw new Error(`水位是 #${through}，应为 #20（上一轮读到的最大 seq）`);
    }
    // 且最新那条必须在
    if (!prompt.includes('新40')) throw new Error('#40（最新）不在【本轮】里');
    // 中间的空洞（#21~#28）不该出现
    if (/新21\b/.test(prompt)) throw new Error('#21 不该出现（应只给最新 12 条）');
    console.log(`    水位 #${through}、含 #40、不含 #21 ✅`);
  });
});

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
