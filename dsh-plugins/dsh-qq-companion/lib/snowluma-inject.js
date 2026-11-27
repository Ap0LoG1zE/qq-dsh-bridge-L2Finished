/**
 * SnowLuma 账号自动注入（2026-11-27）。
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────────────
 *
 * 操作者原来的流程是：
 *   ① 小面板点「启动 SnowLuma」
 *   ② 点「打开 WebUI」
 *   ③ 在 WebUI 里手动选一个 QQ 号注入
 *
 * 第 ②③ 步纯粹是重复劳动 —— 每次都要点同样的东西、选同样的号。
 * 现在做成：点一次「启动 SnowLuma」，起来之后自动把指定 QQ 注入好。
 *
 * ── 怎么注入的 ────────────────────────────────────────────────────────────
 *
 * SnowLuma 的 WebUI 暴露了一组 REST 接口，注入一个账号就是两步：
 *
 *   1. `POST /api/login  { password }`        → 拿 `token`（TTL 24 小时）
 *   2. `GET  /api/processes`                  → 列出所有 QQ.exe 进程
 *      每个进程带 `account.uin`（这个进程对应哪个 QQ 号）
 *   3. `POST /api/processes/<pid>/load`       → 给那个进程注入 hook
 *
 * 第 2 步是关键：**`account.uin` 就是"这个进程是谁"**，所以不用让用户选，
 * 按 uin 匹配就行。已经 `injected: true` 的直接跳过。
 *
 * ── 为什么不在桥接侧做 ────────────────────────────────────────────────────
 *
 * 桥接只跟 OneBot 的 3000/3001 端口打交道，完全不碰 WebUI 的 5099。
 * 而「启动 SnowLuma」这个按钮本来就在 host 插件里（`qq-bigfish.js`），
 * 账号注入是同一个动作的延续，放一起最自然 —— 也不用给桥接加新的
 * 凭据消费方。
 *
 * ── 凭据怎么存 ────────────────────────────────────────────────────────────
 *
 * WebUI 密码放在 `config.json` 的 `snowluma.webuiPassword`（该文件在
 * `.gitignore` 里，不进仓库）。**没配就整段跳过**，行为和以前完全一样。
 *
 * 配置形状：
 *   "snowluma": {
 *     "webuiPort": 5099,                 // 可选，默认 5099（和 runtime.json 一致）
 *     "webuiPassword": "...",            // 不配 → 不自动注入
 *     "autoInjectUin": "3346197751"      // 起来之后自动注入这个号
 *   }
 */

/** WebUI 默认端口（SnowLuma 的 runtime.json 里也是 5099）。 */
const DEFAULT_WEBUI_PORT = 5099

/** 登录令牌缓存：{ port, password, token, expiresAt }。同一份密码不重复登录。 */
let cachedAuth = null

/** 单次 HTTP 请求的超时。WebUI 是本地回环，正常都是毫秒级。 */
const REQ_TIMEOUT_MS = 8000

/**
 * 一个最小可用的 JSON 请求器。
 *
 * 不用全局 fetch 之外的依赖：这里只需要本地回环，不需要跟着
 * 项目里那套 safeFetch（那个是防 SSRF 的，127.0.0.1 会被它拦掉）。
 */
async function jsonRequest(port, pathname, { method = 'GET', token = '', body = null } = {}) {
  const url = `http://127.0.0.1:${port}${pathname}`
  const headers = { accept: 'application/json' }
  if (body !== null) headers['content-type'] = 'application/json'
  if (token) headers['x-snowluma-token'] = token

  const res = await fetch(url, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status, ok: res.ok, data }
}

/**
 * 登录 WebUI，拿会话令牌。
 *
 * 缓存 24 小时内复用 —— SnowLuma 那边的 TOKEN_TTL_MS 就是 1440 分钟，
 * 但这里留足余量，提前 10 分钟换新的。
 *
 * @returns {Promise<{ ok: boolean, token?: string, error?: string }>}
 */
