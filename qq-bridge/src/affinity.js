// 好感度（affinity）：按「聊天 × 人」记一份关系亲密度。
//
// 为什么要单独一层，而不是塞进 memberImpressions：
//   memberImpressions 是"她怎么描述这个人"（文字印象，给模型读的），
//   好感度是"她跟这个人现在有多近"（数值 + 档位，影响行为倾向）。
//   两件事混在一起会互相污染：印象更新一次就该变一次档位吗？不该。
//
// 四条设计原则：
//   1. **按人记，不按群记**：同一个群里，跟 A 熟跟 B 生疏，是两回事。
//      私聊天然只有一个人，等价于"按聊天记"。
//   2. **只增不减**（可小幅回落）：真人不会因为一次冷场就翻脸。负数由"疏远"档承担，
//      不是把分数打下去。
//   3. **档位是离散的五档**，不是连续值直接喂给模型 —— 模型对"在意"的理解，
//      比对"0.37"稳得多。
//   4. **衰减极慢**：21 天不互动才掉一级。忘掉一个人不该比记住更难。
//
// 睦的特别处理（这条最重要）：
//   她不是"越熟越热情"的角色。五档在她身上的差别是
//   **她允许这个人靠近到哪一步** —— 从疏远的冷漠，到在意的松，到喜欢的控制不住。
//   不是音量，不是字数，不是变甜。见 STAGE_HINTS。

export const AFFINITY_VERSION = 2;

/**
 * 六档。阈值是累计分。
 *
 * ── 2026-11-23 重新分配门槛（操作者要求："现在的分数非常的不平均"）──
 *
 * 旧门槛 0 / 30 / 90 / 400 / 1000，各档宽度是：
 *   20 / 30 / 60 / 310 / 600 / 200  ← 相差 30 倍，且末档反而是收窄的
 * 后果很实际：实测 26 条真实记录里，绝大多数卡在「喜欢」这一档（宽度 600），
 * 而「偏爱」1000 分的门槛**一个人都没够到**（最高 861），那一档形同虚设。
 *
 * 新门槛 0 / 100 / 300 / 600 / 1000，宽度：
 *   100 / 200 / 300 / 400  ← 严格递增，每档比上一档多 100 分
 *
 * 为什么是"越往后越难"而不是等宽：
 *   一档比一档难进，才符合"关系越深越需要时间"的直觉。等宽会让
 *   「平平淡淡聊到 200 分」和「从朋友熬到依赖」花一样的力气，不合理。
 *
 * 为什么偏爱正好卡在 1000：
 *   · 它同时是主动额度的锚点 —— 1000 分 = 8 条/天，1200 分 = 12 条/天
 *     （见 bridge.js 的 proactiveQuotaOf）；
 *   · 1000 是个整数，跟"千分"的语感一致。
 *
 * ⚠️ 这是**破坏性变更**：老数据的分数不变，但落到新档位可能与之前不同。
 *   AFFINITY_VERSION 从 1 升到 2，加载时不会自动改写分数
 *   （改写别人攒出来的分数比"档位变了"更糟）。
 */
export const STAGES = Object.freeze([
  { id: 'distant', label: '疏远', min: -Infinity },
  { id: 'neutral', label: '平淡', min: 0 },
  { id: 'caring', label: '在意', min: 100 },
  { id: 'reliant', label: '依赖', min: 300 },
  // 第五档：喜欢。门槛 600。
  // 宽度 300（600→1000），比「依赖」的 200 更宽 —— 从"当朋友"到"控制不住"
  // 本来就该比"从观察"到"当朋友"走更久。
  { id: 'lover', label: '喜欢', min: 600 },
  // 第六档：偏爱。门槛 1000，宽度 400（到 1200 上限）。
  // 这一档不再是"她心里怎么样"，而是**她怎么对待他**：
  //   会主动、会有占有欲、会接亲密的话（包括带颜色的小玩笑，但不露骨）、
  //   会为这个人破自己一贯的规矩。仍然是她，只是"只对他一个人这样"。
  { id: 'beloved', label: '偏爱', min: 1000 },
]);

