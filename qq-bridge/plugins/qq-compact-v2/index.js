// qq-compact-v2 —— host 端：注册 /compact-v2 命令。
//
// ── 照抄 dsh-inject 的结构（它在同一台 DSH 上是能用的）──────────────────────
//
// dsh-inject 的 host 端关键几行：
//     export const name = "dsh-inject";
//     export const inject = ["agents", "llm", "commands", ...];
//     export function apply(ctx, rawConfig = {}) {
//       ...
//       ctx.effect(() => registerCommands(ctx, rawConfig));
//     }
//     function registerCommands(ctx, rawConfig) {
//       const d = ctx.commands.register({ definitionId, name, description, input, handler });
//       return () => d();
//     }
//
// 三个要点：
//   ① `inject` 里必须有 `commands`
//   ② `apply` 里**用 ctx.effect 包住**注册，并把 dispose 返回出去
//   ③ `register` 的返回值是 dispose 函数，effect 要把它返回
// 这三条本文件都照做了。
//
// ── 命令名为什么是 compact-v2 ───────────────────────────────────────────────
//
// DSH 的 @deepseek-ai/dsh-commands 里：
//     const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;
// 只允许小写字母、数字、下划线、连字符。大写字母会让 register 抛 TypeError。
//
// ── 为什么需要这个命令 ─────────────────────────────────────────────────────
//
// DSH 自带 `/compact` 走 `compactNow()`，那里 retainTokens 是**硬编码 0**：
//     selectCompactableRange(session, measurement, 0)
// 后果是"除最后一条外全部压成摘要"，不是保留尾部 N 万。
// 而 `CompactionEngine` 接口另外暴露了 `compactRegion(start, end, ...)`
// —— 显式闭区间的公开入口，范围由调用方自己算。本命令就走这条路。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'qq-compact-v2';
// ⚠️ 只声明 commands 和 compaction（2026-11-25 修，这是 apply 从不被调用的真因）。
//
// 原来还写了 'tokenMeter'，结果：模块被 import 了（日志有「模块已加载」），
// 但 apply() **一次都没被调用** —— Cordis 会一直等一个它在插件作用域里
// 拿不到的服务，永远不触发 apply，且不报错。
//
// 对照 DSH 自带的 command-compact：
//     const inject = ["commands", "compaction"];
// 它不依赖 tokenMeter。TokenMeter 本身还在 [Service.init] 里异步注册一堆投影，
// 依赖它更容易卡住。所以这里改成**运行时懒取**（见 measureTokens()），
// 拿不到就退回按节点数估算，不阻塞插件加载。
export const inject = ['commands', 'compaction'];

/**
 * 懒取 tokenMeter 并测量；拿不到就返回 null（调用方退回估算）。
 *
 * 不放进 inject 的原因见上面的注释 —— 声明成依赖会让 apply 永不执行。
 */
function measureTokens(ctx, session) {
  try {
    const meter = ctx.tokenMeter ?? ctx.get?.('tokenMeter');
    if (!meter || typeof meter.measure !== 'function') return null;
    return meter.measure(session);
  } catch {
    return null;
  }
}

const DEFAULT_RETAIN_TOKENS = 200_000;
const MIN_COMPACT_TOKENS = 20_000;

// 排查日志：「命令不出现」时完全没有反馈，所以主动留痕。
// 写失败一律静默，绝不影响插件本身。
const DIAG_LOG = path.join(os.homedir(), '.dsh', 'qq-compact-v2.log');
function trace(step, detail) {
  try {
    fs.appendFileSync(DIAG_LOG, `[${new Date().toISOString()}] ${step}${detail ? ` — ${detail}` : ''}\n`, 'utf8');
  } catch { /* 静默 */ }
}

trace('模块已加载', `inject=${JSON.stringify(inject)}`);

/** 解析参数：`dry` 开关 + 可选的 retainTokens 数字。 */
function parseArgs(rawInput, fallbackRetain) {
  const parts = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
  let dry = false;
  let retainTokens = fallbackRetain;
  for (const p of parts) {
    if (/^(dry|--dry|-d)$/i.test(p)) { dry = true; continue; }
    const n = Number(p);
    if (Number.isFinite(n) && n > 0) retainTokens = Math.floor(n);
  }
  return { dry, retainTokens };
}

