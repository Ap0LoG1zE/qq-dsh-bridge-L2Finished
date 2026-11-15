# 本分支相对上游的改动

> 上游：https://github.com/NoMindSama/qq-dsh-bridge
> 本分支在原版基础上做了三类改动：**长期记忆（L2）落地**、**面板增强**、**若干修复**。

---

## 一、长期记忆（L2）真正落地

原版的 `memory-facts.js` 实现了完整的数据层（权重、艾宾浩斯衰减、归档、注入选择），
但**写入通道从未接进模型工具链** —— `addFact()` 唯一调用方是人工 CLI 脚本，
所以 `facts/` 目录永远是空的，L2 整层空转。

### 1. 新增 MCP 工具 `qq_fact_add`

**文件**：`qq-bridge/src/mcp-snowluma-safe.js`

- 参数：`key` / `token` / `text` / `tag`
- 工具描述里写清了 6 个 `tag` 的语义（`TAG_WEIGHTS` 是决定权重的唯一依据，
  模型不知道差别就会乱填）
- 明确区分长期事实（跨会话成立）与轻量记忆（会过期）

### 2. 新增 HTTP 端点

**文件**：`qq-bridge/src/bridge.js`

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/socialV2/fact-add` | POST | 写入长期事实，内部调 `addFact()` |
| `/api/socialV2/facts` | GET | 查询，按权重降序；不传 key 返回全部会话 |
| `/api/socialV2/fact-update` | POST | 按 id 改 text / tag（追加修订记录，不原地改） |
| `/api/socialV2/fact-remove` | POST | 按 id 归档（保留记录，只标记 `archived`） |

### 3. 压缩前整理改用 `qq_fact_add`

**文件**：`qq-bridge/src/bridge.js` → `summarizeForIdleV2`

原提示词写着「长期事实写用 `qq_memory_append`」—— 但那个工具只写 `social-v2.json`
的轻量记忆，**从不碰 `facts/`**。模型照着做，写的全是会过期的话题。

改后：

- 长期事实走 `qq_fact_add`，自我认知仍走 `qq_memory_append(category=selfNote)`
- **把已有 facts 和 selfNote 一起喂进提示词**，让它自己判断哪些已经记过
- 加了正反例，减少流水账

### 4. 每轮唤醒附带加权提示

**文件**：`qq-bridge/src/bridge.js` → `buildWakePromptV2`

只在 `factsLine` 非空时追加：

```
【长期记忆·加权】如果这轮对话里有人提到了上面【长期记忆】中的某件事，
用 qq_fact_add 把那条事实原样再写一遍 —— 重复写入只会给它加权，不会多存一条。
```

**零额外成本**：拼进本来就要跑的那一轮唤醒包里，不新开会话、不额外调模型。

---

## 二、控制台面板增强

**文件**：`dsh-plugins/qq-dsh-panel/`

### 新增「长期记忆」页签

- 每条约一张卡，按权重从高到低
- 左侧类别色条（身份蓝 / 约定紫 / 情绪粉 / 偏好绿 / 梗橙 / 其他灰）
- 权重数值分档上色（≥2.8 绿 / ≥1.5 黄 / <1.5 灰）
- **内联编辑**：正文 textarea + 类别下拉，改 tag 会重算 baseWeight
- 两段式删除（点一次变「确认删除」，5 秒无操作自动退回）

### 新增「群友印象」页签

- 每人一张卡，两列网格
- 名字用品牌色，和「长期记忆」的正文白区分
- 每条 trait 左侧竖线，多条时读作列表
- 同样支持内联编辑 + 改名 + 两段式删除

### 对应后端路由

`qq-bigfish.js` 新增 `handleFacts` / `handleImpressions`，转发到桥接的四个端点。

---

## 三、修复

### 1. `tools/fix-session-preset.mjs` 解压 bug

原版用 `zlib.zstdDecompressSync(raw)` 一次性解压，但 DSH 的会话日志是
**每事件一个 zstd 帧**的格式（实测单会话 10316 帧），单流解压只解出第 1 个
header 事件，于是永远找不到系统提示片段，脚本报「没找到」。

重写为：逐帧解压 → 文本层替换 → 每行一帧重新压缩 → **解压自检逐行比对**，
不一致就拒绝写盘。

### 2. 端口发现取最低端口

**文件**：`tools/qq-bot.ps1`、`dsh-plugins/.../qq-bigfish.js`

DSH 桌面端每次都监听**三个连续端口**，只有**最低**那个是 Web UI 且接受 Cookie 鉴权；
+1 / +2 只接受 Bearer token。原版取任意一个，会 401。

### 3. 移除 `qq_get_self_image` 工具

该工具返回固定的鲸鱼娘图片，与自定义人格冲突。已从工具注册、默认值、
`toolFlags`、控制台名称映射、`console.html` 勾选框、`config.example.json`
以及 `/api/socialV2/self-image` 端点全部移除。

### 4. 收尾观望抓到新消息却丢给模型（2026-11-14）

**症状**（操作者实测，私聊 `private:10001`）：`qq_mark_read` 开始 10 秒空转，
操作者在**第 1 秒**发了条新消息，空转**正确地**提前结束了 —— 但她收到的却是一句
「✅ 收尾完成」，那条消息她根本没看见，要等下一次唤醒才补上。

**根因**不是观望逻辑，而是**返回值被扔掉**。`bridge.js` 的 mark-read / wake-config
里原本是：

```js
await observeBeforeSleepV2(st, key, ...);   // 返回值丢弃
// 指望下面的 uncovered 拦截分支替它把消息贴出去
if (isSleepingConfigV2(...) && preSleepWaitBlockedV2(...)) { ...贴消息... }
```

而那道拦截分支有两道门，两条都可能把「刚抓到的消息」挡在外面：

- `isSleepingConfigV2()` 在 `mode === 'active'` 或 `triggers.anyMessage` 时**恒为 false**
  —— 私聊正是把 `anyMessage` 开着的那一类，所以永远进不去；
- `preSleepWaitBlockedV2()` 在最近一句是「晚安/拜拜」时也返回 false。

结果：观望抓到的消息既没贴出，又随收尾被标成已读 —— 白等 + 丢消息。

**修复**：

1. `observeBeforeSleepV2()` 的返回值补上 `fresh`（观望期间新到的那几条 seq 差集），
   不再让调用方自己去算。
2. mark-read / wake-config 都收下这个返回值，进门条件改成
   `!coverAll && (blockedByObserve || blockedBySleep)`：**观望期间真的有人说话了**
   本身就足够拦一次，不再受那两道门影响。`!coverAll` 保留原语义 ——
   她主动给出覆盖式水位（读完即收尾的合法写法）时不被硬拦。
3. 贴出的内容改成 `observedFresh ∪ uncovered` 去重后按 seq 升序，并把并集
   记进 `modelSeenSeqs`（贴出即视为看过，避免下一轮重复贴）。
4. `qq_set_wake_config` 那边同步修：观望不再只在 `isSleepingConfigV2(next)` 时进行
   （她要是把 anyMessage 打开，旧写法等于干脆不观望）。
5. 尊重 `socialV2.wake.preSleepWaitEnabled === false`：总开关关掉时观望抓到也不拦。

**测试**：新增 `scripts/test-observe-before-sleep.mjs`（8 例），已登记进 `test-audit.mjs`。
改前 5 例必红，改后全绿。

**顺带修的测试夹具 bug**：`scripts/audit-bridge-harness.mjs` 里
`setInterval: () => ({ unref() {} })` 是个空桩 —— 观望的 250ms 轮询永远不回调，
Promise 永不 resolve，`/api/socialV2/mark-read` 在测试里整个挂死到 4 秒超时。
这正是 `test-token-economy.mjs` 长期 10/36、且失败方式全是「超时」而不是断言的原因。
换成真 `setInterval` 并在 `close()` 里清理后，那些用例才真正跑到断言
（变成 12/36；剩下的是该文件既有的 `.data.messages` 接口过时问题，与本次改动无关）。
`test-token-economy.mjs` 同时把 `observeBeforeSleepMs` 配成 0（它测的是水位语义，
不该付观望那 10 秒）。

### 5. 砍掉所有「发送后提示」（2026-11-14，操作者要求）

**原话**：「这她已经发完了，一点用都没用，而且还占上下文，除了这种提示还有别的提示，全都砍了」

被砍掉的是两条 `qq_send_message` / `qq_send_burst` 返回里的软提醒：

| 字段 | 文案 | 检测函数 |
|---|---|---|
| `splitWarn` | 「第 1、2 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。」 | `findSplitBoundaryWarning` |
| `warn` | 「第 N 条消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。」 | `findCjkSpaceWarning` |

**为什么该砍**（不只是"操作者不喜欢"）：

1. **无法执行**：提示在消息**已经发到 QQ 之后**才生成。她看见了也撤不回、改不了。
   真正能作用于内容的时刻是发送前，而那时她没有这些信息 —— 这是设计的死结。
2. **纯开销**：每轮发送都往上下文加一句（30~60 字），而检测本身还要逐字符扫描 / 正则回扫。
3. **会干扰她**：口语化的短句结尾（如「那我就先回去了的」）会被判成"拆开了"，
   她可能为了消掉提示而改变自己说话的方式 —— 这是最坏的一种副作用。

**改法**：不是加开关关掉，而是**连函数本体一起删**（`bridge.js` 里两个函数 +
两处调用；`mcp-snowluma-safe.js` 里 `for (const k of ['hint','warn','splitWarn'])`
两处出口）。留死代码以后还会被接回去。

**没被误伤的**：观望期间贴新消息的那个 `text` 字段保留 —— 那是她真正需要的信息
（对方接话了）。测试里专门有一条守着它。

**测试**：新增 `scripts/test-no-post-send-hints.mjs`（5 例），用「旧实现必报警」的三组
输入（以逗号结尾 / 以"的"结尾 / 中文间空格）去撞返回，断言 `warn`/`splitWarn`/`hint`
都不存在，并反向验证 `text` 还在。已登记进 `test-audit.mjs`。改前 5 例全红，改后全绿。

**真实链路已验证**：重启后打 `/api/socialV2/send-message` 发
`['其实我是想说，', '我 今天 有点 累']`（两条旧提示都会被触发），
返回只剩 `{"ok":true,"sent":2,"failed":0,"delays":[2418],"quoted":null}`。

### 6. 收尾观望整个删除 + 发送后等 20 秒（2026-11-15，操作者定稿）

> 这一节**推翻了第 4 节**的做法。第 4 节修的是"观望抓到消息却没给她"，
> 但操作者随后发现：观望本身就是错的方向。

**操作者的判断**：

> 「如果在两个工具中间发了消息，就进到 unread 里了，得下一次等待才能一起发给她」
>
> 实测例子：`【2 条新消息】#127 (57秒前) / #131 (5秒前)` —— 两条差 52 秒，
> 说明它们分别落在不同的空隙里，而那次收尾观望一条都没抓到。