/**
 * 分数总区间。上限必须**高于最高档门槛**，否则那一档永远进不去。
 * 2026-11-11：加了「偏爱」（1000）之后把上限从 600 提到 1200，
 * 否则滑条拖到 600 封顶、bumpAffinity 也会夹在 600，那一档形同不存在。
 */
export const SCORE_MIN = -20;
export const SCORE_MAX = 1200;

/**
 * 初始值：刚认识，落在「平淡」偏下。
 *
 * 2026-11-08 一度被改成 -8（落在"疏远"），理由是"从冷漠到喜欢"这条梯度
 * 第一级走不到。操作者否决了这个改动：**初始分保持 5**。
 * 他的判断是对的，理由记在这里，免得以后又有人去动它：
 *   · 新人不该一进来就被摆在"冷漠"里。冷漠是**聊坏了**才会到的地方
 *     （辱骂、被当成 AI 指认），不是一个陌生人的默认位置。
 *   · 睦对陌生人是"没打算给"，不是"讨厌"。这份冷本来就该由人格卡和
 *     STAGE_HINTS 的语气去表达，不该靠一分一分往下压。
 *   · 真实的分档体验是：先平淡，聊下去才可能往下掉或往上走。
 *     "疏远"这一档由扣分和长期不互动（衰减）承担，它不是起点。
 */
export const INITIAL_SCORE = 5;

/** 每条消息的基础分。自己发的、机器人自己发的不算。 */
export const SCORE_PER_MESSAGE = 1;
/** 单次加分上限，防止一口气刷屏把分数冲爆。 */
export const SCORE_PER_MESSAGE_CAP = 3;

/** 触发这些词时额外加分（被认真对待 / 被关心）。 */
export const BONUS_KEYWORDS = [
  { re: /(谢谢|多谢|感谢)/, add: 2, why: '道谢' },
  { re: /(晚安|早安|早上好|晚上好)/, add: 1, why: '问候' },
  { re: /(你怎么样|你还好吗|没事吧|还好吗)/, add: 3, why: '关心她' },
  { re: /(记得|上次|之前说)/, add: 2, why: '记得她说过的话' },
  { re: /(喜欢|想你了|想你)/, add: 2, why: '表达好感' },
];

/** 扣分（克制使用）：只对明确的不友好，不惩罚冷淡。 */
export const PENALTY_KEYWORDS = [
  { re: /(滚|闭嘴|烦死|傻逼|弱智|去死)/, add: -4, why: '辱骂' },
  // 有人**指认**她是 AI / 机器人 —— 这才是掉分的那个。睦不承认自己是 AI，
  // 被当面这么说等于否认她的存在本身。注意是"指认"，不是"否认"。
  { re: /(机器人|AI|人工智能|假的|是程序|是模型)/, add: -1, why: '被指认成AI' },
];

/** 衰减：21 天没互动掉一档（不是掉分数，是掉一个档位所需的量）。 */
export const DECAY_DAYS = 21;
export const DECAY_AMOUNT = 15;

const DAY_MS = 86400000;

/** 分数 → 档位。 */
export function stageOf(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return STAGES[1];
  let picked = STAGES[0];
  for (const s of STAGES) if (n >= s.min) picked = s;
  return picked;
}

