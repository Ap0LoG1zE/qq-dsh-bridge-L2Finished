/**
 * `/compact_chat` — manual conversation compaction with a configurable
 * verbatim tail (200,000 tokens by default).
 *
 * The built-in `/compact` command delegates to the compaction seam's
 * `compactNow()`, which selects a range with a zero-token retained tail. This
 * plugin owns the same durable transaction instead, so the retained tail is a
 * first-class option: it prices the current surface with `ctx.tokenMeter`,
 * keeps the newest surface nodes until the tail budget is covered, summarizes
 * everything older with one auxiliary model call, and replaces that span with
 * a single checkpoint message.
 *
 * The transaction is intentionally the documented manual-compaction shape:
 * a standalone `compaction/start` (turn: null) that doubles as the durable
 * lock, a `compaction/summary` record with the exact shadowed span, the
 * replacement `user/message` carrying a `compact-checkpoint` source and the
 * surface `replace` operation, and one closing `compaction/end`. Failed
 * attempts still close the lock with an `error` so a crash cannot wedge the
 * session.
 */

import { randomUUID } from 'node:crypto'

export const name = 'command-compact-chat'
export const inject = ['commands', 'llm', 'sessions', 'tokenMeter']

/**
 * Loader-visible configuration schema.
 *
 * The package declares `@deepseek-ai/schemastery` as a peer, so the profile
 * Loader routes this bare specifier to the copy it validates with — the same
 * one the settings form renders. Loading the module directly outside a profile
 * (a checkout run, a test harness) has no such route: the import fails, the
 * schema is omitted, and `apply` still validates the resolved options itself.
 */
let z
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  z = undefined
}

/** Configuration edit surface; values live in the patch and the settings form. */
export const Config = z === undefined ? undefined : z.object({
  retainTokens: z.number().step(1).min(0).default(200_000)
    .description('压缩后逐字保留的最近历史预算（估算 tokens）。'),
  maxTokens: z.number().step(1).min(1).default(8_192)
    .description('摘要辅助请求的输出上限；被截断会判为失败并放弃替换。'),
  summarizationProvider: z.string().default('')
    .description('可选：摘要用的 provider，与 summarizationModel 成对出现；留空沿用会话最后一次请求的路由。'),
  summarizationModel: z.string().default('')
    .description('可选：摘要用的 model，与 summarizationProvider 成对出现。'),
})

/** Retained verbatim tail when the configuration omits `retainTokens`. */
const DEFAULT_RETAIN_TOKENS = 200_000
/** Output cap for the auxiliary summary request. */
const DEFAULT_MAX_TOKENS = 8_192

const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Framing that marks the replacement message as established context. */
const CHECKPOINT_PREAMBLE =
  'This is a checkpoint condensing an earlier span of the conversation to free up context. '
  + 'Treat the captured context as established background and build on it without restating it. '
  + 'Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * Directive delivered as the final user message after the replayed span.
 * Replaying the conversation's own system prompt, tools, and leading messages
 * keeps the auxiliary call a genuine prefix of the last routed request, so the
 * provider's warm prefix cache is reused.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise engineering prose in the language of the conversation. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Expected, directly presentable failure classes. */
class CompactChatError extends Error {
  /**
   * @param {'busy'|'cancelled'|'changed'|'summary'|'commit'|'persistence'} code - stable class.
   * @param {string} message - diagnostic detail.
   * @param {ErrorOptions} [options] - original cause.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CompactChatError'
    this.code = code
  }
}

/** Reject stale or misspelled keys before defaults hide them. */
function resolveOptions(config) {
  const raw = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const known = new Set(['retainTokens', 'maxTokens', 'summarizationProvider', 'summarizationModel'])
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`command-compact-chat: unknown config key "${key}"`)
  }
  const retainTokens = raw.retainTokens ?? DEFAULT_RETAIN_TOKENS
  if (!Number.isSafeInteger(retainTokens) || retainTokens < 0) {
    throw new Error(`command-compact-chat: retainTokens (${String(retainTokens)}) must be a non-negative integer`)
  }
  const maxTokens = raw.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`command-compact-chat: maxTokens (${String(maxTokens)}) must be a positive integer`)
  }
  const summarizationProvider = raw.summarizationProvider ?? ''
  const summarizationModel = raw.summarizationModel ?? ''
  if (typeof summarizationProvider !== 'string' || typeof summarizationModel !== 'string') {
    throw new Error('command-compact-chat: summarizationProvider and summarizationModel must be strings')
  }
  if ((summarizationProvider.length === 0) !== (summarizationModel.length === 0)) {
    throw new Error('command-compact-chat: summarizationProvider and summarizationModel must be set together')
  }
  return { retainTokens, maxTokens, summarizationProvider, summarizationModel }
}

