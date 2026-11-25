// 纯本地时间计算：零依赖、零网络、零状态。
//
// 为什么单独成一个模块：
//   桥接里已经有 localClock（1571 行）和 localClockText（13963 行）两个几乎同名的函数，
//   再加时间逻辑只会更难改。这里所有函数都是纯的（输入毫秒 + 时区，输出普通对象），
//   可以在 node 里离线验证 —— 不需要起 SnowLuma，不需要 DSH 在线，不需要联网。
//
// 三个来源都不联网：
//   · 日期 / 星期 → Intl.DateTimeFormat（Node 26 内置 full-icu）
//   · 农历        → Intl 的 chinese 日历（'zh-CN-u-ca-chinese'）
//   · 节气        → 天文算法：太阳视黄经走到 15° 整数倍的那一刻，逐年缓存
//
// 为什么节气不用网上常见的「寿星公式」（y*0.2422 + C - y/4）：
//   那个公式是线性近似，在个别年份会差一天（例如 2021 年冬至，公式给 12-22，
//   实际是 12-21）。天文算法慢一点（每年 24 个节气 × 约 80 次二分 = 两千次浮点运算，
//   一次性算完缓存住，之后查表），但不会出现"节气报错一天"这种很难排查的错。

const RAD = Math.PI / 180;

export const DEFAULT_TZ = 'Asia/Shanghai';

// 24 节气的名字。顺序从冬至开始，与下面的 target 计算对应
// （冬至太阳视黄经 270°，之后每 15° 一个节气）。
const TERM_NAMES = [
  '冬至', '小寒', '大寒', '立春', '雨水', '惊蛰',
  '春分', '清明', '谷雨', '立夏', '小满', '芒种',
  '夏至', '小暑', '大暑', '立秋', '处暑', '白露',
  '秋分', '寒露', '霜降', '立冬', '小雪', '大雪'
];

const CN_DAY = (() => {
  const d = [''];
  const num = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  for (let i = 1; i <= 10; i += 1) d[i] = `初${num[i - 1]}`;
  for (let i = 11; i <= 19; i += 1) d[i] = `十${num[i - 11]}`;
  d[20] = '二十';
  for (let i = 21; i <= 29; i += 1) d[i] = `廿${num[i - 21]}`;
  d[30] = '三十';
  return d;
})();

// 农历固定节日：键是「月-日」。除夕单独判定（腊月最后一天，随年份变）。
const LUNAR_FESTIVALS = {
  '1-1': '春节',
  '1-15': '元宵',
  '2-2': '龙抬头',
  '5-5': '端午',
  '7-7': '七夕',
  '7-15': '中元',
  '8-15': '中秋',
  '9-9': '重阳',
  '12-8': '腊八',
  '12-23': '小年'
};

/**
 * 公历节日。键是 `月-日`。
 *
 * 只收**她真会提到**的那些 —— 不放植树节、消费者权益日这类纯日历条目：
 * 唤醒词每轮都进历史，多一个没有对话价值的标记就是白烧字符。
 * 清明是节气不是公历节日，由节气表覆盖，这里不重复。
 */
const SOLAR_FESTIVALS = {
  '1-1': '元旦',
  '2-14': '情人节',
  '3-8': '妇女节',
  '5-1': '劳动节',
  '6-1': '儿童节',
  '10-1': '国庆',
  '12-24': '平安夜',
  '12-25': '圣诞'
};

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 公历节日名；不是就返回空串。 */
export function solarFestivalOf(ms = Date.now(), tz = DEFAULT_TZ) {
  const p = partsOf(ms, tz);
  if (!p) return '';
  return SOLAR_FESTIVALS[p.monthDay] || '';
}

/** 取某个时区下的本地日期/时间各部分。tz 非法时退回系统时区。 */
export function partsOf(ms = Date.now(), tz = DEFAULT_TZ) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return null;
  const base = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short'
  };
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...base });
  } catch {
    // 时区名写错（例如拼成 Asia/Shangai）不该让整行消失，退回系统本地时间。
    fmt = new Intl.DateTimeFormat('en-CA', base);
  }
  const got = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') got[part.type] = part.value;
  }
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekdayIndex = wdMap[got.weekday] ?? date.getDay();
  return {
    year: Number(got.year),
    month: Number(got.month),
    day: Number(got.day),
    hour: Number(got.hour),
    minute: Number(got.minute),
    weekdayIndex,
    weekday: WEEKDAY_CN[weekdayIndex],
    ymd: `${got.year}-${got.month}-${got.day}`,
    monthDay: `${Number(got.month)}-${Number(got.day)}`,
    hm: `${got.hour}:${got.minute}`
  };
}

/**
 * 农历。取不到（ICU 缺数据、时区异常）返回 null —— 调用方据此整段省略，
 * 绝不输出「农历未知」这种噪声。
 */
