// 主动消息的「动机候选」。
//
// ── 文案来源（2026-11-24 操作者逐条裁定）─────────────────────────────────
//
// 结构、触发条件、概率、窗口、follow-up 链**全部照抄** AstrBot
// `private_companion_v2@archive/v6.7.2`。
// 文案逐条裁定如下（**改动前请先看这张表，别凭印象改**）：
//
//   | 候选          | 用谁的                                   |
//   |---------------|------------------------------------------|
//   | 早晨·睡浅     | 我们的：昨晚没睡好，醒来还带着睡意，想先轻轻说声早安 |
//   | 早晨·睡好     | 我们的：昨晚睡得挺好，刚起来就想去打个招呼   |
//   | 傍晚天色      | **原作者的**：傍晚路上的天色很好看，想拍给他看看 |
//   | 下午问候      | 我们的：下午节奏缓下来一点，想看看他是不是也能歇会儿 |
//   | 睡前还没困    | 我们的：明明快该睡了，但还是想找他说说话     |
//   | 累了一天      | 我们的：今天快结束了，累了一天，睡前想聊两句  |
//   | 中午犯困      | 原作者（改动后更顺口）：中午这会儿有点犯困，想短短说句话 |
//   | 小想法        | 我们的模板：刚刚想到"X"，想顺手分享一下      |
//   | 天气·雨       | 原作者的：听见外面下雨，想短短提一声         |
//   | 天气·晴       | 我们的：外面天色不错，想拍给你看看           |
//
// 唯一统一改动：「用户」→「他」（唤醒词是给她自己看的，用「你」她会当成在说她自己）。
//
// 原始出处：
//   · `daily_state.py::_generate_morning_linked_proactive_events`   (约 2388 行)
//   · `daily_state.py::_generate_daypart_linked_proactive_events`   (约 2514 行)
//   · `daily_state.py::_generate_weather_linked_proactive_events`   (约 3457 行)
//   · `daily_state.py::_pick_weather_window`                        (约 3486 行)
//
// ── follow-up 链（照原作者做）───────────────────────────────────────────────
//
// 每条候选带 `chain`：
//   [{kind:"name_only_opener"},                       ← 先只叫名字
//    {kind:"if_no_reply", after_minutes:80, ...},     ← 没回 80 分钟，换角度再问
//    {kind:"if_still_no_reply", after_minutes:140}]   ← 再没回，语气从耐心转调侃
//
// **最多三级，绝不纠缠。** 判定用"没有回复"＝没读（操作者确认的口径）。

/**
 * @typedef {object} ChainStep
 * @property {'name_only_opener'|'if_no_reply'|'if_still_no_reply'} kind
 * @property {number} [after_minutes] 仅 if_* 有效
 * @property {string} [reason]
 * @property {string} [topic]
 * @property {string} [motive]
 * @property {string} [tone]
 */

/** 候选优先级：越具体越小。 */
export const PRIORITY = Object.freeze({
  MORNING: 10,
  WEATHER: 20,
  DAYPART: 30,
  AMBIENT: 40,
  RANDOM: 90
});

/** 分钟数落在闭开区间里。 */
const inRange = (minute, start, end) => minute >= start && minute < end;

// ══ A. 早晨问候 ════════════════════════════════════════════════════════════
//
// 原作者默认窗口 8:20–9:50，可用 `_morning_greeting_window` 覆盖。
// 每支的 window 由 `morning_window(delay_minutes, span_minutes)` 算出：
//   start = min(8:20 + delay, 9:42)
//   end   = min(9:50, max(start+8, start+span))
export const MORNING_BASE = Object.freeze({ start: 8 * 60 + 20, end: 9 * 60 + 50 });

/** 复刻原作者的 morning_window()。返回 { start, end }（分钟数）。 */
export function morningWindow(delayMinutes = 0, spanMinutes = 30) {
  const morning_start = MORNING_BASE.start;
  const morning_end = MORNING_BASE.end;
  const latest_start = Math.max(morning_start, morning_end - 8);
  const start = Math.min(morning_start + Math.max(0, delayMinutes), latest_start);
  const end = Math.min(morning_end, Math.max(start + 8, start + Math.max(8, spanMinutes)));
  return { start, end };
}

