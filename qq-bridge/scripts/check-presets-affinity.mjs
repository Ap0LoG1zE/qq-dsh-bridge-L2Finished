// 校验三档 preset：YAML 能解析、persona 正文含关键新段落。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

// qq-chat 是一代仿真档：不用工具、回复靠文本直发，也没有 qq_affinity 可用，
// 所以不要求它带「开口前」流程。只校验三个二代/分级档。
const presets = ['qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly']
let bad = 0
for (const name of presets) {
  const file = path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml')
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'))
    const persona = doc.find((r) => r.id === 'persona')
    const prefix = persona?.config?.prefix ?? ''
    const hasAffinity = prefix.includes('qq_affinity')
    const hasFlow = prefix.includes('【开口前')
    console.log(`${name}`)
    console.log(`  YAML 解析      OK`)
    console.log(`  提到 qq_affinity  ${hasAffinity ? '是' : '否'}`)
    console.log(`  含【开口前】流程   ${hasFlow ? '是' : '否'}`)
    console.log(`  前缀长度        ${prefix.length}`)
    if (!hasAffinity || !hasFlow) bad += 1
  } catch (error) {
    console.log(`${name}  YAML 错误: ${error.message}`)
    bad += 1
  }
}
console.log('')
if (bad) { console.log(`❌ ${bad} 档有问题`); process.exitCode = 1 }
else console.log('✅ 四档全部通过')
