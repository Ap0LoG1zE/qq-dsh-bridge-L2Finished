// /compact-v2 —— 按「保留尾部 N 万 token」压缩会话历史。
//
// ── 命令名为什么是连字符而不是 compactV2 ──────────────────────────────────
//
// DSH 对命令名有严格正则（`@deepseek-ai/dsh-commands` 里的 COMMAND_NAME）：
//
//     const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;
//     function normalizeDefinition(definition) {
//       if (!COMMAND_NAME.test(definition.name))
//         throw new TypeError(`command name "${definition.name}" must match ${...}`);
//
// **只允许小写字母、数字、下划线、连字符。** 大写字母（例如 compactV2 的 V）
// 会在 register 时直接抛 TypeError —— 症状是"命令根本不存在"，而且如果
// 错误被 apply 的上下文吞掉，界面上一点提示都没有。
// 所以命令名定为 `compact-v2`，输入时敲 `/compact-v2`。
//
// ── 为什么需要这个插件 ──────────────────────────────────────────────────────
//
// DSH 自带的 `/compact`（@deepseek-ai/dsh-command-compact）走的是
// `ctx.compaction.compactNow()`，而 `compactNow` 的实现里那一行是**硬编码 0**：
//
//     selectCompactableRange(session, measurement, 0)
//
// `retainTokens = 0` ⇒ 那个从尾往头的累加循环**第一轮就 break** ⇒
// 只保留最后一个节点，其余全部压成摘要。实测后果是「4 万 token 的上下文
// 一夜之间掉到几千，前面一千多条对话全没了」—— 用户以为的「保留尾部 20 万」
// 从未发生过。
//
// 但 DSH 的 `CompactionEngine` 接口**同时暴露了 `compactRegion(start, end, ...)`**，
// 那是「显式指定一个闭区间压成摘要」的公开入口，范围由调用方自己算。
// 所以本插件用 `ctx.tokenMeter.measure()` 自己按 token 累加算出切点，
// 再调 `compactRegion` —— 这样「保留多少」就完全由我们说了算。
//
// ── 两种用法 ────────────────────────────────────────────────────────────────
//
//   /compact-v2            按默认配置压（config.retainTokens，默认 20 万）
//   /compact-v2 dry        只算范围和校验，不实际压缩（安全预览）
//   /compact-v2 150000     指定保留 15 万 token
//
// 建议第一次先用 `dry` 跑一遍，看清「要压哪些、留哪些、工具配对是否平衡」再真压。
//
// ── 安全约束 ────────────────────────────────────────────────────────────────
//
// DSH 的 compactRegion 有两条硬性要求，本插件在调用前**自己先校验**，
// 不合格就明确报错、绝不硬压：
//   ① 切点必须「工具配对平衡」——不能切在 tool_call 和它的 tool_result 之间
//      （DSH 会抛 unbalanced，而且是压到一半才抛）。
//   ② start/end 必须是 surface 位置上的合法闭区间（end >= start）。
//
// ── 会不会破坏 KV cache ─────────────────────────────────────────────────────
//
// 会。压缩改写历史前缀，provider 的 KV cache 按前缀命中，改了就失效，
// 那一步要重算全部历史（实测几十秒）。所以**不要频繁调**：只在上下文确实
// 太大、且当前没人等着回复时用它。它的价值是「可控地保留尾部」，
// 而不是「省那一次 prefill」。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'qq-compact-v2';
// 需要：命令注册表、压缩引擎、token 计量器。
// 三个都必须在，少一个就没法安全地算范围或执行压缩。
export const inject = ['commands', 'compaction', 'tokenMeter'];

const DEFAULT_RETAIN_TOKENS = 200_000;
const MIN_COMPACT_TOKENS = 20_000;

/** 把用户输入解析成 { dry, retainTokens }。 */
function parseArgs(rawInput, fallbackRetain) {
  const text = String(rawInput ?? '').trim();
  const parts = text ? text.split(/\s+/) : [];
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
 * 按「尾部累计 retainTokens」算出要压的 [start, end]。
 *
 * 算法与 DSH 的 selectCompactableRange 一致（从尾往头累加、到量即停），
 * 但**retainTokens 用我们自己的值**，不是 0。
 *
 * @returns {{ start: number, end: number, keptFrom: number, keptTokens: number,
 *             compactedTokens: number, totalNodes: number } | null}
 *          null 表示没有可压的区间（节点太少 / 保留量已经覆盖全部）。
 */
function computeRange(nodes, retainTokens) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  // 第一个节点通常是 system/message，不能压（DSH 也是从 firstIdx=1 起）。
  const firstIdx = 1;
  if (nodes.length <= firstIdx + 1) return null;

  let accumulated = 0;
  let keepFromIdx = nodes.length;
  for (let i = nodes.length - 1; i >= firstIdx; i -= 1) {
    accumulated += Number(nodes[i]?.tokens) || 0;
    keepFromIdx = i;
    if (accumulated >= retainTokens) break;
  }

  // 保留窗口已经吃掉全部可压节点 ⇒ 没得压。
  if (keepFromIdx <= firstIdx) return null;

  const keptTokens = nodes
    .slice(keepFromIdx)
    .reduce((sum, n) => sum + (Number(n?.tokens) || 0), 0);
  const compactedTokens = nodes
    .slice(firstIdx, keepFromIdx)
    .reduce((sum, n) => sum + (Number(n?.tokens) || 0), 0);

  return {
    start: nodes[firstIdx].seq,
    end: nodes[keepFromIdx - 1].seq,
    keptFrom: nodes[keepFromIdx].seq,
    keptTokens,
    compactedTokens,
    totalNodes: nodes.length,
  };
}

