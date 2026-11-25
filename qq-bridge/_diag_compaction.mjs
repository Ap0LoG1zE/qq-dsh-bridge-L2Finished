// 诊断：闲置压缩为什么没触发。
//
// 条件：enabled + onlyPrivate + 未压过 + 不忙 + 有会话 + 安静 idleMs + 模型最近没动 + 上下文 ≥ thresholdTokens
import fs from 'node:fs';

const ST = 'D:\\DSH\\qq-dsh-bridge\\qq-bridge\\state';
const cfg = JSON.parse(fs.readFileSync('D:\\DSH\\qq-dsh-bridge\\qq-bridge\\config.json', 'utf8').replace(/^\uFEFF/, ''));
const c = cfg.socialV2.compaction;
const social = JSON.parse(fs.readFileSync(ST + '\\social-v2.json', 'utf8'));

console.log('=== 压缩配置 ===');
for (const k of Object.keys(c)) console.log(`  ${k}: ${c[k]}`);
console.log('');

console.log('=== 各会话状态 ===');
const now = Date.now();
for (const [key, st] of Object.entries(social.conversations || {})) {
  const lastIn = st.lastIncomingAt || 0;
  const lastAct = st.lastActionAt || 0;
  const idleMin = lastIn ? ((now - lastIn) / 60000).toFixed(1) : '(无)';
  const actMin = lastAct ? ((now - lastAct) / 60000).toFixed(1) : '(无)';
  console.log(`  ${key}`);
  console.log(`    最后收消息: ${idleMin} 分钟前`);
  console.log(`    最后一次动作: ${actMin} 分钟前`);
  console.log(`    idleCompactedAt: ${st.idleCompactedAt || 0} ${st.idleCompactedAt ? '(已压过，等下条消息解锁)' : ''}`);
  console.log(`    idleCompactingAt: ${st.idleCompactingAt || 0}`);
  console.log(`    有 DSH 会话映射: ${social.sessions?.[key] ? '是' : '否'}`);
}

// 读 token 账本看上下文多大
console.log('');
console.log('=== 上下文 token（从账本读最近一条）===');
const ledgerPath = ST + '\\token-ledger.json';
if (fs.existsSync(ledgerPath)) {
  const led = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const rows = Array.isArray(led) ? led : (led.entries || led.rows || []);
  console.log(`  账本条数: ${rows.length}`);
  const byKey = {};
  for (const r of rows) {
    if (!r || !r.key) continue;
    byKey[r.key] = r;   // 保留最后一个
  }
  for (const [k, r] of Object.entries(byKey)) {
    const ctx = (r.cacheMiss || 0) + (r.cacheHit || 0) + (r.cacheWrite || 0);
    console.log(`  ${k}: 约 ${Math.round(ctx / 1000)}k token  (门槛 ${Math.round(c.thresholdTokens / 1000)}k)`);
    console.log(`     cacheMiss=${r.cacheMiss} cacheHit=${r.cacheHit} cacheWrite=${r.cacheWrite}`);
  }
} else {
  console.log('  ⚠️ 账本文件不存在:', ledgerPath);
  console.log('  state 下的文件:');
  for (const f of fs.readdirSync(ST)) if (/token|ledger/i.test(f)) console.log('    ' + f);
}