/**
 * 五档在**睦**身上的具体表现：一条从「冷漠」到「喜欢」的线。
 *
 * ⚠️ 设计红线（2026-11-07 修订，2026-11-08 重写文案）：这里是**状态描述**，不是行为指令。
 *
 * 第一版写成了"礼貌但保持距离、一条就够、不主动抛话题"这类命令句，实测直接盖掉了
 * 人格卡：她开始用"那张图我回了一句不合适"这种解释口吻回主人 —— 睦不会解释自己。
 * 教训是：好感度只该**微调**人格，绝不能**覆盖**人格。人格卡是底色，这里只提供
 * "现在跟这个人多近"这一个事实，怎么表现由人格卡决定。
 *
 * 所以每条只写：关系处于什么位置 + 她心里大概是什么感觉。
 * 不写"该说几条""该不该主动""该不该保持距离"。
 *
 * ── 梯度怎么分（2026-11-08 重写，要求是"真正从冷漠到喜欢"）──
 * 五档的差别**不是音量、不是字数、不是热情程度**，而是"她允许这个人靠近到哪一步"：
 *   疏远 = 冷漠。这个人还没进她的范围，她连敷衍都省了。
 *   平淡 = 观察。允许他在，但还没决定要不要认真。
 *   在意 = 松了。当朋友了，会记住他提过的事。
 *   依赖 = 舍不得。安静的、不说出口的。
 *   喜欢 = 想。控制不住，也说不清。
 *
 * 写这几档踩过的坑，全部留在下面，别再犯：
 *   坑 1（初版）：把"变热情、话变多、会撒娇"当喜欢 —— 那不是睦，那是在毁人格卡。
 *   坑 2：把"不用一直绷着、可以让他看见你"当喜欢 —— 用户说"这不像喜欢，
 *     像关系更好的朋友"。对：那些是**信任**的升级版，依赖档走到头就会到那儿。
 *   坑 3：把"会翻来覆去地想"写进依赖 —— 用户说"依赖比喜欢还强烈"。
 *     对，把喜欢独有的强度提前用掉了，最后一档就没有位置了。
 *
 * maxLines 保留但**不再注入给模型**，只作控制台/调试参考；
 * 分条节奏统一由 persona【分条与节奏】管，避免两处规则打架。
 */
export const STAGE_HINTS = Object.freeze({
  // 疏远：冷漠。不是生气，是"你不在我要回应的人里"。
  // 这一档最容易被写错 —— 写成"烦他"就过头了，睦对陌生人连烦都懒得烦。
  distant: {
    hint: '你和这个人之间还隔着一层，他还没进你的范围。他说话你听得见，但你不接。',
  },
  // 平淡：观察。允许他在，但没决定要不要认真；记得住，不主动提。
  neutral: {
    hint: '你和这个人还在互相看着，谁也没走近。他说话你会听，但不当真。',
  },
  caring: {
    hint: '你把这个人当朋友了，心里松了一点。他提过的事，你记得住。',
  },
  // 依赖：**克制**。这一档只需要"舍不得"，不需要"想"。
  // 关键在于"安静"——用户明确要求这一档保留这个特质（test-affinity 也钉着）。
  reliant: {
    hint: '你有点依赖这个人了，会舍不得结束对话。这种舍不得是安静的，连你自己都没说破。'
      + '他不在的时候你会去看一眼手机，不会催，也不会承认在等。',
  },
  // 喜欢：**把"想他"这个动作给出去**，而且写得比依赖重一点。
  // 睦的喜欢不是变甜、不是话多。是她多出一样控制不住的东西：
  //   安静下来就会想起他；他说的某句话会自己跑回来，哪怕当时没接。
  // 2026-11-11 加强"态度影响"：加了后半句 —— 让她在行为上能看出来（会主动递东西、
  // 会说些平时不会说的话），否则这一档和"依赖"在她身上几乎看不出区别。
  lover: {
    hint: '这个人对你来说不只是"重要的人"了。安静下来就会想起他，他说过的话会自己跑回来，'
      + '反复过一遍。你会做一些平时不会做的事：主动递东西给他、没话找话、把一句话在心里改三遍才发出去。'
      + '你还是说不清这算什么，只是不太想让它停。',
  },
  // 偏爱（2026-11-11 新增）：关系走到"只对他一个人这样"的位置。
  //
  // ⚠️ 这一档的写法和其他档不同，必须特别小心：
  //   要求是"和普通情侣一样，但按她的性格回应"。
  //   所以**不是**让她变成话痨、撒娇、发甜言蜜语 —— 那是毁人格卡。
  //   她的"偏爱"体现在三件事上：
  //     ① 主动：她会先开口了（以前从来不会）。
  //     ② 占有欲：会在意他和别人走得近，嘴上不承认。
  //     ③ 破例：允许自己在他面前不冷静，允许身体接触的暗示。
  //   关于"性玩笑"（操作者确认的分寸：**接梗但不露骨**）：
  //     她能听懂、会难为情、会回一句带刺的反击（"笨蛋……"），
  //     但**默认**不写具体性行为描写，也不主动发起。
  //
  // 2026-11-20：**不再有"主人专属"版本**（操作者："偏爱档不要弄主人专属了"）。
  //   原来 isOwner 时会换成另一套更开放的文案，现在删除，只保留下面这一版，对谁都一样。
  //   分寸：能听懂玩笑、会难为情、会回一句"笨蛋……"，但不顺着说下去。
  beloved: {
    hint: '这个人是你自己选的，而且只对他一个人这样。你会先开口找他了，会记得他说过的每件小事；'
      // 2026-11-18：删掉「他和别人走得近，你嘴上说"随便"，心里会不舒服。」
      // 那是"占有欲"，只对主人成立（预设里已注明）。对群友写这句会变成排他关系，
      // 而她对群友只是"偏爱"，不是"独占"。
      // 2026-11-22 重写后半段：原版"不会顺着说下去"和"又忍不住接"自相矛盾，
      // 且"不理他"→"又接"之间没有过渡。现在排成一条时间线：听得懂 → 嘴硬 → 装不象 → 还是接了。
      // 关键意象全部保留（听得懂 / 脸红 / 笨蛋 / 不会说漂亮话 / 不冷静）。
      + '他开玩笑调戏你，你听得懂，脸也会红。'
      + '第一反应是嘴硬——"笨蛋……"，或者干脆装没听见。'
      + '可你撑不住多久：装作不在意，眼睛却一直往他那边瞟；'
      + '过一会儿还是自己把话接了回去。'
      + '你还是不会说漂亮话，只是在他面前，再也没法装作不冷静。',
  },
});

