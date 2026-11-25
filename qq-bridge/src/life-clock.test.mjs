// life-clock.js 的单元测试。
//
// 全部离线跑，不需要 SnowLuma / DSH / 网络：
//   node --test src/life-clock.test.mjs
//
// 断言的来源：
//   · 节气 —— 天文算法算出来再跟下面这张**人工核对过的 2026 年表**比。
//     表的依据是太阳视黄经（每 15° 一个节气）换算成北京时间后的日期。
//     只要哪天有人把公式改坏，这里立刻红。
//   · 农历 —— 用几个已知锚点（2026 春节 = 2 月 17 日、中秋 = 八月十五）。
//   · 除夕 —— 腊月最后一天，随年份变，专门测 2026 是 2 月 16 日。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  partsOf,
  lunarOf,
  solarTermOf,
  nextSolarTerm,
  lunarFestivalOf,
  buildNowLine,
  describeGap,
  DEFAULT_TZ
} from './life-clock.js';

const at = (iso) => new Date(iso).getTime();

// 2026 年 24 个节气（北京时间，日期级）。
const TERMS_2026 = {
  '小寒': '2026-01-05', '大寒': '2026-01-20', '立春': '2026-02-04', '雨水': '2026-02-18',
  '惊蛰': '2026-03-05', '春分': '2026-03-20', '清明': '2026-04-05', '谷雨': '2026-04-20',
  '立夏': '2026-05-05', '小满': '2026-05-21', '芒种': '2026-06-05', '夏至': '2026-06-21',
  '小暑': '2026-07-07', '大暑': '2026-07-23', '立秋': '2026-08-07', '处暑': '2026-08-23',
  '白露': '2026-09-07', '秋分': '2026-09-23', '寒露': '2026-10-08', '霜降': '2026-10-23',
  '立冬': '2026-11-07', '小雪': '2026-11-22', '大雪': '2026-12-07', '冬至': '2026-12-22'
};

test('partsOf：时区与星期正确', () => {
  const p = partsOf(at('2026-11-23T21:47:00+08:00'));
  assert.equal(p.ymd, '2026-11-23');
  assert.equal(p.weekday, '周一');
  assert.equal(p.hm, '21:47');
  assert.equal(p.monthDay, '11-23');
});

test('partsOf：UTC 输入按指定时区换算（跨天边界）', () => {
  // 2026-11-23T16:30Z = 北京时间 11-24 00:30，必须算到 24 号
  const p = partsOf(Date.parse('2026-11-23T16:30:00Z'));
  assert.equal(p.ymd, '2026-11-24');
  // en-CA 的 hour 是两位数（00:30），不是 0:30 —— 别按直觉断错。
  assert.equal(p.hm, '00:30');
});

test('partsOf：时区名写错不抛错，退回系统时区', () => {
  const p = partsOf(Date.now(), 'Asia/Not_A_Zone');
  assert.ok(p);
  assert.ok(p.ymd);
});

test('lunarOf：已知农历锚点', () => {
  const spring = lunarOf(at('2026-02-17T12:00:00+08:00'));
  assert.equal(spring.monthText, '正月初一'.slice(0, 2));
  assert.equal(spring.dayNum, 1);
  assert.equal(spring.isFirstDay, true);
  assert.equal(lunarFestivalOf(at('2026-02-17T12:00:00+08:00')), '春节');

  const mid = lunarOf(at('2026-09-25T12:00:00+08:00'));
  assert.equal(mid.monthNum, 8);
  assert.equal(mid.dayNum, 15);
  assert.equal(mid.isFullMoon, true);
  assert.equal(lunarFestivalOf(at('2026-09-25T12:00:00+08:00')), '中秋');
});

test('lunarFestivalOf：除夕是腊月最后一天', () => {
  assert.equal(lunarFestivalOf(at('2026-02-16T12:00:00+08:00')), '除夕');
  assert.equal(lunarFestivalOf(at('2026-02-18T12:00:00+08:00')), '');
});

test('solarTermOf：2026 年 24 个节气逐条核对', () => {
  for (const [name, date] of Object.entries(TERMS_2026)) {
    const hit = solarTermOf(at(`${date}T12:00:00+08:00`));
    assert.ok(hit, `${date} 应当是 ${name}`);
    assert.equal(hit.name, name, `${date} 应为 ${name}，实际 ${hit && hit.name}`);
  }
});

test('solarTermOf：非节气日返回 null', () => {
  assert.equal(solarTermOf(at('2026-03-10T12:00:00+08:00')), null);
});

test('nextSolarTerm：跨年也能找到', () => {
  const n = nextSolarTerm(at('2026-12-25T12:00:00+08:00'));
  assert.ok(n);
  assert.equal(n.name, '小寒');
});

test('buildNowLine：普通日子不贴括号', () => {
  const line = buildNowLine(at('2026-03-10T14:30:00+08:00'));
  assert.match(line, /^【现在】3-10 周二 14:30/);
  assert.ok(!line.includes('（'), '普通日子不该有括号标记');
});

