/**
 * Feature: qq-bigfish — 在浮游球工具箱里管理「QQ 大肥鱼」机器人。
 *
 * 设计原则
 * ────────
 * 1. 本 feature **不直接读** qq-bridge 的 state 文件，而是把请求代理到桥接自带的
 *    本地控制台 HTTP API（默认 127.0.0.1:3100）。原因是桥接是唯一知道"当前真相"
 *    的进程——会话映射、社交状态、唤醒计时器、token 账本都在它内存里；直接读文件
 *    会看到过期快照。副作用是桥接升级时这里基本不用改。
 * 2. 控制台令牌只留在 host 侧，绝不发给页面。
 * 3. 找桥接目录**不需要用户配置**：setup-dsh.mjs 会把
 *    `<bridge>/plugins/qq-mode-console` 以 junction 挂到 `~/.dsh/plugins/` 下，
 *    解析这个链接再往上退两级就是仓库根。
 * 4. 写 `socialV2.config` 时**先读完整对象再整体写回**：该接口是浅合并，
 *    子对象（send/wait/wake…）会被整段替换，只发局部字段会清掉其余配置。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LOCAL_STATE_FILE = path.join(DSH_HOME, '.dsh-qq-bigfish.json')

export const id = 'qq-bigfish'
export const title = 'QQ 大肥鱼'
export const hint = '把 DeepSeek 部署到 QQ 群'
export const routePath = '/qq-dsh-panel/qq-bigfish'

/** 子路由：client 半按需调用，全部是精确路径（与 thinking-zh 同一套注册方式）。 */
export const ROUTES = {
  status: routePath,
  toggle: `${routePath}/toggle`,
  // 纯语音：GET 读开关+服务状态，POST 切换（打开时顺带拉起 TTS 推理窗口）。
  tts: `${routePath}/tts`,
  // 重启桥接（靠 start.bat 守护循环自动拉起）。
  restartBridge: `${routePath}/restart-bridge`,
  settings: `${routePath}/settings`,
  persona: `${routePath}/persona`,
  facts: `${routePath}/facts`,
  impressions: `${routePath}/impressions`,
  selfNotes: `${routePath}/self-notes`,
  todos: `${routePath}/todos`,
  tokens: `${routePath}/tokens`,
  stickers: `${routePath}/stickers`,
  launchSnowluma: `${routePath}/launch-snowluma`,
  openSnowluma: `${routePath}/open-snowluma`,
  openConsole: `${routePath}/open-console`,
  access: `${routePath}/access`,
  backend: `${routePath}/backend`,
  diagnose: `${routePath}/diagnose`,
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// ── 基础设施 ────────────────────────────────────────────────────────────────

function json(res, status, payload) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
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

async function readJsonBody(req) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    throw new Error('expected application/json')
  }
  const text = await readBody(req)
  return text ? JSON.parse(text) : {}
}

/** 定位 qq-bridge 目录（优先环境变量，其次 ~/.dsh/plugins 下的 junction）。 */
function findBridgeDir() {
  const fromEnv = process.env.QQ_BRIDGE_DIR
  if (fromEnv) {
    const dir = path.resolve(fromEnv)
    if (fs.existsSync(path.join(dir, 'config.json'))) return dir
  }
  for (const name of ['qq-mode-console', 'qq-agent-presets']) {
    try {
      // realpathSync 会解析 Windows junction / 符号链接，得到仓库里的真实目录
      const real = fs.realpathSync(path.join(DSH_HOME, 'plugins', name))
      const dir = path.dirname(path.dirname(real))
      if (fs.existsSync(path.join(dir, 'config.json'))) return dir
    } catch { /* 链接不存在或不可解析，试下一个 */ }
  }
  return null
}

function bridgeEnv() {
  const dir = findBridgeDir()
  if (!dir) {
    return {
      ok: false,
      error: '找不到 qq-bridge。~/.dsh/plugins 下没有 qq-mode-console 链接；请先在 qq-bridge 目录里跑 node scripts/setup-dsh.mjs',
    }
  }
  // 读 config.json。**必须先吃掉 UTF-8 BOM**，否则 JSON.parse 会抛
  //   SyntaxError: Unexpected token '\uFEFF'
  // 而这里的 catch 是静默的（一旦抛错 cfg 就退回 {}），后果非常隐蔽：
  //   · snowluma.homeDir / launcherPath 全读不到
  //   · 「启动 SnowLuma」报「找不到启动器：(未配置)」—— 明明配置里写着、磁盘上也有
  //   · consolePort 退回默认 3100，端口被改过时还会连错地方
  // 实测踩过：某次用编辑器/PowerShell 改写 config.json 时被补上了 BOM，
  // 桥接自己有 BOM 处理（src/bridge.js 的 readJsonSafe），所以只有面板出问题。
  let cfg = {}
  try {
    let text = fs.readFileSync(path.join(dir, 'config.json'), 'utf8')
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    cfg = JSON.parse(text)
  } catch (error) {
    // 不要完全静默：至少留一行，避免下次再花半天排查「配置明明对却读不到」。
    try { console.warn('[qq-bigfish] 读取 config.json 失败，已退回默认值:', error?.message ?? error) } catch {}
  }
  let token = ''
  try { token = fs.readFileSync(path.join(dir, 'state', 'console-token'), 'utf8').trim() } catch { /* 无令牌 */ }
  const port = Number(cfg.consolePort) || 3100
  return { ok: true, dir, cfg, token, port, base: `http://127.0.0.1:${port}` }
}

/** 代理一次调用到桥接控制台。永远 resolve，失败信息放在返回值里。 */
async function bridgeApi(env, apiPath, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const headers = {}
  if (env.token) headers['x-console-token'] = env.token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetch(env.base + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 500) } }
    return { ok: res.ok, status: res.status, data }
  } catch (error) {
    return { ok: false, status: 0, error: String((error && error.message) || error) }
  }
}

function readLocalState() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_STATE_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

