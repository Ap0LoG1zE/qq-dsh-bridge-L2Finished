// 状态生成：health / sleep / care_warmth / 恢复尾声的词表与掷骰规则。
//
// ── 设计取向（2026-11-24）─────────────────────────────────────────────────
//
// 抄 AstrBot private_companion_v2 的核心策略：**默认平淡，偶尔有事**。
//   每天大部分时间不生病、睡眠普通 —— 那才是常态。
//   词表第一条就是"平淡"项，只有概率命中才换成特殊项。
//   这样做的好处在很后面才显现：**特殊情况一旦出现，它才有信息量**。
//
// 所有词表都很小（3~6 条）是刻意的：
//   词表越大，每次抽出来的句子越离谱；小而准比大而全有用。
//
// ── 谁决定"今天病不病" ──────────────────────────────────────────────────
//
// **不是随机生病，是从环境推病因**（照抄它的 _build_health_causes）：
//   睡眠质量差 + 天气（雨/阴/风/极冷极热）+ 昨天熬夜  →  凑够几条
//   条数越多，命中概率越高。
// 这样"下雨天有点发飘"会自己长出来，而不是凭空掷骰。

const HOUR = 3600000;

// ── sleep：昨晚睡得怎样 ────────────────────────────────────────────────────
// 第 0 条是默认（平淡）。
//
// ⚠️ 2026-11-24 修：**这一组不设 mood**。
//   原来给"睡得浅"配 mood='迟钝'，于是唤醒词出现「心情：迟钝」——
//   那是**身体状态**（没睡醒、反应慢），不是心情。读者一看就别扭：
//   "迟钝"描述的是脑子转得慢，不是心里什么感觉。
//   睡眠的质量已经通过 energyDelta 表达（扣精力），不需要再抢心情位。
//   心情只留给真正的情绪事件：痛经的疲惫、被关心的柔和、经前的烦躁。
export const SLEEP_POOL = Object.freeze([
  { label: '睡得还行', mood: '', energyDelta: 0, hours: 8 },
  { label: '睡得挺沉，一觉到天亮', mood: '轻快', energyDelta: 6, hours: 8 },
  { label: '睡得有点浅，夜里醒过几次', mood: '迟钝', energyDelta: -8, hours: 8 },
  { label: '翻来覆去很久才睡着', mood: '迟钝', energyDelta: -10, hours: 8 },
  { label: '熬到很晚才睡，睡的时候天都快亮了', mood: '低落', energyDelta: -12, hours: 8 }
]);

// ── health：身体不舒服 ────────────────────────────────────────────────────
//
// ⚠️ mood 一律用**感受词**，不用"迟钝/困倦"这类**能力词**。
//   区分标准：能不能填进"我现在觉得___"。
//     「疲惫」「虚弱」「烦躁」 → 能（是感受）
//     「迟钝」「困倦」         → 不能（是状态描述，读者会觉得别扭）
export const HEALTH_POOL = Object.freeze([
  { label: '有点不舒服，说不清是哪儿', mood: '虚弱', energyDelta: -10, hours: 20 },
  { label: '头有点晕，起身的时候眼前发黑', mood: '虚弱', energyDelta: -14, hours: 22 },
  { label: '嗓子干痒，说话有点费劲', mood: '疲惫', energyDelta: -10, hours: 24 },
  { label: '鼻子不通，整个人昏昏沉沉', mood: '疲惫', energyDelta: -12, hours: 26 },
  { label: '胃不太舒服，不太想吃东西', mood: '虚弱', energyDelta: -14, hours: 18 }
]);

/**
 * 从环境凑「病因」。返回命中的原因列表（每条 +1 权重）。
 *
 * 抄 AstrBot 的 `_build_health_causes`（:4559）的判据，但**只用我们真有的数据**：
 * 睡眠结论、天气文本、温度。没有的（昨日日记标签）不硬造。
 *
 * @param {object} ctx
 * @param {string} [ctx.sleepLabel]  昨天的睡眠结论
 * @param {string} [ctx.weatherText] 天气文本（含「雨」「阴」「风」等）
 * @param {number} [ctx.tempC]       当前温度
 * @returns {string[]}
 */
