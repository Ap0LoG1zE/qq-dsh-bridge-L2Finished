---
name: rewrite-agent-preset-into-session
description: "改完 agent 预设怎么让已有 DSH 会话生效：改 agent.cordis.yml → 重新生成 patch → 重启 DSH。也说明为什么改会话文件无效。"
whenToUse: "改完 qq-bridge/dsh/agent-presets/*/agent.cordis.yml 后要让现有会话生效；或排查「改了预设但会话里还是旧文案」。"
---

# 预设改动怎么生效

## 三步

```bash
cd qq-bridge
# 1. 改源文件
#    dsh/agent-presets/qq-chat-agent/agent.cordis.yml  →  config.prefix
# 2. 重新生成 patch
node scripts/build-agent-preset-patches.mjs
# 3. 重启 DSH
```

**缺一步都不生效。**

**不要手改** `plugins/qq-agent-presets/presets/*.patch.yml` —— 它是第 2 步的产物，下次跑就被覆盖。

## 为什么必须重启

`dsh-persona` 里：

```js
text: config.prefix    // 字符串，mount 时求值一次
```

对比 `qq-agent-context`：

```js
text: () => textOf(agent)    // 函数，每轮重算
```

前缀是字符串，agent mount 后就固定了。只有重启会重新 mount。

| 操作 | 结果 |
|---|---|
| 改 yml，不 build | 无效 |
| build 了，不重启 | 无效 |
| 改会话文件 | 无效（见下） |

## 为什么不能改会话文件

`~/.dsh/sessions/<hash>/<sid>/session.v4.jsonl.zstd` 里的 `system/message`
是**每轮装配完写下的留档**。改它：

- 打开文件看是新文案，以为成功了
- 下一轮装配又写回旧版
- 同一会话出现多条互相矛盾的记录

只有一种情况它看起来"有用"：那个会话再没跑过新轮次。那是没刷新，不是改成功。

## 验证

```bash
node scripts/verify-session-preset.mjs --expect-gone <旧文案>
```

输出分两部分：**装配源**（patch，下一轮会用到的）和**各会话上次装配的结果**（历史）。
只看后者会误判。

## 坑

**时间戳是 UTC。** 用 `toLocaleTimeString` 会吞掉日期，容易把昨天的记录当成今天的。

```js
new Date(r.time).toLocaleString('zh-CN', { hour12: false })   // 带日期
```

**一个会话有多条 system/message。** 每条是一次装配的结果，只看最后一条。

**系统提示词是拼起来的。** 一条 `system/message` 里混着：

```
You are an AI agent powered by DeepSeek Harness.   ← DSH
【二代仿真模式…】…【发送与汇报禁令…】               ← 我们管的预设
【你的身份】【令牌】【可用表情包】                   ← qq-agent-context
【思考语言策略：简体中文优先】                       ← thinking-zh
Tokens prefixed with @ are paths…                  ← DSH 工具说明
```

真要动会话文件，只换预设那段（`【二代仿真模式` → `【发送与汇报禁令` 该行结尾），
整段替换会让她丢掉工具用法和中文思考规则。

## 会话文件格式（只读核对用）

zstd **多帧拼接**，不是单个流：

```js
import zlib from 'node:zlib';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const starts = [];
let i = 0;
while (true) { const j = raw.indexOf(MAGIC, i); if (j < 0) break; starts.push(j); i = j + 4; }

for (let k = 0; k < starts.length; k++) {
  const a = starts[k];
  const b = k + 1 < starts.length ? starts[k + 1] : raw.length;
  const text = zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8');
  for (const line of text.split('\n')) if (line.trim()) JSON.parse(line);
}
```

写回时只重压改过的那一帧，其余原样 `Buffer.concat`。

## 本机专属配置

`config.json` 在 `.gitignore` 里（含 console-token）。本机要改的行为放这里，
仓库代码里留通用默认值，别把个人配置写进源码。

## 相关文件

| 路径 | 作用 |
|---|---|
| `dsh/agent-presets/qq-chat-agent/agent.cordis.yml` | 唯一源文件 |
| `scripts/build-agent-preset-patches.mjs` | 生成 patch |
| `plugins/qq-agent-presets/presets/*.patch.yml` | 生成物，DSH 读它 |
| `scripts/verify-session-preset.mjs` | 验证 |
| `state/sessions.json` | QQ key → sessionId |
