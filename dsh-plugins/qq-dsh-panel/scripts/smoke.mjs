import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-floatdock-'))
process.env.DSH_HOME = tmpHome

const { apply, name, inject } = await import('../lib/index.js')

const sections = []
const routes = []
const taps = []
const effects = []

const ctx = {
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
  },
  effect(fn) {
    effects.push(fn)
    return () => {}
  },
}

apply(ctx)

assert.equal(name, 'qq-dsh-panel')
assert.deepEqual(inject, ['systemPrompt', 'webServer'])

// --- the feature contributed exactly one prompt section ---
assert.equal(sections.length, 1)
assert.equal(sections[0].name, 'thinking-language-zh')
assert.equal(sections[0].order, 10250)
assert.match(sections[0].text({}), /简体中文/)
assert.match(sections[0].text({}), /代码、命令、报错信息/)

// --- the feature registered only its own routes; the client asset comes
// from the module loader instead of an HTTP route ---
const stateRoute = routes.find((r) => r.path === '/qq-dsh-panel/state')
assert.ok(stateRoute, 'feature state route registered')
const workspacesRoute = routes.find((r) => r.path === '/qq-dsh-panel/workspaces')
assert.ok(workspacesRoute, 'workspace list route registered')
// `routes` also holds qq-bigfish's own routes (it shares the /qq-dsh-panel/ prefix),
// so count only the two paths this feature owns.
const thinkingRoutes = routes.filter(
  (r) => r.path === '/qq-dsh-panel/state' || r.path === '/qq-dsh-panel/workspaces'
)
assert.equal(thinkingRoutes.length, 2, 'this feature registers exactly two routes')
assert.equal(taps.length, 0, 'no index injection is registered anymore')

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers || {}
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

async function call(payload, { method = 'POST', contentType = 'application/json' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  req.method = method
  req.headers = contentType === null ? {} : { 'content-type': contentType }
  const res = makeRes()
  await stateRoute.handler(req, res)
  const json = res.body === '' ? null : JSON.parse(res.body)
  return { res, json }
}

// --- switch on/off and modes reach the prompt section ---
let out = await call({ enabled: false })
assert.equal(out.res.statusCode, 200)
assert.equal(out.json.state.enabled, false)
assert.equal(sections[0].text({}), '')

out = await call({ enabled: true, mode: 'mixed' })
assert.equal(out.json.state.enabled, true)
assert.equal(out.json.state.mode, 'mixed')
assert.match(sections[0].text({}), /中英混用/)

out = await call({ mode: 'auto' })
assert.equal(out.json.state.mode, 'auto')
assert.match(sections[0].text({}), /跟随用户语言/)

// --- workspace scoping: only the listed workspaces get the section ---
// The section is evaluated per assembly with that assembly's agent, so the
// cwd of the session's header decides whether the rule applies.
// 这两个 cwd 只是用来验证"工作区范围"判定，内容不需要是真实路径
//（2026-11-15 开源清理：原来写的是作者本机的 <仓库>\...）。
const QQ_CWD = path.join('D:', 'work', 'qq-bridge', 'state', 'agents')
const OTHER_CWD = path.join('D:', 'work', 'other-workspace')
const ctxWithCwd = (cwd) => ({ agent: { session: { header: cwd === undefined ? {} : { cwd } } } })

// The workspace list is read from the Host's registry file; seed one so the
// list route and the picker have something to show.
fs.mkdirSync(path.join(tmpHome, 'storages'), { recursive: true })
fs.writeFileSync(
  path.join(tmpHome, 'storages', 'workspace.json'),
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    tables: {
      workspaces: {
        '7c1f20a0-c29b-4181-9d30-bbdb74502b74': { path: QQ_CWD, title: 'QQ 聊天', sessionIds: ['s1', 's2'] },
        '79de119c-04ab-4759-a0e5-3a646cd117e8': { path: OTHER_CWD, title: '日常', sessionIds: ['s3'] },
      },
    },
  }),
  'utf8'
)

out = await call({ scope: 'all', enabled: true, mode: 'zh' })
assert.equal(out.json.state.scope, 'all')
assert.match(sections[0].text(ctxWithCwd(QQ_CWD)), /简体中文/, 'scope=all reaches every workspace')
assert.match(sections[0].text(ctxWithCwd(OTHER_CWD)), /简体中文/, 'scope=all reaches other workspaces')
assert.match(sections[0].text(ctxWithCwd(undefined)), /简体中文/, 'scope=all reaches sessions without cwd')

