// 清掉 state/social-v2.json 里不在白名单的"幽灵会话"。
//
// group:123456789 是测试遗留：allow.groups 里只有 20001，它永远收不到消息，
// 但占着一条状态记录（还带 bootstrapSent=false，看着像"还有个群没引导"）。
// 留着会让排查时误判，也让人怀疑"是不是有个群没配"。
import fs from 'node:fs';

const CONFIG = 'config.json';
const STATE = 'state/social-v2.json';

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const allow = new Set([
  ...(cfg.allow?.groups || []).map((x) => `group:${x}`),
  ...(cfg.allow?.private || []).map((x) => `private:${x}`),
]);

const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const convs = st.conversations || {};

const ghosts = Object.keys(convs).filter((k) => {
  if (allow.has(k)) return false;
  // 白名单为空且 allowAllWhenEmpty=true 时，所有会话都合法，不算幽灵
  if (allow.size === 0 && cfg.allowAllWhenEmpty) return false;
  return true;
});

if (!ghosts.length) {
  console.log('没有幽灵会话，无需清理');
  process.exit(0);
}

console.log('发现幽灵会话（不在白名单）:');
for (const k of ghosts) {
  const c = convs[k];
  console.log(`  ${k}  bootstrapSent=${c.bootstrapSent} 未读=${(c.unread || []).length} recent=${(c.recentMessages || []).length}`);
}

// 只清"确实没内容"的：有未读或最近消息的可能是刚被移除白名单，留着更安全
const safe = ghosts.filter((k) => {
  const c = convs[k];
  return (c.unread || []).length === 0 && (c.recentMessages || []).length === 0;
});

if (!safe.length) {
  console.log('\n幽灵会话都还有消息记录，保守起见不删（请人工确认）');
  process.exit(0);
}

for (const k of safe) {
  delete convs[k];
  console.log(`  已删除 ${k}`);
}
fs.writeFileSync(STATE, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
console.log(`\n完成：删除 ${safe.length} 个空幽灵会话`);
