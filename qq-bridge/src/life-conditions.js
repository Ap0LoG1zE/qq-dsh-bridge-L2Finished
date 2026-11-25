// 状态叠加层：带 TTL 的 condition（2026-11-24）。
//
// ── 为什么要这一层 ──────────────────────────────────────────────────────────
//
// 在只有连续数值的时候，「经期 + 没睡好 + 感冒」只能各改各的数 —— 一个数只能
// 表示"总体有多累"，说不出是哪件事让她累，也没法各自到期消失。
//
// condition 补的就是这块：**每条是一个独立的事实，带自己的起止时间和影响**。
// 它们叠加成最终状态，到点自动消失，不需要任何清理代码。
//
// ── 与 AstrBot private_companion_v2 的关系 ──────────────────────────────────
//
// 结构上参考了它的 `state_conditions`（_make_condition / _get_active_conditions），
// 但我们**不抄**它那两个我们还用不着的东西：
//   · 它每天重掷一批词表 —— 我们的饥饿/精力是连续漂移的，不需要日掷；
//   · 它的 `intensity` 会把所有 energy_delta 再乘一次系数 —— 那等于
//     "同一条 condition 在不同人设强度下效果不同"，调试时极难换算。
//     我们只保留 intensity 作为**排序用**的权重（mood_bias 取最大值靠它），
//     不影响数值。
//
// ── 三条硬规则（改代码前先读）─────────────────────────────────────────────
//
// ① **energyDelta 不改写 circle.energy，只在渲染时叠加。**
//    写进数值就变成"历史不可回溯"：条件过期后你不知道原来的值是多少。
//
// ② **活动判定只看 `startTs <= now < endTs`**，不存"是否已结束"。
//    这样时钟回拨、进程重启、改系统时间都不会卡住一条已经过期的 condition。
//
// ③ **恢复尾声（onEndTransition）只在"自然到期"时触发**，
//    被手动移除的（比如她说"我好了"）不触发 —— 否则会出现
//    "刚说没事了，系统又给她加一个恢复尾声"。

/** 支持的 onEndTransition 形态。空串表示到期就消失，不留尾巴。 */
export const TRANSITIONS = Object.freeze({
  NONE: '',
  // 病好了还有几小时的"还没完全恢复"
  HEALTH_RELIEF: 'health_relief',
  // 睡得很沉/很差之后的一次过渡
  SLEEP_REBOUND: 'sleep_rebound',
  // 一般的"余温"（被关心之后、情绪事件之后）
  SOFT_AFTERGLOW: 'soft_afterglow'
});

const HOUR = 3600000;

/** 一条 condition 的默认形状。 */
function normalizeCondition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const kind = String(raw.kind || '').trim();
  if (!id || !kind) return null;
  const startTs = Number(raw.startTs);
  const endTs = Number(raw.endTs);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) return null;
  return {
    id,
    kind,
    // 给人看的一句话，也是**唯一会进唤醒词的那段文字**
    label: String(raw.label || '').slice(0, 80),
    // 情绪底色用。空串表示不参与 mood_bias 竞争。
    mood: String(raw.mood || '').slice(0, 12),
    // 对精力的影响（负值=更累）。只在渲染时叠加，不改 circle.energy。
    energyDelta: Number.isFinite(Number(raw.energyDelta)) ? Number(raw.energyDelta) : 0,
    // 排序权重：mood_bias 取最高的那一个。0~100。
    intensity: Math.min(100, Math.max(0, Number(raw.intensity) || 50)),
    startTs,
    endTs,
    // 附加标记：经期不适存具体类型（痛经/头痛…），方便统计与去重。
    phase: String(raw.phase || ''),
    onEndTransition: String(raw.onEndTransition || ''),
    // 已消费的恢复尾声生成器，防止同一条 condition 被反复处理。
    transitionDone: raw.transitionDone === true
  };
}

/** 把外部数组整理成合法 condition 列表（丢掉坏数据，不抛错）。 */
export function normalizeConditions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const c = normalizeCondition(item);
    if (c) out.push(c);
  }
  return out;
}

/** 现在还活着的（startTs <= now < endTs）。 */
export function activeConditions(list, now = Date.now()) {
  const t = Number(now) || Date.now();
  return normalizeConditions(list).filter((c) => c.startTs <= t && t < c.endTs);
}

/** 已过期的那些（用于触发恢复尾声 / 清理）。 */
export function expiredConditions(list, now = Date.now()) {
  const t = Number(now) || Date.now();
  return normalizeConditions(list).filter((c) => c.endTs <= t);
}

/**
 * 叠加后的精力。**只用于渲染，不写回 circle.energy。**
 *
 * @param {number} baseEnergy  sphere 结算出来的精力（0~100）
 * @param {object[]} conditions
 * @param {number} [now]
 * @returns {{value:number, applied:object[]}}
 */