/** Format a token budget for human-facing copy. */
function formatTokens(tokens) {
  if (tokens >= 10_000 && tokens % 1_000 === 0) return `${tokens / 10_000} 万`
  return String(tokens)
}

/** Sum one numeric field over a list of priced surface nodes. */
function sumField(nodes, field) {
  let total = 0
  for (const node of nodes) total += node[field]
  return total
}

/**
 * Inspect the durable compaction lock and open-turn state at the log tail.
 * A `compaction/start` older than the newest `session/end-seed` belongs to a
 * previous lifecycle and does not block.
 */
function inspectEntryState(session) {
  const events = session.snapshotEvents()
  let openTurn = null
  let openTurnKnown = false
  let unmatchedCompactionStart
  let compactionKnown = false
  let latestEndSeedSeq
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq
    if (!compactionKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionKnown = true
      } else if (event.type === 'compaction/end') {
        compactionKnown = true
      }
    }
    if (!openTurnKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnKnown = true
      } else if (event.type === 'turn/end') {
        openTurnKnown = true
      }
    }
    if (openTurnKnown && compactionKnown && latestEndSeedSeq !== undefined) break
  }
  const fresh = unmatchedCompactionStart !== undefined
    && !(latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq)
  return { openTurn, activeCompactionStart: fresh ? unmatchedCompactionStart : undefined }
}

/**
 * Balance of every cut in current surface order: a surface of N nodes has N+1
 * cuts, entry `i` being the cut before node `i`. A cut is balanced while no
 * assistant tool call is still waiting for its result.
 */
function balanceCuts(events, nodes) {
  const cuts = new Array(nodes.length + 1)
  let openCalls = 0
  cuts[0] = true
  for (let index = 0; index < nodes.length; index += 1) {
    const event = events[nodes[index]]
    if (event?.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') openCalls += 1
      }
    } else if (event?.type === 'tool/result') {
      openCalls -= 1
    }
    cuts[index + 1] = openCalls === 0
  }
  return cuts
}

/**
 * Choose the inclusive surface span to replace: everything before the newest
 * nodes that cover `retainTokens`, never splitting a tool-call/result pair and
 * never covering the system prompt at surface node 0.
 *
 * @returns the span and its prices, or null when there is nothing useful to compact.
 */
function selectRange(session, measurement, retainTokens) {
  const nodes = measurement.nodes
  if (nodes.length === 0) return null
  const surface = session.surface.nodes
  if (surface.length !== nodes.length || surface.some((seq, index) => seq !== nodes[index]?.seq)) {
    throw new CompactChatError('changed', 'token-meter surface does not match the session surface')
  }
  const events = session.snapshotEvents()
  const isSystemHead = events[nodes[0].seq]?.type === 'system/message'
  const firstIdx = isSystemHead ? 1 : 0

  let accumulated = 0
  let keepFromIdx = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += nodes[index].tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null

  // Never split a tool-call/result pair: the cut closing the shadowed span must
  // leave no assistant tool call without its result inside the span.
  const cuts = balanceCuts(events, nodes)
  while (keepFromIdx > firstIdx && cuts[keepFromIdx] !== true) keepFromIdx -= 1
  if (keepFromIdx <= firstIdx) return null

  const keptNodes = nodes.slice(keepFromIdx)
  return {
    startIdx: firstIdx,
    endIdx: keepFromIdx - 1,
    start: nodes[firstIdx].seq,
    end: nodes[keepFromIdx - 1].seq,
    shadowedSeqs: nodes.slice(firstIdx, keepFromIdx).map(node => node.seq),
    shadowedNodes: nodes.slice(firstIdx, keepFromIdx),
    keptTailNodes: keptNodes,
    routeFreedTokens: sumField(nodes.slice(firstIdx, keepFromIdx), 'tokens'),
    heuristicFreedTokens: sumField(nodes.slice(firstIdx, keepFromIdx), 'heuristicTokens'),
    keptTailTokens: sumField(keptNodes, 'tokens'),
  }
}

