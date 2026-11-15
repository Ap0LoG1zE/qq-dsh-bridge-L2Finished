// 完整演示好感度的数据流：一条消息进来 → 记分 → 下次唤醒注入。
// 不连真实桥接，纯逻辑演示，把每一步的中间值打出来。
import { stageOf, scoreForMessage, bumpAffinity, decayAffinity, renderAffinityLine, INITIAL_SCORE } from '../src/affinity.js'

const bar = (s) => s.repeat(64)

console.log(bar('═'))
console.log('好感度是怎么"让她知道"的 —— 完整数据流')
console.log(bar('═'))

// ── 第 1 步：消息进来 ──
console.log('\n【第 1 步】群里 群友A 说了句话')
const incoming = { userId: '70002', sender: '群友A', text: '你还好吗', isSelf: false, isOwner: false }
console.log(`  userId=${incoming.userId}  text="${incoming.text}"`)

// ── 第 2 步：算这次该加多少分 ──
const delta = scoreForMessage({ text: incoming.text, isSelf: incoming.isSelf, isOwner: incoming.isOwner })
console.log(`\n【第 2 步】算分：scoreForMessage()`)
console.log(`  基础 +1`)
if (incoming.text.includes('你还好吗')) console.log(`  命中"关心她" +3`)
console.log(`  → 本次 ${delta >= 0 ? '+' : ''}${delta}`)

// ── 第 3 步：累加到这个人的记录 ──
let record = { score: INITIAL_SCORE, stageId: stageOf(INITIAL_SCORE).id, lastAt: Date.now(), count: 0, createdAt: Date.now() }
console.log(`\n【第 3 步】累加：bumpAffinity()`)
console.log(`  之前：score=${record.score} (${stageOf(record.score).label})  count=${record.count}`)
record = bumpAffinity(record, delta)
console.log(`  之后：score=${record.score} (${stageOf(record.score).label})  count=${record.count}`)
console.log(`  存进 social-v2.json → affinities["${incoming.userId}"]`)

// ── 第 4 步：下次她被唤醒时，拼进提示词 ──
console.log(`\n【第 4 步】下次唤醒：buildAffinityLineV2()`)
console.log(`  ① 从本轮未读里找到最后说话的人 → userId=${incoming.userId}`)
console.log(`  ② 去 affinities 表里查这个 userId`)
console.log(`  ③ 查到了 score=${record.score} → 换算成档位「${stageOf(record.score).label}」`)
console.log(`  ④ 渲染成一行文本，塞进唤醒包`)
console.log(`\n  ── 模型实际看到的就是这一行 ──`)
console.log('  ' + renderAffinityLine(record, '群友A').split('\n').join('\n  '))

// ── 第 5 步：她的回复 ──
console.log(`\n【第 5 步】她读到那一行，自己决定怎么回`)
console.log(`  注意：代码**没有**命令她说什么。`)
console.log(`  她只知道"跟群友A关系处在 ${stageOf(record.score).label}"，`)
console.log(`  具体说什么由人格卡（角色A）决定。`)

console.log('\n' + bar('─'))
console.log('关键点')
console.log(bar('─'))
console.log('  1. 分数存在 state/social-v2.json 的 conversations[key].affinities[userId]')
console.log('  2. 每次唤醒现算现拼，不是事先写死')
console.log('  3. 注入的只有"关系状态"一句，不含任何行为指令')
console.log('  4. 她"知道"的方式 = 每轮提示词里有这一行文字')
