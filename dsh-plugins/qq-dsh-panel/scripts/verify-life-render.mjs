// 验证「状态」页渲染：用最小 DOM stub 真实加载 client.js，喂真实数据。
//   node scripts/verify-life-render.mjs
//
// 不是查日志、不是查字符串 —— 是真的把 renderLifeTab 跑起来，
// 看它产出的节点树里有没有该有的东西。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'lib', 'client.js');

// ── 最小 DOM stub ──────────────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    id: '',
    textContent: '',
    style: { cssText: '', setProperty() {}, removeProperty() {} },
    children: [],
    parentNode: null,
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)) },
      remove(...c) { c.forEach((x) => this._s.delete(x)) },
      contains(c) { return this._s.has(c) },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c) },
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c },
    insertBefore(c) { this.children.push(c); c.parentNode = this; return c },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    getContext() { return null },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
  };
  return el;
}

const documentStub = {
  createElement: makeEl,
  createTextNode: (t) => ({ textContent: String(t), children: [] }),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  head: makeEl('head'),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};

globalThis.document = documentStub;

// client.js 整个包在 `window.__ModuleLoader__.load({ id, factory })` 里 ——
// 必须先提供这个加载器，否则求值时直接 TypeError（读 undefined 的 load）。
const moduleRegistry = {};
globalThis.window = {
  innerWidth: 1200, innerHeight: 800,
  addEventListener() {}, removeEventListener() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  devicePixelRatio: 1,
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null },
    setItem(k, v) { this._d[k] = String(v) },
    removeItem(k) { delete this._d[k] },
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  __ModuleLoader__: {
    load(spec) {
      moduleRegistry[spec.id] = spec;
      // 立刻执行 factory，让内部函数进入可访问作用域（这里由 wrapped() 触发）。
      return spec;
    },
  },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.fetch = async () => ({
  ok: true, status: 200, json: async () => ({}), text: async () => '',
});
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = () => {};
// ⚠️ 不要写 globalThis.navigator —— Node 26 里它是只读 getter，
//    赋值直接抛 `Cannot set property navigator of #<Object>`。
//    下面的 wrapped() 调用也不传它，让 client.js 用自己的兜底。

// ── 加载 client.js，取出渲染函数 ────────────────────────────────────────────
const src = fs.readFileSync(CLIENT, 'utf8');

if (!src.includes('function renderLifeTab')) {
  console.error('❌ client.js 里找不到 renderLifeTab');
  process.exit(1);
}

// client.js 的结构是：
//   window.__ModuleLoader__.load({ id, factory: function (require) { ...全部代码... } })
// 所以不能直接把整份源码包进 new Function —— 得让 load 捕获 factory，
// 再单独执行 factory 并把内部函数取出来。
//
// 做法：先在一个壳里跑整份源码（只为让 load() 被调用、拿到 factory），
// 然后用「把 factory 源码抠出来重跑 + 末尾追加 return」拿到引用。
const factoryMatch = /factory:\s*function\s*\([^)]*\)\s*\{/.exec(src);
if (!factoryMatch) {
  console.error('❌ 找不到 factory 定义');
  process.exit(1);
}

// 从 factory 的开括号起，按大括号配平找到闭合位置（字符串/注释里的大括号要跳过）。
function findMatchingBrace(text, openIdx) {
  let depth = 0;
  let i = openIdx;
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  while (i < text.length) {
    const ch = text[i];
    const nx = text[i + 1];
    if (inLine) { if (ch === '\n') inLine = false; i++; continue; }
    if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++; continue;
    }
    if (ch === '/' && nx === '/') { inLine = true; i += 2; continue; }
    if (ch === '/' && nx === '*') { inBlock = true; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      i++; continue;
    }
    i++;
  }
  return -1;
}

const bodyStart = factoryMatch.index + factoryMatch[0].length;
const bodyEnd = findMatchingBrace(src, bodyStart - 1);
if (bodyEnd < 0) {
  console.error('❌ factory 大括号没有配平');
  process.exit(1);
}
const factoryBody = src.slice(bodyStart, bodyEnd);

// 在工厂体末尾追加探针。
// ⚠️ 工厂最后一行是 `return module.exports` —— 探针必须**插在 return 之前**，
//    否则永远执行不到（第一版踩过这个坑，表现为"工厂跑了但拿不到函数"）。
const PROBE = `
  // __probe__：渲染函数 + 一个能拦住 setBody 入参的钩子。
  //
  // 直接读 DOM 树行不通：setBody 第一行是 \`if (!modal) return\`，
  // stub 里没有 modal，它直接返回、什么都不写。
  // 所以这里把 pendingBody 暴露出去，脚本调用后再检查渲染出的节点。
  module.exports.__probe = {
    renderLifeTab: renderLifeTab,
    section: section,
    kv: kv,
    h: h,
    setCapture: function (fn) { __captureSetBody = fn },
  }
`;
const RETURN_LINE = '  return module.exports'
const returnIdx = factoryBody.lastIndexOf(RETURN_LINE)
let bodyWithProbe = returnIdx >= 0
  ? factoryBody.slice(0, returnIdx) + PROBE + factoryBody.slice(returnIdx)
  : factoryBody + PROBE + '\nreturn module.exports;\n'

