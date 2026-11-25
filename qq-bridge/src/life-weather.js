// 天气：Open-Meteo（免密钥）+ 本地缓存。
//
// ── 为什么单独一个文件 ──────────────────────────────────────────────────────
//
// 桥接的唤醒路径是同步的（`text()` 是同步函数），而取天气要发 HTTP。
// 所以这里的设计是**缓存优先**：读的时候永远只读缓存（同步、零延迟），
// 刷新由调用方异步触发，刷新失败保留旧值。
//
// ── 降级铁律 ────────────────────────────────────────────────────────────────
//
// **任何一格拿不到就整格省略，绝不写"未知""N/A""天气获取失败"。**
// 唤醒词每轮都进历史，一句"天气未知"会跟着重发几十次。
// 判不出来就是没有 —— 比编一个更接近真实。

const DEFAULT_TTL_MS = 30 * 60 * 1000;   // 30 分钟：Open-Meteo 自己也只每 15 分钟更新
const FETCH_TIMEOUT_MS = 6000;

/**
 * WMO 天气码 → 中文。
 *
 * 抄的是 AstrBot `_openmeteo_weather_description` 的码表（它也是从 WMO 标准来的）。
 * 只保留我们真会用到的那些 —— "冻毛毛雨"这种在中文对话里不会出现，
 * 归到"毛毛雨"就够了。
 */
export function weatherTextOf(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return '';
  if (c === 0) return '晴';
  if (c === 1) return '少云';
  if (c === 2) return '多云';
  if (c === 3) return '阴';
  if (c === 45 || c === 48) return '雾';
  if (c >= 51 && c <= 57) return '毛毛雨';
  if (c >= 61 && c <= 67) return '雨';
  if (c >= 71 && c <= 77) return '雪';
  if (c >= 80 && c <= 82) return '阵雨';
  if (c === 85 || c === 86) return '阵雪';
  if (c >= 95 && c <= 99) return '雷雨';
  // ⚠️ 必须显式挡住越界值：早期写成 `c >= 95` 时，999 会被当成雷雨，
  //    于是「不认识的码」反而编出一个具体天气 —— 正好违反"判不出来就没有"。
  return '';
}

/**
 * 构造请求 URL。坐标与时区都来自配置，不写死。
 * @param {{lat:number, lon:number, timezone?:string}} opts
 */
export function buildWeatherUrl({ lat, lon, timezone = 'Asia/Shanghai' }) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return '';
  const q = [
    `latitude=${la}`,
    `longitude=${lo}`,
    'current=temperature_2m,apparent_temperature,weather_code,is_day',
    'daily=sunrise,sunset',
    'forecast_days=1',
    `timezone=${encodeURIComponent(timezone)}`
  ];
  return `https://api.open-meteo.com/v1/forecast?${q.join('&')}`;
}

/**
 * 把 API 响应整理成我们需要的形状。**缺项就是 undefined**，不填默认值。
 * @returns {{code:number, text:string, tempC:number, feelsC:number, isDay:boolean,
 *            sunrise:string, sunset:string, at:number}|null}
 */
export function parseWeather(json, now = Date.now()) {
  const cur = json?.current;
  if (!cur || typeof cur !== 'object') return null;
  const text = weatherTextOf(cur.weather_code);
  if (!text) return null;          // 不认识的码 → 当作没取到
  const temp = Number(cur.temperature_2m);
  if (!Number.isFinite(temp)) return null;
  const feels = Number(cur.apparent_temperature);
  const daily = json?.daily;
  const pickDaily = (key) => {
    const v = daily?.[key];
    if (!Array.isArray(v) || !v.length) return '';
    // Open-Meteo 返回 "2026-11-24T06:27"，只要 HH:MM。
    const s = String(v[0] || '');
    const m = /T(\d{2}:\d{2})/.exec(s);
    return m ? m[1] : '';
  };
  return {
    code: Number(cur.weather_code),
    text,
    tempC: Math.round(temp),
    feelsC: Number.isFinite(feels) ? Math.round(feels) : Math.round(temp),
    isDay: Number(cur.is_day) === 1,
    sunrise: pickDaily('sunrise'),
    sunset: pickDaily('sunset'),
    at: Number(now) || Date.now()
  };
}

/**
 * 一行短描述，给唤醒词用。温度与现象都取整。
 * 例：`阴 12°`
 */
export function weatherShortText(w) {
  if (!w || !w.text) return '';
  const t = Number(w.tempC);
  return Number.isFinite(t) ? `${w.text} ${t}°` : w.text;
}

/**
 * 创建一个带缓存的取数器。
 *
 * @param {object} opts
 * @param {() => ({lat:number,lon:number,timezone?:string})|null} opts.configOf
 * @param {(url:string, ms:number) => Promise<any>} opts.fetchJson  注入 fetch，便于测试
 * @param {number} [opts.ttlMs]
 * @param {() => number} [opts.now]
 */
export function createWeatherCache({ configOf, fetchJson, ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
  let cached = null;         // 最近一次成功的结果
  let lastTryAt = 0;         // 上次**尝试**的时间（失败也算，避免每次唤醒都打接口）
  let lastError = '';

  /** 同步读缓存。过期了也照给（旧值好过没有），只标记 stale。 */
  function peek() {
    if (!cached) return null;
    return { ...cached, stale: (now() - cached.at) > ttlMs };
  }

  /** 该不该去刷一次。失败后也遵守 ttl，避免网络抖动把唤醒拖慢。 */
  function shouldRefresh() {
    return (now() - lastTryAt) >= ttlMs;
  }

  /**
   * 异步刷一次。**永远不抛错** —— 失败保留旧值，只记 lastError。
   * @returns {Promise<object|null>} 新的缓存值（失败时返回旧值）
   */
  async function refresh() {
    if (!shouldRefresh()) return peek();
    lastTryAt = now();
    const conf = typeof configOf === 'function' ? configOf() : null;
    const url = conf ? buildWeatherUrl(conf) : '';
    if (!url) { lastError = 'no-config'; return peek(); }
    try {
      const json = await fetchJson(url, FETCH_TIMEOUT_MS);
      const parsed = parseWeather(json, now());
      if (parsed) {
        cached = parsed;
        lastError = '';
      } else {
        lastError = 'bad-payload';
      }
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 120);
    }
    return peek();
  }

  return {
    peek,
    refresh,
    shouldRefresh,
    get lastError() { return lastError; }
  };
}