function writeLocalState(patch) {
  const next = { ...readLocalState(), ...(patch && typeof patch === 'object' ? patch : {}) }
  try {
    fs.mkdirSync(path.dirname(LOCAL_STATE_FILE), { recursive: true })
    const tmp = `${LOCAL_STATE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, LOCAL_STATE_FILE)
  } catch { /* 本地偏好写不进去不影响主流程 */ }
  return next
}

/**
 * 发现本机的 DSH 实例与端口。
 *
 * 桌面端端口由 Electron 运行时分配（实测 62295，但不应假设固定），所以按
 * 「进程 → 它监听的回环端口」反查。仅 Windows 实现；其他平台返回空数组，
 * 工具箱会退化成"只显示当前配置"。
 */
let backendCache = { at: 0, list: [] }

async function discoverBackends() {
  if (process.platform !== 'win32') return []
  // 5 秒缓存。这个函数要 spawn PowerShell（首次约 1~3 秒）；早期版本用的是
  // execFileSync —— 那是**同步阻塞**，等待期间会把整个 host 半卡住，
  // 连带把别的页签（诊断）的请求一起拖住。改为异步 + 缓存后，
  // 首次仍要等，之后 5 秒内直接命中缓存。
  const now = Date.now()
  if (now - backendCache.at < 30000) return backendCache.list
  const script = [
    '$out = @()',
    "foreach ($p in (Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" -ErrorAction SilentlyContinue)) {",
    "  if ($p.CommandLine -match '--type=') { continue }",
    '  $c = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq \'127.0.0.1\' } | Sort-Object LocalPort | Select-Object -First 1',
    "  if ($c) { $out += [pscustomobject]@{ kind = 'desktop'; pid = $p.ProcessId; port = $c.LocalPort } }",
    '}',
    "foreach ($p in (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue)) {",
    "  if ($p.CommandLine -notmatch '@deepseek-ai[\\\\/]dsh[\\\\/]lib[\\\\/]bin\\.js') { continue }",
    '  $c = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq \'127.0.0.1\' } | Sort-Object LocalPort | Select-Object -First 1',
    "  if ($c) { $out += [pscustomobject]@{ kind = 'cli'; pid = $p.ProcessId; port = $c.LocalPort } }",
    '}',
    '$out | ConvertTo-Json -Compress',
  ].join('\n')
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    })
    const raw = String(stdout || '').trim()
    if (!raw) {
      backendCache = { at: now, list: [] }
      return []
    }
    const parsed = JSON.parse(raw)
    const list = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((item) => item && item.port)
      .map((item) => ({
        kind: item.kind,
        pid: item.pid,
        port: Number(item.port),
        url: `http://127.0.0.1:${item.port}`,
        label: item.kind === 'desktop' ? '桌面端 DSH' : 'CLI DSH',
      }))
    backendCache = { at: now, list }
    return list
  } catch {
    return backendCache.list
  }
}

// ── 各路由的实现 ────────────────────────────────────────────────────────────

// ── 桥接保活：发现没在跑就把它拉起来 ──────────────────────────────────────
//
// 为什么面板要管这件事：桥接是独立进程（start.bat），DSH 重启、机器久置、
// 守卫计划任务失效时它都可能不在。那时面板只会显示「读不到数据」，
// 而这个提示对使用者没有可行动的下一步 —— 他并不知道要去哪个目录双击什么。
//
// 边界（刻意收窄）：
//   · 只在**面板请求**时触发（点重试 / 打开状态页），不做后台轮询或定时自启；
//   · 只启动仓库里**已存在**的 start.bat，不下载、不安装、不改配置；
//   · 已有进程在跑就绝不再起第二个（双实例会互相抢消息、互相覆盖 state）。
const START_BAT = 'start.bat'

/** 本机是否已有桥接进程（按命令行匹配，不依赖锁文件——锁可能是残留的）。 */
async function hasBridgeProcess() {
  if (process.platform !== 'win32') {
    // 非 Windows 退化为端口探测：能连上说明它在。
    return false
  }
  try {
    const ps = [
      "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
      "  Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' }).Count",
    ].join('\n')
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    })
    const n = Number(String(stdout || '').trim())
    return Number.isFinite(n) && n > 0
  } catch {
    return false
  }
}

/**
 * 确保桥接在运行：没在跑就用 start.bat 拉起来，并等控制台端口真的能连上。
 *
 * @param {object} env bridgeEnv() 的结果
 * @param {object} opts
 * @param {boolean} opts.startIfDown 是否允许启动（默认 true）
 * @param {number} opts.waitMs 最多等多久（默认 20 秒）
 * @returns {Promise<{ok:boolean, started?:boolean, already?:boolean, error?:string, elapsedMs?:number}>}
 */
