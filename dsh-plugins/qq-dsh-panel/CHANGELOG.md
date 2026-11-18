# Changelog

## 0.7.2 — 2026-11-18

主题：**修掉「重启 DSH 后状态页一直读不到数据」**。根因是四层缺陷叠加，不是单点。

- **真凶：`detached: true` 让「拉起桥接」静默失效。** 面板用
  `spawn('powershell.exe', [...Start-Process...], { detached: true })` 启动桥接时，
  `Start-Process` 根本不生效 —— 桥接进程一个都没起来。A/B 实测（同机同时刻、
  只改这一个参数）：`detached: true` → 10.5 秒后仍未启动；`detached: false` → 1.27 秒就绪。
  去掉 `detached` 即可；`Start-Process` 起的 cmd 本来就是独立进程，不需要脱离父进程。
  这个 bug 之所以看起来「时好时坏」，是因为计划任务 `QQBridgeGuard` 每分钟会把桥接
  补起来 —— 等一分钟又好了，极难复现。
- **等待上限被砍半。** `ensureBridgeRunning` 原本是 `Math.min(waitMs, 10000)`，
  最多等 10 秒；桥接冷启动实测 1.3~20 秒波动，越过这道坎面板就放弃。
  现在用满预算（默认 30 秒），且端口一通立即返回。
- **「已经在跑」那条路不重查。** `handleStatus` 原本只在 `broughtUp.started` 为真时
  重试请求；而 `ensureBridgeRunning` 还有 `{ok:true, already:true}` 的路径，走那条路
  不会重试，第一次探测的失败结果被原样返回 —— 端口明明已经通了却报「读不到数据」。
  改成只要 `ok` 就重查。
- **探测方式换便宜的那条。** `hasBridgeProcess` 每次 spawn PowerShell 做进程枚举，
  实测 650ms（三次取样 652/634/648）。改成三层：端口直连（<5ms）→ `netstat`（28ms）
  → PowerShell 兜底。它只是「可能性检查」，不值得用最贵的手段。
- 整块保活逻辑重写为 `waitConsoleUp` / `bridgeAlive` 两个原语：
  前者是唯一的等待入口，判据是「`/api/status` 真的返回了」而不是「端口开了」
  （实测两者差 80ms：端口先开、路由后挂）；后者由快到慢三层判定，命中即返回。
  轮询间隔 1500ms → 120ms，消掉量化误差。
- 顺带修掉 `waitForShell` 的两头错：它靠「页面文案里有没有 `loading plugin`」判断
  启动页是否消失，而 DSH 的启动提示是**本地化**的 —— 中文界面恒为 false（过早就绪），
  匹配不上时又要等满 15 秒硬兜底。改成认宿主自己打的 `data-dsh-boot-spinner` 标记，
  与语言无关；硬兜底 15 秒 → 5 秒。

实测（桥接完全停止、计划任务临时禁用、只改代码）：
- 修复前：请求 30095ms 后返回 `ok:false`，桥接始终没启动
- 修复后：连续三轮 1363 / 1460 / 1298 ms，全部 `ok:true` 且桥接就绪

## 0.7.1 — 2026-11-17

- **修「诊断页还是有问题」**：`renderTab` 开头用 `d.ok === false` 判定「读不到数据」，
  可诊断接口的 `ok` 语义是**「自检全部通过」**，只要有**一项**没通过它也会返回
  `ok:false`。两个语义一混，后果是：只要有一项自检红（比如 preset 没装），整页就被
  那张兜底卡接管，真正拿到的 6 项检查结果被直接丢掉 —— 数据是全的，被拦在渲染层。
  现在豁免条件是「诊断页 + 有 `checks` 数组」，交给 `renderDiagnoseTab` 去决定怎么显示红项；
  `ok` 只作为「全部通过」的标记，不再兼作「请求成功」的判据。其它页签的兜底不受影响。
- 诊断页标题改成「自检有 N 项未通过（共 M 项）」，一眼能分出「全红＝完全连不上」
  和「一红多绿＝只是某一项没配好」。
- 新增 `scripts/verify-diagnose-render.mjs`：用最小 DOM stub 真实加载 `lib/client.js`，
  断言豁免条件、兜底分支仍在、标题措辞。没有它这类「渲染层把数据吞了」的问题只能靠肉眼发现。

