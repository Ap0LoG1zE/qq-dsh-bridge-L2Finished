// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
//
// 2026-11-07 合并：四个旧预设（qq-chat / qq-chat-v2 / qq-chat-readonly / qq-chat-owner）
// 合并为唯一 `qq-chat-agent`，权限面按 readonly。本文件随之改为校验合并后的这一个。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const MERGED = 'qq-chat-agent';
const preset = yaml.load(fs.readFileSync(
  new URL(`../dsh/agent-presets/${MERGED}/agent.cordis.yml`, import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('合并预设 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  // 2026-11-20：操作者删掉了 persona 开头那句英文
  //（`You are a QQ group-chat agent ... powered by the {{model}} model.`），
  // 所以不再要求出现 {{model}}。但**仍然不能出现未注册变量** —— 那会让
  // DSH 的 system prompt 装配直接抛错、每回合 error。
  //
  // DSH 0.2.1 起 agent loop 只注册 provider / model 两个提示词变量（0.2.0 还有 cwd）。
  assert.ok(prefix.length > 2000, `persona 正文应有实质内容，实际 ${prefix.length} 字符`);
  const used = [...JSON.stringify(persona.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((v) => !['provider', 'model'].includes(v)), []);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('合并后的权限面是 readonly：只挂只读文件工具，且不挂任何执行能力', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-fs', 'tool-fs-search', 'tool-web', 'qq-tool-restrict', 'compaction',
  ]);
  // 只读：tool-fs 必须关掉 write / edit —— 注册期就不注册，模型连 schema 都看不到。
  assert.deepEqual(preset.find((row) => row.id === 'tool-fs').config, { write: false, edit: false });
  // 没有 shell：合并后不挂 tool-pwsh / tool-bash。
  assert.equal(preset.some((row) => row.id === 'tool-pwsh' || row.id === 'tool-bash'), false);
  // 群聊里 ask_user_question 没有可回答的交互面，todo_write 也只是白占 schema，都不要。
  assert.equal(preset.some((row) => row.id === 'tool-ask-user' || row.id === 'tool-todo'), false);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  // 守卫必须以 readonly 档挂载：写入/执行在执行期再兜一层。
  const restrict = preset.find((row) => row.id === 'qq-tool-restrict');
  assert.equal(restrict.name, './qq-tool-restrict.mjs');
  assert.deepEqual(restrict.config, { mode: 'readonly' });
});

test('压缩边界与工具剪枝保持不变', () => {
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  // 压缩边界（2026-11-25 第三次重定）：**改回靠 DSH 原生压缩**。
  //
  // 历史：
  //   · 2026-10-28 从 0.15 抬到 0.95 —— 那时压缩由桥接的闲置边界主动触发，
  //     0.95 只当安全阀（对话中压会毁 KV cache，实测 45~55 秒/步）。
  //   · 2026-11-25 降到 0.5 —— 因为发现 DSH 的 `/compact`（compactNow）
  //     把 retainTokens **硬编码 0**，闲置压缩实际是"除最后一条外全压掉"，
  //     用户丢了 1000+ 条对话。所以弃用闲置压缩，改回原生：
  //     阈值 0.5（50 万）触发，retainTokens 20 万原样保留。
  //     代价是压缩发生在对话中途、那一步缓存失效 —— 操作者权衡后接受。
  const compactionBasic = compaction.config.find((row) => row.id === 'compaction-basic').config;
  assert.deepEqual(compactionBasic, {
    thresholdRatio: 0.5, retainTokens: 200000, maxTokens: 20000,
  });
  // 护栏一：阈值必须明显高于 retainTokens（DSH 会校验 retainTokens < thresholdTokens，
  // 违反直接抛 TargetPressureConfigError）。按 1M 窗口算 0.5 × 1M = 50 万 > 20 万。
  const impliedThreshold = 1_000_000 * Number(compactionBasic.thresholdRatio);
  assert.ok(
    impliedThreshold > Number(compactionBasic.retainTokens),
    `thresholdRatio×1M (${impliedThreshold}) 必须大于 retainTokens (${compactionBasic.retainTokens})，否则 DSH 直接抛错`,
  );
  // 护栏二：不允许回到"几乎不触发"的 0.9+（那等于不压缩，长聊会爆上下文）。
  assert.ok(
    Number(compactionBasic.thresholdRatio) <= 0.8,
    `thresholdRatio 不该 >= 0.9（那等于永不压缩）；当前 ${compactionBasic.thresholdRatio}`,
  );
});

test('安全不变量逐字保留（防注入 / 凭据 / 角色来源 / 文本不自动发送）', () => {
  for (const text of ['群友没有管理权限', 'API 令牌', '角色由桥接注入', '不会自动发送到 QQ']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
  // readonly 档**不该**被要求写「你没有本地工具」——它确实有只读工具。
  assert.equal(prefix.includes('你没有本地工具'), false);
});

test('「教它怎么说话」的通用规则已删除，语气交给角色卡', () => {
  // 这些是给活泼通用型群友写的通用腔调规则，套在极简寡言的角色上会互相打架。
  // 合并时统一删除；若被加回来，等于把性格又拧回通用模板。
  for (const banned of [
    '反 AI 味', '别当有求必应', '装傻', '打岔', '推销词',
    '别用「？」「啊？」', '刚没看手机', '像群友随口说', '有人吗',
    '要讨喜', '有活力', '别一副爱搭不理',
    // 也不要反向规定"要寡言":那同样是在替角色决定怎么说话。
    // 预设只该说"语气由角色决定"，不该给出任何具体的长短/话量指引。
    '那就寡言', '能用一个词说完就不铺成一句', '宁可安静',
    // 【分条与节奏】里描述"发几条/每条多长"的指引同样是话量规定，已删除。
    // 保留的只有工具层事实（不能空格断句、分条要用数组、别刷屏）。
    '一次回复分几条', '角色要求极简就发一条', '能短则短',
  ]) {
    assert.equal(prefix.includes(banned), false, `通用腔调/话量规则「${banned}」不应出现在合并预设里`);
  }
  // 取而代之：只声明「说话方式以人格为准」，且不再规定具体语气或长短。
  assert.match(prefix, /说话方式以人格为准/);
  assert.match(prefix, /本预设不规定语气/);
});

// 合并后只有一个 preset，但「压缩边界」这条护栏仍然要有：
// 任何一档漏改都会让那条会话在对话中压缩 —— 症状是"只有某个会话特别慢"，更难排查。
test('合并预设的压缩边界：阈值与 retainTokens 自洽', () => {
  for (const name of [MERGED]) {
    const doc = yaml.load(fs.readFileSync(
      new URL(`../dsh/agent-presets/${name}/agent.cordis.yml`, import.meta.url), 'utf8',
    ));
    const group = doc.find((row) => row.id === 'compaction');
    const basic = group?.config?.find((row) => row.id === 'compaction-basic')?.config;
    assert.ok(basic, `${name} 缺少 compaction-basic`);

    // 2026-11-25：从"禁止对话中压缩"改成"阈值与保留量自洽"。
    //
    // 改的原因：DSH 的 `/compact` 把 retainTokens 硬编码成 0，
    // 桥接的闲置压缩实际会清空历史。所以弃用它、改回原生压缩 ——
    // 而原生压缩**只能**在对话中途触发（由 agent/pre-step 钩子驱动）。
    // "对话中绝不压缩"这条约束已经不成立，断言必须跟着改，
    // 否则它会逼着把阈值调回 0.95（= 永不压缩 = 长聊爆上下文）。
    const ratio = Number(basic.thresholdRatio);
    const retain = Number(basic.retainTokens);
    assert.ok(ratio > 0 && ratio < 1, `${name} 的 thresholdRatio 必须在 (0,1)：${ratio}`);
    // 按 1M 窗口换算，阈值必须严格大于保留量（DSH 会校验，违反直接抛错）。
    const implied = 1_000_000 * ratio;
    assert.ok(
      implied > retain,
      `${name}：thresholdRatio×1M (${implied}) 必须 > retainTokens (${retain})，否则 DSH 抛 TargetPressureConfigError`,
    );
    // 也不允许"永不触发"：>=0.9 等于不压缩，长聊会爆上下文。
    assert.ok(
      ratio <= 0.8,
      `${name} 的 thresholdRatio=${ratio} 太高（>=0.9 等于永不压缩）；当前设计是 0.5`,
    );
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  // 2026-10-28：快照从 JSON 改成纯文本【本轮消息】，标题和续读提示都换了文案。
  // 这里钉住的仍然是同一件事：模型必须知道「从哪继续读」和「水位不是 messageId」。
  assert.match(prefix, /唤醒末尾会附【本轮消息】/);
  assert.match(prefix, /读到 #N[^。]*readThroughSeq/);
  assert.match(prefix, /还有消息没显示[^。]*续读/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  // 2026-11-12 第三次改：这一节从【开口前的三件事】改名为
  // 【新会话 / 刚压缩完：先拿这两样东西】，原因有两个：
  //   ① 原标题像"每一轮都要做三件事"，会误导读起来像持续性要求；
  //      实际只针对新会话第一轮 / 刚压缩过这两种情况。
  //   ② 原来的 ③ 是"看【本轮消息】"，但那是**每一轮**都该做的事，
  //      塞进"新会话专属准备"里反而让她以为平时不用看。
  // 另外修了一句自相矛盾的话：原写「压缩后内容丢了」+「同一个 DSH 会话里查过一次就够」——
  // 压缩就发生在同一个会话里，两句打架。判据改成"有没有被压过"，不是"换没换会话"。
  // 2026-11-17：标题又从「先拿这两样东西」改成「先拿这三样东西」——
  // ③ 是重新加回来的（操作者在别的会话补了一条准备动作）。
  // 这里只钉「这一节存在」，用 . 代替具体数字：数字会随内容增减变，钉死只会反复误报。
  assert.match(prefix, /【新会话 \/ 刚压缩完：先拿这.样东西】/);
  assert.match(prefix, /① 调 qq_get_prompt/);
  assert.match(prefix, /② 调 qq_memory_query/);
  assert.ok(!prefix.includes('这一步不用调工具'),
    '「看【本轮消息】」是每轮都该做的，不该塞进"新会话专属"这一节');
  // 2026-11-12 精简：预设是给她看的，不是给维护者看的。
  // 这条原来解释"为什么同一个 DSH 会话也要重查"（压缩发生在会话内部），
  // 现在直接给判断依据：看唤醒词说没说"刚压缩过"。功能等价，少一句原理。
  assert.match(prefix, /只要唤醒词说"新会话或上下文刚压缩过"，就重新拿一遍/);
  assert.ok(!prefix.includes('同一个 DSH 会话里连着聊的那几轮'),
    '这句和上面"压缩后内容会丢"自相矛盾（压缩就发生在同一个会话里）');
});

test('one closing action acknowledges the read watermark without an observation wait', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  // 2026-11-23：**收尾只剩 qq_mark_read 一条路**。
  //   触发器冻结之后 qq_set_wake_config 不再收 throughSeq 起作用的位置感，
  //   预设也把收尾判据统一成 qq_mark_read（见【收尾】那节）。
  //   原来钉的 `qq_set_wake_config(throughSeq=…, config=…)` 已经不存在，
  //   继续钉它等于要求"留着一条已经废弃的收尾方式"。
  assert.match(prefix, /qq_set_wake_config/);
  // 2026-11-12（操作者在别的会话重写了这一节）：
  //   · 段名从【等、回与沉睡前观察】改成【等、回与收尾】——"观察窗口"这个概念退役了。
  //   · 收尾结果多了 suggestedThroughSeq（放弃那几条新消息的入口）。
  // 2026-11-17 再改：操作者又重写了措辞 —— **收尾不再空等**，立刻返回。
  //   旧断言钉的是「收尾工具自己会等约 N 秒」，与现在的「收尾不会空等，立刻返回」相反，
  //   所以这里改钉新语义（不空等 + 用 suggestedThroughSeq 放弃）。
  assert.match(prefix, /【等、回与收尾】/);
  assert.match(prefix, /收尾不会空等，立刻返回/);
  assert.match(prefix, /suggestedThroughSeq/);
  assert.match(prefix, /对方明确说“不聊了\/晚安\/下了\/拜拜\/明天见”时直接收尾/);
});

test('pre-reply quiet checks, auto-wake on reply, and closing are distinct', () => {
  assert.match(prefix, /先用它，不必重复 qq_get_unread_messages/);
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply", quietMs=10000\)/);
  // 2026-11-12：删掉了「它按最后来信补足静默，读取和思考的时间也算…」这段计时原理，
  // 只留"安静够了就返回"这个行动结论。
  assert.match(prefix, /安静够了就返回/);
  assert.match(prefix, /返回 quiet=false 不代表对方说完了/);
  // 静默下限由桥接的 wait.minQuietAfterNewMs（默认 10000）抬升：传 4000~8000 会被
  // Math.max 悄悄抬到 10 秒，模型却以为自己只等了 4 秒。这里钉住「提示词别再写小值」。
  assert.match(prefix, /【等下文】[^\n]*purpose="reply", quietMs=10000/);
  assert.doesNotMatch(prefix, /quietMs=4000~8000/, '提示词里不应出现低于后台下限的 quietMs');

  // 2026-11-12（操作者重写）：【回复后】这个小标题没了，收尾并入【收尾】那一条，
  // 并改成"收尾工具自己会等约 20 秒看有没有新消息"。所以这里不再断言旧措辞。
  assert.match(prefix, /qq_mark_read\(throughSeq=读到的水位\)/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  // 注：原来的『反 AI 味：别当有求必应』『默认 1 条，最多 2 条』属于「教它怎么说话」的
  // 通用腔调/节奏规则，合并时已删除（改由角色卡定义语气与长短）。断言跟着改成
  // 仍成立的等价表述：能力面必须在，语气面不再钉死具体条数。
  for (const text of [
    '【保持主体性】',
    '【别当群管家/主持人】',
  // 2026-11-17：原文案是「不要在一条里用空格断句」，后来扩成同时禁换行符
  // （模型爱用 '\n' 当分条信号，而 QQ 上那只会变成一条里的空行）。
  // 断言跟着当前文案走，别再钉旧句子 —— 能力面没变，只是表述更完整了。
  '不要在一条里用空格或者换行符',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note',
    'qq_set_sticker_remark',
    // 2026-11-17：这一整段被精简过（删掉了「只有管理端明确开启后才能用」
    // 「普通闲聊约 3~5 轮一张」等细枝末节）。断言改为钉**仍在的能力线索**。
    // 2026-11-17 晚：操作者有意删掉「也不要一轮连发多张表情」这条（觉得太啰嗦），
    // 断言跟着删除，别再钉一句已经不在的规则 —— 否则测试永远红着，红久了就没人看了。
    '每条只能一张，不能附带文字', '不要频繁拍',
    // 2026-11-13：操作者又把这节改成了【纯语音】，并加上 qq_set_voice（只有主人能开关）。
    // 断言跟着**当前能力面**走：语音是"打字自动合成"，不是她去调发语音工具。
    //
    // 2026-11-21 / 11-23 再改：语音从「开关开着就把所有字都转语音」变成**按需**——
    //   她想用声音说话时，先 qq_set_voice 打开，再给 qq_send_message 带 voice:true。
    //   于是旧断言钉的两句（`【纯语音】`、`你打的字会被自动转成你的声音发出去`）
    //   在当前预设里已经不存在了。
    // ⚠️ 这里要钉的是**能力线索**，不是某一次的标题：
    //   只要「有个开关 + 发送时要显式带 voice:true + 没开就退回打字」这三件事还在，
    //   能力面就没退。反过来，如果哪天真的删掉语音，下面两条会立刻红。
    '【语音】', 'qq_set_voice', 'voice:true', '就会退回打字',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);

  // 反向断言：预设里不该再教调用已经不注册的语音工具。
  // 为什么加：`voice.enabled=false` 时 qq_send_voice / qq_list_voices 根本不注册，
  // 预设里留着这些名字会让她去调一个不存在的工具、然后空转一轮。
  for (const gone of ['qq_send_voice', 'qq_list_voices']) {
    assert.ok(!prefix.includes(gone), `已不注册的语音工具仍出现在预设里：${gone}`);
  }
});

test('autonomy limits and the observation escape hatch stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 收尾的逃生口：明确结束语可以直接收尾，不必等任何观察窗口。
    // 2026-11-12（操作者重写）：告别语的收尾规则挪到了【收尾】那一条，且不再带逗号。
    '对方明确说“不聊了/晚安/下了/拜拜/明天见”时直接收尾',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    // 2026-11-17：`qq_memory_clear` 从预设里去掉了（工具仍注册，只是预设不再
    // 主动教她"整块清空"——那条路径风险高、平时用不到，需要时工具描述里能看到）。
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove',
    // 四类轻量记忆 + 长期记忆都必须给出「什么时候该记」，不能只剩「什么时候该删」。
    // 2026-11-08：合并成 readonly 版之后 selfNote 的引导整段丢了（那段原本只在 owner 里，
    // 写在"你会被相处改变"的人格叙事中），结果 selfNote / pendingThought 只剩"过期就删"，
    // 实测 20 小时零写入。现在把引导收进【记忆卫生】，每一类都要有正向说明。
    // 2026-11-10：长期事实并入【记忆卫生】，写入工具从 qq_fact_add 改成
    // qq_memory_append(category='longTerm')，这里同步钉住新写法。
    // 2026-11-12 精简：五类记忆统一成「- **类别** …」的格式，标题也加了总纲。
    // 删掉了一条纯劝说的（原「这两类写下来是有回报的」）—— 它只是把
    // activeTopic/pendingThought 的说明又复述一遍，没有新信息。
    // 2026-11-24：**轻量记忆只剩四类** —— activeTopic / pendingThought 从记忆
    // 体系里整体移除（全库累计只写过一两条，她从不回头查，等于纯噪音）。
    // 那两条断言（「还活着的话题」「想说没说出口的那一句」）跟着删掉：
    // 钉一个已经不存在的类别，只会让测试永远红着，而能力面并没有退。
    '按「多久之后还成立」分四类',
    'selfNote 只有你能写',
    // memberImpression 的断言见下面（2026-11-20 操作者改成「记对一个人的印象」开头）
    // 记错了要能删：删除入口（qq_memory_remove）必须还在预设里，否则错的印象
    // 会跟着一个人留几个月 —— 这是四类精简后唯一还需要"反向操作"的地方。
    'qq_memory_remove', '别让一条错的印象留几个月',
    // 2026-11-12：target 从「填群名片」放宽成「填人名」（私聊没有群名片）。
    // 并纠正「同一个人只该有一条印象」——实际每人最多 10 条，满了顶掉最早的。
    // 2026-11-17：`ccab978 refactor(memory)` 把【记忆卫生】大幅精简 —— 五类记忆
    // 仍在，但删掉了实现细节（「同一个人最多存 10 条」「target 和 content 平级」
    // 「全局共用/各聊各的边界」）。那些属于工具行为的重复说明，工具描述里已有。
    // 断言改成钉**当前文案里真正承载规则的那几句**，别再钉被删的细节 ——
    // 否则预设一精简，测试就红，而实际能力一点没退。
    // 2026-11-20：操作者把这条改成了「记对一个人的印象」开头。
    // 之前的断言钉的是「记具体小事，不记空泛评价」—— 那是同一句的中间部分，
    // 改开头之后就不匹配了。断言要钉**当前文案里真正承载规则的那一句**。
    '记对一个人的印象，记具体小事，不记空泛评价，用 target 指定是谁',
    // 2026-11-12 精简：todo 那条改成粗体类别名开头，判断标准单独成段（原来挤在列表项缩进里）。
    'todo 一两天内要兑现的事', 'extra.dueAtMs', 'extra.done=true',
    '这事过了两三天还成立吗',
    'longTerm 几个月后仍成立的事', 'extra.tag',
    // 旧工具已删除，预设里不能再出现它的名字（否则模型会去调一个不存在的工具）。
    // 这条是**反向**断言，放在最后单独检查。
    // 黑话面：slang-learner.js 与整个「黑话学习」子系统已删除，qq_slang_query/qq_slang_submit
    // 不再存在，预设里的【黑话与梗】小节、以及配套的「不要为了显得懂而硬塞术语」都随之移除。
    // 现在跟"梗"有关的约束落在【QQ 场景规则】：遇到网络用语/梗就去搜，不靠猜。
    // 这条断言因此改为检查那条**真正还在**的规则，别再钉死已经删掉的文案。
    'mcp__web-search-safe__web_search', '遇到需要实时信息、网络用语/梗',
    // 频率类断言已在上面的能力面用例里覆盖（2026-11-17 去重：
    // 原来这里还有一份「普通闲聊约 3~5 轮一张」，那句话随表情段精简被删了）。
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    // 2026-11-12 精简：查人那段原来解释了"桥接怎么维护别名表"，那是给她看的预设里
    // 不该出现的实现细节。现在只留操作指令 + 一条禁令，措辞也跟着变了。
    //
    // 2026-11-23 改：触发器全局冻结（FIXED_WAKE_TRIGGERS），`triggers.speakerIds`
    // 从此不归她调。
    // 2026-11-25（操作者）：**不要再往预设里写「唤醒条件是固定的 / 别再传 triggers」**。
    //   · 她当然可以调 qq_set_wake_config —— 那工具就是让她自己定"下次什么时候醒"的；
    //     写成"别传 triggers"读起来像在劝她别用这个工具。
    //   · 而且这是纯说明性文本：传了不会改变结果，说了也不改变行为，只占字符。
    //   现在钉的是那一节**真正在教她怎么用工具**的那句。
    '由你自己定：下次什么时候被主动叫醒',
    '不要凭记忆编号',
    'qq_get_userid(query=那个人名)', '不要拉群成员名单',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);

  // 反向断言：已删除的工具名不能再出现在预设里。
  // 为什么必须反向查：上面那串全是 includes()，**删掉的东西它一个字都不会报**。
  // qq_fact_add 在 2026-11-10 并入 qq_memory_append(longTerm)，预设里提到它
  // 就会让模型去调一个不存在的工具，然后对着 403/找不到工具空转一轮。
  for (const gone of ['qq_fact_add', 'qq_fact_list']) {
    assert.ok(!prefix.includes(gone), `已删除的工具名仍出现在预设里：${gone}`);
  }
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
