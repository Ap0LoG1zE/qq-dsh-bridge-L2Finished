// 预览「好感度怎么喂进唤醒包」：不启动桥接，直接用真实 state 渲染一份快照。
//
// 用法：
//   node scripts/preview-affinity-injection.mjs                    # 用 group:20001
//   node scripts/preview-affinity-injection.mjs --key=group:123
//   node scripts/preview-affinity-injection.mjs --set 群友A=120    # 临时改分看效果（只影响本次预览）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES, STAGE_HINTS, stageOf } from '../src/affinity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const key = args.find((a) => a.startsWith('--key='))?.slice(6) || 'group:20001';
const overrides = new Map();
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== '--set') continue;
  const spec = String(args[i + 1] || '');
  const m = /^(.+?)=(-?\d+)$/.exec(spec);
  if (m) overrides.set(m[1], Number(m[2]));
}

const stateFile = path.join(ROOT, 'state', 'social-v2.json');
if (!fs.existsSync(stateFile)) {
  console.error(`找不到 ${stateFile}`);
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const convs = state.conversations || {};

// 共享组：跟 bridge.js 的 shareGroupOf 同口径（这里简单实现，够预览用）。
function shareGroupOf(k) {
  const g = cfg.sessionSharing;
  if (!g || g.enabled !== true) return [k];
  for (const [leader, member] of Object.entries(g.groups || {})) {
    const pool = [leader, ...(Array.isArray(member) ? member : [member])];
    if (pool.includes(k)) return [...new Set(pool)];
  }
  return [k];
}
const pool = shareGroupOf(key);

// 收集这个共享组里所有人的分数（取最高那份，跟后端一致）。
const scores = new Map();
for (const ck of pool) {
  const st = convs[ck];
  if (!st) continue;
  for (const [uid, rec] of Object.entries(st.affinities || {})) {
    if (!rec || !(Number(rec.count) > 0)) continue;
    const prev = scores.get(uid);
    if (!prev || Number(rec.score) > Number(prev.score)) scores.set(uid, rec);
  }
}

// 名字：从消息记录倒着找（跟后端同一套清洗）。
const clean = (s) => String(s ?? '')
  .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, 40);
const NON_NAME = new Set(['私聊', '我', '未知', '群友', '管理员']);
const names = new Map();
for (const ck of pool) {
  const msgs = convs[ck]?.recentMessages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const uid = String(msgs[i]?.userId ?? '');
    if (!uid || names.has(uid)) continue;
    const nm = clean(msgs[i]?.sender);
    if (!nm || nm === uid || NON_NAME.has(nm)) continue;
    if (!/[\p{L}\p{N}]/u.test(nm)) continue;
    names.set(uid, nm);
  }
}
const display = (uid) => (String(uid) === String(cfg.ownerQQ) ? '主人' : (names.get(uid) || uid));

// 关系标记：跟 bridge.js 的 affinityTagForV2 同口径（平淡不标）。
function tag(uid, isSelf) {
  if (isSelf) return '';
  const rec = scores.get(String(uid));
  if (!rec) return '';
  const score = overrides.has(display(uid)) ? overrides.get(display(uid)) : Number(rec.score);
  const st = stageOf(score);
  if (st.id === 'neutral') return '';
  return `[${st.label}]`;
}
function scoreOf(uid) {
  const rec = scores.get(String(uid));
  if (!rec) return null;
  return overrides.has(display(uid)) ? overrides.get(display(uid)) : Number(rec.score);
}

const humanAgo = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 60000) return `${Math.max(1, Math.round(n / 1000))}秒前`;
  if (n < 3600000) return `${Math.round(n / 60000)}分钟前`;
  if (n < 86400000) return `${Math.round(n / 3600000)}小时前`;
  return `${Math.round(n / 86400000)}天前`;
};

// 渲染：跟 renderWakeSnapshotV2 的 shared 分支逐字对齐。
const rows = [];
const now = Date.now();
for (const ck of pool) {
  const st = convs[ck];
  if (!st) continue;
  const label = ck.startsWith('group:') ? `群${ck.slice(6)}` : `私聊${ck.slice(8)}`;
  for (const m of [...(st.recentMessages || [])].slice(-6)) {
    const isSelf = !!m.isSelf;
    const who = isSelf ? '我' : (clean(m.sender) || '某人');
    const uid = String(m.userId ?? '');
    const rel = tag(uid, isSelf);
    const seq = Number.isSafeInteger(m.seq) && m.seq > 0 ? `#${m.seq} ` : '';
    const ago = m.time ? humanAgo(now - Number(m.time)) : '';
    const text = String(m.text ?? m.plain ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    rows.push(`[${label}] ${seq}${who}${rel}${ago ? `·${ago}` : ''}：${text}`);
  }
}

console.log(`会话 key：${key}`);
console.log(`共享组：${pool.join(' → ')}`);
console.log('');
console.log('════════ 这些人现在的档位 ════════');
const sorted = [...scores.entries()].sort((a, b) => (scoreOf(b[0]) ?? 0) - (scoreOf(a[0]) ?? 0));
for (const [uid] of sorted) {
  const s = scoreOf(uid);
  const st = stageOf(s);
  console.log(`  ${display(uid).padEnd(16)} ${String(s).padStart(4)} 分  ${st.label}`);
}
console.log('');
console.log('════════ 她实际看到的【之前】片段 ════════');
for (const r of rows) console.log(r);
console.log('');
// 档名以 affinity.js 的 STAGES 为准，不在这里重新列一遍：
// 之前写死了「恋爱」，后来那一档改名「喜欢」，这里就一直是过期的。
const STAGE_LABELS = STAGES.map((s) => s.label);
const anyTag = rows.some((r) => new RegExp(`\\[(${STAGE_LABELS.join('|')})\\]`).test(r));
if (anyTag) {
  console.log(`（名字后面的 [${STAGE_LABELS.join('] / [')}] 是你和这个人的关系，不是群名片。）`);
} else {
  console.log('（当前没有任何人的档位高于平淡，所以这一轮不会出现关系标记，也不会出现那行说明。）');
}
console.log('');
console.log('════════ 档位含义（STAGE_HINTS，不进上下文，仅供你核对文案）════════');
for (const s of STAGES) {
  const h = STAGE_HINTS[s.id];
  const range = `≥${s.min === -Infinity ? '−∞' : s.min}`;
  console.log(`  ${s.label}（${range}）：${h?.hint || ''}`);
}
console.log('');
console.log('提示：用 --set 名字=分数 可以临时预览某个档位的样子，例如');
console.log('  node scripts/preview-affinity-injection.mjs --set 群友A=420');
