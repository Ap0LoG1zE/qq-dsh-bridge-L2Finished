// 好感度模块单测：档位、加分、衰减、渲染、以及"睦不该变热情"的边界。
//
// ⚠️ 本文件必须是**无 BOM 的 UTF-8**。踩过的坑：用 PowerShell 的
// `Set-Content -Encoding utf8` 回写过一次，它按 GBK 读进来再按 UTF-8 写出，
// 中文全变乱码且不可逆（168 个字符直接变成 U+FFFD）。要批量改文本请用
// node + fs.writeFileSync(..., 'utf8')，别用 PowerShell 的文本 cmdlet。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  STAGES, STAGE_HINTS, INITIAL_SCORE, stageOf, scoreForMessage,
  bumpAffinity, decayAffinity, renderAffinityLine, DECAY_DAYS, DECAY_AMOUNT, PENALTY_KEYWORDS, describeAffinity,
  SCORE_MIN, SCORE_MAX, BELOVED_OWNER_HINT,
} from '../src/affinity.js'

let pass = 0
const ok = (name) => { pass += 1; console.log(`✅ ${name}`) }

// 1. 六档阈值
assert.equal(stageOf(-5).id, 'distant')
assert.equal(stageOf(0).id, 'neutral')
assert.equal(stageOf(29).id, 'neutral')
assert.equal(stageOf(30).id, 'caring')
assert.equal(stageOf(89).id, 'caring')
assert.equal(stageOf(90).id, 'reliant')
assert.equal(stageOf(399).id, 'reliant')
assert.equal(stageOf(400).id, 'lover')
assert.equal(stageOf(999).id, 'lover')
assert.equal(stageOf(1000).id, 'beloved')
assert.equal(stageOf(SCORE_MAX).id, 'beloved')
ok('六档阈值正确（疏远/平淡/在意/依赖/喜欢/偏爱）')

// 1b. 关键回归：最高档门槛必须 <= 分数上限，否则那一档永远到不了
// （实测踩过：先加了 400 分档，但 bumpAffinity 里还写着 Math.min(200, ...)，
//   于是一直停在"依赖"，看起来像档位没生效）
const topMin = Math.max(...STAGES.map((s) => s.min).filter(Number.isFinite))
assert.ok(SCORE_MAX >= topMin, `分数上限 ${SCORE_MAX} 低于最高档门槛 ${topMin}，该档永远进不去`)
ok(`分数上限 ${SCORE_MAX} 覆盖最高档门槛 ${topMin}`)

// 1c. 一档一档往上撞，确认能真的走到喜欢
let climb = { score: INITIAL_SCORE, count: 0, lastAt: Date.now() }
for (let i = 0; i < 500; i += 1) climb = bumpAffinity(climb, 3)
assert.equal(climb.score, SCORE_MAX, `连续加分应封顶在 ${SCORE_MAX}，实际 ${climb.score}`)
assert.equal(stageOf(climb.score).id, 'beloved', '封顶时必须落在最高档（偏爱）')
ok(`连续互动可以真的走到喜欢（封顶 ${climb.score} 分）`)

// 2. 异常输入不炸
assert.equal(stageOf(NaN).id, 'neutral')
assert.equal(stageOf(undefined).id, 'neutral')
assert.equal(stageOf('abc').id, 'neutral')
ok('异常分数安全回退到平淡')

// 3. 初始值落在平淡
// 设计意图（2026-11-08 由操作者定）：初始分**保持 5**。
// 中途其实试过把它压到 -8（落在"疏远"），理由是"从冷漠到喜欢的第一级走不到"，
// 但那个改动被否了，理由是对的：
//   · 冷漠是**聊坏了**才会到的地方（辱骂、长期不互动衰减），不是陌生人的默认位置；
//   · 睦对陌生人是"没打算给"，不是"讨厌"，这份冷该由人格卡和 STAGE_HINTS 的语气表达，
//     不该靠一分一分往下压。
// 这条断言就是钉住"别再有人把它改回负数"。
assert.equal(stageOf(INITIAL_SCORE).id, 'neutral')
assert.equal(INITIAL_SCORE, 5, '初始分必须保持 5（操作者明确要求；改它请先确认）')
ok('初始值是平淡，且为 5 分（刚认识）')

// 3b. 疏远这一档仍然可达 —— 靠扣分与衰减，不靠初始值。
// 只要"辱骂能把她压到疏远"这件事成立，这一档就不是摆设。
let pushed = { score: INITIAL_SCORE, count: 0, lastAt: Date.now() }
for (let i = 0; i < 5; i += 1) pushed = bumpAffinity(pushed, -4)
assert.equal(stageOf(pushed.score).id, 'distant', '连续辱骂应能把她压到疏远档')
ok('疏远档可由扣分抵达（不是摆设）')

// 4. 普通消息加分
assert.equal(scoreForMessage({ text: '嗯', isSelf: false }), 1)
ok('普通消息 +1')

// 5. 自己发的不加分
assert.equal(scoreForMessage({ text: '你好', isSelf: true }), 0)
ok('自己发的消息不加分')