## 0.7.0 — 2026-11-17

主题：**打开 DSH → 点启动 SnowLuma → 立刻连上**，把这条链路上所有会「等很久」的地方堵掉。

- **DSH 端口不再靠猜，改成用权威提示对齐。** 面板的 host 半跑在 DSH 进程里面，
  所以 `req.socket.localPort` 就是 DSH 正在服务的端口。现在 `launch-snowluma`
  与 `diagnose` 都把它作为 `port` 发给桥接的 `/api/dsh/follow-endpoint`，
  桥接一次指纹验证就能定下来，不必再扫一遍回环监听端口。
  只接受回环来源（`127.0.0.1` / `::1`），不接受任何远端提示。
- **「启动 SnowLuma」不再提前返回。** 旧实现是 `probePort(3001)` 一通就回
  「似乎已经在运行」。可 SnowLuma 常常常驻不关，DSH 重启后真正缺的是
  「桥接连上它」而不是「把它拉起来」—— 于是点完按钮什么都没变。
  现在 `already` 只是一个分支标记，后面照样等到 `connected` 或超时。
- **启动后确认 `dshReady`。** 启动流程收尾再对齐一次端点；端口没变时桥接直接回
  `changed:false`，代价很小，但能兜住「SnowLuma 启动那几十秒里 DSH 又换了端口」。
- **诊断页不再卡死。** 三处修正：① 桥接没跑时先 `ensureBridgeRunning`（与状态页
  同一套），而不是对着死端口干等；② 先对齐 DSH 端点，后面的 RPC 才有意义；
  ③ 两条补充信息（presets / model）改成 5 秒短超时，不拖累整页。任何失败都会
  返回结构化结论，不再是一个转圈的空白页。
- **状态页会自愈。** `dshReady !== true` 时顺手促一次对齐，救活了就重读一次状态，
  让模式 / SnowLuma / preset 一并刷新。
- **后端发现改用 DSH 指纹。** 旧实现取「该进程监听的最小端口」，但 DSH 同时监听
  多个回环端口（实测 1873/1874/1875），只有 1873 是 Web UI；「最小」在别人机器上
  更是差出 7000 多。现在与 `bridge.js` 的 `probeDshPort`、`tools/bridge-guard.ps1`、
  `tools/qq-bot.ps1` 共用同一套正文指纹，并额外标出 `selfPort`。
- 诊断页显示「端点对齐」小节与本次耗时；桥接自启失败时把原因写在页面上。

## 0.6.0 — 2026-11-07

- **支持按工作区限定作用范围**：新增 `scope`（`all` / `workspaces`）与 `workspaces`（绝对路径允许列表）。选「只选中的工作区」加上 QQ 聊天工作区后，只有那边的会话让模型用中文思考，其它工作区（包括正在对话的这个）不受影响。
- 判断依据是**会话的 `cwd`**：`systemPrompt.section` 每轮组装都会把当前 `agent` 传进来，取 `agent.session.header.cwd` 与允许列表比对。因此不需要改 DSH 本体，也不依赖 preset 名。
- 路径比较做了三件事：统一分隔符、盘符小写（Windows 不区分大小写）、按分隔符边界判前缀（`.../agents-old` 不会误命中 `.../agents`）。子目录算作所属工作区的一部分。
- **空允许列表 = 谁都不生效**，而不是退回"全部"——后者会让这个设置的实际效果与字面意思相反。
- 新增 `GET /qq-dsh-panel/workspaces`：从 `~/.dsh/storages/workspace.json` 读出工作区清单（标题/路径/会话数），供面板直接勾选，不用手打路径。文件缺失或格式变化时返回空列表，面板给出提示。
- 面板「状态」页新增「作用范围」小节：两个范围胶囊 + 可勾选的工作区列表；已从列表消失但仍在允许列表里的路径会标成「已不存在」，方便清掉而不是静默丢弃。
- 老版本的状态文件（没有 `scope`/`workspaces` 字段）归一化为 `scope: 'all'`，行为与升级前一致。
- smoke 测试补上工作区作用域、路径比较边界、清单路由的断言。

## 0.5.0 — 2026-11-07

