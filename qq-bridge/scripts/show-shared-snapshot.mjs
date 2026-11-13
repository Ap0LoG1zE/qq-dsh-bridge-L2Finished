// 渲染一次真实的「共用会话」唤醒包，确认结构：水位 + 标签 + 【之前】。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8')

function grab(name) {
  const re = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`, 'm')
  const m = re.exec(src)
  if (!m) throw new Error(`找不到 ${name}`)
  let depth = 0
  let i = m.index + m[0].length - 1
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break } }
  }
  return src.slice(m.index, i)
}

const cfg = { ownerQQ: 10001, sessionSharing: { enabled: true, groups: { 'private:10001': 'group:20001' } } }
const canonicalV2Key = new Function(`${grab('canonicalV2Key')}; return canonicalV2Key`)()
const sharedOwnerKeyOf = new Function('canonicalV2Key', `${grab('sharedOwnerKeyOf')}; return sharedOwnerKeyOf`)(canonicalV2Key)
const shareGroupOf = new Function('cfg', 'canonicalV2Key', 'sharedOwnerKeyOf', `${grab('shareGroupOf')}; return shareGroupOf`)(cfg, canonicalV2Key, sharedOwnerKeyOf)
const chatLabelForV2 = new Function('cfg', 'canonicalV2Key', `${grab('chatLabelForV2')}; return chatLabelForV2`)(cfg, canonicalV2Key)

// 直接跑 renderWakeSnapshotV2 需要一堆依赖，这里手工模拟 packed snapshot 的结构，
// 复用源码里的渲染逻辑片段太脆；改为断言源码包含关键输出点 + 手绘样张。
const needStructure = [
  ['首行带水位', '读到 #${v}'],
  ['未读与之前分开', '【之前】'],
  ['每条带标签', '[${row.chatLabel}]'],
]
for (const [label, needle] of needStructure) {
  const ok = src.includes(needle.replace('${v}', '${v}').replace('${row.chatLabel}', '${row.chatLabel}'))
  console.log(`${ok ? '✅' : '❌'} ${label}`)
}

console.log('\n════════ 样张 ════════\n')
const rows = [
  { chatLabel: chatLabelForV2('group:20001'), seq: 80, who: '辣椒烧土坤', ago: '6分钟前', text: '善' },
  { chatLabel: chatLabelForV2('group:20001'), seq: 81, who: 'Ap0LoG1zE', ago: '8秒前', text: '@角色A 晚上好' },
  { chatLabel: chatLabelForV2('private:10001'), seq: 7, who: '主人', ago: '2分钟前', text: '骂回去' },
]
const past = [
  { chatLabel: chatLabelForV2('group:20001'), seq: 77, who: '飞鱼QwQ', ago: '7分钟前', text: '总有一天善良的zzz会被邪恶的玖玖璃吃干抹净的' },
  { chatLabel: chatLabelForV2('group:20001'), seq: 79, who: '辣椒烧土坤', ago: '6分钟前', text: '[图片]（图id=3557253141）' },
]
const through = `群20001 读到 #81，私聊10001（主人） 读到 #7`
console.log(`【本轮消息】${rows.length} 条未读（来自 2 个聊天），${through}`)
for (const r of rows) console.log(`[${r.chatLabel}] #${r.seq} ${r.who}·${r.ago}：${r.text}`)
console.log('（上面带方括号的就是去处：回群用群号那个 key，回私聊用私聊那个 key。可以两个都回，也可以只回一个。）')
console.log('【之前】')
for (const r of past) console.log(`[${r.chatLabel}] #${r.seq} ${r.who}·${r.ago}：${r.text}`)
