// 记忆注入策略的回归测试（2026-11-10 定稿，2026-11-13 随冷启动链路重建调整）。
//
// 钉住的是操作者定的那条规则：**唤醒词里一律不带记忆正文**。
//   · 冷启动（新会话）/ 压缩后 → 只给一句「先查 qq_memory_query」的提示；
//   · 平时轮次 → 干净，长期事实内容真变了才提示一句；
//   · 提示只给一次，且提示里也不能夹带正文。
//
// 2026-11-13 变化：冷启动提示的判据从 `st.memNeedsSync` 换成 coldStartRegistry
// （按 DSH sessionId），并且**只认投递出口**。原来那两条对着 buildWakePromptV2
// 单次渲染写断言的用例已删除 —— 它们的断言在旧实现里全绿，而线上那句提示
// 从来没发出去过（第一遍渲染时标记就被清了，第二遍渲染什么都不挂）。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { addFact } from '../src/memory-facts.js';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const KEY = 'group:20001';
const P = 'private:10001';

async function withBridge(run) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: ['20001'] },
      socialV2: { sticker: { enabled: false }, wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } }
    },
    files: { 'state/current-role.json': JSON.stringify({ role: '角色A', mode: 'active' }) }
  });
  h.setMode('reserved2');
  h.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly', 'qq-chat-agent']);
  try { await run(h, path.join(h.temp, 'state')); } finally { await h.close(); }
}

/** 造一套三类记忆都有数据的状态。
 *
 * 长期三类（selfNote / memberImpression / longTerm）存在**全局**存储里
 * （见 src/bridge.js 的「记忆归属」注释块），不是 conversations[KEY]。
 */
function seedAll(h, stateDir) {
  const g = h.getSocialV2State('global');
  g.selfNotes = [{ text: 'SELFNOTE-MARKER 我不喜欢被叫大肥鱼', at: Date.now() }];
  g.memberImpressions = {
    群友A: { traits: ['IMPRESSION-MARKER 天天改我的提示词'], lastSeenAt: Date.now() }
  };
  addFact(stateDir, 'global', { text: 'FACT-MARKER 要说记住了别说记下了', tag: 'agreement' });
}

const BODY_MARKERS = ['SELFNOTE-MARKER', 'IMPRESSION-MARKER', 'FACT-MARKER'];

test('冷启动只给查询提示，不带任何记忆正文，且提示里只有一次调用', async () => {
  await withBridge(async (h, stateDir) => {
    seedAll(h, stateDir);
    // 冷启动提示现在只由登记表驱动（新会话 / 刚压缩过）。先建会话拿到登记，
    // 再渲染 —— 光传 reason='bootstrap' 已经不再触发提示。
    const sid = await h.ensureSession(KEY);
    assert.equal(h.coldStartStateOf(KEY).coldStart, true, '前置：新会话必须登记冷启动');
    const boot = h.buildWakePromptV2(KEY, 'bootstrap');
    void sid;
    for (const marker of BODY_MARKERS) {
      assert.ok(!boot.includes(marker), `唤醒包里不该出现记忆正文：${marker}`);
    }
    assert.match(boot, /qq_memory_query/, '冷启动必须提示她去查');
    // 提示里**只准出现一次**工具调用（并列写两条时她只挑一条执行，另一类整块被跳过）。
    const calls = boot.match(/qq_memory_query/g) || [];
    assert.equal(calls.length, 1, `提示里只能有一次 qq_memory_query，实际 ${calls.length} 次`);
    assert.ok(!/category='/.test(boot), '不得再教 category= 的分开查法');
    // 2026-11-13 操作者要求：**不写会返回什么**（那是工具自己的说明，写这里是会过期的副本）。
    for (const word of ['selfNote', '群友印象', '长期事实']) {
      assert.ok(!boot.includes(word), `提示里不该预览会返回什么（出现了 ${word}）`);
    }
    assert.match(boot, /不带 category/, '要说明怎么调（不带 category）');
  });
});

test('平时轮次完全干净：一个字都不提示', async () => {
  await withBridge(async (h, stateDir) => {
    seedAll(h, stateDir);
    // 走一次真实投递：冷启动那轮渲染时会把事实指纹写成基线，标记也被消费。
    // （直接手工把 consumedAt 塞进去会跳过"写基线"这一步，下一轮必然误报
    //   「长期记忆有变化」—— 那是测试造出来的假象，不是产品行为。）
    await h.sendWakePromptV2(KEY, 'anyMessage');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.coldStartStateOf(KEY).coldStart, false, '前置：冷启动那轮已消费');

    const normal = h.buildWakePromptV2(KEY, 'atMention@seq1');
    assert.ok(!normal.includes('qq_memory_query'), '没有变化时不该催她查');
    assert.ok(!normal.includes('长期记忆有变化'), '没有变化时不该说"有变化"');
    for (const marker of BODY_MARKERS) assert.ok(!normal.includes(marker));
  });
});

test('冷启动后下一轮不得误报「有变化」（基线要写，留空会假变化）', async () => {
  await withBridge(async (h, stateDir) => {
    addFact(stateDir, 'global', { text: 'FACT-ONE', tag: 'identity' });
    h.buildWakePromptV2(KEY, 'bootstrap');
    const normal = h.buildWakePromptV2(KEY, 'atMention@seq1');
    assert.ok(!normal.includes('长期记忆有变化'),
      '冷启动把指纹留空会让下一轮必然误报一次"有变化"——指纹是内容哈希，写基线不会漏检');
  });
});

test('长期事实内容真变化时能检测到，且提示里不带正文', async () => {
  await withBridge(async (h, stateDir) => {
    addFact(stateDir, 'global', { text: 'FACT-OLD', tag: 'identity' });
    h.buildWakePromptV2(KEY, 'bootstrap');
    h.buildWakePromptV2(KEY, 'atMention@seq1');
    addFact(stateDir, 'global', { text: 'FACT-NEW-MARKER 新约定', tag: 'agreement' });
    const changed = h.buildWakePromptV2(KEY, 'atMention@seq2');
    assert.ok(changed.includes('长期记忆有变化'), '新写一条事实必须被检测到');
    assert.ok(!changed.includes('FACT-NEW-MARKER'), '检测到变化也只提示，正文让她自己查');
    const after = h.buildWakePromptV2(KEY, 'atMention@seq3');
    assert.ok(!after.includes('长期记忆有变化'), '同一个变化只提示一次');
  });
});

test('冷启动提示不夹带正文，且是真的投递出去的那一份（不是被丢弃的草稿）', async () => {
  await withBridge(async (h, stateDir) => {
    seedAll(h, stateDir);
    const sid = await h.ensureSession(P);
    const before = h.calls.prompts.length;
    await h.sendWakePromptV2(P, 'anyMessage');
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(h.calls.prompts.length > before, '这一轮必须真的投递');
    const text = h.calls.prompts.at(-1).content.map((c) => c.text || '').join('');
    assert.match(text, /qq_memory_query/, '真正投递的正文里必须有记忆提示');
    for (const marker of BODY_MARKERS) assert.ok(!text.includes(marker), `正文里不该有：${marker}`);
    assert.equal(h.coldStartStateOf(P).coldStart, false, '投递成功后标记就该消费掉');
    void sid;
  });
});