**为什么观望解决不了**：它只覆盖"收尾这一瞬间"。消息真正会丢的地方是
**两次工具调用之间** —— 那时没有任何等待在跑，消息安静地进 unread，
只能等下一次唤醒。而每次收尾却要为此白等 10~20 秒。

**改法**：

1. **删掉 `qq_mark_read` / `qq_set_wake_config` 的空转**，连同
   `observeForCloseV2` 一起删。收尾行为回到最朴素的：
   算 `uncovered` → 没读的贴出来 → 标已读。
2. **新增 `socialV2.send.observeAfterSendMs`（当前 30000）**：
   `qq_send_message` / `qq_send_burst` 发完之后空转看对方接不接。
3. `observingKeys`（观望期间压住唤醒）保留，改为给发送后空转用 ——
   否则那段时间里消息一到就排唤醒，同一批会被处理两遍。

**两轮调参的过程（保留，说明为什么是 30/10）**：

| 轮次 | observeAfterSendMs | send.observeQuietMs | 起因 |
|---|---|---|---|
| 初版 | 20000 | 5000 | 操作者定 20 秒 |
| 现在 | **30000** | **10000** | 「我每次聊天得发很快才能卡在 5 秒内，太短了」 |

**第二个参数的真正含义**（容易误解，特意记下来）：

