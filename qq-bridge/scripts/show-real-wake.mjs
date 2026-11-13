// 抓真实唤醒包：从会话日志里找出最近一次投递的 user message（唤醒包正文），原样打印。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const SESS_DIR = 'C:/Users/Ap0/.dsh/sessions/--D-DSH-qq-dsh-bridge-qq-bridge-state-agents--'

// 找最新的会话目录
const dirs = fs.readdirSync(SESS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const f = path.join(SESS_DIR, d.name, 'session.v4.jsonl.zstd')
    let mtime = 0
    try { mtime = fs.statSync(f).mtimeMs } catch {}
    return { name: d.name, file: f, mtime }
  })
  .filter((d) => d.mtime > 0)
  .sort((a, b) => b.mtime - a.mtime)

if (!dirs.length) { console.log('没找到会话日志'); process.exit(0) }
const target = dirs[0]
console.log(`会话: ${target.name}`)
console.log(`更新: ${new Date(target.mtime).toLocaleString('zh-CN', { hour12: false })}`)
console.log('')

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const raw = fs.readFileSync(target.file)
const starts = []
let i = 0
while (true) {
  const j = raw.indexOf(MAGIC, i)
  if (j < 0) break
  starts.push(j)
  i = j + 4
}
const recs = []
for (let k = 0; k < starts.length; k += 1) {
  const a = starts[k]
  const b = k + 1 < starts.length ? starts[k + 1] : raw.length
  let txt
  try { txt = zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8') } catch { continue }
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue
    try { recs.push(JSON.parse(line)) } catch {}
  }
}
console.log(`解出 ${recs.length} 条记录\n`)

// 找最近的 user 消息（唤醒包）
const users = recs.filter((r) => {
  const c = r?.data?.message?.content
  return Array.isArray(c) && c.some((p) => p?.type === 'text')
    && (r.type === 'user/message' || r.type === 'message/user' || (r.data?.message?.role === 'user'))
})

if (!users.length) {
  // 退一步：找 agent/inbox/spliced 里带文本的
  const spliced = recs.filter((r) => r.type === 'agent/inbox/spliced')
  console.log(`没找到 user/message，改用 agent/inbox/spliced（${spliced.length} 条）`)
  const last = spliced[spliced.length - 1]
  if (last) {
    const txt = last.data?.inserted?.[0]?.content?.find((p) => p.type === 'text')?.text ?? ''
    console.log('════════ 最后一条注入 ════════\n')
    console.log(txt)
  }
  process.exit(0)
}

const last = users[users.length - 1]
const txt = last.data.message.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
const t = last.time ? new Date(last.time).toLocaleString('zh-CN', { hour12: false }) : '?'
console.log(`════════ 最近一次唤醒包（${t}）════════\n`)
console.log(txt)
