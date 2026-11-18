/**
 * Feature: thinking-zh — make the model reason in Simplified Chinese.
 *
 * A feature owns its own host-side wiring: the prompt section it contributes
 * and the HTTP route the dock uses to read/write its state. Adding a new
 * capability to the floating dock means adding one file shaped like this and
 * listing it in ../index.js.
 *
 * Scope: the switch is per-Host, but the prompt it injects can be narrowed to
 * a set of workspaces. The section text is evaluated on every assembly with
 * that assembly's context, which carries `agent`; `agent.session.header.cwd`
 * is the workspace the session belongs to. That is what lets "only the QQ chat
 * workspace thinks in Chinese" work without any change to the Host itself.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, '.dsh-thinking-zh.json')
const WORKSPACES_FILE = path.join(DSH_HOME, 'storages', 'workspace.json')

const DEFAULT_STATE = { enabled: true, mode: 'zh', scope: 'all', workspaces: [], version: 1 }
const VALID_MODES = new Set(['zh', 'mixed', 'auto'])
const VALID_SCOPES = new Set(['all', 'workspaces'])
/** Hard cap on the allow-list: a runaway edit must not bloat every prompt. */
const MAX_WORKSPACES = 50

export const id = 'thinking-zh'
export const title = '思考链中文'
export const hint = '模型从源头用中文推理，术语保留英文'
export const routePath = '/qq-dsh-panel/state'
export const workspacesPath = '/qq-dsh-panel/workspaces'

const PROMPTS = {
  zh: [
    '【思考语言策略：简体中文优先】',
    '',
    '在你的内部推理与思考过程（reasoning）中，默认使用简体中文组织思路。',
    '这条规则适用于本会话的每一轮，优先级高于模型默认的英文推理习惯。',
    '',
    '具体要求：',
    '1. 思考链的主干、转折、验证与结论都用简体中文表达。',
    '2. 代码、命令、报错信息、API 名、文件路径、变量名、专有名词、引用原文保留英文，不要翻译。',
    '3. 遇到特别复杂的数学、逻辑或代码推理，可以中英混用；但思考链的主干和最终结论必须使用中文。',
    '4. 不要为了切换语言而改变推理步骤、工具调用或结论。',
    '5. 不要输出「我正在用中文思考」这类元话语，直接自然地思考。',
    '6. 面向用户的最终回复使用中文，除非用户明确要求其他语言。',
  ].join('\n'),
  mixed: [
    '【思考语言策略：中英混用，结论中文】',
    '',
    '在你的内部推理与思考过程（reasoning）中，可以使用中文为主、英文为辅的方式组织思路：',
    '- 简单事实、计划、验证与结论使用简体中文；',
    '- 复杂的数学推导、代码分析、英文资料引用可以使用英文；',
    '- 但思考链的主干与最终结论必须使用简体中文。',
    '',
    '代码、命令、报错信息、API 名、文件路径、变量名、专有名词、引用原文保留英文，不要翻译。',
    '不要为了切换语言而改变推理步骤、工具调用或结论；不要输出语言切换的元话语。',
    '面向用户的最终回复使用中文，除非用户明确要求其他语言。',
  ].join('\n'),
  auto: [
    '【思考语言策略：跟随用户语言】',
    '',
    '在你的内部推理与思考过程（reasoning）中，跟随用户当前消息的主要语言：',
    '- 用户主要使用简体中文时，思考链使用简体中文；',
    '- 用户主要使用英文时，思考链可以使用英文；',
    '- 无论使用哪种语言，代码、命令、报错信息、API 名、文件路径、变量名、专有名词、引用原文都保留英文，不要翻译。',
    '',
    '不要为了切换语言而改变推理步骤、工具调用或结论；不要输出语言切换的元话语。',
    '面向用户的最终回复使用与用户相同的语言，除非用户明确要求其他语言。',
  ].join('\n'),
}

/**
 * Keep the on-disk state and the in-memory state the same shape. `enabled` is
 * strictly boolean on purpose: a corrupt file holding the string "false" must
 * not silently turn the switch on.
 *
 * `scope`/`workspaces` are additive: a file written by an older version has
 * neither, and normalizing it to `scope: 'all'` keeps the previous behaviour.
 */
function normalizeState(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const list = Array.isArray(raw.workspaces) ? raw.workspaces : []
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_STATE.enabled,
    mode: VALID_MODES.has(raw.mode) ? raw.mode : DEFAULT_STATE.mode,
    scope: VALID_SCOPES.has(raw.scope) ? raw.scope : DEFAULT_STATE.scope,
    workspaces: list
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, MAX_WORKSPACES),
    version: 1,
  }
}