`send.observeQuietMs` = **来了一条消息之后，再等它安静多久才返回**。
每来一条新消息就把计时器重置成这个值。

所以操作者说的"得发很快才能卡在 5 秒内"指的是：**他两句话之间的间隔必须
小于这个安静窗，否则第二条会落到下一次返回里**。这不是"她等得不够久"，
而是"给他的打字时间不够"。安静窗 5→10 秒，等于把允许的连发间隔放宽一倍。

**语义澄清（操作者特别问过）**：

`minSendIntervalMs` 和"数组内多条之间的间隔"是**两套独立机制**：

| 机制 | 配置项 | 实际范围 |
|---|---|---|
| 数组内多条之间 | `burstIntervalMinMs/MaxMs`、`longGapMaxMs`、`maxGapMs` | 1~10 秒（`clampGapV2` 按 `maxGapMs` 钳） |
| 发送后空转 | `observeAfterSendMs` | 30000 |
| 连发合并窗 | `send.observeQuietMs` | 10000 |

`computeGapsV2` **一次都没读** `minSendIntervalMs`，所以把空转调大
**不会**让一次工具发 5 条变成每条都等那么久。

**最终形状**：`空转时间 = Σ(数组内间隔) + observeAfterSendMs`

- 1 条 → 0 + 30 = 30 秒
- 3 条（间隔 1s）→ 2 + 30 = 32 秒
- 5 条（1~3 秒随机）→ 约 4~12 + 30 = 34~42 秒

