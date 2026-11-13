// 渲染 bootstrap 唤醒包的开头，检查引导句是否与共用会话一致。
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
  let d = 0
  let i = m.index + m[0].length - 1
  for (; i < src.length; i += 1) {
    if (src[i] === '{') d += 1
    else if (src[i] === '}') { d -= 1; if (d === 0) { i += 1; break } }
  }
  return src.slice(m.index, i)
}

const cfg = { ownerQQ: 10001, sessionSharing: { enabled: true, groups: { 'private:10001': 'group:20001' } } }
const canonicalV2Key = new Function(`${grab('canonicalV2Key')}; return canonicalV2Key`)()
const sharedOwnerKeyOf = new Function('canonicalV2Key', `${grab('sharedOwnerKeyOf')}; return sharedOwnerKeyOf`)(canonicalV2Key)
const shareGroupOf = new Function('cfg', 'canonicalV2Key', 'sharedOwnerKeyOf', `${grab('shareGroupOf')}; return shareGroupOf`)(cfg, canonicalV2Key, sharedOwnerKeyOf)
const chatLabelForV2 = new Function('cfg', 'canonicalV2Key', `${grab('chatLabelForV2')}; return chatLabelForV2`)(cfg, canonicalV2Key)

const key = 'group:20001'
const pool = shareGroupOf(key)
const joined = pool.length > 1
  ? pool.map((k) => chatLabelForV2(k)).join('、')
  : chatLabelForV2(key)

console.log('════════ 共用组 ════════')
console.log('  ' + pool.join('  +  '))
console.log('')
console.log('════════ 修改前的引导句 ════════')
console.log(`【引导】你已接入 QQ 会话 group:20001。`)
console.log(`你的文本输出不会自动发到 QQ，发言要调用 qq_send_message；`)
console.log(`处理完先收尾（qq_mark_read 或 qq_set_wake_config），否则会收到一条提醒。`)
console.log('')
console.log('════════ 修改后的引导句 ════════')
console.log(`【引导】你已接入 ${joined}。`)
console.log(`发言必须调 qq_send_message 并带上对应聊天的 key（文本输出不会自动发出去）；`)
console.log(`处理完记得收尾（qq_mark_read 或 qq_set_wake_config），否则会收到一条提醒。`)
