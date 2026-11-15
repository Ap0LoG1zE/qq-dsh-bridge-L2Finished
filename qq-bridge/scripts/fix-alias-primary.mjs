#!/usr/bin/env node
// 修复别名表里「primary 是 QQ 号」的脏记录。
//
// 成因见 noteAliasV2 的注释：拍一拍事件在私聊分支里直接把 QQ 号当 sender，
// 那条消息进 recentMessages 后 noteAliasV2 把号码写成 primary，
// 于是 displayNameOfV2 一直返回号码 —— 群友印象、记忆渲染全显示成一串数字。
//
// 修法：从 names 里挑一个**不是纯号码**的当 primary；一个都没有才删掉整条
// （留着号码做 primary 比没记录更糟：它会让回退逻辑以为"已经知道名字了"）。
//
// 用法：
//   node scripts/fix-alias-primary.mjs           # 预演
//   node scripts/fix-alias-primary.mjs --apply   # 真写
import fs from 'node:fs';

const STATE = 'state/social-v2.json';
const APPLY = process.argv.includes('--apply');

const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const aliases = st.aliases && typeof st.aliases === 'object' ? st.aliases : {};
const isNumberLike = (s) => /^\d{4,12}$/.test(String(s ?? '').trim());

const fixes = [];
for (const [uid, rec] of Object.entries(aliases)) {
  if (!rec || typeof rec !== 'object') continue;
  const primary = String(rec.primary ?? '').trim();
  if (!primary || !isNumberLike(primary)) continue;   // primary 正常，跳过
  const names = Array.isArray(rec.names) ? rec.names.map((n) => String(n ?? '').trim()).filter(Boolean) : [];
  const good = names.filter((n) => !isNumberLike(n));
  fixes.push({ uid, primary, names, good });
}

if (!fixes.length) {
  console.log('没有需要修的记录（所有 primary 都不是纯号码）');
  process.exit(0);
}

console.log(`发现 ${fixes.length} 条 primary 是号码的记录：\n`);
for (const f of fixes) {
  if (f.good.length) {
    console.log(`  ${f.uid}`);
    console.log(`    现在 primary = ${JSON.stringify(f.primary)}`);
    console.log(`    候选名字     = ${JSON.stringify(f.good)}`);
    console.log(`    → 改成 ${JSON.stringify(f.good[0])}`);
  } else {
    console.log(`  ${f.uid}`);
    console.log(`    现在 primary = ${JSON.stringify(f.primary)}，且 names 里全是号码`);
    console.log(`    → 整条删除（留着只会让回退逻辑以为已知名字）`);
  }
  console.log('');
}

if (!APPLY) {
  console.log('（预演。加 --apply 写入）');
  process.exit(0);
}

for (const f of fixes) {
  if (f.good.length) {
    aliases[f.uid].primary = f.good[0];
    // 把号码从 names 里剔掉：它是脏数据，留着只会在下次选 primary 时又被挑中。
    aliases[f.uid].names = f.good.slice(0, 12);
  } else {
    delete aliases[f.uid];
  }
}
st.aliases = aliases;
fs.writeFileSync(STATE, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
console.log(`已修 ${fixes.length} 条`);