数组间隔部分由 `sendMessagesV2` 里的 `sendChain.then(() => sleep(d))`
**真的 sleep 掉**，所以 `paceAfterSendV2` 只需补 observeAfterSendMs 那一截。

**上限**：`hardCapMs = observeAfterSendMs + observeQuietMs = 30 + 10 = 40 秒`，
是单次发送工具调用的最长耗时。MCP 侧 `agentApi` 是 300 秒、
DSH `toolCallTimeoutMs` 是 725 秒，余量充足。

**真实链路实测**：

第一轮（20/5 参数，重启后打真实 HTTP）：

```
① mark_read          8ms   （原来 10155ms）
② set_wake_config    5ms   （原来 10181ms）
③ send_message ×1    20223ms
④ send_message ×3    22583ms  delays=[1000,1000]  → 2×1000 + 20000 ✓
```

第二轮（30/10 参数，操作者真机连发）：

```
14:18:35 [pace] 开始观望 waitMs=30000 已有未读=1
14:19:03 [pace] 观望结束 arrived=true waitedMs=28300 条数=3   ← 3 条合并成一次
14:19:38 [pace] 观望结束 arrived=false waitedMs=30062 条数=0  ← 等满 30 秒
14:19:43 [mark] throughSeq=100 uncovered=[101] blocked=true   ← 收尾拦下新到的
14:19:48 [mark] throughSeq=101 uncovered=[] coverAll=true     ← 收尾成功
```

`条数=3` 就是操作者要的效果：连发的几句进同一次返回，不再被切成几轮。

**测试**：`scripts/test-observe-before-sleep.mjs` 9 例
（收尾不空转 ×2、没读仍贴出、发送后等、没人说话等满、**连发合并 + 计时器重置**、
多条数组叠加、单条只等 observeAfterSendMs、观望期间压住唤醒）。
改前 7 例红，改后全绿。
`test-no-post-send-hints.mjs` 同步改用 `observeAfterSendMs`。

**⚠️ 收尾仍会贴「未读」—— 这是有意的，不是漏删**：

删的是**空转**；`mark_read` 里 `!coverAll && blockedBySleep` 那条分支保留。
它防的是「她没看过这些消息，却要直接标成已读」。实测日志里它是这样触发的：

```
14:19:43 [mark] throughSeq=100 uncovered=[101] coverAll=false blocked=true
```

含义：她读到 100 就收尾，但 101 在她读完之后才到 —— 直接标掉就等于吞消息。
所以先贴出来，等她再调一次才真正收尾。密集对话时这会多几轮往返，属于
「严格防漏」的必然代价，不是 bug。

### 7. 新增 `qq_recall_message`：按原文撤回自己刚发的消息（2026-11-15）

**操作者的需求与原话**：

