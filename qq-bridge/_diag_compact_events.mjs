// 查 DSH 原生压缩是否真的被触发过（应被 thresholdRatio 0.95 挡住）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const SID = 'session-4996b486-1146-4843-84c7-2dc672ec8139';
const base = path.join(os.homedir(), '.dsh', 'sessions', '--D-DSH-qq-dsh-bridge-qq-bridge-state-agents--');
const file = path.join(base, SID, 'session.v4.jsonl.zstd');

const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let off = 0;
const chunks = [];
while (off < buf.length) {
  if (buf.readUInt32LE(off) !== 0xFD2FB528) { off += 1; continue; }
  for (const end of [buf.length, off + 400000, off + 200000, off + 50000, off + 12000]) {
    if (end <= off) continue;
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(off, end))); break; } catch { /* 继续试 */ }
  }
  const next = buf.indexOf(MAGIC, off + 4);
  if (next < 0) break;
  off = next;
}

const events = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

console.log(`会话 ${SID}`);
console.log(`事件数: ${events.length}\n`);

// 找压缩相关事件
const hits = events.filter((e) => /compaction/i.test(String(e.type || '')));
console.log(`=== 压缩事件（${hits.length} 条）===`);
if (!hits.length) {
  console.log('  ✅ 从未发生压缩 —— 说明 thresholdRatio 0.95 的守卫有效');
}
for (const e of hits.slice(0, 20)) {
  const t = new Date(e.time || 0).toLocaleString('zh-CN');
  console.log(`  [${t}] ${e.type}  ${JSON.stringify(e.data).slice(0, 200)}`);
}

// 看当前会话头里的模型/上下文
const head = events.find((e) => e.type === 'session');
console.log('\n=== 会话头 ===');
console.log(`  createdAt: ${new Date(head?.createdAt || 0).toLocaleString('zh-CN')}`);
console.log(`  agentPreset: ${head?.agentPreset}`);

// 统计 turn 数
let turns = 0;
for (const e of events) if (e.type === 'turn/start') turns += 1;
console.log(`  turn 数: ${turns}`);