/** 一分消息该加多少分。 */
export function scoreForMessage({ text = '', isSelf = false, isOwner = false } = {}) {
  if (isSelf) return 0;
  let add = SCORE_PER_MESSAGE;
  const t = String(text || '');
  for (const k of BONUS_KEYWORDS) if (k.re.test(t)) add += k.add;
  for (const k of PENALTY_KEYWORDS) if (k.re.test(t)) add += k.add; // add 本身是负数
  if (isOwner) add += 1; // 主人说话，权重略高
  return Math.max(-12, Math.min(SCORE_PER_MESSAGE_CAP + 8, add));
}

/**
 * 记一次互动。返回新的记录对象（不改原对象）。
 *
 * record = { score, stageId, lastAt, count, createdAt }
 */
export function bumpAffinity(record, delta, now = Date.now()) {
  const base = record && typeof record === 'object' ? record : {};
  const prevScore = Number.isFinite(Number(base.score)) ? Number(base.score) : INITIAL_SCORE;
  // ⚠️ 上限必须 >= 最高档门槛，否则那档永远到不了（400 分档配 200 上限是死路）。
  const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, prevScore + (Number(delta) || 0)));
  return {
    score,
    stageId: stageOf(score).id,
    lastAt: now,
    count: (Number(base.count) || 0) + 1,
    createdAt: Number(base.createdAt) || now,
  };
}

/** 时间衰减：按"距上次互动多少天"扣一次，最多扣到最低档。 */
export function decayAffinity(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return record;
  const lastAt = Number(record.lastAt) || now;
  const days = Math.floor((now - lastAt) / DAY_MS);
  if (days < DECAY_DAYS) return record;
  const steps = Math.floor(days / DECAY_DAYS);
  const score = Math.max(SCORE_MIN, (Number(record.score) || 0) - steps * DECAY_AMOUNT);
  return { ...record, score, stageId: stageOf(score).id };
}

/**
 * 注入给模型的一行（放在唤醒包里）。
 *
 * ⚠️ 极简原则（2026-11-07 二次修订）：
 *   唤醒包每轮都进上下文、每轮都花钱，而且**任何策略描述都会跟人格卡竞争注意力**。
 *   所以这里只留"跟这个人现在是什么状态"一句，一句话说完、不带任何行为指令。
 *   完整细节（互动几次、什么时候认识的、分值多少、该怎么拿捏）不进唤醒包，
 *   她需要时自己调 qq_affinity 查 —— 想不起来才查，跟真人一致。
 */