/**
 * 按「尾部累计 retainTokens」算要压的 [start, end]。
 *
 * 算法与 DSH 的 selectCompactableRange 一致（从尾往头累加、到量即停），
 * 但 retainTokens 用我们自己的值，不是 0。
 * 返回 null 表示没有可压区间（节点太少 / 保留量已覆盖全部）。
 */
function computeRange(nodes, retainTokens) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  // 节点 0 是 system/message，不参与压缩（DSH 也是从 firstIdx=1 起）。
  const firstIdx = 1;
  if (nodes.length <= firstIdx + 1) return null;

  let accumulated = 0;
  let keepFromIdx = nodes.length;
  for (let i = nodes.length - 1; i >= firstIdx; i -= 1) {
    accumulated += Number(nodes[i]?.tokens) || 0;
    keepFromIdx = i;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx <= firstIdx) return null;

  const sum = (arr) => arr.reduce((s, n) => s + (Number(n?.tokens) || 0), 0);
  return {
    start: nodes[firstIdx].seq,
    end: nodes[keepFromIdx - 1].seq,
    keptFrom: nodes[keepFromIdx].seq,
    keptTokens: sum(nodes.slice(keepFromIdx)),
    compactedTokens: sum(nodes.slice(firstIdx, keepFromIdx)),
    totalNodes: nodes.length,
  };
}

