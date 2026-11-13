#!/usr/bin/env node
// 把按会话存的长期事实（facts/*.jsonl）合并成全局一份（facts/global.jsonl）。
//
// 背景（2026-11-10 操作者定稿）：memberImpression / selfNote / longTerm 改成**全局一份**。
//   social-v2.json 里的两类由桥接启动时自动迁移（见 loadSocialV2State）；
//   facts 是独立 jsonl 文件，需要这个脚本搬一次。
//
// 迁移规则：
//   · 同名（factsFileOf 结果）跳过；已有 global.jsonl 则把旧文件并进去。
//   · 按 id 折叠后合并；**同一句 text 只留一条**（取 hits 最高、lastHit 最新的那条的元数据）。
//   · 旧文件改名为 *.migrated-<时间戳>，不删除 —— 迁移出问题还能回滚。
//
// 用法：
//   node scripts/migrate-global-memory.mjs           # 预演，只打印计划
//   node scripts/migrate-global-memory.mjs --apply   # 真写
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFacts, collapse, factsFileOf } from '../src/memory-facts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, '..', 'state');
const FACTS_DIR = path.join(STATE_DIR, 'memory', 'facts');
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(FACTS_DIR)) {
  console.log('没有 facts 目录，无需迁移');
  process.exit(0);
}

const files = fs.readdirSync(FACTS_DIR).filter((f) => f.endsWith('.jsonl'));
const globalFile = path.basename(factsFileOf(STATE_DIR, 'global'));
const sources = files.filter((f) => f !== globalFile);

console.log(`目标文件: ${globalFile}`);
console.log(`待合并的旧文件: ${sources.length} 个`);
if (!sources.length) {
  console.log('已经全是 global.jsonl，无需迁移');
  process.exit(0);
}

// 读所有旧文件的记录
const all = [];
for (const f of sources) {
  const full = path.join(FACTS_DIR, f);
  const rows = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  console.log(`  ${f}: ${rows.length} 行`);
  all.push(...rows);
}

// 已有的 global 也读进来一起合并
const existingGlobal = loadFacts(STATE_DIR, 'global');

// 按 id 折叠，再按 text 去重（同一句话在不同会话各写过一次的那种）
const byId = new Map();
for (const r of [...existingGlobal, ...all]) if (r && r.id) byId.set(r.id, r);
const folded = [...byId.values()];

const byText = new Map();
let dupText = 0;
for (const r of folded) {
  const key = String(r.text || '').trim();
  if (!key) continue;
  const prev = byText.get(key);
  if (!prev) { byText.set(key, r); continue; }
  dupText += 1;
  // 合并元数据：hits 取最大、lastHit/createdAt 取最新、archived 取「两者都归档才算归档」
  byText.set(key, {
    ...prev,
    hits: Math.max(Number(prev.hits) || 0, Number(r.hits) || 0),
    lastHit: Math.max(Number(prev.lastHit) || 0, Number(r.lastHit) || 0),
    createdAt: Math.min(Number(prev.createdAt) || Infinity, Number(r.createdAt) || Infinity) || Date.now(),
    archived: !!(prev.archived && r.archived),
  });
}

const merged = [...byText.values()];
const live = merged.filter((f) => !f.archived);
console.log('');
console.log(`折叠后 ${folded.length} 条 → 按文本去重 ${merged.length} 条（去掉重复 ${dupText} 条）`);
console.log(`其中活跃 ${live.length} 条、已归档 ${merged.length - live.length} 条`);

if (!APPLY) {
  console.log('\n（预演模式，未写入。确认无误后加 --apply 执行）');
  process.exit(0);
}

// 写全局文件
const target = factsFileOf(STATE_DIR, 'global');
fs.mkdirSync(path.dirname(target), { recursive: true });
const body = merged.map((f) => JSON.stringify(f)).join('\n') + (merged.length ? '\n' : '');
fs.writeFileSync(target, body, 'utf8');
console.log(`\n已写入 ${target}（${merged.length} 条）`);

// 旧文件改名存档（不删）
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const f of sources) {
  const full = path.join(FACTS_DIR, f);
  const dst = `${full}.migrated-${stamp}`;
  fs.renameSync(full, dst);
  console.log(`  归档旧文件 → ${path.basename(dst)}`);
}

console.log('\n迁移完成。重启桥接后长期事实就是全局一份了。');