/**
 * 早晨候选。照抄原作者的**分支顺序与互斥规则**：
 *   1. sleep 含「赖床/闹钟/起得有点迟/还没完全开机/懵懵/有点懵」 → 迷糊
 *   2. elif sleep 含「睡得很浅/半夜醒/一晚上都在做梦/失眠」      → 迟钝
 *   3. 独立：energy >= 62 且 45%                                → 清爽
 *   4. 条件遍历：含「睡眠延续」且 55%                            → 半梦半醒
 *   5. 或：label 含「赖床/闹钟/起得有点迟」                      → 迷糊又有点乱
 * 最后 `return events[:2]`。
 *
 * ⚠️ 我们的 `sleep` 只有「睡眠时长」，没有原作者那样的自由文本。
 *    所以第 1、2 支用**时长**映射：<6.5h 视为睡浅那一支。
 *    这是唯一偏离原文的地方，写在注释里以便日后核对。
 */
export function morningCandidates(ctx = {}) {
  const minute = Number(ctx.minuteOfDay);
  if (!Number.isFinite(minute)) return [];
  // 原作者由调度器在窗口内调用；我们这里再兜一道窗口判断。
  if (!inRange(minute, MORNING_BASE.start, MORNING_BASE.end)) return [];
  if (ctx.alreadySentToday) return [];

  const rand = typeof ctx.rand === 'function' ? ctx.rand : Math.random;
  const energy = Number(ctx.energy);
  const sleepHours = Number(ctx.sleepHours);
  const out = [];

  // ① 睡浅（原文：sleep_text 含「睡得很浅/半夜醒/一晚上都在做梦/失眠」）
  if (Number.isFinite(sleepHours) && sleepHours > 0 && sleepHours < 6.5) {
    out.push({
      id: 'morning-light',
      reason: 'morning_greeting',
      action: 'message',
      window: morningWindow(6, 28),
      why: '醒来还带着一点睡意时,迷迷糊糊先发一声早安。',
      topic: '没完全醒的早安',
      motive: '昨晚没睡好，醒来还带着睡意，想先轻轻说声早安',
      scene: '人还带着睡意的时候',
      tone: '迟钝',
      impulse: '想轻轻说声早安',
      mood: '迟钝',
      priority: PRIORITY.MORNING,
      chain: [
        { kind: 'name_only_opener' },
        { kind: 'if_no_reply', after_minutes: 90, reason: 'check_in', topic: '早安余韵', motive: '已经清醒过来，但刚刚和他说过的早安还没得到回应,猜测他还在休息', tone: '耐心等待' },
        { kind: 'if_still_no_reply', after_minutes: 150, reason: 'morning_greeting', topic: '催他起床', motive: '他依旧没有回应，该催他起床了', tone: '调侃' }
      ]
    });
  }

  // ② 睡得好（原文：energy >= 62 且 45%）—— 注意原文这里是**独立 if**，不是 elif。
  //    但两支都出会让同一早晨有两条问候，所以我们在下面按"最具体优先"只留第一条。
  if (Number.isFinite(energy) && energy >= 62 && rand() < 0.45) {
    out.push({
      id: 'morning-fresh',
      reason: 'morning_greeting',
      action: 'message',
      window: morningWindow(3, 24),
      why: '睡得很好,习惯性地想去打个招呼。',
      topic: '早安',
      motive: '昨晚睡得挺好，刚起来就想去打个招呼',
      scene: '刚从床上爬起来的时候',
      tone: '清爽',
      impulse: '想轻轻说早安',
      mood: '清爽',
      priority: PRIORITY.MORNING,
      chain: [
        { kind: 'name_only_opener' },
        { kind: 'if_no_reply', after_minutes: 85, reason: 'check_in', topic: '早安余韵', motive: '刚刚和他说了早安但没得到回应,猜测他还在休息', tone: '耐心等待' },
        { kind: 'if_still_no_reply', after_minutes: 145, reason: 'morning_greeting', topic: '催他起床', motive: '他依旧没有回应，该催他起床了', tone: '调侃' }
      ]
    });
  }

  // ③ 兜底问候（2026-11-24 补，**原作者没有这一支**）。
  //
  // 为什么必须加：上面两支有硬门槛 ——
  //   睡浅要 sleepHours < 6.5，睡好要 energy >= 62。
  // 于是「睡 7 小时、精力 60」这种**最常见的普通早晨**两条都进不去，
  // 一整个早晨不会有任何问候。实测确认过这个空洞。
  //
  // 概率压到 0.35：平淡的早晨本来就该大多数时候什么都不说。
  if (rand() < 0.35) {
    out.push({
      id: 'morning-plain',
      reason: 'morning_greeting',
      action: 'message',
      window: morningWindow(8, 26),
      why: '醒来之后，习惯性地想打个招呼。',
      topic: '早安',
      motive: '刚醒，习惯性地想打个招呼',
      scene: '刚起来的时候',
      tone: '平稳',
      impulse: '想轻轻说早安',
      mood: '平稳',
      priority: PRIORITY.MORNING
    });
  }

  // ④ 睡觉继续（原文：cond.title 含「睡眠延续」且 55%）
  //    我们目前没有这个 condition，保留分支以便后续接上。
  if (ctx.hasSleepContinuation === true && rand() < 0.55) {
    out.push({
      id: 'morning-drowsy',
      reason: 'morning_greeting',
      action: 'message',
      window: morningWindow(10, 30),
      why: '睡意延续到白天,有种半梦半醒的感觉',
      topic: '刚醒来后脑子晕乎乎的',
      motive: '依旧带着睡意的早安问候',
      scene: '依旧带着睡意',
      tone: '半梦半醒',
      impulse: '醒来迷迷糊糊的，想轻轻说早安',
      mood: '迟钝',
      priority: PRIORITY.MORNING
    });
  }

  // ④ 早晨小插曲（原文：cond.label 含「赖床/闹钟/起得有点迟」）
  if (ctx.hasMorningIncident === true) {
    out.push({
      id: 'morning-incident',
      reason: 'morning_greeting',
      action: 'message',
      window: morningWindow(6, 32),
      why: '早晨发生了一点生活小插曲，和他抱怨一句或打个招呼。',
      topic: '早晨的生活小插曲',
      motive: '早上折腾了一下,想来找他吐个小槽',
      scene: '被早晨的小事故折腾了一下之后',
      tone: '迷糊又有点乱',
      impulse: '想顺手分享早上的生活小插曲',
      mood: '迷糊',
      priority: PRIORITY.MORNING
    });
  }

  // 原文 `return events[:2]`；早晨问候一天只该有一条，我们取第一条
  // （数组已按"睡浅 > 睡好 > 延续 > 插曲"的原文顺序压入）。
  return out.slice(0, 1);
}

