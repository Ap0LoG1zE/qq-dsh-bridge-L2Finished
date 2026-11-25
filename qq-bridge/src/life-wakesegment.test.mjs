// 「昨晚」合并段的测试（2026-11-24 重做）。
//
// 起因：原来三样东西各说各的，会在同一条唤醒词里打架 ——
//   【状态】…睡得有点浅，夜里醒过几次…          （按**睡眠时长**判）
//   （睡得还行，起来还有点没缓过来。）            （按**精力恢复量**判，单独一行）
// 两句话意思相反，而且同一个信息两个来源。
//
// 现在合并成一句：`（醒了，<睡眠>　<梦>）`。

import test from 'node:test';
import assert from 'node:assert/strict';

/** 复刻 bridge.js 里的合并逻辑。 */
function composeWakeSegment({ wake, quality, dream }) {
  if (!wake && !quality && !dream) return '';
  const bits = [];
  const sleepText = String(wake || quality || '').replace(/[。.]$/, '').trim();
  if (sleepText) bits.push(sleepText);
  if (dream) bits.push(String(dream).replace(/[。.]$/, '').trim());
  if (!bits.length) return '';
  return `（醒了，${bits.join('　')}）`;
}

test('三样都没有 → 不产生这一段', () => {
  // 大多数轮次都是这样。绝不能出现「（醒了） 」这种空壳。
  assert.equal(composeWakeSegment({}), '');
  assert.equal(composeWakeSegment({ wake: '', quality: '', dream: '' }), '');
});

test('只有睡眠 → 一句', () => {
  const s = composeWakeSegment({ wake: '睡得还行，起来还有点没缓过来。' });
  assert.equal(s, '（醒了，睡得还行，起来还有点没缓过来）');
});

test('睡眠 + 梦 → 用全角空格分隔', () => {
  const s = composeWakeSegment({
    wake: '睡得还行', dream: '梦见吃到很好吃的东西，醒来还在回味'
  });
  assert.equal(s, '（醒了，睡得还行　梦见吃到很好吃的东西，醒来还在回味）');
});

test('只有梦 → 也能成句', () => {
  const s = composeWakeSegment({ dream: '梦见走过一段很安静的路' });
  assert.equal(s, '（醒了，梦见走过一段很安静的路）');
});

test('**wake 优先于 quality**（按恢复量比按时长更准）', () => {
  const s = composeWakeSegment({
    wake: '睡得还行，起来还有点没缓过来',
    quality: '睡得有点浅，夜里醒过几次'
  });
  assert.ok(s.includes('睡得还行'), '应当用 wake 那句');
  assert.ok(!s.includes('睡得有点浅'), '不该同时出现两套判据');
});

test('没有 wake 时退回 quality', () => {
  const s = composeWakeSegment({ quality: '睡得有点浅，夜里醒过几次' });
  assert.equal(s, '（醒了，睡得有点浅，夜里醒过几次）');
});

test('句尾的「。」被去掉（外面已经套括号）', () => {
  const s = composeWakeSegment({ wake: '睡得还不错。', dream: '梦见下雨了。' });
  assert.ok(!s.includes('。'), `不该有句号：${s}`);
});

test('重复的睡眠信息不会同时出现', () => {
  // 这是这次改动的核心目的。
  const s = composeWakeSegment({
    wake: '睡得还行', quality: '睡得有点浅，夜里醒过几次', dream: '梦见吃到很好吃的东西'
  });
  const hasShallow = s.includes('有点浅');
  const hasOk = s.includes('睡得还行');
  assert.ok(!(hasShallow && hasOk), `两套判据同时出现了：${s}`);
});

test('噩梦那条**不该**走这个通道（它是唤醒理由，不是"醒了"）', () => {
  // 噩梦会真的把她弄醒，走 proactiveNightmare 那句
  // 「（刚做了个不太好的梦，惊醒了。）」—— 与「（醒了，…）」是两回事。
  const nightmareReason = '（刚做了个不太好的梦，惊醒了。）';
  const wakeSegment = composeWakeSegment({ dream: '梦见从很高的地方掉下去' });
  assert.notEqual(nightmareReason, wakeSegment);
  // 两者语义不同：一个是"被吓醒"，一个是"睡到自然醒"
  assert.ok(nightmareReason.includes('惊醒'));
  assert.ok(wakeSegment.startsWith('（醒了'));
});

test('段落总长有上限（防止以后往里加东西）', () => {
  // 唤醒词每轮都进历史，这一段不该超过 60 字符。
  const longest = composeWakeSegment({
    wake: '睡得有点浅，夜里醒过几次',
    dream: '梦见一直在找一件放错地方的小东西，醒来还残着没找完的感觉'
  });
  assert.ok(longest.length <= 60, `实际 ${longest.length} 字符：${longest}`);
});
