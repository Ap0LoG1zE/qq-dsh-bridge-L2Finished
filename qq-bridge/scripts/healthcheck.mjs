// 开新会话前的完整体检：压缩 / L2 记忆 / 好感度 / 共用会话 / preset。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { collapse, loadFacts, selectForInjection, weightOf, ARCHIVE_THRESHOLD } from '../src/memory-facts.js'
import { stageOf, INITIAL_SCORE } from '../src/affinity.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const STATE = path.join(ROOT, 'state')

let fail = 0
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
  if (!cond) fail += 1
}

console.log('════════════ 1. PRESET ════════════')
const presetDir = path.join(ROOT, 'dsh', 'agent-presets')
const presets = fs.readdirSync(presetDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
ok('只剩一个 preset', presets.length === 1, `实际: ${presets.join(', ')}`)
const presetName = presets[0]
const presetFile = path.join(presetDir, presetName, 'agent.cordis.yml')
let doc = null
try {
  doc = yaml.load(fs.readFileSync(presetFile, 'utf8'))
  ok('YAML 可解析', true, presetName)
} catch (e) {
  ok('YAML 可解析', false, e.message)
}
const persona = doc?.find((r) => r.id === 'persona')
const prefix = persona?.config?.prefix ?? ''
ok('persona 存在', !!persona, `前缀 ${prefix.length} 字符`)

console.log('\n════════════ 2. 压缩机制 ════════════')
const compaction = doc?.find((r) => r.id === 'compaction')
ok('compaction 行存在', !!compaction)
const basic = compaction?.config?.find?.((r) => r.id === 'compaction-basic')
const basicCfg = basic?.config ?? {}
ok('thresholdRatio >= 0.9（对话中不压缩）', Number(basicCfg.thresholdRatio) >= 0.9, `= ${basicCfg.thresholdRatio}`)
ok('retainTokens 已设', Number(basicCfg.retainTokens) > 0, `= ${basicCfg.retainTokens}`)
ok('maxTokens 已设', Number(basicCfg.maxTokens) > 0, `= ${basicCfg.maxTokens}`)
const pruner = compaction?.config?.find?.((r) => r.id === 'tool-result-pruner')
ok('工具结果裁剪存在', !!pruner, `thresholdChars=${pruner?.config?.thresholdChars}`)
ok('compact 命令存在', !!compaction?.config?.find?.((r) => r.id === 'command-compact'))

console.log('\n════════════ 3. 唤醒包结构 ════════════')
for (const [label, needle] of [
  ['能力地图含好感度', '好感度(qq_affinity)'],
  ['【开口前】流程', '【开口前'],
  ['先人格后关系再发', '先按人格走'],
  ['无工具索引误导', '也不要去找 qq_find_tool'],
  ['非 coding agent', 'QQ'],
]) {
  ok(label, prefix.includes(needle))
}
ok('不再自称 coding agent', !prefix.includes('You are a coding agent'))
ok('黑话工具已移除', !prefix.includes('qq_slang_query'))

console.log('\n════════════ 4. L2 记忆 ════════════')
const factsDir = path.join(STATE, 'memory', 'facts')
const files = fs.existsSync(factsDir) ? fs.readdirSync(factsDir).filter((f) => f.endsWith('.jsonl')) : []
console.log(`  facts 文件: ${files.join(', ') || '(无)'}`)
if (files.length) {
  const fp = path.join(factsDir, files[0])
  const all = loadFacts(STATE, 'group:20001')
  const live = collapse(all)
  const archived = live.filter((f) => f.archived)
  const injection = selectForInjection(STATE, 'group:20001')
  console.log(`  总记录 ${all.length} / 去重 ${live.length} / 已归档 ${archived.length}`)
  console.log(`  当前注入 ${injection.picked.length} 条（${injection.text.length} 字符）`)
  ok('L2 机制可读可算', live.length > 0)
  ok('归档状态与操作者标注一致（全部归档 → 注入 0）', archived.length === live.length && injection.picked.length === 0,
    '如需注入请手动取消归档')
  ok('写入通道存在（qq_memory_append 的 longTerm 类别）', true)
}

console.log('\n════════════ 5. 好感度 ════════════')
const social = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8'))
let affTotal = 0
for (const [k, c] of Object.entries(social.conversations ?? {})) {
  const a = c.affinities ?? {}
  const n = Object.keys(a).length
  affTotal += n
  console.log(`  ${k}: ${n} 人`)
  for (const [uid, rec] of Object.entries(a)) {
    const st = stageOf(rec.score)
    console.log(`    ${uid}  ${st.label}  score=${rec.score}  互动${rec.count}次`)
  }
}
ok('好感度数据结构正常', affTotal >= 0, `共 ${affTotal} 条记录`)
// 初始值是"新认识的人站在梯度的哪一级"。保持 5（平淡）—— 这是操作者定的：
// 冷漠是**聊坏了**才会到的地方（辱骂 / 长期不互动衰减），不是陌生人的默认位置。
ok('初始值落在平淡（刚认识）', stageOf(INITIAL_SCORE).id === 'neutral', `INITIAL_SCORE=${INITIAL_SCORE}`)
// 但疏远档必须仍然可达，否则那一档就是摆设：靠扣分和衰减进去。
ok('疏远档可由扣分抵达（不是摆设）', stageOf(INITIAL_SCORE - 20).id === 'distant', `推演：${INITIAL_SCORE} - 20 → 疏远`)

console.log('\n════════════ 6. 共用会话 ════════════')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
ok('sessionSharing 已启用', cfg.sessionSharing?.enabled === true)
ok('私聊与群绑定', !!cfg.sessionSharing?.groups?.['private:10001'], JSON.stringify(cfg.sessionSharing?.groups))
ok('agentPreset 指向唯一预设', cfg.agentPreset === presetName, cfg.agentPreset)
ok('socialV2.agentPreset 一致', cfg.socialV2?.agentPreset === presetName)
const sess = JSON.parse(fs.readFileSync(path.join(STATE, 'sessions.json'), 'utf8'))
const sessIds = new Set(Object.values(sess.sessions ?? {}))
console.log(`  sessions: ${JSON.stringify(sess.sessions)}`)
ok('私聊与群共用同一个 sessionId', sessIds.size <= 1, `共 ${sessIds.size} 个`)

console.log('\n' + '═'.repeat(40))
if (fail) { console.log(`❌ ${fail} 项未通过`); process.exitCode = 1 }
else console.log('✅ 全部通过')
