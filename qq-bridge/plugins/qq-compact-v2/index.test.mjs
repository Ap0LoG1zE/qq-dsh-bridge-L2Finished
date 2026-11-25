// qq-compact-v2 的单元测试。
//
// 两类：
//   ① 纯函数（computeRange / parseArgs）—— 决定"压哪儿、留哪儿"，算错就丢历史
//   ② 真实跑 apply()（用最小 mock ctx）—— 抓"注册时抛错被吞掉""依赖没齐 apply 不执行"
//
// ② 尤其重要：历史上就是因为 inject 里多写了一个 tokenMeter，
// 导致 apply() 一次都没被调用、命令根本不存在，而且完全没有报错。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, inject, name, __test } from './index.js';

const { computeRange, parseArgs } = __test;

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

// ── ① 纯函数 ─────────────────────────────────────────────────────────

const makeNodes = (tokenList) => tokenList.map((tokens, i) => ({ seq: i * 10 + 1, tokens }));

test('computeRange：保留尾部 20 万，切点在累加到 retainTokens 的位置', () => {
  // system(500) + 10 个 3 万 = 30 万
  const nodes = makeNodes([500, ...Array(10).fill(30000)]);
  const r = computeRange(nodes, 200000);
  assert.ok(r, '应当有可压区间');
  // 从尾往头累加 3万×6=18万 < 20万，再加一个=21万 ≥ 20万 ⇒ keepFromIdx = index 4
  assert.equal(r.keptFrom, nodes[4].seq);
  assert.equal(r.end, nodes[3].seq);
  assert.ok(r.keptTokens >= 200000);
});

test('computeRange：历史不够长时不压', () => {
  assert.equal(computeRange(makeNodes([500, 30000, 30000]), 200000), null);
});

test('computeRange：节点太少返回 null', () => {
  assert.equal(computeRange(makeNodes([500]), 1000), null);
  assert.equal(computeRange(makeNodes([500, 100]), 1000), null);
  assert.equal(computeRange([], 1000), null);
  assert.equal(computeRange(null, 1000), null);
});

test('computeRange：system 节点（index 0）永不进压缩区间', () => {
  const nodes = makeNodes([999999, ...Array(8).fill(30000)]);
  const r = computeRange(nodes, 100000);
  assert.ok(r);
  assert.notEqual(r.start, nodes[0].seq, 'start 不能是 system');
  assert.equal(r.start, nodes[1].seq);
});

test('computeRange：retainTokens 极小 → 只保留最后一个', () => {
  const nodes = makeNodes([500, 1000, 1000, 1000, 1000]);
  const r = computeRange(nodes, 1);
  assert.ok(r);
  assert.equal(r.keptFrom, nodes[4].seq);
  assert.equal(r.end, nodes[3].seq);
});

test('computeRange：compacted + kept = 除 system 外的全部', () => {
  const nodes = makeNodes([500, 10000, 10000, 10000, 10000]);
  const r = computeRange(nodes, 20000);
  assert.ok(r);
  const sumNoSystem = nodes.slice(1).reduce((s, n) => s + n.tokens, 0);
  assert.equal(r.compactedTokens + r.keptTokens, sumNoSystem);
});

test('parseArgs：默认、dry 别名、数字覆盖、非法值忽略', () => {
  assert.deepEqual(parseArgs('', 200000), { dry: false, retainTokens: 200000 });
  assert.deepEqual(parseArgs(undefined, 200000), { dry: false, retainTokens: 200000 });
  for (const s of ['dry', '--dry', '-d', 'DRY']) {
    assert.equal(parseArgs(s, 200000).dry, true, `${s} 应识别为 dry`);
  }
  assert.deepEqual(parseArgs('150000', 200000), { dry: false, retainTokens: 150000 });
  assert.deepEqual(parseArgs('dry 80000', 200000), { dry: true, retainTokens: 80000 });
  assert.deepEqual(parseArgs('abc', 200000), { dry: false, retainTokens: 200000 });
  assert.deepEqual(parseArgs('-5', 200000), { dry: false, retainTokens: 200000 });
});

// ── ② 真实跑 apply() ──────────────────────────────────────────────────

