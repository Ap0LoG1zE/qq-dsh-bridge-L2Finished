# 文档索引

> 根目录只留 `README.md` / `README.en.md` / `RULES.md`，其余在 `docs/`。
> 目录结构见 [FOLDER_MAP.md](FOLDER_MAP.md)。

## 接手前先读

| 文档 | 说明 |
| --- | --- |
| [PROJECT_HANDBOOK.md](PROJECT_HANDBOOK.md) | AI 会话工作档案：这是哪个仓库（fork ≠ origin）、system prompt 由谁生成、上下文瘦身改过什么、重启与验证怎么做 |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 目录与 `scripts/` 命名约定 |

## guides/

| 文档 | 说明 |
| --- | --- |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装：preset 与 MCP server 怎么挂 |
| [guides/QQ-AGENT-CONTEXT-SETUP.md](guides/QQ-AGENT-CONTEXT-SETUP.md) | `qq-agent-context` 插件安装（把身份/令牌注入系统提示词） |
| [guides/skills/rewrite-agent-preset-into-session/SKILL.md](guides/skills/rewrite-agent-preset-into-session/SKILL.md) | 改完预设怎么让已有会话生效（改 yml → build patch → 重启 DSH） |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | DSH 0.2.1 适配记录。升级 DSH 前先看 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | DSH 0.2.0 适配记录 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全基线与威胁模型。**动安全相关代码前必读** |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径 |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览与浏览器回归 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 隐私边界：哪些内容算本机私有、不该进仓库 |

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 把 qq-bridge 接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 装 qq-agent-context | [guides/QQ-AGENT-CONTEXT-SETUP.md](guides/QQ-AGENT-CONTEXT-SETUP.md) |
| 改完预设不生效 | [guides/skills/rewrite-agent-preset-into-session/SKILL.md](guides/skills/rewrite-agent-preset-into-session/SKILL.md) |
| 升级 DSH | [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) |
| 动安全相关代码 / 发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 看 AI 烧了多少钱 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