/** Minimal chunk-to-block assembler: keeps text for the summary and every block for `rawOutput`. */
class ChunkAssembler {
  constructor() {
    /** @type {Map<number, {blockType: string, text: string, toolCallId?: string, toolCallName?: string, toolCallArguments: string, block?: object}>} */
    this.partials = new Map()
    this.order = []
    this.usage = undefined
    this.finish = undefined
  }

  /** @param {object} chunk - one stream chunk. */
  push(chunk) {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.#ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block !== undefined) return
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.#ensure(chunk.index, 'tool-call')
        if (partial.block !== undefined) return
        if (chunk.id !== undefined) partial.toolCallId = chunk.id
        if (chunk.name !== undefined) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.#ensure(chunk.index, chunk.block.type)
        if (partial.block !== undefined) return
        partial.block = chunk.block
        return
      }
      case 'usage': {
        this.usage = chunk.usage
        return
      }
      case 'finish': {
        this.finish = chunk.reason
        return
      }
      default:
        return
    }
  }

  #ensure(index, blockType) {
    let partial = this.partials.get(index)
    if (partial === undefined) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.order.push(index)
      this.partials.set(index, partial)
    }
    return partial
  }

  /** @returns {object[]} one block per seen index, in stream order. */
  blocks() {
    return this.order.map((index) => {
      const partial = this.partials.get(index)
      if (partial === undefined) throw new Error('CommandCompactChat: assembler invariant violated')
      if (partial.block !== undefined) return partial.block
      switch (partial.blockType) {
        case 'text':
          return { type: 'text', text: partial.text }
        case 'reasoning':
          return { type: 'reasoning', text: partial.text }
        case 'tool-call':
          return {
            type: 'tool-call',
            id: partial.toolCallId ?? `call-${index}`,
            name: partial.toolCallName ?? '',
            arguments: partial.toolCallArguments,
          }
        default:
          return { type: 'text', text: partial.text }
      }
    })
  }

  /** @returns {string} joined text blocks. */
  text() {
    return this.blocks()
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
  }
}

/** Resolve the summarization route: explicit config, then the last routed request, then agent options. */
function resolveTarget(options, session, agent) {
  if (options.summarizationProvider.length > 0) {
    return { provider: options.summarizationProvider, model: options.summarizationModel }
  }
  const header = session.requestHeader()
  const routed = header?.config
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  const provider = agent.options?.provider
  const model = agent.options?.model
  if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
    return { provider, model }
  }
  return undefined
}

/**
 * Replay the shadowed span and ask one auxiliary model call to summarize it.
 * @returns the summary text plus the call envelope for the durable record.
 */
async function summarizeShadowedSpan(ctx, options, session, agent, shadowedSeqs, signal) {
  const target = resolveTarget(options, session, agent)
  if (target === undefined) {
    throw new CompactChatError(
      'summary',
      '会话还没有可用的模型路由：先正常发一条消息，或配置 summarizationProvider / summarizationModel',
    )
  }
  const events = session.snapshotEvents()
  const surface = session.surface.nodes
  const head = surface.length > 0 ? events[surface[0]] : undefined
  const messages = []
  if (head?.type === 'system/message') {
    const system = session.deriveEventMessage(head)
    if (system !== null && system !== undefined && system.content.length > 0) messages.push(system)
  }
  for (const seq of shadowedSeqs) {
    const event = events[seq]
    if (event === undefined) continue
    const derived = session.deriveEventMessage(event)
    if (derived !== null && derived !== undefined && derived.content.length > 0) messages.push(derived)
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] })

  const header = session.requestHeader()
  const assembler = new ChunkAssembler()
  try {
    for await (const chunk of ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      messages,
      ...header?.tools === undefined ? {} : { tools: [...header.tools] },
      toolHistory: session.toolHistory(),
      maxTokens: options.maxTokens,
      sessionId: session.id,
      purpose: 'compaction',
      signal,
    })) {
      assembler.push(chunk)
    }
  } catch (error) {
    if (signal.aborted) throw new CompactChatError('cancelled', 'compaction cancelled while summarizing', { cause: error })
    throw new CompactChatError('summary', error instanceof Error ? error.message : String(error), { cause: error })
  }
  const finish = assembler.finish ?? { kind: 'stop' }
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const detail = finish.failure?.message ?? 'the summarization request failed'
    throw new CompactChatError('summary', detail)
  }
  if (finish.kind === 'max-tokens') {
    throw new CompactChatError('summary', '摘要输出被 maxTokens 截断，未写入检查点；调大 maxTokens 后重试')
  }
  const text = assembler.text().trim()
  if (text.length === 0) {
    throw new CompactChatError('summary', '模型没有返回可用的摘要文本')
  }
  return {
    text,
    rawOutput: assembler.blocks(),
    provider: target.provider,
    model: target.model,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  }
}