async function ensureBridgeRunning(env, { startIfDown = true, waitMs = 20000 } = {}) {
  const t0 = Date.now()

  // ① 端口已经能连上 = 它本来就在跑，什么都不做。
  if (await probePort(env.port, 1200)) return { ok: true, already: true, elapsedMs: Date.now() - t0 }

  // ② 端口不通，但进程还在 —— 可能正在启动中（或卡住了）。等一会儿再看。
  const alive = await hasBridgeProcess()
  if (alive) {
    const ready = await waitForPorts([env.port], Math.min(waitMs, 10000))
    if (ready) return { ok: true, already: true, elapsedMs: Date.now() - t0 }
    return {
      ok: false,
      error: `桥接进程在跑（${env.dir}），但控制台端口 ${env.port} 一直连不上。可能是启动卡住或端口被占用，看一下 state/bridge.log。`,
      elapsedMs: Date.now() - t0,
    }
  }

  // ③ 确认进程不在 —— 只有这一步才真的去启动。
  if (!startIfDown) {
    return { ok: false, error: '桥接没有在运行（已按调用方要求不自动启动）', elapsedMs: Date.now() - t0 }
  }

  const bat = path.join(env.dir, START_BAT)
  if (!fs.existsSync(bat)) {
    return { ok: false, error: `找不到启动脚本：${bat}`, elapsedMs: Date.now() - t0 }
  }

  try {
    // 先清掉可能残留的锁：上一次异常退出会留下 bridge.lock，
    // 桥接启动时会因为「已有实例」直接退出（exit 2），表现为「启动后毫无反应」。
    const lock = path.join(env.dir, 'state', 'bridge.lock')
    try {
      if (fs.existsSync(lock)) {
        const raw = String(fs.readFileSync(lock, 'utf8') || '').trim()
        const lockPid = Number(raw)
        let stale = true
        if (Number.isInteger(lockPid) && lockPid > 0) {
          // 锁里记的 PID 还活着才不算残留。
          try { process.kill(lockPid, 0); stale = false } catch { stale = true }
        }
        if (stale) fs.rmSync(lock, { force: true })
      }
    } catch { /* 清锁失败不阻断启动，让桥接自己判断 */ }

    // ⚠️ 两条踩过的坑（都实测过，别改回去）：
    //
    //  ① 不能用 `cmd /c start "" start.bat`：`start` 是"新开窗口"的命令，会**无视
    //     windowsHide** 强行弹出控制台；而 start.bat 是常驻循环（node 挂了 5 秒后重启），
    //     那个黑窗口会一直留在桌面上；start.bat 里还有一处 `pause`，异常退出时窗口会
    //     停在"请按任意键继续"等人按键。
    //
    //  ② 改成 `cmd /c start.bat` + `detached:true` + `windowsHide:true` 也不行：
    //     Node 在 **detached:true 时会忽略 windowsHide**（Windows 上的已知行为），
    //     实测仍然会多出一个 conhost（新控制台窗口）。而 detached 又不能去掉 ——
    //     桥接必须独立于 DSH 生命周期，否则 DSH 一重启就把它带走。
    //
    // 正解：借 PowerShell 的 `Start-Process -WindowStyle Hidden` 来落盘。
    // 这和仓库里 tools/bridge-guard.ps1 的做法完全一致（守卫计划任务每分钟拉起桥接，
    // 从来不会弹窗），所以是被验证过的路径。
    // 注意 SnowLuma 的启动（handleLaunchSnowluma）**不在此列**：那里刻意保留 `start`，
    // 因为试过改成直接 spawn 反而连弹 3 个窗口（见该函数内注释）。
    const psArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-Command',
      `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start.bat' -WorkingDirectory '${env.dir.replace(/'/g, "''")}' -WindowStyle Hidden`,
    ]
    const child = spawn('powershell.exe', psArgs, {
      cwd: env.dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch (error) {
    return { ok: false, error: `启动失败：${String(error?.message ?? error)}`, elapsedMs: Date.now() - t0 }
  }

  // ④ 等控制台端口真的能连上，再回 ok —— 否则面板会说"启动了"但依然读不到数据。
  const ready = await waitForPorts([env.port], waitMs)
  if (!ready) {
    return {
      ok: false,
      started: true,
      error: `已执行 ${START_BAT}，但 ${Math.round(waitMs / 1000)} 秒内控制台端口 ${env.port} 还没起来。看 state/bridge.log 的前几行。`,
      elapsedMs: Date.now() - t0,
    }
  }
  return { ok: true, started: true, elapsedMs: Date.now() - t0 }
}

/** GET 状态：桥接在哪、DSH 就绪没、上线/下线、SnowLuma 上游健康。 */
async function handleStatus(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  // 调用方可以用 /status?autostart=0 关掉自动启动（诊断页只想看状态时用）。
  const wantAutostart = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('autostart') !== '0'

  let r = await bridgeApi(env, '/api/status')
  // 首次失败且允许自启：先确保桥接在跑，再重试一次。
  // 这样「点重试」就等于「把它拉起来」——使用者不需要知道 start.bat 在哪。
  let broughtUp = null
  if (!r.ok && wantAutostart) {
    broughtUp = await ensureBridgeRunning(env)
    if (broughtUp.ok && broughtUp.started) {
      r = await bridgeApi(env, '/api/status', { timeoutMs: 20000 })
    }
  }
  if (!r.ok) {
    return json(res, 200, {
      ok: false,
      error: r.error || `桥接控制台返回 HTTP ${r.status}`,
      // 把这轮自启的结论一起回给前端，面板才能显示「已尝试启动 / 启动失败原因」，
      // 而不是丢一句通用的「读不到数据」让人无从下手。
      autostart: broughtUp,
      bridge: { dir: env.dir, port: env.port, running: false },
    })
  }
  const s = r.data || {}
  const online = s.socialV2Paused !== true
  // 纯语音状态：和上线/下线一起返回，面板打开时不用再多打一次接口。
  // 桥接老版本没有这个端点时静默降级（tts: null），不能让状态页整个挂掉。
  let tts = null
  try {
    const t = await bridgeApi(env, '/api/socialV2/tts')
    if (t.ok) {
      tts = {
        enabled: t.data?.enabled === true,
        ready: t.data?.ready === true,
        baseUrl: t.data?.baseUrl ?? '',
      }
    }
  } catch {}
  return json(res, 200, {
    ok: true,
    // `state` 是浮游球面板通用的形状（client 半据此渲染开关）；其余字段供设置窗口用。
    state: { online, tts },
    online,
    paused: s.socialV2Paused === true,
    tts,
    dshReady: s.dshReady === true,
    mode: s.mode ?? null,
    role: s.role ?? null,
    roleMode: s.roleMode ?? null,
    ownerQQ: s.ownerQQ ?? null,
    allowPrivate: s.allowPrivate ?? [],
    allowGroups: s.allowGroups ?? [],
    snowluma: s.snowluma ?? null,
    bridge: {
      dir: env.dir,
      port: env.port,
      running: true,
      baseUrl: env.cfg?.dsh?.baseUrl ?? '',
      consoleUrl: env.base,
    },
    local: readLocalState(),
  })
}

/**
 * GET/POST 纯语音（文字 → 睦的声音）。
 *
 * 语义：打开后她照常打字（qq_send_message 不变），**桥接收到文字后**合成语音再发。
 * 她自己完全不知道这件事，人设不会被"要不要发语音"污染。
 *
 * 打开时如果 TTS 推理服务没在跑，桥接会自动拉起它；这个请求可能要等几十秒
 * （模型加载），所以前端要显示"正在启动"，不能让人以为卡死。
 */
async function handleTts(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const r = await bridgeApi(env, '/api/socialV2/tts')
    if (!r.ok) return json(res, 200, { ok: false, error: r.error || `HTTP ${r.status}` })
    return json(res, 200, { ok: true, ...(r.data || {}) })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) {
    return json(res, 400, { ok: false, error: String(error.message || error) })
  }
  const enabled = body.enabled === true
  const r = await bridgeApi(env, '/api/socialV2/tts', { method: 'POST', body: { enabled } })
  if (!r.ok) return json(res, 200, { ok: false, error: r.error || `HTTP ${r.status}` })
  return json(res, 200, { ok: true, ...(r.data || {}) })
}

/**
 * POST 重启桥接。
 *
 * 为什么需要独立端点而不是前端直接打 `/api/restart`：
 *   面板走的是插件宿主（Node 侧）转发，浏览器的 fetch 直接打桥接会缺 console-token。
 *   这里由宿主带着凭据调，前端只要点按钮。
 *
 * ⚠️ 语义要说清楚：桥接的 `/api/restart` 只是 **process.exit(0)**，
 *   靠 `start.bat` 的守护循环 5 秒后重新拉起。
 *   如果桥接是**手动 `node src/bridge.js`** 起的，退出后就真没了 ——
 *   所以这里先探测父进程，不是守护启动的就明确警告，别让用户以为"点了就一定会回来"。
 */
async function handleRestartBridge(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  // 先记下重启前的状态，便于前端提示"等多久、会不会回来"。
  const before = await bridgeApi(env, '/api/status', { timeoutMs: 5000 })
  const wasUp = before.ok

  const r = await bridgeApi(env, '/api/restart', { method: 'POST', body: {} })
  if (!r.ok) {
    return json(res, 200, { ok: false, error: r.error || `桥接拒绝重启（HTTP ${r.status}）` })
  }
  return json(res, 200, {
    ok: true,
    wasUp,
    message: r.data?.message || '桥接正在重启…',
    // 桥接退出后要等 start.bat 重新拉起，前端据此提示"几秒后刷新"。
    hint: '若由守护窗口（start.bat）启动，约 5 秒后自动恢复；手动运行的不会自动回来。',
  })
}

/** POST 上线/下线：{ online: boolean } → socialV2.paused = !online。 */
async function handleToggle(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })
  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const online = body.online === true
  const r = await bridgeApi(env, '/api/socialV2/activity', { method: 'POST', body: { paused: !online } })
  if (!r.ok) return json(res, 200, { ok: false, error: r.error || `HTTP ${r.status}` })
  return json(res, 200, { ok: true, state: { online }, online, paused: !online })
}