/** 可选：能拿到 DSH 的 toolPairing 辅助函数就先自检，拿不到靠 compactRegion 兜底。 */
async function loadToolPairing() {
  for (const spec of ['@deepseek-ai/dsh-compaction/tool-pairing', '@deepseek-ai/dsh-compaction']) {
    try {
      const mod = await import(spec);
      if (typeof mod?.toolPairingBalancedBefore === 'function'
        && typeof mod?.toolPairingBalancedAfter === 'function') {
        return { before: mod.toolPairingBalancedBefore, after: mod.toolPairingBalancedAfter, from: spec };
      }
    } catch { /* 试下一个 */ }
  }
  return null;
}

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}k`;
  return String(v);
}

/** 命令处理体（独立成函数，便于测试与查日志）。 */
async function runCompactV2(ctx, invocation, fallbackRetain) {
  const agent = invocation?.agent;
  const signal = invocation?.signal;
  if (!agent) return { kind: 'error', text: 'compact-v2：拿不到当前 agent，无法定位会话。' };
  if (signal?.aborted) return { kind: 'error', text: 'compact-v2：请求已取消。' };

  const { dry, retainTokens } = parseArgs(invocation.rawInput, fallbackRetain);

  // tokenMeter 是懒取的（见 measureTokens 注释）。拿不到就用节点里的 tokens
  // 累加估算 —— 与 DSH 的计量口径接近，够用来定切点。
  const measurement = measureTokens(ctx, agent.session);
  const nodes = measurement?.nodes ?? [];
  let totalTokens = Number(measurement?.totalTokens) || 0;
  if (!measurement) {
    const sum = nodes.reduce((s, n) => s + (Number(n?.tokens) || 0), 0);
    if (!nodes.length) {
      return {
        kind: 'error',
        text: 'compact-v2：拿不到 ctx.tokenMeter，也没有可用的 surface 节点，无法计算压缩范围。',
      };
    }
    totalTokens = sum;
  }

  const range = computeRange(nodes, retainTokens);
  if (!range) {
    return {
      kind: 'success',
      text: `compact-v2：没有可压的区间。当前 ${nodes.length} 个节点、约 ${fmt(totalTokens)} token；`
        + `保留目标 ${fmt(retainTokens)} → 可压部分为空（历史还没长到值得压）。`,
    };
  }

  const pairing = await loadToolPairing();
  let pairingNote;
  if (pairing) {
    try {
      const okBefore = pairing.before(agent.session, range.start);
      const okAfter = pairing.after(agent.session, range.end);
      if (!okBefore.ok || !okAfter.ok) {
        const reason = !okBefore.ok ? okBefore.reason : okAfter.reason;
        return {
          kind: 'error',
          text: `compact-v2：切点会让工具调用与结果分离（${reason ?? 'unbalanced'}），已中止。`
            + '换一个保留量再试（差一点通常就能对齐）。',
        };
      }
      pairingNote = `工具配对预检：通过（${pairing.from}）`;
    } catch (error) {
      pairingNote = `工具配对预检：辅助函数调用失败（${error?.message ?? error}），交给 DSH 兜底`;
    }
  } else {
    pairingNote = '工具配对预检：拿不到 toolPairing 辅助函数，交给 compactRegion 自己校验';
  }

  const report = [
    `上下文：${nodes.length} 个节点、约 ${fmt(totalTokens)} token`,
    `保留：尾部约 ${fmt(range.keptTokens)} token（目标 ${fmt(retainTokens)}）`,
    `要压：约 ${fmt(range.compactedTokens)} token（seq ${range.start} → ${range.end}）`,
    `保留起点：seq ${range.keptFrom}`,
    pairingNote,
  ].join('\n  ');

  if (dry) return { kind: 'success', text: `compact-v2（dry-run，什么都没改）：\n  ${report}` };

  try {
    const result = await ctx.compaction.compactRegion(
      range.start,
      range.end,
      { session: agent.session, options: agent.options ?? {} },
      signal,
    );
    const shadowed = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : 0;
    const shadowedTokens = Number(result?.shadowedTokenCount) || 0;
    trace('压缩完成', `压掉 ${shadowed} 节点 / ${shadowedTokens} token`);
    return {
      kind: 'success',
      text: `compact-v2：压缩完成。压掉 ${shadowed} 个节点、约 ${fmt(shadowedTokens)} token；`
        + `尾部约 ${fmt(range.keptTokens)} token 原样保留。\n`
        + '（压缩改写历史前缀，下一次请求的 KV cache 会失效，属预期）',
    };
  } catch (error) {
    return {
      kind: 'error',
      text: `compact-v2：压缩失败 —— ${error?.message ?? error}\n`
        + '（若提示 unbalanced/busy/changed，换个保留量或等这轮结束再试）',
    };
  }
}

/**
 * 注册命令。返回值是 dispose 函数 —— 与 dsh-inject 的 registerCommands 同构。
 */
function registerCommands(ctx, retainTokens) {
  let dispose;
  try {
    dispose = ctx.commands.register({
      // definitionId 用包名做前缀（dsh-inject 用 "dsh-inject/inject"）。
      definitionId: '@local/qq-compact-v2/compact-v2',
      name: 'compact-v2',
      description: `按「保留尾部 N 万 token」压缩历史（默认 ${Math.round(retainTokens / 1000)}k）`,
      input: { hint: 'dry | 150000（留空 = 用默认保留量）' },
      handler: (invocation) => runCompactV2(ctx, invocation, retainTokens),
    });
    trace('注册成功', 'name=compact-v2');
  } catch (error) {
    trace('注册失败', `${error?.constructor?.name}: ${error?.message}`);
    throw error;
  }
  return () => {
    trace('注销');
    if (typeof dispose === 'function') dispose();
  };
}

export function apply(ctx, config) {
  const retainTokens = Math.max(
    MIN_COMPACT_TOKENS,
    Number(config?.retainTokens) || DEFAULT_RETAIN_TOKENS,
  );

  trace('apply() 被调用', `retainTokens=${retainTokens}`);
  // 探测依赖服务 + 可选的 tokenMeter（懒取的，缺了也能跑）
  for (const svc of [...inject, 'tokenMeter']) {
    let state = 'ok';
    try {
      if (ctx[svc] === undefined) state = 'undefined';
    } catch (error) { state = `throw:${error.message}`; }
    trace(`  服务 ${svc}`, state);
  }

  // 必须用 ctx.effect 包住（照抄 dsh-inject 的 ctx.effect(() => registerCommands(...))）
  ctx.effect(() => registerCommands(ctx, retainTokens), 'qq-compact-v2: /compact-v2');
}

// 供单元测试使用。
export const __test = { computeRange, parseArgs, runCompactV2 };
