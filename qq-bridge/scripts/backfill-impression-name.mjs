#!/usr/bin/env node
// 给缺 name 的群友印象补上展示名（从别名表读）。
//
// 背景：2026-11-12 前写入的 impression 没有 name 字段，控制台面板只能显示 QQ 号，
// 而别名表里早就有「号 → 昵称」的映射（每条消息进来都会记一次）。
// 这里一次性补齐，避免面板上一串号码看不出是谁。
//
// 用法：
//   node scripts/backfill-impression-name.mjs          # 预演
//   node scripts/backfill-impression-name.mjs --apply  # 真写
import fs from 'node:fs';

const STATE = 'state/social-v2.json';
const APPLY = process.argv.includes('--apply');

const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const g = st.globalMemory || {};
const im = g.memberImpressions || {};
const aliases = st.aliases || {};

const fixes = [];
for (const [uid, rec] of Object.entries(im)) {
  if (!rec || typeof rec !== 'object') continue;
  if (String(rec.name || '').trim()) continue;  // 已有名字，跳过
  const a = aliases[uid];
  const name = a ? String(a.primary || (Array.isArray(a.names) ? a.names[0] : '') || '').trim() : '';
  if (!name) continue;
  fixes.push({ uid, name, traits: (rec.traits || []).length });
}

if (!fixes.length) {
  console.log('没有需要补名字的印象（或别名表里也查不到）');
  process.exit(0);
}

console.log(`发现 ${fixes.length} 条缺 name 的印象：`);
for (const f of fixes) console.log(`  ${f.uid} → ${f.name}（${f.traits} 条观察）`);

if (!APPLY) {
  console.log('\n（预演。加 --apply 写入）');
  process.exit(0);
}

for (const f of fixes) {
  im[f.uid].name = f.name;
}
g.memberImpressions = im;
st.globalMemory = g;
fs.writeFileSync(STATE, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
console.log(`\n已补 ${fixes.length} 条`);