/** GET/POST 回复节奏（socialV2 的 send/wait/wake/context + autoReplyCheckMs）。 */
async function handleSettings(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  const current = await bridgeApi(env, '/api/socialV2/config')
  if (!current.ok) return json(res, 200, { ok: false, error: current.error || `HTTP ${current.status}` })
  const full = (current.data && current.data.config) || {}

  if ((req.method || 'GET') === 'GET') {
    const effort = await bridgeApi(env, '/api/dsh/model')
    return json(res, 200, {
      ok: true,
      rhythm: {
        autoReplyCheckMs: full.autoReplyCheckMs,
        send: full.send ?? {},
        wait: full.wait ?? {},
        wake: full.wake ?? {},
        context: full.context ?? {},
        proactive: full.proactive ?? {},
        // QQ 空间：它只是一个工具，这里只控制「能不能发 / 一天最多几条」，
        // 不控制"什么时候发" —— 那由它自己或操作者临场决定。
        qzone: full.qzone ?? {},
      },
      model: effort.ok ? effort.data : null,
      paused: full.paused === true,
    })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }

  // ★ 必须是「完整对象整体写回」：该接口浅合并，子对象会被整段替换。
  const next = { ...full, ...(body.rhythm || {}) }
  if (body.paused !== undefined) next.paused = body.paused === true
  const saved = await bridgeApi(env, '/api/socialV2/config', { method: 'POST', body: next })
  if (!saved.ok) return json(res, 200, { ok: false, error: saved.error || `HTTP ${saved.status}` })
  return json(res, 200, { ok: true, saved: saved.data })
}

