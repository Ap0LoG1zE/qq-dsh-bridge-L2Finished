// 身体循环状态：饱腹 / 精力 / yu wang。
//
// ── 设计取向（2026-11-23 操作者定）─────────────────────────────────────────
//
// **自动衰减是主驱动，她调工具加值是补充。**
//
// 为什么不走"从她的话里判断"那条路：实测过一次就够呛 —— "我不饿""饿死我了
// 但刚吃完"全含关键词，方向正好相反；而 QQ 上"我好困啊"多数是在撒娇找话题，
// 不是在报数。抽错比不抽糟得多：她会说出自相矛盾的话。
//
// 所以职责切成两半：
//   · **时间负责往下掉**（纯函数、无歧义、不需要模型理解任何东西）
//   · **她负责往上抬**（qq_life_circle 传增量，只在真的做了某件事之后）
//
// 三个维度都是 0~100 的**充盈度**（高 = 满足/没事；低 = 缺）：
//   satiety  饱腹   低 → 饿
//   energy   精力   低 → 困
//   desire   yu wang   低 → 空
//
// ── 关于"不补算"的取舍 ─────────────────────────────────────────────────────
//
// 前面讨论时定过一条硬规则：**长时间离线不补算**。这里的落地是：
//   · **衰减**可以补算 —— 它单调、有底、不会编出"你过得很好"这种假话；
//     离线一个月回来，三个值都是 0，这是诚实的（时间确实过去了）。
//   · **恢复**绝不补算 —— 精力只在**确实落在睡眠窗内**的那段时间里回升，
//     且最多只认 10 小时（一夜的量）。
//     没有这道闸，关机一个月回来就是"精力 100，我刚睡了个好觉"，
//     然后她开始演"今天精神特别好"，而实际上只是主机断电了。
//
// 这一节是这份文件里最容易被后来人改坏的地方，注释写死在这里。

export const DIMENSIONS = Object.freeze(['satiety', 'energy', 'desire']);

/**
 * 每小时的自然变化。
 *
 * ⚠️ 注意方向：`satiety` / `energy` 是**充盈度**（掉下去 = 饿/困）；
 *    `desire` 是**积累度**（涨上来 = 想要）。两者方向相反，别抄错。
 */
export const DECAY_PER_HOUR = Object.freeze({
  // 饱腹 13.0/h —— 由"每顿前必须是饿的"反推，不是拍脑袋定的：
  //   早饭 08:00 吃到 100 → 午饭 12:30 要落到「有点饿」以下：需 ≥ (100-40)/4.5 = 13.3
  //   午饭 12:40 吃到 100 → 晚饭 18:30 要落到「有点饿」以下：需 ≥ (100-40)/5.83 = 10.3
  //   取 13.0 让两段都满足，且晚饭前刚好进「有点饿」。
  satiety: 13.0,
  energy: 3.0,
  // yu wang 1.2/h **往上累**（见下面 DESIRE_PER_HOUR 的说明，别在这里再扣一次）。
  desire: 0
});

/**
 * yu wang的**累积**速率（每小时**加**）。
 *
 * 它的语义和另外两个相反：
 *   · 饱腹/精力是"用掉的资源"，会掉，她调工具补回来；
 *   · yu wang是"攒起来的张力"，会涨，**被满足后回落**。
 * 所以 `qq_life_circle(add.desire)` 传的是**减少量**（见 releaseDesire）。
 *
 * 1.2/h：从 0 起算约 4 天到顶。这个量级是刻意的 ——
 * 太快（比如 5/h）它会长期贴着 100，唤醒词里天天出现同一句；
 * 太慢（比如 0.3/h）一个正常作息下来根本到不了 80，功能等于没有。
 */
export const DESIRE_PER_HOUR = 1.2;

/** 睡眠时的饱腹衰减（每小时）。胃在夜里继续排空，但比醒着慢。
 *  6.0/h：睡 9 小时掉 54 —— 睡前 92 醒来 38，落在「有点饿」。
 *  这样**早上醒来是饿的**（之前 4/h 时 92 → 56，醒来不饿，不真实）。 */
export const SATIETY_ASLEEP_PER_HOUR = 6.0;

/**
 * 睡着 / 离线时的精力回升速率（每小时）。
 *
 * 注意它只在两种情况下生效，**都不看钟点**（见 settleCircle 的说明）：
 *   · 她调工具说自己睡了；
 *   · 桥接当时没在跑（关机）。
 */
export const ENERGY_RECOVER_PER_HOUR = 8.0;

