// life-weather.js 单元测试：纯离线（不真联网）。
//   node --test src/life-weather.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  weatherTextOf,
  buildWeatherUrl,
  parseWeather,
  weatherShortText,
  createWeatherCache
} from './life-weather.js';

const NOW = new Date('2026-11-24T12:00:00+08:00').getTime();

const sample = (over = {}) => ({
  current: {
    time: '2026-11-24T11:45',
    temperature_2m: 19.4,
    apparent_temperature: 20.1,
    weather_code: 61,
    is_day: 1,
    ...over.current
  },
  daily: {
    sunrise: ['2026-11-24T06:46'],
    sunset: ['2026-11-24T17:40'],
    ...over.daily
  }
});

test('weatherTextOf：常见码正确', () => {
  assert.equal(weatherTextOf(0), '晴');
  assert.equal(weatherTextOf(3), '阴');
  assert.equal(weatherTextOf(61), '雨');
  assert.equal(weatherTextOf(71), '雪');
  assert.equal(weatherTextOf(95), '雷雨');
});

test('weatherTextOf：越界/未知码返回空串（绝不编造）', () => {
  // 这条是修过一个真 bug 的：曾经写成 `c >= 95`，于是 999 被当成雷雨。
  for (const c of [100, 999, -1, NaN, undefined, 'abc']) {
    assert.equal(weatherTextOf(c), '', `code=${c} 应当返回空串`);
  }
});

test('buildWeatherUrl：坐标无效返回空串', () => {
  assert.equal(buildWeatherUrl({ lat: NaN, lon: 113 }), '');
  assert.equal(buildWeatherUrl({}), '');
});

test('buildWeatherUrl：包含必要参数', () => {
  const url = buildWeatherUrl({ lat: 23.13, lon: 113.26 });
  assert.match(url, /latitude=23\.13/);
  assert.match(url, /longitude=113\.26/);
  assert.match(url, /weather_code/);
  assert.match(url, /timezone=/);
});

test('parseWeather：正常载荷', () => {
  const w = parseWeather(sample(), NOW);
  assert.equal(w.text, '雨');
  assert.equal(w.tempC, 19);
  assert.equal(w.feelsC, 20);
  assert.equal(w.isDay, true);
  assert.equal(w.sunrise, '06:46');
  assert.equal(w.sunset, '17:40');
});

test('parseWeather：缺 current → null', () => {
  assert.equal(parseWeather({}, NOW), null);
  assert.equal(parseWeather(null, NOW), null);
});

test('parseWeather：温度缺失 → null（不填 0）', () => {
  assert.equal(parseWeather(sample({ current: { temperature_2m: undefined } }), NOW), null);
});

test('parseWeather：天气码不认识 → null', () => {
  assert.equal(parseWeather(sample({ current: { weather_code: 999 } }), NOW), null);
});

test('parseWeather：没有 sunrise/sunset 时给空串而不是编', () => {
  const w = parseWeather({ current: sample().current }, NOW);
  assert.equal(w.sunrise, '');
  assert.equal(w.sunset, '');
});

test('weatherShortText：形如「雨 19°」', () => {
  assert.equal(weatherShortText({ text: '雨', tempC: 19 }), '雨 19°');
  assert.equal(weatherShortText({ text: '晴' }), '晴');
  assert.equal(weatherShortText(null), '');
});

test('createWeatherCache：首次 refresh 后能 peek 到', async () => {
  let calls = 0;
  const c = createWeatherCache({
    configOf: () => ({ lat: 23.13, lon: 113.26 }),
    fetchJson: async () => { calls += 1; return sample(); },
    now: () => NOW
  });
  assert.equal(c.peek(), null);
  await c.refresh();
  assert.equal(calls, 1);
  assert.equal(c.peek().text, '雨');
});

test('createWeatherCache：TTL 内不重复请求', async () => {
  let calls = 0;
  let t = NOW;
  const c = createWeatherCache({
    configOf: () => ({ lat: 23, lon: 113 }),
    fetchJson: async () => { calls += 1; return sample(); },
    ttlMs: 1000,
    now: () => t
  });
  await c.refresh();
  t += 500;
  await c.refresh();
  assert.equal(calls, 1, 'TTL 内不该再打接口');
  t += 1000;
  await c.refresh();
  assert.equal(calls, 2);
});

test('createWeatherCache：请求失败保留旧值（不像素级崩）', async () => {
  let fail = false;
  let t = NOW;
  const c = createWeatherCache({
    configOf: () => ({ lat: 23, lon: 113 }),
    fetchJson: async () => {
      if (fail) throw new Error('network down');
      return sample();
    },
    ttlMs: 100,
    now: () => t
  });
  await c.refresh();
  const good = c.peek();
  assert.ok(good);
  fail = true;
  t += 200;
  await c.refresh();
  // 旧值还在，只是可能被标记 stale
  assert.equal(c.peek().text, good.text);
  assert.match(c.lastError, /network down/);
});

test('createWeatherCache：没有配置时不发请求', async () => {
  let calls = 0;
  const c = createWeatherCache({
    configOf: () => null,
    fetchJson: async () => { calls += 1; return sample(); },
    now: () => NOW
  });
  await c.refresh();
  assert.equal(calls, 0);
  assert.equal(c.peek(), null);
  assert.equal(c.lastError, 'no-config');
});

test('createWeatherCache：载荷坏掉不覆盖旧值', async () => {
  let bad = false;
  let t = NOW;
  const c = createWeatherCache({
    configOf: () => ({ lat: 23, lon: 113 }),
    fetchJson: async () => (bad ? {} : sample()),
    ttlMs: 100,
    now: () => t
  });
  await c.refresh();
  const good = c.peek().text;
  bad = true;
  t += 200;
  await c.refresh();
  assert.equal(c.peek().text, good);
  assert.equal(c.lastError, 'bad-payload');
});
