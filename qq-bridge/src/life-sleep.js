// 睡醒那一刻的「起床状态」。
//
// ── 为什么不做 LLM 生成的梦（2026-11-23 操作者定）─────────────────────────
//
// AstrBot 那套做梦是**一次独立模型调用**：把碎片 + 主题 + prompt 发给模型，
// 让它输出 180–600 字的梦境 JSON，再拿回来做成 dream_aftertaste 条件。
//
// 我们这边开不了这个口子：**我们的"模型"是一个完整 agent turn**。
// 为了生成一句梦话单独开一个会话，成本比那一段文字本身高两个数量级。
//
// 所以改成：**只做"睡得好不好"这一个维度**，不生成梦境内容。
//
//   她睡了 → 结算精力恢复 → 按恢复得怎么样，给一句起床状态
//   "昨晚睡得很浅，半夜醒过" / "睡得踏实" / "翻来覆去很久才睡着"
//
// 这句话放进唤醒词，她自己在下一轮里决定要不要提、怎么提。
// **不需要模型预先写梦**，效果上接近：她知道自己是"没睡好"还是"睡饱了"。
//
// ── 那句状态是从哪来的（不是随机抽签）─────────────────────────────────────
//
// 定这条的目的是：**状态要有因果**，不能是"今天抽到恍惚"。
//
//   恢复量 = 结算前后精力差
//   · 恢复 ≥ 满额 85%  → 睡得很踏实
//   · 恢复 60–85%      → 睡得还行
//   · 恢复 30–60%      → 睡得断断续续
//   · 恢复 < 30%       → 基本没睡好
//   · 睡眠时长极短（<2h）→ 睡了一小会儿
//   · 睡眠时长极长（>10h）→ 睡太久了，有点懵
//
// 再叠一个：**入睡时刻**。凌晨 3 点后才睡 → 加一句"睡得太晚了"。
//
// 所以同一句"睡得浅"背后是真实的恢复量偏低，而不是抽签抽到的。
//
// ── 为什么不用 note ────────────────────────────────────────────────────────
//
// AstrBot 那边会把状态拼成一句话存进 note，再用**关键词匹配**去读它
// （note 里有「疲惫」就扣意愿分）。那是"读自己写的文本再翻译一次"，
// 既不可靠又多余。这里直接读结构化的恢复量，一步到位。

/** 睡眠时长的档位（小时）。只用于「短」和「长」两个极端，正常长度返回空串。 */
export const SLEEP_LENGTH_BUCKETS = Object.freeze([
  { maxHours: 2, text: '只睡了一小会儿' },
  { maxHours: 4, text: '睡得不久' },
  { maxHours: Infinity, text: '' }   // 4 小时以上不额外说长度（长睡眠由 tooLong 单独处理）
]);

/** 恢复质量的档位（占满额比例）。 */
export const RECOVERY_BUCKETS = Object.freeze([
  { minRatio: 0.85, text: '睡得很踏实' },
  { minRatio: 0.60, text: '睡得还行' },
  { minRatio: 0.30, text: '睡得断断续续，中途醒过' },
  { minRatio: 0, text: '基本没睡好' }
]);

/** 凌晨几点之后算"睡得太晚"。 */
export const LATE_SLEEP_HOUR = 2;

const clamp = (n, lo, hi) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
};

/** 恢复比例 → 一句话。 */
export function recoveryText(recoveredPoints, maxPoints) {
  const max = Number(maxPoints);
  if (!(max > 0)) return '';
  const ratio = clamp(Number(recoveredPoints) / max, 0, 1);
  for (const bucket of RECOVERY_BUCKETS) {
    if (ratio >= bucket.minRatio) return bucket.text;
  }
  return '';
}

/** 睡眠时长 → 一句话（正常长度返回空串）。 */
export function lengthText(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return '';
  for (const bucket of SLEEP_LENGTH_BUCKETS) {
    if (h < bucket.maxHours) return bucket.text;
  }
  return '';
}

/**
 * 生成一句起床状态。
 *
 * 纯函数：只吃数字，不读状态、不看时钟。便于测试，也不会因为并发写入而漂。
 *
 * @param {object} p
 * @param {number} p.hours          睡了多久（小时）
 * @param {number} p.recovered      这段时间实际回升了多少精力（点）
 * @param {number} p.maxRecover     这一夜理论最多能回多少（点）
 * @param {number} [p.sleptAtHour]  入睡时刻（0–23，本地时区）；未知可不传
 * @returns {string} 一句话；什么都没得说时返回空串
 */
export function buildWakeText({ hours, recovered, maxRecover, sleptAtHour } = {}) {
  const h = Number(hours);
  const parts = [];

  // ── 短睡眠优先，并且**改用质量句** ──────────────────────────────────────
  // 踩过的坑：只睡 1.5 小时、精力回了 12/12（比例 100%）→ 判成「睡得很踏实」。
  // 但 1.5 小时不可能是踏实。比例只能描述"这段睡眠的效率"，
  // **不能描述"睡得够不够"**。所以时长过短时，质量句换成中性的长度描述。
  const tooShort = Number.isFinite(h) && h > 0 && h < 4;
  if (tooShort) {
    parts.push(lengthText(h) || '没睡多久');
  } else {
    const quality = recoveryText(recovered, maxRecover);
    if (quality) parts.push(quality);
  }

  // 睡太久（≥10h）单独一句，且**不再说"踏实"**。
  // 睡 13 小时不会是"睡得很踏实"——那通常是前一夜欠了觉，反而更累。
  const tooLong = Number.isFinite(h) && h >= 10;
  if (tooLong) {
    // 把已加进去的质量句换成中性的长睡眠描述。
    parts.length = 0;
    parts.push('睡太久了，起来还有点懵');
  }

  const hour = Number(sleptAtHour);
  if (Number.isFinite(hour)) {
    const hh = ((hour % 24) + 24) % 24;
    if (hh >= LATE_SLEEP_HOUR && hh < 6) parts.push('睡得太晚了');
  }
  if (!parts.length) return '';
  return `${parts.join('，')}。`;
}

/**
 * 判断「这次算不算一次真正的起床」。
 *
 * 只在这几种情况下返 true：
 *   · 之前 asleep === true，现在要醒了；
 *   · 之前 asleep 未知（老数据），但离线上限已经过完（关机一夜）；
 * 否则返回 false —— 醒来状态只该出现一次，不能每轮都贴。
 *
 * @param {object} before  结算前
 * @param {object} after   结算后（asleep 已置 false）
 * @returns {boolean}
 */
export function didJustWakeUp(before, after) {
  return before?.asleep === true && after?.asleep === false;
}

export const wakeInternal = { clamp, recoveryText, lengthText };
