// 生理周期推算（纯后端被动，不给她任何工具入口）。
//
// ── 设计约束（2026-11-23 操作者定）──────────────────────────────────────────
//
// ① **她不能调工具改它。** 到日子就自己出现，是"身体发生了什么"，不是她能演的。
//    这和睡眠相反 —— 睡眠是她主动说的（asleep=true），因为那是行为；
//    周期不是行为，是生理事实。
//
// ② **一次只持续 1~2 天**：1 天概率 0.6，2 天概率 0.4。
//
// ③ **只在私聊显示**，群聊一个字都不出。
//
// ④ 措辞用「不方便」而不是直白的生理词 —— 唤醒词每轮进历史，
//    太直白会污染整段对话的语感，也容易被别人拿去做文章。
//
// ── 医学上的依据（写清楚，免得以后有人凭想象改）────────────────────────────
//
// 常规周期 28 天（21~35 天都算正常）。四个阶段：
//
//   月经期     第 1~5 天     出血、可能腹痛、疲惫、情绪低落
//   卵泡期     第 6~13 天    精力回升，情绪转好
//   排卵期     第 14 天前后   精力最高、最外向
//   黄体期     第 15~28 天   前期平稳；**末期（经前 3~7 天）易怒、疲惫、情绪波动**
//                           这就是经前综合征（PMS）
//
// 本模块只做两件事：**推下一次的日期** + **给出当前阶段的修正值**。
// 不做任何医疗判断，也不产出任何"她哪里痛"的细节 —— 那是幻觉素材。

/** 默认周期长度（天）。 */
export const DEFAULT_CYCLE_DAYS = 28;
export const MIN_CYCLE_DAYS = 21;
export const MAX_CYCLE_DAYS = 35;

/** 一次经期持续 1 天的概率；2 天就是 1 - 它。 */
export const PERIOD_ONE_DAY_PROB = 0.6;

/** 经前综合征窗口：下次月经前这么多天开始。 */
export const PMS_LEAD_DAYS = 5;

const DAY_MS = 86400000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 把毫秒落到"当天 0 点"，按给定时区的日历日算。 */
export function floorDay(ms, tz = 'Asia/Shanghai') {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return 0;
  // 用 Intl 拿到该时区下的年月日，再用 Date.UTC 拼回"那个日历日的零点"。
  // 不直接减时间戳取模：夏令时、跨时区都会算错。
  let y;
  let m;
  let day;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const got = {};
    for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') got[p.type] = p.value;
    y = Number(got.year); m = Number(got.month); day = Number(got.day);
  } catch {
    y = d.getUTCFullYear(); m = d.getUTCMonth() + 1; day = d.getUTCDate();
  }
  return Date.UTC(y, m - 1, day);
}

/**
 * 决定"这一次来几天"。**同一次经期内必须稳定**，所以用起始日当种子，
 * 不能用 Math.random() —— 否则同一天问两次会得到不同答案。
 */
export function periodLengthFor(startDayMs) {
  const seed = Number(startDayMs) || 0;
  // 一个朴素的整数散列，只为把日期打散成 [0,1)。
  let x = (seed / DAY_MS) | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = x + (x << 3);
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  const r = ((x >>> 0) % 10000) / 10000;
  return r < PERIOD_ONE_DAY_PROB ? 1 : 2;
}

/**
 * 推到"从 anchor 起算、这一天属于哪个周期"。
 *
 * 关键：如果很久没更新 anchor，**不能**让它永远停在过去的第 1 天 ——
 * 那意味着她会一直处于经期。所以要按周期长度循环推到"当前所在的这一轮"。
 *
 * @param {number} anchorDay  上次经期起始日（floorDay 过的）
 * @param {number} todayDay
 * @param {number} cycleDays
 * @returns {{cycleStart:number, dayInCycle:number, cycleIndex:number}}
 */