function makeCtx({ nodes = [], totalTokens = 0, hasMeter = true } = {}) {
  const registered = [];
  const effects = [];
  const ctx = {
    effect(fn, label) {
      effects.push(label ?? '(no label)');
      return fn();
    },
    commands: {
      register(def) {
        // 复刻 DSH 的 normalizeDefinition 校验
        if (!COMMAND_NAME.test(def.name)) {
          throw new TypeError(`command name "${def.name}" must match ${String(COMMAND_NAME)}`);
        }
        if (typeof def.description !== 'string' || !def.description.trim()) {
          throw new TypeError(`command "${def.name}" description must be a non-empty string`);
        }
        if (typeof def.handler !== 'function') {
          throw new TypeError(`command "${def.name}" handler must be a function`);
        }
        registered.push(def);
        return () => { /* dispose */ };
      },
    },
    compaction: {
      compactRegion: async () => ({ shadowedSeqs: [], shadowedTokenCount: 0 }),
    },
  };
  if (hasMeter) ctx.tokenMeter = { measure: () => ({ nodes, totalTokens, surfaceTokens: totalTokens }) };
  return { ctx, registered, effects };
}

test('inject 只声明 commands / compaction（不能加 tokenMeter）', () => {
  // 这是硬约束：多声明一个拿不到的服务，apply 永远不会被调用，且不报错。
  assert.deepEqual(inject, ['commands', 'compaction']);
});

test('apply() 用 ctx.effect 注册命令，且名字合法', () => {
  const { ctx, registered, effects } = makeCtx();
  apply(ctx, { retainTokens: 200000 });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'compact-v2');
  assert.ok(COMMAND_NAME.test(registered[0].name));
  assert.ok(effects.length >= 1, '注册必须包在 ctx.effect 里');
});

test('没 tokenMeter 也能注册（懒取，不阻塞加载）', () => {
  const { ctx, registered } = makeCtx({ hasMeter: false });
  apply(ctx, { retainTokens: 200000 });
  assert.equal(registered.length, 1, '缺少 tokenMeter 不该影响注册');
});

test('handler：没有 tokenMeter 且没有节点 → 明确报错', async () => {
  const { ctx, registered } = makeCtx({ hasMeter: false });
  apply(ctx, {});
  const out = await registered[0].handler({ agent: { session: {} }, rawInput: '', signal: { aborted: false } });
  assert.equal(out.kind, 'error');
  assert.match(out.text, /tokenMeter|节点/);
});

test('handler：历史不够长时明确说「没有可压的区间」', async () => {
  const { ctx, registered } = makeCtx({ nodes: makeNodes([500, 30000, 30000]), totalTokens: 60500 });
  apply(ctx, { retainTokens: 200000 });
  const out = await registered[0].handler({ agent: { session: {} }, rawInput: '', signal: { aborted: false } });
  assert.equal(out.kind, 'success');
  assert.match(out.text, /没有可压的区间/);
});

test('handler：dry 模式只报告，绝不调用 compactRegion', async () => {
  const { ctx, registered } = makeCtx({
    nodes: makeNodes([500, ...Array(8).fill(30000)]), totalTokens: 240500,
  });
  let called = false;
  ctx.compaction.compactRegion = async () => { called = true; return {}; };
  apply(ctx, { retainTokens: 100000 });
  const out = await registered[0].handler({ agent: { session: {} }, rawInput: 'dry', signal: { aborted: false } });
  assert.equal(out.kind, 'success');
  assert.match(out.text, /dry-run/);
  assert.equal(called, false, 'dry 模式绝不能真压');
});

test('handler：非 dry 真调 compactRegion，范围在 system 之后', async () => {
  const nodes = makeNodes([500, ...Array(8).fill(30000)]);
  const { ctx, registered } = makeCtx({ nodes, totalTokens: 240500 });
  let captured = null;
  ctx.compaction.compactRegion = async (start, end, agentArg) => {
    captured = { start, end, agentArg };
    return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 90000 };
  };
  apply(ctx, { retainTokens: 100000 });
  const out = await registered[0].handler({
    agent: { session: {}, options: { model: 'x' } }, rawInput: '', signal: { aborted: false },
  });
  assert.equal(out.kind, 'success');
  assert.ok(captured, '应调用 compactRegion');
  assert.notEqual(captured.start, nodes[0].seq, 'start 不能是 system');
  assert.ok(captured.end >= captured.start);
  assert.match(out.text, /压缩完成/);
});

test('handler：拿不到 agent 时明确报错', async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, {});
  const out = await registered[0].handler({ rawInput: '', signal: { aborted: false } });
  assert.equal(out.kind, 'error');
  assert.match(out.text, /agent/);
});

test('handler：compactRegion 抛错时如实报告', async () => {
  const { ctx, registered } = makeCtx({
    nodes: makeNodes([500, ...Array(5).fill(30000)]), totalTokens: 150500,
  });
  ctx.compaction.compactRegion = async () => { throw new Error('unbalanced edge'); };
  apply(ctx, { retainTokens: 50000 });
  const out = await registered[0].handler({ agent: { session: {} }, rawInput: '', signal: { aborted: false } });
  assert.equal(out.kind, 'error');
  assert.match(out.text, /unbalanced edge/);
});