export async function snowlumaWebuiLogin(port, password) {
  const p = Number(port) || DEFAULT_WEBUI_PORT
  const pw = String(password || '')
  if (!pw) return { ok: false, error: '未配置 snowluma.webuiPassword' }

  const now = Date.now()
  if (cachedAuth && cachedAuth.port === p && cachedAuth.password === pw && cachedAuth.expiresAt > now) {
    return { ok: true, token: cachedAuth.token }
  }

  try {
    const r = await jsonRequest(p, '/api/login', { method: 'POST', body: { password: pw } })
    if (!r.ok || !r.data?.success) {
      // 密码错 / 需要二次验证 / 登录过于频繁 —— 都走这里，把原文带回去便于排查
      const msg = r.data?.needsTotp
        ? 'WebUI 开了二次验证，自动登录做不了（请在 config 里关掉或手动注入一次）'
        : (r.data?.message || `HTTP ${r.status}`)
      return { ok: false, error: msg }
    }
    const token = String(r.data.token || '')
    if (!token) return { ok: false, error: '登录成功但没拿到 token' }
    cachedAuth = {
      port: p,
      password: pw,
      token,
      // 提前 10 分钟过期，避免边界上刚好失效
      expiresAt: now + (1440 - 10) * 60 * 1000,
    }
    return { ok: true, token }
  } catch (error) {
    return { ok: false, error: `连不上 WebUI（127.0.0.1:${p}）：${error?.message ?? error}` }
  }
}

/**
 * 把指定 QQ 号注入到对应的 QQ 进程里。
 *
 * 三种结果都算「成功」：
 *   · 刚注入成功
 *   · 之前就注入过（injected === true）
 *   · 进程列表里根本没有这个号（QQ 没登录 / 没开）—— 那不是错误，
 *     只是这次没什么可做的，操作者自己去开 QQ 就好
 *
 * @param {object} opts
 * @param {number} opts.port         WebUI 端口
 * @param {string} opts.password     WebUI 密码
 * @param {string} opts.uin          要注入的 QQ 号
 * @returns {Promise<{ok:boolean, injected:boolean, already:boolean, found:boolean,
 *                    pid:number|null, uin:string, error?:string, candidates?:string[]}>}
 */
export async function snowlumaAutoInject(opts = {}) {
  const want = String(opts.uin || '').trim()
  const port = Number(opts.port) || DEFAULT_WEBUI_PORT
  const base = { injected: false, already: false, found: false, pid: null, uin: want }

  if (!want) return { ...base, ok: false, error: '未配置 snowluma.autoInjectUin' }

  const auth = await snowlumaWebuiLogin(port, opts.password)
  if (!auth.ok) return { ...base, ok: false, error: auth.error }

  let list
  try {
    const r = await jsonRequest(port, '/api/processes', { token: auth.token })
    if (!r.ok) {
      // 401 = 令牌失效（SnowLuma 重启过），清缓存让下次重登
      if (r.status === 401) cachedAuth = null
      return { ...base, ok: false, error: `读进程列表失败：HTTP ${r.status}` }
    }
    list = Array.isArray(r.data?.list) ? r.data.list : []
  } catch (error) {
    return { ...base, ok: false, error: `读进程列表异常：${error?.message ?? error}` }
  }

  // 按 account.uin 匹配。**不看 `uin` 字段** —— 那个只在"已注入"时才有值，
  // 未注入的进程它是 `"0"`；而 `account.uin` 是 QQ 客户端自己报的账号，
  // 两者谁更早可用就用谁。
  const hit = list.find((p) => {
    const a = String(p?.account?.uin || '')
    const b = String(p?.uin || '')
    return a === want || b === want
  })

  if (!hit) {
    return {
      ...base,
      ok: true,
      found: false,
      // 把现有的号列出来，日志/提示里能说清楚"现在有哪几个"
      candidates: list.map((p) => String(p?.account?.uin || p?.uin || '')).filter((x) => x && x !== '0'),
    }
  }

  const pid = Number(hit.pid)
  if (hit.injected === true && hit.connected === true) {
    return { ...base, ok: true, found: true, pid, already: true, injected: true }
  }

  try {
    const r = await jsonRequest(port, `/api/processes/${pid}/load`, { method: 'POST', token: auth.token })
    if (!r.ok || r.data?.success === false) {
      if (r.status === 401) cachedAuth = null
      return {
        ...base,
        ok: false,
        found: true,
        pid,
        error: r.data?.message || `注入失败：HTTP ${r.status}`,
      }
    }
    return { ...base, ok: true, found: true, pid, injected: true }
  } catch (error) {
    return { ...base, ok: false, found: true, pid, error: `注入异常：${error?.message ?? error}` }
  }
}

/** 清掉登录缓存（测试用；也用于"密码改了"之后强制重登）。 */
export function resetSnowlumaWebuiAuth() {
  cachedAuth = null
}
