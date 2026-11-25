// life-proactive.js 单元测试：纯离线。
//   node --test src/life-proactive.test.mjs
//
// ⚠️ 本文件里所有**中文断言都是原文**（AstrBot private_companion_v2 @ v6.7.2）。
//    改文案前先去原作者仓库核对；如果原文变了，这些断言要跟着变，
//    而不是顺手把断言改成"看起来也合理"的新句子。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIORITY,
  MORNING_BASE,
  morningWindow,
  morningCandidates,
  daypartCandidates,
  weatherCandidates,
  buildProactiveCandidates,
  candidateMotiveLine,
  chainStepAt,
  hasChain,
  pickWeatherWindow
} from './life-proactive.js';

const at = (h, m = 0) => h * 60 + m;
const yes = () => 0;          // 一律命中
const no = () => 0.999999;    // 一律不命中

// ── 窗口计算（照抄原作者 morning_window）───────────────────────────────────

test('morningWindow：与原作者算法一致', () => {
  // start = min(8:20+delay, 9:42)；end = min(9:50, max(start+8, start+span))
  assert.deepEqual(morningWindow(3, 24), { start: at(8, 23), end: at(8, 47) });
  assert.deepEqual(morningWindow(6, 28), { start: at(8, 26), end: at(8, 54) });
  assert.deepEqual(morningWindow(10, 30), { start: at(8, 30), end: at(9, 0) });
});

// ── 早晨 ───────────────────────────────────────────────────────────────────

test('早晨：睡浅那一支的 motive 是原文', () => {
  const out = morningCandidates({ minuteOfDay: at(9), energy: 80, sleepHours: 5, rand: yes });
  assert.equal(out.length, 1);
  assert.equal(out[0].motive, '昨晚没睡好，醒来还带着睡意，想先轻轻说声早安');
  assert.equal(out[0].mood, '迟钝');
});

test('早晨：睡得好那一支的 motive 是原文', () => {
  const out = morningCandidates({ minuteOfDay: at(9), energy: 80, sleepHours: 8, rand: yes });
  assert.equal(out[0].id, 'morning-fresh');
  assert.equal(out[0].motive, '昨晚睡得挺好，刚起来就想去打个招呼');
  assert.equal(out[0].tone, '清爽');
});

test('早晨：睡浅优先于睡得好（原文 if / elif 的顺序）', () => {
  const out = morningCandidates({ minuteOfDay: at(9), energy: 95, sleepHours: 4, rand: yes });
  assert.equal(out[0].id, 'morning-light');
});

test('早晨：链是三级，时长照原文', () => {
  const out = morningCandidates({ minuteOfDay: at(9), energy: 80, sleepHours: 5, rand: yes });
  const chain = out[0].chain;
  assert.equal(chain.length, 3);
  assert.equal(chain[0].kind, 'name_only_opener');
  assert.equal(chain[1].kind, 'if_no_reply');
  assert.equal(chain[1].after_minutes, 90, '睡浅支是 90 分钟');
  assert.equal(chain[2].kind, 'if_still_no_reply');
  assert.equal(chain[2].after_minutes, 150);
  assert.equal(chain[2].tone, '调侃');
});

test('早晨：睡得好那支的链是 85 / 145（和睡浅不同）', () => {
  const out = morningCandidates({ minuteOfDay: at(9), energy: 80, sleepHours: 8, rand: yes });
  assert.equal(out[0].chain[1].after_minutes, 85);
  assert.equal(out[0].chain[2].after_minutes, 145);
});

test('早晨：窗口外不生成', () => {
  assert.deepEqual(morningCandidates({ minuteOfDay: at(7), energy: 70, rand: yes }), []);
  assert.deepEqual(morningCandidates({ minuteOfDay: at(11), energy: 70, rand: yes }), []);
});

test('早晨：今天已打过招呼就不再生成', () => {
  assert.deepEqual(morningCandidates({ minuteOfDay: at(9), energy: 70, alreadySentToday: true, rand: yes }), []);
});

test('早晨：最多返回一条（原文 return events[:2]，问候不该重复）', () => {
  const out = morningCandidates({ minuteOfDay: at(9), energy: 90, sleepHours: 8, rand: yes });
  assert.ok(out.length <= 1);
});

// ── 白天 ───────────────────────────────────────────────────────────────────

test('白天：中午犯困的 motive / why 是原文', () => {
  const out = daypartCandidates({ minuteOfDay: at(12, 30), energy: 50, rand: yes });
  const c = out.find((x) => x.id === 'noon-sleepy');
  assert.equal(c.motive, '中午这会儿有点犯困，想短短说句话');
  assert.equal(c.why, '中午有些犯困，想短短打声招呼。');
  assert.equal(c.mood, '懒洋洋');
});