> 「不应该叫 qq_recall，你想想应该叫啥，然后我要求这个工具输入输出都要精简，超过两分钟的就别管了」
>
> 「她按原文输入，然后桥接那边自动判断是哪一条，然后去撤回」

**为什么是「按原文」而不是 seq / message_id**：

- 她**自己的消息没有 seq**。`seq` 是入站未读水位的编号（`lastUnreadSeq + 1`），
  自己发的消息本来就不占号 —— 这是既有设计，不该为了撤回去改。
  （试过给她的消息编高位段 seq，被操作者否掉：那会让消息列表出现两套编号。）
- `message_id` 是一长串可能为负的数字，让她记没意义、也占上下文。
- **复述自己刚说过的话**最自然，且完全不动她看到的上下文格式。

**实现**：

| 位置 | 改动 |
|---|---|
| `bridge.js` | 新增 `/api/socialV2/recall-message`；`sendMessagesV2` 把每条回执的 `message_id` 带出来（`sentMessages.ids`）；`recordSentMessagesV2` 记 `sentReceipts: [{text, id, at}]` |
| `mcp-snowluma-safe.js` | 新工具 `qq_recall_message(key, token, text)`，`timeoutMs: 15000` |

**匹配策略**（从严格到宽松）：完全相等 → 包含 → 互相包含；多条命中取**最新**那条
（她说"撤刚才那句"几乎总是指最后说的）。

**2 分钟窗口**：桥接自己判，超了直接回「超过 2 分钟，撤不回了」，
**不发起任何网络请求**。理由：QQ 私聊/群聊撤回时限都是 2 分钟，超了必然失败；
而 SnowLuma 失败时只回一句 `message not found or not retractable`，
不区分"太久"和"id 错"，让她读不出该不该重试。

**输入输出精简**：

```
qq_recall_message(key, token, text)   →   "✅ 已撤回"
                                      或  "超过 2 分钟，撤不回了"
                                      或  "没找到这句（只记得最近 2 分钟内自己发的内容）"
```

**保留 recentMessages 里那条**：撤回只影响 QQ 侧。她的上下文里那句还在，
抹掉会导致"我说过什么"和上下文对不上；原文库是事实来源。

**真实链路实测**（重启后）：

```
① 发送                       20325ms   sent=1
② 发送后历史里能看到         是 ✔
③ 按原文撤回                  74ms   HTTP 200 → ✅ 已撤回
④ 撤回后历史里还在吗         已消失 ✔
⑤ 重复撤回                   HTTP 400 → 没找到这句
```

**测试**：`scripts/test-recall-message.mjs`（7 例），已登记进 `test-audit.mjs`。
覆盖：自己的消息不带 seq、按原文撤回、片段命中、多条取最新、别人的撤不了、
超 2 分钟不尝试、空/超长原文拒绝。改前 7 例全红，改后全绿。

---

## 四、改动文件清单

```
dsh-plugins/qq-dsh-panel/lib/client.js                        +485
dsh-plugins/qq-dsh-panel/lib/features/qq-bigfish.js            +84
qq-bridge/src/bridge.js                                          +287
qq-bridge/src/mcp-snowluma-safe.js                                +61
tools/qq-bot.ps1                                                  +13
tools/fix-session-preset.mjs                                     新增
qq-bridge/roles/角色A.md                                         新增
qq-bridge/config.example.json                                      -1
qq-bridge/public/console.html                                      -1
qq-bridge/scripts/console-ui-contracts.json                      ±8
qq-bridge/scripts/test-qq-preset-contract.mjs                     ±2
qq-bridge/dsh/agent-presets/*/agent.cordis.yml                 格式重排
qq-bridge/plugins/qq-agent-presets/presets/*.patch.yml         重新生成
qq-bridge/roles/傲娇助手.md                                       删除
```

---

## 五、需要注意

1. **`config.json` 与 `state/` 不进版本库**（`.gitignore` 已排除），
   使用时需要自己从 `config.example.json` 复制并填写。
2. **preset 改动只对新建会话生效**。已有会话的系统提示词是冻结在会话日志里的，
   要么用 `tools/fix-session-preset.mjs` 改写，要么等会话重建。
3. **`qq_fact_add` 的 tag 决定权重**，工具描述里已写明 6 个语义，换文案时别删。