export function buildHealthCauses(ctx = {}) {
  const causes = [];
  const sleep = String(ctx.sleepLabel || '');
  if (/浅|很晚|翻来覆去|醒过/.test(sleep)) causes.push('没睡好');

  const weather = String(ctx.weatherText || '');
  if (/雨|雪|雷/.test(weather)) causes.push('下雨下雪');
  else if (/阴|雾|霾/.test(weather)) causes.push('天阴');

  const temp = Number(ctx.tempC);
  if (Number.isFinite(temp)) {
    if (temp <= 10) causes.push('太冷');
    else if (temp >= 30) causes.push('太热');
  }
  return causes;
}

/**
 * 今天病的概率。**条数越多越可能**，但有上限。
 *
 * 公式照 AstrBot 的 `min(0.42, 0.12 + n × 0.1 × intensity)`：
 *   0 条原因 → 12%（基线，人也会莫名其妙不舒服）
 *   1 条 → 22%，2 条 → 32%，3 条 → 42%（封顶）
 * 封顶很重要：没有它，又下雨又冷又没睡好会到 60%+，那不真实。
 */
export function healthChance(causeCount, intensity = 0.5) {
  const n = Math.max(0, Number(causeCount) || 0);
  // intensity 是 0~1 的人设强度（默认 0.5）。它只影响"斜率有多陡"，
  // 不影响 0 条的基线 —— 基线 12% 是"人也会莫名不舒服"，跟人设无关。
  const k = Math.min(1, Math.max(0, Number(intensity) || 0.5));
  const slope = 0.1 * (k / 0.5);
  return Math.min(0.42, 0.12 + n * slope);
}

// ── care_warmth：被关心之后 ────────────────────────────────────────────────
// 这条不是自动滚的 —— 由 qq_life_circle(cared=true) 触发。
export const CARE_POOL = Object.freeze([
  { label: '被关心了一下，心里软了一点', mood: '柔和', energyDelta: 4, hours: 3 }
]);

// ── 饭点心情（2026-11-24 补）────────────────────────────────────────────────
//
// 抄 AstrBot `_ensure_time_based_hunger_condition` 的五个窗口与心情词。
// 这是我们**正向心情的主要来源** —— 之前只有"柔和"一个。
//
// 关键设计：**心情按钟点给，不按饥饿值给**。
//   午饭饿的时候人是"走神"（想别的），晚饭饿是"粘人"（想找人），
//   夜宵是"松散"（放松下来）。同一个"饿"，不同时刻感觉不一样。
//
// `kinds` 里 `sweet` 是正向（想吃甜的 = 馋，不是饿），其余是负向。
export const MEAL_MOODS = Object.freeze([
  { id: 'breakfast', startMin: 7 * 60, endMin: 9 * 60 + 30, label: '想吃点热的', mood: '柔软', energyDelta: -4, hours: 2, sweet: false },
  { id: 'lunch', startMin: 11 * 60, endMin: 13 * 60 + 40, label: '饿了，想吃东西', mood: '走神', energyDelta: -6, hours: 2, sweet: false },
  { id: 'afternoon', startMin: 15 * 60, endMin: 17 * 60, label: '想吃甜的', mood: '柔软', energyDelta: 2, hours: 2, sweet: true },
  { id: 'dinner', startMin: 17 * 60 + 30, endMin: 20 * 60, label: '饿了，想吃点热的', mood: '粘人', energyDelta: -5, hours: 3, sweet: false },
  { id: 'late_snack', startMin: 21 * 60 + 30, endMin: 23 * 60 + 30, label: '有点想吃东西', mood: '松散', energyDelta: -3, hours: 2, sweet: false }
]);

