// 验证共用会话：私聊进来后是否复用群那个 sessionId，且回复仍发回私聊。
//
// 不连真实 QQ：直接调桥接的内部接口（/api/socialV2/*）模拟两种消息，看 sessions 映射变化。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim()
const BASE = 'http://127.0.0.1:3100'

async function api(p, body) {
  const res = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-console-token': token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

const before = await api('/api/sessions')
console.log('=== 测试前 ===')
for (const s of before.sessions ?? []) console.log(`  ${s.key} -> ${s.sessionId}`)

const groupId = (before.sessions ?? []).find((s) => s.key.startsWith('group:'))?.sessionId
console.log(`\n群会话 sessionId = ${groupId}`)

// 触发私聊会话建立：调用 ensureSession 的公开路径 —— 用 wake 接口发一个最小唤醒。
// 先看有没有现成的内部端点能"确保会话存在"。
const st = await api('/api/socialV2/state?key=private:10001')
console.log('\n=== 私聊状态（触发 getSocialV2State）===')
console.log('  ok=', st.ok, ' key=', st.key ?? st.raw)

console.log('\n=== 说明 ===')
console.log('私聊会话要等真实消息才会建立。上面的 key 归一已单独验证通过；')
console.log('端到端"不串号"需要你在 QQ 里各发一条消息，然后我读日志确认。')