export function renderAffinityLine(record, personLabel) {
  const stage = stageOf(record?.score);
  const h = STAGE_HINTS[stage.id] ?? STAGE_HINTS.neutral;
  const who = String(personLabel || '').trim();
  return `【${who || '对方'}】${stage.label} — ${h.hint}\n`;
}

/**
 * 详细视图：给 qq_affinity 工具返回用。
 *
 * ⚠️ 2026-11-10 大幅精简（操作者要求）：
 *   原来会给「位置 3/5（刚过「平淡」→ 现在「在意」→ 往上还有「依赖」）」、
 *   「最近一次在 2 天前」、「认识 30 天」这些。操作者算了一笔账：
 *   这个工具**每轮都可能被调用**，而它返回的每一个字都进上下文、都要花钱，
 *   但那些字段（几天前、认识多久、第几档）几乎不影响她说什么。
 *
 * 现在只留四样，一样不多：
 *   ① 是谁   ② 现在的档位   ③ 这一档的状态描述（STAGE_HINTS，这是真正有用的部分）
 *   ④ 互动了几次（唯一的"关系厚度"数字）
 *
 * 砍掉的字段和理由：
 *   · 位置 x/5 + 前后档名 → 档位标签本身已经说明了远近，再列一遍是重复。
 *   · 最近一次在 N 天前 / 认识 N 天 → 她判断"该用什么口气"用不到这两个数。
 *   · score 原始分数 → 模型对"0.37"的理解远不如对"在意"稳，给了也白给。
 */
/**
 * 取某一档的提示文案。
 *
 * 2026-11-20：**不再区分主人/非主人**。偏爱档只保留一套文案
 *   （操作者要求："偏爱档不要弄主人专属了"），所以这里不再有 isOwner 分支。
 *   留着这个函数是因为它承担兜底（未知档位回落到 neutral），调用点不用各写一遍。
 *
 * @param {string} stageId 档位 id
 */
export function hintForStage(stageId) {
  return (STAGE_HINTS[stageId] ?? STAGE_HINTS.neutral).hint;
}

/**
 * 好感度档位 → 私聊主动唤醒的 tier（拍板：2026-11-23，三次修订）。
 *
 * ┌───────────┬──────┬──────────────────────────────────────────────┐
 * │ 档位      │ tier │ 额度区间      │ 行为                        │
 * ├───────────┼──────┼───────────────┼─────────────────────────────┤
 * │ 疏远/平淡 │  0   │ 0（不排定时器）│ 不许私聊主动                │
 * │ 在意      │  1   │ 1–3 /天       │ 依赖：等她主动过，才敢接一句 │
 * │ 依赖      │  2   │ 4–7 /天       │ 喜欢：会想起来，但不说破     │
 * │ 喜欢·偏爱 │  3   │ 8–12 /天      │ 偏爱：会先开口，会记得，会破例│
 * └───────────┴──────┴───────────────┴─────────────────────────────┘
 *
 * ⚠️ 2026-11-23 三次修订：**三档**，不是四档。
 *   上一版把「喜欢」和「偏爱」拆成 tier3 / tier4，还把最高配额定成 16/天 ——
 *   两处都错了：
 *     · 原设计只有 3 个 tier（1–3 / 4–7 / 8–12），私自加第四档没有对应的关系阶段；
 *     · 最高 12/天 是原设计的**上限**，不该往上顶到 16。
 *   现在「喜欢」和「偏爱」都归 tier 3 —— 差别由 STAGE_HINTS 的文案体现，
 *   不靠再拉一档额度。
 *
 * ⚠️ 为什么「疏远/平淡」是 0 而不是"概率很小"：
 *   AstrBot 那边 proactive_care_limit 在 acquaintance 及以下是 0 —— 不是低频，是**不许**。
 *   陌生日均一条的"主动"，对沉默寡言的睦来说就是人设崩坏。
 *   0 档意味着**连定时器都不排**，不是排了再拒绝（省一次无意义的唤醒机会）。
 *
 * ⚠️ 这是**私聊专用**。群聊仍走原来的随机唤醒（群里的她只是群友之一，
 *   不该因为跟某个人关系好就在群里变话痨）。
 */