// 在工厂体最前面声明捕获变量，并给 setBody 开头插一行转发。
// setBody 的签名是 `function setBody(nodes, opts) {` —— 在它后面插一行。
bodyWithProbe = 'var __captureSetBody = null;\n' + bodyWithProbe
const setBodyDecl = 'function setBody(nodes, opts) {'
const sbIdx = bodyWithProbe.indexOf(setBodyDecl)
if (sbIdx < 0) {
  console.error('❌ 找不到 setBody 定义')
  process.exit(1)
}
const insertAt = sbIdx + setBodyDecl.length
bodyWithProbe = bodyWithProbe.slice(0, insertAt)
  + '\n    if (__captureSetBody) { try { __captureSetBody(nodes) } catch (e) {} }'
  + bodyWithProbe.slice(insertAt)

const factoryFn = new Function(
  'document', 'window', 'localStorage', 'fetch', 'requestAnimationFrame',
  'cancelAnimationFrame', 'navigator', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'require',
  bodyWithProbe
);

let api;
try {
  const exported = factoryFn(
    documentStub, globalThis.window, globalThis.window.localStorage,
    globalThis.fetch, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame,
    { userAgent: 'node' }, setTimeout, clearTimeout, setInterval, clearInterval,
    () => ({})
  );
  api = exported && exported.__probe ? exported.__probe : null
} catch (error) {
  console.error('❌ 执行 factory 失败：', error.message);
  console.error(error.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

if (!api || typeof api.renderLifeTab !== 'function') {
  console.error('❌ 拿不到 renderLifeTab');
  process.exit(1);
}

// ── 构造真实形状的数据（与 /api/life 的返回一致）────────────────────────────
const NOW = Date.now();
const data = {
  ok: true,
  enabled: true,
  timezone: 'Asia/Shanghai',
  dayKey: '2026-11-24',
  clock: '03:20',
  circle: { satiety: 58, energy: 52, energyBase: 67, desire: 0, asleep: false },
  mood: '疲惫',
  cycle: {
    phase: 'follicular', phaseName: '卵泡期', dayInCycle: 4, cycleDays: 28,
    daysToNextPeriod: 25, energyMedian: 0, mark: '', inPeriod: false
  },
  weather: { text: '阴', tempC: 18, feelsC: 17, sunrise: '06:46', sunset: '17:40', stale: false },
  conditions: [
    { id: 'd1', kind: 'cycle_discomfort', label: '今天有点痛经，小腹闷闷的不舒服', mood: '疲惫', energyDelta: -14, intensity: 70, endsAt: NOW + 3600000, remainMinutes: 60 },
    { id: 'h1', kind: 'health', label: '鼻子不通，整个人昏昏沉沉', mood: '疲惫', energyDelta: -12, intensity: 65, endsAt: NOW + 7200000, remainMinutes: 120 },
    { id: 'm1', kind: 'meal', label: '饿了，想吃东西', mood: '走神', energyDelta: -6, intensity: 50, endsAt: NOW + 1800000, remainMinutes: 30 }
  ],
  meta: { lastDiscomfortRoll: '2026-11-24', lastHealthRoll: '2026-11-24', lastSleepDay: '2026-11-24', lastSleepHours: 6 },
  flags: { circle: true, cycle: true, health: true, sleep: true, discomfort: true, meals: true, weather: true }
};

// ── 跑渲染 ──────────────────────────────────────────────────────────────────
let capturedNodes = null;
api.setCapture((nodes) => { capturedNodes = nodes });

try {
  api.renderLifeTab(data);
} catch (error) {
  console.error('❌ 渲染抛错：', error.message);
  console.error(error.stack);
  process.exit(1);
}

if (!capturedNodes) {
  console.error('❌ setBody 没有被调用（渲染函数没走到 setBody）');
  process.exit(1);
}

// ── 把节点树拍平成文本 ──────────────────────────────────────────────────────
function flatten(node, out) {
  if (!node || typeof node !== 'object') {
    if (typeof node === 'string' && node) out.push(node);
    return out;
  }
  if (node.textContent) out.push(String(node.textContent));
  if (Array.isArray(node.children)) {
    for (const c of node.children) flatten(c, out);
  }
  return out;
}

const allText = flatten({ children: capturedNodes }, []);
const joined = allText.join('\n');

console.log('════ 渲染产出的文本 ════');
console.log(joined || '（空）');
console.log('════════════════════');

// ── 断言 ────────────────────────────────────────────────────────────────────
const need = [
  ['时间', /03:20/],
  ['天气', /阴 18°/],
  ['饱腹条', /饱腹/],
  ['精力条', /精力/],
  ['精力原始值提示', /叠加后 52，原始 67/],
  ['性欲条', /性欲/],
  ['性欲不显示提示', /低于 80 不显示/],
  ['心情', /疲惫/],
  ['周期', /卵泡期/],
  ['周期第几天', /第 4 \/ 28 天/],
  ['距下次', /距下次/],
  ['叠加状态标题', /叠加状态（3 条）/],
  ['痛经条目', /痛经/],
  ['健康条目', /鼻子不通/],
  ['饭点条目', /饿了，想吃东西/],
  ['精力影响', /-14 精力/],
  ['剩余时间（小时档）', /剩 1 小时 0 分/],
  ['剩余时间（分钟档）', /剩 30 分/],
  ['开关行', /身体✓/],
  ['今日已掷', /今天已掷/],
];
let pass = 0;
let fail = 0;
console.log('\n════ 断言 ════');
for (const [name, re] of need) {
  if (re.test(joined)) { console.log(`  ✅ ${name}`); pass += 1; }
  else { console.log(`  ❌ ${name}   （未找到 ${re}）`); fail += 1; }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
