// 验证：qq_send_message 的 schema 里不再有 gapMode / gapMs / gaps。
//
// 2026-11-19 操作者问「为什么她还要传 gapMode: auto」。
// 根因：那是可选 enum，第一个值就是 auto，模型看到顺手填第一个。
// 而桥接不传就是 auto（`(body.gapMode === 'fixed' || ...) ? body.gapMode : 'auto'`），
// 所以这三个参数对她完全多余 —— 已从 schema 删除，桥接仍然接受（兼容手写调用）。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根：从脚本位置推导，换机器/换目录都能跑（别再写死绝对路径）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SRC = path.join(ROOT, 'src', 'mcp-snowluma-safe.js');
const src = fs.readFileSync(SRC, 'utf8');
const code = src.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');

let pass = 0;
let fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, '—', e.message); }
};

test('schema 里没有 gapMode', () => {
  if (/gapMode:\s*z\./.test(code)) throw new Error('gapMode 仍在 schema 里');
});

test('schema 里没有 gapMs', () => {
  if (/gapMs:\s*z\./.test(code)) throw new Error('gapMs 仍在 schema 里');
});

test('schema 里没有 gaps', () => {
  if (/\bgaps:\s*z\./.test(code)) throw new Error('gaps 仍在 schema 里');
});

test('解构参数里没有 gapMode/gapMs/gaps', () => {
  const m = code.match(/async \(\{ key, token, messages[^}]*\}\)/);
  if (!m) throw new Error('找不到 send_message 的解构');
  if (/gapMode|gapMs|gaps/.test(m[0])) {
    throw new Error(`解构里还有 gap 参数：${m[0]}`);
  }
});

test('请求体里不再发送 gap 字段', () => {
  const m = code.match(/body: JSON\.stringify\(\{ key, messages: finalMessages[^)]*\)/);
  if (!m) throw new Error('找不到请求体');
  if (/gapMode|gapMs|gaps/.test(m[0])) {
    throw new Error(`请求体仍带 gap 字段：${m[0]}`);
  }
});

// 2026-11-20：noWait 已整体删除，这条断言反过来 —— 确认它真的不在了。
test('noWait 已删除（2026-11-20 操作者要求）', () => {
  if (/noWait:\s*z\./.test(code)) throw new Error('noWait 仍然暴露在 schema 里');
});

test('桥接侧仍然接受 gapMode（兼容手写调用，不该跟着删）', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  if (!/body\.gapMode === 'fixed'/.test(bridge)) {
    throw new Error('桥接侧的 gapMode 分支被误删 —— 手写 HTTP 调用会失去 fixed 能力');
  }
});

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
void execFileSync;