export function lunarOf(ms = Date.now(), tz = DEFAULT_TZ) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return null;
  let parts;
  try {
    // year:'numeric' 必须带 —— 不带的话 formatToParts 不会产出 yearName（丙午），
    // 实测过：漏了它 yearName 恒为空串，而我又没做兜底，结果是静默缺一个字段。
    const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      timeZone: tz, year: 'numeric', month: 'long', day: 'numeric'
    });
    parts = fmt.formatToParts(date);
  } catch {
    return null;
  }
  const got = {};
  for (const part of parts) {
    if (part.type !== 'literal') got[part.type] = part.value;
  }
  const dayNum = Number(got.day);
  if (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 30) return null;
  // Intl 给的 month 已经是「十月」「闰六月」这种现成写法，直接用，不要自己拼。
  const monthText = String(got.month ?? '').trim();
  const leap = monthText.startsWith('闰');
  const monthNum = chineseMonthToNumber(monthText.replace('闰', '').replace('月', ''));
  return {
    yearName: String(got.yearName ?? '').trim(),
    monthText,
    monthNum,
    leap,
    dayNum,
    dayText: CN_DAY[dayNum] ?? String(dayNum),
    isFirstDay: dayNum === 1,
    isFullMoon: dayNum === 15
  };
}

function chineseMonthToNumber(text) {
  const map = {
    正: 1, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
    七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 冬: 11, 腊: 12
  };
  return map[text] ?? 0;
}

// ── 节气 ────────────────────────────────────────────────────────────────────
// 太阳视黄经（度），输入是世界时儒略日。低阶 VSOP 够用，误差远小于一天。
function sunLongitude(jd) {
  const T = (jd - 2451545) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const Mr = M * RAD;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr)
    + 0.000289 * Math.sin(3 * Mr);
  const trueLong = L0 + C;
  // 章动 + 光行差：不加这两项会偏 0.005° 左右，日级判断用不上，但加上更省心。
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  return ((lambda % 360) + 360) % 360;
}

// ΔT（TT − UT），2020 年代约 69 秒。误差对节气日期的影响远小于一小时。
const DELTA_T_SEC = 69.184;

/**
 * 算出某一公历年 24 个节气的时刻（毫秒）。
 * 返回按时间升序的 [{ name, at }]。这个函数很贵（每年两千次三角函数），
 * 所以结果按年缓存在下面。
 */
function computeTermsOfYear(year) {
  const out = [];
  for (let i = 0; i < 24; i += 1) {
    // 冬至 270°，之后每个节气 +15°。
    const target = (270 + i * 15) % 360;
    let lo = Date.UTC(year, 0, 1);
    let hi = Date.UTC(year + 1, 0, 1);
    // 二分：太阳黄经在这一年里单调递增（360° 回绕处理在下面的 d 里）。
    for (let k = 0; k < 80; k += 1) {
      const mid = (lo + hi) / 2;
      const jdUT = mid / 86400000 + 2440587.5;
      const L = sunLongitude(jdUT + DELTA_T_SEC / 86400);
      const d = ((L - target + 540) % 360) - 180;
      if (d < 0) lo = mid; else hi = mid;
    }
    out.push({ name: TERM_NAMES[i], at: Math.round((lo + hi) / 2) });
  }
  return out.sort((a, b) => a.at - b.at);
}

const termCache = new Map();

function termsOfYear(year) {
  if (!termCache.has(year)) {
    termCache.set(year, computeTermsOfYear(year));
    // 缓存只保留最近几年：桥接是长期进程，但没必要把整个世纪存着。
    if (termCache.size > 6) {
      const oldest = Math.min(...termCache.keys());
      if (oldest < year - 2) termCache.delete(oldest);
    }
  }
  return termCache.get(year);
}

/** 当天是不是节气。是就返回 { name, index, at }，不是返回 null。 */
export function solarTermOf(ms = Date.now(), tz = DEFAULT_TZ) {
  const p = partsOf(ms, tz);
  if (!p) return null;
  const t = Number(ms);
  for (const year of [p.year - 1, p.year, p.year + 1]) {
    for (const term of termsOfYear(year)) {
      if (Math.abs(term.at - t) > 36 * 3600 * 1000) continue;
      const tp = partsOf(term.at, tz);
      if (tp && tp.ymd === p.ymd) {
        return { name: term.name, index: TERM_NAMES.indexOf(term.name), at: term.at };
      }
    }
  }
  return null;
}

/** 下一个节气（用于「还有几天」这类表达），当天是节气时返回后面那个。 */
export function nextSolarTerm(ms = Date.now(), tz = DEFAULT_TZ) {
  const p = partsOf(ms, tz);
  if (!p) return null;
  const t = Number(ms);
  for (const year of [p.year, p.year + 1]) {
    for (const term of termsOfYear(year)) {
      if (term.at > t + 36 * 3600 * 1000) return { name: term.name, at: term.at };
    }
  }
  return null;
}

/**
 * 农历节日名。除夕要单独判：它是腊月最后一天，天数随年份变，
 * 没法写成固定键 —— 判定办法是「明天是不是正月初一」。
 */