/**
 * 当前落在哪个饭点窗口。不在任何窗口返回 null。
 *
 * ★ 2026-11-26：**饥饿值已删除，这个函数不再看"她有多饿"。**
 *
 *   原来是 `mealMoodAt(minute, { satiety })`，刚吃完就压掉"饿了"那几条。
 *   但连续饥饿值整项移除之后（它 13/h 掉、她 47 小时只加过 2 次、长期贴着 0），
 *   没有任何东西能说明"她刚吃完"了。
 *
 *   现在的口径是**纯时段**：到了午饭窗口就说"想吃东西"。
 *   这比"先查她饿不饿再说"更接近人 —— 到点会想吃饭，不需要先饿到某个分数。
 *   而且她真吃过一顿时，`qq_life_circle` 会顺手清掉这些饭点 condition
 *   （见 bridge.js 里"吃过饭清掉饿了类 condition"那段），所以不会刚吃完就说饿。
 *
 * @param {number} minuteOfDay
 * @returns {object|null} MEAL_MOODS 里的一条（副本）
 */
export function mealMoodAt(minuteOfDay) {
  const m = Number(minuteOfDay);
  if (!Number.isFinite(m)) return null;
  const hit = MEAL_MOODS.find((w) => m >= w.startMin && m < w.endMin);
  if (!hit) return null;
  return { ...hit };
}

// ── 睡意回升（positive）────────────────────────────────────────────────────
// 睡够了之后的"补回来一点精神"。这是入睡 durationHours 之后挂的尾声。
export const SLEEP_AFTERGLOW_SPEC = Object.freeze({
  label: '睡意缓解后的轻度回升', mood: '轻松', energyDelta: 8, hours: 8
});

// ── 周期恢复（positive）────────────────────────────────────────────────────
// 月经期结束后的那一两天：不难受了，但还没完全回到稳定。
export const CYCLE_RECOVERY_SPEC = Object.freeze({
  label: '生理期后，慢慢回到稳定状态', mood: '松弛', energyDelta: -5, hours: 24
});

// ── 梦（2026-11-24 重做）───────────────────────────────────────────────────
//
// 分两池，**用途完全不同**：
//
//   NIGHTMARE_POOL  噩梦 —— **会把她弄醒**，并触发一次主动唤醒。
//                   关键词是「惊醒」：惊醒了才会想找人说话。
//                   情绪偏负面、能量扣得多、mood 多样化。
//
//   DREAM_POOL      普通梦 —— **不唤醒她**，只是醒来之后（跨天第一轮）
//                   在唤醒词里给她看一句"我昨晚梦见了什么"。
//                   有正向的梦（照原作者：他 4 条里有一条「柔和 +4」）。
//
// 为什么分开：原来只有噩梦池，于是"做梦"必然等于"半夜被叫醒"——
// 这不真实。人大部分日子做梦是安安静静到天亮的。
//
// ── 权重怎么算（照原作者 daily_state.py 的 pick）──────────────────────────
//
//   def pick(pool, special_chance=0.35):
//       if random.random() > special_chance * max(0.2, intensity):
//           return pool[0]                    # 绝大多数取默认项
//       return random.choice(pool[1:])        # 掷中了才从特殊项里抽
//
// 也就是**两段式**：
//   ① 先决定"今晚有没有事"（概率受 intensity 缩放）
//   ② 有事的话，从特殊项里**均匀抽**（原作者没有逐条权重）
//
// 这样"默认无事"是一个真实的档位，而不是靠把概率压到极小来凑。

// 正常梦（不唤醒）。第一条是默认项 —— 大多数夜晚都在这里。
export const DREAM_POOL = Object.freeze([
  { label: '', mood: '', energyDelta: 0, hours: 0 },                                    // 默认：没有记住梦
  { label: '梦见走过一段很安静的路，路灯和风声都很近', mood: '柔和', energyDelta: 4, hours: 4 },
  { label: '梦见小时候住过的地方，走廊比记忆里长', mood: '恍惚', energyDelta: -2, hours: 3 },
  { label: '梦见一直在找一件放错地方的小东西，醒来还残着没找完的感觉', mood: '恍惚', energyDelta: -6, hours: 5 },
  { label: '梦里反复听见一句没听清的话，醒来后胸口还有点闷', mood: '低落', energyDelta: -10, hours: 7 },
  { label: '梦见吃到很好吃的东西，醒来还在回味', mood: '轻快', energyDelta: 3, hours: 3 },
  { label: '梦见下了一场很大的雨，自己站在屋檐底下看', mood: '安静', energyDelta: 1, hours: 4 }
]);

