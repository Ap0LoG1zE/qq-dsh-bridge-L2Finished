// 找出 bridge.js 里"被引用但从未声明"的局部变量（删功能时留下的悬空引用）。
// 用 vm 在一份最小桩里跑语法作用域检查不现实，这里用保守的启发式：
//   对每个形如 `xxxSessions.has/delete/get` 的标识符，检查是否有 const/let/var 声明。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '..', 'src', 'bridge.js'), 'utf8')

const suspects = new Set()
// 抓所有 "标识符." 的用法里，名字带这些后缀的（容易是集合/缓存，最可能被删声明）
const re = /\b([A-Za-z_$][\w$]*(?:Sessions|Collectors|Waiters|Windows|Entries|Writable|Store|Cache))\b/g
let m
while ((m = re.exec(src)) !== null) suspects.add(m[1])

const undeclared = []
for (const name of suspects) {
  const declaredRe = new RegExp(`(?:const|let|var|function)\\s+${name}\\b`)
  const paramRe = new RegExp(`\\([^)]*\\b${name}\\b[^)]*\\)`) // 作为参数传入
  if (!declaredRe.test(src) && !paramRe.test(src)) {
    const uses = (src.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length
    undeclared.push({ name, uses })
  }
}

if (undeclared.length === 0) {
  console.log('✅ 没有发现悬空引用')
} else {
  console.log('❌ 发现可能未声明就使用的标识符：')
  for (const u of undeclared.sort((a, b) => b.uses - a.uses)) {
    console.log(`   ${u.name}  使用 ${u.uses} 次`)
  }
  process.exitCode = 1
}