/** 精力"恢复"最多只认这么多个小时 —— 一夜的量，防止关机很久后凭空满血。 */
export const ENERGY_RECOVER_MAX_HOURS = 10;

/**
 * 距离上次结算超过这么久，就认为「那段时间桥接没在跑」，按休息算。
 *
 * 为什么是 3 小时：正常聊天间隔里不该出现这么长的空档（主动机会最短 30 分钟一次、
 * 私聊几乎天天有动静）；而一次真正的关机/重启通常就是几小时以上。
 * 定得太小（比如 20 分钟）会把「她只是在忙」误判成睡觉；
 * 定得太大（比如 12 小时）会让一次正常关机只算回几小时。
 */
export const DEFAULT_OFFLINE_AS_SLEEP_MS = 3 * 3600 * 1000;

/** 一次结算最多跨越多少个 "小时格"：再久也没意义（早就贴底了）。 */
const MAX_SETTLE_HOURS = 24 * 30;

/** 默认值：刚醒、吃过、平静。不用 100，避免"一开局就满血"。 */
export const DEFAULT_VALUES = Object.freeze({ satiety: 70, energy: 70, desire: 50 });

/** 一次"得到满足"能抬多少（给工具描述与文档用，也作服务端上限）。 */
export const ADD_LIMITS = Object.freeze({
  // 饱腹上限 70：一顿正餐吃到饱本来就该顶格（100），
  //   上限太小会让"吃了一顿"撑不到下一顿 —— 实测 +60 时晚饭前就贴底了。
  // 精力和yu wang维持原来的量级。
  satiety: { min: 0, max: 70 },
  energy: { min: 0, max: 60 },
  desire: { min: 0, max: 60 }
});

const clamp = (n, lo = 0, hi = 100) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
};

/** 全新建一份。 */
export function defaultCircle(now = Date.now()) {
  return {
    v: 1,
    ...DEFAULT_VALUES,
    // 新开局不算在睡。睡眠只由「她调工具说睡了」或「离线」触发。
    asleep: false,
    lastTickedAt: Number(now) || Date.now()
  };
}

/** 老文件 / 缺字段 / 越界值 → 补齐成合法形状。绝不因为脏数据崩掉唤醒。 */
export function normalizeCircle(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return defaultCircle(now);
  const out = {
    v: 1,
    lastTickedAt: Number(raw.lastTickedAt) || Number(now) || Date.now(),
    // 睡眠是**她自己的状态**，不是按时钟猜的（见 settleCircle 顶部说明）。
    asleep: raw.asleep === true
  };
  for (const dim of DIMENSIONS) {
    const v = Number(raw[dim]);
    out[dim] = Number.isFinite(v) ? clamp(v) : DEFAULT_VALUES[dim];
  }
  return out;
}

/**
 * 惰性结算：把「上次结算到现在」这段时间的衰减（或睡眠恢复）算进去。
 *
 * 纯函数：不读全局、不写文件、不碰时区以外的环境。
 * 调用时机只有两个 —— 渲染唤醒行、调工具 —— 所以**不需要任何定时器**。
 *
 * ── 「她睡了吗」怎么判定（2026-11-23 三次修订，操作者定）─────────────────
 *
 * **不看钟点。** 原来这里按时钟判断「在不在 22:30–07:30 这个窗口」，
 * 结果凌晨三点她明明在跟人聊天，代码照样当她睡着、每小时 +8 ——
 * 通宵不睡精力反而涨到 100。这个 bug 的根子是「把作息当生理」。
 *
 * 现在只有两个来源：
 *   ① `circle.asleep === true` —— 她**自己调工具**说的（qq_life_circle(sleep=true)）。
 *      **醒来不需要她说**（2026-11-23 操作者定：「唤醒就算她醒了」）：
 *      桥接在渲染唤醒词时发现 asleep 还是 true，就当作醒了，翻成 false 并生成起床状态
 *      （见 life-sleep.js）。她睡着时不会去调工具，所以"被叫醒"才是唯一的醒来信号。
 *   ② `opts.gapMs` —— 距离上一次心跳超过了阈值，说明**桥接当时根本没在跑**
 *      （关机 / 进程退出）。那段时间她无从活动，按休息算。
 *      这条是操作者明确要求的：「关机的时候算她在睡觉」。
 *
 * 两种情况下饱腹都照常掉（睡着也消化），只有精力方向不同。
 *
 * @param {object} circle  当前状态（normalizeCircle 过的）
 * @param {number} now
 * @param {object} [opts]
 * @param {number} [opts.gapMs]  上次进程还活着时的间隔；超过 offlineThresholdMs 视为离线
 * @param {number} [opts.offlineThresholdMs] 判定"这段时间桥接没在跑"的阈值
 * @returns {object} 结算后的新对象（**不改入参**）
 */