export function lunarFestivalOf(ms = Date.now(), tz = DEFAULT_TZ) {
  const lu = lunarOf(ms, tz);
  if (!lu) return '';
  if (lu.leap) return '';              // 闰月不算节日
  const fixed = LUNAR_FESTIVALS[`${lu.monthNum}-${lu.dayNum}`];
  if (fixed) return fixed;
  const nextDay = lunarOf(Number(ms) + 86400000, tz);
  if (nextDay && !nextDay.leap && nextDay.monthNum === 1 && nextDay.dayNum === 1) return '除夕';
  return '';
}

/**
 * 唤醒词首位那一行。
 *
 * 现在只有时间 + 特殊日子（全部本地计算）。天气要靠联网、饥饿/精力要靠状态文件，
 * 那两块在后续步骤里往 extras 里塞，这里的格式已经留好位置：
 *   【现在】11-23 周日 21:47 阴12° 饱·困（立冬 · 农历十月十五）
 *                                   └─extras─┘ └──── specials ────┘
 *
 * @param {number} ms
 * @param {object} [opts]
 * @param {string} [opts.timezone]
 * @param {string[]} [opts.extras]  天气 / 饥饿 / 精力等，按顺序拼在时间后面
 * @returns {string} 以换行结尾的完整段落；永远不抛错
 */
export function buildNowLine(ms = Date.now(), opts = {}) {
  const tz = opts.timezone || DEFAULT_TZ;
  const p = partsOf(ms, tz);
  if (!p) return '';
  let line = `【现在】${p.monthDay} ${p.weekday} ${p.hm}`;

  // 天气（2026-11-24 接入）：形如「阴 12°」。
  // 它和时间一样是**客观事实**，所以放在【现在】这一行；
  // 身体状态（饿、困、心情）才放【状态】—— 两者性质不同，混一起会让她分不清
  // 哪个是窗外、哪个是自己。
  const weather = String(opts.weather || '').trim();
  if (weather) line += `　${weather}`;

  const extras = Array.isArray(opts.extras) ? opts.extras.filter((s) => s && String(s).trim()) : [];

  const marks = [];
  const term = solarTermOf(ms, tz);
  if (term) marks.push(term.name);
  // 公历节日排在农历节日前面：元旦/国庆这类对日常对话更重要。
  const solarFest = solarFestivalOf(ms, tz);
  if (solarFest) marks.push(solarFest);
  const fest = lunarFestivalOf(ms, tz);
  if (fest) marks.push(fest);
  const lu = lunarOf(ms, tz);
  // 初一/十五只在没有更重要的标记时才提，避免「春节 · 农历正月初一」这种重复。
  if (lu && !fest && !solarFest && (lu.isFirstDay || lu.isFullMoon)) {
    marks.push(`农历${lu.monthText}${lu.dayText}`);
  }
  if (marks.length) line += `（${marks.join(' · ')}）`;

  // ── 【状态】独立成行（2026-11-23 操作者要求）──────────────────────────
  //
  // 原来状态是直接缀在【现在】后面的（`… 07:30 饿 精神`），问题有两个：
  //   ① 光一个「饿」字在长提示词里容易被当成别的意思（形容词、比喻）；
  //   ② 时间与身体是两类信息，混一行会让模型分不清哪个是"事实"。
  // 现在拆开、并且**不带标签**（直接输出「有点饿」这种自然说法）——
  // 标签占的字符比内容还多，而整行已经挂在【状态】下面，不会有歧义。
  //
  // 状态为空（都在正常档）时整行不输出 —— 不产生「【状态】正常」这种废话。
  //
  // ★ 2026-11-24：**带括号的整句**（如「（醒了，睡得还行　梦见…）」）
  //   不并入【状态】行，而是**另起一行**排在它下面。
  //   理由：那一行是「状态项」列表（饿了/精力/心情），
  //   而括号句是一句完整的话 —— 塞进列表末尾读起来像第八个状态项。
  //   约定比【状态】多的这一行以 `（` 开头，由 opts.extras 里原样传入。
  let out = line;
  const isSentence = (s) => /^[（(]/.test(String(s).trim());
  const stateItems = extras.filter((s) => !isSentence(s)).map((s) => String(s).trim());
  const sentenceItems = extras.filter((s) => isSentence(s)).map((s) => String(s).trim());
  if (stateItems.length) out += `\n【状态】${stateItems.join('　')}`;
  // 句子按原顺序各占一行（目前最多一条，但接口不限制条数）。
  for (const s of sentenceItems) out += `\n${s}`;

  return `${out}\n\n`;
}

/** 跨天 / 长时间未见的描述。给唤醒包尾部用，避免"三小时前的旧账当刚发的"。 */
export function describeGap(sinceMs, nowMs = Date.now()) {
  const s = Number(sinceMs);
  if (!Number.isFinite(s) || s <= 0) return '';
  const gapMs = Math.max(0, Number(nowMs) - s);
  if (gapMs < 60 * 1000) return '';
  const min = Math.floor(gapMs / 60000);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时`;
  return `${Math.floor(hour / 24)} 天`;
}