/**
 * 噩梦（会唤醒）。
 *
 * 主题覆盖心理学里公认的高频噩梦类型（威胁模拟理论那几类）：
 *   被追赶 / 坠落 / 迷路找不到 / 牙齿脱落 / 考试没准备 / 发不出声音 / 当众出丑
 *
 * mood 刻意分散到六种 —— 原来五条全是"恍惚"，读起来像同一个梦换了说法。
 */
export const NIGHTMARE_POOL = Object.freeze([
  { label: '梦见被什么追着跑，腿怎么都迈不动', mood: '慌张', energyDelta: -6, hours: 2 },
  { label: '梦见从很高的地方掉下去，醒来心跳得厉害', mood: '慌张', energyDelta: -7, hours: 2 },
  { label: '梦见在一栋不认识的楼里找出口，怎么走都回到原地', mood: '不安', energyDelta: -4, hours: 3 },
  { label: '梦见牙齿一颗一颗松了，怎么按都按不住', mood: '不安', energyDelta: -5, hours: 3 },
  { label: '梦见考试铃响了，卷子还是一个字没写', mood: '慌张', energyDelta: -6, hours: 2 },
  { label: '梦见想喊却发不出声音，喉咙里像堵着东西', mood: '压抑', energyDelta: -7, hours: 3 },
  { label: '梦见站在一群人面前，忘了自己要说什么', mood: '羞耻', energyDelta: -5, hours: 2 },
  { label: '梦见妈妈在很远的地方叫自己的名字，怎么走都到不了', mood: '低落', energyDelta: -8, hours: 4 },
  { label: '梦见一直在赶一班永远赶不上的车', mood: '疲惫', energyDelta: -5, hours: 3 },
  { label: '梦见房间里多了一个人，看不见脸', mood: '不安', energyDelta: -6, hours: 3 }
]);

// ── 恢复尾声（onEndTransition 的产物）──────────────────────────────────────
//
// ⚠️ 文案必须**跟它由来的那条一致**，不能反过来。
//   这里踩过一个坑：sleep_rebound 原来写「睡得太沉了，起来还有点懵」，
//   但触发它的往往是「睡得有点浅」—— 两句话语义正好相反，
//   拼在唤醒词里就是自相矛盾。现在改成中性表达：只说她"还没缓过来"，
//   不断言睡得深还是浅。
export const AFTERGLOW_POOL = Object.freeze({
  health_relief: {
    // 2026-11-24：mood 从「迟钝」改成「平缓」。
    //   「迟钝」留给"没睡醒反应慢"；病好之后是"整体好转但还虚"，
    //   用"平缓"更准，也不会和她当天的睡眠状态打架。
    label: '好了大半，还有点没缓过来', mood: '平缓', energyDelta: -4, hours: 6
  },
  sleep_rebound: {
    label: '刚醒那阵还有点懵，慢慢才回神', mood: '', energyDelta: 2, hours: 3
  },
  soft_afterglow: {
    label: '心里还留着一点余温', mood: '柔和', energyDelta: 2, hours: 2
  }
});

/** 按权重抽一条，返回 spec 副本（不改原表）。rand 可注入便于测试。 */
export function pickFromPool(pool, rand = Math.random) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const idx = Math.floor(Math.min(0.999999, Math.max(0, rand())) * pool.length);
  return { ...pool[idx] };
}

/**
 * **两段式抽取**（照原作者 `daily_state.py` 的 `pick`）。
 *
 * ```
 * if random() > specialChance × max(0.2, intensity): return pool[0]
 * return random.choice(pool[1:])
 * ```
 *
 * 差异在哪：`pickFromPool` 是均分——每次调用必然出一条。
 * 这个版本先过一道"今晚有没有事"的闸：
 *   · 没掷中 → 返回 `pool[0]`（默认项，通常是"没有记住梦"）
 *   · 掷中   → 从 `pool[1:]` 里均分
 *
 * 这样"平淡"是一个真实的档位，不需要靠把概率压到 0.03 来凑。
 *
 * @param {object[]} pool 第一条必须是默认项
 * @param {object} [opts]
 * @param {number} [opts.specialChance] 基础命中率，默认 0.35（原作者值）
 * @param {number} [opts.intensity]     0~1，默认 0.5（= 人设强度 50%）
 * @param {() => number} [opts.rand]
 * @returns {{spec: object|null, isDefault: boolean, roll: number, threshold: number}}
 */