/**
 * 尝试用 DSH 的 toolPairing 辅助函数校验切点。
 *
 * 这两个函数在 `@deepseek-ai/dsh-compaction/tool-pairing` 子路径里。
 * 但它们**不是稳定公开 API**（DSH 升级可能改路径），所以这里做**可选导入**：
 * 导不进来就跳过预检，靠 compactRegion 自己的校验兜底（它会在写入前抛错，
 * 不会留下半压缩状态）。
 */
async function loadToolPairing() {
  const candidates = [
    '@deepseek-ai/dsh-compaction/tool-pairing',
    '@deepseek-ai/dsh-compaction',
  ];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      const before = mod?.toolPairingBalancedBefore;
      const after = mod?.toolPairingBalancedAfter;
      if (typeof before === 'function' && typeof after === 'function') {
        return { before, after, from: spec };
      }
    } catch { /* 试下一个 */ }
  }
  return null;
}

export function apply(ctx, config) {
  const fallbackRetain = Math.max(
    MIN_COMPACT_TOKENS,
    Number(config?.retainTokens) || DEFAULT_RETAIN_TOKENS,
  );

  ctx.commands.register({
    // ⚠️ 必须是 /^[a-z][a-z0-9_-]*$/u 能匹配的名字（见文件头说明）。
    // 之前写成 compactV2，大写 V 让 register 抛 TypeError，命令根本没注册上。
    name: 'compact-v2',
    description: `按「保留尾部 N 万 token」压缩历史（默认 ${Math.round(fallbackRetain / 1000)}k）。用法：/compact-v2 [dry] [retainTokens]`,
    handler: async (invocation) => {
      const agent = invocation?.agent;
      const signal = invocation?.signal;
      if (!agent) {
        return { kind: 'error', text: 'compact-v2：拿不到当前 agent，无法定位会话。' };
      }
      if (signal?.aborted) {
        return { kind: 'error', text: 'compact-v2：请求已取消。' };
      }

      const { dry, retainTokens } = parseArgs(invocation.rawInput, fallbackRetain);

      // ── 量当前上下文 ────────────────────────────────────────────────
      let measurement;
      try {
        measurement = ctx.tokenMeter.measure(agent.session);
      } catch (error) {
        return { kind: 'error', text: `compact-v2：测量上下文失败 —— ${error?.message ?? error}` };
      }
      const nodes = measurement?.nodes ?? [];
      const totalTokens = Number(measurement?.totalTokens) || 0;

      const range = computeRange(nodes, retainTokens);
      if (!range) {
        return {
          kind: 'success',
          text: `compact-v2：没有可压的区间。当前 ${nodes.length} 个节点、约 ${fmt(totalTokens)} token；`
            + `保留 ${fmt(retainTokens)} → 可压部分为空（历史还没长到值得压）。`,
        };
      }

      // ── 工具配对预检（能拿到辅助函数就查，拿不到就靠 DSH 兜底）─────
      const pairing = await loadToolPairing();
      let pairingNote = '';
      if (pairing) {
        try {
          const okBefore = pairing.before(agent.session, range.start);
          const okAfter = pairing.after(agent.session, range.end);
          if (!okBefore.ok || !okAfter.ok) {
            const reason = !okBefore.ok ? okBefore.reason : okAfter.reason;
            return {
              kind: 'error',
              text: `compact-v2：切点会让工具调用与结果分离（${reason ?? 'unbalanced'}），已中止。`
                + '这是 DSH 的硬性约束，换一个保留量再试（差一点通常就能对齐）。',
            };
          }
          pairingNote = `工具配对预检：通过（来自 ${pairing.from}）`;
        } catch (error) {
          pairingNote = `工具配对预检：辅助函数调用失败（${error?.message ?? error}），交给 DSH 兜底`;
        }
      } else {
        pairingNote = '工具配对预检：拿不到 toolPairing 辅助函数，交给 DSH 的 compactRegion 自己校验';
      }

      const summary = [
        `上下文：${nodes.length} 个节点、约 ${fmt(totalTokens)} token`,
        `保留：尾部约 ${fmt(range.keptTokens)} token（目标 ${fmt(retainTokens)}）`,
        `要压：约 ${fmt(range.compactedTokens)} token（${range.start} → ${range.end}）`,
        `保留起点：seq ${range.keptFrom}`,
        pairingNote,
      ].join('\n  ');

      // ── dry：只报告，不动 ───────────────────────────────────────────
      if (dry) {
        return {
          kind: 'success',
          text: `compact-v2（dry-run，什么都没改）：\n  ${summary}`,
        };
      }

      // ── 真压 ───────────────────────────────────────────────────────
      try {
        const result = await ctx.compaction.compactRegion(
          range.start,
          range.end,
          { session: agent.session, options: agent.options ?? {} },
          signal,
        );
        const shadowed = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : 0;
        const shadowedTokens = Number(result?.shadowedTokenCount) || 0;
        return {
          kind: 'success',
          text: `compact-v2：压缩完成。压掉 ${shadowed} 个节点、约 ${fmt(shadowedTokens)} token；`
            + `尾部约 ${fmt(range.keptTokens)} token 原样保留。\n（压缩会改写历史前缀，下一次请求的 KV cache 会失效，属预期）`,
        };
      } catch (error) {
        return {
          kind: 'error',
          text: `compact-v2：压缩失败 —— ${error?.message ?? error}\n`
            + '（若提示 unbalanced/busy/changed，换个保留量或等这轮结束再试）',
        };
      }
    },
  });
}

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}k`;
  return String(v);
}

// 供单元测试直接引用，不参与运行时逻辑。
export const __test = { computeRange, parseArgs };
