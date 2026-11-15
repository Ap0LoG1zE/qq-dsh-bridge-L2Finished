// 验证「好感度不再随会话消失」这个核心诉求。
//
// 做法：走真实的控制台接口清一次上下文，然后看全局好感度还在不在。
// 这是用户最初的痛点：「我清除上下文，18 个人的好感度就没了」。
import fs from 'node:fs';
import path from 'node:path';

// 桥接根目录默认取脚本所在目录的上一级（2026-11-15 开源清理）。
// 原来硬编码作者本机路径 <仓库>\...，别人 clone 下来跑不了。
// 需要指向别处时用环境变量：set "QQ_BRIDGE_ROOT=D:\your\path\qq-bridge"
const ROOT = process.env.QQ_BRIDGE_ROOT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const STATE = path.join(ROOT, 'state');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const token = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
const base = `http://127.0.0.1:${cfg.consolePort || 3100}`;

const api = async (p, init = {}) => {
  const res = await fetch(base + p, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-console-token': token, ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const readAff = () => {
  const j = JSON.parse(fs.readFileSync(path.join(STATE, 'social-v2.json'), 'utf8'));
  const top = Object.keys(j.affinities || {}).length;
  let inConv = 0;
  for (const c of Object.values(j.conversations || {})) inConv += Object.keys(c.affinities || {}).length;
  return { top, inConv, raw: j.affinities || {}, convs: Object.keys(j.conversations || {}) };
};

console.log('=== 清除前 ===');
const before = readAff();
console.log(`  顶层 affinities: ${before.top} 人`);
console.log(`  会话内残留: ${before.inConv} 条`);
console.log(`  会话: ${before.convs.join(', ') || '(无)'}`);

if (before.top === 0) { console.error('❌ 顶层没有数据，无法验证'); process.exit(1); }
if (!before.convs.length) {
  console.log('\n(没有会话可清 —— 之前已经清过了；顶层数据仍在说明它与会话解耦)');
  process.exit(0);
}

for (const key of before.convs) {
  console.log(`\n=== 清除上下文: ${key} ===`);
  const r = await api('/api/session/reset', { method: 'POST', body: JSON.stringify({ key }) });
  console.log(`  HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
}

await new Promise((res) => setTimeout(res, 1500));

console.log('\n=== 清除后 ===');
const after = readAff();
console.log(`  顶层 affinities: ${after.top} 人`);
console.log(`  会话内残留: ${after.inConv} 条`);

console.log('');
if (after.top === before.top) {
  let same = 0;
  for (const [uid, rec] of Object.entries(before.raw)) {
    if (after.raw[uid] && after.raw[uid].score === rec.score) same += 1;
  }
  console.log(`✅ 好感度完好：清除前后都是 ${after.top} 人，分数未变 ${same}/${before.top}`);
} else {
  console.log(`❌ 好感度丢了：${before.top} → ${after.top}`);
  process.exitCode = 1;
}