// ══ B. 白天状态 ════════════════════════════════════════════════════════════
//
// 原文里五个 `if` **互相独立**（不是 elif），各自有窗口和概率。
// 最后 `return events[:3]`。
export function daypartCandidates(ctx = {}) {
  const minute = Number(ctx.minuteOfDay);
  if (!Number.isFinite(minute)) return [];
  const rand = typeof ctx.rand === 'function' ? ctx.rand : Math.random;
  const energy = Number(ctx.energy);
  const out = [];

  // ① 中午犯困：36~68 且 58%，窗口 12:10-13:30
  if (Number.isFinite(energy) && energy >= 36 && energy <= 68
    && inRange(minute, 12 * 60 + 10, 13 * 60 + 30) && rand() < 0.58) {
    out.push({
      id: 'noon-sleepy',
      reason: 'noon_greeting',
      action: 'message',
      window: { start: 12 * 60 + 10, end: 13 * 60 + 30 },
      why: '中午有些犯困，想短短打声招呼。',
      topic: '午后犯困',
      motive: '中午这会儿有点犯困，想短短说句话',
      scene: '午后犯困的时候',
      tone: '懒洋洋',
      impulse: '想趁午后休息时短短说一句',
      mood: '懒洋洋',
      priority: PRIORITY.DAYPART
    });
  }

  // ② 傍晚天色：天气含「晚霞/晴/阳光/多云」且 52%，窗口 17:20-19:10
  const weather = String(ctx.weatherText || '');
  if (/晚霞|晴|阳光|多云/.test(weather)
    && inRange(minute, 17 * 60 + 20, 19 * 60 + 10) && rand() < 0.52) {
    out.push({
      id: 'evening-sky',
      reason: 'activity_share',
      action: 'message',
      window: { start: 17 * 60 + 20, end: 19 * 60 + 10 },
      why: '傍晚天色好看时，想拍一张路上的画面给他看。',
      topic: '傍晚路上',
      motive: '傍晚路上的天色很好看，想拍给他看看',
      scene: '傍晚走在路上时',
      tone: '松弛',
      impulse: '想顺手分享傍晚路上的画面',
      mood: '松弛',
      priority: PRIORITY.DAYPART
    });
  }

  // ③ 下午问候：45~82 且 46%，窗口 15:20-17:10
  if (Number.isFinite(energy) && energy >= 45 && energy <= 82
    && inRange(minute, 15 * 60 + 20, 17 * 60 + 10) && rand() < 0.46) {
    out.push({
      id: 'afternoon-checkin',
      reason: 'check_in',
      action: 'message',
      window: { start: 15 * 60 + 20, end: 17 * 60 + 10 },
      why: '下午短暂休息时，想轻轻问一句他那边怎么样。',
      topic: '下午短暂休息',
      motive: '下午节奏缓下来一点，想看看他是不是也能歇会儿',
      scene: '下午短暂休息的时候',
      tone: '平静',
      impulse: '好奇他在做什么',
      mood: '微松',
      priority: PRIORITY.DAYPART
    });
  }

  // ④ 突然的小想法：48%，窗口按当前钟点分
  //    原文 motive 是 f-string：`刚刚想到"{topic}"，想顺手分享一下`
  if (rand() < 0.48) {
    // ⚠️ 2026-11-24：占位符「一件小事」已去掉。
    //    原来没传 thoughtTopic 时会拼出「刚刚想到“一件小事”，想顺手分享一下」——
    //    一眼就是模板，唤醒词里出现这种句子等于告诉她"这是系统写的"。
    //    现在默认按时段给具体说法（见 defaultThoughtTopic），照原作者
    //    `_pick_life_thought_topic` 的兜底口径。
    const topic = String(ctx.thoughtTopic || defaultThoughtTopic(minute));
    const win = (minute >= 12 * 60 && minute < 18 * 60)
      ? { start: 14 * 60 + 40, end: 18 * 60 + 40 }
      : { start: 19 * 60 + 20, end: 21 * 60 + 40 };
    if (inRange(minute, win.start, win.end)) {
      out.push({
        id: 'ambient-thought',
        reason: 'activity_share',
        action: 'message',
        window: win,
        why: '日常里突然冒出一个小想法，想短短说一句。',
        topic,
        motive: `刚刚想到“${topic}”，想顺手分享一下`,
        scene: '闲下来的时候',
        tone: '自然',
        impulse: '想把刚冒出来的小想法顺口提一下',
        mood: '微妙',
        priority: PRIORITY.AMBIENT
      });
    }
  }

  // ⑤ 睡前还没困：昨晚失眠/睡浅 且 50%，窗口 22:10-23:25
  if (ctx.lastNightRestless === true
    && inRange(minute, 22 * 60 + 10, 23 * 60 + 25) && rand() < 0.5) {
    out.push({
      id: 'late-unwilling',
      reason: 'quiet_care',
      action: 'message',
      window: { start: 22 * 60 + 10, end: 23 * 60 + 25 },
      why: '睡前还没完全困下来，想随便聊两句',
      topic: '睡前还没困下来',
      motive: '明明快该睡了，但还是想找他说说话',
      scene: '准备睡觉但还没困下来的时候',
      tone: '平静',
      impulse: '想在睡前聊天',
      mood: '安静',
      conversation_posture: 'closing',
      priority: PRIORITY.DAYPART
    });
  }

  // ⑥ 累了一天：energy < 42 且 42%，窗口 19:40-21:10
  if (Number.isFinite(energy) && energy < 42
    && inRange(minute, 19 * 60 + 40, 21 * 60 + 10) && rand() < 0.42) {
    out.push({
      id: 'evening-tired',
      reason: 'quiet_care',
      action: 'message',
      window: { start: 19 * 60 + 40, end: 21 * 60 + 10 },
      why: '累了一天之后，想在睡前和他聊聊天',
      topic: '一天快结束时',
      motive: '今天快结束了，累了一天，睡前想聊两句',
      scene: '一天快结束的时候',
      tone: '疲惫',
      impulse: '想在睡前聊天',
      mood: '疲惫',
      conversation_posture: 'closing',
      priority: PRIORITY.DAYPART
    });
  }

  return out.slice(0, 3);
}

