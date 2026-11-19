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

export const AFFINITY_VERSION = 1;

/** 六档。阈值是累计分。 */
export const STAGES = Object.freeze([
  { id: 'distant', label: '疏远', min: -Infinity },
  { id: 'neutral', label: '平淡', min: 0 },
  { id: 'caring', label: '在意', min: 30 },
  { id: 'reliant', label: '依赖', min: 90 },
  // 第五档：喜欢。门槛定在 400，是**刻意难到**的 ——
  // 前面四档从「平淡」到「依赖」只差 90 分，日常聊天几百条就能到；
  // 再往上如果只差几十，它就和「依赖」没有区别，等于白加一档。
  // 400 分意味着（按每条约 1~3 分算）要聊几百轮才够，这是"长期、稳定、
  // 一直没有被辜负"才会到的位置，不是刷出来的。
  { id: 'lover', label: '喜欢', min: 400 },
  // 第六档：偏爱（2026-11-11 新增）。
  // 门槛 1000，是"喜欢"的 2.5 倍 —— 刻意让它成为**几乎只能靠长期陪伴攒出来**的位置。
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
      + '他开玩笑调戏你，你听得懂，也会脸红，但不会顺着说下去——'
      + '你会回一句"笨蛋……"或者直接不理他，过一会儿又忍不住接。'
      + '你仍然不会说漂亮话，可是允许自己在他面前不冷静了。',
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
