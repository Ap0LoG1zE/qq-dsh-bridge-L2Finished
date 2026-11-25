// computeRange / parseArgs 的单元测试（纯函数，不依赖 DSH）。
//
// 这两个函数决定了「压哪儿、留哪儿」，算错一次就是丢历史，必须钉住。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __test } from './index.js';

const { computeRange, parseArgs } = __test;

/** 造节点：tokens 可控。节点 0 当 system。 */
function makeNodes(tokenList) {
  return tokenList.map((tokens, i) => ({ seq: i * 10 + 1, tokens }));
}

test('保留尾部 20 万：切点在累加到 retainTokens 的位置', () => {
  // 节点 0 = system(500)
  // 1..10 = 每个 3 万 → 共 30 万
  const nodes = makeNodes([500, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]);
  const r = computeRange(nodes, 200000);
  assert.ok(r, '应当有可压区间');
  // 从尾往头累加：10,9,8,7,6,5 → 6 个 3 万 = 18 万 < 20 万；
  // 再加 4 → 21 万 >= 20 万，所以 keepFromIdx = 4
  assert.equal(r.keptFrom, nodes[4].seq, '保留起点应是 index 4');
  assert.equal(r.end, nodes[3].seq, '压缩终点应是保留起点的前一个');
  assert.ok(r.keptTokens >= 200000, `保留量 ${r.keptTokens} 应 >= 20 万`);
});

test('历史不够长时不压（保留量覆盖全部）', () => {
  const nodes = makeNodes([500, 30000, 30000]);  // 共 6 万
  const r = computeRange(nodes, 200000);
  assert.equal(r, null, '6 万 < 20 万，不该压');
});

test('节点太少时返回 null（避免压掉 system 或唯一一条）', () => {
  assert.equal(computeRange(makeNodes([500]), 1000), null);
  assert.equal(computeRange(makeNodes([500, 100]), 1000), null);
  assert.equal(computeRange([], 1000), null);
  assert.equal(computeRange(null, 1000), null);
});

test('system 节点（index 0）永远不进压缩区间', () => {
  const nodes = makeNodes([999999, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]);
  const r = computeRange(nodes, 100000);
  assert.ok(r);
  assert.notEqual(r.start, nodes[0].seq, 'start 不能是 system 节点');
  assert.equal(r.start, nodes[1].seq, 'start 应从 index 1 开始');
});

test('retainTokens 极小 → 尽量多压，但仍保留至少一个节点', () => {
  const nodes = makeNodes([500, 1000, 1000, 1000, 1000]);
  const r = computeRange(nodes, 1);
  assert.ok(r);
  assert.equal(r.keptFrom, nodes[4].seq, '只保留最后一个');
  assert.equal(r.end, nodes[3].seq);
});

test('compactedTokens 与 keptTokens 之和不含 system', () => {
  const nodes = makeNodes([500, 10000, 10000, 10000, 10000]);
  const r = computeRange(nodes, 20000);
  assert.ok(r);
  const sumNoSystem = nodes.slice(1).reduce((s, n) => s + n.tokens, 0);
  assert.equal(r.compactedTokens + r.keptTokens, sumNoSystem);
});

// ── parseArgs ────────────────────────────────────────────────────────
test('parseArgs：无参数 → 非 dry，用默认保留量', () => {
  assert.deepEqual(parseArgs('', 200000), { dry: false, retainTokens: 200000 });
  assert.deepEqual(parseArgs(undefined, 200000), { dry: false, retainTokens: 200000 });
});

test('parseArgs：dry 别名', () => {
  for (const s of ['dry', '--dry', '-d', 'DRY', 'Dry']) {
    assert.equal(parseArgs(s, 200000).dry, true, `${s} 应识别为 dry`);
  }
});

test('parseArgs：数字覆盖保留量', () => {
  assert.deepEqual(parseArgs('150000', 200000), { dry: false, retainTokens: 150000 });
  assert.deepEqual(parseArgs('dry 80000', 200000), { dry: true, retainTokens: 80000 });
  assert.deepEqual(parseArgs('80000 dry', 200000), { dry: true, retainTokens: 80000 });
});

test('parseArgs：非法数字忽略', () => {
  assert.deepEqual(parseArgs('abc', 200000), { dry: false, retainTokens: 200000 });
  assert.deepEqual(parseArgs('-5', 200000), { dry: false, retainTokens: 200000 });
  assert.deepEqual(parseArgs('0', 200000), { dry: false, retainTokens: 200000 });
});