// ══ C. 天气 ════════════════════════════════════════════════════════════════
//
// 原文：天气消息为空就不生成；最多 1 条（`events[:1]`）。
//
// ⚠️ 窗口用原作者的 `_pick_weather_window(kind)`（原文约 3486 行）：
//     rain：6-11 点 → 08:20-10:40；11-17 → 12:40-16:30；17-23 → 18:10-21:10；其余 09:00-10:30
//     clear：16-20 点 → 17:10-19:20；其余 15:30-18:10
//
// 本鱼第一版漏了这段窗口，导致**凌晨 3 点也能说"外面天色不错"**。
// 这是抄漏，不是有意偏离 —— 已按原文补齐。
export function pickWeatherWindow(weatherKind, hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return { start: 0, end: 0 };
  if (weatherKind === 'rain') {
    if (h >= 6 && h < 11) return { start: 8 * 60 + 20, end: 10 * 60 + 40 };
    if (h >= 11 && h < 17) return { start: 12 * 60 + 40, end: 16 * 60 + 30 };
    if (h >= 17 && h < 23) return { start: 18 * 60 + 10, end: 21 * 60 + 10 };
    return { start: 9 * 60, end: 10 * 60 + 30 };
  }
  if (h >= 16 && h < 20) return { start: 17 * 60 + 10, end: 19 * 60 + 20 };
  return { start: 15 * 60 + 30, end: 18 * 60 + 10 };
}

