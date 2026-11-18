// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  // 收尾前观望（2026-11-14）：mark_read / set_wake_config 的 10 秒空转抓到新消息后
  // **必须贴给模型**。旧实现把 observeBeforeSleepV2 的返回值扔掉，指望下面的
  // uncovered 分支，而那道分支在 anyMessage/active 会话（私聊正是）上恒不成立
  // ⇒ 观望第 1 秒来的消息被静默标成已读、她只收到一句「收尾完成」。
  'test-observe-before-sleep.mjs',
  // 发送后提示已全部砍掉（2026-11-14 操作者要求）：拆句提醒 / 中文空格提醒。
  // 这两条都是**发完之后**才生成，撤不回也改不了，纯占上下文。用例用"旧实现必报警"
  // 的三组输入去撞返回，断言 warn / splitWarn / hint 都不存在，同时确认
  // 观望贴消息的 `text` 没被误伤。
  'test-no-post-send-hints.mjs',
  // 撤回自己刚发的消息（2026-11-15）：只按 **seq** 撤（她唯一看得到的句柄），
  // message_id 藏在桥接内部；只能撤自己发的；超过 2 分钟直接拦下不尝试。
  'test-recall-message.mjs',
  // 主动机会唤醒的提示词（2026-11-15）：私聊不能说"群里"。
  // 机制本来就对私聊生效（无 group 限制），是她看到"群里安静了一阵"
  // 判断成别人的事才不开口。
  'test-proactive-prompt.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // 预设完整性：按"累积改动清单"核对，防止改一处把别处弄没（2026-11-12 加）。
  // 起因：拿旧备份回滚时，把操作者在控制台改的记忆段落整段盖掉了。
  'test-preset-completeness.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、reserved2 落库丢表情识别字段（R16）。
  'test-audit-regressions.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'test-media-search.mjs',
  // B站分享卡片内联展开（2026-11-12）：卡片 JSON 抽取、链接归类、外网文本清洗、
  // 降级链（开关关/非B站/接口失败都要回到「[卡片消息]」）。纯函数段不依赖网络；
  // 真实网络那一条失败只告警，不会把必跑回归打红。
  'test-card-parse.mjs',
  // qq-agent-context 的**首轮令牌**契约（2026-11-17）：桥接写 sessions.json 发生在
  // api.sessions.create() 之后，而 agent/created 在 create 内部就派发完了 —— 于是
  // 「建会话时去问桥接」必然 404。旧实现（拿到数据才注册段）因此让新会话第一轮
  // 永远没有【令牌】（实测 107 个历史会话首轮带令牌的是 0 个）。
  // 现在断言的是：段无条件注册 + 首次装配（prompt 投递之后）必须已带令牌；
  // 非 QQ 会话不得每步打 404；桥接连不上不许把异常漏进回合。
  'test-agent-context-inject.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'test-issue-regressions.mjs',
  // 二代「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'test-v2-initial-prompt.mjs',
  // 冷启动引导（2026-11-13 重建）：新会话 / 刚压缩过 → 那两句提示。
  // 只认**投递出口**（DSH 真收到了什么）。覆盖旧实现的两个真实故障：
  // 压缩后那句从没发出去（被第一遍渲染清掉标记）、新会话那句在同一会话里发两遍
  // （降级只作用于被丢弃的那一份）。断言直接用 h.calls.prompts，禁止再对着
  // buildWakePromptV2 单次渲染写断言 —— 那正是旧测试全绿而线上出错的根因。
  'test-cold-start.mjs',
  // 冷启动标记的归属：共用会话下一份、没开共用时各一份（替换旧的 test-bootstrap-sharing /
  // test-double-bootstrap —— 那两个断言的是 bootstrapSent 的组级置位，
  // 而 bootstrapSent 现在只管【初始提示词】，不再决定那两句提示）。
  'test-cold-start-sharing.mjs',
  // 多条数组「逐条发送」期间的盲区（2026-11-17 操作者实测）：
  // sendMessagesV2 按数组间隔逐条发，3 条约 5~10 秒，那期间对方说的话
  // 既不算"观望期间新到"、也不会被带回去。修法是发送前拍快照当基线，
  // 并且 observeBeforeSleepV2 不能自己再拍一份把它覆盖掉。
  'test-send-observe-gap.mjs',
  // 观望语义的连续性（2026-11-17 操作者定）：总预算=发送耗时+20秒，
  // 来消息就重置 10 秒安静窗，无额外上限。
  'test-observe-continuous.mjs',
  // noWait（2026-11-19）：急着连发时只等"句末那一截"，与句间同一套随机逻辑。
  'test-send-nowait.mjs',
  // 面板改值 → 桥接配置 → 实际行为 的端到端连通性（2026-11-19）。
  // 操作者要求「验证小面板里改的数据能确实影响到实际的设置」。
  // 走真实路由（harness 隔离实例），不 mock，覆盖：内存更新、影响等待时长、
  // 可反复修改、条数上限随之变化、前端秒↔毫秒换算。
  'test-panel-settings-e2e.mjs',
  // 唤醒包给**最新**的未读（2026-11-19 操作者要求）：
  // 原来给最旧的 12 条，导致 6 小时前的闲聊在、19 秒前的消息被截掉。
  // 水位必须停在"上一轮读到的位置"，否则中间那段会被当成已读永久丢失。
  'test-wake-latest-first.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // 守卫本身的回归：restrict 失败不静默、延迟重试补藏、三档 mode 的执行期矩阵
  // （strict / readonly / open）与"未知 mode 按 strict 处理"的 fail-closed 防线。
  'test-tool-restrict-guard.mjs',
  // 三档权限分级（2026-10-26）：owner 优先于白名单、显式白名单才给只读档
  // （allowAllWhenEmpty 不得提权）、deny 前置、新 preset 缺失时 fail-closed、
  // 以及档位变化触发会话重建。纯离线，跑的是真实 bridge.js（VM harness）。
  'test-permission-tiers.mjs',
  // 发文件（qq_send_file）：路径安全层（扩展名白名单 / 敏感路径黑名单 / 体积 / 普通文件）
  // + 真实路由闸门（只有 Owner 档能发出去；群聊 / 白名单 / 陌生会话一律 403 且不碰网关）。
  'test-send-file.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