test('buildNowLine：节气当天贴节气', () => {
  const line = buildNowLine(at('2026-11-07T10:00:00+08:00'));
  assert.match(line, /（立冬）/);
});

test('buildNowLine：春节只贴节日不重复贴初一', () => {
  const line = buildNowLine(at('2026-02-17T08:00:00+08:00'));
  assert.match(line, /（春节）/);
  assert.ok(!line.includes('农历正月初一'), '春节不该再重复农历日');
});

test('buildNowLine：普通初一贴农历', () => {
  // 2026-03-19 是农历二月初一（春节 2/17 正月初一 + 29/30 天）
  const line = buildNowLine(at('2026-03-19T08:00:00+08:00'));
  assert.match(line, /农历/, `期望贴农历，实际：${line.trim()}`);
});

test('buildNowLine：extras 独立成【状态】行，按顺序、过滤空值', () => {
  const line = buildNowLine(at('2026-11-23T21:47:00+08:00'), {
    extras: ['饱腹：饱', '', null, '精力：困']
  });
  // 2026-11-23 改：状态不再缀在时间后面，而是独立一行 ——
  // 光一个「饿」字在长提示词里容易被当成别的意思，加标签+分行才没有歧义。
  assert.match(line, /^【现在】11-23 周一 21:47/m);
  assert.match(line, /^【状态】饱腹：饱　精力：困$/m);
});

test('buildNowLine：extras 为空时不产生【状态】行', () => {
  const line = buildNowLine(at('2026-11-23T21:47:00+08:00'), { extras: [] });
  assert.ok(!line.includes('【状态】'), `不该有空状态行：${JSON.stringify(line)}`);
  const line2 = buildNowLine(at('2026-11-23T21:47:00+08:00'), { extras: ['', null] });
  assert.ok(!line2.includes('【状态】'));
});

test('buildNowLine：带括号的整句**另起一行**，不并进【状态】', () => {
  // 2026-11-24 定的规则：【状态】是"状态项列表"（饿了/精力/心情），
  // 而「（醒了，睡得还行　梦见…）」是一句完整的话 —— 塞进列表末尾
  // 读起来像第八个状态项。
  const line = buildNowLine(at('2026-11-23T21:47:00+08:00'), {
    extras: ['饿了，想吃东西', '精力：还好', '（醒了，睡得还行　梦见吃到很好吃的东西）']
  });
  const rows = line.split('\n').filter((r) => r.trim());
  const stateRow = rows.find((r) => r.startsWith('【状态】'));
  assert.equal(stateRow, '【状态】饿了，想吃东西　精力：还好', '状态行不该含括号句');
  const sentenceRow = rows.find((r) => r.startsWith('（'));
  assert.ok(sentenceRow, '括号句应当独立成行');
  assert.ok(!sentenceRow.includes('【状态】'));
});

test('buildNowLine：只有句子没有状态项时，不输出空的【状态】', () => {
  const line = buildNowLine(at('2026-11-23T21:47:00+08:00'), {
    extras: ['（醒了，睡得很踏实）']
  });
  assert.ok(!line.includes('【状态】'), `不该有空状态行：${JSON.stringify(line)}`);
  assert.ok(line.includes('（醒了，睡得很踏实）'));
});

test('buildNowLine：句子行在【状态】行**之后**（顺序固定）', () => {
  const line = buildNowLine(at('2026-11-23T21:47:00+08:00'), {
    extras: ['（醒了，睡得还行）', '饿了，想吃东西']
  });
  const iState = line.indexOf('【状态】');
  const iSentence = line.indexOf('（醒了');
  assert.ok(iState >= 0 && iSentence >= 0);
  assert.ok(iState < iSentence, '状态行应在句子之前（不受传入顺序影响）');
});

test('buildNowLine：永远以两个换行结尾（与唤醒包其它段一致）', () => {
  const line = buildNowLine(Date.now());
  assert.ok(line.endsWith('\n\n'));
});

test('buildNowLine：非法时间返回空串而不是抛错', () => {
  assert.equal(buildNowLine(NaN), '');
  assert.equal(buildNowLine(undefined), buildNowLine(undefined)); // 不抛即可
});

test('describeGap：分档正确', () => {
  const now = at('2026-11-23T21:00:00+08:00');
  assert.equal(describeGap(now - 30_000, now), '');
  assert.equal(describeGap(now - 20 * 60_000, now), '20 分钟');
  assert.equal(describeGap(now - 3 * 3600_000, now), '3 小时');
  assert.equal(describeGap(now - 50 * 3600_000, now), '2 天');
  assert.equal(describeGap(0, now), '');
});

test('默认时区是 Asia/Shanghai', () => {
  assert.equal(DEFAULT_TZ, 'Asia/Shanghai');
});