export function weatherCandidates(ctx = {}) {
  const weather = String(ctx.weatherText || '');
  if (!weather) return [];
  const minute = Number(ctx.minuteOfDay);
  if (!Number.isFinite(minute)) return [];
  const hour = Math.floor(minute / 60);
  const rand = typeof ctx.rand === 'function' ? ctx.rand : Math.random;
  const out = [];

  // 雨：24%
  if (/雨|阵雨|雷|小雨|中雨|大雨/.test(weather) && rand() < 0.24) {
    const win = pickWeatherWindow('rain', hour);
    if (inRange(minute, win.start, win.end)) {
      out.push({
        id: 'weather-rain',
        reason: 'activity_share',
        action: 'message',
        weather_linked: true,
        source: 'weather_context',
        window: win,
        why: `外面在下雨，想短短提一句。${weather}`,
        topic: '外面下雨了',
        motive: '听见外面下雨，想短短提一声',
        mood: '安静',
        priority: PRIORITY.WEATHER
      });
    }
  }

  // 晴：12%
  if (/晴|阳光|多云|晚霞/.test(weather) && rand() < 0.12) {
    const win = pickWeatherWindow('clear', hour);
    if (inRange(minute, win.start, win.end)) {
      out.push({
        id: 'weather-nice',
        reason: 'activity_share',
        action: 'message',
        weather_linked: true,
        source: 'weather_context',
        window: win,
        why: `外面的天色有点好看，想短短提一句。${weather}`,
        topic: '天色有点好看',
        motive: '外面天色不错',
        mood: '松弛',
        priority: PRIORITY.WEATHER
      });
    }
  }

  return out.slice(0, 1);
}

/**
 * 汇总所有生成器，按优先级排序。
 *
 * ⚠️ 原作者是"三个生成器各自返回，由上层调度器合并"。
 *    我们这里合并在一个函数里，但**保留各自的截断规则**
 *    （早晨 [:2] / 白天 [:3] / 天气 [:1]，我们早晨取 1、白天取 3、天气取 1）。
 *
 * @param {object} ctx
 * @returns {Array} 候选数组（空 = 这次没有理由开口）
 */
