// 查 DSH 原生压缩是否触发过。逐帧解压、只保留含 compaction 的行（避免内存爆）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const SID = 'session-4996b486-1146-4843-84c7-2dc672ec8139';
const base = path.join(os.homedir(), '.dsh', 'sessions', '--D-DSH-qq-dsh-bridge-qq-bridge-state-agents--');
const file = path.join(base, SID, 'session.v4.jsonl.zstd');

const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// 先找出所有帧起点
const starts = [];
for (let i = 0; i + 4 <= buf.length; i += 1) {
  if (buf.readUInt32LE(i) === 0xFD2FB528) starts.push(i);
}
console.log(`文件 ${(buf.length / 1024 / 1024).toFixed(2)} MB，帧数约 ${starts.length}\n`);

let frameOk = 0;
let lineCount = 0;
let turnCount = 0;
const compactionLines = [];
let headLine = null;

for (let fi = 0; fi < starts.length; fi += 1) {
  const s = starts[fi];
  const e = fi + 1 < starts.length ? starts[fi + 1] : buf.length;
  let text;
  try {
    text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
    frameOk += 1;
  } catch {
    // 尝试更大的边界（某些帧可能跨了多个魔数误判）
    let ok = false;
    for (const end of [Math.min(buf.length, s + 400000), Math.min(buf.length, s + 100000), Math.min(buf.length, s + 20000)]) {
      if (end <= s) continue;
      try {
        text = zlib.zstdDecompressSync(buf.subarray(s, end)).toString('utf8');
        ok = true;
        frameOk += 1;
        break;
      } catch { /* 继续 */ }
    }
    if (!ok) continue;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lineCount += 1;
    if (line.includes('"turn/start"')) turnCount += 1;
    if (/compaction/i.test(line)) compactionLines.push(line);
    if (!headLine && line.includes('"type":"session"')) headLine = line;
  }
}

console.log(`成功解压帧: ${frameOk}`);
console.log(`总行数: ${lineCount}`);
console.log(`turn 数: ${turnCount}\n`);

console.log(`=== 压缩相关行（${compactionLines.length} 条）===`);
if (!compactionLines.length) {
  console.log('  ✅ 从未发生压缩（thresholdRatio 0.95 的守卫有效，空闲压缩也没到门槛）');
}
for (const l of compactionLines.slice(0, 15)) {
  console.log('  ' + l.slice(0, 260));
}

if (headLine) {
  const h = JSON.parse(headLine);
  console.log('\n=== 会话头 ===');
  console.log(`  创建: ${new Date(h.createdAt || 0).toLocaleString('zh-CN')}`);
  console.log(`  preset: ${h.agentPreset}`);
}