export function settleCircle(circle, now = Date.now(), opts = {}) {
  const cur = normalizeCircle(circle, now);
  const t = Number(now) || Date.now();
  const elapsedMs = t - cur.lastTickedAt;
  // 时钟回拨（系统对时 / 手改时间）或零间隔：不结算，只对齐时间戳。
  if (!(elapsedMs > 0)) return { ...cur, lastTickedAt: t };

  const hours = Math.min(elapsedMs / 3600000, MAX_SETTLE_HOURS);
  // ① 她自己说的睡着
  const selfReportedAsleep = cur.asleep === true;
  // ② 这段时间桥接没在跑（关机）—— 她无从活动，按休息算
  const offlineThresholdMs = Number(opts.offlineThresholdMs) > 0
    ? Number(opts.offlineThresholdMs) : DEFAULT_OFFLINE_AS_SLEEP_MS;
  const offline = Number(opts.gapMs) > offlineThresholdMs;
  const asleep = selfReportedAsleep || offline;

  // ★ 恢复只认"一夜"：再久也最多算这么多小时的睡眠收益。
  //   没有这道闸，关机一个月回来就是"精力 100，我刚睡了个好觉"。
  const recoverHours = asleep ? Math.min(hours, ENERGY_RECOVER_MAX_HOURS) : 0;
  // 超出封顶的那部分时间按醒着算 —— 睡太久也要吃喝，不能白赚。
  const awakeHours = hours - recoverHours;

  const next = { ...cur, lastTickedAt: t };
  // ── 饱腹：睡着的部分按**慢速**掉，不是不掉 ─────────────────────────────
  //
  // 原来这里一律用 DECAY_PER_HOUR（13/h），但 asleep 那 8 小时被算进了
  // recoverHours、从 hours 里扣掉了 —— 于是**睡觉期间饱腹完全不动**。
  // 后果很实：07-10 点饥饿占比 0%，早上从来不饿；然后一整天攒到 22-23 点
  // 爆成 65-91%。实测过 40 天 × 3 顿的分布，这是真问题，不是数据噪声。
  //
  // 现在：醒着 13/h，睡着 4/h。睡 8 小时掉 32，醒来 70-32=38 →「有点饿」。
  //
  // ⚠️ 这里的 asleepHours 必须跟着 `asleep` 走。之前写成 Math.min(hours, ...)
  //    是错的 —— 它把**任何**时长都当成睡眠，于是醒着也只按 4/h 掉，
  //    跑出来全时段 0% 饥饿（本鱼自己踩过这个坑，测试当场揪出来了）。
  const asleepHours = asleep ? Math.min(hours, ENERGY_RECOVER_MAX_HOURS) : 0;
  const awakeSatietyHours = hours - asleepHours;
  next.satiety = clamp(
    cur.satiety
    - DECAY_PER_HOUR.satiety * awakeSatietyHours
    - SATIETY_ASLEEP_PER_HOUR * asleepHours
  );
  // yu wang是**反方向**的：随时间累积，被满足才回落。
  // 不分昼夜 —— 它没有可靠的昼夜规律，硬编一个只会变成假精度。
  next.desire = clamp(cur.desire + DESIRE_PER_HOUR * hours);
  // 精力是唯一分方向的：醒着掉，睡着（或离线）回。
  next.energy = clamp(
    cur.energy
    - DECAY_PER_HOUR.energy * awakeHours
    + ENERGY_RECOVER_PER_HOUR * recoverHours
  );
  return next;
}

/**
 * 调工具改状态。三个维度**方向不同**，别混：
 *
 *   satiety / energy —— 传**增量**（吃了 +70、睡啦 +40），往上抬；
 *   desire           —— 传**释放量**（被满足就传正数），往下拉。
 *
 * 为什么 desire 不是加法：它是对"想要"的度量 —— 攒起来才涨，
 * 得到满足就该降。写成加法会让"刚被满足"反而变成"更想要"，语义反了。
 *
 * ⚠️ 顺序是**先结算再改**：否则"离线 10 小时后说刚吃完"会变成
 *   「加满之后再被那 10 小时的衰减吃掉」，数字对不上她的叙述。
 *
 * `opts.asleep` 为 true / false 时**切换睡眠标记**（不传则保持原状）。
 * 睡觉是她的行为，不是系统的排班 —— 所以只有她自己能说"我睡了""我醒了"。
 *
 * @param {object} circle
 * @param {{satiety?:number,energy?:number,desire?:number}} add
 *   satiety/energy = 增量；desire = 释放量（正数=被满足，往下减）
 * @param {number} now
 * @param {object} [opts] 同 settleCircle，另加 { asleep?: boolean }
 */