out = await call({ scope: 'workspaces' })
assert.equal(out.json.state.scope, 'workspaces')
assert.equal(
  sections[0].text(ctxWithCwd(QQ_CWD)),
  '',
  'an empty allow-list means nothing is in scope, not everything'
)

out = await call({ workspaces: [QQ_CWD] })
assert.equal(out.json.state.workspaces.length, 1)
assert.match(sections[0].text(ctxWithCwd(QQ_CWD)), /简体中文/, 'the listed workspace is in scope')
assert.equal(sections[0].text(ctxWithCwd(OTHER_CWD)), '', 'other workspaces stay untouched')
assert.equal(sections[0].text(ctxWithCwd(undefined)), '', 'sessions without cwd stay untouched')

// separator and case differences must still match (Windows paths)
assert.match(
  sections[0].text(ctxWithCwd('d:/DSH/qq-dsh-bridge/qq-bridge/state/agents')),
  /简体中文/,
  'path comparison is separator- and case-insensitive'
)
// a sibling directory with the same prefix is a different workspace
assert.equal(
  sections[0].text(ctxWithCwd(QQ_CWD + '-old')),
  '',
  'a prefix-colliding sibling directory is not in scope'
)

// subdirectories of a selected workspace are part of it
assert.match(
  sections[0].text(ctxWithCwd(QQ_CWD + '\\child')),
  /简体中文/,
  'subdirectories inherit the workspace scope'
)

// --- the workspace list route exposes title/path/session count ---
{
  const res = makeRes()
  const req = Readable.from([])
  req.method = 'GET'
  req.headers = {}
  await workspacesRoute.handler(req, res)
  const json = JSON.parse(res.body)
  assert.equal(json.ok, true)
  assert.ok(Array.isArray(json.workspaces))
  const qq = json.workspaces.find((w) => w.path === QQ_CWD)
  assert.ok(qq, 'the seeded workspace is listed')
  assert.equal(qq.title, 'QQ 聊天')
  assert.equal(qq.sessions, 2)
}

// back to a clean global default for the remaining assertions
out = await call({ scope: 'all', workspaces: [] })

// --- request hardening ---
out = await call({ enabled: true }, { method: 'DELETE' })
assert.equal(out.res.statusCode, 405)
assert.equal(out.res.headers.Allow, 'GET, POST, PUT')

out = await call({ enabled: true }, { contentType: 'text/plain' })
assert.equal(out.res.statusCode, 415)

out = await call({ enabled: true }, { contentType: null })
assert.equal(out.res.statusCode, 415)

// --- corrupt state must not be trusted ---
const stateFile = path.join(tmpHome, '.dsh-thinking-zh.json')

function mountFresh() {
  const collected = []
  apply({
    systemPrompt: {
      section: (s) => {
        collected.push(s)
        return () => {}
      },
    },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    effect: () => () => {},
  })
  return collected.at(-1)
}

fs.writeFileSync(stateFile, JSON.stringify({ enabled: false, mode: 'bogus' }), 'utf8')
assert.equal(mountFresh().text({}), '', 'boolean false must disable the section')

fs.writeFileSync(stateFile, JSON.stringify({ enabled: 'false' }), 'utf8')
assert.match(
  mountFresh().text({}),
  /简体中文/,
  'a non-boolean enabled falls back to the default instead of stringifying'
)

// --- the client half is a module-loader plugin, not an injected asset ---
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.equal(manifest.dsh.client.platform, 'web', 'client platform is declared')
assert.equal(manifest.exports['./client'], './lib/client.js', 'client entry is exported')
assert.equal(manifest.exports['.'], './lib/index.js', 'host entry is exported')

const clientJs = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
assert.match(clientJs, /__ModuleLoader__\.load\(/, 'registered through the page module loader')
assert.match(clientJs, /id:\s*'qq-dsh-panel'/, 'module id matches the package name')
assert.match(clientJs, /exports\.apply\s*=/, 'exposes apply')
assert.match(clientJs, /dsh-fb-ball/, 'floating ball is rendered')
assert.match(clientJs, /position:fixed/, 'ball is position:fixed')
assert.match(clientJs, /localStorage/, 'position is persisted')
assert.match(clientJs, /FEATURES\s*=/, 'features live in a registry')
assert.match(clientJs, /pointerdown/, 'drag gesture is wired')
assert.ok(!/data-composer-card/.test(clientJs), 'no composer DOM dependency anymore')
assert.ok(!/data-composer-seat/.test(clientJs), 'no composer seat dependency anymore')

// --- teardown is wired through ctx.effect ---
assert.equal(effects.length, 1)
assert.doesNotThrow(() => effects[0]()())

console.log('SMOKE OK')
console.log('tmpHome=' + tmpHome)
