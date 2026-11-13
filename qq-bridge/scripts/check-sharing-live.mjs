// 用真实 config.json 验证共用会话的 key 归一：两个 QQ key 是否落到同一个归属。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))

function grab(name) {
  const re = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`, 'm')
  const m = re.exec(src)
  if (!m) throw new Error(`找不到函数 ${name}`)
  let depth = 0
  let i = m.index + m[0].length - 1
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break } }
  }
  return src.slice(m.index, i)
}

const canonicalV2Key = new Function(`${grab('canonicalV2Key')}; return canonicalV2Key`)()
const sharedOwnerKeyOf = new Function('canonicalV2Key', `${grab('sharedOwnerKeyOf')}; return sharedOwnerKeyOf`)(canonicalV2Key)

console.log('config.sessionSharing =', JSON.stringify(cfg.sessionSharing))
console.log('')
const keys = ['private:10001', 'group:20001', 'group:999999', 'private:123456']
const owners = new Map()
for (const k of keys) {
  const o = sharedOwnerKeyOf(cfg, k)
  owners.set(k, o)
  console.log(`${k.padEnd(22)} → 归属 ${o}`)
}

console.log('')
const shared = owners.get('private:10001') === owners.get('group:20001')
console.log(shared
  ? '✅ 私聊与群归一到同一份记忆/会话（共用生效）'
  : '❌ 私聊与群没有归一，共用未生效')
console.log(owners.get('group:999999') === 'group:999999'
  ? '✅ 组外的群不受影响'
  : '❌ 组外的群被误归一')