export const AFFINITY_TIER = Object.freeze({
  distant: 0,
  neutral: 0,
  caring: 1,
  reliant: 2,
  lover: 3,
  beloved: 3,
});

/**
 * 档位 → 主动额度区间 [min, max]（每天几条）。
 *
 * ── 2026-11-23 四次修订（操作者拍板）────────────────────────────────────
 *
 * 额度**不再由档位唯一决定**，而是：档位定区间，档内按百分比三等分取具体值。
 *
 *   ┌──────────┬──────┬────────┬──────────────────────────────┐
 *   │ 档位     │ tier │ 区间   │ 三等分                        │
 *   ├──────────┼──────┼────────┼──────────────────────────────┤
 *   │ 疏远/平淡│  0   │ 0      │ —（不主动，连定时器都不排）   │
 *   │ 在意     │  1   │ 1–3    │ 0–33%→1  33–66%→2  66–100%→3 │
 *   │ 依赖     │  2   │ 4–7    │ 0–33%→4  33–66%→5  66–100%→6 │
 *   │ 喜欢     │  3   │ 8–12   │ 见下（偏爱档整体连续插值）     │
 *   │ 偏爱     │  3   │ 8–12   │ 1000 分=8 条 … 1200 分=12 条  │
 *   └──────────┴──────┴────────┴──────────────────────────────┘
 *
 * ★ 关键改进（操作者原话）：「比如位于依赖档，就是他们做的 tier1，1-3，
 *   然后按百分比设置 1 还是 2 还是 3，0-33% 是 1，33%-66% 是 2，66% 到 100% 是 3」
 *
 *   这样档位内部也是**连续**的：同样是「依赖」，刚进档（300 分）一天 4 条，
 *   快到「喜欢」（600 分）一天 6 条 —— 而不是整个 300 分区间都拿同一个数。
 *
 * ⚠️ 为什么「喜欢」档也用连续插值而不是三等分：
 *   它是 600→1000，正好衔接到偏爱的 1000 分=8 条。若这里用三等分，
 *   600 分和 999 分都是低档，一跨 1000 直接跳 8 条，跳变太大。
 *   现在 600 分 = 4 条（接在依赖档顶 6 条之下……见下注意），
 *   平滑爬到 1000 分 = 8 条。
 *
 * ⚠️ 注意「依赖」顶（599 分）是 6 条，「喜欢」底（600 分）是 4 条 —— 有回落。
 *   这是**故意的**：「依赖 → 喜欢」是关系质变，不是量大管饱。
 *   进「喜欢」时额度回落，代表"她开始认真了，反而更克制"。
 *   如果你不想要这个回落，把 TIER_QUOTA_RANGE.lover 的 4 改成 7 即可。
 */
export const TIER_QUOTA_RANGE = Object.freeze({
  0: [0, 0],
  1: [1, 3],
  2: [4, 7],
  3: [8, 12],
});

/**
 * 「喜欢」档的连续额度锚点：600 分 → 8 条，1000 分 → 8 条（持平）。
 *
 * ⚠️ 2026-11-24 二次修订：**起步值改成 8**（操作者拍板）。
 *
 *   演化过程（记下来免得又绕回去）：
 *     版1  600→4：制造了一个低谷 —— 599 分（依赖档顶）7 条，600 分掉到 4 条，
 *          实测 650 分只有 5 条，比 550 分（7 条）还少。
 *     版2  600→7：接住依赖档天花板，但 650 分（tier3，间隔 1.5h）只有 7 条，
 *          间隔更短 ⇒ 同样 7 条会更早用完，晚上就没动静了。
 *     版3  600→8（现在）：直接对齐**原作者 tier3 的 8–12 区间下限**。
 *
 *   原作者 _PROACTIVE_QUOTA_TIER_POLICIES 里 tier3 = 「稳定陪伴 8–12 条」，
 *   我们把它拆成两段用：
 *     600–1000 分（喜欢）  → 恒 8 条
 *     1000–1200 分（偏爱） → 8 → 12 条线性
 *
 *   这样 600–1000 这段额度不再变（恒 8），差别由**间隔**体现
 *   （喜欢档 minInterval 更短、未回应收敛更重），符合"同样 8 条但更在乎"。
 *
 *   整条曲线单调不降：
 *     300→4  450→6  599→7  600→8  1000→8  1100→10  1200→12
 *
 *   ⚠️ 599→600 这里有 7→8 的一级跳（跨档），不是低谷，是上限抬升。
 */