// 6. 关键词加分
assert.ok(scoreForMessage({ text: '谢谢你' }) > 1, '道谢应加分')
assert.ok(scoreForMessage({ text: '你还好吗' }) > scoreForMessage({ text: '谢谢你' }), '关心应比道谢分高')
ok('关键词加分生效（道谢 < 关心）')

// 7. 辱骂扣分
assert.ok(scoreForMessage({ text: '滚' }) < 0, '辱骂应扣分')
ok('辱骂扣分生效')

// 8. 主人权重略高
const normal = scoreForMessage({ text: '嗯', isOwner: false })
const owner = scoreForMessage({ text: '嗯', isOwner: true })
assert.ok(owner > normal, '主人说话权重应略高')
ok('主人权重略高')

// 9. 加分有上限，刷屏不能爆分
let rec = { score: INITIAL_SCORE, count: 0, lastAt: Date.now() }
for (let i = 0; i < 100; i += 1) rec = bumpAffinity(rec, 999)
assert.ok(rec.score <= SCORE_MAX, `分数必须有上限，实际 ${rec.score}`)
ok('加分有上限（刷屏不会爆分）')

// 10. 从平淡升到在意（这条固定的是「分数→档位」的换算，与初始值无关，
//     所以起点显式给 0，而不是拿 INITIAL_SCORE —— 后者现在是负数）
let r2 = { score: 0, count: 0, lastAt: Date.now() }
assert.equal(stageOf(r2.score).id, 'neutral')
for (let i = 0; i < 30; i += 1) r2 = bumpAffinity(r2, 1)
assert.equal(stageOf(r2.score).id, 'caring')
ok('积累 30 次互动由平淡升到在意')

// 11. 衰减：21 天内不掉
const now = Date.now()
const fresh = { score: 50, count: 10, lastAt: now - 5 * 86400000 }
assert.equal(decayAffinity(fresh, now).score, 50)
ok('21 天内不衰减')

// 12. 衰减：超过 21 天掉一档的量
const old = { score: 50, count: 10, lastAt: now - (DECAY_DAYS + 1) * 86400000 }
assert.equal(decayAffinity(old, now).score, 50 - DECAY_AMOUNT)
ok(`超过 ${DECAY_DAYS} 天衰减 ${DECAY_AMOUNT} 分`)

// 13. 衰减不会无限掉
const ancient = { score: 5, count: 10, lastAt: now - 3650 * 86400000 }
assert.ok(decayAffinity(ancient, now).score >= -20, '衰减有下限')
ok('衰减有下限（不会掉成无限负）')

// 14. 渲染包含档位中文名与对方称呼
const line = renderAffinityLine({ score: 50 }, '主人')
assert.ok(line.includes('在意'), `应含"在意"，实际：${line}`)
assert.ok(line.includes('主人'), '应含对方称呼')
ok('渲染输出含档位与称呼')

// 14b. 注入行必须够短（每轮都进上下文，长了会挤人格卡）
assert.ok(line.length < 60, `注入行过长（${line.length} 字符），应保持极简：${line}`)
ok(`注入行足够短（${line.length} 字符）`)

// 14c. describeAffinity 给工具的详细视图
// 2026-11-10 精简之后只保留：谁 + 档位、状态描述、互动次数。
const detail = describeAffinity({ score: 50, count: 12, lastAt: Date.now() - 2 * 86400000, createdAt: Date.now() - 30 * 86400000 }, '群友A', Date.now())
assert.ok(detail.includes('群友A'), '详细视图应含对方称呼')
assert.ok(detail.includes('在意'), '详细视图应含档位')
assert.ok(detail.includes('12'), '详细视图应含互动次数')
ok('describeAffinity 输出称呼/档位/次数')

// 14d. 精简后的硬约束：必须足够短，且**不许**再出现这些冗余字段。
// 操作者的原话是"全部都是输入给AI的文本，大大增加了上下文的负担"，
// 所以这里反过来钉死：这些词一旦回来就说明有人又把它加回去了。
assert.ok(detail.length < 120, `详细视图过长（${detail.length} 字符），应保持在 120 以内：${detail}`)
for (const banned of ['位置', '最近一次在', '认识 ', '分', '→']) {
  assert.ok(!detail.includes(banned), `详细视图里不该再有「${banned}」这类冗余字段：${detail}`)
}
// 只允许 3 行：称呼+档位 / 状态 / 次数
assert.equal(detail.split('\n').length, 3, `详细视图应为 3 行，实际 ${detail.split('\n').length} 行`)
ok(`详细视图已精简（${detail.length} 字符 / 3 行，无冗余字段）`)

// 14e. 从没聊过的人：一句话说清，不能长篇
const never = describeAffinity(null, '新来的')
assert.ok(never.includes('没聊过'), '没记录的人应说明"没聊过"')
assert.ok(never.length < 30, `"没聊过"的说明太长（${never.length} 字符）：${never}`)
ok('"没聊过"用一句话带过')

