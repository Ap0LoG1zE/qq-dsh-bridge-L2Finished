// 验证指定会话里实际加载的预设是不是**精简版**。
// 和旧脚本的区别：断言的字符串改成新版文案，并加上"旧的长描述必须不在"的反向检查。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const base = path.join(os.homedir(), '.dsh', 'sessions', '--D-DSH-qq-dsh-bridge-qq-bridge-state-agents--');
let sid = process.argv[2];
if (!sid) {
  const dirs = fs.readdirSync(base).filter((n) => n.startsWith('session-'))
    .map((n) => ({ n, t: fs.statSync(path.join(base, n, 'session.v4.jsonl.zstd')).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  sid = dirs[0]?.n;
}
const file = path.join(base, sid, 'session.v4.jsonl.zstd');
const text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
const st = fs.statSync(file);
console.log(`会话：${sid}`);
console.log(`会话文件时间：${st.mtime.toLocaleString()}`);
const preset = fs.statSync('dsh/agent-presets/qq-chat-agent/agent.cordis.yml');
console.log(`预设源文件时间：${preset.mtime.toLocaleString()}`);
console.log('');

const check = (label, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${label}`); return ok; };
let bad = 0;
const c = (label, ok) => { if (!check(label, ok)) bad += 1; };

console.log('=== 精简版应有的标记 ===');
c('档名索引「疏远=冷漠」（精简后格式）', text.includes('疏远=冷漠'));
c('「发生以下两种情况的时候查」', text.includes('发生以下两种情况的时候查'));
c('「从没查过」', text.includes('从没查过'));
c('「档位怎么表现以它返回的为准」', text.includes('档位怎么表现以它返回的为准'));

console.log('\n=== 精简后不该再有的长描述 ===');
for (const v of [
  '他还没进你要回应的范围',
  '你会回，但只回这件事本身',
  '结束对话这件事开始有点难',
  '哪怕当时没接上',
]) {
  c(`已无「${v.slice(0, 14)}…」`, !text.includes(v));
}

console.log('\n=== 旧的硬性规则 ===');
c('已无「每轮必做」', !text.includes('每轮必做'));
c('已无「回复前必查好感度」', !text.includes('回复前必查好感度'));

console.log('');
if (bad) {
  console.log(`❌ ${bad} 项不符 —— 这个会话可能是在精简**之前**创建的。`);
  console.log('   处理：清掉 state/sessions.json 的会话映射，下一条消息会重建会话。');
  process.exitCode = 1;
} else {
  console.log('✅ 这个会话加载的是精简版预设。');
}