export function cycleAt(anchorDay, todayDay, cycleDays = DEFAULT_CYCLE_DAYS) {
  const len = clamp(Math.round(Number(cycleDays) || DEFAULT_CYCLE_DAYS), MIN_CYCLE_DAYS, MAX_CYCLE_DAYS);
  const anchor = Number(anchorDay) || 0;
  const today = Number(todayDay) || anchor;
  if (!anchor) return { cycleStart: today, dayInCycle: 1, cycleIndex: 0 };
  const elapsedDays = Math.floor((today - anchor) / DAY_MS);
  // 负数（时钟回拨 / anchor 在未来）：按第 1 天算，不抛错。
  if (elapsedDays < 0) return { cycleStart: anchor, dayInCycle: 1, cycleIndex: 0 };
  const cycleIndex = Math.floor(elapsedDays / len);
  const cycleStart = anchor + cycleIndex * len * DAY_MS;
  return { cycleStart, dayInCycle: elapsedDays - cycleIndex * len + 1, cycleIndex };
}

/**
 * 六个阶段的定义（2026-11-24 改成六期，照 AstrBot private_companion_v2 的划分）。
 *
 * 为什么从四期改成六期：四期里「排卵期」是一整段 14~16 天，但那几天
 * 其实是先上升（排卵前）再回落（排卵后），压成一段就丢了曲线。
 * 拆成 pre_ovulation / ovulation 之后，精力是**先升后降**的，更像真实。
 *
 * 精力中位数（相对基线的偏移）：
 *   menstrual −12 · follicular 0 · pre_ovulation +8 · ovulation +9 · luteal +5 · pms −8
 *
 * ⚠️ 注意 luteal 是 **+5 不是负数**：黄体期前期人其实还行，真正难受的是末尾的
 *    pms。早期版本把它写成 −2 是错的 —— 那会让整整两周都偏低。
 */
export const CYCLE_PHASES = Object.freeze([
  'menstrual', 'follicular', 'pre_ovulation', 'ovulation', 'luteal', 'pms'
]);

export const PHASE_ENERGY_MEDIAN = Object.freeze({
  menstrual: -12,
  follicular: 0,
  pre_ovulation: 8,
  ovulation: 9,
  luteal: 5,
  pms: -8
});

const PHASE_CN = Object.freeze({
  menstrual: '月经期',
  follicular: '卵泡期',
  pre_ovulation: '排卵前期',
  ovulation: '排卵期',
  luteal: '黄体期',
  pms: 'PMS 期',
  none: ''
});

/**
 * 当前处于哪个阶段（六期）。
 * @returns {{phase:string, dayInCycle:number, periodLength:number,
 *            daysToNextPeriod:number, phaseName:string, energyMedian:number}}
 */
export function phaseAt(anchorDay, todayDay, cycleDays = DEFAULT_CYCLE_DAYS) {
  const anchor = Number(anchorDay) || 0;
  if (!anchor) {
    // 从没记过：不知道她在哪一天。返回 none —— 调用方据此**什么都不输出**，
    // 不要编一个"第 1 天"出来。
    return {
      phase: 'none', dayInCycle: 0, periodLength: 0,
      daysToNextPeriod: 0, phaseName: '', energyMedian: 0
    };
  }
  const { cycleStart, dayInCycle } = cycleAt(anchor, todayDay, cycleDays);
  const len = clamp(Math.round(Number(cycleDays) || DEFAULT_CYCLE_DAYS), MIN_CYCLE_DAYS, MAX_CYCLE_DAYS);
  const periodLength = periodLengthFor(cycleStart);

  // 六期边界。用比例而不是写死天数：周期不是 28 天时（21~35 都可能）也能用。
  //   menstrual    第 1 天 ~ periodLength
  //   follicular   之后 ~ 40%   （卵泡期通常占前半段最大一块）
  //   pre_ovulation 40%~48%
  //   ovulation    48%~57%
  //   luteal       57% ~ (len - PMS_LEAD_DAYS)
  //   pms          最后 5 天
  const p40 = Math.round(len * 0.40);
  const p48 = Math.round(len * 0.48);
  const p57 = Math.round(len * 0.57);
  let phase;
  if (dayInCycle <= periodLength) phase = 'menstrual';
  else if (dayInCycle > len - PMS_LEAD_DAYS) phase = 'pms';
  else if (dayInCycle <= p40) phase = 'follicular';
  else if (dayInCycle <= p48) phase = 'pre_ovulation';
  else if (dayInCycle <= p57) phase = 'ovulation';
  else phase = 'luteal';

  const daysToNextPeriod = len - dayInCycle + 1;
  return {
    phase,
    dayInCycle,
    periodLength,
    daysToNextPeriod,
    phaseName: PHASE_CN[phase] || '',
    energyMedian: PHASE_ENERGY_MEDIAN[phase] ?? 0
  };
}