- **「思考链中文」开关搬进设置窗口的「状态」页签**：以前只有浮游球小面板里的一行，用户把插件从面板删掉后就再也找不到入口；现在主入口在「QQ 大肥鱼 → 设置 → 状态」。
- 该区块**不依赖桥接**：状态由本插件自己落盘（`~/.dsh/.dsh-thinking-zh.json`），所以桥接没运行时「状态」页虽然显示「读不到数据」，思考开关照样在、照样能切。
- 补上**模式切换**（中文 / 中英混用 / 跟随），胶囊只在开启时出现；切换后就地更新选中态，不重开页签（避免列表跳回顶部）。
- 开关与胶囊都有**失败回退**：请求没成功就把界面拨回原状态并弹提示，不会出现「显示已开启但其实没开」。
- 客户端支持**热更新自替换**：`apply()` 不再发现 `window.__dshFloatDock` 就直接 return，改为先调用旧实例的 `dispose()` 再挂新的，解决了「改了代码但界面还是旧的、必须 Ctrl+F5」的问题；装卸时一并移除 resize/focus/visibilitychange 监听，不会叠加。
- 新增三组无头测试：渲染结构、点击与回退、HMR 重入。

## 0.4.0 — 2026-10-21

- **修复「重启后看不到浮游球」**：根因是桌面端主窗口加载 `dsh://app/`，不经过 HTTP，`webServer.tapIndex` 注入的脚本永远到不了 Electron 窗口（前两版失效的真正原因）。
- 客户端改为**官方客户端插件**：`package.json` 增加 `exports["./client"]` 与 `dsh.client = { platform: "web" }`，`lib/client.js` 改为 `window.__ModuleLoader__.load({ id, factory })` 自注册。
- 移除 host 端的 `/dsh-floatdock/client.js` 路由与 `tapIndex` 注入，避免与模块加载器重复注册同一 id。
- 已验证 boot 图里出现 `{"id":"qq-dsh-panel","url":"plugins/??qq-dsh-panel/client.js&rev=..."}`，模块资源可取回。
- 冒烟测试改为断言 `dsh.client` 声明、loader 注册格式、`exports.apply`，并断言不再注册任何 index tap。

## 0.3.0 — 2026-10-21

- **重做为浮游球（floating dock）**：页面角落一个可拖动的小圆球，点开是「小工具箱」面板，功能以「一行 + 右侧开关」的形式列在里面。
- 彻底移除对官方 DOM 的依赖：不再查找 `[data-composer-card]` / `[class*="_tools"]` / `data-composer-seat`，只挂 `body` + `position: fixed`。
- 加入拖动（5px 阈值区分点击与拖拽）、位置持久化（`localStorage: dsh-floatdock:pos:v1`）、窗口缩放自动收敛到视口内、双击复位。
- 面板方向自适应：球在右半屏时左对齐，空间不足自动翻转，并始终夹在视口内。
- **重构为 feature 注册表**：`lib/features/<id>.js` 承担 host 端（提示词段 + 状态路由），`lib/client.js` 的 `FEATURES` 数组提供同 id 的描述；面板自动渲染，新增功能不改面板代码。
- 拆卸链路改为逐 feature disposer，统一由 `ctx.effect` 回收。
- 客户端资源路径改为 `/dsh-floatdock/client.js`；状态路由保持 `/qq-dsh-panel/state`。
- 冒烟测试改为断言「无 composer 依赖」、feature 注册表、拖动与位置持久化、拆卸链路。

## 0.2.0 — 2026-10-21

- 开关从「输入框上方的悬浮胶囊」改为输入框工具栏内的 28px 按钮，复用宿主按钮 class。
- 挂载策略改为 `[data-composer-card]` → `[class*="_tools"]`，并用 `MutationObserver` 在 React 重渲染后自动重挂。
- 修正主题变量名：`--dsw-alias-text` → `--dsw-alias-label-primary`，`--dsw-alias-border` → `--dsw-alias-border-l1/l2`。
- 状态路由加固：非 GET/POST/PUT 返回 405；非 `application/json` 返回 415。
- 状态写入改为「临时文件 + rename」；`normalizeState` 严格校验 `enabled` 必须是布尔。
- 新增 LICENSE、.gitignore、CHANGELOG；清理遗留的 `.test-web.log`。

## 0.1.0 — 2026-10-21

- 首个可用版本：系统提示词注入、三档模式、输入框上方悬浮开关、状态持久化。
