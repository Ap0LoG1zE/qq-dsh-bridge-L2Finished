// 主动机会唤醒的提示词。
//
// ── 历史 ────────────────────────────────────────────────────────────────
// 2026-11-15：真实故障「群聊的主动唤醒有提示词，私聊的没有」。
//   当时根因是 `buildWakePromptV2` 对两种会话用了同一句
//   「（群里安静了一阵，想说什么可以说。）」——
//   私聊收到「群里」两个字，判断这跟自己无关，于是不开口。
//   修法是按会话类型分句：私聊说"这个人"，群聊才说"群里"。
//
// ── 2026-11-25 重写 ─────────────────────────────────────────────────────
// **通用提示整段删掉了**，所以本文件的旧断言（`这个人有阵子没说话` /
// `群里安静了一阵`）已经和实现对不上 —— 那不是回归，是设计变了。
//
// 新契约：
//   1. 私聊主动唤醒**必须带具体动机**（`proactiveCheck:动机`）。
//      由 life-proactive.js 的候选生成器提供；没有候选就不唤醒。
//   2. 群聊仍走旧的随机唤醒，文案保持「群里安静了一阵」。
//   3. 其它唤醒原因（timeout / replyCheck / poke）不受影响。
//
// 为什么这条重要（真实故障）：日志里出现过
//   `[proactive] private:84420221 tier=3 route=curiosity`
//   而唤醒词里一个字都没有 —— 她看着四条没回的消息不知道为什么要开口，
//   只能标记已读继续睡。根因是候选为 0 时退到了概率兜底，而兜底没有动机。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let tests = 0;

async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '—', e?.stack ?? e); }
}

async function withBridge(run) {
  // harness 的 allow 里私聊白名单是 ['123']，群是 ['456']
  const h = await bridgeHarness({ config: { socialV2: {
    send: { minSendIntervalMs: 0, observeAfterSendMs: 0 },
    proactive: { enabled: true },
    sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  try { await run({ h }); }
  finally { await h.close(); }
}

// ── 1. 私聊：带动机时必须说出来，且不能出现"群里" ──────────────────────
await test('私聊的主动机会唤醒带出动机，且不说"群里"', async () => {
  await withBridge(async ({ h }) => {
    const key = 'private:123';
    h.getSocialV2State(key);
    // reason 形如 `proactiveCheck:动机`（bridge 就是这么传的）
    const prompt = h.buildWakePromptV2(key, 'proactiveCheck:手头的事告一段落，忽然想起你，想看看你在忙什么');
    assert.ok(typeof prompt === 'string' && prompt.length > 0, '应当有提示词');
    assert.doesNotMatch(prompt, /群里/, `私聊不该出现"群里"，实际：\n${prompt}`);
    assert.match(prompt, /手头的事告一段落/, `动机必须出现在唤醒词里，实际：\n${prompt}`);
    // 外面套括号：`（…。）`，与 poke / replyCheck 同一位置和口吻
    assert.match(prompt, /（手头的事告一段落[^）]*）/, `动机要套在括号里，实际：\n${prompt}`);
  });
});

// ── 1b. 私聊：没有动机时**不编通用话**（这是新契约的核心）────────────
await test('私聊的主动唤醒没有动机时不编通用话', async () => {
  await withBridge(async ({ h }) => {
    const key = 'private:123';
    h.getSocialV2State(key);
    const prompt = h.buildWakePromptV2(key, 'proactiveCheck');
    // 旧版的「这个人有阵子没说话」必须彻底消失 ——
    // 否则等于又回到"闹钟响了"的通用话。
    assert.doesNotMatch(prompt, /这个人有阵子没说话/, `旧通用文案应已删除，实际：\n${prompt}`);
    assert.doesNotMatch(prompt, /群里/, '私聊不该出现"群里"');
  });
});

// ── 1c. 动机末尾的句号不该重复 ─────────────────────────────────────────
await test('动机自带句号时不重复加句号', async () => {
  await withBridge(async ({ h }) => {
    const key = 'private:123';
    h.getSocialV2State(key);
    const prompt = h.buildWakePromptV2(key, 'proactiveCheck:外面天色一直闷闷的。');
    assert.doesNotMatch(prompt, /。。/, `不该出现连续句号，实际：\n${prompt}`);
    assert.match(prompt, /外面天色一直闷闷的/, '动机应保留');
  });
});

// ── 2. 群聊：保持原来的文案 ────────────────────────────────────────────
await test('群聊的主动机会提示词仍是"群里安静了一阵"', async () => {
  await withBridge(async ({ h }) => {
    const key = 'group:456';
    h.getSocialV2State(key);
    const prompt = h.buildWakePromptV2(key, 'proactiveGroupCheck');
    assert.match(prompt, /群里安静了一阵/, `群聊文案不该变，实际：\n${prompt}`);
    assert.doesNotMatch(prompt, /这个人有阵子没说话/, '群聊不该用私聊文案');
  });
});

// ── 3. 别的唤醒原因不受影响（防止改这里时误伤）────────────────────────
await test('其它唤醒原因的文案没被波及', async () => {
  await withBridge(async ({ h }) => {
    const priv = 'private:123';
    const grp = 'group:456';
    h.getSocialV2State(priv);
    h.getSocialV2State(grp);

    for (const key of [priv, grp]) {
      const t = h.buildWakePromptV2(key, 'timeout');
      assert.match(t, /潜水时间到了/, `${key} timeout 文案变了：${t}`);
      const r = h.buildWakePromptV2(key, 'replyCheck');
      assert.match(r, /对方回你了/, `${key} replyCheck 文案变了：${r}`);
      const p = h.buildWakePromptV2(key, 'poke');
      assert.match(p, /有人拍了一拍/, `${key} poke 文案变了：${p}`);
    }
  });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
