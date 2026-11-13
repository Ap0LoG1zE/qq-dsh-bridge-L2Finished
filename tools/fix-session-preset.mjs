#!/usr/bin/env node
// 把「已存在会话」里冻结的系统提示，换成当前 preset 源文件里的正文。
//
// 【上一版的致命 bug】
// 直接把含真实换行的文本拼进 JSON 字符串里，导致一个事件被切成几十行，
// 每行都 JSON.parse 失败，DSH 报 "unparsable committed event"，整个会话打不开。
//
// 【本版做法】
//   1. 按帧解压 → 找到目标事件 → **JSON.parse 成对象**
//   2. 只改 data.message.content[i].text 字段
//   3. **JSON.stringify 序列化回去**（自动处理换行转义）
//   4. 自检：每帧写回前先 JSON.parse 验证；整文件写盘后再全量复查
//
// 用法（必须先关掉 DSH）：
//   node tools/fix-session-preset.mjs --key group:123456789 --preset qq-chat-readonly --dry
//   node tools/fix-session-preset.mjs --key group:123456789 --preset qq-chat-readonly --last
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', 'qq-bridge')
const STATE = path.join(ROOT, 'state')

const MARKER = 'You are a coding agent powered by the'
const ANCHOR = '群友只会在你调用发送工具后看到消息。'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes('--' + name)

const key = arg('key')
const preset = arg('preset')
const dry = flag('dry')
const onlyLast = flag('last')
const modelName = arg('model', 'deepseek-flash')
if (!key || !preset) {
  console.error('用法: node tools/fix-session-preset.mjs --key group:123456789 --preset qq-chat-readonly [--last] [--model xxx] [--dry]')
  process.exit(2)
}

// ── 读 preset 正文 ─────────────────────────────────────────────────────────
const presetFile = path.join(ROOT, 'dsh', 'agent-presets', preset, 'agent.cordis.yml')
if (!fs.existsSync(presetFile)) {
  console.error(`找不到 preset 源文件: ${presetFile}`)
  process.exit(2)
}
const presetLines = fs.readFileSync(presetFile, 'utf8').split('\n')
const headIdx = presetLines.findIndex((l) => /^\s*prefix: \|-/.test(l))
if (headIdx < 0) {
  console.error('preset 源文件里找不到 prefix 块')
  process.exit(2)
}
const baseIndent = (presetLines[headIdx].match(/^\s*/)[0].length) + 2
const body = []
for (let i = headIdx + 1; i < presetLines.length; i += 1) {
  const line = presetLines[i]
  if (line.trim() === '') { body.push(''); continue }
  if ((line.match(/^\s*/)[0].length) < baseIndent) break
  body.push(line.slice(baseIndent))
}
const newPrefix = body.join('\n').replace(/\{\{model\}\}/g, modelName).replace(/\r\n/g, '\n').trimEnd()

// ── 定位日志 ───────────────────────────────────────────────────────────────
const sessions = JSON.parse(fs.readFileSync(path.join(STATE, 'sessions.json'), 'utf8'))
const sessionId = sessions.sessions?.[key]
if (!sessionId) {
  console.error(`sessions.json 里没有 ${key}`)
  process.exit(2)
}
const sessionsRoot = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions')
let logFile = ''
for (const dir of fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : []) {
  const candidate = path.join(sessionsRoot, dir, sessionId, 'session.v4.jsonl.zstd')
  if (fs.existsSync(candidate)) { logFile = candidate; break }
}
if (!logFile) {
  console.error(`找不到会话日志，sessionId=${sessionId}`)
  process.exit(2)
}

// ── 切帧 ───────────────────────────────────────────────────────────────────
const raw = fs.readFileSync(logFile)
const starts = []
{
  let i = 0
  while (true) {
    const j = raw.indexOf(ZSTD_MAGIC, i)
    if (j < 0) break
    starts.push(j)
    i = j + 4
  }
}

function hasPromptZone(text) {
  const mi = text.indexOf(MARKER)
  if (mi < 0) return false
  return text.indexOf(ANCHOR, mi) >= 0
}

