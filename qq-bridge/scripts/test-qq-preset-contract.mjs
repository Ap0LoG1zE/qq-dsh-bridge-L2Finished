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
  assert.match(prefix, /\{\{model\}\}/);
  // DSH 0.2.1 起 agent loop 只注册 provider / model 两个提示词变量（0.2.0 还有 cwd），
  // 未知变量会让 system prompt 装配直接抛错 ⇒ 每回合 error、模型一次都不跑。
  // 这里钉住「只用已注册变量」，而不只是「有 {{model}}」。
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
  // 压缩边界（2026-10-28 重定）：**对话进行中绝不压缩**。
  // 旧值 0.15（≈15 万触发）会让上下文长期骑在阈值上方，每隔两三步就压一次；
  // 压缩改写历史前缀 → provider 的 KV cache 整段失效 → 之后每步重算全部历史
  // （实测 45~55 秒/步）。所以阈值抬到 0.95（≈95 万，正常会话到不了）只当
  // 安全阀，真正的压缩由桥接在「闲置边界」主动触发（bridge.js idleCompactV2）。
  const compactionBasic = compaction.config.find((row) => row.id === 'compaction-basic').config;
  // 2026-11-13：操作者把 retain/max 抬到了 200k/20k（原来的 80k/8k 保留太短，
  // 压缩后容易被压掉太多近期上下文）。thresholdRatio 仍是 0.95 —— 那条是护栏，不跟着变。
  assert.deepEqual(compactionBasic, {
    thresholdRatio: 0.95, retainTokens: 200000, maxTokens: 20000,
  });
  // 护栏：任何把阈值调回「对话中会触发」的改动都必须先过这里。
  assert.ok(
    Number(compactionBasic.thresholdRatio) >= 0.9,
    `thresholdRatio 必须 >= 0.9（对话中不压缩）；当前 ${compactionBasic.thresholdRatio} 会让上下文骑在阈值上反复压缩、把 KV cache 打死`,
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
test('合并预设的压缩边界：对话进行中不允许触发压缩', () => {
  for (const name of [MERGED]) {
    const doc = yaml.load(fs.readFileSync(
      new URL(`../dsh/agent-presets/${name}/agent.cordis.yml`, import.meta.url), 'utf8',
    ));
    const group = doc.find((row) => row.id === 'compaction');
    const basic = group?.config?.find((row) => row.id === 'compaction-basic')?.config;
    assert.ok(basic, `${name} 缺少 compaction-basic`);
    assert.ok(
      Number(basic.thresholdRatio) >= 0.9,
      `${name} 的 thresholdRatio=${basic.thresholdRatio}：对话中途会触发压缩，必须 >= 0.9`,
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
  assert.match(prefix, /【新会话 \/ 刚压缩完：先拿这两样东西】/);
  assert.match(prefix, /① \*\*调 qq_get_prompt\*\*/);
  assert.match(prefix, /② \*\*调 qq_memory_query\*\*/);
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
  assert.match(prefix, /qq_set_wake_config\(throughSeq=…, config=…\)/);
  // 2026-11-12（操作者在别的会话重写了这一节）：
  //   · 段名从【等、回与沉睡前观察】改成【等、回与收尾】——"观察窗口"这个概念退役了，
  //     改为由收尾工具自己等约 20 秒。
  //   · 收尾结果多了 suggestedThroughSeq（放弃那几条新消息的入口）。
  // 这里跟着钉住新语义；旧断言（发完就收尾 / 没有水位时省略 throughSeq）已随重写消失。
  assert.match(prefix, /【等、回与收尾】/);
  assert.match(prefix, /收尾工具自己会等约 \d+ 秒/);
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
    '【别当群管家/主持人】', '不要在一条里用空格断句',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    // 2026-11-13：操作者又把这节改成了【纯语音】，并加上 qq_set_voice（只有主人能开关）。
    // 断言跟着**当前能力面**走：语音是"打字自动合成"，不是她去调发语音工具。
    '【纯语音】', '你打的字会被自动转成你的声音发出去', 'qq_set_voice',
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
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    // 四类轻量记忆 + 长期记忆都必须给出「什么时候该记」，不能只剩「什么时候该删」。
    // 2026-11-08：合并成 readonly 版之后 selfNote 的引导整段丢了（那段原本只在 owner 里，
    // 写在"你会被相处改变"的人格叙事中），结果 selfNote / pendingThought 只剩"过期就删"，
    // 实测 20 小时零写入。现在把引导收进【记忆卫生】，每一类都要有正向说明。
    // 2026-11-10：长期事实并入【记忆卫生】，写入工具从 qq_fact_add 改成
    // qq_memory_append(category='longTerm')，这里同步钉住新写法。
    // 2026-11-12 精简：五类记忆统一成「- **类别** …」的格式，标题也加了总纲。
    // 删掉了一条纯劝说的（原「这两类写下来是有回报的」）—— 它只是把
    // activeTopic/pendingThought 的说明又复述一遍，没有新信息。
    '按「多久之后还成立」分五类',
    '**selfNote** 只有你能写', '**memberImpression** 记具体小事',
    '**activeTopic** 记这个聊天里还活着的话题', '24 小时没人再提自动消失',
    '**pendingThought** 记你此刻想说还没说出口的那一句', '2 小时后就没了',
    // 2026-11-12：target 从「填群名片」放宽成「填人名」（私聊没有群名片）。
    // 并纠正「同一个人只该有一条印象」——实际每人最多 10 条，满了顶掉最早的。
    // 2026-11-12：target 的写法改成给一个完整调用示例。
    // 起因：模型把 target 放在顶层、而工具 schema 只认 extra.target，
    // 于是报了「memberImpression 需要 extra.target」这种"明明填了却报没填"的错。
    // 已经让工具两端都收顶层 target；预设这边补一句调用示例，避免她再猜。
    '**target 和 content 平级，都放顶层**', '同一个人最多存 10 条',
    // 全局共享 + 会话隔离的边界。
    'selfNote / memberImpression / todo / longTerm 是全局共用的',
    'activeTopic / pendingThought 则各聊各的',
    // 2026-11-12 精简：todo 那条改成粗体类别名开头，判断标准单独成段（原来挤在列表项缩进里）。
    '**todo** 一两天内要兑现的事', "category='todo'", 'extra.dueAtMs',
    '这事过了两三天还成立吗',
    "qq_memory_append(category='longTerm')", '**longTerm** 几个月后仍成立的事',
    // 旧工具已删除，预设里不能再出现它的名字（否则模型会去调一个不存在的工具）。
    // 这条是**反向**断言，放在最后单独检查。
    // 黑话面：slang-learner.js 与整个「黑话学习」子系统已删除，qq_slang_query/qq_slang_submit
    // 不再存在，预设里的【黑话与梗】小节、以及配套的「不要为了显得懂而硬塞术语」都随之移除。
    // 现在跟"梗"有关的约束落在【QQ 场景规则】：遇到网络用语/梗就去搜，不靠猜。
    // 这条断言因此改为检查那条**真正还在**的规则，别再钉死已经删掉的文案。
    'mcp__web-search-safe__web_search', '遇到需要实时信息、网络用语/梗',
    // 频率上限。'别刷屏' 一词语料里已不再出现，改用仍在的等价表述。
    '普通闲聊约 3~5 轮一张', '不要一轮连发多张', '每条只能一张，不能附带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    // 2026-11-12 精简：查人那段原来解释了"桥接怎么维护别名表"，那是给她看的预设里
    // 不该出现的实现细节。现在只留操作指令 + 一条禁令，措辞也跟着变了。
    'triggers.speakerIds', '不要凭记忆编号',
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
