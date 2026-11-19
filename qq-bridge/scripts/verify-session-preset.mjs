// 验证：会话里**最新装配**的系统提示词是不是当前预设，且其余段落没被破坏。
//
// 用法：
//   node scripts/verify-session-preset.mjs                          # 检查全部会话
//   node scripts/verify-session-preset.mjs session-xxxx             # 只查一个
//   node scripts/verify-session-preset.mjs --expect-gone 谁是主人    # 额外断言旧文案已消失
//
// ⚠️ 一个会话里会有**多条** system/message —— 每条代表"那一轮装配出来的系统提示词"。
//    只有**最后一条**有意义；前面那些是历史留档，本来就是旧版，不必也不能改它们。
//    这个脚本只看最后一条（--all 可列出全部）。
//
// 检查四项：
//   ① 当前预设的起止锚点都在
//   ② 旧文案已消失（--expect-gone 指定）
//   ③ 插件注入段还在（【你的身份】或【令牌】）
//   ④ DSH 段落还在（harness 头）
import fs from 'node:fs';
import zlib from 'node:zlib';
import yaml from 'js-yaml';

const ROOT = 'C:/Users/Ap0/.dsh/sessions/--D-DSH-qq-dsh-bridge-qq-bridge-state-agents--';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const START_ANCHOR = '【二代仿真模式';
const END_ANCHOR = '【发送与汇报禁令';

const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const gi = argv.indexOf('--expect-gone');
const gone = gi >= 0 ? argv.slice(gi + 1).filter((a) => !a.startsWith('--')) : [];
const sids = argv.filter((a) => !a.startsWith('--') && !gone.includes(a));

const map = JSON.parse(fs.readFileSync('state/sessions.json', 'utf8')).sessions || {};
const targets = sids.length ? sids : [...new Set(Object.values(map))];

const yml = yaml.load(fs.readFileSync('dsh/agent-presets/qq-chat-agent/agent.cordis.yml', 'utf8'));
const fresh = yml.find((r) => r.id === 'persona').config.prefix;
if (!fresh.includes(START_ANCHOR) || !fresh.includes(END_ANCHOR)) {
  console.log('⚠️ 当前预设锚点不全，检查 agent.cordis.yml');
}

function decode(file) {
  const raw = fs.readFileSync(file);
  const starts = [];
  let i = 0;
  while (true) { const j = raw.indexOf(MAGIC, i); if (j < 0) break; starts.push(j); i = j + 4; }
  const recs = [];
  let badFrames = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const a = starts[k];
    const b = k + 1 < starts.length ? starts[k + 1] : raw.length;
    let t;
    try { t = zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8'); } catch { badFrames += 1; continue; }
    for (const line of t.split('\n')) { if (!line.trim()) continue; try { recs.push(JSON.parse(line)); } catch {} }
  }
  return { recs, badFrames, bytes: raw.length };
}

const textOf = (rec) => (rec.data?.message?.content || []).map((c) => c.text || '').join('\n');
const whenOf = (rec) => (rec.time ? new Date(rec.time).toLocaleString('zh-CN', { hour12: false }) : '-');

let bad = 0;

// ── 先看装配源：patch 文件（DSH 每轮从它重新装配）──────────────────────────
// 这一项比"会话里最新那条"更重要：会话里的是**上一次装配的结果**，
// 而 patch 才是"下一轮会用到的"。
const PATCH = 'plugins/qq-agent-presets/presets/qq-chat-agent.patch.yml';
let patchText = '';
try {
  patchText = fs.readFileSync(PATCH, 'utf8');
} catch {
  console.log(`⚠️ 读不到 ${PATCH}（先跑 node scripts/build-agent-preset-patches.mjs）`);
}

if (patchText) {
  console.log('\n══ 装配源（下一轮会用到的）');
  console.log(`   ${PATCH}`);
  const pChecks = [
    ['预设起点', patchText.includes(START_ANCHOR)],
    ['预设终点', patchText.includes(END_ANCHOR)],
    ...gone.map((g) => [`旧文案已消失：${g}`, !patchText.includes(g)]),
  ];
  const pOk = pChecks.every(([, v]) => v);
  if (!pOk) bad += 1;
  console.log(`   ${pOk ? '✅ 就是当前预设' : '❌ 与当前预设不一致'}`);
  for (const [name, v] of pChecks) if (!v) console.log(`      ✗ ${name}`);
  const pOwner = patchText.split('\n').find((l) => l.includes('谁是'));
  if (pOwner) console.log(`   ▸ ${pOwner.trim().slice(0, 110)}`);
}

console.log('\n══ 各会话上次装配的结果（历史，仅供参考）');
for (const sid of targets) {
  const file = `${ROOT}/${sid}/session.v4.jsonl.zstd`;
  if (!fs.existsSync(file)) { console.log(`\n✗ ${sid} 文件不存在`); bad += 1; continue; }

  const { recs, badFrames, bytes } = decode(file);
  const sys = recs.filter((r) => r.type === 'system/message');
  if (!sys.length) { console.log(`\n✗ ${sid} 没有 system/message`); bad += 1; continue; }

  const latest = sys[sys.length - 1];
  const txt = textOf(latest);

  const checks = [
    ['预设起点', txt.includes(START_ANCHOR)],
    ['预设终点', txt.includes(END_ANCHOR)],
    ['插件段（身份/令牌）', txt.includes('【你的身份】') || txt.includes('【令牌】')],
    ['harness 头', txt.startsWith('You are an AI agent')],
    ...gone.map((g) => [`旧文案已消失：${g}`, !txt.includes(g)]),
  ];
  const lineOk = checks.every(([, v]) => v) && !badFrames;
  if (!lineOk) bad += 1;

  console.log(`\n${lineOk ? '✅' : '❌'} ${sid.slice(0, 28)}…  ${bytes} 字节，${sys.length} 条 system/message`);
  console.log(`   最新装配: turn=${latest.data?.turn}  ${whenOf(latest)}  len=${txt.length}`);
  const ownerLine = txt.split('\n').find((l) => l.includes('谁是'));
  if (ownerLine) console.log(`   ▸ ${ownerLine.trim().slice(0, 110)}`);
  for (const [name, v] of checks) if (!v) console.log(`      ✗ ${name}`);
  if (badFrames) console.log(`      ✗ ${badFrames} 帧解压失败`);

  if (showAll) {
    console.log('   ── 全部记录（历史留档，仅供参考）──');
    for (const s of sys) {
      const t = textOf(s);
      console.log(`     turn=${String(s.data?.turn).padEnd(4)} ${whenOf(s)}  len=${String(t.length).padEnd(6)} 起点=${t.includes(START_ANCHOR)} 终点=${t.includes(END_ANCHOR)}`);
    }
  }
}

console.log(bad === 0 ? '\n✅ 全部正确' : `\n❌ ${bad} 个会话有问题`);
process.exit(bad === 0 ? 0 : 1);
