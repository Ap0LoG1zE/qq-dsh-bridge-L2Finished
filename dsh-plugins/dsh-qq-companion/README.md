# dsh-qq-companion

DSH 的 **QQ 伴侣套件（四合一）**。把原先四个独立插件收进一个包里：

| 原插件 | 现在的角色 | 入口 |
|---|---|---|
| `qq-dsh-panel` | 浮游球面板（思考链中文 + QQ 大肥鱼 11 个页签） | `lib/index.js` → `lib/features/*` + `lib/client.js` |
| `qq-agent-context` | QQ 会话身份/令牌注入系统提示词 | `lib/agent-context.js` |
| `qq-agent-presets` | `qq-chat-agent` 预设 + 只读工具守卫 | `presets/*.patch.yml` + `tool-restrict.mjs` |
| `dsh-command-compact-chat` | `/compact_chat` 命令（保留尾部 N token 的压缩） | `lib/compact-chat.js` |

`qq-mode-console` **已丢弃**：模式只剩「二代仿真」一种，桥接控制台的模式面板也已隐藏，
那个设置命名空间读到的值永远不变。

## 安装

```powershell
cd <你的 qq-bridge 仓库>\qq-bridge
node scripts/setup-dsh.mjs
```

`setup-dsh.mjs` 会建 junction、写 profile 的 `package.json`（dependencies + bundles）。
也可以用仓库里的 `scripts/install-qq-companion.mjs` 单独装。

装完**重启 DSH**（host 插件与预设只在启动时加载）。

## 结构

```
dsh-qq-companion/
  package.json            两个 bundle patch + client 声明
  cordis.patch.yml        主 entry（面板 / 身份注入 / compact_chat）
  presets/qq-chat-agent.patch.yml   预设（由 build-agent-preset-patches.mjs 生成）
  tool-restrict.mjs       只读工具守卫（预设行按 dsh-qq-companion/tool-restrict.mjs 引用）
  lib/
    index.js              主入口：按子模块各自的 inject 开作用域装配
    client.js             面板 client bundle（浏览器侧，169 KB）
    agent-context.js      身份/令牌注入
    compact-chat.js       /compact_chat 命令
    features/
      qq-bigfish.js       QQ 大肥鱼（bridge 状态、节奏、记忆、表情…11 页签）
      thinking-zh.js      思考链中文
  locale/{zh,en}.json
```

## 关键设计

**每个子模块各自用 `ctx.inject` 开作用域**，而不是把四个 inject 并成一个数组。

原因（2026-11-25 实测）：Cordis 的 `inject` 里只要有一个服务在插件作用域里拿不到，
**`apply` 永远不会被调用，而且不报任何错误**。当时 inject 里多写了一个 `tokenMeter`，
日志只有「模块已加载」、没有「apply 被调用」，查了很久。

用 `ctx.inject([...], child => ...)` 的话，缺哪个服务就只跳过那个子模块，其余照常装配。

本插件的 `inject` 是空数组 —— 它自己不直接依赖任何服务。

## `/compact_chat`

```
/compact_chat
```

把较早历史压成一条检查点摘要，**保留最后 20 万 tokens 原文**。

与 DSH 自带 `/compact` 的区别：

| | 保留尾部 |
|---|---|
| `/compact` | 后端决定，且 `compactNow()` 按 **0** 选范围 ⇒ 只留最后一条 |
| `/compact_chat` | 本插件自己算切点，保留 `retainTokens`（默认 20 万） |

配置见 `cordis.patch.yml`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `compactRetainTokens` | 200000 | 压缩后逐字保留的最近历史预算 |
| `compactMaxTokens` | 8192 | 摘要那次辅助请求的输出上限 |
| `bridgeUrl` | `http://127.0.0.1:3100` | 桥接控制台地址（身份注入用） |
| `tokenFile` | 空 | 控制台令牌文件；留空自动推导 |

## 桥接目录定位

面板需要找 `qq-bridge` 来读配置、连桥接。定位顺序：

1. 环境变量 `QQ_BRIDGE_DIR`
2. `~/.dsh/plugins/dsh-qq-companion` junction 的真实路径，逐级往上找含 `config.json` 的目录
3. 兼容旧包名（`qq-agent-presets` / `qq-mode-console`）的 junction

## 测试

```powershell
node scripts/smoke.mjs
```

41 项检查：文件完整性、JSON/YAML 可解析、主入口可 import、子模块 inject 声明、
client.js 的模块 id 与包名一致、预设守卫引用指向本包、无旧包名残留。

## License

MIT
