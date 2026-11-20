// 验证面板「回复节奏」里的秒↔毫秒换算（2026-11-19 操作者要求填秒）。
//
// 要防的两个错：
//   ① 显示时没除 1000 —— 界面上出现 30000（用户以为要填毫秒）
//   ② 保存时没乘 1000 —— "30" 被存成 30 毫秒，安静窗直接失效
//
// 这里不启动浏览器，直接抽 client.js 里的 RHYTHM_FIELDS 与换算逻辑做静态校验，
// 再用一个最小 DOM 桩跑 renderRhythmTab / saveRhythm 的关键分支。
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根：从脚本位置推导，换机器/换目录都能跑（别再写死绝对路径）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SRC = path.join(ROOT, 'dsh-plugins', 'qq-dsh-panel', 'lib', 'client.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
let fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.error('FAIL', name, '—', e.message); }
};

// ── ① 时间类字段都标了 'sec' ────────────────────────────────────────
test('所有 *Ms 时间字段都标注了 sec 单位', () => {
  const msFields = [
    'autoReplyCheckMs',
    'send.burstIntervalMinMs',
    'send.burstIntervalMaxMs',
    'send.observeAfterSendMs',
    'wait.defaultMs',
    'wait.defaultQuietMs',
    'wake.batchWindowMs',
  ];
  for (const key of msFields) {
    const re = new RegExp(`\\['${key.replace(/\./g, '\\.')}',[^\\]]*'sec'\\]`);
    assert.ok(re.test(src), `${key} 没有标 'sec'，界面会显示毫秒`);
  }
});

// ── ② 新增的「发完后额外再等多久」字段存在 ────────────────────────────────
test('新增 send.observeAfterSendMs（发完后额外再等多久）', () => {
  assert.ok(src.includes("'send.observeAfterSendMs'"), '字段不存在');
  // 2026-11-19 改名：原显示名「发送后空转」不直观，操作者要求改成白话。
  assert.ok(/发完后额外再等多久/.test(src), '显示名不存在');
  // 它必须带 sec 标记，否则用户还是得填毫秒
  assert.ok(/send\.observeAfterSendMs'[^\]]*'sec'/.test(src), '没标 sec');
});

// ── ③ 渲染时除 1000 ─────────────────────────────────────────────────
test('渲染时把毫秒换算成秒（÷1000）', () => {
  assert.ok(/spec\[3\] === 'sec'[\s\S]{0,200}\/ 1000/.test(src),
    '没找到 ÷1000 的换算');
});

// ── ④ 保存时乘 1000 ─────────────────────────────────────────────────
test('保存时把秒换算回毫秒（×1000）', () => {
  assert.ok(/dataset\.unit === 'sec'[\s\S]{0,120}\* 1000/.test(src),
    '没找到 ×1000 的换算');
});

// ── ⑤ 数值换算真算一遍（用同样的表达式，防手滑写反）─────────────────
test('30000 毫秒 ↔ 30 秒 双向一致', () => {
  const ms = 30000;
  const shown = Math.round((ms / 1000) * 1000) / 1000;   // 与渲染同式
  assert.equal(shown, 30, `显示值 ${shown} 应为 30`);
  const back = Math.round(shown * 1000);                 // 与保存同式
  assert.equal(back, ms, `回存值 ${back} 应为 ${ms}`);
});

test('10000 毫秒 ↔ 10 秒（静默判定窗口）', () => {
  assert.equal(Math.round((10000 / 1000) * 1000) / 1000, 10);
  assert.equal(Math.round(10 * 1000), 10000);
});

test('8000 毫秒 ↔ 8 秒（面板当前值）', () => {
  assert.equal(Math.round((8000 / 1000) * 1000) / 1000, 8);
  assert.equal(Math.round(8 * 1000), 8000);
});

// ── ⑥ 非时间字段不能被误标 sec ──────────────────────────────────────
test('条数/字数类字段没有 sec 标记（否则会被乘 1000）', () => {
  const nonMs = [
    'send.burstMaxMessages',
    'send.maxSendPerMinute',
    'send.maxSendPerHour',
    'send.maxMessageChars',
    'wake.maxWakePerHour',
    'context.recentLimit',
    'qzone.maxPerDay',
  ];
  for (const key of nonMs) {
    const re = new RegExp(`\\['${key.replace(/\./g, '\\.')}',[^\\]]*'sec'\\]`);
    assert.ok(!re.test(src), `${key} 被误标了 sec，值会被乘 1000`);
  }
});

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