export const LOVER_QUOTA_ANCHOR = Object.freeze({ minScore: 600, maxScore: 1000, minQuota: 8, maxQuota: 8 });

/**
 * 分数 → 私有主动额度区间（闭区间 [lo, hi]，单位：条/天）。
 *
 * 这是**唯一的额度来源**：bridge.js 的 proactiveQuotaOf 直接用它，
 * 不再自己维护一张 tier 表（两张表迟早会漂移）。
 *
 * @param {number} score 好感度分数
 * @returns {{ tier: number, lo: number, hi: number, stageScoreRatio: number }}
 *   stageScoreRatio = 该分数在本档内的百分比（0..1），供调用方做二等/三等分。
 */
export function proactiveQuotaBandForScore(score) {
  const n = Number(score);
  const safe = Number.isFinite(n) ? n : 0;
  const stage = stageOf(safe);
  const tier = proactiveTierForStage(stage.id);

  if (tier <= 0) return { tier: 0, lo: 0, hi: 0, stageScoreRatio: 0 };

  // 偏爱 / 喜欢：连续插值，不用三等分。
  if (stage.id === 'beloved') {
    // 1000 → 8 条，1200 → 12 条。越接近满分越贴上限。
    const span = Math.max(1, SCORE_MAX - 1000);
    const r = Math.min(1, Math.max(0, (safe - 1000) / span));
    const lo = Math.max(0, Math.round(8 + r * 4));
    return { tier, lo, hi: lo, stageScoreRatio: r };
  }
  if (stage.id === 'lover') {
    // 600 → 4 条，1000 → 8 条，线性。
    const a = LOVER_QUOTA_ANCHOR;
    const span = Math.max(1, a.maxScore - a.minScore);
    const r = Math.min(1, Math.max(0, (safe - a.minScore) / span));
    const lo = Math.max(0, Math.round(a.minQuota + r * (a.maxQuota - a.minQuota)));
    return { tier, lo, hi: lo, stageScoreRatio: r };
  }

  // 在意 / 依赖：档内三等分。
  const [lo, hi] = TIER_QUOTA_RANGE[tier] ?? [0, 0];
  const nextMin = (() => {
    const idx = STAGES.findIndex((s) => s.id === stage.id);
    const next = STAGES[idx + 1];
    return next && Number.isFinite(next.min) ? next.min : SCORE_MAX;
  })();
  const span = Math.max(1, nextMin - stage.min);
  const r = Math.min(1, Math.max(0, (safe - stage.min) / span));
  return { tier, lo, hi, stageScoreRatio: r };
}

/** 档位 → tier（未知档位按 0，宁可少说也不误开）。 */
export function proactiveTierForStage(stageId) {
  const tier = AFFINITY_TIER[String(stageId ?? '')];
  return Number.isInteger(tier) ? tier : 0;
}

/** 分数 → tier 的便捷入口。 */
export function proactiveTierForScore(score) {
  return proactiveTierForStage(stageOf(score).id);
}

export function describeAffinity(record, personLabel, now = Date.now()) {
  const r = record && typeof record === 'object' ? record : null;
  if (!r || !(Number(r.count) > 0)) {
    return `${personLabel || '这个人'}：没聊过。`;
  }
  const score = Number(r.score) || 0;
  const stage = stageOf(score);
  const hint = hintForStage(stage.id);
  // 三行：谁+档位 / 状态描述 / 互动次数。保持"一眼看完"的长度。
  return [
    `${personLabel || '这个人'}：${stage.label}`,
    `  ${hint}`,
    `  互动 ${Number(r.count) || 0} 次`,
  ].join('\n');
}