export function buildProactiveCandidates(ctx = {}) {
  const all = [];
  const safe = (fn) => {
    try {
      const got = fn(ctx);
      if (Array.isArray(got)) all.push(...got);
    } catch {
      // 任何生成器坏掉都不能影响其它几个。
    }
  };
  safe(morningCandidates);
  safe(daypartCandidates);
  safe(weatherCandidates);
  const out = all
    .filter((c) => c && c.id && c.reason)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));
  // ★ 2026-11-25：**具体候选一个都没有时，退到兜底理由池**。
  //
  //   实测：一天 96 个采样点里 **83 个**候选为 0。
  //   原因是所有具体候选都有硬窗口（早晨 8:20–9:50、傍晚天色 17:20–19:10 …），
  //   窗口之外就彻底没理由了，于是落到 bridge.js 的概率兜底 ——
  //   而概率兜底的 reason 是裸的 `proactiveCheck`，**没有动机**，
  //   唤醒词里一个字都不说，她只能干看着四条没回的消息发呆（真实案例）。
  //
  //   原作者的解法是 `_choose_planned_reason()`：从**理由池**里随机抽一个
  //   "此刻仍然说得通"的由头（activity_share / diary_share / check_in /
  //   quiet_care …），再交给 `_choose_proactive_motive()` 生成动机文本。
  //   所以永远不会出现"叫醒了但不说为什么"。
  //
  //   这里照同样的结构补一层。优先级排在所有具体候选之后（RANDOM=90）。
  if (!out.length) {
    const fill = ambientFallbackCandidates(ctx);
    if (fill.length) out.push(...fill);
  }
  return out;
}

/**
 * 兜底理由池 —— 具体候选全落空时用。
 *
 * 照原作者 `_choose_planned_reason`（`proactive_engine.py`）的权重思路：
 *   activity_share 抽中概率最高（原始列表里出现 3~5 次），
 *   diary_share / check_in / quiet_care 次之。
 * 我们改编成**按当前时段与状态挑一个说得通的**，而不是纯随机 ——
 * 凌晨 3 点说"下午缓下来想问问你"同样是假话。
 *
 * 每条都必须带 `motive`：**没有动机的候选等于没理由叫醒她**，
 * 这正是这次要修的问题。
 *
 * @param {object} ctx 同 buildProactiveCandidates
 * @returns {object[]} 按优先级排好的**全部**可用理由（上层去重后取第一条）
 */
export function ambientFallbackCandidates(ctx = {}) {
  const minute = Number(ctx.minuteOfDay);
  if (!Number.isFinite(minute)) return [];
  const energy = Number(ctx.energy);
  const weather = String(ctx.weatherText || '');
  const hour = Math.floor(minute / 60);

  // 池子：每条 { id, reason, motive, topic, scene, tone, mood, corridor }
  // corridor = 这段话只在哪个时段说得通（硬约束，不是权重）。
  const pool = [];

  // ① 白天通用：只是想起对方了。原作者 `check_in` 的基础形态。
  if (hour >= 9 && hour < 22) {
    pool.push({
      id: 'ambient-think-of-you',
      reason: 'check_in',
      topic: '忽然想起他',
      motive: '手头的事告一段落，忽然想起你，想看看你在忙什么',
      scene: '手头的事刚告一段落',
      tone: '平静',
      mood: '微松'
    });
  }

  // ② 状态分享：她自己的状态说得出口（精力低 / 天气闷），
  //    对应原作者的 `state_share` —— "这会儿说话可能慢一点"。
  if (Number.isFinite(energy) && energy < 45 && hour >= 10 && hour < 23) {
    pool.push({
      id: 'ambient-low-energy',
      reason: 'state_share',
      topic: '今天有点提不起劲',
      motive: '今天有点提不起劲，说话可能慢一点，但还是想跟你搭一句',
      scene: '一整天都提不起劲的时候',
      tone: '疲惫',
      mood: '疲惫'
    });
  }

  // ③ 安静的关心：不索取回应，只是问一句。
  //    对应原作者 `quiet_care`（次要用户关系下最常用的那一类）。
  if (hour >= 11 && hour < 23) {
    pool.push({
      id: 'ambient-quiet-care',
      reason: 'quiet_care',
      topic: '随口问一句',
      motive: '没什么事，就是随口问一句你那边怎么样，不用急着回',
      scene: '安静的间隙里',
      tone: '轻',
      mood: '安静'
    });
  }

  // ④ 天气闷/阴：从天气长出来的话头（阴天也算，不只有晴和雨）。
  //    原作者 `_ordinary_weather_topic_available` 允许阴天说"闷"。
  if (/阴|雾|霾|闷/.test(weather) && hour >= 9 && hour < 21) {
    pool.push({
      id: 'ambient-gloomy',
      reason: 'activity_share',
      topic: '天色闷闷的',
      motive: '外面天色一直闷闷的，待在屋里有点发懒，想跟你说一声',
      scene: '天色闷闷的下午',
      tone: '懒',
      mood: '慵懒'
    });
  }

  // ⑤ 夜里还没困：只在 21 点后，且不能太晚（23:30 之后别打扰）。
  if (hour >= 21 && minute < 23 * 60 + 30) {
    pool.push({
      id: 'ambient-late-quiet',
      reason: 'quiet_care',
      topic: '夜里安静下来',
      motive: '夜里安静下来，忽然想听听你的声音',
      scene: '夜里安静下来的时候',
      tone: '安静',
      mood: '安静'
    });
  }

  if (!pool.length) return [];
  // ★★ 2026-11-26 修：**返回整个池子，不在这里随机抽一条**。
  //
  //   原来这里 `Math.random()` 抽一条就返回 —— 也就是"随机"发生在**去重之前**。
  //   于是：池子里明明有 3 条可使用，抽到的那条恰好今天用过 → 上层过滤后
  //   变成 0 条 → 判成"没有理由"→ 不开口。11-26 19:07 / 20:07 / 21:07
  //   连续三次 no-reason 就是这么来的（21:07 的池子里 `ambient-late-quiet`
  //   明明是空的，却因为抽到了 `ambient-quiet-care` 而整轮作废）。
  //
  //   现在按优先级把**全部**可用理由交上去，由上层先做去重、再取第一条 ——
  //   抽签变成"在当前真正可用的理由里挑"，而不是"先抽签再看能不能用"。
  return pool.map((pick) => ({
    ...pick,
    action: 'message',
    priority: PRIORITY.RANDOM,
    // 窗口给一整天：兜底本来就是"任何时刻都能用"的
    window: { start: 0, end: 24 * 60 }
  }));
}

