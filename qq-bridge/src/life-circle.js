// 身体循环状态：精力 / yu wang。
//
// ── 设计取向（2026-11-26 修订：饥饿值已删除）──────────────────────────────
//
// 原来这里有连续三维（饱腹 / 精力 / 第三项），其中**饱腹是有害的**，已整项移除：
//
//   · 它 13/h 往下掉，从满到饿只要 3.8 小时 —— 一天得加五次才追得上；
//   · 实测她 47 小时只加过 2 次，于是【状态】行两天来一直挂着「饿了，想吃东西」。
//     那不是"偶尔饿"，那是**坏掉的钟**；
//   · 而饭点（life-vitals.js 的 MEAL_MOODS）本来就在说同一件事，
//     两套并存只会互相稀释，还会出现「不饿」和「饿了」同时显示的荒谬组合。
//
// 现在饥饿**只由饭点提醒表达**：「午饭时间饿了，想吃东西」这种带语境的话，
// 比一个掉到 0 的数字更像人。这也是原作者的做法 ——
// 它压根没有连续饥饿值，只有五个离散的饭点窗口。
//
// 剩下两维都是 0~100：
//   energy   精力   充盈度（低 = 困；睡着/离线回升）
//   desire   欲望   累积度（高 = 想要；被满足后回落）—— 方向和其他项相反
//
// ── 自动衰减是主驱动，她调工具加值是补充 ──────────────────────────────────
//
// 为什么不走"从她的话里判断"那条路：实测过一次就够呛 —— "我不饿""饿死我了
// 但刚吃完"全含关键词，方向正好相反；而 QQ 上"我好困啊"多数是在撒娇找话题，
// 不是在报数。抽错比不抽糟得多：她会说出自相矛盾的话。
//
// 所以职责切成两半：
//   · **时间负责往下掉**（纯函数、无歧义、不需要模型理解任何东西）
//   · **她负责往上抬**（qq_life_circle 传增量，只在真的做了某件事之后）
//
// ── 关于"不补算"的取舍 ─────────────────────────────────────────────────────
//
// 前面讨论时定过一条硬规则：**长时间离线不补算**。这里的落地是：
//   · **衰减**可以补算 —— 它单调、有底、不会编出"你过得很好"这种假话；
//     离线一个月回来，精力是 0，这是诚实的（时间确实过去了）。
//   · **恢复**绝不补算 —— 精力只在**确实落在睡眠窗内**的那段时间里回升，
//     且最多只认 10 小时（一夜的量）。
//     没有这道闸，关机一个月回来就是"精力 100，我刚睡了个好觉"，
//     然后她开始演"今天精神特别好"，而实际上只是主机断电了。
//
// 这一节是这份文件里最容易被后来人改坏的地方，注释写死在这里。

export const DIMENSIONS = Object.freeze(['energy', 'desire']);

/**
 * 每小时的自然变化。
 *
 * ⚠️ 注意方向：`energy` 是**充盈度**（掉下去 = 困）；
 *    `desire` 是**累积度**（涨上来 = 想要）。两者方向相反，别抄错。
 */
export const DECAY_PER_HOUR = Object.freeze({
  energy: 3.0,
  // yu wang 1.2/h **往上累**（见下面 DESIRE_PER_HOUR 的说明，别在这里再扣一次）。
  desire: 0
});

/**
 * yu wang的**累积**速率（每小时**加**）。
 *
 * 它的语义和精力相反：
 *   · 精力是"用掉的资源"，会掉，她调工具补回来；
 *   · yu wang是"攒起来的张力"，会涨，**被满足后回落**。
 * 所以 `qq_life_circle(add.desire)` 传的是**减少量**（见 addToCircle）。
 *
 * 1.2/h：从 0 起算约 4 天到顶。这个量级是刻意的 ——
 * 太快（比如 5/h）它会长期贴着 100，唤醒词里天天出现同一句；
 * 太慢（比如 0.3/h）一个正常作息下来根本到不了 80，功能等于没有。
 */
export const DESIRE_PER_HOUR = 1.2;

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

/** 默认值：刚醒、平静。不用 100，避免"一开局就满血"。 */
export const DEFAULT_VALUES = Object.freeze({ energy: 70, desire: 50 });