// 找出候选帧
const candidates = []
for (let k = 0; k < starts.length; k += 1) {
  const a = starts[k]
  const b = k + 1 < starts.length ? starts[k + 1] : raw.length
  let text
  try { text = zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8') } catch { continue }
  if (hasPromptZone(text)) candidates.push(k)
}
const targets = onlyLast ? new Set(candidates.slice(-1)) : new Set(candidates)

console.log(`日志: ${logFile}`)
console.log(`帧数: ${starts.length}  候选帧: ${candidates.length}  本次改: ${targets.size} 个`)
console.log(`模型名: ${modelName}`)
if (!targets.size) {
  console.error('没有候选帧，中止')
  process.exit(4)
}

// ── 逐帧重建 ───────────────────────────────────────────────────────────────
let touched = 0
const outParts = []

for (let k = 0; k < starts.length; k += 1) {
  const a = starts[k]
  const b = k + 1 < starts.length ? starts[k + 1] : raw.length

  if (!targets.has(k)) {
    outParts.push(raw.subarray(a, b))   // 原样写回，逐字节不变
    continue
  }

  let text
  try {
    text = zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8')
  } catch {
    outParts.push(raw.subarray(a, b))
    continue
  }

  const lines = text.split('\n').filter((l) => l.trim())
  const newLines = []
  let changed = false

  for (const line of lines) {
    let o
    try {
      o = JSON.parse(line)
    } catch {
      // 原本就坏的行，原样保留（不掩盖既有问题）
      newLines.push(line)
      continue
    }
    if (o && o.type === 'system/message') {
      const content = o.data?.message?.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && part.type === 'text' && typeof part.text === 'string') {
            const mi = part.text.indexOf(MARKER)
            const ai = mi >= 0 ? part.text.indexOf(ANCHOR, mi) : -1
            if (mi >= 0 && ai >= 0) {
              const end = ai + ANCHOR.length
              // 在字符串层面替换，转义交给下面的 JSON.stringify
              part.text = part.text.slice(0, mi) + newPrefix + part.text.slice(end)
              changed = true
            }
          }
        }
      }
    }
    // ★ JSON.stringify 会自动把内容里的换行转成 \n 两个字符
    newLines.push(JSON.stringify(o))
  }

  if (!changed) {
    outParts.push(raw.subarray(a, b))
    continue
  }

  // 自检 ①：每行序列化后必须能 parse 回来
  for (let i = 0; i < newLines.length; i += 1) {
    try {
      JSON.parse(newLines[i])
    } catch (e) {
      console.error(`❌ 帧#${k} 第 ${i + 1} 条序列化后无法解析：${e.message}`)
      process.exit(6)
    }
  }

  const rebuilt = newLines.join('\n') + '\n'
  outParts.push(zlib.zstdCompressSync(Buffer.from(rebuilt, 'utf8')))
  touched += 1
}

console.log(`重建的帧数: ${touched}`)
if (dry) {
  console.log('--dry：不写盘。')
  process.exit(0)
}

const outBuf = Buffer.concat(outParts)

// ── 自检 ②：全量逐帧解压 + 逐行 JSON.parse ─────────────────────────────────
{
  const chkStarts = []
  let i = 0
  while (true) {
    const j = outBuf.indexOf(ZSTD_MAGIC, i)
    if (j < 0) break
    chkStarts.push(j)
    i = j + 4
  }
  if (chkStarts.length !== starts.length) {
    console.error(`自检失败：原 ${starts.length} 帧，写回 ${chkStarts.length} 帧`)
    process.exit(5)
  }
  let bad = 0
  let newFound = 0
  const probe = newPrefix.slice(0, 40)
  for (let k = 0; k < chkStarts.length; k += 1) {
    const a = chkStarts[k]
    const b = k + 1 < chkStarts.length ? chkStarts[k + 1] : outBuf.length
    let text
    try { text = zlib.zstdDecompressSync(outBuf.subarray(a, b)).toString('utf8') } catch { bad += 1; continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { JSON.parse(line) } catch { bad += 1 }
    }
    if (targets.has(k) && text.includes(probe)) newFound += 1
  }
  if (bad > 0) {
    console.error(`自检失败：${bad} 行无法解析（拒绝写盘）`)
    process.exit(7)
  }
  if (newFound !== touched) {
    console.error(`自检失败：期望 ${touched} 帧含新正文，实得 ${newFound}`)
    process.exit(8)
  }
  console.log(`自检通过：${chkStarts.length} 帧全部可解析，${newFound} 帧已换新正文`)
}

// ── 备份 + 写盘 ────────────────────────────────────────────────────────────
const bak = logFile + '.bak-preset-' + Date.now()
fs.copyFileSync(logFile, bak)
fs.writeFileSync(logFile, outBuf)
console.log(`已备份: ${bak}`)
console.log(`已写入: ${logFile}（${raw.length} → ${outBuf.length} 字节）`)