// 15. 关键：六档都必须"像睦"，不能是热情/撒娇
for (const s of STAGES) {
  const h = STAGE_HINTS[s.id]
  assert.ok(h && h.hint, `${s.id} 缺少提示`)
  for (const banned of ['撒娇', '元气', '活泼', '活力']) {
    assert.ok(!h.hint.includes(banned), `${s.id} 的提示出现了不符合睦的词：${banned}`)
  }
}
ok('六档提示都不含"撒娇/元气/活泼"（保持睦的底色）')

// 15b. 关键红线：提示是"状态描述"，不许出现行为指令
// （第一版写成"礼貌但保持距离、一条就够"，实测直接盖掉了人格卡）
const COMMAND_WORDS = ['一条就够', '最多发', '不要主动', '保持距离', '不主动抛', '回一两个字', '不许', '必须']
for (const s of STAGES) {
  const hint = STAGE_HINTS[s.id].hint
  for (const w of COMMAND_WORDS) {
    assert.ok(!hint.includes(w), `${s.id} 的提示出现行为指令"${w}"，会盖掉人格卡`)
  }
}
ok('六档提示都不含行为指令（只描述状态，不指挥行为）')

// 15c. 提示里不该再出现条数控制
for (const s of STAGES) {
  assert.ok(!Object.hasOwn(STAGE_HINTS[s.id], 'maxLines'), `${s.id} 仍带 maxLines，条数应由 persona 统一管`)
  assert.ok(!Object.hasOwn(STAGE_HINTS[s.id], 'allowSilence'), `${s.id} 仍带 allowSilence`)
}
ok('提示对象不再带 maxLines / allowSilence（交还 persona 管）')

// 15d. 渲染出来不能带条数（也不能带行为指令）
const rendered = renderAffinityLine({ score: 5 }, '主人')
assert.ok(!rendered.includes('最多发'), '渲染结果不应包含条数限制')
assert.ok(!rendered.includes('条消息'), '渲染结果不应包含条消息')
assert.ok(!rendered.includes('保持距离'), '渲染结果不应包含行为指令')
ok('渲染结果不含条数与行为指令')

// 16. 依赖档也不该是"吵闹"
assert.ok(STAGE_HINTS.reliant.hint.includes('安静'), '依赖档应保留安静的特质')
ok('依赖档仍是安静的依赖')

// 16b. 梯度必须真的是「从冷漠到喜欢」—— 这是 2026-11-08 的核心要求。
// 检查的不是文采，是**结构**：五档得各自站在不同的位置，不能有哪一档是空转的。
//   疏远必须冷（不给回应），喜欢必须"控制不住"，且两者不能互换措辞。
assert.ok(/没进|不在|不接|不打算/.test(STAGE_HINTS.distant.hint), '疏远档必须写出"冷"：他不在这人回应范围内')
assert.ok(/防线|控制不住|自己跑回来|想起/.test(STAGE_HINTS.lover.hint), '喜欢档必须写出"控制不住地想他"')
// 每档的 hint 必须互不相同（复制粘贴会让梯度塌成两档）
const hintTexts = STAGES.map((s) => STAGE_HINTS[s.id].hint)
assert.equal(new Set(hintTexts).size, STAGES.length, '有档位的提示文案重复了，梯度会塌')
ok('六档文案互不相同（没有复制粘贴塌档）')

// 16c. 每一档都得带上**它自己那一级的标记**，不能含糊带过。
// 最初想用"暖词计数比大小"，但那种写法会被措辞骗（"在意"档里同时出现
// "朋友"和"松"，反而比"依赖"档计数高）。所以改成钉每档的关键意象：
// 缺了哪个标记，就说明那一档没写出自己的位置。
const STAGE_MARKERS = {
  distant: ['不接'],            // 冷的核心是"不回应"，不是"烦"
  neutral: ['不当真'],          // 观察 = 听但不采信
  caring: ['记得'],             // 朋友 = 会记住他说过的事
  reliant: ['舍不得'],          // 依赖 = 舍不得结束
  lover: ['想起'],              // 喜欢 = 会想他
  beloved: ['只对他一个人'],     // 偏爱 = 独占 + 破例
}
for (const [id, markers] of Object.entries(STAGE_MARKERS)) {
  for (const m of markers) {
    assert.ok(
      STAGE_HINTS[id].hint.includes(m),
      `${id} 档缺少关键意象「${m}」，这一档会退化成和上一档一样的空话：${STAGE_HINTS[id].hint}`,
    )
  }
}
ok('六档各自带住自己的关键意象（不塌成同一档）')

// 16c-2. 冷漠档不许出现"亲近"的意象：它必须是这条线的起点
for (const warm of ['舍不得', '想起', '记得']) {
  assert.ok(
    !STAGE_HINTS.distant.hint.includes(warm),
    `疏远档出现了"${warm}"，冷漠被写暖了`,
  )
}
ok('疏远档没有被写暖（冷漠是梯度的真实起点）')

