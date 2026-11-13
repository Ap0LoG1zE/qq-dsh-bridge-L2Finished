// 验证精简后的落盘格式：字段对不对、体积省多少、读取端是否兼容。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../src/memory-store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-slim-'));
const store = createStore({ dir: tmp });

console.log('=== 写入 3 条不同 kind 的记录 ===\n');

// ① 群友消息（有 userId / messageId / media）
store.append([{
  src: 'qq', key: 'group:20001', seq: 100, t: Date.now(),
  kind: 'msg', role: '鹿', text: '你们没人觉得这个打气筒很奇怪吗',
  meta: { messageId: '-1460857195', userId: '3380569062', media: false },
}]);

// ② 她自己的话（kind: ai）
store.append([{
  src: 'qq', key: 'group:20001', seq: 101, t: Date.now(),
  kind: 'ai', role: '角色A', text: '没叫我，我就没插话',
  meta: { self: true },
}]);

// ③ 拍一拍
store.append([{
  src: 'qq', key: 'private:10001', seq: 102, t: Date.now(),
  kind: 'poke', role: '主人', text: '[拍一拍] 主人拍了拍我',
  meta: { targetId: '30001', targetIsSelf: true, groupId: null },
}]);

const eventsDir = path.join(tmp, 'memory', 'events');
const files = fs.readdirSync(eventsDir);
const raw = fs.readFileSync(path.join(eventsDir, files[0]), 'utf8');
const lines = raw.split('\n').filter(Boolean);

console.log('=== 落盘内容 ===');
for (const l of lines) console.log(l);
console.log('');

// 断言
let fails = 0;
const ok = (label, cond) => { if (!cond) fails += 1; console.log(`${cond ? '✅' : '❌'} ${label}`); };

const recs = lines.map((l) => JSON.parse(l));
ok('不再写 id', recs.every((r) => !('id' in r)));
ok('不再写 v', recs.every((r) => !('v' in r)));
ok('不再写 src（纯 QQ 记录）', recs.every((r) => !('src' in r)));
ok('不再写 sid（全是 null 的那个）', recs.every((r) => !('sid' in r)));
ok('kind:ai 的记录带 self:true', recs[1].self === true);
ok('meta.self 不再重复写', !recs[1].meta || !('self' in recs[1].meta));
ok('保留 key', recs.every((r) => !!r.key));
ok('保留 seq', recs.every((r) => r.seq != null));
ok('保留 text', recs.every((r) => !!r.text));
ok('保留 messageId/userId', recs[0].meta?.messageId === '-1460857195' && recs[0].meta?.userId === '3380569062');
ok('false 的 media 不写', !recs[0].meta || recs[0].meta.media === undefined);

// ids.txt 必须仍然有效（id 不落盘，但要进索引）
const idsPath = path.join(tmp, 'memory', 'index', 'ids.txt');
const ids = fs.readFileSync(idsPath, 'utf8').split('\n').filter(Boolean);
console.log(`\n=== ids.txt（${ids.length} 条）===`);
for (const i of ids) console.log(' ', i);
ok('ids.txt 仍有 3 条（去重键没丢）', ids.length === 3);
ok('id 格式仍可推导', ids.includes('qq:group:20001:100'));

// rebuildIndex 能不能从新格式重建出同样的 id
const before = fs.readFileSync(idsPath, 'utf8');
const n = store.rebuildIndex();
const after = fs.readFileSync(idsPath, 'utf8');
console.log(`\nrebuildIndex() → ${n} 条`);
ok('重建索引条数一致', n === 3);
ok('重建后 ids.txt 内容一致', before.trim() === after.trim());

// 体积对比：同样内容按旧格式（11 字段）会是多少
function oldShape(r, i) {
  return JSON.stringify({
    id: `qq:${r.key}:${r.seq}`,
    v: 1,
    src: 'qq',
    key: r.key,
    sid: null,
    seq: r.seq,
    t: r.t,
    kind: r.kind,
    role: r.role,
    text: r.text,
    meta: r.meta,
  });
}
const newBytes = Buffer.byteLength(raw, 'utf8');
const oldBytes = Buffer.byteLength(recs.map(oldShape).join('\n') + '\n', 'utf8');
console.log(`\n=== 体积 ===`);
console.log(`  旧格式: ${oldBytes} 字节`);
console.log(`  新格式: ${newBytes} 字节`);
console.log(`  节省: ${((1 - newBytes / oldBytes) * 100).toFixed(1)}%`);

store.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
