// 主动机会唤醒的提示词：**私聊不能说"群里"**（2026-11-15 修）。
//
// 真实故障：操作者发现「群聊的主动唤醒有提示词，私聊的没有」，
// 而且"以前什么都没改的时候她会主动找我"。
//
// 排查结论：机制对私聊**是生效的**（`scheduleProactiveCheckV2` 没有 group 限制，
// 日志也证实 `15:50:37 唤醒 private:10001（proactiveCheck）`）。
// 真正的问题是 `buildWakePromptV2` 里这一句对两种会话用了同一套文案：
//
//   （群里安静了一阵，想说什么可以说。）
//
// 私聊收到「群里」两个字，她判断这跟自己无关，于是不开口。
//
// 本文件锁住修复后的契约：私聊说"这个人"，群聊才说"群里"。
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

// ── 1. 私聊：必须说"这个人"，不能出现"群里" ─────────────────────────────
await test('私聊的主动机会提示词不说"群里"', async () => {
  await withBridge(async ({ h }) => {
    const key = 'private:123';
    h.getSocialV2State(key);
    const prompt = h.buildWakePromptV2(key, 'proactiveCheck');
    assert.ok(typeof prompt === 'string' && prompt.length > 0, '应当有提示词');
    assert.doesNotMatch(prompt, /群里/, `私聊不该出现"群里"，实际：\n${prompt}`);
    assert.match(prompt, /这个人有阵子没说话/, `应当用私聊口吻，实际：\n${prompt}`);
  });
});

// ── 2. 群聊：保持原来的文案，别被改坏 ────────────────────────────────────
await test('群聊的主动机会提示词仍是"群里安静了一阵"', async () => {
  await withBridge(async ({ h }) => {
    const key = 'group:456';
    h.getSocialV2State(key);
    const prompt = h.buildWakePromptV2(key, 'proactiveCheck');
    assert.match(prompt, /群里安静了一阵/, `群聊文案不该变，实际：\n${prompt}`);
    assert.doesNotMatch(prompt, /这个人有阵子没说话/, '群聊不该用私聊文案');
  });
});

// ── 3. 别的唤醒原因不受影响（防止改这里时误伤）────────────────────────────
await test('其它唤醒原因的文案没被波及', async () => {
  await withBridge(async ({ h }) => {
    const priv = 'private:123';
    const grp = 'group:456';
    h.getSocialV2State(priv);
    h.getSocialV2State(grp);

    // timeout / replyCheck 对两种会话都不该出现"群里"
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
