// 检查某个 DSH 会话里加载的 preset 是不是**最新版**。
//
// 为什么需要这个：DSH 只在启动时读 preset bundle，改完 `dsh/agent-presets/*/agent.cordis.yml`
// 后新建的会话**仍然会用旧内容** —— 除非 DSH 进程重启过。这个脚本直接翻会话日志
// （zstd 压缩的 jsonl）把 persona 抠出来，逐条比对关键规则在不在。
//
// 用法：
//   node scripts/check-session-preset.mjs                      # 用桥接当前会话
//   node scripts/check-session-preset.mjs --id=session-xxxx
//   node scripts/check-session-preset.mjs --list              # 列出所有会话
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SESSION_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const AGENT_DIR = '--D-DSH-qq-dsh-bridge-qq-bridge-state-agents--';
const baseDir = path.join(SESSION_ROOT, AGENT_DIR);

function listSessions() {
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir)
    .filter((n) => n.startsWith('session-'))
    .map((n) => {
      const file = path.join(baseDir, n, 'session.v4.jsonl.zstd');
      const exists = fs.existsSync(file);
      return {
        id: n,
        file,
        exists,
        mtime: exists ? fs.statSync(file).mtime : null,
        size: exists ? fs.statSync(file).size : 0,
      };
    })
    .sort((a, b) => (b.mtime?.getTime() || 0) - (a.mtime?.getTime() || 0));
}

if (args.includes('--list')) {
  const list = listSessions();
  if (!list.length) { console.log('没有找到任何会话'); process.exit(0); }
  console.log('会话 ID'.padEnd(46) + '大小'.padStart(9) + '  修改时间');
  for (const s of list) {
    console.log(`${s.id.padEnd(46)}${String(s.size).padStart(9)}  ${s.mtime ? s.mtime.toLocaleString() : '-'}`);
  }
  process.exit(0);
}

// 选会话：显式 --id 优先，否则问桥接要当前映射。
let sessionId = args.find((a) => a.startsWith('--id='))?.slice(5) || '';
if (!sessionId) {
  const tokenFile = path.join(ROOT, 'state', 'console-token');
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const port = cfg.consolePort || 3100;
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { 'x-console-token': token },
    });
    const j = await res.json();
    const first = Array.isArray(j.sessions) ? j.sessions[0] : null;
    if (first) sessionId = first.sessionId;
  } catch (error) {
    console.log(`（桥接没连上：${error?.message ?? error}，改用最新的会话）`);
  }
}
if (!sessionId) {
  const newest = listSessions().find((s) => s.exists);
  if (!newest) { console.error('找不到任何可用会话'); process.exit(1); }
  sessionId = newest.id;
}

const file = path.join(baseDir, sessionId, 'session.v4.jsonl.zstd');
if (!fs.existsSync(file)) {
  console.error(`会话文件不存在：${file}`);
  process.exit(1);
}
const stat = fs.statSync(file);
const text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');

console.log(`会话：${sessionId}`);
console.log(`文件：${stat.size} 字节，修改于 ${stat.mtime.toLocaleString()}`);
console.log(`解出：${text.length} 字符\n`);

// 从**当前源文件**里取判据，这样永远是"拿新版去比旧会话"。
const presetSrc = fs.readFileSync(
  path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-agent', 'agent.cordis.yml'), 'utf8');

// 1) 新版独有的标记（必须全部存在）
const mustHave = [
  ['【回复前必查好感度】', '新增的 0.5 条硬规则'],
  ['每轮必做', '把"拿不准才查"改成"每轮必做"'],
  ['不是可选步骤', '强调这是硬性前置'],
  ['先做自己，再查关系', '小节标题从"想关系"改成"查关系"'],
];
// 2) 旧版残留（出现就说明没更新）
// ⚠️ 这里千万不能放"新规则里为了对比而引用的旧措辞"：
//    新版正文写着 ``不是"拿不准才查"`` —— 那是**说明语气变了**，不是残留。
//    之前把 `拿不准分寸时` 和 `拿不准才查` 放进来，导致明明更新成功了还报"2 处不符"，
//    差点让人以为重启没用。
const mustNotHave = [
  ['不是每轮都要查', '旧版触发条件'],
  ['先做自己，再想关系', '旧版小节标题'],
  ['**再看关系**', '旧版步骤 ② 的写法'],
];

let bad = 0;
console.log('=== 新版规则是否生效 ===');
for (const [kw, why] of mustHave) {
  const hit = text.includes(kw);
  if (!hit) bad += 1;
  console.log(`  ${hit ? '✓' : '✗'} ${kw.padEnd(24)} ${why}`);
}
console.log('\n=== 旧版内容是否残留 ===');
for (const [kw, why] of mustNotHave) {
  const hit = text.includes(kw);
  if (hit) bad += 1;
  console.log(`  ${hit ? '✗ 仍有' : '✓ 已无'} ${kw.padEnd(22)} ${why}`);
}

// 3) 五档：判断"恋爱档"是否可达。
//    注意 STAGE_HINTS 在 **affinity.js**、档位阈值在 affinity.js 的 STAGES，
//    而 persona 里的那句是「疏远 / 平淡 / 在意 / 依赖 / 恋爱」的档位列表。
//    所以这里查两样：会话里有没有出现"恋爱"这个档名，以及源文件里 lover 档在不在。
console.log('\n=== 五档 ===');
const hasLoverInSession = text.includes('疏远 / 平淡 / 在意 / 依赖 / 恋爱') || text.includes('恋爱');
if (!hasLoverInSession) bad += 1;
console.log(`  ${hasLoverInSession ? '✓' : '✗'} 会话里能看到「恋爱」档`);

// 恋爱档的提示文案在 affinity.js 里，不在 preset 里 —— 从那边读。
const affinitySrcPath = path.join(ROOT, 'src', 'affinity.js');
let hasLoverHint = false;
if (fs.existsSync(affinitySrcPath)) {
  const src = fs.readFileSync(affinitySrcPath, 'utf8');
  hasLoverHint = /id:\s*'lover'/.test(src) && /lover:\s*\{/.test(src);
}
if (!hasLoverHint) bad += 1;
console.log(`  ${hasLoverHint ? '✓' : '✗'} affinity.js 里有 lover 档（阈值 + 提示文案）`);

// 档位阈值是运行时读的（不走 DSH preset 缓存），所以只要文件对就等于生效。
console.log('  （档位阈值/文案由 bridge 直接 import affinity.js，不受 DSH preset 缓存影响）');

// 4) 结论
console.log('');
if (bad === 0) {
  console.log('✅ 这个会话加载的是**最新版**预设。');
  process.exit(0);
}
const dsStart = (() => {
  // 粗略判断：会话建立时间 vs preset 文件修改时间
  return stat.mtime;
})();
const presetMtime = fs.statSync(path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-agent', 'agent.cordis.yml')).mtime;
console.log(`❌ 这个会话用的是**旧版**预设（${bad} 处不符）。`);
console.log(`   会话文件时间：${dsStart.toLocaleString()}`);
console.log(`   预设源文件时间：${presetMtime.toLocaleString()}`);
if (dsStart.getTime() < presetMtime.getTime()) {
  console.log('   → 会话是在预设改动**之前**建立的。DSH 只在启动时读 preset，');
  console.log('     所以必须重启 DSH 才会加载新版（只重建会话不够）。');
}
process.exit(1);