/** GET/POST 人格（角色卡）。GET 带 ?name= 时返回该角色全文。 */
async function handleImpressions(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const r = await bridgeApi(env, '/api/socialV2/impressions')
    if (!r.ok) return json(res, 200, { ok: false, error: r.error || `HTTP ${r.status}` })
    const data = r.data || {}
    return json(res, 200, {
      ok: true,
      total: data.total || 0,
      impressions: Array.isArray(data.impressions) ? data.impressions : [],
    })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const action = String(body.action || '')

  if (action === 'remove') {
    const r = await bridgeApi(env, '/api/socialV2/impression-remove', {
      method: 'POST',
      body: { key: body.key, name: body.name },
    })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  if (action === 'update') {
    const payload = { key: body.key, name: body.name }
    if (body.traitIndex !== undefined) payload.traitIndex = body.traitIndex
    if (body.text !== undefined) payload.text = body.text
    if (body.newName !== undefined) payload.newName = body.newName
    if (Array.isArray(body.traits)) payload.traits = body.traits
    const r = await bridgeApi(env, '/api/socialV2/impression-update', { method: 'POST', body: payload })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  return json(res, 400, { ok: false, error: '未知 action' })
}

async function handleSelfNotes(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const wantKey = String((req.url || '').split('?')[1] || '')
    const qs = new URLSearchParams(wantKey)
    const key = qs.get('key')
    const suffix = key ? `?key=${encodeURIComponent(key)}` : ''
    const r = await bridgeApi(env, `/api/socialV2/self-notes${suffix}`)
    if (!r.ok) return json(res, 200, { ok: false, error: r.error || `HTTP ${r.status}` })
    const data = r.data || {}
    return json(res, 200, {
      ok: true,
      total: data.total || 0,
      notes: Array.isArray(data.notes) ? data.notes : [],
    })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const action = String(body.action || '')

  if (action === 'update') {
    const r = await bridgeApi(env, '/api/socialV2/memory-update', {
      method: 'POST',
      body: {
        key: body.key,
        category: 'selfNote',
        oldContent: body.oldText,
        newContent: body.text,
      },
    })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  if (action === 'remove') {
    const r = await bridgeApi(env, '/api/socialV2/memory-remove', {
      method: 'POST',
      body: { key: body.key, category: 'selfNote', content: body.text },
    })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  return json(res, 400, { ok: false, error: '未知 action' })
}

/**
 * 待办（todo）—— 2026-11-12 新增页签。
 *
 * 数据来源：桥接 /api/socialV2/todos（全局一份，只返回还没过期的）。
 * 只支持删除：待办的"编辑此刻要做什么"没有意义，过期了自然消失，
 * 真要做新的让她在聊天里重新记一条。
 */
async function handleTodos(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const r = await bridgeApi(env, '/api/socialV2/todos')
    if (!r.ok) return json(res, 200, { ok: false, error: r.error || `HTTP ${r.status}` })
    const data = r.data || {}
    return json(res, 200, {
      ok: true,
      total: data.total || 0,
      todos: Array.isArray(data.todos) ? data.todos : [],
    })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const action = String(body.action || '')

  if (action === 'remove') {
    const r = await bridgeApi(env, '/api/socialV2/memory-remove', {
      method: 'POST',
      body: { key: body.key, category: 'todo', content: body.text },
    })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  return json(res, 400, { ok: false, error: '未知 action' })
}

async function handleFacts(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const r = await bridgeApi(env, '/api/socialV2/facts')
    if (!r.ok) return json(res, 200, { ok: false, error: r.error || `HTTP ${r.status}` })
    const data = r.data || {}
    return json(res, 200, { ok: true, total: data.total || 0, facts: Array.isArray(data.facts) ? data.facts : [] })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const action = String(body.action || '')

  if (action === 'remove') {
    const r = await bridgeApi(env, '/api/socialV2/fact-remove', {
      method: 'POST',
      body: { key: body.key, id: body.id },
    })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  if (action === 'update') {
    const r = await bridgeApi(env, '/api/socialV2/fact-update', {
      method: 'POST',
      body: { key: body.key, id: body.id, text: body.text, tag: body.tag },
    })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  return json(res, 400, { ok: false, error: '未知 action' })
}

async function handlePersona(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const name = url.searchParams.get('name')

  if ((req.method || 'GET') === 'GET') {
    if (name) {
      const one = await bridgeApi(env, `/api/roles/content?name=${encodeURIComponent(name)}`)
      return json(res, 200, one.ok ? { ok: true, ...(one.data || {}) } : { ok: false, error: one.error || `HTTP ${one.status}` })
    }
    const list = await bridgeApi(env, '/api/roles')
    return json(res, 200, list.ok ? { ok: true, ...(list.data || {}) } : { ok: false, error: list.error || `HTTP ${list.status}` })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const action = String(body.action || '')

  if (action === 'save') {
    // 已存在则 update，否则 create —— 先查列表，避免把已有角色当新建而报错
    const list = await bridgeApi(env, '/api/roles')
    const names = (list.data && Array.isArray(list.data.roles)) ? list.data.roles : []
    const exists = names.includes(body.name)
    const r = await bridgeApi(env, exists ? '/api/roles/update' : '/api/roles/create', {
      method: 'POST',
      body: { name: body.name, content: body.content },
    })
    return json(res, 200, r.ok ? { ok: true, created: !exists, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  if (action === 'activate') {
    // 桥接的 /api/role 认的是 `role`（传 null 表示清除）。这里以前传 `name`，
    // 桥接只认 role 时会把 undefined 当成"清除"，于是点「设为当前角色」反而
    // 把角色清空了，还回 ok:true。字段名必须和桥接对齐。
    const r = await bridgeApi(env, '/api/role', { method: 'POST', body: { role: body.name || null } })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  if (action === 'delete') {
    const r = await bridgeApi(env, '/api/roles/delete', { method: 'POST', body: { name: body.name } })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  if (action === 'limit') {
    const r = await bridgeApi(env, '/api/roles/limit', { method: 'POST', body: { injectMaxChars: Number(body.injectMaxChars) } })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  return json(res, 400, { ok: false, error: `未知 action: ${action}` })
}

/** GET Token 用量与花费（桥接按 provider 上报的 usage 折叠，价格来自价目表）。 */
async function handleTokens(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const window = url.searchParams.get('window') || 'today'
  const r = await bridgeApi(env, `/api/tokens/summary?window=${encodeURIComponent(window)}`)
  return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
}

/** GET/POST 表情素材：列出、上传（加进 QQ 收藏）、改备注、删除、强制同步。 */
async function handleStickers(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const count = url.searchParams.get('count') || '60'
    const r = await bridgeApi(env, `/api/stickers?count=${encodeURIComponent(count)}`, { timeoutMs: 60000 })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const action = String(body.action || '')

  const forward = async (apiPath, payload, timeoutMs) => {
    const r = await bridgeApi(env, apiPath, { method: 'POST', body: payload, timeoutMs })
    return r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` }
  }

  // 上传的 base64 会经此转发到桥接；图片本体上限由桥接的 socialV2.sticker.uploadMaxBytes 把关。
  if (action === 'upload') {
    if (!body.data) return json(res, 400, { ok: false, error: 'data 不能为空' })
    return json(res, 200, await forward('/api/stickers/upload', { data: body.data, note: body.note }, 180000))
  }
  if (action === 'sync') return json(res, 200, await forward('/api/stickers/sync', {}, 90000))
  if (action === 'note') return json(res, 200, await forward('/api/stickers/note', { stickerId: body.stickerId, note: body.note, tags: body.tags, usage: body.usage }))
  if (action === 'remark') return json(res, 200, await forward('/api/stickers/remark', { stickerId: body.stickerId, remark: body.remark }, 60000))
  if (action === 'delete') return json(res, 200, await forward('/api/stickers/delete', { stickerId: body.stickerId }, 60000))
  return json(res, 400, { ok: false, error: `未知 action: ${action}` })
}

// ── SnowLuma 的启动与打开 ─────────────────────────────────────────────────
//
// ⚠️ 合规边界（写在最前面，方便日后回看）：SnowLuma 的 EULA §5.4 规定「将其并入
// 第三方安装包或 Docker 镜像、通过自动化脚本部署」须事先取得书面授权。上游
// qq-bridge 因此只探测、不部署，并在 0.2.1 删掉了早期版本的 start_snowluma /
// stop_snowluma 与 allowProcessControl 开关。
//
// 这里采取的是**本机自用**取向的折中，边界卡在三点上：
//   1. 不下载、不解压、不打包、不分发 SnowLuma —— 只启动你机器上**已经存在**的
//      launcher.bat，路径完全来自 config.json 的 snowluma.launcherPath / homeDir；
//   2. 只在你**点击按钮**时触发，没有任何自动或定时启动；
//   3. 保留配置层开关 snowluma.allowProcessControl，显式设为 false 即彻底禁用。
//
// 若日后要对外分发，请把 allowProcessControl 默认置 false（或删掉这两条路由），
// 以与上游一致的「只探测不部署」姿态发布。

/** 探一下端口是否有人监听（判断 SnowLuma 是否已经起来）。 */
function probePort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function waitForPorts(ports, totalMs) {
  const deadline = Date.now() + totalMs
  for (;;) {
    const results = await Promise.all(ports.map((p) => probePort(p)))
    if (results.every(Boolean)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/** POST 启动本机已安装的 SnowLuma。 */
async function handleLaunchSnowluma(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if (env.cfg?.snowluma?.allowProcessControl === false) {
    return json(res, 403, {
      ok: false,
      error: 'config.json 里 snowluma.allowProcessControl 为 false —— 已在配置层禁用代启动。要启用就把它改成 true 或删掉这一项。',
    })
  }

  // 顺手对齐一次 DSH 端口。
  //
  // 为什么放在这里：点「启动 SnowLuma」通常是**刚开机/刚重启 DSH 之后**的第一个动作，
  // 而桌面版 DSH 每次启动换端口、桥接只在「探测到连不上」时才重新跟随（有 60 秒冷却）。
  // 在这个时机主动促一次，能让桥接立刻跟上当前端口，不用等冷却。
  //
  // 失败不影响 SnowLuma 启动：端口对齐是"顺带"，不是前置条件。
  let endpointSync = null
  try {
    const r = await bridgeApi(env, '/api/dsh/follow-endpoint', { method: 'POST', body: {}, timeoutMs: 20000 })
    if (r.ok) endpointSync = r.data ?? null
  } catch { /* 老版本桥接没有这个端点时静默跳过 */ }

  if (await probePort(3001)) {
    return json(res, 200, { ok: true, already: true, message: 'SnowLuma 似乎已经在运行（3001 已在监听）', endpointSync })
  }

  const homeDir = String(env.cfg?.snowluma?.homeDir || '').trim()
  let launcher = String(env.cfg?.snowluma?.launcherPath || '').trim()
  if (!launcher && homeDir) launcher = path.join(homeDir, 'launcher.bat')
  if (!launcher || !fs.existsSync(launcher)) {
    return json(res, 200, {
      ok: false,
      error: `找不到 SnowLuma 启动器：${launcher || '(未配置)'}。请在 config.json 里设置 snowluma.launcherPath 或 snowluma.homeDir。`,
    })
  }

  try {
    // detached + unref：SnowLuma 必须独立于 DSH 的生命周期，否则 DSH 一重启就把它带走。
    // stdio:'ignore'：它的输出很多，捕获会撑满管道缓冲把进程卡死（同类坑踩过一次）。
    // cwd 设为安装目录：launcher.bat 里用的是相对路径（node ./index.mjs）。
    //
    // ⚠️ 这里**故意保持** `cmd /c start "" launcher.bat`（2026-11-09 试过改掉，回滚了）。
    //    试过"绕开 bat 直接 spawn node.exe + windowsHide:true"想消除 CMD 窗口，
    //    实测结果更糟：点一次按钮会连弹 3 个窗口，最后只剩一个空的黑窗口。
    //    原因没完全查清（怀疑与 SnowLuma 自己的子进程/重启逻辑、以及
    //    detached+windowsHide 在 cmd start 场景下的行为叠加有关），
    //    但结论明确：**不要动这里**。原写法至少是"能跑、只多一个 CMD"。
    //    想要无窗口，正确的做法是改 SnowLuma 自己的启动方式或做个无窗口的包装，
    //    而不是从桥接侧塞 spawn 参数 —— 那只是把窗口从"一个"变成"三个"。
    const child = spawn('cmd.exe', ['/c', 'start', '', launcher], {
      cwd: path.dirname(launcher),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
  } catch (error) {
    return json(res, 500, { ok: false, error: `启动失败：${String(error?.message ?? error)}` })
  }

  const ready = await waitForPorts([3000, 3001], 45000)

  // 端口就绪 ≠ 桥接已连上：桥接对 SnowLuma 用的是**指数退避**重连，
  // 反复失败后实测间隔可达 30 秒。所以这里继续轮询桥接状态，
  // 等到真正 connected 再返回 —— 否则用户会以为「启动了但没反应」。
  let connected = false
  if (ready) {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const st = await bridgeApi(env, '/api/status', { timeoutMs: 8000 })
      if (st.ok && st.data?.snowluma?.connected === true) { connected = true; break }
      await new Promise((r) => setTimeout(r, 2500))
    }
  }

  return json(res, 200, {
    ok: true,
    launched: true,
    ready,
    connected,
    launcher,
    message: !ready
      ? '进程已启动，但 45 秒内没等到 3000/3001 监听。可能需要在 WebUI 里扫码登录，或它启动得比较慢 —— 点「打开 WebUI」看看。'
      : connected
        ? 'SnowLuma 已启动，桥接也已连上。'
        : 'SnowLuma 已启动（端口在监听），但桥接还没连上 —— 它用的指数退避可能要再等一会儿，稍后刷新本页即可。',
  })
}

/** GET 打开 SnowLuma 的 WebUI 或安装目录。 */
async function handleOpenSnowluma(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const target = url.searchParams.get('target') || 'webui'
  const homeDir = String(env.cfg?.snowluma?.homeDir || '').trim()

  let openTarget = ''
  if (target === 'webui') {
    let port = 5099
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(homeDir, 'config', 'runtime.json'), 'utf8'))
      if (Number(runtime?.webuiPort) > 0) port = Number(runtime.webuiPort)
    } catch { /* 用默认端口 */ }
    openTarget = `http://127.0.0.1:${port}`
  } else if (target === 'dir') {
    if (!homeDir || !fs.existsSync(homeDir)) {
      return json(res, 200, { ok: false, error: `SnowLuma 目录不存在：${homeDir || '(未配置 snowluma.homeDir)'}` })
    }
    openTarget = homeDir
  } else {
    return json(res, 400, { ok: false, error: `未知 target: ${target}` })
  }

  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', openTarget], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return json(res, 200, { ok: true, opened: openTarget })
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/** GET 一键打开桥接控制台（带令牌，免手输）。
 *
 * 为什么必须在 host 侧做：控制台的 `?token=` 是**服务端凭据**，只有 host 半读得到
 * `state/console-token`。浏览器半（lib/client.js）拿不到它，也不该拿到 ——
 * 早先的注释写明「控制台令牌只留在 host 侧，绝不发给页面」。
 * 所以这里不把令牌交给页面，而是由 host 自己拼好 URL 再交给系统打开浏览器：
 * 令牌既不进页面 DOM，也不出现在任何返回体里。
 *
 * 只开**本机回环**地址，且只拼我们自己读到的端口，不接受用户传入的任意 URL
 * （否则就成了一个「让本机浏览器打开任意地址」的开放重定向口子）。
 */
async function handleOpenConsole(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  // 先确认控制台真的在监听，避免打开一个「无法访问」的标签页。
  const alive = await probePort(env.port, 1500)
  if (!alive) {
    return json(res, 200, {
      ok: false,
      error: `控制台没在监听 127.0.0.1:${env.port}（桥接可能没运行）。先启动桥接再点这个按钮。`,
    })
  }

  const target = env.token
    ? `${env.base}/?token=${encodeURIComponent(env.token)}`
    : `${env.base}/`

  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    // 注意：**不返回 target**，因为里面含控制台令牌。
    return json(res, 200, { ok: true, opened: true, port: env.port, withToken: Boolean(env.token) })
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/** GET/POST 访问控制：白名单 / 黑名单 / 管理员。
 *
 * 桥接侧已经有 GET+POST /api/whitelist，且 deny 在事件入口就 return（消息不入库、
 * 不进上下文）。这里只是把它包装成「新手也能点」的接口：
 *   · 一键踢出 = 从 allow 移除 + 加入 deny（全链路静默）
 *   · 解除拉黑 = 从 deny 移除并回到 allow
 * allow / deny 互斥，避免同一个 id 同时出现在两个名单里造成语义歧义。
 * 注意：这里**不写 ownerQQ**（不传该字段 = 桥接保留原值），改管理员请去桥接控制台。
 */
async function handleAccess(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const r = await bridgeApi(env, '/api/whitelist', { timeoutMs: 15000 })
    return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) {
    return json(res, 400, { ok: false, error: String(error.message || error) })
  }

  // 先读现状再改，避免并发覆盖（桥接的 POST 是部分更新，但这里要整体回写）
  const cur = await bridgeApi(env, '/api/whitelist', { timeoutMs: 15000 })
  if (!cur.ok) return json(res, 200, { ok: false, error: cur.error || '读不到当前名单，已放弃写入' })

  const allow = {
    private: [...(cur.data?.allow?.private || [])],
    groups: [...(cur.data?.allow?.groups || [])],
  }
  const deny = {
    private: [...(cur.data?.deny?.private || [])],
    groups: [...(cur.data?.deny?.groups || [])],
  }

  const action = String(body.action || '')
  const bucket = body.kind === 'group' ? 'groups' : 'private'
  const idNum = Number(String(body.id ?? '').trim())
  const drop = (arr, n) => { const i = arr.indexOf(n); if (i >= 0) arr.splice(i, 1) }

  if (action === 'allow' || action === 'block' || action === 'unblock') {
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return json(res, 400, { ok: false, error: 'id 必须是正整数（QQ 号或群号）' })
    }
    if (action === 'block') {
      drop(allow[bucket], idNum)
      if (!deny[bucket].includes(idNum)) deny[bucket].push(idNum)
    } else if (action === 'unblock') {
      drop(deny[bucket], idNum)
      if (!allow[bucket].includes(idNum)) allow[bucket].push(idNum)
    } else {
      drop(deny[bucket], idNum)
      if (!allow[bucket].includes(idNum)) allow[bucket].push(idNum)
    }
  } else if (action === 'drop') {
    if (!Number.isInteger(idNum) || idNum <= 0) return json(res, 400, { ok: false, error: 'id 无效' })
    drop(allow[bucket], idNum)
    drop(deny[bucket], idNum)
  } else {
    return json(res, 400, { ok: false, error: `未知 action: ${action}` })
  }

  const r = await bridgeApi(env, '/api/whitelist', {
    method: 'POST',
    body: { allow, deny },
    timeoutMs: 20000,
  })
  return json(res, 200, r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, error: r.error || `HTTP ${r.status}` })
}

/** GET/POST 后端（DSH 实例）：列出发现结果，或切换 baseUrl。 */
async function handleBackend(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  if ((req.method || 'GET') === 'GET') {
    const backends = await discoverBackends()
    const currentUrl = String(env.cfg?.dsh?.baseUrl || '').replace(/\/+$/, '')
    return json(res, 200, {
      ok: true,
      current: currentUrl,
      backends: backends.map((b) => ({ ...b, current: b.url === currentUrl })),
      supported: process.platform === 'win32',
    })
  }

  let body
  try { body = await readJsonBody(req) } catch (error) { return json(res, 400, { ok: false, error: String(error.message || error) }) }
  const targetUrl = String(body.url || '').replace(/\/+$/, '')
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(targetUrl)) {
    return json(res, 400, { ok: false, error: '只接受 http://127.0.0.1:<port> 形式的后端地址' })
  }

  // 只替换 baseUrl 一行，其余配置原样保留（不重新序列化整个 JSON）
  const configPath = path.join(env.dir, 'config.json')
  let raw
  try { raw = fs.readFileSync(configPath, 'utf8') } catch (error) { return json(res, 500, { ok: false, error: String(error.message || error) }) }
  const patched = raw.replace(/("baseUrl"\s*:\s*")[^"]*(")/, `$1${targetUrl}$2`)
  if (patched === raw && !raw.includes(targetUrl)) {
    return json(res, 500, { ok: false, error: 'config.json 里没有 dsh.baseUrl 字段' })
  }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(configPath, path.join(env.dir, 'state', `config.json.bak-${stamp}`))
    fs.writeFileSync(configPath, patched, 'utf8')
  } catch (error) {
    return json(res, 500, { ok: false, error: `写入 config.json 失败: ${String(error.message || error)}` })
  }

  // 切换后让下次 discovery 重新探测，而不是拿 30 秒内的旧列表
  backendCache = { at: 0, list: [] }

  // 桥接自带重启端点：写完立刻生效
  const restarted = await bridgeApi(env, '/api/restart', { method: 'POST', body: {} })
  return json(res, 200, {
    ok: true,
    backend: targetUrl,
    restarted: restarted.ok,
    restartNote: restarted.ok ? '桥接已重启' : `已写入配置，但自动重启失败（${restarted.error || restarted.status}），请手动重启桥接`,
  })
}

/** GET 连接诊断：一次把排查要看的都拿齐。 */
async function handleDiagnose(req, res) {
  const env = bridgeEnv()
  if (!env.ok) return json(res, 200, { ok: false, error: env.error })

  const [status, presets, model] = await Promise.all([
    bridgeApi(env, '/api/status'),
    bridgeApi(env, '/api/presets'),
    bridgeApi(env, '/api/dsh/model'),
  ])
  const s = (status.data || {})
  const presetIds = (presets.data && Array.isArray(presets.data.presets)) ? presets.data.presets.map((p) => p.id) : []
  // 取「配置里实际在用的 preset」，再判断它在不在 DSH 的清单里。
  //
  // ⚠️ 这里以前读的是 `s.agentPreset`，但 `/api/status` **不返回**这个字段，
  // 于是永远走兜底分支，显示成
  //   「qq-chat preset 已装：未配置具体 preset；可用：standard, ...」
  // —— 看着像警告，其实是假告警（config 里明明写着 qq-chat-agent）。
  // 现在 bridge 的 /api/status 已补上 agentPreset，这里才有真实值。
  // 仍保留兜底：万一旧版桥接不返回该字段，就按「至少有某个 qq-chat*」判断，
  // 并把措辞改成明确的提示，而不是一句容易被误读的「未配置」。
  const wanted = String(s.agentPreset || s.preset || '').trim()
  const wantedOk = wanted
    ? presetIds.includes(wanted)
    : presetIds.some((id) => /^qq-chat/i.test(String(id)))
  const wantedDetail = (() => {
    if (!presetIds.length) return 'DSH 还没连上，拿不到清单'
    if (!wanted) return `桥接没回传当前 preset；DSH 现有 ${presetIds.length} 个`
    return presetIds.includes(wanted)
      ? '已装'
      : `DSH 里没有它（现有 ${presetIds.join(', ')}）。跑 node scripts/setup-dsh.mjs 再重启 DSH`
  })()
  const checks = [
    { name: '桥接控制台可达', ok: status.ok, detail: status.ok ? env.base : (status.error || `HTTP ${status.status}`) },
    { name: 'DSH 已就绪', ok: s.dshReady === true, detail: s.dshReady === true ? `模式 ${s.mode}` : '桥接连不上 DSH（看 state/bridge.log）' },
    { name: 'SnowLuma 已连接', ok: s.snowluma?.connected === true, detail: s.snowluma?.connected ? `账号在线=${s.snowluma.accountOnline}` : 'WebSocket 未连接' },
    { name: 'SnowLuma 上游健康', ok: s.snowluma?.good === true, detail: s.snowluma?.good ? `来源 ${s.snowluma.goodSource || 'heartbeat'}` : (s.snowluma?.hint || '收不到 QQ 数据（注入退化）') },
    { name: wanted ? `preset「${wanted}」已装` : 'QQ preset 已装', ok: wantedOk, detail: wantedDetail },
    { name: '机器人上线中', ok: s.socialV2Paused !== true, detail: s.socialV2Paused === true ? '当前处于下线（暂停）状态' : '正常' },
  ]
  return json(res, 200, {
    ok: checks.every((c) => c.ok),
    checks,
    model: model.ok ? model.data : null,
    bridge: { dir: env.dir, port: env.port, baseUrl: env.cfg?.dsh?.baseUrl ?? '' },
  })
}

// ── 挂载 ────────────────────────────────────────────────────────────────────

export function mount(ctx) {
  // 预热后端发现：首次要 spawn PowerShell（实测 1~3 秒）。这里后台跑一次，
  // 于是用户点开「后端」页签时多半已命中 5 秒缓存，而不是先看到"加载中…"。
  discoverBackends().catch(() => {})

  // ── DSH 启动时对齐一次桥接的 baseUrl ──────────────────────────────────
  //
  // 为什么放在 mount()：这个函数在 **DSH 启动、插件加载时执行一次**，正是
  // 「桌面版 DSH 换了新端口」的那个时刻。桌面版每次启动都由 Electron 重新分配
  // 端口，桥接那边记的还是上一次的，不对齐的话它所有 RPC 都会打到一个死端口。
  //
  // 桥接侧原来有一份「掉线后每 60 秒重探一次」的轮询，已经删掉了 ——
  // 那种后台盲猜既不可预期，又会在 DSH 关机期间反复空转。
  // 现在改成**事件驱动**：DSH 启动推一次，剩下的时机（小面板点启动 SnowLuma、
  // 控制台手动按钮）各自负责，不再有周期性副作用。
  //
  // 失败完全不影响插件装配：桥接可能还没起来，下次请求会自然重试。
  try {
    const env = bridgeEnv()
    if (env.ok) {
      bridgeApi(env, '/api/dsh/follow-endpoint', { method: 'POST', body: {}, timeoutMs: 20000 })
        .then((r) => {
          if (r.ok && r.data?.changed) {
            console.log(`[qq-bigfish] DSH 启动对齐：桥接 baseUrl → ${r.data.baseUrl}`)
          }
        })
        .catch(() => {})
    }
  } catch { /* 桥接不可达时静默跳过 */ }

  const table = [
    [ROUTES.status, handleStatus],
    [ROUTES.toggle, handleToggle],
  [ROUTES.tts, handleTts],
  [ROUTES.restartBridge, handleRestartBridge],
    [ROUTES.settings, handleSettings],
    [ROUTES.persona, handlePersona],
    [ROUTES.facts, handleFacts],
    [ROUTES.impressions, handleImpressions],
    [ROUTES.selfNotes, handleSelfNotes],
    [ROUTES.todos, handleTodos],
    [ROUTES.tokens, handleTokens],
    [ROUTES.stickers, handleStickers],
    [ROUTES.launchSnowluma, handleLaunchSnowluma],
    [ROUTES.openSnowluma, handleOpenSnowluma],
    [ROUTES.openConsole, handleOpenConsole],
    [ROUTES.access, handleAccess],
    [ROUTES.backend, handleBackend],
    [ROUTES.diagnose, handleDiagnose],
  ]

  const disposers = table.map(([routePath, impl]) =>
    ctx.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (req, res) => {
        try {
          await impl(req, res)
        } catch (error) {
          try { json(res, 500, { ok: false, error: String((error && error.message) || error) }) } catch {}
        }
      },
    })
  )

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  }
}