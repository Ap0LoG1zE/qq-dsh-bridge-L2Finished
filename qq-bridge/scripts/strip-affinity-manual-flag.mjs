// 清掉测试期间留下的 manualAt 标记（这个字段表示"操作者手工调过"，
// 用测试数据污染真实状态会误导以后的排查）。
// 用法：node scripts/strip-affinity-manual-flag.mjs <userId> [--key=group:xxx] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const uid = String(args.find((a) => /^\d+$/.test(a)) || '').trim();
const onlyKey = args.find((a) => a.startsWith('--key='))?.slice(6) || '';
const dry = args.includes('--dry');
if (!uid) {
  console.error('用法：node scripts/strip-affinity-manual-flag.mjs <QQ号> [--key=group:xxx] [--dry]');
  process.exit(2);
}

const file = path.join(ROOT, 'state', 'social-v2.json');
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
const convs = json.conversations && typeof json.conversations === 'object' ? json.conversations : {};
let hits = 0;
for (const [ck, st] of Object.entries(convs)) {
  if (onlyKey && ck !== onlyKey) continue;
  const rec = st?.affinities?.[uid];
  if (!rec || typeof rec !== 'object') continue;
  if ('manualAt' in rec) {
    console.log(`${dry ? '[dry] ' : ''}${ck}: 去掉 ${uid} 的 manualAt（score=${rec.score}, count=${rec.count} 保持不动）`);
    if (!dry) delete rec.manualAt;
    hits++;
  }
}
if (!hits) {
  console.log(`没有找到需要清理的 manualAt（uid=${uid}${onlyKey ? `, key=${onlyKey}` : ''}）`);
  process.exit(0);
}
if (dry) {
  console.log('\n这是预演，没有写盘。去掉 --dry 才会真正保存。');
  process.exit(0);
}
const tmp = file + '.tmp-strip';
fs.writeFileSync(tmp, JSON.stringify(json), 'utf8');
fs.renameSync(tmp, file);
console.log(`\n已写回 ${path.relative(ROOT, file)}（清理 ${hits} 处）`);
