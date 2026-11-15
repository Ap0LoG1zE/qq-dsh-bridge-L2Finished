// 验证 qq_recall 能读新格式（老文件里新旧混杂也要能读）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../src/memory-store.js';
import { createRecall } from '../src/memory-search.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-mix-'));
const store = createStore({ dir: tmp });

let fails = 0;
const ok = (label, cond) => { if (!cond) fails += 1; console.log(`${cond ? '✅' : '❌'} ${label}`); };

// ① 用新格式写两条
store.append([
  { src: 'qq', key: 'group:20001', seq: 1, t: Date.now() - 2000, kind: 'msg', role: '鹿', text: '那个打气筒真的很奇怪' },
  { src: 'qq', key: 'group:20001', seq: 2, t: Date.now() - 1000, kind: 'ai', role: '角色A', text: '我没觉得奇怪' },
]);

// ② 手动往同一个文件里追加一条**旧格式**（模拟历史数据）
const eventsDir = path.join(tmp, 'memory', 'events');
const shard = fs.readdirSync(eventsDir).find((f) => f.endsWith('.jsonl'));
const oldLine = JSON.stringify({
  id: 'qq:group:20001:3',
  v: 1,
  src: 'qq',
  key: 'group:20001',
  sid: null,
  seq: 3,
  t: Date.now(),
  kind: 'msg',
  role: '7月1',
  text: '打气筒是什么梗',
  meta: { messageId: '123', userId: '70001' },
});
fs.appendFileSync(path.join(eventsDir, shard), `${oldLine}\n`, 'utf8');

// ③ 检索
const recall = createRecall({ dir: path.join(tmp, 'memory', 'events') });
const hits = recall.search('打气筒', { limit: 10 });
console.log(`=== 搜「打气筒」命中 ${hits.length} 条 ===`);
for (const h of hits) console.log(`  [${h.time}] ${h.role}: ${h.text}`);

ok('能搜到新格式的记录', hits.some((h) => String(h.text).includes('那个打气筒真的很奇怪')));
ok('能搜到旧格式的记录（兼容）', hits.some((h) => String(h.text).includes('打气筒是什么梗')));
// 只该命中含关键词的两条 —— AI 那句「我没觉得奇怪」不含"打气筒"，本来就不该出现。
ok('只命中含关键词的（不误召回）', hits.length === 2);
// 说话人要能看出来是谁（原来恒为"某人"）
ok('展示真实昵称而不是"某人"', hits.some((h) => h.sender === '鹿') && hits.some((h) => h.sender === '7月1'));

// ④ format 输出
console.log('\n=== qq_recall 的返回格式 ===');
console.log(recall.format(hits, { query: '打气筒' }));
ok('format 正常输出', recall.format(hits, { query: '打气筒' }).includes('原文库'));

store.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
