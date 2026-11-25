// 从 session.v4.jsonl.zstd 的所有字符串字段删除指定短语（2026-11-24）。
//
// 需求（操作者）：把 "You are a helpful assistant" 全部删掉，
// 连带因为删除而变空的相邻引号一起清。
//
// 实现要点：
//   ① 按 zstd 魔数切帧（多帧拼接是 DSH 的格式约定），只重压改过的帧
//   ② 递归遍历 JSON 里所有字符串值
//   ③ 删除串 + 紧跟的句号/空白作为整体（避免留下孤零零的 "."）
//   ④ 清掉因此变成空的引号对（含 JSON 里的 \"\"）
//   ⑤ 只清**行首**残留的孤立句号 —— 不做全局标点清理
//      （踩过：宽正则会吃掉「总结性的"汇报。注意：」里的正常文字）
//
// 用法：
//   node scripts/strip-session-phrase.mjs <sessionDir> [--apply]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PHRASE = 'You are a helpful assistant';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const dir = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dir) {
  console.error('用法: node strip-session-phrase.mjs <sessionDir> [--apply]');
  process.exit(1);
}
const file = path.join(dir, 'session.v4.jsonl.zstd');
if (!fs.existsSync(file)) {
  console.error('找不到文件:', file);
  process.exit(1);
}

const raw = fs.readFileSync(file);

/** 切帧：返回 [{a,b}]。 */
function frameBounds(buf) {
  const starts = [];
  let i = 0;
  while (true) {
    const j = buf.indexOf(MAGIC, i);
    if (j < 0) break;
    starts.push(j);
    i = j + 4;
  }
  return starts.map((a, k) => ({ a, b: k + 1 < starts.length ? starts[k + 1] : buf.length }));
}

const escaped = PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 目标串 + 紧跟的可选句号 + 可选空白，整体删除
const RE_PHRASE = new RegExp(`${escaped}[.。]?\\s*`, 'g');

/** 删除目标串并清理因此变空的相邻标点。 */
function stripText(s) {
  if (!s.includes(PHRASE)) return s;
  let out = s.replace(RE_PHRASE, '');
  // 清掉因此变成空的引号对（含 JSON 转义形式）
  out = out.replace(/\\"\\"/g, '')
    .replace(/""/g, '')
    .replace(/''/g, '')
    .replace(/「」/g, '')
    .replace(/『』/g, '')
    .replace(/（）/g, '')
    .replace(/\(\)/g, '')
    .replace(/【】/g, '');
  // 只清行首残留的孤立句号
  out = out.replace(/^[.。]\s*/, '');
  // 连续空行压成两个
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

/** 递归处理所有字符串值，统计改动数。 */
function stripValue(value, counter) {
  if (typeof value === 'string') {
    if (!value.includes(PHRASE)) return value;
    counter.n += 1;
    return stripText(value);
  }
  if (Array.isArray(value)) return value.map((v) => stripValue(v, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripValue(v, counter);
    return out;
  }
  return value;
}

const bounds = frameBounds(raw);
const rebuilt = [];
let totalFields = 0;
let totalLines = 0;
let changedFrames = 0;

for (const { a, b } of bounds) {
  const slice = raw.subarray(a, b);
  let text;
  try {
    text = zlib.zstdDecompressSync(slice).toString('utf8');
  } catch {
    rebuilt.push(slice);
    continue;
  }
  if (!text.includes(PHRASE)) {
    rebuilt.push(slice);
    continue;
  }
  const counter = { n: 0 };
  const outLines = [];
  let frameChanged = false;
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes(PHRASE)) {
      outLines.push(line);
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      // 不是 JSON 行：当纯文本处理
      counter.n += 1;
      outLines.push(stripText(line));
      frameChanged = true;
      totalLines += 1;
      continue;
    }
    outLines.push(JSON.stringify(stripValue(obj, counter)));
    frameChanged = true;
    totalLines += 1;
  }
  totalFields += counter.n;
  if (frameChanged) {
    rebuilt.push(zlib.zstdCompressSync(Buffer.from(outLines.join('\n'), 'utf8')));
    changedFrames += 1;
  } else {
    rebuilt.push(slice);
  }
}

const out = Buffer.concat(rebuilt);

console.log(`原文件:     ${raw.length} 字节`);
console.log(`新文件:     ${out.length} 字节`);
console.log(`总帧数:     ${bounds.length}（改动 ${changedFrames} 帧）`);
console.log(`命中字段数: ${totalFields}`);
console.log(`命中行数:   ${totalLines}`);

if (!apply) {
  console.log('\n[dry-run] 没有写回。加 --apply 生效。');
  process.exit(0);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const bak = `${file}.bak-strip-${ts}`;
fs.copyFileSync(file, bak);
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, out);
fs.renameSync(tmp, file);
console.log('\n已写回:', file);
console.log('备份:  ', bak);
