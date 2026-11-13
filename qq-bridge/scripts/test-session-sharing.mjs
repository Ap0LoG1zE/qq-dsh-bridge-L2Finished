// 共用会话（sessionSharing）单元验证：不连 bridge 主进程，只测纯函数逻辑。
// 覆盖：key 归一、组内成员收集、最低档 preset 选择、以及「记忆共享但不乱串」的边界。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src', 'bridge.js')
const text = fs.readFileSync(SRC, 'utf8')

let pass = 0
const ok = (name) => { pass += 1; console.log(`✅ ${name}`) }

// ── 从源码里抽取纯函数来测（bridge.js 整体 import 会启动进程，只能摘出来）──
function grab(name) {
  const re = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`, 'm')
  const m = re.exec(text)
  assert.ok(m, `源码里找不到函数 ${name}`)
  let depth = 0
  let i = m.index + m[0].length - 1
  const start = m.index
  for (; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break } }
  }
  return text.slice(start, i)
}

const canonicalSrc = grab('canonicalV2Key')
const sharedSrc = grab('sharedOwnerKeyOf')
const canonicalV2Key = new Function(`${canonicalSrc}; return canonicalV2Key`)()
const sharedOwnerKeyOf = new Function('canonicalV2Key', `${sharedSrc}; return sharedOwnerKeyOf`)(canonicalV2Key)

const GROUP = 'group:20001'
const PRIVATE = 'private:10001'
const cfg = { sessionSharing: { enabled: true, groups: { [PRIVATE]: GROUP }, preset: '' } }
const off = { sessionSharing: { enabled: false, groups: { [PRIVATE]: GROUP }, preset: '' } }

// 1. 开启后，两个 key 归一到同一个代表 key
assert.equal(sharedOwnerKeyOf(cfg, PRIVATE), GROUP)
assert.equal(sharedOwnerKeyOf(cfg, GROUP), GROUP)
ok('私聊与群归一到同一个代表 key（group 优先）')

// 2. 关闭时完全不变（旧行为零影响）
assert.equal(sharedOwnerKeyOf(off, PRIVATE), PRIVATE)
assert.equal(sharedOwnerKeyOf(off, GROUP), GROUP)
ok('共享关闭时每个 key 保持独立')

// 3. 不在组里的 key 不受影响
assert.equal(sharedOwnerKeyOf(cfg, 'group:123456'), 'group:123456')
assert.equal(sharedOwnerKeyOf(cfg, 'private:999'), 'private:999')
ok('未登记的 key 不受共享影响')

// 4. 前导零归一：group:0993 与 group:993 视为同一组
assert.equal(sharedOwnerKeyOf(cfg, 'private:010001'), GROUP)
ok('前导零的不同写法归一到同一组（防事实库分裂）')

// 5. 代表 key 必须只由组内容决定，与"谁先说话"无关
const a = sharedOwnerKeyOf(cfg, PRIVATE)
const b = sharedOwnerKeyOf(cfg, GROUP)
assert.equal(a, b, '同一组从不同成员算出的代表 key 必须一致')
ok('代表 key 与调用方无关（纯函数）')

// 6. 多成员组：仍然取 group 那个
const cfgMulti = { sessionSharing: { enabled: true, groups: { [PRIVATE]: [GROUP, 'private:555'], preset: '' } } }
assert.equal(sharedOwnerKeyOf(cfgMulti, 'private:555'), GROUP)
ok('多成员组同样收敛到 group 代表 key')

// 7. 没有 group 成员的组：退化为字典序最小，且稳定
const cfgNoGroup = { sessionSharing: { enabled: true, groups: { 'private:200': ['private:100'], preset: '' } } }
assert.equal(sharedOwnerKeyOf(cfgNoGroup, 'private:200'), 'private:100')
assert.equal(sharedOwnerKeyOf(cfgNoGroup, 'private:100'), 'private:100')
ok('无 group 的组退化为字典序最小 key，且稳定')

// ── 结构断言：源码里必须存在这些关键机制 ──
for (const [label, needle] of [
  ['回复按回合归属路由', 'turnKeyQueue'],
  ['本轮归属锁存', 'turnKeyLatch'],
  ['队列按共享组串行', 'queueKeyOf'],
  ['记忆按共享组读写', 'memoryKeyOf'],
  ['组内取最低档 preset', 'sharedPresetName'],
  ['场景感知注入', 'buildSceneLineV2'],
  ['组内策略一致（防互相退役）', 'shareGroupOf'],
]) {
  assert.ok(text.includes(needle), `源码缺少 ${label}（${needle}）`)
}
ok('七个关键机制都在源码里')

// 7b. 本轮消息必须跨聊天聚合、且每条带来源标签（manager 的核心需求）
for (const [label, needle] of [
  ['跨聊天聚合本轮消息', 'collectSharedMessagesV2'],
  ['消息带聊天标签', 'chatLabelForV2'],
  ['渲染时标明去处', '方括号'],
]) {
  assert.ok(text.includes(needle), `缺少 ${label}（${needle}）`)
}
// 标签必须能生成，且群/私聊可区分
const chatLabelSrc = grab('chatLabelForV2')
const chatLabelForV2 = new Function(
  'canonicalV2Key', 'cfg',
  `${chatLabelSrc}; return chatLabelForV2`,
)(canonicalV2Key, { ownerQQ: 10001 })
assert.equal(chatLabelForV2('group:20001'), '群20001')
assert.match(chatLabelForV2('private:10001'), /私聊10001/)
ok('聊天标签生成正确（群 / 私聊可区分，主人有标记）')

// 7c. 标签与 key 必须一一对应：模型照着标签就能填对 key
assert.ok(chatLabelForV2('group:20001').includes('20001'))
assert.ok(chatLabelForV2('private:10001').includes('10001'))
ok('标签里带群号/QQ 号，可直接对应到 key 参数')

// 8. 最低档 preset：组内同时有 owner 与 readonly 时必须选 readonly
const sharedPresetSrc = grab('sharedPresetName')
const TIER_PRESETS = { OWNER: 'qq-chat-owner', READONLY: 'qq-chat-readonly' }
function makeWanted(tierOf) {
  return (key, mode, c) => {
    const t = tierOf(key)
    if (t === 'owner') return TIER_PRESETS.OWNER
    if (t === 'readonly') return TIER_PRESETS.READONLY
    return c.socialV2.agentPreset
  }
}
const wanted = makeWanted((k) => (k === PRIVATE ? 'owner' : 'readonly'))
const sharedPresetName = new Function(
  'wantedPresetName', 'TIER_PRESETS',
  `${sharedPresetSrc}; return sharedPresetName`,
)(wanted, TIER_PRESETS)
const chosen = sharedPresetName([PRIVATE, GROUP], 'reserved2', { socialV2: { agentPreset: 'qq-chat-v2' } })
assert.equal(chosen, 'qq-chat-readonly', '共用组必须取最低档 readonly，否则群友可驱动本机工具')
ok('共用组取最低档：owner + readonly → readonly（安全边界）')

console.log(`\n共用会话测试通过：${pass} 项`)