/** Build the replacement checkpoint message carrying the compact-checkpoint source. */
function createCheckpointMessage(compactionId, sourceCommandId, summaryText) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [
      { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
      { type: 'text', text: summaryText },
      { type: 'text', text: SUMMARY_CLOSE_TAG },
    ],
    source: {
      kind: 'compact-checkpoint',
      compactionId,
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
    },
  }
}

/** Verify the chosen span is still the same present, contiguous surface range. */
function assertSpanStable(session, range) {
  const nodes = session.surface.nodes
  if (range.endIdx >= nodes.length) throw new CompactChatError('changed', 'the selected span left the surface')
  for (let offset = 0; offset < range.shadowedSeqs.length; offset += 1) {
    if (nodes[range.startIdx + offset] !== range.shadowedSeqs[offset]) {
      throw new CompactChatError('changed', 'the selected span changed before it could be replaced')
    }
  }
}

/**
 * Run one manual compaction transaction that retains a verbatim tail.
 * @returns a human-facing success result.
 */
async function runCompaction(ctx, options, agent, commandId, signal) {
  const session = agent.session
  const entryState = inspectEntryState(session)
  if (entryState.activeCompactionStart !== undefined) {
    throw new CompactChatError('busy', 'another compaction is already in progress for this session')
  }
  if (entryState.openTurn !== null) {
    throw new CompactChatError('busy', 'the session still has an open turn')
  }

  const measurement = ctx.tokenMeter.measure(session)
  const range = selectRange(session, measurement, options.retainTokens)
  if (range === null) {
    return {
      kind: 'success',
      text: `没有需要压缩的历史：剩余内容还没有超过要保留的 ${formatTokens(options.retainTokens)} tokens。`,
    }
  }

  const compactionId = randomUUID()
  const lifecycle = { compactionId, ...commandId === undefined ? {} : { sourceCommandId: commandId }, turn: null }
  const startEvent = session.append('compaction/start', lifecycle)
  let closing = false
  let stage = 'summary'
  let failure
  let result

  try {
    const summary = await summarizeShadowedSpan(ctx, options, session, agent, range.shadowedSeqs, signal)
    if (signal.aborted) throw new CompactChatError('cancelled', 'compaction cancelled')
    assertSpanStable(session, range)

    const checkpoint = createCheckpointMessage(compactionId, commandId, summary.text)
    const framedTokens = ctx.tokenMeter.estimateMessage(checkpoint)
    if (framedTokens >= range.routeFreedTokens) {
      throw new CompactChatError(
        'summary',
        `摘要没有比被替换的历史更短（${framedTokens} >= ${range.routeFreedTokens} tokens），已放弃替换`,
      )
    }

    stage = 'commit'
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      ...commandId === undefined ? {} : { sourceCommandId: commandId },
      summary: [{ type: 'text', text: summary.text }],
      rawOutput: summary.rawOutput,
      llmStreamCall: true,
      shadowedRange: { start: range.start, end: range.end },
      shadowedSeqs: [...range.shadowedSeqs],
      shadowedTokenCount: range.heuristicFreedTokens,
      provider: summary.provider,
      model: summary.model,
      maxTokens: options.maxTokens,
      ...summary.usage === undefined ? {} : { usage: summary.usage },
    })
    session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...range.shadowedSeqs],
    })
    closing = true
    session.append('compaction/end', lifecycle)
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      throw new CompactChatError('persistence', 'compaction finished, but the session could not be saved', { cause: error })
    }
    result = {
      kind: 'success',
      text: `已压缩 ${range.shadowedSeqs.length} 条历史（约释放 ${range.routeFreedTokens} tokens），保留最后约 ${formatTokens(range.keptTailTokens)} tokens 原文。`,
      sourceEventSeq: summaryEvent.seq,
    }
  } catch (error) {
    failure = { error, stage: closing ? 'commit' : stage }
    if (!closing) {
      // Exactly one closing attempt; a failed close deliberately leaves the
      // unmatched start detectable instead of pretending the lock was released.
      closing = true
      try {
        const reason = error instanceof Error ? error.message : String(error)
        session.append('compaction/end', { ...lifecycle, error: reason })
      } catch (closeError) {
        failure = { error: closeError, stage: 'commit' }
      }
    }
  }

  if (failure !== undefined) {
    if (signal.aborted) throw new CompactChatError('cancelled', 'compaction cancelled', { cause: failure.error })
    if (failure.error instanceof CompactChatError) throw failure.error
    if (failure.stage === 'commit' && !(failure.error instanceof CompactChatError)) {
      throw new CompactChatError('commit', 'manual compaction did not commit cleanly', { cause: failure.error })
    }
    throw failure.error
  }
  if (result === undefined) throw new CompactChatError('commit', 'compaction finished without a result')
  return result
}