test('白天：傍晚天色那条的 motive 是原文', () => {
  const out = daypartCandidates({ minuteOfDay: at(18), energy: 60, weatherText: '晴', rand: yes });
  const c = out.find((x) => x.id === 'evening-sky');
  assert.equal(c.motive, '傍晚路上的天色很好看，想拍给他看看');
  assert.equal(c.mood, '松弛');
});

test('白天：下午问候那条的 motive 是原文', () => {
  const out = daypartCandidates({ minuteOfDay: at(16), energy: 60, rand: yes });
  const c = out.find((x) => x.id === 'afternoon-checkin');
  assert.equal(c.motive, '下午节奏缓下来一点，想看看他是不是也能歇会儿');
  assert.equal(c.impulse, '好奇他在做什么');
});

test('白天：累了一天那条的 motive 是原文', () => {
  const out = daypartCandidates({ minuteOfDay: at(20), energy: 30, rand: yes });
  const c = out.find((x) => x.id === 'evening-tired');
  assert.equal(c.motive, '今天快结束了，累了一天，睡前想聊两句');
  assert.equal(c.tone, '疲惫');
  assert.equal(c.conversation_posture, 'closing');
});

test('白天：睡前还没困那条的 motive 是原文', () => {
  const out = daypartCandidates({ minuteOfDay: at(22, 30), lastNightRestless: true, rand: yes });
  const c = out.find((x) => x.id === 'late-unwilling');
  assert.equal(c.motive, '明明快该睡了，但还是想找他说说话');
  assert.equal(c.mood, '安静');
});

test('白天：小想法那条的 motive 是拼接原文模板', () => {
  const out = daypartCandidates({ minuteOfDay: at(16), thoughtTopic: '窗外的云', rand: yes });
  const c = out.find((x) => x.id === 'ambient-thought');
  assert.equal(c.motive, '刚刚想到“窗外的云”，想顺手分享一下');
  assert.equal(c.why, '日常里突然冒出一个小想法，想短短说一句。');
});

test('白天：各条是独立判断，可以同时成立', () => {
  // 16:00 + energy 60 + 晴：afternoon-checkin 与 ambient-thought 都可能出。
  const out = daypartCandidates({ minuteOfDay: at(16), energy: 60, weatherText: '晴', rand: yes });
  assert.ok(out.length >= 2, `应当出多条，实际 ${out.length}`);
});

test('白天：最多三条（原文 return events[:3]）', () => {
  const out = daypartCandidates({
    minuteOfDay: at(20), energy: 30, lastNightRestless: false, weatherText: '晴', rand: yes
  });
  assert.ok(out.length <= 3);
});

test('白天：rand=1 时一条都不出（概率是闸门）', () => {
  assert.deepEqual(daypartCandidates({ minuteOfDay: at(12, 30), energy: 50, rand: no }), []);
});

// ── 天气 ───────────────────────────────────────────────────────────────────

test('天气：下雨那条的 motive / why 是原文', () => {
  const out = weatherCandidates({ minuteOfDay: at(9), weatherText: '小雨', rand: yes });
  assert.equal(out.length, 1);
  assert.equal(out[0].motive, '听见外面下雨，想短短提一声');
  assert.equal(out[0].why, '外面在下雨，想短短提一句。小雨');
  assert.equal(out[0].mood, '安静');
});

test('天气：晴天那条的 motive 是原文', () => {
  // ⚠️ 必须用晴天窗口内的时段（16-20 点 → 17:10-19:20）。
  //    9 点不在窗口里 —— 原作者也不会在早上 9 点说"傍晚天色不错"。
  const out = weatherCandidates({ minuteOfDay: at(18), weatherText: '晴', rand: yes });
  assert.equal(out[0].motive, '外面天色不错');
  assert.equal(out[0].topic, '天色有点好看');
});

test('天气：没有天气数据就不生成（原文首行直接 return []）', () => {
  assert.deepEqual(weatherCandidates({ minuteOfDay: at(9), weatherText: '', rand: yes }), []);
});

test('天气：最多一条（原文 return events[:1]）', () => {
  const out = weatherCandidates({ minuteOfDay: at(9), weatherText: '多云转小雨', rand: yes });
  assert.ok(out.length <= 1);
});

// ── 汇总与优先级 ───────────────────────────────────────────────────────────

