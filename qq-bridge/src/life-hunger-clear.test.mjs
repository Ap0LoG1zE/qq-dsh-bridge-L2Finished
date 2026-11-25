// 「吃过饭要清掉饿了类 condition」测试（2026-11-24）。
//
// 起因（实测 18:46）：
//   【状态】不饿　精力：还好　心情：柔软　想吃甜的　饿了，想吃点热的
//   —— satiety 已经是 59（她调 qq_life_circle 说吃过了），
//      但「饿了，想吃点热的」还挂在唤醒词里。
//
// 根因：qq_life_circle 的 satiety 加值只动**数字**，不动 condition。
//   数值和文字因此可以完全矛盾。
//
// 修法：只要这次调用抬了 satiety，就把 meal 类 + 任何 label 含"饿"的 condition 全清掉。
//   不看加了多少 —— 她主动调这个工具本身就是"我吃了"这个事实。

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 复刻 bridge.js 里的清理谓词，供测试。
 * @param {object[]} list
 * @returns {object[]} 清理后的列表
 */
function clearHungerConditions(list) {
  return list.filter((c) => {
    if (c.kind === 'meal') return false;
    if (/饿/.test(String(c.label || ''))) return false;
    return true;
  });
}

const meal = (label = '饿了，想吃点热的') => ({ kind: 'meal', label, endTs: Date.now() + 3600000 });
const other = (kind, label) => ({ kind, label, endTs: Date.now() + 3600000 });

test('meal 类条件一律被清掉', () => {
  const list = [meal('想吃甜的'), meal('饿了，想吃点热的')];
  assert.deepEqual(clearHungerConditions(list), []);
});

test('其它 kind 但 label 含"饿"的也被清掉', () => {
  // 比如将来如果给 hunger 单独开一个 kind，这里也能兜住。
  const list = [other('hunger', '有点饿，想吃点东西')];
  assert.deepEqual(clearHungerConditions(list), []);
});

test('无关条件不受影响', () => {
  const list = [
    other('sleep', '睡得有点浅，夜里醒过几次'),
    other('health', '嗓子干痒，说话有点费劲'),
    other('cycle_discomfort', '今天有点痛经，小腹闷闷的不舒服'),
    other('care_warmth', '被关心了一下，心里软了一点')
  ];
  assert.equal(clearHungerConditions(list).length, 4, '这些都不该被误删');
});

test('混合场景：只清饿的，其它保留', () => {
  const list = [
    meal('想吃甜的'),
    other('sleep', '睡得有点浅'),
    other('hunger', '饿了'),
    other('health', '有点不舒服')
  ];
  const kept = clearHungerConditions(list);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((c) => c.kind).sort(), ['health', 'sleep']);
});

test('空列表不出错', () => {
  assert.deepEqual(clearHungerConditions([]), []);
});

test('label 为空时不该被 /饿/ 误伤', () => {
  // 空 label 的 condition 很多（sleep 的数值条件 label 就是空串），
  // 如果不判空就直接正则，`/饿/.test('')` 是 false，安全；
  // 但这里明确锁一下，防止以后有人把条件写反。
  const list = [{ kind: 'sleep', label: '', endTs: Date.now() + 1000 }];
  assert.equal(clearHungerConditions(list).length, 1);
});

test('「饿」只在 label 里判，不看 kind 名', () => {
  // 万一以后有个 kind 叫 'hungry_but_full' 但不该清 —— 当前规则是
  // **只认 label**，kind 只特判 'meal'。这条锁住这个语义。
  const list = [{ kind: 'hungry_but_full', label: '吃得很饱', endTs: Date.now() + 1000 }];
  assert.equal(clearHungerConditions(list).length, 1, 'label 不含"饿"就不该清');
});