// 16d. 关系梯度**不进人格卡，进预设**（2026-11-08 操作者明确要求）。
//
// 为什么这条要钉死：好感度是"关系状态"，属于**预设**那一层（什么时候能开口、
// 跟这个人多近该怎么拿捏）；人格卡只管"你是谁、你怎么说话"。
// 把梯度写进人格卡会带来两个副作用：
//   ① 人格卡是每轮常驻注入，等于把关系策略缝进人设里，越写越像行为指令；
//   ② 一代没有 qq_affinity、也没有好感度，给一代注入这套梯度只会让她
//      莫名其妙地对人忽冷忽热。
const roleCard = readFileSync(new URL('../roles/角色A.md', import.meta.url), 'utf8')
assert.ok(!/关系梯度/.test(roleCard), '人格卡里不该有「关系梯度」小节，它属于预设')
assert.ok(!/疏远（冷漠）/.test(roleCard), '人格卡里不该写档位定义')
ok('人格卡里没有关系梯度（归预设管）')

// 16e. 但预设里必须有：六档齐全，且守住"不变热情"这条红线。
// 2026-11-10 精简后，预设不再逐档展开描述（那部分与工具返回的 STAGE_HINTS 重复），
// 改成一行「档名索引：疏远=冷漠 · 平淡=观察 · …」。所以这里查的是那行索引。
const presetSrc = readFileSync(
  new URL('../dsh/agent-presets/qq-chat-agent/agent.cordis.yml', import.meta.url), 'utf8')
assert.ok(/【开口前/.test(presetSrc), '预设里应有【开口前】流程')
for (const pair of ['疏远=冷漠', '平淡=观察', '在意=朋友', '依赖=舍不得', '喜欢=想', '偏爱=只对他一个人这样']) {
  assert.ok(presetSrc.includes(pair), `预设的档名索引里缺少「${pair}」`)
}
assert.ok(/防线更少|防线少一层/.test(presetSrc), '预设里应写明"往上走是防线更少，不是变热情"')
// 精简的红线：预设里**不该**再逐档展开那五段长描述（它们归工具返回管）。
// 只要有一档的长描述回来了，就说明有人又把重复内容抄了回去。
const verboseStageMarkers = [
  '他还没进你要回应的范围。他说什么你听得见',
  '你会回，但只回这件事本身。不接话头',
  '结束对话这件事开始有点难。你不会说，只是不说话也不走',
  '安静下来就会想起他，他说过的话会自己跑回来，反复过一遍，哪怕当时没接上',
]
for (const v of verboseStageMarkers) {
  assert.ok(!presetSrc.includes(v), `预设里又出现了逐档的长描述（与工具返回重复）：${v.slice(0, 20)}…`)
}
// 热词只许出现在否定语境里
const NEG_RE = /不|绝不|别|非|没有/
for (const banned of ['撒娇', '元气', '活泼', '话痨']) {
  const badLines = presetSrc.split('\n').filter((l) => l.includes(banned) && !NEG_RE.test(l))
  assert.equal(badLines.length, 0, `预设里把"${banned}"写成正面描述了：${badLines.join(' / ')}`)
}
ok('预设含六档索引，且不再重复工具里的长描述')

// 16f. 预设里的档名意象必须和 affinity.js 对得上：
// 两边各写各的，就会出现"工具说冷淡、预设说热情"的自相矛盾。
// 精简后预设用的是索引形式「疏远=冷漠」，所以这里也按 `=` 查。
const PRESET_MARKERS = { distant: '冷漠', neutral: '观察', caring: '朋友', reliant: '舍不得', lover: '想', beloved: '只对他一个人这样' }
const labelOf = Object.fromEntries(STAGES.map((s) => [s.id, s.label]))
for (const [id, marker] of Object.entries(PRESET_MARKERS)) {
  assert.ok(
    presetSrc.includes(`${labelOf[id]}=${marker}`),
    `${id} 档在预设索引里应写成「${labelOf[id]}=${marker}」—— 与 affinity.js 的意象对齐`,
  )
}
ok('预设与 affinity.js 的档位意象一致（不会自相矛盾）')

// 17b. 指认 AI 的语义方向：必须是"被指认"才扣分（不是"她否认自己是AI"）
const agentPenalty = PENALTY_KEYWORDS.find((k) => k.why.includes('AI'))
assert.ok(agentPenalty, '应存在"被指认成AI"的扣分规则')
assert.ok(agentPenalty.add < 0, '被指认成 AI 应扣分')
assert.ok(!agentPenalty.why.includes('否认'), 'why 不应写成"否认"（语义相反）')
ok('指认 AI 的扣分规则语义正确（是被指认，不是否认）')

// 18. 不改原对象
const orig = { score: 10, count: 1, lastAt: now }
const after = bumpAffinity(orig, 5)
assert.equal(orig.score, 10, 'bumpAffinity 不应修改原对象')
assert.equal(after.score, 15)
ok('bumpAffinity 不改原对象（纯函数）')

