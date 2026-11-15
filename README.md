# QQ DSH Bridge

把 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面端的 agent 接进 QQ。

不是"套了个大模型 API 的聊天机器人"——它就是你桌面端那个能读文件、能执行命令、
能多步调用工具的 agent，只是换了个入口说话。

```
QQ ⇄ SnowLuma(OneBot v11) ⇄ qq-bridge ⇄ DSH ⇄ agent loop ⇄ MCP 工具
```

---

## 装之前先知道三件事

1. **需要三个东西**：DSH 桌面端（已装好能聊天）、[SnowLuma](https://github.com/SnowLuma/SnowLuma/releases/latest)（QQ 网关）、一个 QQ 号（**建议小号**）。
2. **桥接不会替你启动 SnowLuma**（它的 EULA 禁止自动化部署）。每次开机你要手动开它。
3. **路径不能有空格**。`dsh plugin` 会把参数拼成命令行，空格会被拆开。

装完能做什么、架构细节、二次开发说明，见文末的进阶文档。

---

## 安装

### 最快的方式：交给 DSH 自己装

仓库根目录有一份 **`DSH安装提示词.md`**。把它**全文复制**给你那台机器上的 DSH
（或 Claude Code 之类的 coding agent），它会照着装完并自检。

这是推荐方式——里面包含踩过的坑、验收清单和排查步骤。

### 手动装（四步）

```powershell
# 1. 取仓库（路径不能有空格）
git clone https://github.com/Ap0LoG1zE/qq-dsh-bridge-L2Finished.git qq-dsh-bridge
cd qq-dsh-bridge\qq-bridge

# 2. 装依赖 —— 必须用 npm ci，不要 npm install
#    npm install 会解析到 @snowluma/sdk 1.14.22，MCP 工具 schema 随之漂移，
#    表现为模型报 "tool input is invalid JSON"
npm ci --registry=https://registry.npmmirror.com

# 3. 生成配置
Copy-Item config.example.json config.json

# 4. 装 DSH 端（preset + MCP），然后重启 DSH
node scripts/setup-dsh.mjs desktop
```

**重启 DSH 是必须的**：preset 和 MCP 只在 DSH 启动时加载。跳过这步桥接不会崩，
但建不出会话（日志会明确说 `Unknown agent preset`）。

### 改 config.json 的五个必填项

```jsonc
{
  "ownerQQ": 123456789,              // ① 你的 QQ 号（管理员，能用全部工具）
  "allow": {
    "private": [123456789],          // ② 允许私聊的 QQ（和上面一致）
    "groups": []                     // ③ 想接入的群号，空 = 只服务私聊
  },
  "snowluma": {
    "accessToken": "……",             // ④ SnowLuma 的 HTTP token
    "homeDir": "D:/SnowLuma"         // ⑤ SnowLuma 安装目录（用于自动发现 token）
  },
  "dsh": {
    "baseUrl": "http://127.0.0.1:12345"  // ⑥ 见下方"端口会漂"
  }
}
```

> ⚠️ **`allow.private` 和 `allow.groups` 留空时桥接不响应任何消息**（刻意的
> fail-closed 设计）。白名单必须自己填。

### 启动

```powershell
start.bat
```

看到这三行算成功：

```
SnowLuma 已连接：ws://127.0.0.1:3001
DSH 已就绪（模式: reserved2）
桥接模式已确定为 reserved2
```

然后在 QQ 里发一句话试。

---

## 三个必踩的坑

### 1. DSH 端口每次启动都变

DSH 桌面端每次启动会占用**三个连续端口**，只有**最低**那个是 Web UI。
桥接的 `config.json → dsh.baseUrl` 是写死的，所以**每次重启 DSH 都要改这一项**。

查当前端口：

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 6000 } |
  Select-Object LocalPort, OwningProcess | Sort-Object LocalPort
```

拿最小的那个，写成 `http://127.0.0.1:<端口>`。

症状：日志刷 `DSH 事件流已结束（本次收到 0 帧）`。

### 2. 令牌不在唤醒词里 = 工具全被拒

有两种注入方式，**二选一**，别混着来：

| 方式 | 配置 | 说明 |
|---|---|---|
| **简单**（默认） | `injectViaSystemPrompt: false` | 身份和【令牌】直接写在唤醒词里 |
| **干净** | `injectViaSystemPrompt: true` | 靠 `qq-agent-context` 插件写进系统提示词 |

选第二种就必须把插件装好——**只开开关不装插件 = 模型拿不到令牌，所有 QQ 工具被拒**。
插件安装有**三个步骤**（junction + profile 的 cordis.patch.yml + profile 的 package.json），
详见 `DSH安装提示词.md` 第 6 步。漏第三步最常见。

### 3. `npm install` 会装出错误的 SDK 版本

必须 `npm ci`。`package-lock.json` 锁的是 `@snowluma/sdk 1.14.20`，
`npm install` 可能解析到更高版本，MCP 工具 schema 跟着变，
模型报 `tool input is invalid JSON`，表现为回复异常或变慢。

---

## 常驻（可选）

桥接挂了 QQ 就没人回。用计划任务兜底，每分钟检查一次：

```powershell
schtasks /create /tn "QQBridgeGuard" `
  /tr "wscript.exe <仓库>\tools\bridge-guard.vbs" `
  /sc minute /mo 1 /f
```

---

## 进阶文档

| 文档 | 讲什么 |
|---|---|
| `DSH安装提示词.md` | **给 agent 看的完整安装流程**（含验收与排查） |
| `CHANGES-fork.md` | 本分支相对上游改了什么（长期记忆、面板、撤回、观望调参等） |
| `qq-bridge/docs/guides/DSH_SETUP.md` | DSH 端 preset 与 MCP 的安装细节 |
| `qq-bridge/docs/FOLDER_MAP.md` | 目录结构说明 |
| `qq-bridge/README.md` | 桥接本身的完整能力清单与参数说明 |

---

## 常见问题

**QQ 上完全没反应**
按顺序查：SnowLuma 是否在线 → `config.json` 的 `allow` 白名单是否填了 →
DSH 是否在跑且端口对 → 桥接日志最后 20 行说什么。

**日志说 `Unknown agent preset: qq-chat-agent`**
DSH 没加载到 preset。确认 `setup-dsh.mjs` 跑过，并且**重启过 DSH**。

**日志刷 `收到 0 帧`**
`dsh.baseUrl` 端口不对，见上面「坑 1」。

**模型说拿不到令牌 / 工具全被拒**
见上面「坑 2」。

---

## 许可

MIT（见 `LICENSE`）。上游：<https://github.com/NoMindSama/qq-dsh-bridge>