test('优先级：早晨 < 天气 < 白天 < 自发', () => {
  assert.ok(PRIORITY.MORNING < PRIORITY.WEATHER);
  assert.ok(PRIORITY.WEATHER < PRIORITY.DAYPART);
  assert.ok(PRIORITY.DAYPART < PRIORITY.AMBIENT);
});

test('buildProactiveCandidates：结果按优先级升序', () => {
  const out = buildProactiveCandidates({ minuteOfDay: at(9), energy: 70, sleepHours: 5, weatherText: '小雨', rand: yes });
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i - 1].priority <= out[i].priority, '排序不对');
  }
});

test('buildProactiveCandidates：凌晨没有任何理由', () => {
  const out = buildProactiveCandidates({ minuteOfDay: at(3), energy: 80, weatherText: '晴', rand: yes });
  assert.deepEqual(out, []);
});

test('每条候选都带必需字段（天气那类原文没有 tone / impulse）', () => {
  const out = buildProactiveCandidates({ minuteOfDay: at(12, 30), energy: 50, weatherText: '小雨', rand: yes });
  assert.ok(out.length > 0);
  for (const c of out) {
    for (const k of ['id', 'reason', 'motive', 'mood']) {
      assert.ok(c[k], `${c.id} 缺 ${k}`);
    }
    assert.equal(typeof c.priority, 'number');
    // 天气那类在原文里只有 source/weather_linked/window/why/topic/motive/mood，
    // **没有** tone / impulse —— 不要为了整齐硬加，那是偏离婚原文。
    if (c.source === 'weather_context') {
      assert.ok(c.weather_linked === true);
      assert.ok(!('tone' in c), '天气类不该有 tone（原文没有）');
    } else {
      assert.ok(c.tone, `${c.id} 缺 tone`);
    }
  }
});

test('天气窗口：凌晨 3 点不该出任何天气候选（抄漏过一次）', () => {
  // 原文用 _pick_weather_window 按钟点算窗口；第一版漏了它，
  // 导致凌晨也能说"外面天色不错"。这条锁住那个 bug。
  const clear = weatherCandidates({ minuteOfDay: at(3), weatherText: '晴', rand: yes });
  assert.deepEqual(clear, []);
  const rain = weatherCandidates({ minuteOfDay: at(3), weatherText: '小雨', rand: yes });
  assert.deepEqual(rain, []);
});

test('pickWeatherWindow：与原作者的分段一致', () => {
  // rain
  assert.deepEqual(pickWeatherWindow('rain', 8), { start: at(8, 20), end: at(10, 40) });
  assert.deepEqual(pickWeatherWindow('rain', 13), { start: at(12, 40), end: at(16, 30) });
  assert.deepEqual(pickWeatherWindow('rain', 19), { start: at(18, 10), end: at(21, 10) });
  // clear
  assert.deepEqual(pickWeatherWindow('clear', 18), { start: at(17, 10), end: at(19, 20) });
  assert.deepEqual(pickWeatherWindow('clear', 10), { start: at(15, 30), end: at(18, 10) });
});

// ── follow-up 链 ───────────────────────────────────────────────────────────

test('chainStepAt：按序号取链上的步骤', () => {
  const chain = [
    { kind: 'name_only_opener' },
    { kind: 'if_no_reply', after_minutes: 90 },
    { kind: 'if_still_no_reply', after_minutes: 150 }
  ];
  assert.equal(chainStepAt(chain, 0).kind, 'name_only_opener');
  assert.equal(chainStepAt(chain, 1).after_minutes, 90);
  assert.equal(chainStepAt(chain, 2).after_minutes, 150);
  assert.equal(chainStepAt(chain, 3), null, '越界返回 null（绝不多追）');
  assert.equal(chainStepAt(null, 0), null);
  assert.equal(chainStepAt(chain, -1), null);
});

test('hasChain：只有带链的候选才值得排定时器', () => {
  const withChain = morningCandidates({ minuteOfDay: at(9), energy: 80, sleepHours: 5, rand: yes })[0];
  assert.equal(hasChain(withChain), true);
  const noon = daypartCandidates({ minuteOfDay: at(12, 30), energy: 50, rand: yes })[0];
  assert.equal(hasChain(noon), false, '白天那条没有链');
});

test('candidateMotiveLine：正常返回动机，空值返回空串', () => {
  assert.equal(candidateMotiveLine({ motive: '想说话' }), '想说话');
  assert.equal(candidateMotiveLine(null), '');
  assert.equal(candidateMotiveLine({}), '');
});