/**
 * 经期不适：六种，各带允许的阶段、精力影响、时长与权重。
 *
 * 直接照抄 AstrBot 的 `_ADVANCED_CYCLE_DISCOMFORT_SPECS`：那套数值是它实测调过的，
 * 重新发明只会更差。**权重决定同一阶段里谁更容易出现**（痛经/乏力最高）。
 */
export const DISCOMFORT_SPECS = Object.freeze({
  痛经: {
    phases: ['menstrual'], label: '今天有点痛经，小腹闷闷的不舒服',
    mood: '疲惫', energyDelta: -14, durationHours: 6, weight: 4
  },
  头痛: {
    phases: ['menstrual', 'pms'], label: '头有点闷痛，注意力不太集中',
    // 原来写 '迟钝' —— 那是能力词（脑子转得慢），不是心情。
    // 头痛时更接近"烦躁"或"疲惫"，取后者：闷痛更多是累，不是烦。
    mood: '疲惫', energyDelta: -10, durationHours: 5, weight: 3
  },
  腰酸: {
    phases: ['menstrual', 'luteal'], label: '腰有点酸，不太想久坐',
    mood: '疲惫', energyDelta: -8, durationHours: 6, weight: 3
  },
  乏力: {
    phases: ['menstrual', 'luteal', 'pms'], label: '身上没什么力气，动作慢半拍',
    // 原来写 '困倦' —— 同样是能力词。乏力更接近"虚弱"。
    mood: '虚弱', energyDelta: -12, durationHours: 8, weight: 4
  },
  情绪低落: {
    phases: ['pms'], label: '情绪有点低，不太想说话',
    mood: '低落', energyDelta: -6, durationHours: 5, weight: 2
  },
  恶心: {
    phases: ['menstrual', 'pms'], label: '胃里有点泛恶心，不太想吃东西',
    mood: '虚弱', energyDelta: -9, durationHours: 4, weight: 1
  }
});

/**
 * 阶段 → 对身体状态的修正 + 唤醒词里要不要标记。
 *
 * ── 文案（2026-11-24 改成原作者口吻）────────────────────────────────────
 *
 * 用 AstrBot `_advanced_cycle_phase_spec` 的那套写法（说明式、第三人称感受），
 * 而不是我们原来那种第一人称短句。理由：
 *   ① 它那句是**状态描述**，和唤醒词里其它几项（"饿了，想吃东西"）同一种语气；
 *   ② 第一人称短句（"累、容易烦躁"）放在【状态】里读起来像她在抱怨，
 *      会挤掉她自己想说的话。
 *
 * 原作者原文（参考）：
 *   menstrual     处于月经期，身体更容易疲倦，情绪感受稍敏锐
 *   follicular    处于卵泡期，精力平稳回升，心情逐渐轻快
 *   pre_ovulation 处于排卵前期，身体逐渐轻盈，精力有所上升
 *   ovulation     处于排卵期，精力较充足，社交意愿稍有增强
 *   luteal        处于黄体期，精力尚可，情绪整体平稳
 *   pms           处于 PMS 期，精力有所下降，情绪波动稍明显
 *
 * ⚠️ mood 一律用**中文感受词**：`irritable` / `calm` 这种英文混在唤醒词里
 *    会直接显示成「心情：irritable」—— 那是没做完的痕迹，不是设计。
 */
export function phaseEffect(phaseInfo, opts = {}) {
  const phase = phaseInfo?.phase ?? 'none';
  const text = opts.text && typeof opts.text === 'object' ? opts.text : {};
  const label = String(text.cycleLabel || '生理期');
  const periodText = String(text.cyclePeriod || '处于月经期，身体更容易疲倦，情绪感受稍敏锐');
  const pmsText = String(text.cyclePms || '处于 PMS 期，精力有所下降，情绪波动稍明显');
  switch (phase) {
    case 'menstrual':
      return {
        energyDelta: PHASE_ENERGY_MEDIAN.menstrual,
        mood: '敏感', show: true, label, note: periodText
      };
    case 'pms':
      return {
        energyDelta: PHASE_ENERGY_MEDIAN.pms,
        mood: '敏感', show: true, label, note: pmsText
      };
    case 'pre_ovulation':
      return { energyDelta: PHASE_ENERGY_MEDIAN.pre_ovulation, mood: '期待', show: false, label, note: '' };
    case 'ovulation':
      return { energyDelta: PHASE_ENERGY_MEDIAN.ovulation, mood: '明朗', show: false, label, note: '' };
    case 'luteal':
      return { energyDelta: PHASE_ENERGY_MEDIAN.luteal, mood: '平稳', show: false, label, note: '' };
    case 'follicular':
      return { energyDelta: PHASE_ENERGY_MEDIAN.follicular, mood: '轻快', show: false, label, note: '' };
    default:
      return { energyDelta: 0, mood: '', show: false, label, note: '' };
  }
}