export function composeEnergy(baseEnergy, conditions, now = Date.now()) {
  const active = activeConditions(conditions, now);
  let sum = 0;
  const applied = [];
  for (const c of active) {
    if (!c.energyDelta) continue;
    sum += c.energyDelta;
    applied.push(c);
  }
  const base = Number(baseEnergy);
  const value = Math.min(100, Math.max(0, (Number.isFinite(base) ? base : 0) + sum));
  return { value, applied, delta: sum };
}

/**
 * 情绪底色：取**活跃且带 mood** 的 condition 里 intensity 最高的那个。
 *
 * 为什么是"取最大"而不是加权平均：
 *   平均会把「疲惫」和「很兴奋」混成「一般」，那是个没有意义的词。
 *   取最大的意思是"此刻哪种感受最占上风"，更贴近人怎么描述自己。
 *
 * @returns {{mood:string, from:object|null}}
 */
export function composeMood(conditions, now = Date.now()) {
  const active = activeConditions(conditions, now).filter((c) => c.mood);
  if (!active.length) return { mood: '', from: null };
  const top = active.reduce((a, b) => (b.intensity > a.intensity ? b : a));
  return { mood: top.mood, from: top };
}

/**
 * 处理到期：把**自然过期且有 onEndTransition** 的 condition 变成恢复尾声。
 *
 * @param {object[]} list 当前全部（含已过期）
 * @param {number} now
 * @param {(spec:object)=>object|null} makeTransition
 *        由调用方提供「transition 类型 → 新的 condition 草稿」的映射，
 *        这样 transition 的具体词表留在上层，本模块只负责状态推进。
 * @returns {{list:object[], created:object[]}}
 */
export function reapExpired(list, now = Date.now(), makeTransition = null) {
  const t = Number(now) || Date.now();
  const all = normalizeConditions(list);
  const created = [];
  const kept = [];
  for (const c of all) {
    if (c.endTs > t) { kept.push(c); continue; }
    // 已经处理过 → 直接丢（不再触发第二次）
    if (c.transitionDone) continue;
    if (c.onEndTransition && typeof makeTransition === 'function') {
      let next = null;
      try {
        next = makeTransition({ ...c, expiredAt: t });
      } catch {
        next = null;
      }
      const norm = normalizeCondition(next);
      if (norm) created.push(norm);
    }
    // 无论有没有生出尾声，这条原 condition 都不再保留。
  }
  return { list: [...kept, ...created], created };
}

/** 生成一条 condition（id 由调用方给，保证同源可去重）。 */
export function makeCondition({
  id,
  kind,
  label = '',
  mood = '',
  energyDelta = 0,
  intensity = 50,
  startTs = Date.now(),
  durationHours = 1,
  phase = '',
  onEndTransition = ''
}) {
  const start = Number(startTs) || Date.now();
  const hours = Math.max(0.016, Number(durationHours) || 1);   // 最少约 1 分钟
  return normalizeCondition({
    id,
    kind,
    label,
    mood,
    energyDelta,
    intensity,
    startTs: start,
    endTs: start + hours * HOUR,
    phase,
    onEndTransition,
    transitionDone: false
  });
}

/** 手动移除（她说"我好了"这类）。返回新数组，不改入参。 */
export function removeConditions(list, predicate) {
  if (typeof predicate !== 'function') return normalizeConditions(list);
  return normalizeConditions(list).filter((c) => !predicate(c));
}

/** 同一个 id 已经活着就别再插一条（防重复触发）。 */
export function upsertCondition(list, condition) {
  const cur = normalizeConditions(list);
  const norm = normalizeCondition(condition);
  if (!norm) return cur;
  const idx = cur.findIndex((c) => c.id === norm.id);
  if (idx >= 0) {
    const next = cur.slice();
    next[idx] = norm;
    return next;
  }
  return [...cur, norm];
}

/**
 * 同 kind **只保留 intensity 最高的那一条**（2026-11-24）。
 *
 * 为什么需要：恢复尾声是自动生成的，一次到期可能同时生出两条
 * （sleep_rebound + soft_afterglow），拼进唤醒词就是两句意思相近的废话。
 * 真实的人也只会说"还有点没缓过来"，不会同时描述两种余韵。
 *
 * 注意：**只对指定的 kind 生效**。cycle_discomfort / health 这类
 * 本来就不该并存，但由调用方各自的去重逻辑管（一天一次），
 * 这里只处理"尾声堆积"这一类问题。
 *
 * @param {object[]} list
 * @param {string[]} kinds 要合并的 kind 列表
 * @returns {object[]}
 */
export function dedupeByKind(list, kinds = ['afterglow']) {
  const cur = normalizeConditions(list);
  const targets = new Set(kinds);
  const best = new Map();      // kind → intensity 最高的那条
  const rest = [];
  for (const c of cur) {
    if (!targets.has(c.kind)) { rest.push(c); continue; }
    const prev = best.get(c.kind);
    if (!prev || c.intensity > prev.intensity) best.set(c.kind, c);
  }
  return [...rest, ...best.values()];
}