/** 给唤醒词用：返回候选的 motive。 */
export function candidateMotiveLine(candidate) {
  return candidate && candidate.motive ? String(candidate.motive) : '';
}

/**
 * 小想法那条的默认 topic。
 *
 * 照原作者 `_pick_life_thought_topic`（`proactive_engine.py:9433`）的兜底口径：
 *   先看当前日程/活动 → `f"{activity}里自然冒出来的小内容"`；
 *   取不到 → `"当前时段里自然冒出来的小内容"`。
 *
 * 我们没有"当前活动"字段，所以退到时段版 —— 但**按时段说具体一点**，
 * 不用「一件小事」这种占位符（那会拼出
 * 「刚刚想到“一件小事”，想顺手分享一下」这种一眼假的话）。
 *
 * @param {number} minuteOfDay
 * @returns {string}
 */
export function defaultThoughtTopic(minuteOfDay) {
  const m = Number(minuteOfDay);
  if (!Number.isFinite(m)) return '当前时段里自然冒出来的小内容';
  if (m < 11 * 60) return '早上这点空闲里自然冒出来的小内容';
  if (m < 14 * 60 + 30) return '中午歇下来时自然冒出来的小内容';
  if (m < 18 * 60) return '下午这点空闲里自然冒出来的小内容';
  if (m < 21 * 60) return '傍晚这段路上自然冒出来的小内容';
  return '晚上安静下来时自然冒出来的小内容';
}

/**
 * 取 follow-up 链里某一步。
 *
 * 原作者的链：`[name_only_opener, if_no_reply, if_still_no_reply]`。
 * 我们这里按"第几次追问"取：
 *   followUpIndex = 0 → chain[0]（name_only_opener）
 *   followUpIndex = 1 → chain 里第一个 if_no_reply
 *   followUpIndex = 2 → chain 里 if_still_no_reply
 *
 * @param {object[]} chain
 * @param {number} followUpIndex 0 起
 * @returns {object|null}
 */
export function chainStepAt(chain, followUpIndex) {
  if (!Array.isArray(chain) || !chain.length) return null;
  const idx = Number(followUpIndex);
  if (!Number.isFinite(idx) || idx < 0) return null;
  return chain[idx] || null;
}

/** 这条候选是否有 follow-up 链（有才值得排定时器）。 */
export function hasChain(candidate) {
  return !!(candidate && Array.isArray(candidate.chain) && candidate.chain.length);
}
