// 用最小 mock 的 Cordis ctx 真正跑一遍 apply()，验证：
//   ① apply 不抛错
//   ② 注册的命令名能通过 DSH 的 COMMAND_NAME 校验
//   ③ handler 在 dry 模式下能产出合理文本
//
// 这个测试的价值：能抓出「注册时抛 TypeError 被吞掉，命令静默消失」这类问题
// —— 之前命令名写成 compactV2（大写 V）就是这样，界面上毫无提示。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, inject, name } from './index.js';

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

/** 造一个最小 ctx：只实现插件用到的 commands / compaction / tokenMeter / effect。 */
function makeCtx({ nodes = [], totalTokens = 0 } = {}) {
  const registered = [];
  const effects = [];
  return {
    registered,
    effects,
    ctx: {
      // Cordis 的 ctx.effect(fn, label)：立即执行 fn，把返回值当 dispose。
      // 命令注册必须包在这里 —— 裸调 register 拿不到生命周期归属，命令不出现。
      effect(fn, label) {
        effects.push(label ?? '(no label)');
        return fn();
      },
      commands: {
        register(def) {
          // 复刻 DSH 的校验（@deepseek-ai/dsh-commands 里的 normalizeDefinition）
          if (!COMMAND_NAME.test(def.name)) {
            throw new TypeError(`command name "${def.name}" must match ${String(COMMAND_NAME)}`);
          }
          if (typeof def.description !== 'string') {
            throw new TypeError(`command "${def.name}" description must be a string`);
          }
          if (def.description.trim().length === 0) {
            throw new TypeError(`command "${def.name}" description must not be empty`);
          }
          if (typeof def.handler !== 'function') {
            throw new TypeError(`command "${def.name}" handler must be a function`);
          }
          registered.push(def);
          return () => { /* dispose */ };
        },
      },
      tokenMeter: {
        measure: () => ({ nodes, totalTokens, surfaceTokens: totalTokens }),
      },
      compaction: {
        compactRegion: async () => ({ shadowedSeqs: [], shadowedTokenCount: 0 }),
      },
    },
  };
}

/** 造节点：node[0] 当 system（不参与压缩）。 */
const makeNodes = (tokenList) => tokenList.map((tokens, i) => ({ seq: i * 10 + 1, tokens }));

test('apply() 能注册命令，且命令名合法', () => {
  const { ctx, registered, effects } = makeCtx();
  apply(ctx, { retainTokens: 200000 });
  assert.equal(registered.length, 1, '应注册 1 个命令');
  const def = registered[0];
  assert.equal(def.name, 'compact-v2');
  assert.ok(COMMAND_NAME.test(def.name), `命令名必须匹配 ${String(COMMAND_NAME)}：${def.name}`);
  assert.ok(def.description.includes('compact-v2'), '描述里应带用法提示');
  // 注册必须在 ctx.effect 里（否则 Cordis 拿不到生命周期归属，命令不出现）
  assert.ok(effects.length >= 1, 'apply 必须用 ctx.effect 包裹注册');
});

test('inject 声明的三个服务都是真服务名', () => {
  assert.deepEqual(inject, ['commands', 'compaction', 'tokenMeter']);
  for (const s of inject) assert.ok(/^[a-zA-Z][\w]*$/.test(s), `服务名格式可疑: ${s}`);
});

test('handler：历史不够长时明确说「没有可压的区间」', async () => {
  const nodes = makeNodes([500, 30000, 30000]);   // 6 万，< 20 万保留
  const { ctx, registered } = makeCtx({ nodes, totalTokens: 60500 });
  apply(ctx, { retainTokens: 200000 });
  const out = await registered[0].handler({
    agent: { session: {}, options: {} },
    rawInput: '',
    signal: { aborted: false },
  });
  assert.equal(out.kind, 'success');
  assert.match(out.text, /没有可压的区间/);
});

test('handler：dry 模式只报告，不调用 compactRegion', async () => {
  const nodes = makeNodes([500, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]);
  const { ctx, registered } = makeCtx({ nodes, totalTokens: 240500 });
  let called = false;
  ctx.compaction.compactRegion = async () => { called = true; return {}; };
  apply(ctx, { retainTokens: 100000 });
  const out = await registered[0].handler({
    agent: { session: {}, options: {} },
    rawInput: 'dry',
    signal: { aborted: false },
  });
  assert.equal(out.kind, 'success');
  assert.match(out.text, /dry-run/);
  assert.equal(called, false, 'dry 模式绝不能真压');
});

test('handler：非 dry 会真的调 compactRegion，且范围在 system 之后', async () => {
  const nodes = makeNodes([500, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]);
  const { ctx, registered } = makeCtx({ nodes, totalTokens: 240500 });
  let captured = null;
  ctx.compaction.compactRegion = async (start, end, agentArg) => {
    captured = { start, end, agentArg };
    return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 90000 };
  };
  apply(ctx, { retainTokens: 100000 });
  const out = await registered[0].handler({
    agent: { session: {}, options: { model: 'x' } },
    rawInput: '',
    signal: { aborted: false },
  });
  assert.equal(out.kind, 'success');
  assert.ok(captured, '应调用 compactRegion');
  assert.notEqual(captured.start, nodes[0].seq, 'start 不能是 system 节点');
  assert.ok(captured.end >= captured.start, 'end 应 >= start');
  assert.match(out.text, /压缩完成/);
});

test('handler：拿不到 agent 时明确报错，不静默失败', async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, {});
  const out = await registered[0].handler({ rawInput: '', signal: { aborted: false } });
  assert.equal(out.kind, 'error');
  assert.match(out.text, /拿不到当前 agent/);
});

test('handler：compactRegion 抛错时如实报告', async () => {
  const nodes = makeNodes([500, 30000, 30000, 30000, 30000, 30000]);
  const { ctx, registered } = makeCtx({ nodes, totalTokens: 150500 });
  ctx.compaction.compactRegion = async () => { throw new Error('unbalanced edge'); };
  apply(ctx, { retainTokens: 50000 });
  const out = await registered[0].handler({
    agent: { session: {}, options: {} },
    rawInput: '',
    signal: { aborted: false },
  });
  assert.equal(out.kind, 'error');
  assert.match(out.text, /unbalanced edge/);
});
