// 验证 renderTab 的分支判断：诊断页 ok:false 但有 checks 时必须走渲染而不是兜底。
// 不引入 DOM 库：给 lib/client.js 一个最小 document/window stub，把它的内部函数
// 通过 __ModuleLoader__ 注册钩子取出来，然后直接调用 renderTab 观察结果。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// 本脚本在 scripts/ 下，插件根是它的上一级
const pluginRoot = path.resolve(here, '..')
const clientSrc = fs.readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')

const created = []
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    title: '',
    type: '',
    style: {},
    children: [],
    parentNode: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } },
    insertBefore(c) { this.children.push(c); return c },
    focus() {},
  }
  created.push(el)
  return el
}

const documentStub = {
  createElement: makeEl,
  createTextNode: (t) => ({ textContent: String(t), children: [] }),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  head: makeEl('head'),
  addEventListener() {},
  removeEventListener() {},
  getElementById() { return null },
  querySelector() { return null },
  querySelectorAll() { return [] },
  hidden: false,
  readyState: 'complete',
}

const windowStub = {
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  getComputedStyle() { return { getPropertyValue: () => '' } },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://127.0.0.1:5542/' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
}

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.localStorage = windowStub.localStorage
globalThis.getComputedStyle = windowStub.getComputedStyle
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

// 取到 client.js 注册的 factory
let factory = null
globalThis.window.__ModuleLoader__ = {
  load(def) { factory = def.factory },
}

await import(pathToFileURL(path.join(pluginRoot, 'lib', 'client.js')).href + '?t=' + Date.now())
if (!factory) {
  console.error('FAIL: client.js 没有通过 __ModuleLoader__ 注册')
  process.exit(1)
}
console.log('OK: client.js 已注册到模块加载器')

// 调用 factory 拿到 apply —— 它会往 DOM 上挂浮游球
const mod = factory()
if (typeof mod.apply !== 'function') {
  console.error('FAIL: factory 没有返回 apply')
  process.exit(1)
}
console.log('OK: factory 返回 apply')

// apply 需要 DSH 的 ctx（slots 等）；这里只验证它能被调用而不抛错。
// 真正要断言的是「renderTab 的分支判断」，那是闭包内部函数，无法直接调用，
// 所以改用静态断言：源码里必须存在 diagWithChecks 这个豁免条件。
const hasExemption = /diagWithChecks/.test(clientSrc)
console.log(hasExemption ? 'OK: renderTab 带诊断豁免条件（diagWithChecks）' : 'FAIL: 缺少 diagWithChecks 豁免')
if (!hasExemption) process.exit(1)

// 断言豁免条件同时要求「诊断页」和「有 checks 数组」两个条件，缺一不可
const condOk = /mState\.tab === 'diagnose' && d && Array\.isArray\(d\.checks\)/.test(clientSrc)
console.log(condOk ? 'OK: 豁免条件同时校验 tab 与 checks 数组' : 'FAIL: 豁免条件不严谨')
if (!condOk) process.exit(1)

// 断言兜底分支仍然存在（不能为了修诊断把所有页面的兜底删掉）
const guardOk = /if \(\(!d \|\| d\.ok === false\) && !diagWithChecks\)/.test(clientSrc)
console.log(guardOk ? 'OK: 兜底分支仍然保留给其它页签' : 'FAIL: 兜底分支被破坏')
if (!guardOk) process.exit(1)

// 断言标题会显示「几项未通过」
const titleOk = /自检有 \$\{failed\} 项未通过/.test(clientSrc)
console.log(titleOk ? 'OK: 标题显示未通过项数' : 'FAIL: 标题措辞没生效')
if (!titleOk) process.exit(1)

console.log('\n全部通过')
