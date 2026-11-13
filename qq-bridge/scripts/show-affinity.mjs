// 好感度完整说明：五档内容 + 分值区间 + 升降规则。给操作者看的。
//
// ⚠️ 这份输出**必须从 affinity.js 现读**，不能在脚本里另抄一份阈值。
// 历史教训：脚本里写死了「依赖 90~200、总分 -20~200、初始值 5」，
// 而模块早就改成 600 上限、加了喜欢档、初始值也移到了疏远档 ——
// 于是 `npm run` 出来的"说明"和真实行为相反，看完只会更糊涂。
import {
  STAGES, STAGE_HINTS, INITIAL_SCORE, SCORE_MIN, SCORE_MAX,
  SCORE_PER_MESSAGE, SCORE_PER_MESSAGE_CAP,
  BONUS_KEYWORDS, PENALTY_KEYWORDS, DECAY_DAYS, DECAY_AMOUNT,
  stageOf,
} from '../src/affinity.js'

const bar = (s) => s.repeat(62)
console.log(bar('═'))
console.log('好感度：五档内容与分值区间（一条从冷漠到喜欢的线）')
console.log(bar('═'))
console.log('')

// 档位区间：下界取 STAGES 的 min，上界取下一档 min - 1（最高档取 SCORE_MAX）。
const sorted = [...STAGES].sort((a, b) => (a.min === -Infinity ? -1e9 : a.min) - (b.min === -Infinity ? -1e9 : b.min))
const descOf = {
  distant: '冷漠（起点）',
  neutral: '观察',
  caring: '朋友',
  reliant: '舍不得',
  lover: '想，控制不住',
}
for (let i = 0; i < sorted.length; i += 1) {
  const s = sorted[i]
  const from = s.min === -Infinity ? SCORE_MIN : s.min
  const nextMin = sorted[i + 1]?.min
  const to = nextMin === undefined ? SCORE_MAX : nextMin - 1
  console.log(`【${s.label}】  分数 ${from} ~ ${to}    (${descOf[s.id] ?? ''})`)
  console.log(`  状态：${STAGE_HINTS[s.id].hint}`)
  console.log('')
}

console.log(bar('─'))
console.log('分值明细')
console.log(bar('─'))
console.log('')
console.log(`初始值          ${INITIAL_SCORE}（= ${stageOf(INITIAL_SCORE).label}，新认识的人从这里起步）`)
console.log(`每条普通消息    +${SCORE_PER_MESSAGE}`)
console.log(`主人说话        额外 +1`)
console.log('')
console.log('加分项：')
for (const b of BONUS_KEYWORDS) {
  console.log(`  ${String(b.add).padStart(3)}  ${b.why}`)
}
console.log('')
console.log('扣分项：')
for (const p of PENALTY_KEYWORDS) {
  console.log(`  ${String(p.add).padStart(3)}  ${p.why}`)
}
console.log('')
console.log(`单次上下限      -12 ~ +${SCORE_PER_MESSAGE_CAP + 8}`)
console.log(`总分范围        ${SCORE_MIN} ~ ${SCORE_MAX}`)
console.log(`衰减            ${DECAY_DAYS} 天不互动 -${DECAY_AMOUNT} 分`)
console.log('')

// 升级需要多少互动：按 +1/条 保守估算，用真实阈值算，不写死。
//
// 注意这里算的是"**从这一档的起点**升到下一档要多少条"，不是"从初始值出发"。
// 初始值 5 落在「平淡」中间，所以它不在任何一档的起点上 —— 单独在下面列出来，
// 免得出现"疏远→平淡 约 20 条（新认识从 5 起，还要 0 条）"这种自相矛盾的输出。
console.log(bar('─'))
console.log('升级需要多少互动（假设纯"嗯"这种 +1/条，从该档起点算）')
console.log(bar('─'))
console.log('')
const enterAt = (id) => sorted.find((s) => s.id === id)?.min
for (let i = 0; i < sorted.length - 1; i += 1) {
  const cur = sorted[i]
  const nxt = sorted[i + 1]
  const from = cur.min === -Infinity ? SCORE_MIN : cur.min
  const need = Math.max(0, nxt.min - from)
  console.log(`${cur.label} → ${nxt.label}`.padEnd(12) + `约 ${need} 条`)
}
console.log(`                                    实际有问候/关心会快很多`)
console.log('')
const initialStage = stageOf(INITIAL_SCORE)
const toCaring = Math.max(0, (enterAt('caring') ?? 0) - INITIAL_SCORE)
console.log(`新认识的人从 ${INITIAL_SCORE} 分起（= 「${initialStage.label}」档）：`)
console.log(`  到「在意」还要约 ${toCaring} 条；到「喜欢」还要约 ${Math.max(0, (enterAt('lover') ?? 0) - INITIAL_SCORE)} 条`)
console.log('  「疏远」不会是新人的起点 —— 那是聊坏了（辱骂/被当AI指认）或长期不互动衰减才会掉进去的地方。')
console.log('')
console.log('注意：只计算"有人跟她说话"，她自己发的不算。')
console.log('按人记，跨聊天共享：私聊的你和群里的你是同一个人。')