export function pickWithDefault(pool, opts = {}) {
  if (!Array.isArray(pool) || !pool.length) {
    return { spec: null, isDefault: true, roll: 1, threshold: 0 };
  }
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const base = Number.isFinite(Number(opts.specialChance)) ? Number(opts.specialChance) : 0.35;
  const rawIntensity = Number(opts.intensity);
  const intensity = Number.isFinite(rawIntensity) ? rawIntensity : 0.5;
  // max(0.2, intensity)：强度再低也留 20% 的底，否则"特殊事件永不发生"
  const threshold = base * Math.max(0.2, intensity);
  const roll = rand();
  if (roll > threshold || pool.length === 1) {
    return { spec: { ...pool[0] }, isDefault: true, roll, threshold };
  }
  const rest = pool.slice(1);
  const idx = Math.floor(Math.min(0.999999, Math.max(0, rand())) * rest.length);
  return { spec: { ...rest[idx] }, isDefault: false, roll, threshold };
}

/**
 * 昨天睡得怎样 —— 用**她昨天有没有说"睡了"**来判断，而不是掷骰。
 *
 * 这是我们的实现比原作者强的一点：他只能日掷一个 sleep 词表；
 * 我们真有 `asleep` 标记和结算时长，能算出"这一觉睡了几小时"。
 *
 * @param {object} opts
 * @param {number} opts.sleepHours 最近一次睡眠结算出的实际时长（小时）
 * @param {number} [opts.energyGain] 那一觉让精力涨了多少
 * @param {() => number} [opts.rand]
 * @returns {object} SLEEP_POOL 里的一条
 */
export function sleepVerdict(opts = {}) {
  const hours = Number(opts.sleepHours);
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  // ★ 2026-11-26 修：**没有数据就一个字都不说**（label 给空串）。
  //
  // 原来这里返回 SLEEP_POOL[0]，而它第一条的 label 正是「睡得还行」——
  // 于是"她根本没说自己睡过"也会在跨天第一轮冒出一句「醒了，睡得还行」。
  // 11-26 00:01 那次就是这样：她 23:30 只是收尾了对话，00:02:56 才说"我睡了"，
  // 可唤醒词里已经先写上了起床语。
  //
  // 空 label 是**契约**：调用方（bridge.js 的 sleep 分支）只在 label 非空时
  // 才写 condition / 塞 pendingSleepQuality，所以空串 = 这一整套都不发生。
  if (!Number.isFinite(hours) || hours <= 0) return { ...SLEEP_POOL[0], label: '' };
  if (hours < 4) return { ...SLEEP_POOL[4] };
  if (hours < 6) return { ...SLEEP_POOL[2] };
  if (hours < 7) return { ...SLEEP_POOL[3] };
  if (hours > 10) return { ...SLEEP_POOL[1] };
  // 正常区间：偶尔给一条"睡得挺沉"，多数是平淡。
  return rand() < 0.3 ? { ...SLEEP_POOL[1] } : { ...SLEEP_POOL[0] };
}

/** 生成恢复尾声 condition 的草稿（给 life-conditions 的 reapExpired 用）。 */
export function makeAfterglow(transitionKind, now = Date.now()) {
  const spec = AFTERGLOW_POOL[transitionKind];
  if (!spec) return null;
  return {
    id: `afterglow-${transitionKind}-${Math.floor(Number(now) / 1000)}`,
    kind: 'afterglow',
    label: spec.label,
    mood: spec.mood,
    energyDelta: spec.energyDelta,
    // ★ 尾声的 intensity 必须**低于真实事件**（痛经 70、health 65、sleep 55）。
    //   否则它会抢走情绪底色：实测出现"刚痛完 → 底色变成恍惚"，
    //   那不对 —— 尾声是余韵，不该盖过正事。
    intensity: 30,
    startTs: Number(now) || Date.now(),
    endTs: (Number(now) || Date.now()) + spec.hours * HOUR,
    phase: transitionKind,
    onEndTransition: '',
    transitionDone: false
  };
}
