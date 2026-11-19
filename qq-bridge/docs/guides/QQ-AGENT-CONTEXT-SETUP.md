# 安装 `qq-agent-context`（把身份/令牌注入系统提示词）

## 这个插件解决什么问题

桥接每轮唤醒都会把「身份 / 会话令牌 / 可用表情包」拼进一条 **user message**。这有两个副作用：

1. **每轮都进对话历史**，随历史一起累积、重复计费；
2. **上下文压缩后可能被摘要掉** —— 令牌一丢，模型的 QQ 工具全部 403。

插件的做法：在**每个 QQ 会话自己的 agent 作用域**里注册一个 system prompt 段落。
内容每轮重新装配，不进历史，压缩也压不掉。

---

## 装它要同时满足四件事，缺一个都不生效

### 1. 仓库里的插件源码

```
<仓库>/qq-bridge/plugins/qq-agent-context/
├── index.js
├── package.json        ← name 是 @local/qq-agent-context
├── cordis.patch.yml
├── icon.svg
└── locale/
```

这份源码随仓库提供，不需要改动。

### 2. 建 junction 到 `~/.dsh/plugins`

```powershell
# Windows（管理员 PowerShell）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\plugins\qq-agent-context" `
  -Target "<仓库>\qq-bridge\plugins\qq-agent-context"
```

```bash
# Linux / macOS
ln -s "<仓库>/qq-bridge/plugins/qq-agent-context" ~/.dsh/plugins/qq-agent-context
```

### 3. 【最容易漏】在 profile 里登记

`~/.dsh/profiles/<profile>/package.json`（通常是 `desktop`）：

```json
{
  "dependencies": {
    "@local/qq-agent-context": "link:C:/Users/<你>/.dsh/plugins/qq-agent-context"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...其他已有插件...",
        "@local/qq-agent-context"
      ]
    }
  }
}
```

**两处都要加**：

- `dependencies` —— 声明这个包在哪
- **`dsh.profile.bundles`** —— **DSH 只加载这里列出的插件**

> ⚠️ 只建 junction 不登记 `bundles`，插件永远不会被加载。表现是「明明装了，但没任何效果，插件列表里也看不到」。

还要建带 scope 的 junction（因为 package name 带 `@local/` 前缀）：

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local"
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\qq-agent-context" `
  -Target "$env:USERPROFILE\.dsh\plugins\qq-agent-context"
```

> ⚠️ **不要**在 `profiles/<profile>/cordis.patch.yml` 里再写一条 `- id: qq-agent-context`。
> 插件自带 `cordis.patch.yml`，两份 config 会互相覆盖（插件源码注释里明确警告过这个问题）。

### 4. 打开开关

`qq-bridge/config.json`：

```json
{
  "socialV2": {
    "injectViaSystemPrompt": true
  }
}
```

> ⚠️ **这一步必须在确认插件装好之后再做。**
> 开关会让唤醒词跳过身份和令牌段（`buildWakePromptV2` 里 `viaSystemPrompt ? '' : ...`）。
> 插件若没加载 ⇒ 模型既没有身份、也拿不到令牌，**所有 QQ 工具 403**。

---

## 验证

### ① 依赖能被解析

```bash
node -e "console.log(require.resolve('@local/qq-agent-context',{paths:['C:/Users/<你>/.dsh/profiles/desktop']}))"
```

期望输出：

```
<仓库>/qq-bridge/plugins/qq-agent-context/index.js
```

解析不到就是名字或 junction 有问题，先别开开关。

### ② 注入生效（需要跑一轮对话）

重启 DSH，让机器人在 QQ 里跑一轮，然后看会话记录：

```bash
# 会话目录：~/.dsh/sessions/--<cwd 转义>--/<session-id>/session.v4.jsonl.zstd
```

判断标准：

| 检查项 | 期望 |
|---|---|
| `system/message` 里 | **有** `【你的身份】`、`【令牌】`、`【可用表情包】` |
| 同轮的 `user/message`（唤醒词）里 | **都没有** |
| 模型能不能调工具 | `qq_send_poke` / `qq_set_wake_config` 成功 ⇒ 令牌拿到了 |

### ③ 插件确实被加载

DSH 的插件列表里应该能看到它；启动日志里也可能出现 `qq-agent-context`。

---

## 常见问题

### 装好了但插件列表里看不到

检查 `dsh.profile.bundles` 有没有加。这是最常见的漏项。

### `node_modules/.modules.yaml` 里没有这个包

**正常，无害。** 那是 pnpm 自己的内部记录。DSH 用的是标准 Node 解析，
只要上面 ① 的 `require.resolve` 能通就够了。

### 唤醒词里身份和令牌都没了，工具全 403

说明开了 `injectViaSystemPrompt` 但插件没生效。排查顺序：

1. `require.resolve` 能不能解析？
2. `dsh.profile.bundles` 里有没有它？
3. `cordis.patch.yml` 是不是被重复写了一份（会互相覆盖）？

暂时兜底：把 `injectViaSystemPrompt` 改回 `false` 并重启 DSH，恢复到「令牌在唤醒词里」的旧行为。

### 令牌轮换后插件还拿旧的

插件每 2 分钟刷新一次（`REFRESH_MS = 120000`），令牌缓存 60 秒（`TOKEN_TTL_MS`）。
刚轮换的令牌最多有约 2 分钟延迟。这段时间撞上工具调用会 403，重试即可。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `plugins/qq-agent-context/index.js` | 插件实现 |
| `plugins/qq-agent-context/cordis.patch.yml` | 插件自带的默认配置（`bridgeUrl`） |
| `src/bridge.js` 的 `/api/socialV2/agent-context` | 数据源端点，插件定时来拉 |
| `src/bridge.js` 的 `sessionTokenLineV2` / `selfIdentityTextV2` | 这两段文本的生成处 |