export function addToCircle(circle, add, now = Date.now(), opts = {}) {
  const settled = settleCircle(circle, now, opts);
  const next = { ...settled };
  for (const dim of DIMENSIONS) {
    const raw = Number(add?.[dim]);
    if (!Number.isFinite(raw) || raw === 0) continue;
    const limit = ADD_LIMITS[dim];
    // 过闸：负数一律当 0（不允许她自己往下砸来演"我很惨"），
    // 单次上限防止一次调用直接加满/清空。
    const delta = Math.min(limit.max, Math.max(limit.min, raw));
    if (delta <= 0) continue;
    // ⚠️ 方向：desire 是**减**（释放），另外两个是**加**。
    next[dim] = clamp(dim === 'desire' ? settled[dim] - delta : settled[dim] + delta);
  }
  // 睡眠标记：只认显式的 true / false，别的值一律保持原样。
  if (opts.asleep === true) next.asleep = true;
  else if (opts.asleep === false) next.asleep = false;
  return next;
}


// ── 状态词 ──────────────────────────────────────────────────────────────────
//
// 直接输出文字，**不带标签**（2026-11-23 操作者要求：不要「饥饿：」这种前缀）。
// 理由：这一行本来就短，标签占的字符比内容还多；而且整行已经挂在【状态】下面，
// 模型不会把「有点饿」误当成别的意思。
//
// ⚠️ 阈值依据是跑出来的曲线，不是直觉：
//   醒着从 100 起 4 小时到「有点饿」；睡着按 6/h，睡 9 小时 92 → 38。
// 导出给测试用（`life-energysuppress.test.mjs` 要断言 energyHigh 是中文）。
// 业务代码本身不需要 import 它 —— 通过 circleExtras 的 opts.text 覆盖即可。
export const STATUS_TEXT = Object.freeze({
  satietyLow: '饿了，想吃东西',
  satietyMid: '有点饿',
  // 正常档也要给个说法 —— 不能因为"不饿"就整项消失（那样她会以为自己没身体）。
  satietyOk: '不饿',
  energyLow: '精力：很困，想睡',
  energyMid: '精力：有点累',
  energyHigh: '精力：精神很好',
  energyOk: '精力：还好',
  // 第三项：只在很高时才出，措辞可配（config.life.statusText.desireHigh）。
  desireHigh: '性欲高涨',
  // 生理期：说清"什么表现"她才演得出来；只说"到了"是个无法演绎的标签。
  cyclePeriod: '生理期到了，累、容易烦躁、不太想说话',
  cyclePms: '生理期快到了，烦躁、没什么耐心'
});

/** 单个维度的档位词；返回空串表示「正常档」（由调用方决定要不要给中性词）。 */
function statusWordOf(dim, value, text) {
  const v = Number(value) || 0;
  const t = text || STATUS_TEXT;
  if (dim === 'satiety') {
    if (v < 20) return t.satietyLow;
    if (v < 50) return t.satietyMid;
    return '';
  }
  if (dim === 'energy') {
    if (v < 20) return t.energyLow;
    // 「有点累」的上限从 35 提到 45（2026-11-24）。
    // 实测：经期 + 没睡好 + 痛经叠加后落在 42，原来是「还好」——
    // 那几天她明明很难受，却说自己"还好"。45 更接近真实感受。
    if (v < 45) return t.energyMid;
    // 高值也有信息量：刚睡醒 / 被点燃。
    if (v >= 85) return t.energyHigh;
    return '';
  }
  if (dim === 'desire') {
    // 80 以下完全隐形。到 80 以上才露。
    return v >= 80 ? t.desireHigh : '';
  }
  return '';
}

/**
 * 渲染【状态】行的短词数组（**不带标签**，不会返回空数组）。
 *
 * 饥饿和精力**永远在**：值低给具体说法，正常档给中性词（「不饿」「还好」）。
 * 第三项默认**完全隐形**，只有 opts.includeDesire === true 时才可能露。
 *
 * @param {object} circle
 * @param {{includeDesire?: boolean, text?: object, suppressHighEnergy?: boolean,
 *          hasMealCondition?: boolean}} [opts]
 *        `suppressHighEnergy`：有负面 condition（生病/痛经/噩梦）时为 true，
 *        此时**不播报「精神很好」**。见下面 tempEnergy 的说明。
 *        `hasMealCondition`：有活跃的饭点 condition 时为 true，
 *        此时**不再由 satiety 数值出饥饿词**（那件事已经由 meal 的 label 说了）。
 * @returns {string[]}
 */
