// 从 token-usage.jsonl 算当前上下文体量。
//
// 每行是 { k:"turn", t, sid, key, seq, turn, step, retry, model, provider, b:{cacheMiss,cacheHit,cacheWrite,...} }
// 上下文大小 ≈ cacheMiss + cacheHit + cacheWrite（输入侧总量）。
import fs from 'node:fs';

const FILE = 'D:\\DSH\\qq-dsh-bridge\\qq-bridge\\state\\token-usage.jsonl';
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
console.log(`账本行数: ${lines.length}\n`);

const rows = [];
for (const l of lines) {
  try {
    const r = JSON.parse(l);
    if (r.k === 'turn' && r.key && r.b) rows.push(r);
  } catch { /* ignore */ }
}
console.log(`turn 记录: ${rows.length}\n`);

// 按 key 取最后一条
const byKey = {};
for (const r of rows) byKey[r.key] = r;

const threshold = 400000;
console.log('=== 各会话当前上下文（最后一步的输入侧 token）===');
for (const [key, r] of Object.entries(byKey)) {
  const b = r.b;
  const ctx = (b.cacheMiss || 0) + (b.cacheHit || 0) + (b.cacheWrite || 0);
  const out = b.outputTokens ?? b.output ?? 0;
  const when = new Date(r.t).toLocaleString('zh-CN');
  const pct = ((ctx / threshold) * 100).toFixed(1);
  console.log(`  ${key}`);
  console.log(`    最后一步: ${when}  turn=${r.turn} step=${r.step}`);
  console.log(`    输入侧: cacheMiss=${b.cacheMiss} cacheHit=${b.cacheHit} cacheWrite=${b.cacheWrite}`);
  console.log(`    合计 = ${ctx.toLocaleString()} token  (门槛 ${threshold.toLocaleString()}，${pct}%)`);
  console.log(`    输出: ${out}`);
  console.log(`    ${ctx >= threshold ? '⚠️ 已超过门槛' : '未到门槛'}`);
  console.log('');
}

// 顺便看模型/供应商
const last = rows[rows.length - 1];
if (last) {
  console.log('=== 最后一条的元信息 ===');
  console.log(`  model=${last.model} provider=${last.provider} sid=${last.sid}`);
  console.log(`  b 的完整字段: ${Object.keys(last.b).join(', ')}`);
}