function readState() {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')))
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function writeState(current, patch) {
  const next = normalizeState({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) })
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    // Write-then-rename so a crash mid-write cannot leave a truncated file.
    const tmp = `${STATE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, STATE_FILE)
  } catch (err) {
    console.error(`[dsh-floatdock] ${id}: failed to write state:`, err && err.message ? err.message : err)
  }
  return next
}

/**
 * Compare a workspace path for equality or containment.
 *
 * Separators are unified and a drive-letter path is lower-cased, because
 * Windows paths are case-insensitive and the Host may report either form.
 * A plain `startsWith` would make `.../state/agents-old` match
 * `.../state/agents`, so the separator is part of the prefix test.
 */
function normalizePath(value) {
  if (typeof value !== 'string') return ''
  let result = value.trim().replace(/\\/g, '/')
  while (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1)
  if (/^[A-Za-z]:\//.test(result)) result = result.toLowerCase()
  return result
}

function cwdOf(context) {
  const agent = context && context.agent
  const header = agent && agent.session && agent.session.header
  return header && typeof header.cwd === 'string' ? header.cwd : ''
}

/** Whether this assembly's workspace is in the configured allow-list. */
function inScope(state, context) {
  if (state.scope !== 'workspaces') return true
  // "Only these workspaces" with an empty list means "none": falling back to
  // every workspace would be the exact opposite of what the setting says.
  if (state.workspaces.length === 0) return false
  const target = normalizePath(cwdOf(context))
  if (!target) return false
  for (const entry of state.workspaces) {
    const base = normalizePath(entry)
    if (!base) continue
    if (target === base || target.startsWith(`${base}/`)) return true
  }
  return false
}

function promptFor(state, context) {
  if (!state.enabled) return ''
  if (!inScope(state, context)) return ''
  return PROMPTS[state.mode] || PROMPTS.zh
}

/**
 * Read the Host's workspace registry so the dock can offer a list instead of
 * asking the user to retype absolute paths. Best-effort: an unreadable or
 * reshaped file yields an empty list and the UI falls back to manual paths.
 */
function readWorkspaces() {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'))
  } catch {
    return []
  }
  const table = raw && raw.tables && raw.tables.workspaces
  if (!table || typeof table !== 'object') return []
  const out = []
  for (const [workspaceId, record] of Object.entries(table)) {
    if (!record || typeof record.path !== 'string' || !record.path) continue
    out.push({
      id: workspaceId,
      title: typeof record.title === 'string' && record.title ? record.title : record.path,
      path: record.path,
      sessions: Array.isArray(record.sessionIds) ? record.sessionIds.length : 0,
    })
  }
  // Sort by path, not title: title sorting depends on the collation the
  // runtime happens to carry for mixed CJK/Latin strings, so the same list
  // could come back in a different order on another machine. Path order is
  // stable and still groups sibling workspaces together.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/**
 * Wire this feature into the host.
 * @param ctx - the plugin context (systemPrompt + webServer).
 * @returns a disposer releasing everything this feature registered.
 */
export function mount(ctx) {
  let state = readState()

  // Evaluated on every prompt assembly, so the switch affects the next turn of
  // both new and existing conversations without touching history. The context
  // carries this assembly's agent, which is how a workspace-scoped rule knows
  // whether it applies here.
  const disposeSection = ctx.systemPrompt.section({
    name: 'thinking-language-zh',
    // ── 2026-11-19：从 10250 改到 100（与 qq-agent-context 的 qq:session-context 同位置）──
    //
    // 原设计把这段放在整个 prompt 的最末尾（10250 > DEPLOYMENT_PERSONA_SUFFIX
    // 的 10200），注释理由是「模型开始推理前最后读到的东西」。实测这个理由是错的：
    //
    // session-0d17e66f 的 turn 1：系统提示词 12,698 字，本段落在 12,387（97.6%），
    // 前面 8.2 千字是 persona 与工具清单。结果 17 条 reasoning **全部是英文**：
    //   「Let me get the prompt and the session token. Wait — I need to know...」
    // 指令完整无损，但对推理语言毫无约束力 —— 排在一万多字之后的最后 311 字，
    // 在注意力上和没写差不多。
    //
    // 现在挪到 100：紧跟 persona（0）、在 FILE_REFERENCE(900) 与所有工具段之前。
    // 与 qq:session-context 同序（同 order 时按段名排序，两者都在 3~4 号位），
    // 模型一建立身份就读到「用中文思考」，而不是在 8 千字工具说明之后才看到。
    order: 100,
    text: (context) => promptFor(state, context),
  })

  const disposeStateRoute = ctx.webServer.register({
    kind: 'exact',
    path: routePath,
    handler: async (req, res) => {
      const method = req.method || 'GET'
      if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
        res.writeHead(405, { ...JSON_HEADERS, Allow: 'GET, POST, PUT' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      if (method === 'GET') {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, state }))
        return
      }
      // Requiring a JSON content type keeps cross-site form posts out: a plain
      // HTML form cannot send it, and a cross-origin fetch would need a CORS
      // preflight this server never grants.
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        res.writeHead(415, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'expected application/json' }))
        return
      }
      try {
        const patch = JSON.parse(await readBody(req))
        state = writeState(state, patch)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, state }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })

  const disposeWorkspacesRoute = ctx.webServer.register({
    kind: 'exact',
    path: workspacesPath,
    handler: async (req, res) => {
      if ((req.method || 'GET') !== 'GET') {
        res.writeHead(405, { ...JSON_HEADERS, Allow: 'GET' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, workspaces: readWorkspaces() }))
    },
  })

  return () => {
    try { disposeSection() } catch {}
    try { disposeStateRoute() } catch {}
    try { disposeWorkspacesRoute() } catch {}
  }
}

/** Exported for the smoke test: the scope rules are worth asserting directly. */
export const __test = { normalizeState, normalizePath, inScope, promptFor, readWorkspaces }