/** 一次"得到满足"能抬多少（给工具描述与文档用，也作服务端上限）。 */
export const ADD_LIMITS = Object.freeze({
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
    v: 2,
    ...DEFAULT_VALUES,
    // 新开局不算在睡。睡眠只由「她调工具说睡了」或「离线」触发。
    asleep: false,
    // 入睡时刻（毫秒）。**只有 addToCircle(asleep=true) 会写，结算不动它。**
    //
    // ★ 2026-11-26 新增，修的是一个很隐蔽的 bug：
    //   原来"睡了多久"是用 lastTickedAt 算的，而 lastTickedAt 每次结算都推到现在
    //   （面板轮询、每轮唤醒都会触发结算）。实测她 00:02 说睡了，
    //   01:34 时 lastTickedAt 已经晚 91 分钟；睡满 8 小时期间被结算十几次，
    //   读出来的 sleptMs 就是 0 —— 于是「睡够自动醒」永远不触发，
    //   噩梦的「睡够 1 小时才做梦」也永远不成立。
    asleepSince: 0,
    lastTickedAt: Number(now) || Date.now()
  };
}

/** 老文件 / 缺字段 / 越界值 → 补齐成合法形状。绝不因为脏数据崩掉唤醒。 */
export function normalizeCircle(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return defaultCircle(now);
  const asleep = raw.asleep === true;
  const lastTickedAt = Number(raw.lastTickedAt) || Number(now) || Date.now();
  // 老数据（v1）没有 asleepSince —— 退化成"上次结算时刻"当起点。
  // 那是当时唯一能拿到的近似值，比当成"刚睡着"安全：会正常走去自动醒，
  // 而不是因为 sleptMs=0 卡在「睡够 1 小时才做梦」那道闸前面。
  const rawSince = Number(raw.asleepSince);
  const asleepSince = asleep
    ? (Number.isFinite(rawSince) && rawSince > 0 ? rawSince : lastTickedAt)
    : 0;
  const out = {
    // ★ 2026-11-26：v1 → v2。v1 有 satiety，v2 没有。
    //   老文件读进来**直接丢掉饱腹字段**，不需要迁移脚本 ——
    //   饥饿值本来就已经烂到 0 了，没有值得保留的信息。
    v: 2,
    lastTickedAt,
    // 睡眠是**她自己的状态**，不是按时钟猜的（见 settleCircle 顶部说明）。
    asleep,
    asleepSince
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
 *   ① `circle.asleep === true` —— 她**自己调工具**说的（qq_life_circle(asleep=true)）。
 *      **醒来不需要她说**（2026-11-23 操作者定：「唤醒就算她醒了」）：
 *      桥接在渲染唤醒词时发现 asleep 还是 true，就当作醒了，翻成 false 并生成起床状态
 *      （见 life-sleep.js）。她睡着时不会去调工具，所以"被叫醒"才是唯一的醒来信号。
 *   ② `opts.gapMs` —— 距离上一次心跳超过了阈值，说明**桥接当时根本没在跑**
 *      （关机 / 进程退出）。那段时间她无从活动，按休息算。
 *      这条是操作者明确要求的：「关机的时候算她在睡觉」。
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
  // 超出封顶的那部分时间按醒着算 —— 睡太久也不该白赚。
  const awakeHours = hours - recoverHours;

  const next = { ...cur, lastTickedAt: t };
  // yu wang是**反方向**的：随时间累积，被满足才回落。
  // 不分昼夜 —— 它没有可靠的昼夜规律，硬编一个只会变成假精度。
  next.desire = clamp(cur.desire + DESIRE_PER_HOUR * hours);
  // 精力是唯一分方向的：醒着掉，睡着（或离线）回。
  next.energy = clamp(
    cur.energy
    - DECAY_PER_HOUR.energy * awakeHours
    + ENERGY_RECOVER_PER_HOUR * recoverHours
  );
  // ⚠️ 这里**不动 asleep / asleepSince**：睡眠是行为，不是结算的产物。
  return next;
}

/**
 * 调工具改状态。两维**方向不同**，别混：
 *
 *   energy —— 传**增量**（睡啦 +40、歇一会儿 +10~20），往上抬；
 *   desire —— 传**释放量**（被满足就传正数），往下拉。
 *
 * 为什么 desire 不是加法：它是对"想要"的度量 —— 攒起来才涨，
 * 得到满足就该降。写成加法会让"刚被满足"反而变成"更想要"，语义反了。
 *
 * ⚠️ 顺序是**先结算再改**：否则"离线 10 小时后说刚睡醒"会变成
 *   「加满之后再被那 10 小时的衰减吃掉」，数字对不上她的叙述。
 *
 * `opts.asleep` 为 true / false 时**切换睡眠标记**（不传则保持原状）。
 * 睡觉是她的行为，不是系统的排班 —— 所以只有她自己能说"我睡了""我醒了"。
 *
 * @param {object} circle
 * @param {{energy?:number, desire?:number}} add
 *   energy = 增量；desire = 释放量（正数=被满足，往下减）
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
    // ⚠️ 方向：desire 是**减**（释放），energy 是**加**。
    next[dim] = clamp(dim === 'desire' ? settled[dim] - delta : settled[dim] + delta);
  }
  // 睡眠标记：只认显式的 true / false，别的值一律保持原样。
  const t = Number(now) || Date.now();
  if (opts.asleep === true) {
    // 只在"从醒到睡"的那一下记起点；重复调 asleep=true 不重置它。
    if (next.asleep !== true) next.asleepSince = t;
    next.asleep = true;
  } else if (opts.asleep === false) {
    next.asleep = false;
    next.asleepSince = 0;
  }
  return next;
}


// ── 状态词 ──────────────────────────────────────────────────────────────────
//
// 直接输出文字，**不带标签**（2026-11-23 操作者要求：不要「饥饿：」这种前缀）。
// 理由：这一行本来就短，标签占的字符比内容还多；而且它已经挂在【状态】下面，
// 模型不会把「有点累」误当成别的意思。
//
// ⚠️ 饥饿那三条（satietyLow / satietyMid / satietyOk）已于 2026-11-26 随饥饿值
//    一起删除 —— 现在饥饿只由饭点 condition 的 label 说。
// 导出给测试用（`life-energysuppress.test.mjs` 要断言 energyHigh 是中文）。
export const STATUS_TEXT = Object.freeze({
  energyLow: '精力：很困，想睡',
  energyMid: '精力：有点累',
  energyHigh: '精力：精神很好',
  energyOk: '精力：还好',
  // 第三项：只在很高时才出，措辞可配（config.life.statusText.desireHigh）。
  desireHigh: '欲望高涨',
  // 生理期：说清"什么表现"她才演得出来；只说"到了"是个无法演绎的标签。
  cyclePeriod: '生理期到了，累、容易烦躁、不太想说话',
  cyclePms: '生理期快到了，烦躁、没什么耐心'
});

/** 单个维度的档位词；返回空串表示「正常档」（由调用方决定要不要给中性词）。 */
function statusWordOf(dim, value, text) {
  const v = Number(value) || 0;
  const t = text || STATUS_TEXT;
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
 * 渲染【状态】行的短词数组（**不带标签**）。
 *
 * ★ 2026-11-26：饥饿项已删除。现在这里**只出精力**（第三项按开关可能加一项），
 *   所以返回值可能只有 1 个元素 —— 调用方必须按数组长度处理，不能假定 2 项。
 *
 * @param {object} circle
 * @param {{includeDesire?: boolean, text?: object, suppressHighEnergy?: boolean}} [opts]
 *        `suppressHighEnergy`：有负面 condition（生病/痛经/噩梦）时为 true，
 *        此时**不播报「精神很好」**。见下面 displayEnergy 的说明。
 * @returns {string[]}
 */
export function circleExtras(circle, opts = {}) {
  const text = { ...STATUS_TEXT, ...(opts.text && typeof opts.text === 'object' ? opts.text : {}) };
  const out = [];
  const e = Number(circle?.energy) || 0;

  // ── 「精神很好」和负面条件打架（2026-11-24 修）───────────────────
  //
  // 实测过的矛盾：精力 98（基础值高、扣了 12 还剩 86）+ 感冒 →
  //   【状态】精力：精神很好　心情：疲惫
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
  //   人都困到不行了还"欲望高涨"是自相矛盾的 —— 和经期抑制同一条理由：
  //   两个标记会打架，她只能演其中一个。
  const tooTired = e < 20;
  if (opts.includeDesire === true && !tooTired) {
    const word = statusWordOf('desire', Number(circle?.desire) || 0, text);
    if (word) out.push(word);
  }
  return out;
}

/**
 * 工具调用的返回文案（2026-11-26 修订：饥饿项已删除）。
 *
 * ⚠️ 原来返回的是 `饥饿 30/100（有点饿） · 精力 61/100（正常） · 第三项 3/100（正常）`
 *    —— 三个数字 + 三个档位词。操作者否了，理由很实在：
 *    她**不需要知道分数**。那 30/100 对她没意义，她只需要知道"我现在有点累"。
 *    数字还会让她开始算账（"我 30 分，还能再撑一会儿"），那不像人。
 *
 * 现在只给**能读成一句话的东西**，复用 `circleExtras` 的档位口径 ——
 * 它已经处理了"正常档给中性词"（还好），也处理了第三项在低精力时隐身。
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
  bits.push(statusWordOf('energy', cur.energy, text) || text.energyOk);
  // 第三项：主动查就告诉她（不像【状态】行那样藏着）
  const desireWord = statusWordOf('desire', cur.desire, text);
  if (desireWord) bits.push(desireWord);
  if (cur.asleep === true) bits.push('正在睡');
  return `${bits.join('　')}。`;
}
