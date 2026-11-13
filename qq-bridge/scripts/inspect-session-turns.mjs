// 按**会话内部**的首末时间戳归类，而不是文件 mtime。
//
// 为什么必须这样：一个 02:00 开始的会话，如果一直聊到 16:27，
// 文件 mtime 只会显示 16:27 —— 按 mtime 找"两点那个会话"永远找不到。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const baseDir = path.join(os.homedir(), '.dsh', 'sessions', '--D-DSH-qq-dsh-bridge-qq-bridge-state-agents--');
const args = process.argv.slice(2);
const since = args.find((a) => a.startsWith('--since='))?.slice(8) || '';
const detailId = args.find((a) => a.startsWith('--id='))?.slice(5) || '';
const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) || 20);

function analyze(id) {
  const file = path.join(baseDir, id, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8'); } catch { return null; }
  let first = Infinity, last = 0;
  const turns = new Set();
  const calls = new Map();
  let userMsgs = 0;
  const userTexts = [];
  const selfReplies = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const t = Number(obj.time);
    if (Number.isFinite(t) && t > 0) {
      if (t < first) first = t;
      if (t > last) last = t;
    }
    if (obj.type === 'assistant/message') {
      const d = obj.data || {};
      if (d.turn != null) turns.add(d.turn);
      const content = d.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'tool-call' && c.name) calls.set(c.name, (calls.get(c.name) || 0) + 1);
          if (c?.type === 'text' && c.text) selfReplies.push(c.text);
        }
      }
    }
    if (obj.type === 'user/message') {
      const content = obj.data?.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'text' && c.text) { userMsgs += 1; userTexts.push(c.text); }
        }
      }
    }
  }
  return { id, first, last, turns: turns.size, calls, userMsgs, userTexts, selfReplies };
}

if (detailId) {
  const a = analyze(detailId);
  if (!a) { console.error('找不到'); process.exit(1); }
  console.log(`会话 ${a.id}`);
  console.log(`  内部起: ${new Date(a.first).toLocaleString()}`);
  console.log(`  内部止: ${new Date(a.last).toLocaleString()}`);
  console.log(`  轮数: ${a.turns}   用户消息: ${a.userMsgs}`);
  console.log('\n=== 工具调用 ===');
  if (!a.calls.size) console.log('  （一次都没调）');
  for (const [n, c] of [...a.calls.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${String(c).padStart(3)}  ${n}`);
  const hasPrompt = [...a.calls.keys()].some((n) => n.includes('get_prompt'));
  console.log(`\n调过 qq_get_prompt: ${hasPrompt ? '是' : '否 ← 关键'}`);
  process.exit(0);
}

const ids = fs.readdirSync(baseDir).filter((n) => n.startsWith('session-'));
let rows = ids.map(analyze).filter(Boolean);
if (since) {
  const cut = new Date(since).getTime();
  rows = rows.filter((r) => r.last >= cut);
}
rows.sort((a, b) => b.last - a.last);

console.log('会话 ID'.padEnd(44) + '轮'.padStart(4) + '用户消息'.padStart(9) + '  prompt  起始时间           结束时间');
for (const r of rows.slice(0, limit)) {
  const pc = [...r.calls.entries()].filter(([n]) => n.includes('get_prompt')).reduce((s, [, v]) => s + v, 0);
  console.log(
    `${r.id.padEnd(44)}${String(r.turns).padStart(4)}${String(r.userMsgs).padStart(9)}${String(pc).padStart(8)}` +
    `  ${new Date(r.first).toLocaleString().padEnd(20)}${new Date(r.last).toLocaleString()}`,
  );
}

// 找内部起始时间在某天 00:00~03:00 的会话
console.log('\n=== 起始时间落在 00:00~03:00 的会话 ===');
for (const r of rows) {
  const d = new Date(r.first);
  if (d.getHours() < 3) {
    const pc = [...r.calls.entries()].filter(([n]) => n.includes('get_prompt')).reduce((s, [, v]) => s + v, 0);
    console.log(`  ${r.id}  起 ${d.toLocaleString()}  ${r.turns} 轮  prompt调用=${pc}`);
  }
}