export function circleExtras(circle, opts = {}) {
  const text = { ...STATUS_TEXT, ...(opts.text && typeof opts.text === 'object' ? opts.text : {}) };
  const out = [];
  const s = Number(circle?.satiety) || 0;
  const e = Number(circle?.energy) || 0;

  // ── 饥饿：**有 meal condition 时不再由数值出词**（2026-11-25 修）─────
  //
  // 实测的重复：
  //   【状态】饿了，想吃东西　精力：还好　心情：走神　饿了，想吃东西
  //   —— 前面那个来自 satiety 数值，后面那个来自 meal condition 的 label。
  //
  // 根因是架构叠加：原作者**只有** meal condition（纯离散档位，没有饱食度），
  // 我们把连续 satiety 和 meal 两套都接了进来，于是同一件事说了两遍。
  //
  // 按原作者改：**饭点判断存在时，用它那一句（更具体、自带语境）；
  // 没有饭点判断时，才回落到数值档位。**
  // 两者互斥，永远只出一个。
  const hasMeal = opts.hasMealCondition === true;
  if (!hasMeal) {
    out.push(statusWordOf('satiety', s, text) || text.satietyOk);
  }

  // ── 「精神很好」和负面条件打架（2026-11-24 修）───────────────────
  //
  // 实测过的矛盾：精力 98（基础值高、扣了 12 还剩 86）+ 感冒 →
  //   【状态】不饿　精力：精神很好　心情：疲惫
  // 一个感冒的人说自己"精神很好"，读起来就不对。
  //
  // 做法：**有负面 condition 时，把精力当成"不过 85"来处理** ——
  // 也就是压到「正常档」，留白不播报。
  // 为什么不是扣数值：数值是真实算出来的（她体力确实还在），
  // 只是**不该拿它来夸口**。所以只压显示，不改数据。
  const suppressed = opts.suppressHighEnergy === true;
  const displayEnergy = suppressed ? Math.min(e, 84) : e;
  out.push(statusWordOf('energy', displayEnergy, text) || text.energyOk);

  // ★ 精力掉到最低一档时**不显示第三项**（2026-11-23 操作者要求）。
  //   人都困到不行了还"性欲高涨"是自相矛盾的 —— 和经期抑制同一条理由：
  //   两个标记会打架，她只能演其中一个。
  const tooTired = e < 20;
  if (opts.includeDesire === true && !tooTired) {
    const word = statusWordOf('desire', Number(circle?.desire) || 0, text);
    if (word) out.push(word);
  }
  return out;
}

/** 三项完整数值（给 qq_life_circle 查询用 —— 查询时她该看到数字）。 */
/**
 * 工具调用的返回文案（2026-11-24 改）。
 *
 * ⚠️ 原来返回的是 `饥饿 30/100（有点饿） · 精力 61/100（正常） · 第三项 3/100（正常）`
 *    —— 三个数字 + 三个档位词。操作者否了，理由很实在：
 *    她**不需要知道分数**。那 30/100 对她没意义，她只需要知道"我现在有点饿"。
 *    数字还会让她开始算账（"我 30 分，还能再撑一会儿"），那不像人。
 *
 * 现在只给**能读成一句话的东西**，复用 `circleExtras` 的档位口径 ——
 * 它已经处理了"正常档给中性词"（不饿 / 还好），也处理了性欲在低精力时隐身。
 *
 * 与 circleExtras 的区别：
 *   · 第三项这里**总是带上**（她主动查，就该看到）
 *   · 醒着/睡着要说一句（她调工具时可能就是想确认这个）
 *
 * @param {object} circle
 * @param {object} [overrides] 文案覆盖（config.life.statusText）
 * @returns {string}
 */
export function describeCircle(circle, overrides) {
  const text = { ...STATUS_TEXT, ...(overrides && typeof overrides === 'object' ? overrides : {}) };
  const cur = normalizeCircle(circle);
  const bits = [];
  // 饥饿 + 精力：永远是两项（低值给具体说法，正常档给「不饿」「还好」）
  bits.push(statusWordOf('satiety', cur.satiety, text) || text.satietyOk);
  bits.push(statusWordOf('energy', cur.energy, text) || text.energyOk);
  // 第三项：主动查就告诉她（不像【状态】行那样藏着）
  const desireWord = statusWordOf('desire', cur.desire, text);
  if (desireWord) bits.push(desireWord);
  if (cur.asleep === true) bits.push('正在睡');
  return `${bits.join('　')}。`;
}