/** Convert one settled failure into a directly presentable command result. */
function describeFailure(error) {
  if (error instanceof CompactChatError) {
    switch (error.code) {
      case 'busy':
        return {
          kind: 'error',
          text: '压缩暂不可用：当前回合还在运行、已有一次压缩在进行，或会话里还留着上一次未正常结束的压缩标记。等当前回合结束后再试。',
        }
      case 'cancelled':
        return { kind: 'error', text: '压缩已取消。' }
      case 'changed':
        return {
          kind: 'error',
          text: '准备压缩的那段历史在生成摘要期间变了，已放弃替换。这次尝试记录在会话日志里，可以重试。',
        }
      case 'summary':
        return { kind: 'error', text: `没能生成可用的摘要：${error.message}` }
      case 'commit':
        return {
          kind: 'error',
          text: '压缩没有干净地完成，部分会话历史可能已经改变；重试前先检查当前会话状态。',
        }
      case 'persistence':
        return { kind: 'error', text: '压缩已完成，但会话没能保存到磁盘。' }
      default:
        return { kind: 'error', text: `压缩失败：${error.message}` }
    }
  }
  return { kind: 'error', text: `压缩失败：${error instanceof Error ? error.message : String(error)}` }
}

/**
 * Execute one `/compact_chat` invocation against the invoking agent.
 * @param ctx - host context carrying commands, llm, sessions, and tokenMeter.
 * @param options - resolved plugin configuration.
 * @param invocation - command invocation supplied by the registry.
 * @returns the human-facing command result.
 */
async function executeCompactChat(ctx, options, invocation) {
  if (invocation.rawInput.trim().length > 0) {
    return {
      kind: 'error',
      text: `用法：/compact_chat（不接受参数）。要改保留额度请调整插件配置 retainTokens（当前 ${options.retainTokens}）。`,
    }
  }
  const { agent, signal, commandId } = invocation
  try {
    return await agent.runMaintenance(async (agentSignal) => {
      const operationSignal = agentSignal !== undefined && signal !== undefined
        ? AbortSignal.any([agentSignal, signal])
        : signal
      operationSignal?.throwIfAborted()
      return runCompaction(ctx, options, agent, commandId, operationSignal)
    })
  } catch (error) {
    if (signal?.aborted) return { kind: 'error', text: '压缩已取消。' }
    if (!(error instanceof CompactChatError)) {
      const wrapped = error instanceof Error && /maintenance|idle|active/i.test(error.message)
        ? new CompactChatError('busy', error.message, { cause: error })
        : error
      return describeFailure(wrapped)
    }
    return describeFailure(error)
  }
}

/**
 * Register `/compact_chat` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the services compaction needs.
 * @param config - plugin configuration (`retainTokens`, `maxTokens`, optional summarization route).
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  /** @type {Set<Promise<object>>} */
  const active = new Set()
  const handler = (invocation) => {
    const operation = executeCompactChat(ctx, options, invocation)
    active.add(operation)
    const retire = () => { active.delete(operation) }
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Composite teardown is LIFO: unregister first on unwind, then quiesce the
    // handlers already started so an aborted command closes its durable marker.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      name: 'compact_chat',
      description: `压缩早期历史，保留最后约 ${formatTokens(options.retainTokens)} tokens 原文`,
      handler,
    })
  }, 'command-compact-chat lifecycle')
}
