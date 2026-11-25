// life-conditions.js 单元测试：纯离线。
//   node --test src/life-conditions.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSITIONS,
  normalizeConditions,
  activeConditions,
  expiredConditions,
  composeEnergy,
  composeMood,
  reapExpired,
  makeCondition,
  removeConditions,
  upsertCondition
} from './life-conditions.js';

const H = 3600000;
const NOW = new Date('2026-11-24T12:00:00+08:00').getTime();
const c = (over = {}) => ({
  id: 'x', kind: 'test', label: 'L', mood: '', energyDelta: 0, intensity: 50,
  startTs: NOW - H, endTs: NOW + H, phase: '', onEndTransition: '', transitionDone: false,
  ...over
});

test('makeCondition：算出正确的 endTs', () => {
  const cond = makeCondition({ id: 'a', kind: 'health', startTs: NOW, durationHours: 6 });
  assert.equal(cond.startTs, NOW);
  assert.equal(cond.endTs, NOW + 6 * H);
});

test('makeCondition：时长有下限（不会造出立即过期的）', () => {
  const cond = makeCondition({ id: 'a', kind: 'x', startTs: NOW, durationHours: 0 });
  assert.ok(cond.endTs > cond.startTs);
});

test('normalizeConditions：丢掉坏数据而不抛错', () => {
  const list = normalizeConditions([
    null, {}, { id: '', kind: 'x' }, { id: 'a', kind: '' },
    { id: 'ok', kind: 'k', startTs: NOW, endTs: NOW + H },
    { id: 'bad', kind: 'k', startTs: NOW, endTs: NOW }        // endTs <= startTs
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ok');
  assert.deepEqual(normalizeConditions('not-an-array'), []);
});

test('activeConditions：只返回 now 落在区间内的', () => {
  const list = [
    c({ id: 'past', startTs: NOW - 3 * H, endTs: NOW - H }),
    c({ id: 'now', startTs: NOW - H, endTs: NOW + H }),
    c({ id: 'future', startTs: NOW + H, endTs: NOW + 2 * H })
  ];
  const act = activeConditions(list, NOW);
  assert.deepEqual(act.map((x) => x.id), ['now']);
});

test('activeConditions：边界是左闭右开', () => {
  const at = c({ id: 'edge', startTs: NOW, endTs: NOW + H });
  assert.equal(activeConditions([at], NOW).length, 1, 'startTs 那一刻算活着');
  assert.equal(activeConditions([at], NOW + H).length, 0, 'endTs 那一刻算过期');
});

test('expiredConditions：找出已经过期的', () => {
  const list = [
    c({ id: 'past', endTs: NOW - 1 }),
    c({ id: 'now', endTs: NOW + H })
  ];
  assert.deepEqual(expiredConditions(list, NOW).map((x) => x.id), ['past']);
});

test('composeEnergy：叠加所有活跃 condition 的 delta', () => {
  const list = [
    c({ id: 'a', energyDelta: -12 }),
    c({ id: 'b', energyDelta: -8 }),
    c({ id: 'past', energyDelta: -50, endTs: NOW - 1 })
  ];
  const r = composeEnergy(70, list, NOW);
  assert.equal(r.value, 50, '70 - 12 - 8 = 50（过期的不算）');
  assert.equal(r.delta, -20);
  assert.equal(r.applied.length, 2);
});

test('composeEnergy：结果被夹在 0~100', () => {
  assert.equal(composeEnergy(10, [c({ energyDelta: -99 })], NOW).value, 0);
  assert.equal(composeEnergy(90, [c({ energyDelta: 99 })], NOW).value, 100);
});

test('composeEnergy：不改写传入的 base', () => {
  const base = 70;
  composeEnergy(base, [c({ energyDelta: -20 })], NOW);
  assert.equal(base, 70);
});

test('composeMood：取 intensity 最高的那个 mood', () => {
  const list = [
    c({ id: 'a', mood: '疲惫', intensity: 30 }),
    c({ id: 'b', mood: '轻快', intensity: 80 }),
    c({ id: 'c', mood: '迟钝', intensity: 50 })
  ];
  const r = composeMood(list, NOW);
  assert.equal(r.mood, '轻快');
  assert.equal(r.from.id, 'b');
});

test('composeMood：没有带 mood 的活跃 condition 时返回空', () => {
  assert.equal(composeMood([c({ mood: '' })], NOW).mood, '');
  assert.equal(composeMood([c({ mood: '疲惫', endTs: NOW - 1 })], NOW).mood, '');
  assert.equal(composeMood([], NOW).mood, '');
});

test('reapExpired：自然到期 + 有 transition → 生成尾声，原条不再保留', () => {
  const list = [c({ id: 'sick', endTs: NOW - 1, onEndTransition: TRANSITIONS.HEALTH_RELIEF })];
  const { list: next, created } = reapExpired(list, NOW, (exp) => makeCondition({
    id: `after-${exp.id}`, kind: 'afterglow', startTs: exp.expiredAt, durationHours: 6
  }));
  assert.equal(created.length, 1);
  assert.equal(next.length, 1);
  assert.equal(next[0].kind, 'afterglow');
});

test('reapExpired：没有 transition 的到期就直接消失', () => {
  const list = [c({ id: 'plain', endTs: NOW - 1, onEndTransition: '' })];
  const { list: next, created } = reapExpired(list, NOW, () => null);
  assert.equal(created.length, 0);
  assert.equal(next.length, 0);
});

test('reapExpired：还没到期的原样留着', () => {
  const list = [c({ id: 'alive', endTs: NOW + H, onEndTransition: TRANSITIONS.HEALTH_RELIEF })];
  const { list: next, created } = reapExpired(list, NOW, () => null);
  assert.equal(next.length, 1);
  assert.equal(created.length, 0);
});

test('reapExpired：makeTransition 抛错时不影响其它条', () => {
  const list = [
    c({ id: 'boom', endTs: NOW - 1, onEndTransition: TRANSITIONS.HEALTH_RELIEF }),
    c({ id: 'alive', endTs: NOW + H })
  ];
  const { list: next } = reapExpired(list, NOW, () => { throw new Error('x'); });
  assert.deepEqual(next.map((x) => x.id), ['alive']);
});

test('removeConditions：按谓词移除', () => {
  const list = [c({ id: 'a', kind: 'health' }), c({ id: 'b', kind: 'sleep' })];
  const next = removeConditions(list, (x) => x.kind === 'health');
  assert.deepEqual(next.map((x) => x.id), ['b']);
});

test('upsertCondition：同 id 覆盖，不重复插入', () => {
  const base = [c({ id: 'a', label: '旧' })];
  const next = upsertCondition(base, c({ id: 'a', label: '新' }));
  assert.equal(next.length, 1);
  assert.equal(next[0].label, '新');
  const added = upsertCondition(base, c({ id: 'b' }));
  assert.equal(added.length, 2);
});

test('TRANSITIONS 常量齐全', () => {
  assert.equal(TRANSITIONS.NONE, '');
  assert.equal(TRANSITIONS.HEALTH_RELIEF, 'health_relief');
  assert.equal(TRANSITIONS.SLEEP_REBOUND, 'sleep_rebound');
  assert.equal(TRANSITIONS.SOFT_AFTERGLOW, 'soft_afterglow');
});