/**
 * 当天该不该给她抽一条经期不适。
 *
 * 规则照抄 AstrBot（那几条都是踩过坑的）：
 *   ① 一天**最多掷一次**，掷失败也记下日期 —— 否则同一天会反复重掷，
 *      实际概率远高于设定值；
 *   ② 已有不适还没到期就不掷（不叠加同类）；
 *   ③ 只在该不适类型允许的阶段里掷。
 *
 * @param {object} opts
 * @param {string} opts.phase
 * @param {string} opts.todayKey      形如 2026-11-24，用于"一天只掷一次"
 * @param {string} [opts.lastRollKey] 上次掷过的日期
 * @param {boolean} [opts.hasActive]  是否已有活跃的经期不适
 * @param {number} [opts.chance]      0~100，默认 55
 * @param {() => number} [opts.rand]  注入随机源便于测试
 * @returns {{roll:boolean, type:(string|null), spec:(object|null), reason:string}}
 */
export function rollDiscomfort(opts = {}) {
  const phase = String(opts.phase || 'none');
  const todayKey = String(opts.todayKey || '');
  const lastRollKey = String(opts.lastRollKey || '');
  const chance = Number.isFinite(Number(opts.chance)) ? Number(opts.chance) : 55;
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;

  if (phase === 'none') return { roll: false, type: null, spec: null, reason: 'no-phase' };
  if (todayKey && lastRollKey === todayKey) {
    // 已经掷过：不重掷，也不更新日期。
    return { roll: false, type: null, spec: null, reason: 'already-rolled-today' };
  }
  if (opts.hasActive) return { roll: false, type: null, spec: null, reason: 'already-active' };

  const candidates = Object.entries(DISCOMFORT_SPECS)
    .filter(([, spec]) => spec.phases.includes(phase));
  if (!candidates.length) return { roll: false, type: null, spec: null, reason: 'no-candidate' };

  // 注意：**掷骰判定在"有没有候选"之后**。反过来的话，
  // 在不允许的阶段也会消耗掉当天那次机会。
  if (chance <= 0 || rand() > chance / 100) {
    return { roll: true, type: null, spec: null, reason: 'miss' };
  }
  // 按权重抽：痛经/乏力 weight 4，恶心 weight 1 —— 前者明显更常见。
  const total = candidates.reduce((sum, [, s]) => sum + (Number(s.weight) || 1), 0);
  let pick = rand() * total;
  for (const [name, spec] of candidates) {
    pick -= Number(spec.weight) || 1;
    if (pick <= 0) return { roll: true, type: name, spec, reason: 'hit' };
  }
  const [name, spec] = candidates[candidates.length - 1];
  return { roll: true, type: name, spec, reason: 'hit' };
}

/**
 * 推理锚点：如果记录太久没更新，**往前推进到最近的一轮**并把 anchor 写回去。
 *
 * 为什么要推进：anchor 停在两个月前，`cycleAt` 每轮都要循环算很久（虽然便宜），
 * 更重要的是前端展示"上次是 X 天前"会变成 60 天，看起来像坏了。
 * 推进到最近一轮起始日后，数字永远落在 0~28 天之间。
 *
 * @returns {{anchorDay:number, changed:boolean}}
 */
export function normalizeAnchor(anchorDay, todayDay, cycleDays = DEFAULT_CYCLE_DAYS) {
  const anchor = Number(anchorDay) || 0;
  if (!anchor) return { anchorDay: 0, changed: false };
  const { cycleStart } = cycleAt(anchor, todayDay, cycleDays);
  return { anchorDay: cycleStart, changed: cycleStart !== anchor };
}
