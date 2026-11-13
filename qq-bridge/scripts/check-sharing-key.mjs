// 验证 sessionSharing 的 key 归一到共享代表键（私有/群 → 同一个代表）。
// 直接从 bridge.js 里 import 真实实现不可行（那是启动脚本），所以这里复制同一段逻辑
// 并覆盖两种配置写法。真实路径由 scripts/test-session-sharing.mjs 覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

function sharedOwnerKeyOf(cfg, key) {
  const sharing = cfg?.sessionSharing;
  if (!sharing || sharing.enabled !== true) return key;
  const canonical = canonicalV2Key(key);
  if (!canonical) return key;
  const groups = sharing.groups && typeof sharing.groups === 'object' ? sharing.groups : {};
  for (const [leaderRaw, memberRaw] of Object.entries(groups)) {
    const leader = canonicalV2Key(leaderRaw) || String(leaderRaw);
    const members = Array.isArray(memberRaw) ? memberRaw : [memberRaw];
    const pool = [leader, ...members.map((m) => canonicalV2Key(m) || String(m))];
    if (!pool.includes(canonical)) continue;
    const g = pool.filter((k) => k.startsWith('group:')).sort();
    return g[0] ?? [...pool].sort()[0];
  }
  const targets = new Set();
  for (const [fromRaw, toRaw] of Object.entries(groups)) {
    const from = canonicalV2Key(fromRaw) || String(fromRaw);
    if (from !== canonical) continue;
    const to = canonicalV2Key(toRaw) || String(toRaw);
    if (to) targets.add(to);
  }
  if (targets.size) {
    const ag = [...targets].filter((k) => k.startsWith('group:')).sort();
    return ag[0] ?? [...targets].sort()[0];
  }
  return key;
}

const cases = [
  ['group:20001', 'group:20001'],
  ['private:10001', 'group:20001'],
];
let bad = 0;
for (const [input, want] of cases) {
  const got = sharedOwnerKeyOf(cfg, input);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${input} -> ${got} (期望 ${want})`);
}

// 反向写法也要成立：{ group: [private] }
const alt = { sessionSharing: { enabled: true, groups: { 'group:111': ['private:222'] } } };
const altCases = [
  ['group:111', 'group:111'],
  ['private:222', 'group:111'],
];
for (const [input, want] of altCases) {
  const got = sharedOwnerKeyOf(alt, input);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [alt] ${input} -> ${got} (期望 ${want})`);
}

// 未开启共享时原样返回
const off = { sessionSharing: { enabled: false, groups: { 'private:222': 'group:111' } } };
const offGot = sharedOwnerKeyOf(off, 'private:222');
if (offGot !== 'private:222') { bad++; console.log(`FAIL [off] ${offGot}`); }
else console.log('PASS [off] 未开启共享时原样返回');

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