// 19. 关键回归：好感度**全局按 QQ 号存**，不再挂在会话上（2026-11-10 架构变更）。
//
// 历史：最早的 bug 是"群里 9 分、私聊 7 分"（各存一份，靠写回所有聊天来对齐）；
// 后来改成写回组内所有聊天，分裂问题解决了，但**新问题**出现了 ——
// 数据仍在 conversations[key].affinities 下，于是「清除上下文」「重置二代状态」
// 会把 18 个人的关系一起删掉（实际发生过）。
// 现在改成 socialV2.affinities 顶层全局一份，与会话生命周期彻底解耦。
const bridgeSrc = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8')
assert.ok(
  /affinities:\s*\{\}/.test(bridgeSrc) && bridgeSrc.includes('affinityStageChanges: {}'),
  '差评：socialV2 顶层缺少 affinities / affinityStageChanges 容器',
)
// 计分时必须是读全局表，而不是 st.affinities
assert.ok(
  /socialV2\.affinities\[uid\] = next/.test(bridgeSrc),
  '差评：计分没有写入全局表 socialV2.affinities',
)
assert.ok(
  !/st\.affinities\[uid\] = next/.test(bridgeSrc),
  '差评：仍在往会话内写好感度（会被清除上下文一起删掉）',
)
// 落盘必须在顶层 obj 上，且会话内不再写 affinities
assert.ok(
  /obj\.affinities = \(\(\) => \{/.test(bridgeSrc),
  '差评：saveSocialV2State 没有把好感度写到顶层',
)
assert.ok(
  /obj\.affinityStageChanges = \(\(\) => \{/.test(bridgeSrc),
  '差评：saveSocialV2State 没有把档位变化写到顶层',
)
// 加载时要能把旧的会话内数据迁移进来（否则升级一次数据就丢）
assert.ok(
  bridgeSrc.includes('从会话迁移'),
  '差评：加载时缺少「把会话内旧数据迁移到全局」的逻辑，升级会丢数据',
)
ok('好感度全局存储（与会话生命周期解耦，且能迁移旧数据）')

// 20. 关键回归：分数上限**不许在任何地方写死**
// 实测 bug：affinity.js 改了 SCORE_MAX，但滑条/接口上限没跟着改，
// 但 POST /api/socialV2/affinity 那一行还写着 `Math.min(200, …)` ——
// 于是控制台拖到 500 一保存就弹回 200，看起来像"存不住"。
// 这类 bug 的特点是**没人报错**，只是数字悄悄被夹掉，所以必须在源码层面钉死。
const affinitySrc = readFileSync(new URL('../src/affinity.js', import.meta.url), 'utf8')
const bridgeSrc2 = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8')
const consoleSrc = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8')

// bridge.js 里所有和好感度相关的 Math.min(数字) 都必须用常量
const hardcodedInBridge = [...bridgeSrc2.matchAll(/Math\.min\(\s*(\d{2,4})\s*,\s*Math\.round\(rawScore\)/g)]
assert.equal(
  hardcodedInBridge.length, 0,
  `bridge.js 里仍有写死的分数上限：${hardcodedInBridge.map((m) => m[1]).join(', ')}，` +
  '必须改用 AFFINITY_SCORE_MAX',
)
ok('bridge.js 不再写死好感度上限（必须用 SCORE_MAX）')

// affinity.js 内部也不许再出现旧的 200 硬编码
assert.ok(
  !/Math\.min\(\s*200\s*,/.test(affinitySrc),
  'affinity.js 里仍有 Math.min(200, …)，应改用 SCORE_MAX',
)
ok('affinity.js 里没有残留的 200 上限')

// 前端滑条上限必须 >= 最高档门槛
const rangeMax = /id="affRange"[^>]*max="(\d+)"/.exec(consoleSrc)?.[1]
assert.ok(rangeMax, '找不到 affRange 的 max 属性')
assert.ok(
  Number(rangeMax) >= SCORE_MAX - 1,
  `滑条上限 ${rangeMax} 低于 SCORE_MAX ${SCORE_MAX}，最高档拖不到`,
)
ok(`滑条上限 ${rangeMax} 覆盖分数上限 ${SCORE_MAX}`)

// 前端写死的 AFF_SCORE_MAX 也必须和后端一致
const feMax = /const AFF_SCORE_MAX = (\d+);/.exec(consoleSrc)?.[1]
assert.ok(feMax, '找不到 AFF_SCORE_MAX 常量')
assert.equal(Number(feMax), SCORE_MAX, `前端 AFF_SCORE_MAX=${feMax} 与后端 SCORE_MAX=${SCORE_MAX} 不一致`)
ok(`前后端分数上限一致（都是 ${SCORE_MAX}）`)

// 21. 控制台的档位说明必须和 affinity.js 同源（五档、同一套名字）
// 面板里那份 AFF_STAGE_META 是独立维护的副本，最容易在这里漂：
// 后端加了「喜欢」档，面板却还画着四档 —— 操作者就永远点不到那一档。
for (const s of STAGES) {
  assert.ok(
    consoleSrc.includes(`label: '${s.label}'`),
    `控制台面板缺少档位「${s.label}」，面板与 affinity.js 不同步`,
  )
}
for (const id of ['distant', 'neutral', 'caring', 'reliant', 'lover', 'beloved']) {
  assert.ok(
    consoleSrc.includes(`data-aff-stage="${id}"`),
    `控制台缺少「跳到 ${id}」按钮，这一档在界面上不可达`,
  )
}
ok('控制台的档位卡片与跳档按钮覆盖全部六档')

// 21b. 【真实踩过的漏测】每一档都必须有**完整的 CSS 配色**，缺一个就是界面上一段空白。
// 2026-11-11 加「偏爱」档时只补了 JS 常量、没补 CSS，结果：
//   刻度尺偏爱那一段没颜色、徽章没底色、卡片进度条是空的 —— 操作者一眼就看出来了，
//   但所有单元测试都是绿的，因为没人检查样式。
// 所以这里按 affinity.js 的 STAGES 逐档核对那 5 处 CSS 选择器。
for (const s of STAGES) {
  const sel = [
    `.aff-scale-seg.s-${s.id}`,       // 刻度尺段
    `.aff-stage-badge.s-${s.id}`,     // 徽章
    `.aff-avatar.s-${s.id}`,          // 头像
    `.aff-card-bar i.s-${s.id}`,      // 卡片进度条
  ];
  for (const one of sel) {
    assert.ok(consoleSrc.includes(one), `控制台缺少样式 ${one} —— 该档在界面上会没有颜色`);
  }
  // 暗色主题的徽章也要有，否则切到深色时那一档看不到
  assert.ok(
    consoleSrc.includes(`[data-theme="dark"] .aff-stage-badge.s-${s.id}`),
    `控制台缺少暗色徽章样式 s-${s.id}`,
  );
}
ok('六档在控制台都有完整配色（刻度尺/徽章/头像/进度条/暗色）')

// 21c. fixture 的档位表必须和 affinity.js 同步：
//   少一档 → 预览页刻度尺少画一段（这正是上面那个 bug 的放大版）。
const fixtureSrc = readFileSync(new URL('./console-ui-fixture.mjs', import.meta.url), 'utf8')
for (const s of STAGES) {
  assert.ok(
    fixtureSrc.includes(`id: '${s.id}', label: '${s.label}'`),
    `console-ui-fixture 缺少档位 ${s.id}/${s.label}，预览页刻度尺会少一段`,
  )
}
ok('预览 fixture 与 affinity.js 六档同步')

// 22. 「按需查 + 档位变化提醒」这套机制（2026-11-10 操作者要求）。
// 这是本轮改动的核心，三条都要钉住：
//   ① 预设里不许再有"每轮必查"这种硬性要求（那正是要拿掉的东西）；
//   ② 预设里必须说明"什么时候必须查 / 什么时候不用查"；
//   ③ bridge 必须真的实现：写档位变化、注入唤醒词、查过之后清掉。
console.log('\n=== 按需查 + 档位变化提醒 ===')
assert.ok(!presetSrc.includes('每轮必做'), '预设里不该再有「每轮必做」这种硬性要求')
assert.ok(!presetSrc.includes('回复前必查好感度'), '预设里不该再有「回复前必查好感度」的旧标题')
assert.ok(presetSrc.includes('不必') || presetSrc.includes('不用') || presetSrc.includes('不必重复查'), '预设里应说明查过之后不必重复查')
// 措辞按操作者要求：用「发生以下三种情况的时候查」（2026-11-12 从两种加到三种，
// 新增「拿不准怎么回」）。不再用"什么时候必须查/不用查"那种啰嗦说法。
// 2026-11-12：操作者观察到她会在没查过对方好感度的情况下直接说话，
// 所以「没查过这个人」不再是三个并列条件之一，而是**硬性前置**（不查不许开口）。
assert.ok(presetSrc.includes('硬性前置'), '预设应把「没查过这个人」写成硬性前置')
assert.ok(presetSrc.includes('从没查过'), '预设应说清"从没查过这个人"这一种情况')
assert.ok(presetSrc.includes('发生了变化'), '预设应提到唤醒词里的「好感度发生了变化」提示')
// 第三种：拿不准的时候也查（2026-11-12 新增，且要和"从没查过"一样加粗）
assert.ok(
  presetSrc.includes('你**拿不准怎么回**的时候'),
  '预设应包含「你**拿不准怎么回**的时候」，且按操作者要求加粗',
)
// 0.5 条压缩后只做"总则 + 指路"，不该再把三种情况列一遍（那是【开口前】的职责）
const zeroFiveLine = presetSrc.split('\n').find((l) => l.trim().startsWith('0.5 ')) || ''
assert.ok(!zeroFiveLine.includes('发生以下'), '0.5 条不该重复列条件，应交给【开口前】')
assert.ok(zeroFiveLine.includes('【开口前'), '0.5 条应指向【开口前】')
assert.ok(zeroFiveLine.includes('没查过'), '0.5 条应点明「没查过这个人就先查」这个硬性要求')
// 反例：这些是操作者明确嫌"太啰嗦"的旧措辞，不许回来。
assert.ok(!presetSrc.includes('第一次要回'), '「第一次要回」表述不清，已按操作者要求替换')
assert.ok(!presetSrc.includes('从「X」变成了「Y」'), '唤醒提示里不该再剧透"从哪档到哪档"')
ok('预设已改成按需查询（措辞按操作者要求）')

// bridge 侧：写入 / 注入 / 清除，三处缺一不可
assert.ok(
  bridgeSrc2.includes('affinityStageChanges'),
  'bridge.js 里没有 affinityStageChanges，档位变化根本记不下来',
)
assert.ok(
  /prevStageId !== nextStageId/.test(bridgeSrc2),
  'bridge.js 应按「档位 id 是否变化」判断，而不是按分数变化',
)
assert.ok(
  bridgeSrc2.includes('buildAffinityStageChangeLineV2'),
  'bridge.js 缺少把档位变化注入唤醒词的函数',
)
assert.ok(
  // 2026-11-13：改成 wantUserResolved（支持按名字查后，要清的是解析出来的号码）
  /delete socialV2\.affinityStageChanges\[wantUserResolved\]/.test(bridgeSrc2),
  '她查过之后必须清掉提醒，否则每轮都会重复提示',
)
// 只有在档位真的变了时才记：同一档里涨分不该触发
const stageOfA = stageOf(10).id
const stageOfB = stageOf(25).id
assert.equal(stageOfA, stageOfB, '同档内涨分不应算档位变化（当前实现应满足）')
// 关键回归（2026-11-12 操作者报告）：**手工调整也要记档位变化**。
// 现象：把「7月1」拖到 400（进入喜欢档）并保存，唤醒词没有提示。
// 根因：affinityStageChanges 只在"聊天计分"（addUnread → bumpAffinity）里写，
//   POST /api/socialV2/affinity（控制台拖滑条）只写分数，不写变化记录。
// 这个 bug 的特点是"没有任何报错"——数据看着是对的，只是提醒永远不触发。
{
  // 定位手工调整那个端点里的写入块。
  // ⚠️ GET 和 POST 共用同一个 pathname 字符串，直接 indexOf 会命中 GET 那处 —— 必须带上 method 判断。
  const needle = "url.pathname === '/api/socialV2/affinity'"
  let postIdx = -1
  let from = 0
  while (true) {
    const i = bridgeSrc2.indexOf(needle, from)
    if (i < 0) break
    const head = bridgeSrc2.slice(Math.max(0, i - 40), i)
    if (head.includes("'POST'")) { postIdx = i; break }
    from = i + 1
  }
  assert.ok(postIdx > 0, '找不到 POST /api/socialV2/affinity 端点')
  const region = bridgeSrc2.slice(postIdx, postIdx + 5000)
  assert.ok(
    region.includes('socialV2.affinityStageChanges[wantUser] ='),
    '手工调整好感度时必须同时写入 affinityStageChanges，否则拖滑条进新档位不会提醒'
  )
  assert.ok(
    region.includes('prevStageId') && region.includes('nextStageId'),
    '手工调整应按「档位 id 是否变化」判断，不能在每次保存时都记一条'
  )
}
ok('手工调整好感度也会记录档位变化（拖滑条进新档位能触发唤醒提示）')

// 关键回归（2026-11-13）：qq_affinity 单人查询必须读 data.text。
// 桥接在传 userId 时返回的是单人结构（没有 people 数组）；
// 工具若仍去读 data.people，就会恒空并返回"这个会话里还没有认识的人"——
// 她于是以为"不认识这个人"。这个 bug 不报错、ok 也是 true。
{
  const mcpSrc = readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
  // 必须先判 userId 并读 text
  assert.ok(
    /if \(userId\) \{[\s\S]{0,300}?data\?\.text/.test(mcpSrc),
    'qq_affinity 在传 userId 时必须优先使用桥接返回的 data.text（单人结构里没有 people）',
  )
  // 且这段要出现在读 data.people 之前
  const textIdx = mcpSrc.indexOf('const single = String(data?.text')
  const peopleIdx = mcpSrc.indexOf('const rows = Array.isArray(data?.people)')
  assert.ok(textIdx > 0 && peopleIdx > 0 && textIdx < peopleIdx,
    '单人分支必须写在 people 列表逻辑之前，否则永远读不到')
}
// 回归（2026-11-13）：偏爱档文案两处一致性 + 那句限制性文案不许回来。
// 操作者原话：「只是话仍然不多，说得也不花哨，常常一句话就脸红着别开脸」
//   影响她的发挥 —— 前面刚允许"可以主动"，这句立刻把落点改回"所以她还是会收着"。
{
  const htmlSrc = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8')
  const m = htmlSrc.match(/ownerDesc:\s*'([^']*)'/)
  assert.ok(m, '控制台缺少 ownerDesc（偏爱档"仅对主人"的说明）')
  const consoleDesc = m[1]

  // ① 限制性文案不许在任一处出现
  for (const banned of ['话仍然不多', '不花哨', '脸红着别开脸']) {
    assert.ok(!BELOVED_OWNER_HINT.includes(banned), `affinity.js 里不该再有「${banned}」——它会拉低她的发挥`)
    assert.ok(!consoleDesc.includes(banned), `控制台里不该再有「${banned}」`)
  }

  // ② 该留的害羞必须在两处都在
  for (const keep of ['……说什么呢', '赖着不走', '自己接回去']) {
    assert.ok(BELOVED_OWNER_HINT.includes(keep), `affinity.js 应保留「${keep}」（操作者明确喜欢这段害羞）`)
    assert.ok(consoleDesc.includes(keep), `控制台应保留「${keep}」，否则和模型实际拿到的不一致`)
  }

  // ③ "可以主动" 这条允许必须还在（删限制句不能连允许一起删了）
  assert.ok(BELOVED_OWNER_HINT.includes('可以主动'), '应保留"也可以主动"这条允许')
}
// 回归（2026-11-13）：qq_set_voice 的权限口径必须与预设文案一致。
// 事件经过：预设写的是「只有主人能开关」，但桥接最初只校验开、关谁都可以。
//   操作者选择桥接对齐文案（不是改文案），所以这里钉死开关都要校验主人。
//   两边再漂的话，她信预设去关闭 -> 403 -> 她会以为自己坏了。
{
  const bridgeSrc3 = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8')
  const mcpSrc3 = readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
  const presetSrc3 = readFileSync(new URL('../dsh/agent-presets/qq-chat-agent/agent.cordis.yml', import.meta.url), 'utf8')

  // 桥接：权限判断不能再带 want &&（那等于只有开要主人）
  assert.ok(
    /if \(!talkingToOwner\)/.test(bridgeSrc3),
    '桥接应校验开关都要主人（if (!talkingToOwner)），不能只校验开启',
  )
  // 只在**代码行**里查旧写法 —— 注释里提到「想恢复就改回 xxx」是正常的说明文字。
  const codeLines3 = bridgeSrc3.split('\n').filter((l) => !l.trim().startsWith('//'))
  assert.ok(
    !codeLines3.some((l) => l.includes('want && !talkingToOwner')),
    '代码里不该再有 want && !talkingToOwner（注释里说明可以）',
  )
  // 工具描述别自相矛盾
  assert.ok(
    mcpSrc3.includes('开关都只有主人能'),
    'qq_set_voice 的工具描述应写开关都只有主人能动，和预设一致',
  )
  // 预设里也是这个说法
  assert.ok(
    presetSrc3.includes('只有主人能开关'),
    '预设应写「只有主人能开关」，和桥接一致',
  )
}
// 回归（2026-11-13）：qq_affinity 必须支持**按名字**查。
// 事件经过：她调 qq_affinity(userId="彤雲") —— 传的是人名，桥接把它当 QQ 号查，
//   返回「彤雲：没聊过」，她就以为不认识这个人。实测：传名字→没聊过，传号码→依赖。
// 修法：桥接在 userId 不是纯数字时，去 socialV2.aliases 里按名字反查。
{
  const bridgeSrc4 = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8')
  assert.ok(
    bridgeSrc4.includes('wantUserResolved'),
    '桥接应把 userId 解析成 wantUserResolved（支持名字反查）',
  )
  assert.ok(
    /!\/\^\\d\{1,20\}\$\/\.test\(wantUser\)/.test(bridgeSrc4),
    '桥接应在 userId 不是纯数字时走名字反查分支',
  )
  assert.ok(
    bridgeSrc4.includes('affinityStageChanges?.[wantUserResolved]'),
    '清除档位提醒时要用解析后的号码，否则按名字查不会清掉提醒',
  )
  // 重名不能瞎猜
  assert.ok(
    bridgeSrc4.includes("stage: 'ambiguous'"),
    '名字对上多个人时应返回候选让模型自己挑，不能随便选一个',
  )
  // 工具描述也要说清楚可以传名字
  const mcpSrc4 = readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
  assert.ok(
    mcpSrc4.includes('QQ 号或名字都行'),
    'qq_affinity 的 userId 参数描述应写明名字也可以',
  )
}
// 回归（2026-11-15）：删除表情后必须走 HTTP 同步。
// 事件：面板显示删不掉，实际 QQ 已删（7->6）；WS 侧列表不跟随删除刷新。
{
  const bs = readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8')
  const ls = bs.split('\n')
  assert.ok(
    bs.includes('{ preferHttp = false }'),
    'syncStickerLibrary 应支持 preferHttp 选项',
  )
  // 删除端点必须用它
  const delLine = ls.findIndex((l) => l.includes("/api/stickers/delete"))
  assert.ok(delLine > 0, '找不到删除表情端点')
  const delBlock = ls.slice(delLine, delLine + 40).join('\n')
  assert.ok(
    delBlock.includes('preferHttp: true'),
    '删除表情后必须用 preferHttp 重新同步，否则 WS 的旧列表会让界面永远显示删不掉',
  )
  // 其它端点不该用（避免无谓地绕过更快的 WS）
  const preferCount = (bs.match(/preferHttp: true/g) || []).length
  assert.equal(preferCount, 1, 'preferHttp: true 只应出现在删除端点一处，实际 ' + preferCount + ' 处')
}
ok('删除表情后用 HTTP 重新同步（WS 列表不跟随删除）')
ok('qq_affinity 支持按名字查（不再误报"没聊过"）')
ok('qq_set_voice 权限：开关都要主人，桥接/工具/预设三处口径一致')
ok('偏爱档文案：限制句已清、害羞保留、控制台与源码一致')

ok('qq_affinity 单人查询读 data.text（不再误报"不认识"）')

ok('bridge 侧：记录 / 注入 / 清除 三处齐全')

console.log(`\n好感度测试通过：${pass} 项`)
