// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, presetTierKey, renderPresetPromptYaml } from './preset-prompt.js';
import { checkSendFilePath, normalizeSendFileConfig } from './send-file-lib.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE, auditOutbound } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage, describeAge } from './qq-model-view.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
  // B站分享卡片内联展开。只导入需要的这两个。
import { setCardConfig, summarizeCard } from './card-parse.js';
import { normalizeImageForModel } from './media-normalize.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse, renderForwardText } from './forward.js';
import { resolvePriceTable } from './model-prices.js';
import { createTokenLedger } from './token-ledger.js';
import { createStore as createMemoryStore } from './memory-store.js';
import { selectForInjection as selectFactsForInjection, addFact, loadFacts, weightOf, archiveFact, TAG_WEIGHTS, factsFileOf } from './memory-facts.js';
import { INITIAL_SCORE as AFFINITY_INITIAL, STAGES as AFFINITY_STAGES, SCORE_MIN as AFFINITY_SCORE_MIN, SCORE_MAX as AFFINITY_SCORE_MAX, stageOf as affinityStageOf, bumpAffinity, decayAffinity, scoreForMessage, describeAffinity } from './affinity.js';
import { createRecall } from './memory-search.js';
import { createArtifactStore } from './artifact-store.js';
import {
  synthesize as synthesizeTts,
  ensureTtsServer,
  ttsReady as ttsServerReady,
  normalizeTtsConfig,
  TTS_DEFAULTS,
} from './tts.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  resolveSticker,
  formatStickerList,
  renderStickerListText,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';
import { isStickerLike, describeInlineImage, stickerLabelFromSummary } from './media-kind.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
// 纯语音的合成产物：按"文本+音色"哈希缓存，同一句话不重复合成。
const TTS_CACHE_DIR = path.join(STATE_DIR, 'tts');
// 原文库检索器：懒加载（首次检索才建索引），events 目录 mtime 变了自动重建。
// 与 memoryStoreHandle 一样放在模块级，避免每个请求都新建一份索引。
let recallHandle = null;
function getRecall() {
  if (!recallHandle) recallHandle = createRecall({ dir: path.join(STATE_DIR, 'memory', 'events') });
  return recallHandle;
}
// 产物索引（L3）：正文落盘，索引只留 id/描述/大小/校验和。仅 owner 私聊可用。
let artifactHandle = null;
function getArtifacts() {
  if (!artifactHandle) artifactHandle = createArtifactStore({ dir: path.join(STATE_DIR, 'memory', 'artifacts') });
  return artifactHandle;
}
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 操作者为每个会话预写的「初始提示词」（见 main() 里的 initialPrompts）。
// 单独一个文件：它属于操作者配置，不能随 social-v2.json 的会话状态一起被重置清掉。
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

// 开了 socialV2.deferTools 之后，MCP 侧只原生注册这几个工具（其余经 qq_find_tool /
// qq_call_tool）。两组必须手动保持一致：MCP 侧是 src/mcp-snowluma-safe.js 的 EAGER_TOOLS，
// 桥接侧是这里 —— 漂移的表现是模型去调一个不存在的工具，或以为某工具不能用。
const DEFERRED_RESIDENT_TOOLS = new Set([
  'qq_get_unread_messages',
  'qq_send_message',
  'qq_get_message_images',
  'qq_wait_for_messages',
  'qq_mark_read',
  'qq_set_wake_config',
  'qq_get_prompt',
  'qq_find_tool',
  'qq_call_tool'
]);

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

/**
 * 从 DSH `settings.describe` 的一个命名空间里读某个键，**user 层优先、value 回退**。
 *
 * 为什么不能只读 `value`：DSH 0.2.0-rc.2 的 `settings/update` 写入的是 user 层
 * （profile patch 的显式 config），当次进程内 `describe().value`（取自插件 fiber 的
 * 运行配置）**不会更新**，要重启 DSH 才变。控制台切模式后 5 秒一次的 `refreshMode()`
 * 会读回旧 `value`，把刚选的模式改回去（issue #22，实测复现）。
 * 写哪读哪：`user` 里有显式值就用它，否则回退 `value`（从没写过时 `user` 是空对象，
 * 老行为不变；DSH 以后修好热更新也继续正确）。
 */
function settingFromDshNamespace(ns, key) {
  if (!ns || typeof ns !== 'object') return undefined;
  for (const layer of [ns.user, ns.value]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    if (Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 8000（2026-10 起：小鲸鱼卡补了形象/圈层/白饭-token/开发事件梗，6000 会把
// 末尾「你的样子」整段截掉——截断点落在卡尾而不是卡中，比调大预算更危险），
// 仍是每条约 6~8k token 的成本护栏；可用 config.json 的 role.maxInjectChars 调整
// （1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 8000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'v2') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
  }
  if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
    warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
        injectedV1: Math.min(stats.v1, roleInjectMaxChars),
        injectedV2: Math.min(stats.v2, roleInjectMaxChars),
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 四个仿真预设各自有独立的预设提示词，控制台可分别查看与修改：
//   一代 qq-chat（空格分条 / [SILENT]）· 二代 qq-chat-v2（一切皆工具，仅聊天档）
//   qq-chat-owner（管理员私聊，全工具档）· qq-chat-readonly（白名单，只读档）
//
// ⚠️ 2026-11-07 合并：上面四个已经合并成唯一一个 `qq-chat-agent`（权限按 readonly）。
//    为了不打断控制台与既有调用方，PRESET_NAMES 的四个键仍然存在，但**值全部是同一个
//    preset 名**——于是想按档位取名字的代码不用改，取到的自然都是合并后的那个。
//    三档分级本身已取消：owner 不再拥有全工具档（这是刻意的，合并要求权限按 readonly）。
const MERGED_PRESET = 'qq-chat-agent';
const PRESET_NAMES = { v1: MERGED_PRESET, v2: MERGED_PRESET, owner: MERGED_PRESET, readonly: MERGED_PRESET };
/** 控制台展示用的档位名（键与 PRESET_NAMES 一致）。 */
const PRESET_LABELS = Object.freeze({
  [MERGED_PRESET]: 'QQ 聊天（角色A · 只读档，已合并）',
});
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

/**
 * 控制台的 preset 参数校验：只接受本项目这两个预置名（缺省 = 二代）。
 *
 * 为什么必须在拼路径**之前**校验：main() 里的 resolvePresetName() 在「DSH preset 清单为空」
 * （DSH 还没连上 / 正在启动）时会把调用方给的字符串**原样返回**。那四个 preset 控制台路由
 * 都拿它去 path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml')，
 * 于是 `preset=..\..\..\x` 会读写/备份 <x>/agent.cordis.yml，越出仓库。
 * 返回 null 由调用方回 400。
 */
function knownPresetName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return PRESET_NAMES.v2;
  return Object.values(PRESET_NAMES).includes(name) ? name : null;
}

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

/**
 * DSH 当前可用的 preset id 列表（来自 `agentPresets/list`）。
 *
 * ⚠️ 必须是**模块级**变量。历史 bug：`presetStatus()` / `isPresetInstalledInDsh()`
 * 是模块级函数，却去读 `main()` 内部声明的 `dshPresetIds` —— 那是另一个作用域，
 * 运行时直接 `ReferenceError: dshPresetIds is not defined`，
 * 表现为控制台「仿真提示词」整个区域 500，而不是给出一条能看懂的报错。
 * 模块级声明后，刷新函数（在 main 内）写它、模块级函数读它，两边都成立。
 */
let dshPresetIds = [];

/**
 * 这个 preset 在 DSH 里**真正生效**了没。
 *
 * ⚠️ 别用 `.agent-presets/` 目录判断（那是 DSH 0.1.5 的旧机制，0.1.7 起 DSH
 * 完全不读它）。现在 preset 是 profile 里的一条 `@deepseek-ai/dsh-agent-preset`
 * 行，由 qq-agent-presets 这个 bundle 的 patch 插入。所以唯一可靠的判据是
 * **问 DSH 自己**：从 `agentPresets/list` 的结果里找这个 id。
 *
 * 拿不到清单（DSH 还没连上）时返回 null，表示"不知道"，不要谎报 false/true。
 */
function isPresetInstalledInDsh(name) {
  if (!Array.isArray(dshPresetIds) || dshPresetIds.length === 0) return null;
  return dshPresetIds.includes(name);
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  const installedInDsh = isPresetInstalledInDsh(name);
  return {
    preset: name,
    label: PRESET_LABELS[name] ?? 'QQ 聊天（角色A · 只读档，已合并）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    // 旧字段保留（控制台可能还在读），但要理解它只代表 0.1.5 的旧目录，
    // **不代表 preset 有没有装进 DSH**。真正该看的 `installedInDsh` 在下面。
    installed: fs.existsSync(installedPresetYaml(name)),
    // 真实状态：true=DSH 清单里有它；false=清单里没有；null=DSH 没连上，无法判断。
    installedInDsh,
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── DSH 端点自动跟随 ────────────────────────────────────────────────────────
//
// 桌面版 DSH 的 HTTP 端口**每次启动都由 Electron 重新分配**。config.json 里
// `dsh.baseUrl` 记的是上一次那个数值，所以 DSH 一重启它就过期，桥接的所有 RPC
// 全部打到一个没人监听的端口 → `dshReady` 恒为 false → 面板「读不到数据」。
//
// 这就是「同一个毛病反复出现、每次都得进 DSH 手动改一下」的机制：手改只是把
// **这一次**的值补对，下一次 DSH 重启照样漂。启动时自动探测一次并写回，
// 才能从根上去掉这个手工步骤。
//
// 探测思路（只认本机回环、只认真的像 DSH 的端口）：
//   1. 先试配置里的 baseUrl —— 它还有效就不要多余动作（最常见的顺利路径）；
//   2. 再试上次跟随成功记下的端口池；
//   3. 最后用 `netstat -ano` 让系统告诉我们哪些端口在监听，只对这些端口做指纹确认。
//      **不要逐端口扫**：实测 2000~20000 全扫要 4~7 秒，而 netstat 一次只要 25 毫秒。
// 写回失败不影响启动（只记日志）——探测到的新值仍然留在内存里本次生效。

/**
 * 列出本机回环地址上正在监听的端口。
 *
 * 用 `netstat -ano`：Windows 自带、无需权限，实测 25 毫秒返回。
 * 解析失败就返回空数组（调用方会退化到"只用配置值"，绝不阻塞启动）。
 */
function listListeningLoopbackPorts() {
  if (process.platform !== 'win32') return [];
  try {
    const res = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (res.error || res.status !== 0) return [];
    const ports = new Set();
    for (const line of String(res.stdout ?? '').split(/\r?\n/)) {
      // 形如：TCP    127.0.0.1:12126        0.0.0.0:0              LISTENING       5516
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/i);
      if (m) ports.add(Number(m[1]));
    }
    // 端口小的先试（DSH 落在低位段的可能性更高），结果稳定可复现。
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** 某个回环端口上是不是一个活着的 DSH。
 *
 * ⚠️ 只判「HTTP 200/401」是**不够的**：实测本机 4310 端口上的另一个服务
 * （看着像个二进制协议服务）对 `/` 直接回 200、对 `/api/status` 也回 200，
 * 于是按状态码扫会把它误认成 DSH —— 自动跟随就会把 baseUrl 指到一个根本没有
 * DSH API 的端口上，症状比原来更糟（面板照样读不到，且更难查）。
 *
 * 所以必须认**DSH 自己的指纹**。实测可靠的两条：
 *   · 未鉴权时 `GET /` 回 401，正文是纯文本
 *     `dsh web authentication required; reopen the URL printed by dsh web.`
 *   · `/api/*` 回 401 且正文是 `unauthorized`
 * 二者任一命中才算 DSH。正文只取前 512 字节，避免被大页面拖慢。
 */
async function probeDshPort(port, timeoutMs = 1200) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  const looksLikeDsh = async (path) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 只有 401 这个分支带识别正文；200 一律不认（4310 就是 200）。
      const status = res.status;
      let head = '';
      if (status === 401) head = (await res.text()).slice(0, 512);
      else await res.body?.cancel();
      if (status !== 401) return false;
      return /dsh web authentication required/i.test(head) || /^unauthorized\s*$/i.test(head.trim());
    } catch {
      return false;
    }
  };
  if (await looksLikeDsh('/')) return true;
  return looksLikeDsh('/api/status');
}

/**
 * 在给定端口集合里找出**第一个**真的是 DSH 的端口。
 *
 * 为什么要并发、又为什么要限流：
 *   · 顺序探有上界风险 —— 某个端口「接受连接但永不响应」时每次都要吃满 1.2s 超时，
 *     十几个这样的端口叠起来就是十几秒，而这段代码跑在掉线自愈路径上。
 *   · 全并发也不行 —— 一次开几十个 socket 探测，防火墙/系统资源都不喜欢。
 *   取折中：并发 8 路，命中即全员提前退出（hit 是共享的短路标记）。
 *
 * @returns {Promise<number>} 命中的端口；一个都没有则返回 0。
 */
async function firstDshPort(ports, concurrency = 8) {
  let cursor = 0;
  let hit = 0;
  const worker = async () => {
    for (;;) {
      if (hit) return;                       // 别人已经找到了，收工
      const i = cursor++;
      if (i >= ports.length) return;         // 队列空了，收工
      const port = ports[i];
      if (await probeDshPort(port)) { hit = port; return; }
    }
  };
  const n = Math.min(concurrency, ports.length);
  if (n <= 0) return 0;
  await Promise.all(Array.from({ length: n }, worker));
  return hit;
}

/**
 * 让 `cfg.dsh.baseUrl` 跟上 DSH 当前实际监听的端口。
 *
 * @param {object} cfg 配置对象（会被就地改写 dsh.baseUrl）
 * @param {object} [opts]
 * @param {number} [opts.port] 权威端口提示：调用方**确定**自己就是 DSH 时传进来
 *        （例如面板跑在 DSH 进程内，`req.socket.localPort` 就是它正在服务的端口）。
 *        有提示就先用指纹验一次，验过直接用 —— 不必去监听列表里猜。
 *        这消除了整条「扫端口」路径，是「点一下立刻连上」的关键。
 * @param {boolean} [opts.force] 跳过「配置值还能用就不动」的短路。
 * @returns {Promise<{changed: boolean, baseUrl: string, from?: string, reason: string}>}
 */
async function followDshEndpoint(cfg, opts = {}) {
  const configured = String(cfg?.dsh?.baseUrl || '').trim();
  const parsePort = (url) => {
    try { return Number(new URL(url).port) || 0; } catch { return 0; }
  };

  // ① 权威提示优先：调用方说「我就在这个端口上」，验一下指纹即可采纳。
  //    注意仍然要验证 —— 端口可以被别的进程抢占，盲信提示会把 baseUrl 指到错误的服务。
  const hintedPort = Number(opts.port) || 0;
  if (Number.isInteger(hintedPort) && hintedPort > 0 && await probeDshPort(hintedPort)) {
    return finish(hintedPort, 'hint');
  }

  // ② 配置里的地址还能用就什么都不做（不制造无谓的文件改写）。
  const configuredPort = parsePort(configured);
  if (!opts.force && configuredPort && await probeDshPort(configuredPort)) {
    return { changed: false, baseUrl: configured, reason: 'configured-alive' };
  }

  // 跳过 SnowLuma(3000/3001) 与本桥接控制台端口。
  const skip = new Set([3000, 3001, Number(cfg?.consolePort) || 3100]);

  /** 候选端口的基本过滤：不重复探配置值、不探已知的非 DSH 服务。 */
  const inRange = (p) => Number.isInteger(p) && p > 0 && p <= 65535
    && p !== configuredPort && !skip.has(p);

  // ③ 让操作系统告诉我们哪些端口在监听 —— 再只对这些端口做 DSH 指纹确认。
  //    ⚠️ 不要逐端口 TCP/HTTP 扫描：实测 2000~20000 全扫要 4~7 秒，
  //    而 `netstat -ano` 一次只要 **25 毫秒**（实测），拿到的还是精确的监听集合。
  //    本机同时在监听的端口通常只有十几个，并发确认指纹瞬间完成。
  //
  // ⚠️ 这里**刻意不做**「记住上次的端口再优先试」。
  //    桌面版 DSH 每次启动都重新分配端口（实测一天里见过 5306→9149→7167→4801…），
  //    上一次成功记录的端口下一次必然失效；先试它只会白等一个超时才回退，
  //    反而比直接查监听列表更慢。netstat 这条路已经是毫秒级，没有优化的必要。
  const listening = listListeningLoopbackPorts().filter(inRange);
  const found = await firstDshPort(listening);
  if (found) return finish(found, 'scan');

  return { changed: false, baseUrl: configured, from: configured, reason: 'not-found' };

  /** 采纳找到的端口：更新内存配置 + 写回 config.json + 记住它。 */
  function finish(port, reason = 'scan') {
    const nextUrl = `http://127.0.0.1:${port}`;
    if (nextUrl === configured) return { changed: false, baseUrl: configured, reason: 'already-current' };
    // 措辞区分来源：提示命中是「被明确告知」，扫描命中是「推导出来的」。
    // 两者在排错时的含义完全不同，日志里必须分得开。
    const how = reason === 'hint' ? '（由调用方提供端口提示）' : '';
    log(`[dsh] 配置里的 DSH 地址 ${configured || '(空)'} 已失效，自动跟随到 ${nextUrl}${how}`);
    cfg.dsh.baseUrl = nextUrl;

    // 写回 config.json（只替换 baseUrl 那一行的值，其余字节原样保留）。
    const configPath = String(process.env.QQ_BRIDGE_CONFIG || '').trim()
      ? path.resolve(String(process.env.QQ_BRIDGE_CONFIG).trim())
      : path.join(ROOT, 'config.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const patched = raw.replace(/("baseUrl"\s*:\s*")[^"]*(")/, `$1${nextUrl}$2`);
      if (patched !== raw) {
        fs.writeFileSync(configPath, patched, 'utf8');
        log(`[dsh] 已把新地址写回 ${path.basename(configPath)}`);
      }
    } catch (error) {
      // 写不进去也要继续跑：内存里的 cfg 已是新值，本次进程能用。
      log(`[dsh] ⚠️ 自动跟随已生效，但写回配置失败（下次启动可能仍要重新探测）：${error?.message ?? error}`);
    }
    // 不再记 dsh-port.json：桌面版 DSH 每次启动都换端口，上一次记下的值下一次必然失效，
    // 留着只会让「优先试旧端口」那条路径白等一个超时。端口发现改成直接读监听列表。
    return { changed: true, baseUrl: nextUrl, from: configured, reason: reason || 'scan' };
  }
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  // 配置路径：默认 ROOT/config.json。
  // 支持 QQ_BRIDGE_CONFIG 环境变量覆盖 —— 实测遇到过 config.json 被句柄锁死
  // （读/改/删/重命名全被拒，但同目录其他文件正常、ACL 也正常）的情况，
  // 没有这个逃生口就只能重启整机。指向一份可用副本即可继续跑。
  const override = String(process.env.QQ_BRIDGE_CONFIG || '').trim();
  const p = override ? path.resolve(override) : path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  if (override) log(`[config] 使用 QQ_BRIDGE_CONFIG 指定的配置：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat-agent',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    // 共用会话（默认关）。开启后：私聊与群共用一个 DSH 会话 + 一套记忆，
    // 但每轮唤醒包会写明【当前场景】，回复按 turn 归属路由，不会串号。
    // 权限取组内最低档（见 sharedPresetName），私聊会因此失去本地工具。
    sessionSharing: {
      ...SESSION_SHARING_DEFAULTS,
      ...(file.sessionSharing ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-agent',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        // 2026-11-10：fact 开关已删除 —— 长期事实并入 qq_memory_append(category='longTerm')，
        // 写入走 memory 开关，不再单独有 fact 闸门。
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
      },
      // 纯语音（文字 → 睦的声音）：她照常打字，桥接把文字合成语音再发。
      // 默认关闭。开关在控制台「运行概览 → 暂停/恢复」那一排。
      tts: { ...TTS_DEFAULTS },
      // ── 收尾前观望（mark_read / set_wake_config 的"空转"）───────────────
      // 三个值原来有两处是硬编码的 `?? 10000` 兜底，配置里根本没有声明，
      // 于是控制台看不到、也没法调。现在显式列出来。
      observeBeforeSleepMs: 10000,   // 没人说话时干等多久（没来消息就照常收尾）
      observeQuietMs: 5000,          // 来了消息后，等它安静多久再合并贴给她
      // 总时长硬上限。必须 < mcp-snowluma-safe.js 里 mark_read / wake-config 的
      // timeoutMs(25000)，否则工具会先被 AbortSignal 掐断，模型只看到「超时」。
      observeHardCapMs: 20000,
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        // 硬下限：她设的潜水时长不能短于这个值。
        // 默认保持 1 分钟 —— 具体数值由操作者在控制台「最小潜水（秒）」里改，
        // 这里只是**缺字段时的兜底**。（2026-11-11 曾误改成 600000，已还原：
        // 操作者明确要求这个值归他自己管，代码不要替他做主。）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      // ── 闲置压缩（上下文边界管理）──────────────────────────────────────────
      // 设计原则：**对话进行中绝不压缩**。压缩会改写历史前缀，前缀一变
      // provider 的 KV cache 就整段失效，之后每步都要重算全部历史。所以压缩
      // 只发生在「用户已经安静足够久、DSH 也没在跑」的边界上，且一轮对话
      // 最多压一次（idleCompactedAt 由下一条用户消息解锁）。
      compaction: {
        enabled: true,
        onlyPrivate: true,        // 只对私聊（owner）做；群聊上下文靠话题自然推进
        idleMs: 1800000,          // 30 分钟没有**用户**消息（模型自己的动作不重置计时）
        thresholdTokens: 300000,  // 上下文超过 30 万 token 才值得压（1M 窗口的 30%）
        checkIntervalMs: 60000,   // 每分钟扫一次
        // 2026-11-10：压缩前「记忆整理」投递已删除（summarize 开关随之失效）。
        // 旧行为是压缩前投递一次模型调用，让她把要点写进记忆库；现在长期记忆由她
        // 自己在聊天中用 qq_memory_append(category='longTerm') 写，压缩不再额外调模型。
        // 这个字段保留只为兼容旧 config.json，读代码时不要以为它还在生效。
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        // 同一会话**两次工具调用**之间至少隔多久（跨回合防砸屏）。
        //
        // ⚠️ 2026-11-15 澄清：这个值**不是**"数组内多条消息之间的间隔"
        // （那个由 burstIntervalMinMs/MaxMs/maxGapMs 管，上限 10 秒），
        // 也**不是**"发送后空转多久"（那个是下面的 observeAfterSendMs）。
        // 她一次调用发 3 条数组时，条与条之间只隔 1~3 秒，和这里无关。
        //
        // 注意：负责读它的 sendThrottleRemainMsV2 目前**没有调用方**（死代码），
        // 所以实际生效的只有发送后空转（用 observeAfterSendMs）。保留这个键是
        // 为了控制台面板还能看/改，以及以后要接回节流时不至于缺字段。
        minSendIntervalMs: 10000,
        // 发送后空转多久看对方接不接（2026-11-15 操作者定 30 秒）。
        //
        // 语义：`Σ(数组内间隔) + 这 30 秒`。间隔部分由 sendMessagesV2 真的 sleep 掉，
        // 所以这里只补 30 秒那一截。详细推演见 paceAfterSendV2 的注释。
        //
        // 20 → 30（2026-11-15 第二次调整）：操作者说"每次聊天得发很快才能卡在
        // 5 秒内"，说明等待窗口整体不够用。两处一起放宽：
        //   空转 20→30（没新消息时干等多久）
        //   安静窗 5→10（来了消息后等它安静多久，见下面的 observeQuietMs）
        observeAfterSendMs: 30000,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        // 发送后空转期间，**来了一条消息之后再等多久**才算对方说完。
        //
        // 语义：每来一条新消息就把计时器重置为这个值；安静满它才返回，
        // 把那几条合并成一次贴给她。所以操作者"两条消息间隔超过它就看不到"
        // 的观感是对的 —— 5 秒太紧（打字快一点就接不上），现在 10 秒。
        //
        // 上限：paceAfterSendV2 里 hardCapMs = observeAfterSendMs + 这个值
        // = 30 + 10 = 40 秒，这是单次发送工具调用的最长耗时。
        // MCP 侧 agentApi 是 300 秒、DSH toolCallTimeoutMs 是 725 秒，余量充足。
        observeQuietMs: 10000,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6500
      },
      // 操作者在控制台为单个会话预写的「初始提示词」的字数上限（只在首次唤醒时注入一次）。
      // 它不是安全边界，只是防止误粘贴一篇长文把首次唤醒的 prompt 撑爆。
      initialPromptMaxChars: 2000,
      // 图片/表情（含动图）的数量与体积上限。QQ 的动图表情常见 1~4MB，
      // 旧的 4MB 单条总上限会误伤；这里默认 8MB，仍受 DSH 的 20MB/64MP 限制约束。
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.files（发文件）与 tools 同理：外部配置**必须过归一化**再使用 ——
  // 体积/频率上限要收敛，扩展名白名单要清洗，否则 config.json 里一个手写的
  // `maxBytes: 1e12` 或 `allowExtensions: ["exe"]` 就等于把这道闸门关掉。
  // 内置的敏感路径/密钥黑名单在归一化里不可移除（那是底线，不是可配置项）。
  cfg.socialV2.files = normalizeSendFileConfig(cfg.socialV2.files);

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    // fact 开关已删除（见上面默认配置处的说明）。
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    // 发文件（qq_send_file）：只对 Owner 档（private:<ownerQQ>）生效，路由里有独立档位闸门；
    // 这里的开关是"要不要给管理员用这个工具"，默认开。详细边界见 socialV2.files。
    sendFile: true,
    // 查歌词（qq_get_lyrics）：纯 MCP 侧出网，不经过桥接路由，所以这里只是让控制台
    // 读数一致。真正生效的开关是 socialV2.lyrics.enabled。
    getLyrics: true,
    ...(cfg.socialV2.tools ?? {})
  };

  // ⚠️ 2026-11-12：`socialV2.voice`（语音库 / 固定语音发送）已整体删除。
  //   那是原作者做的一套功能，操作者不再使用 —— 现在用的是**纯语音 TTS**
  //   （她的话用 GPT-SoVITS 合成后发出），链路在 onebotSend / maybeSendAsVoice 里，
  //   直接生成 record 段，与本配置无关。
  //   同时删掉：qq_send_voice / qq_list_voices、voice-core.js、send-voice-lib.js、
  //   /api/socialV2/send-voice、/api/socialV2/voices、控制台语音库面板。
  //   保留：socialV2.tts（纯语音）与 socialV2.ffmpegPath（media-normalize 要用）。

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // socialV2.media：图片/表情的数量与体积上限。旧配置没有这一段，必须深度合并出默认值，
  // 否则 `{...defaults, ...file.socialV2}` 里缺失的 media 会取到 undefined（等于无上限判断）。
  cfg.socialV2.media = {
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 64_000_000,
    maxCount: 5,
    ...((cfg.socialV2?.media && typeof cfg.socialV2.media === 'object' && !Array.isArray(cfg.socialV2.media)) ? cfg.socialV2.media : {})
  };

  // socialV2.cards（B站分享卡片内联展开）：
  //   默认开、只认 B站。为什么默认开：卡片在群聊里很常见，而「[卡片消息]」四个字对
  //   她等于什么都没说——她只能装没看见，或者白花一步去调 web_fetch 抓一个短链。
  //   在桥接侧内联成 `[B站] 标题 · UP · 时长 · 播放` 之后，她零工具调用就能接话。
  //   详细取舍见 src/card-parse.js 文件头。
  // 注意：这里**必须**在建配置对象时就归一化，setCardConfig 内部也会兜一层，
  //   但配置是用户可直接编辑的，非法值不能变成运行期异常。
  cfg.socialV2.cards = setCardConfig(cfg.socialV2.cards);

  // socialV2.initialPromptMaxChars：会话「初始提示词」的字数上限。config.json 是用户可编辑的，
  // 手工写进字符串/负数/超大值时要收敛到安全区间，否则要么保存接口永远报"过长"，要么等于没上限。
  {
    const raw = Number(cfg.socialV2?.initialPromptMaxChars);
    cfg.socialV2.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
      ? Math.min(8000, Math.max(100, Math.round(raw)))
      : 2000;
  }

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// 冷启动登记表：**DSH sessionId → { newAt, compactedAt, consumedAt, at }**。
//
// 它回答的唯一问题：下一次唤醒要不要带那两句提示（记忆 / 人格卡）。
// 为什么按 DSH sessionId 而不是 QQ key：私聊和群可能共用同一个 DSH 会话，
// 而"上下文没了"是**会话级**的事实 —— 按 DSH 会话记，天然就是全组一份，
// 两个入口不可能各发一遍。
const coldStartRegistry = new Map();
// 正在压缩中的 DSH 会话（compaction/start 到 compaction/end 之间）。
// 用途只有一个：压缩期间如果正好有唤醒要渲染，那会儿历史上的"compress 完了"还没发生，
// 提示不该提前挂 —— 但也不能漏，所以结束时会再登记一次。这里只做日志与判重。
const compactionInFlight = new Map();
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 冷启动登记表：读写 ───────────────────────────────────────────────────────
//
// 落盘在 sessions.json 的 `coldStarts` 下（和 sessions 一样是"会话 ↔ DSH"的事实，
// 不属于 socialV2 的聊天状态）。丢一次的后果是"少提示一次"，所以读写都按尽力而为：
// 解析失败当空表，绝不阻断启动。
const COLD_START_KEEP = 200; // 只留最近 200 条；每次新会话/压缩都会产生一条，旧的没人读

function loadColdStarts() {
  coldStartRegistry.clear();
  const raw = state?.coldStarts;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const entries = Object.entries(raw)
    .filter(([sid, v]) => typeof sid === 'string' && v && typeof v === 'object')
    .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0));
  for (const [sid, v] of entries.slice(0, COLD_START_KEEP)) {
    coldStartRegistry.set(sid, {
      newAt: Number(v.newAt) || 0,
      compactedAt: Number(v.compactedAt) || 0,
      consumedAt: Number(v.consumedAt) || 0,
      at: Number(v.at) || 0
    });
  }
}

function saveColdStarts() {
  if (!stateWritable) return;
  const entries = [...coldStartRegistry.entries()]
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, COLD_START_KEEP);
  state.coldStarts = Object.fromEntries(entries);
  saveState();
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
// DSH 控制类调用（停任务/归档会话）的超时。这些 await 以前是裸的：DSH 接受了连接但
// 不返回响应时，HTTP handler 永不返回，控制台与群消息一起失去响应（issue #32）。
// 超时后走各自的 catch 记日志，最坏情况只是「这一次重置没做成」，而不是整体挂死。
const DSH_CONTROL_TIMEOUT_MS = 15000;
// `/compact` 这条不能跟控制类调用共用 15 秒：它要调一次模型生成摘要
// （maxTokens 8k），实测 15 秒必然超时，命令其实还在后台跑，桥接却已经判定失败。
// 这是「一次后台压缩」，用户不在等，给足 5 分钟；超时也只是这一次没压成。
const COMPACT_TIMEOUT_MS = 300000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      // QQ 把「表情包」也发射成 image 段，靠 picSubType 区分渲染方式：
      //   sub_type=0 → 普通图片（相册/截图/粘贴进来的图）
      //   sub_type=1 → 表情包（收藏表情、斗图用的那种）
      // 两者对读消息的模型意义完全不同：表情包是在表达情绪（该接梗、该反应），
      // 普通图片是在传递内容（该看图、该评论画面）。一律标 [图片] 会让她把
      // 别人甩来的表情包当成「一张图」去分析，那正好是人和机器最容易露馅的地方。
      // 判定逻辑统一在 media-kind.js，避免这里和 media 元数据/看图标注各说各话。
      case 'image': out.push(describeInlineImage(d)); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': {
        // 分享卡片（小程序 / 结构化分享）。以前一律渲染成「[卡片消息]」，对模型等于
        // 什么都没说；现在在**桥接侧**内联展开成一行摘要（见 src/card-parse.js），
        // 这样她零工具调用就知道群友转的是什么，既少一次往返、也不多占 schema。
        //
        // 三类路由（各自有开关），任何一层失败都不影响消息投递：
        //   · B站  → `[B站] 标题 · UP · 时长 · 播放 · BV号`（唯一出网的一类）
        //   · 音乐 → `[QQ音乐]/[网易云音乐] 曲名 · 歌手`（纯本地，零出网）
        //   · 其他 → `[平台] 标题 · 摘要`（纯本地）
        //   全关 / 认不出 / 解析异常 → 回到「[卡片消息]」。
        // 摘要里刻意**不放 URL**：模型拿到也只能转述，而一条链接比标题还长。
        // 同一条消息会调本函数两次（带引用版/纯文本版），summarizeCard 按原始 JSON
        // 做 memo，第二次不再出网。
        const rawCard = typeof d.data === 'string'
          ? d.data
          : (d.data && typeof d.data === 'object' ? JSON.stringify(d.data) : '');
        let cardLine = '';
        if (rawCard) {
          try { cardLine = await summarizeCard(rawCard); } catch { cardLine = ''; }
        }
        out.push(cardLine || '[卡片消息]');
        break;
      }
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
function sanitizeMediaSummary(value, max = 60) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? truncateText(s, max) : '';
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      const subType = (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '';
      const emojiIdRaw = String(d.emoji_id ?? d.emojiId ?? '').trim();
      // 和上面 segmentsToText 用同一套判定（media-kind.js），保证
      // 「文本标注」和「media 元数据」不会各说各话。
      const stickerLike = isStickerLike(d);
      media.push({
        // ⚠️ `kind` 保持 'image' 不变：它表达的是**段类型**，下游
        // collectStickerV2 就是靠 `kind === 'image'` 决定走 fetchOneBotImage 取字节的，
        // 改成 'sticker' 会让「偷图」功能直接报「无法获取该表情的图片源」。
        // 语义分类另开字段（isSticker），两者不要混用。
        kind: 'image',
        segmentType: 'image',
        isSticker: stickerLike,
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType,
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

// ── 共用会话（sessionSharing）────────────────────────────────────────────────
//
// 需求原话：私聊与群聊「用一样的 selfNote 和记忆」，但两个场景各自知道自己是谁在跟谁说话，
// 回复也不能串到别的聊天里。
//
// 做法：把**一个 DSH 会话**同时挂在多个 QQ key 上（两个 key 共享同一个 sessionId），
// 记忆层也按 owner 共享一份；每轮唤醒包显式写明【当前场景】，发言靠 qq_send_message 的
// key 参数落到各自的聊天里 —— 所以"不串"靠的是工具参数，不是靠会话隔离。
//
// ⚠️ 权限必须取**最低档**：一个 DSH 会话只有一个 preset。私聊（owner 档，能读写本机）
// 与群聊（readonly 档）共用一个会话时，只能挂 readonly —— 否则群里任何人都能诱导
// 她读写本机文件。开启本功能即等于私聊也放弃本地工具，这是刻意的取舍，不是缺陷。
//
// 配置（config.json 的 sessionSharing）：
//   { "enabled": true,
//     "groups": { "private:10001": "group:20001" } }   // 私聊 key -> 归属群 key
// 私聊 key 的会话、记忆、长期事实全部改用群 key 的那一份；只影响"存到哪"，不影响发到哪。
const SESSION_SHARING_DEFAULTS = Object.freeze({
  enabled: false,
  groups: {},
  // 共用会话跑哪个 preset。留空 = 用共用组里**最低档**的 preset（readonly < v2 < owner）。
  preset: '',
});

/**
 * 把 QQ key 归一成「共享组内的代表 key」（owner key）。
 *
 * 没有开启共享、或这个 key 不属于任何共享组时，原样返回 —— 全部旧行为不变。
 * 代表 key 统一取组内那个 group: 的 key；组里没有 group 时取字典序最小的那个，
 * 保证同一个组无论从哪个成员发起都落到同一个 key 上（否则事实库会分裂成两份）。
 */
function sharedOwnerKeyOf(cfg, key) {
  const sharing = cfg?.sessionSharing;
  if (!sharing || sharing.enabled !== true) return key;
  const canonical = canonicalV2Key(key);
  if (!canonical) return key;
  const groups = sharing.groups && typeof sharing.groups === 'object' ? sharing.groups : {};
  // ⚠️ 方向不能反。本函数的契约（见上方注释）是 **私聊 key → 归属群 key**，
  // 也就是 `{ "private:10001": "group:20001" }` 里 **key 是私聊、value 是群**。
  //
  // 这里曾经把 key 当 leader、value 当 member 来遍历（那是 shareGroupOf 的视角），
  // 结果 `private:10001` 找不到自己所属的组、被原样返回 —— 于是"共用记忆"只在
  // **会话层**成立了（ensureSession 走的是另一条路），记忆层却各自存一份：
  // 私聊写的 selfNote 在群里读不到。实测踩过，表现就是"说好共用的记忆没共用"。
  //
  // 两种写法都要能认：既支持 { private: 群 } 的箭头形式，也支持 { 群: [私聊...] }
  // 的成员列表形式（老配置与未来的多人群组）。
  for (const [leaderRaw, memberRaw] of Object.entries(groups)) {
    const leader = canonicalV2Key(leaderRaw) || String(leaderRaw);
    const members = Array.isArray(memberRaw) ? memberRaw : [memberRaw];
    const pool = [leader, ...members.map((m) => canonicalV2Key(m) || String(m))];
    if (!pool.includes(canonical)) continue;
    // 组内代表 key：优先 group:，其次字典序最小 —— 必须是**组内容的纯函数**，
    // 不能依赖"谁先说话"，否则重启顺序一变事实库就换文件了。
    const groupsInPool = pool.filter((k) => k.startsWith('group:')).sort();
    return groupsInPool[0] ?? [...pool].sort()[0];
  }
  // 箭头形式兜底：canonical 本身是某个键、其 value 指向另一个 key，则代表取那个 group。
  // （上面那轮已经覆盖了这种形状，这里保留是为了让"私聊指向群但群不在同一项"的
  //  分散写法也能合并，例如 { private:A: 'group:G', private:B: 'group:G' }。）
  const targets = new Set();
  for (const [fromRaw, toRaw] of Object.entries(groups)) {
    const from = canonicalV2Key(fromRaw) || String(fromRaw);
    if (from !== canonical) continue;
    const to = canonicalV2Key(toRaw) || String(toRaw);
    if (to) targets.add(to);
  }
  if (targets.size) {
    const asGroups = [...targets].filter((k) => k.startsWith('group:')).sort();
    return asGroups[0] ?? [...targets].sort()[0];
  }
  return key;
}


// ── 三档权限分级：会话 → preset（2026-10-26） ────────────────────────────────
//
// 档位与 preset 的对应（preset 源在 dsh/agent-presets/<preset>/agent.cordis.yml）：
//   ownerQQ 私聊             → qq-chat-owner    全工具（读写文件 + 执行命令）
//   allow 白名单（群 / 私聊）→ qq-chat-readonly 只读（read / read_image / glob / grep）
//   其它（陌生私聊、未收录群）→ 配置的聊天 preset（默认 qq-chat-v2）仅聊天，无本地工具
//   deny 黑名单              → 连消息都不入库（见 modeAllowed 与事件分发入口），轮不到选 preset
//
// ⚠️ owner 优先于白名单：同一账号同时出现在 ownerQQ 与 allow 里时按 owner 处理
//   （用户明确要求）。config.json 的默认形态就是这样——ownerQQ 通常也在 allow.private 里。
// ⚠️ 2026-11-07 合并后两档指向同一个 preset：不再有 owner 全工具档。
//   保留这两个键是为了让 shareGroupOf / sharedPresetName 那套「取最低权限档」的
//   逻辑继续成立（现在它们恒等，等价于"没有分级"）。
const TIER_PRESETS = Object.freeze({
  OWNER: 'qq-chat-agent',
  READONLY: 'qq-chat-agent',
});

/**
 * 「明确列在白名单里」—— 与 {@link allowed} 的区别是**不要 allowAllWhenEmpty 兜底**。
 *
 * 为什么分级必须用这个而不是 allowed()：allowAllWhenEmpty=true（且该 kind 的白名单为空）
 * 时 allowed() 对陌生私聊/群也返回 true，那是"允许聊天"的宽松默认，不是"允许读本机
 * 文件"的授权。拿 allowed() 判只读档会把放行陌生人的配置顺手升级成"陌生人可读文件"。
 */
function isAllowListed(kind, id, cfg) {
  if (isDenied(kind, id, cfg)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  return allowList.map(String).includes(String(id));
}

/** 是否在 deny（黑名单）里。deny 优先于一切：连 ownerQQ 也挡得住（见 modeAllowed 的注释）。 */
function isDenied(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  return denyList.map(String).includes(s);
}

/**
 * 会话的权限档位：'owner' | 'readonly' | ''（'' = 仅聊天）。
 *
 * 纯函数，只看 key / mode / cfg。closed-agent 不参与分级（那个模式只放行 owner 私聊，
 * 走 closedAgentPreset / DSH 默认 preset 的既有路径）。
 *
 * deny 在 owner 之前判定：正常路径下 deny 会话根本不会走到建会话（modeAllowed 先拒），
 * 但档位判定保持 fail-safe —— 万一哪条路径漏了准入检查，也不会给黑名单里的人发全工具。
 */
function sessionTier(key, mode, cfg) {
  if (mode === 'closed-agent') return '';
  const canonical = canonicalV2Key(key);
  if (!canonical) return '';
  const kind = canonical.slice(0, canonical.indexOf(':'));
  const id = canonical.slice(canonical.indexOf(':') + 1);
  if (isDenied(kind, id, cfg)) return '';
  // owner 判定必须是 private + ownerQQ 精确匹配：群聊里有人 QQ 号等于 ownerQQ 不升档。
  if (kind === 'private' && cfg?.ownerQQ !== null && cfg?.ownerQQ !== undefined
    && String(cfg.ownerQQ) !== '' && id === String(cfg.ownerQQ)) {
    return 'owner';
  }
  return isAllowListed(kind, id, cfg) ? 'readonly' : '';
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();
  // 冷启动登记表跟着 sessions.json 一起读回：重启后"新会话/刚压缩过"的判定不能失忆。
  loadColdStarts();
  // ── 自动跟上 DSH 的实际端口 ────────────────────────────────────────────
  // 桌面版 DSH 每次启动都由 Electron 重新分配端口（历史备份里见过
  // 2113/3632/5412/6694/9509/10613/14061/14851…），而 config.json 里存的是**上一次**
  // 那个数值。DSH 一重启，baseUrl 就指到一个没人监听的端口 —— 桥接所有 RPC 全挂、
  // `dshReady` 永远是 false，QQ 大肥鱼面板就显示「读不到数据」。
  // 这就是「同一个毛病反复出现、每次都要进 DSH 改一下」的真正原因：
  // 手动改 baseUrl 只修好这一次，下次 DSH 重启又漂了。
  // 启动时自动探测一次并写回，从结构上消掉这个手工步骤。
  await followDshEndpoint(cfg);


  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // ── 读接口的 HTTP 兜底：WS 挂了不等于网关挂了 ──────────────────────────────
  //
  // 为什么要有：`fetch_custom_face_detail` 原来只走 SnowLuma 的 WS action，于是
  // 「WS 正在重连」这段时间里表情库同步必然失败。日志实测 33 次同步里 16 次失败（≈48%），
  // 全是 `SnowLuma WebSocket closed before opening`；表现就是操作者说的
  // 「有时读群友的表情包会失败」——库里没有新收藏 ⇒ qq_get_sticker_image 直接报「找不到表情」。
  //
  // 而**同一个网关的 HTTP 口一直是可用的**（onebotSend 发消息、fetch_ptt_text 转写都直接用它）。
  // 读接口没有理由单点依赖 WS。这里只在 WS 失败时兜底，不改变正常路径的延迟。
  async function onebotHttpAction(action, params = {}, { timeoutMs = 15000 } = {}) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error(`OneBot HTTP ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body;
  }

  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false, { preferHttp = false } = {}) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      let response;
      let via = 'ws';
      try {
        // 2026-11-15：preferHttp 时跳过 WS。SnowLuma 的 WS 侧收藏表情列表
        // **不跟随删除刷新**（实测删完 WS 仍返回旧列表），而删除后必须看真值，
        // 否则界面永远显示"删不掉"。
        if (preferHttp) throw new Error('preferHttp=true，跳过 WS 直接走 HTTP');
        response = await bot.request('fetch_custom_face_detail', { count });
        if (!response || response.status !== 'ok' || response.retcode !== 0) {
          throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
        }
      } catch (wsError) {
        // WS 失败 ⇒ 立刻用 HTTP 再问一次同一个 action（语义相同，token 可能不同但同一账号）。
        log(`[sticker] WS 同步不可用（${wsError?.message ?? wsError}），改走 OneBot HTTP 兜底`);
        response = await onebotHttpAction('fetch_custom_face_detail', { count });
        via = 'http';
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条，via ${via}）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false, via };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const resolved = resolveSticker(synced?.entries ?? stickerEntries, stickerId);
    if (resolved.entry) return resolved.entry;
    // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
    const forced = await syncStickerLibrary(true);
    const resolved2 = resolveSticker(forced?.entries ?? stickerEntries, stickerId);
    if (!resolved2.entry) throw new Error(resolved2.error || `找不到表情 ${stickerId}`);
    return resolved2.entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站文件（语音/文件）的名称审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（音频与文件的正文本身无法审计，但文件名同样会泄露路径与项目信息）。
   * 注意 Subject 只传 basename，所以 full 档也不会因为路径形态误伤（审计的是名字）。
   */
  function assertOutboundAuditOk(key, subject) {
    const audit = auditOutbound(subject, { level: auditLevelFor(key), knownTokens: KNOWN_AGENT_TOKENS });
    if (audit.blocked) {
      log(`⚠️ 文件/语音发送被安全策略拦截 (${key})：文件名疑似含${audit.reason}`);
      appendActivity(`${key} [file] 发送被拦截（文件名疑似含${audit.reason}）`);
      throw new Error(`文件名疑似包含${audit.reason}，已阻止发送；请重命名后再发`);
    }
  }

  // ── 发文件（AI 通道，**仅 Owner 档**：private:<ownerQQ>） ─────────────────────
  //
  // 为什么只给 Owner 档，而且闸门放在**服务端**：
  //   · 这是唯一一个"把本机文件主动送出去"的工具。群聊/白名单会话一旦拥有它，
  //     任何群友（或一段被读取的文本）都能诱导 AI 外发本机文件；
  //   · MCP 工具在 DSH 里是**进程级注册**的，schema 对所有会话可见 —— 桥接无法按会话
  //     隐藏它。所以真正的门必须在路由层：sessionTier() !== 'owner' 一律 403。
  //   · 路径安全（扩展名白名单 / 敏感路径黑名单 / 体积 / 普通文件）全部在
  //     src/send-file-lib.js 里，纯函数、可单测，见 scripts/test-send-file.mjs。
  const fileSendTimes = new Map();

  /** 发文件配置（每次读都过归一化：控制台改完立即生效，越界/脏值进不来）。 */
  function fileCfg() {
    return normalizeSendFileConfig(cfg.socialV2?.files);
  }

  /** 发文件限流：与文本/语音分开计数。只检查，真正发出后才记账（失败不吃额度）。 */
  function fileBudgetCheck(scopeKey, fc) {
    const now = Date.now();
    const bucket = fileSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000).length;
    const inHour = bucket.filter((t) => now - t < 3600000).length;
    if (fc.maxPerMinute > 0 && inMinute + 1 > fc.maxPerMinute) {
      throw new Error(`发文件频率超限（每分钟最多 ${fc.maxPerMinute} 个），请稍后再试`);
    }
    if (fc.maxPerHour > 0 && inHour + 1 > fc.maxPerHour) {
      throw new Error(`发文件频率超限（每小时最多 ${fc.maxPerHour} 个），请稍后再试`);
    }
  }

  function fileBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (fileSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    fileSendTimes.set(scopeKey, bucket);
  }

  /**
   * 解析并校验要发送的文件（唯一的路径闸门）。
   * 出错信息里只给 basename / 类型提示，**不回显别的本机路径** —— 这条错误会经 MCP
   * 回到模型上下文，而模型面对的内容可能是别人注入的。
   */
  function resolveSendFilePathForV2(input) {
    const fc = fileCfg();
    if (!fc.enabled) throw new Error('发文件功能已关闭（socialV2.files.enabled=false）');
    const checked = checkSendFilePath(input, {
      cfg: fc,
      realpath: (p) => fs.realpathSync(p),
      stat: (p) => fs.statSync(p),
      exists: (p) => fs.existsSync(p),
    });
    if (!checked.ok) throw new Error(checked.error);
    return { ...checked, cfg: fc };
  }

  /**
   * 底层发送：按会话类型调 OneBot 的 upload_private_file / upload_group_file。
   * 返回的 file_id 是"网关真的收下了这个文件"的证据（QQ 侧的文件消息靠它）。
   */
  async function sendFileV2(key, fileRef, { guard = false, audit = true } = {}) {
    const { path: sendPath, name, size } = resolveSendFilePathForV2(fileRef);
    if (audit) assertOutboundAuditOk(key, `[文件:${name}]`);

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = String(key).split(':');
    const action = kind === 'group' ? 'upload_group_file' : 'upload_private_file';
    const params = kind === 'group'
      ? { group_id: Number(id), file: sendPath, name }
      : { user_id: Number(id), file: sendPath, name };

    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 文件要过一遍上传（大文件更慢），给 120s 预算；与文本/语音/图片共用 sendChain，
        // 所以文件传完之前后面的文本会自然排队，不会出现"消息先于文件到达"。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(120000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data ?? {});
      } catch (error) {
        rejectSend(error);
      }
    });
    const data = await sendPromise;
    return { fileId: data?.file_id ? String(data.file_id) : null, name, bytes: size };
  }

  /** 把「我发了个文件」写进二代会话的 recentMessages（AI 自己知道自己发过什么）。 */
  function recordFileSentV2(key, sent) {
    try {
      const st = getSocialV2State(key);
      const kb = Math.max(1, Math.round(sent.bytes / 1024));
      const display = `[文件 ${sent.name}（${kb} KB）]`;
      const entry = {
        messageId: sent.fileId ? String(sent.fileId) : null,
        sender: '我',
        text: display,
        plain: display,
        quoteTargetIsSelf: false,
        isOwner: true,
        isSelf: true,
        at: Date.now()
      };
      st.recentMessages.push(entry);
      if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
      st.lastAiReplyAt = entry.at;
      st.lastActionAt = entry.at;
      st.wakeConfig.noActionCount = 0;
      saveSocialV2State();
    } catch (error) {
      log(`⚠️ 记录已发文件失败（${key}）：${error?.message ?? error}`);
    }
  }

  // 发送一个收藏表情（按 id/md5/url，或与备注完全一致的文字解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const resolved = resolveSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!resolved.entry) throw new Error(resolved.error || `找不到表情 ${stickerRef}`);
    const entry = resolved.entry;
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
    }
    // ── 必须以「表情」而不是「图片」发出：sub_type=1 ─────────────────────────
    //
    // QQ 的图片段靠 picSubType 区分渲染方式：0 = 普通图片（撑满气泡宽度），
    // 1 = 表情（按表情尺寸显示、可被当成斗图表情）。历史上这里只发 file，
    // 不带 sub_type ⇒ 网关按 0 上传 ⇒ 原本在客户端里小巧的收藏表情被拉成一大张图。
    //
    // 这不是猜的：SnowLuma 自己的 `send_custom_face` action（index.mjs 里
    // `{ type: 'image', data: { file: face.url, sub_type: 1, summary: '[动画表情]' } }`）
    // 就是靠 sub_type=1 实现「保留表情显示样式」；网关侧 uploadImageMsgInfo 把
    // 它写进 bizType / extData.subType（群聊）或 NotOnlineImagePbReserve（私聊）。
    //
    // summary 一并发：它是 QQ 客户端对这条消息的文本占位（[动画表情]），
    // 不发的话部分版本会回落到 [图片]。
    segments.push({
      type: 'image',
      data: {
        file: 'base64://' + image.buffer.toString('base64'),
        sub_type: 1,
        summary: '[动画表情]'
      }
    });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const resolved = resolveSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!resolved.entry) throw new Error(resolved.error || `找不到表情 ${stickerId}`);
    const entry = resolved.entry;
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    // 删除后用 HTTP 重新同步：WS 侧的列表是旧的，用它判断"删没删掉"永远为否。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }


  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  // 共用组的「已排唤醒」登记（2026-11-13）。
  // 键是组代表 key（sharedOwnerKeyOf）；成员排唤醒时加入，定时器触发/被取消时删除。
  // 目的：私聊与群共用同一个 DSH 会话时，不要让两边各排一次唤醒（那会变成两个 turn）。
  const groupHasPendingWake = new Set();
  const groupPendingReason = new Map(); // 组代表 key -> 当前待发唤醒原因

  /**
   * 清掉「组内已排唤醒」的登记。
   * 任何取消 pendingWakeTimer 的地方都必须调它 —— 否则那个组会被永久挡住，
   * 之后组内所有人说话都排不出唤醒（比重复发更严重）。
   */
  function clearGroupPendingWake(key) {
    try {
      const pool = shareGroupOf(key);
      if (pool.length <= 1) return;
      const owner = sharedOwnerKeyOf(cfg, key);
      const gk = canonicalV2Key(owner) || owner;
      groupHasPendingWake.delete(gk);
      groupPendingReason.delete(gk);
    } catch { /* 拿不到组就忽略 */ }
  }
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  /**
   * 回合判忙租约：只要 `turn/start` 的结束信号（turn/end）丢了，会话就会**永久**判忙，
   * 之后所有唤醒只进 pendingWakeReasons、QQ 上表现为「它不理我了」，只能重启（issue #11/#23/#26/#19）。
   * 正常回合 1~3 分钟，最长工具调用（DSH 的 toolCallTimeoutMs）≈12 分钟，15 分钟足以覆盖任何
   * **还活着**的回合。过期只是不再判忙：collector 本身保留，真回复照常 flush，只是允许新唤醒排队。
   */
  const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
  const turnLeaseNoted = new Set(); // 租约过期的日志去重（每个 session 只记一次）
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  // qq_report_feedback 的限频时间戳：key -> [timestamp]。上限 100 条/key（见下方写回处）。
  // ⚠️ 这行曾经缺失：forgetConversationCaches() 与反馈接口都在用它，但声明被删了，
  //    于是每次会话退役都抛 `ReferenceError: feedbackTimes is not defined`，
  //    retireSession 直接中断 —— 表现为旧会话退役不掉、reconcileSessionPolicies 反复重试。
  const feedbackTimes = new Map();
  const reverse = new Map(); // sessionId -> conv key（主 key；共用会话时是组内代表 key）
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 共用会话：一个 sessionId 可能同时挂在多个 QQ key 上（私聊 + 群）。
  // reverse 只能记住一个，所以回复路由改为看「这一轮是谁投递的」——见 turnKeyQueue。
  const keysForSession = new Map(); // sessionId -> Set<key>
  for (const [key, sessionId] of Object.entries(state.sessions)) {
    if (!keysForSession.has(sessionId)) keysForSession.set(sessionId, new Set());
    keysForSession.get(sessionId).add(key);
  }
  // sessionId -> [key]：按投递顺序记下"第 N 个 prompt 是替哪个聊天发的"。
  // turn 结束时 shift 掉一个，回复就发回它自己的聊天 —— 共用会话下这是唯一可靠的路由依据，
  // 因为 reverse 在共用时是共享的，单看 sessionId 已经分不出私聊还是群。
  const turnKeyQueue = new Map();
  function pushTurnKey(sessionId, key) {
    if (!sessionId || !key) return;
    const arr = turnKeyQueue.get(sessionId) ?? [];
    arr.push(key);
    turnKeyQueue.set(sessionId, arr);
  }
  function shiftTurnKey(sessionId) {
    const arr = turnKeyQueue.get(sessionId);
    if (!arr || arr.length === 0) return null;
    const key = arr.shift();
    if (arr.length === 0) turnKeyQueue.delete(sessionId);
    return key;
  }
  const turnKeyLatch = new Map(); // sessionId -> key：本轮归属锁存，turn/start 时定，turn/end 时清
  // 黑话学习会话的三件套。黑话学习功能（slang-learner.js / qq_slang_* 工具）已下线，
  // 但事件流分支里仍在读它们 —— 删功能时只删了定义、留下了使用处，
  // 结果是每次收到 session/event 都抛 ReferenceError，pumpMux 整条流崩掉、3 秒循环重连
  //（现象：AI 完全不回消息、日志刷 "事件流中断: learnerSessions is not defined"）。
  // 保留空集合：学习会话永远不会成立（没人往里塞 id），这些分支就是纯粹的 no-op，
  // 既不会误吞正常回合，也不会再抛。
  const learnerSessions = new Set();
  const learnerCollectors = new Map();
  const learnerWaiters = new Map();

  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  // 串行投递队列。**按会话串行，不是按 QQ key**：共用会话时私聊与群用的是同一条 DSH 会话，
  // 若两个 key 各自并发投递，两轮会交错，回复必然串号。所以队列键统一取 sharedOwnerKeyOf。
  const promptQueues = new Map(); // queueKey -> { queue: [], running: false }
  const queueKeyOf = (key) => {
    const owner = sharedOwnerKeyOf(cfg, key);
    return canonicalV2Key(owner) || owner;
  };
  // ── 记忆归属 ─────────────────────────────────────────────────────────────
  //
  // 2026-11-10 操作者定稿（照这个来，别再改回按共用组）：
  //   · **全局**（所有会话共用一份）：
  //       memberImpression —— 对某个人的印象，按 **QQ 号** 记（不按昵称：
  //                           同一个人换群名片/改昵称不会变成两条）。
  //       selfNote         —— 她对自己的认识，全局就一份。
  //       longTerm(facts)  —— 长期事实，全局一份。
  //   · **按会话**（各聊各的，会串味）：
  //       activeTopic      —— 这会儿在聊什么。
  //       pendingThought   —— 想对这个人说还没说的话。
  //
  // 为什么不再按「共用组」算：组只解决"私聊+某个群共用"，但同一个群友可能出现在
  // 好几个群里，按组记仍然会一人多条。按 QQ 号 + 全局存储才是真正的一份。
  //
  // 老数据是按 key 存的（且 sender 里有「私聊」这种非人名），
  // 迁移脚本见 scripts/migrate-global-memory.mjs。

  /** 全局记忆的存储 key（facts 库的文件名靠它）。 */
  const GLOBAL_MEMORY_KEY = 'global';

  // todo（待办）的常量必须定义在所有使用点之前 —— loadSocialV2State 在文件后面
  // 就要用到 TODO_MAX，而 JS 的 const 有 TDZ：定义在使用之后会直接 ReferenceError。
  /** todo 默认有效期：48 小时。一两天后还没兑现的事，基本也就不用记了。 */
  const TODO_DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;
  /** todo 上限：待办堆太多就变成噪音，留 20 条够用。 */
  const TODO_MAX = 20;

  /**
   * 全局记忆（长期三类 + todo）的存储。
   *
   * 2026-11-10 操作者定稿：
   *   memberImpression / selfNote / longTerm 是**全局一份**，跟会话无关；
   *   activeTopic / pendingThought 仍然按会话存（各聊各的，会串味）。
   *
   * 2026-11-12 新增 todo（待办）：
   *   「明天再讲那张卡片」「六点十分提醒他拿快递」这类**一两天内要兑现**的事，
   *   既不是长期事实（几个月后不成立），也不是 pendingThought（那是"想说没说出口的话"，
   *   不是"要做的事"）。实测她就把它塞进 longTerm 了 —— 长期记忆被短期事项污染。
   *
   *   todo 也放全局：事情本身不按聊天分（私聊提到的快递，群里也该知道），
   *   但**必须带到期时间**，到期自动消失 —— 这是它和 longTerm 的根本区别。
   *
   * 为什么单独一个对象而不是塞进 conversations['global']：
   *   conversations 的每个 key 都会被当成"一个 QQ 聊天"去遍历（唤醒调度、未读队列、
   *   定时器、token 轮换、白名单校验…），而且 getSocialV2State 只接受 `group:|private:`
   *   格式。塞一个 'global' 进去会在十几处遍历里炸掉或产生假的"会话"。
   *   这里照 affinities 的先例：顶层单独一块，活过「清上下文 / 重置」。
   */
  const globalMemory = {
    // 只放"长期三类"里靠 social-v2.json 存的两类；facts 走独立的 jsonl 文件。
    memberImpressions: {},
    selfNotes: [],
    // 待办：一两天内要兑现的事。结构见 appendMemoryV2 的 todo 分支。
    todos: [],
    // 下面这几个是给 appendMemoryV2 / formatMemoryV2 复用的空容器：
    // 它们会顺手清理 activeTopics / pendingThoughts，全局存储里不该有这两类，
    // 给空数组既能满足形状，也保证"全局永远不会有进行中话题"。
    activeTopics: [],
    pendingThoughts: [],
    // 形如会话状态的最小字段：不是会话，但被当成状态对象传进通用函数时不该炸。
    key: GLOBAL_MEMORY_KEY
  };

  /** 读写全局记忆对象（长期三类 + todo）。 */
  const globalMemoryOf = () => globalMemory;

  /** 某一类记忆该落在哪个 key 上：长期三类 + todo → 全局；短期两类 → 会话自己。 */
  const memoryKeyFor = (category, key) => {
    const canonical = canonicalV2Key(key) || key;
    if (category === 'selfNote' || category === 'memberImpression'
      || category === 'longTerm' || category === 'todo') {
      return GLOBAL_MEMORY_KEY;
    }
    return canonical;
  };

  /**
   * 长期记忆的归属 key（facts 库用）。
   * 保留这个函数名是因为它在多处被调用（facts 注入、差集、控制台查询…），
   * 语义统一成「长期记忆一律全局」。
   * ⚠️ 只用于**记忆**，不能用来取会话运行时状态。
   */
  const memoryKeyOf = () => GLOBAL_MEMORY_KEY;

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // 恢复出来的回合也必须带起始时间，否则租约对它无从生效 —— 这正是
    // 「DSH 重启后忙标记永不复位」的那条路径（issue #19）。不知道真实起点时按现在算：
    // 活着的回合会在 turn/end 清掉；真丢了的回合最多再忙一个租约期就自动解除。
    if (!v2TurnStartAt.has(sessionId)) v2TurnStartAt.set(sessionId, Date.now());
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  // 上次「DSH 掉线后重新跟随端口」的时刻（毫秒）。见 checkDsh 里的冷却说明。
  let lastDshFollowAt = 0;
  // ── 事件流退避睡眠的「提前叫醒」开关 ───────────────────────────────────────
  // pumpMux 在「连上但 0 帧」时会指数退避（3s → 30s）。端口刚对齐完那一刻，
  // 它多半正睡在退避窗口里，于是表现成「端口明明对了，事件流还要再等半分钟」。
  // 这里存一个 resolver：任何知道「DSH 现在重新可用了」的地方调 wakeMuxPump()
  // 就能把它从 sleep 里立刻叫起来，用新端口重连。
  let muxWake = null;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  // dshPresetIds 已提升为**模块级**变量（见 presetStatus 上方的说明）：
  // 模块级的 presetStatus() / isPresetInstalledInDsh() 要读它，声明在这里会变成
  // 另一个作用域，运行时抛 ReferenceError。这里不再重复声明。
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同内容不重复入队。
  //
  // ⚠️ 去重键必须带 wakeReason：唤醒类投递的 promptText 是空串（渲染挪到了
  // deliverPromptNow，见 §冷启动引导），只比文本会把"两次不同的唤醒"当成同一条。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    const wakeReason = String(opts.wakeReason ?? '');
    if (!items.some((it) => it.promptText === promptText && String(it.wakeReason ?? '') === wakeReason)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      const defaultPreset = settingFromDshNamespace(presetNs, 'default');
      if (typeof defaultPreset === 'string' && defaultPreset) {
        dshDefaultPreset = defaultPreset;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      // 读取必须 user 层优先：DSH 0.2.0-rc.2 写完 settings 后同进程内 value 不更新，
      // 只读 value 会让控制台切的模式被 5 秒轮询改回去（issue #22）。
      const fromDsh = normalizeModeInput(settingFromDshNamespace(ns, 'mode'));
      if (fromDsh) {
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；**留空表示不覆盖 config.json**
        // （见 plugins/qq-mode-console 的 schema 描述）。这里必须显式判断空串：
        // normalizeOwnerQQ('') 返回 null，若照旧 `!== undefined` 就直接赋值，
        // 设置页每次轮询都会把 config.json 里的 ownerQQ 抹成 null —— 而 5 秒一次的
        // refreshMode 会让它「几秒后必然发生」，后果是 closed-agent 谁都不放行、
        // 审批/提问永远等不到管理员回答。
        const rawOwnerValue = settingFromDshNamespace(ns, 'ownerQQ');
        if (rawOwnerValue !== undefined) {
          const rawOwner = String(rawOwnerValue ?? '').trim();
          if (rawOwner) {
            try {
              cfg.ownerQQ = normalizeOwnerQQ(rawOwner);
            } catch (error) {
              log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
            }
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /**
   * 会话**应当**使用的 preset 名（未解析、未校验；诊断信息与 modePreset 共用）。
   *
   * 三档分级优先，其次才是「配置里写死的聊天 preset」：
   *   ownerQQ 私聊 → qq-chat-owner；显式白名单 → qq-chat-readonly；其余 → 配置值。
   * 用 sessionTier()（= 显式白名单）而不是 allowed()，理由见 isAllowListed 的注释。
   */
  function wantedPresetName(key, mode, cfg) {
    if (mode === 'closed-agent') return closedAgentPreset || '';
    const tier = sessionTier(key, mode, cfg);
    if (tier === 'owner') return TIER_PRESETS.OWNER;
    if (tier === 'readonly') return TIER_PRESETS.READONLY;
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    return mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
  }

  /**
   * 共用会话的 preset：组内**最低权限**那一档。
   *
   * 为什么不是"取第一个"或"取群那档"：一个 DSH 会话只能挂一个 preset，而共用组成员可能
   * 横跨 owner（能读写本机）与 readonly（只能读）两档。取高档等于把本机交给群里任何人
   * —— 这是 RULES.md「群里没有本地工具」的直接违反。所以宁可让 owner 也降级为 readonly：
   * 少几个本地工具是体验问题，多给群友本地工具是安全事故。
   */
  function sharedPresetName(pool, mode, cfg) {
    const explicit = String(cfg?.sessionSharing?.preset ?? '').trim();
    if (explicit) return explicit;
    const order = [TIER_PRESETS.READONLY, cfg.socialV2?.agentPreset || cfg.agentPreset || '', TIER_PRESETS.OWNER];
    const wanted = new Set(pool.map((k) => wantedPresetName(k, mode, cfg)).filter(Boolean));
    for (const candidate of order) {
      if (candidate && wanted.has(candidate)) return candidate;
    }
    return [...wanted][0] ?? '';
  }

  /** 当前模式/权限档位下的会话预设；返回 undefined 表示「没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    const wanted = wantedPresetName(key, mode, cfg);
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(wanted);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    // 三档分级同样 strict：qq-chat-owner / qq-chat-readonly 还没装进 DSH 时**必须** fail-closed。
    // 回退方向一旦反了（把群聊升到 owner）就是把本机交给群里的人；宁可 owner 会话暂时建不出来，
    // 报错里会带上该跑 node scripts/setup-dsh.mjs 的提示。
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  /**
   * 会话共享组：返回与 key 同组的所有 QQ key（含自己）。
   *
   * 不开共享时恒返回 [key]，全部旧行为不变。开了共享、但这个 key 不在任何组里时同样返回 [key]。
   * 组内成员一起决定 preset（取最低档）与记忆归属（取组内代表 key）。
   */
  /**
   * 构造【会话令牌】那一行。
   *
   * 单会话（不共用）时输出与历史完全一致的一行；**只有共用会话**（私聊与群共用一个
   * DSH 会话）时才按 key 逐行列出各自的令牌。
   *
   * 为什么必须按 key 分开写：两个 QQ 会话各有独立的 agentToken，模型用错一个就 403。
   * 实测事故：提示词写「你已接入 私聊 x、群 y」却只给一个令牌，模型只能盲试，
   * 于是出现「标记已读失败：agent token 无效」，还会在思考链里反复纠结哪个是对的。
   *
   * @param {string} key 当前唤醒的 QQ 会话 key
   * @param {string} fallbackToken 无法取到成员状态时用的令牌（保持旧行为）
   */
  function sessionTokenLineV2(key, fallbackToken) {
    const members = (() => {
      try { return shareGroupOf(key); } catch { return [key]; }
    })();
    if (members.length <= 1) {
      // 单聊天也要给 key：标签可能已经简化成「群」，光有令牌没法发言。
      const only = members[0] ?? key;
      const canonical = canonicalV2Key(only) || only;
      return `【令牌】${chatLabelForV2(canonical)} → key "${canonical}"，token ${fallbackToken}`;
    }
    // 2026-11-10 合并成一行：原版是「群 20001 → 38721c0c…」+「调用工具时把 key 和令牌
    // 配成一对…」共 5 行约 220 字，每轮唤醒都进历史并随每一步重发。
    //
    // ⚠️ key 必须显式写出来：标签简化成「群」之后，模型光看标签推不出 `group:20001`
    // 这个要塞进 qq_send_message 的字面值。这一行给全「标签 → key → 令牌」三元组，
    // 也顺带替代了原来的【当前场景】段和「怎么回」那段解释。
    const lines = members.map((k) => {
      const canonical = canonicalV2Key(k) || k;
      const st = getSocialV2State(k);
      return `${chatLabelForV2(canonical)} → key "${canonical}"，token ${st.agentToken}`;
    });
    return `【令牌】${lines.join(' ｜ ')}`;
  }

  function shareGroupOf(key) {
    const ownerKey = sharedOwnerKeyOf(cfg, key);
    if (ownerKey === key) {
      const sharing = cfg?.sessionSharing;
      const groups = sharing?.enabled === true && sharing.groups && typeof sharing.groups === 'object' ? sharing.groups : null;
      if (!groups) return [key];
      // key 可能本身就是组里的 leader：把它自己那一组成员收齐。
      const canonical = canonicalV2Key(key) || key;
      for (const [leaderRaw, memberRaw] of Object.entries(groups)) {
        const leader = canonicalV2Key(leaderRaw) || String(leaderRaw);
        const members = Array.isArray(memberRaw) ? memberRaw : [memberRaw];
        const pool = [leader, ...members.map((m) => canonicalV2Key(m) || String(m))];
        if (pool.includes(canonical)) return [...new Set(pool)];
      }
      return [key];
    }
    // key 是组里的非代表成员：整组都在同一个共享会话里。
    const sharing = cfg?.sessionSharing;
    const groups = sharing?.groups && typeof sharing.groups === 'object' ? sharing.groups : {};
    const canonical = canonicalV2Key(key) || key;
    for (const [leaderRaw, memberRaw] of Object.entries(groups)) {
      const leader = canonicalV2Key(leaderRaw) || String(leaderRaw);
      const members = Array.isArray(memberRaw) ? memberRaw : [memberRaw];
      const pool = [leader, ...members.map((m) => canonicalV2Key(m) || String(m))];
      if (pool.includes(canonical)) return [...new Set(pool)];
    }
    return [key];
  }

  function sessionPolicy(key) {
    // 共用会话：策略必须由**整组**算出同一个值，否则成员之间会互相把对方判定成
    // "权限已变化"，reconcileSessionPolicies 每轮都会把正在用的会话退役掉。
    const pool = shareGroupOf(key);
    const preset = pool.length > 1
      ? sharedPresetName(pool, currentMode, cfg)
      : modePreset(key, currentMode, cfg);
    return JSON.stringify([currentMode, preset ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 这个会话（或它所在的共用组）是否已经注入过【初始提示词】。
   *
   * ⚠️ 2026-11-13：它**不再**是"要不要发那两句冷启动提示"的判据。
   * 那个判据只有一个：coldStartRegistry（按 DSH sessionId，见 §冷启动引导）。
   * bootstrapSent 现在只管一件事 —— 操作者为会话预写的初始提示词有没有注入过。
   * 两件事分开的理由：初始提示词是"这个群是什么地方"，与上下文丢没丢无关；
   * 而冷启动提示问的是"她脑子里还有没有东西"。把它们绑在一起时，任何一边的
   * 漏判/重复都会污染另一边（旧实现里正是这么发重、发漏的）。
   *
   * 为什么按组算：`bootstrapSent` 原本是**按 QQ key 各自存**的，而共用会话下
   * private 和 group 共用一个 DSH 会话、一套记忆、一模一样的引导词。
   * 于是只要两个 key 的 bootstrapSent 不一致（典型：只清了私聊的上下文，
   * 群的还是初始 false），两个 key 就会各发一次 bootstrap —— 同一段引导词
   * 发进同一个会话里两遍。2026-11-10 实测踩过（22:52:09 与 22:52:21）。
   *
   * 判定用「组内任意一个 key 已发过就算发过」：宁可少发（她本来就已经在
   * 同一个会话里被引导过了），也不要重复发（每条都是 token）。
   */
  function groupBootstrapSent(key) {
    const pool = (() => {
      try { return shareGroupOf(key); } catch { return [key]; }
    })();
    // 单聊（不在任何共用组）时 pool 就是 [key]，行为与旧版完全一致。
    for (const k of pool) {
      const st = socialV2.conversations.get(canonicalV2Key(k) || k);
      if (st && st.bootstrapSent) return true;
    }
    return false;
  }

  /**
   * 把「已发过引导」记到组内**所有** key 上。
   *
   * 只置当前 key 是不够的：下一个 key 第一次收到消息时又会走一遍判断，
   * 那时组里其它 key 还是 false，于是又发一次。整组一起置才能压住重复。
   * 组内还没建过状态的 key 也要顺手建出来（getSocialV2State 会建），
   * 否则它之后第一次说话时仍然是 false。
   */
  function markGroupBootstrapSent(key) {
    const pool = (() => {
      try { return shareGroupOf(key); } catch { return [key]; }
    })();
    for (const k of pool) {
      try {
        const st = getSocialV2State(k);
        if (!st.bootstrapSent) st.bootstrapSent = true;
      } catch { /* 非法 key 忽略：不能因为组里有个坏 key 就阻断引导 */ }
    }
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 共用会话：这个 sessionId 还挂着别的 QQ key，就不能归档 —— 否则一个成员出问题
    // 会把另一个正在用的聊天一起废掉（表现为"私聊好好的，群突然不回了"）。
    if (sessionId && keysForSession.has(sessionId)) {
      const members = keysForSession.get(sessionId);
      members.delete(key);
      if (members.size > 0) {
        forgetConversationCaches(key);
        log(`共用会话：${key} 退役，但 ${sessionId} 仍被 ${[...members].join(', ')} 使用，保留会话不归档`);
        return;
      }
      keysForSession.delete(sessionId);
    }
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    turnLeaseNoted.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      // 2026-11-16：agentToken 定为 **16 个十六进制字符**（randomBytes(8)）。
      //   历史：原来是 48 字符（randomBytes(24)）→ 试过 8 字符（randomBytes(4)，
      //   40 亿种，现代机器几小时能爆破）→ 最终定 16 字符：
      //   1.8×10^19 种，实际不可爆破，同时比 48 字符每次调用省 32 字符。
      //   调用次数多时这仍是可观的开销（300 次 ≈ 9.6k 字符）。
      st.agentToken = crypto.randomBytes(8).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      // 共用会话：整组一起复位。只复位自己会让组里其它 key 仍然「已引导」，
      // 而它们的会话映射已经被 retire —— 结果下一个 key 醒来时既不补发引导，
      // 也拿不到新的引导上下文。整组复位 = 大家一起重新引导一次（本来就该如此，
      // 因为组共用一个 DSH 会话，旧会话已经退役了）。
      for (const memberKey of (() => { try { return shareGroupOf(key); } catch { return [key]; } })()) {
        if (memberKey === key) continue;
        const memberSt = socialV2.conversations.get(canonicalV2Key(memberKey) || memberKey);
        if (memberSt) memberSt.bootstrapSent = false;
      }
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  // ── checkDsh 的重入护栏 ────────────────────────────────────────────────────
  // 它由 `setInterval(..., 5000)` 驱动，而「掉线自愈」那段会 `await` 一次端口探测
  // （netstat + 指纹，最坏几百毫秒）。一旦某轮耗时超过 5 秒（DSH 半死不活时完全
  // 可能），定时器就会再起一轮，两轮同时更新 dshReady / 同时改写 cfg 与 config.json，
  // 结果不可预期。用单飞标记把并发的第二轮直接挡掉 —— 下一轮 5 秒后自然会来。
  let dshCheckBusy = false;
  const checkDsh = async () => {
    if (dshCheckBusy) return;
    dshCheckBusy = true;
    try {
      await checkDshOnce();
    } finally {
      dshCheckBusy = false;
    }
  };
  const checkDshOnce = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
            setupTodoTimerV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
            setupTodoTimerV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
    // ── 掉线后的端口自愈 ────────────────────────────────────────────────────
    //
    // 曾经**刻意去掉过**这一段，理由是「端口对齐改成事件驱动、少一份周期性副作用」。
    // 那个判断在实测里站不住，现在加回来 —— 但加了明确的前置条件，不再是盲目轮询：
    //
    //   真正卡住用户的场景是「先开 DSH，再点启动 SnowLuma」：
    //     · DSH 是**新的**进程，端口是**新的**值；
    //     · 桥接要么还在连旧端口（上次那个 DSH 进程的），要么刚起来、配置里也是旧值；
    //     · 面板那条「启动 SnowLuma」顺带的对齐请求 —— 它要求面板**先能连上桥接的
    //       控制台**，而桥接这时通常还没起好，于是这一步经常根本没执行；
    //     · 结果就得等到「有人想起来去点一下对齐」为止。
    //   所以必须在**桥接自己这一侧**也能自愈，不能只依赖外部事件。
    //
    // 三条前置条件（缺一不做，避免 5 秒一次地扫端口）：
    //   ① DSH 确实不可用（`ok === false`）—— 可用时绝不打扰；
    //   ② 距上次尝试跟随已过冷却期（JOIN 成功时会把时间戳写在这里）；
    //   ③ 当前不是「刚刚跟随完仍然连不上」的状态 —— 由冷却期自然覆盖。
    //
    // 代价可控：netstat 一次约 25ms，指纹探测并发 8 路，命中即停。
    if (!ok) {
      const FOLLOW_COOLDOWN_MS = 10_000;
      const now = Date.now();
      if (now - lastDshFollowAt > FOLLOW_COOLDOWN_MS) {
        lastDshFollowAt = now;   // 先占位：这次无论成败都不在冷却期内重复
        try {
          const r = await followDshEndpoint(cfg);
          if (r.changed) {
            api.baseUrl = r.baseUrl;
            api.invalidateAuth();
            log(`[dsh] 掉线自愈：${r.from || '(空)'} → ${r.baseUrl}（来源 ${r.reason || 'scan'}）`);
            // 端口变了：立刻重探一次，让本轮 checkDsh 就能把 dshReady 翻成 true，
            // 而不是再等 5 秒。顺带把退避中的事件流叫醒。
            try { await api.settings.describe({}); } catch {}
            wakeMuxPump();
          }
        } catch { /* 自愈失败不阻断主循环，下一轮冷却期过后再试 */ }
      }
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  /**
   * 把正睡在退避窗口里的 pumpMux 立刻叫起来。
   *
   * 幂等：没有等待者时什么都不做（下一次 pumpMux 会自己算退避）。
   * 注意它只打断「睡眠」，不改变退避策略本身 —— 策略仍然是
   * 「真的连上了才重置」，否则会退化成每 3 秒一次的刷屏重连。
   */
  function wakeMuxPump() {
    if (!muxWake) return;
    const r = muxWake;
    muxWake = null;
    r();
  }

  /**
   * 可被打断的 sleep：`ms` 到点或 wakeMuxPump() 被调用，哪个先到就返回。
   * @returns {Promise<boolean>} true = 是被 wake 叫醒的（而不是自然到点）。
   */
  function sleepUnlessWoken(ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (woken) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (muxWake === fire) muxWake = null;
        resolve(woken);
      };
      const fire = () => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      muxWake = fire;
    });
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        // 4MB：控制台接口里只有「上传表情」会传大 body，而图片经 base64 会膨胀约 33%，
        // 所以留出余量（图片本身的上限见 socialV2.sticker.uploadMaxBytes，默认 2MB）。
        const MAX_BODY_BYTES = 4_000_000;
        const MAX_BODY_LABEL = `${Math.round(MAX_BODY_BYTES / 1000)}KB`;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, `请求体过大（超过 ${MAX_BODY_LABEL}）`);
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, `请求体过大（超过 ${MAX_BODY_LABEL}）`);
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
      if (consoleToken && !tokenMatches) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1；带了令牌就必须命中某个活跃会话，
      // 端点自己漏写校验也不会退回管理端。
      //
      // 但「没带令牌」的智能体调用不能一律拒绝：closed-agent（管理员私聊）模式下模型
      // 本来就**没有**会话令牌（令牌只在 reserved2 的唤醒提示里下发），而 qq_send_group_message
      // / qq_list_groups 等工具必须在这个模式里可用（工具描述写的也是"closed-agent 模式不需要"）。
      // 这些端点各自按模式判定（/api/send/* 只在 closed-agent 放行；/api/images/* 在 reserved2
      // 强制要令牌；/api/status 对智能体调用只回最小对象），所以这里把「无令牌智能体调用」
      // 限制到这条非 v2 会话面；整个 /api/socialV2/ 前缀一概不放——那里的 token 校验全是
      // `if (x-agent-token && …)`，放进来就等于退化成管理端全权（confused deputy）。
      if (req.headers['x-agent-call'] !== undefined) {
        const agentToken = req.headers['x-agent-token'];
        const hasToken = typeof agentToken === 'string' && agentToken !== '';
        if (hasToken && !isLiveAgentToken(agentToken)) {
          sendJson({ ok: false, error: '未授权：智能体调用携带的会话令牌无效' }, 403);
          return;
        }
        if (!hasToken) {
          const tokenlessAgentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/');
          if (!tokenlessAgentAllowed) {
            sendJson({ ok: false, error: '未授权：该接口的智能体调用必须携带有效的会话令牌' }, 403);
            return;
          }
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        // /api/socialV2/initial-prompt 也在这里：它是操作者写给 AI 的"环境背景"，
        // 让 AI 自己读/改等于把控制台的管理输入（以及未来可能写入的其它群信息）交给会话主体。
        // /api/socialV2/affinity 的 **POST** 同样列进来：GET 是 AI 查"跟这个人多近"（qq_affinity 要用），
        // 但 POST 是操作者撬动关系的旋钮，绝不能让被评价的那一方自己转。
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/initial-prompt'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET') || (url.pathname === '/api/socialV2/affinity' && req.method === 'POST'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        // 只读降级：表情库在启动时加载失败时，写接口必须**明确失败**。
        // 旧行为是 save 函数里只打一行日志就 return，而接口照样回 {ok:true}：
        // 控制台显示"✅ 已保存"，实际只改在内存里，重启后全部消失。
        if (req.method !== 'GET') {
          const readonlyStore = (!stickerStoreWritable && (url.pathname === '/api/stickers/sync'
              || url.pathname === '/api/stickers/note'
              || url.pathname === '/api/stickers/remark'
              || url.pathname === '/api/socialV2/sticker-note'
              || url.pathname === '/api/socialV2/sticker-remark'
              || url.pathname === '/api/socialV2/collect-sticker')) ? '表情库'
              : '';
          if (readonlyStore) {
            sendJson({ ok: false, error: `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接` }, 503);
            return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady,
              socialV2Paused: socialV2.paused,
            });
            return;
          }
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            // 当前模式**配置**的 agent preset（不是某个具体会话解析后的结果 ——
            // /api/status 是全局视角，没有会话 key，不能调 modePreset(key, ...)）。
            //
            // 为什么必须回这个字段：面板「诊断」页要判断「配置的 preset 装没装」，
            // 读的就是它。之前 status 里没有该字段，那段判断永远拿不到值，
            // 只能走兜底分支，显示成
            //   「qq-chat preset 已装：未配置具体 preset；可用：standard, ...」
            // —— 一条看着像警告、其实是假告警的信息（config 里明明有值）。
            agentPreset: currentMode === 'closed-agent'
              ? String(closedAgentPreset || dshDefaultPreset || '')
              : String(cfg.socialV2?.agentPreset || cfg.agentPreset || ''),
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot(),
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (currentMode === 'reserved' && requestedMode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = requestedMode;
          lastMode = requestedMode;
          reconcileSessionPolicies();
          if (requestedMode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          // 入参兼容：桥接原生用 `{ role }`，qq-dsh-panel 的设置页传的是 `{ name }`。
          // 历史坑：旧代码只认 `role`，那边传 { name: '傲娇助手' } 时 rawRole 是
          // undefined，于是走进下面的「清除」分支 —— 用户点「设为当前角色」实际把
          // 角色清空了，接口还回 ok:true，界面提示"已切换"，下拉框随即变空。
          // 所以这里必须把「没传参数」和「传 null 表示清除」严格区分开。
          const hasRoleField = Object.prototype.hasOwnProperty.call(body, 'role')
            || Object.prototype.hasOwnProperty.call(body, 'name');
          if (!hasRoleField) {
            sendJson({ ok: false, error: '缺少参数：role（或 name）传角色名，传 null 表示清除' }, 400);
            return;
          }
          const rawRole = Object.prototype.hasOwnProperty.call(body, 'role') ? body.role : body.name;
          if (rawRole === null || rawRole === '') {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
            return;
          }
          const name = sanitizeRoleName(String(rawRole));
          if (!name || !fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
            sendJson({ ok: false, error: `角色「${name || rawRole}」不存在（roles/${name || rawRole}.md）` }, 400);
            return;
          }
          writeRoleState(name, rs.mode);
          log(`控制台：角色已设置为 ${name}（mode=${rs.mode}）`);
          sendJson({ ok: true, role: name });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: roleInjectMaxChars },
            stats: roleCharStats(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          atomicWriteJson(configFile, file);
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          roleInjectMaxChars = next;
          log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          const rs = readRoleState();
          const switched = rs.role === from;
          if (switched) writeRoleState(to, rs.mode);
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) writeRoleState(null, rs.mode);
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          let nextText;
          try {
            const { text, prefix } = readPresetPromptText(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
              return;
            }
            nextText = renderPresetPromptYaml(text, body.content, presetTierKey(preset));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = presetPromptWarnings(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), nextText);
            // 同步到旧版安装副本（DSH 0.1.5 的 ~/.dsh/.agent-presets/<名>/）。
            // ⚠️ DSH 0.1.7 起**完全不读这个目录**，它通常根本不存在，所以这里只是
            // 兼容旧部署的尽力而为；真正生效的是 profile 里的 preset 行，改完**必须重启 DSH**。
            // 安装副本**不做仓库内备份**——内容与刚写好的源文件一致，备份它等于把含
            // 本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) {
              fs.copyFileSync(presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
            }
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            // 旧字段：只反映 0.1.5 的旧目录有没有同步成功。0.1.7 上它必然是 false，
            // 别把它读成"失败"——看 installedInDsh / requiresRestart 才准。
            synced: fs.existsSync(installedPresetYaml(preset)),
            installedInDsh: isPresetInstalledInDsh(preset),
            requiresRestart: true,
            status: presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            sendJson({ ok: true, backups: listPresetBackups(preset) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设档位取**：一代本来就没有工具面表述，owner / readonly
            // 则相反 —— 它们有本地能力，要求「你没有本地工具」会自相矛盾。
            const blockers = presetPromptBlockers(restoredPrefix, presetTierKey(preset));
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), restored);
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
            log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        // ── 三档权限分级诊断（只读） ─────────────────────────────────────────
        // 为什么需要：档位判定（sessionTier）与 preset 是否真的可用（dshPresetIds）分别在
        // 两处，"这个会话现在算什么档、会用哪个 preset、建不建得出来"肉眼看不出来。
        // 这里把两者拼起来，工具箱/探针直接读即可，不必等真发一条 QQ 消息建会话。
        // 属于管理信息（含 ownerQQ 与白名单）⇒ 与 /api/whitelist 同级，agent token 读不到
        // （见上面的 agentAllowed 白名单）。
        if (req.method === 'GET' && url.pathname === '/api/permission-tiers') {
          const entries = [];
          const push = (kind, id) => {
            // 用 canonical key：白名单里可能带前导零（'0123'），与 '123' 是同一个会话。
            const key = canonicalV2Key(`${kind}:${id}`) ?? `${kind}:${id}`;
            const tier = sessionTier(key, currentMode, cfg);
            const preset = wantedPresetName(key, currentMode, cfg);
            entries.push({
              key,
              tier: tier || 'chat',
              preset,
              // null = DSH preset 清单还没拿到（启动瞬间）；false = 该档 preset 没装 ⇒ fail-closed
              available: dshPresetIds.length === 0 ? null : dshPresetIds.includes(preset),
              sessionId: state.sessions[key] ?? null,
            });
          };
          if (cfg.ownerQQ) push('private', cfg.ownerQQ);
          for (const id of cfg.allow?.private ?? []) push('private', id);
          for (const id of cfg.allow?.groups ?? []) push('group', id);
          const seen = new Set();
          const sessions = entries.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)));
          sendJson({
            mode: currentMode,
            ownerQQ: cfg.ownerQQ ?? null,
            presets: {
              owner: TIER_PRESETS.OWNER,
              readonly: TIER_PRESETS.READONLY,
              chat: currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset,
            },
            dshPresets: dshPresetIds,
            deny: cfg.deny ?? { private: [], groups: [] },
            sessions,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          sendJson({
            provider,
            model,
            reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          const auditTest = auditOutbound(message, { level: auditLevelFor(`${kind}:${id}`), knownTokens: KNOWN_AGENT_TOKENS });
          if (auditTest.blocked) { sendJson({ ok: false, error: `消息含${auditTest.reason}，已阻止发送` }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readConfigObject(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `${sessionTokenLineV2(key, stV2.agentToken)}\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          // 注意 'fact' 已移除（2026-11-10）：长期事实并入 qq_memory_append 的 longTerm 类别，
          // 写入闸门走 'memory'。留在这里会让旧配置的 tools.fact 被重新写回。
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'sendFile', 'recallMessage'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // 收尾前观望（2026-11-14）：三个毫秒值都走统一归一化。
          // 硬上限额外 clamp 到 20 秒以内 —— MCP 那边 mark_read / wake-config
          // 是 timeoutMs:25000，配置成更大就会变成「工具超时、消息丢掉」。
          for (const k of ['observeBeforeSleepMs', 'observeQuietMs', 'observeHardCapMs']) {
            if (body[k] !== undefined) {
              const n = Number(body[k]);
              merged[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current[k] ?? 0;
            }
          }
          if (merged.observeHardCapMs !== undefined) {
            merged.observeHardCapMs = Math.min(20000, Math.max(0, merged.observeHardCapMs));
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs', 'minSendIntervalMs', 'observeQuietMs', 'observeAfterSendMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6500, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          // qzone：QQ 空间（说说）。它是**一个工具**，不是日程任务 —— 这里只管
          // 「能不能发」和「一天最多几条」，不控制"什么时候发"，那由它自己或操作者决定。
          if (body.qzone && typeof body.qzone === 'object' && !Array.isArray(body.qzone)) {
            merged.qzone = { ...(current.qzone ?? {}), ...body.qzone };
            if (merged.qzone.enabled !== undefined) merged.qzone.enabled = merged.qzone.enabled === true;
            if (merged.qzone.maxPerDay !== undefined) {
              const n = Number(merged.qzone.maxPerDay);
              merged.qzone.maxPerDay = Number.isFinite(n) ? Math.min(20, Math.max(1, Math.round(n))) : (current.qzone?.maxPerDay ?? 2);
            }
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          // 发文件配置：写盘前必须过归一化（体积/频率收敛、扩展名清洗）。内置的敏感路径与
          // 密钥黑名单在归一化里是**并集**，控制台无法通过这次保存把它们去掉。
          if (merged.files !== undefined) merged.files = normalizeSendFileConfig(merged.files);
          // 工具开关里与"文件"相关的键也要显式收敛成布尔（防止字符串 "false" 被当成真）。
          if (merged.tools && typeof merged.tools === 'object' && !Array.isArray(merged.tools)
            && merged.tools.sendFile !== undefined) {
            merged.tools = { ...merged.tools, sendFile: merged.tools.sendFile !== false };
          }
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs',
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        // ── 纯语音（文字 → 睦的声音）──────────────────────────────────────
        // GET  ：读当前开关 + 推理服务是否就绪（控制台打开页面时用来画状态）
        // POST ：切换开关。**打开时**如果推理服务没在跑，自动拉起并等它就绪。
        //        拉起失败不阻断开关本身（仍然记住"想开"），但会把原因回给控制台，
        //        避免出现"开关是开的、其实一直发文字"这种没人知道的静默降级。
        // ── 纯语音（智能体通道）──────────────────────────────────────────
        // 她能自己开关纯语音，但**只有跟主人私聊时才能开**。
        //
        // 身份判定不靠她传参数（2026-11-13 操作者：消息行末尾已有「（主人）」标记，
        // 她本来就知道谁是主人），而是桥接自己看当前 key：
        //   · private:<ownerQQ> → 就是主人，允许开
        //   · 群里 / 其他人的私聊 → 一律拒绝
        // 这样即使她在群里被某人要求"开语音"，也开不起来 —— 纯语音是熟人在私聊里用的东西，
        // 不是群里谁喊一声就能触发的开关。
        if (url.pathname === '/api/socialV2/tts' && req.headers['x-agent-token']) {
          const body = req.method === 'POST' ? await readBody() : {};
          const ownerQQ = String(cfg.ownerQQ ?? '');
          // 当前会话是不是"跟主人在私聊"
          const ownerPrivateKey = ownerQQ ? `private:${ownerQQ}` : '';
          const keyRaw = String(body.key ?? url.searchParams.get('key') ?? '').trim();
          const talkingToOwner = ownerPrivateKey && canonicalV2Key(keyRaw) === ownerPrivateKey;

          if (req.method === 'POST') {
            const want = body.enabled === true;
            // 2026-11-13：**开关都只有主人能动**（原来只有"开"校验，"关"谁都可以）。
            // 对齐预设里的「只有主人能开关」——操作者选择严格一致，不接受"谁都能关"。
            // 想恢复"谁都能关"：把条件改回 `if (want && !talkingToOwner)`。
            if (!talkingToOwner) {
              sendJson({ ok: false, error: '只有主人能开关纯语音', enabled: socialV2.tts?.enabled === true }, 403);
              return;
            }
            const cur = normalizeTtsConfig(socialV2.tts ?? {});
            let started = false;
            let ready = await ttsServerReady(cur.baseUrl);
            let detail = ready ? '已在运行' : '';
            if (want && !ready) {
              const r = await ensureTtsServer(cur, { log, logFile: path.join(STATE_DIR, 'tts-server.log') });
              started = r.started;
              ready = r.ready;
              detail = r.detail;
            }
            socialV2.tts = { ...cur, enabled: want };
            saveSocialV2State();
            log(`[tts] 智能体切换纯语音：${want ? '开' : '关'}（key=${keyRaw}，服务${ready ? '就绪' : '未就绪'}）`);
            appendActivity(`[tts] 智能体切换纯语音 ${want ? '开启' : '关闭'}`);
            // 只回最少的信息：她要的是一句话，不是状态面板。
            sendJson({ ok: true, enabled: want, ready, started, detail });
            return;
          }
          if (req.method === 'GET') {
            const cur = normalizeTtsConfig(socialV2.tts ?? {});
            sendJson({ ok: true, enabled: cur.enabled === true });
            return;
          }
        }
        if (url.pathname === '/api/socialV2/tts') {
          if (req.method === 'GET') {
            const cur = normalizeTtsConfig(socialV2.tts ?? {});
            const ready = await ttsServerReady(cur.baseUrl);
            sendJson({ ok: true, enabled: cur.enabled === true, ready, baseUrl: cur.baseUrl });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody();
            const want = body.enabled === true;
            const cur = normalizeTtsConfig(socialV2.tts ?? {});
            let started = false;
            let ready = await ttsServerReady(cur.baseUrl);
            let detail = ready ? '已在运行' : '';
            if (want && !ready) {
              log('[tts] 开关打开，但推理服务没在跑，尝试自动拉起…');
              // 窗口是隐藏的，所以给它的输出留一份日志（state/tts-server.log）。
              const r = await ensureTtsServer(cur, { log, logFile: path.join(STATE_DIR, 'tts-server.log') });
              started = r.started;
              ready = r.ready;
              detail = r.detail;
              log(`[tts] 自动拉起结果：started=${started} ready=${ready} ${detail}`);
            }
            socialV2.tts = { ...cur, enabled: want };
            saveSocialV2State();
            log(`控制台：纯语音${want ? '已开启' : '已关闭'}（推理服务${ready ? '就绪' : '未就绪'}）`);
            appendActivity(`[tts] 纯语音${want ? '开启' : '关闭'}；服务${ready ? '就绪' : '未就绪'}${started ? '（已自动拉起）' : ''}`);
            sendJson({ ok: true, enabled: want, ready, started, detail });
            return;
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              stopRetiredSessionWork(sid, key);
              sessionModels.delete(sid);
              modelAppliedSessions.delete(sid);
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              turnLeaseNoted.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              api.events.forget?.(sid);
            }
            delete state.sessionPolicies[key];
            forgetAgentToken(key);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          saveState();
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            recallMessage: 'qq_recall_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_userid',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear（长期记忆用 qq_memory_append 的 longTerm 类别）',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            // 发文件：只有 Owner 档（管理员私聊）真能调通，见 /api/socialV2/send-file 的档位闸门。
            sendFile: 'qq_send_file（仅管理员私聊）'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
            self: {
              nickname: selfDisplayName || null,
              userId: selfUserId || null,
              line: selfIdentityTextV2().trim() || null
            },
            role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools: cfg.socialV2?.deferTools === true
              // 开了工具索引：只有常驻的这几个是原生工具，其余要经 qq_find_tool / qq_call_tool。
              // 这里必须跟 MCP 侧的真实注册面一致，否则模型会去调一个根本不存在的工具。
              ? { resident: enabledTools.filter((n) => DEFERRED_RESIDENT_TOOLS.has(n)), note: '其余工具未常驻：先 qq_find_tool 查名字，再 qq_call_tool 调用。' }
              : enabledTools,
            replyTiming: replyTimingV2(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            // 记忆：长期三类 + todo 在全局，短期两类在本会话。
            // 2026-11-12 修：这里原来传的是 `st`（当前会话对象），
            // 而 selfNote / memberImpression / todo 现在都存在 globalMemory 里，
            // 于是 qq_get_prompt 返回的 memory 永远是空的 —— 预设却写着
            // 「记忆会随 qq_get_prompt 出现」，两边对不上。
            // 现在按归属分开取，和 /api/socialV2/memory 的口径一致。
            memory: formatMemoryV2({
              activeTopics: st.activeTopics,
              pendingThoughts: st.pendingThoughts,
              memberImpressions: getSocialV2State(GLOBAL_MEMORY_KEY).memberImpressions,
              selfNotes: getSocialV2State(GLOBAL_MEMORY_KEY).selfNotes,
              todos: getSocialV2State(GLOBAL_MEMORY_KEY).todos,
            }, key),
            participation: formatParticipationV2(st),
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            },
            voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              maxSeconds: voiceCfg().maxSeconds,
            }
          });
          return;
        }
        // 闲置压缩的 dry-run：报告每个会话的判定依据，**不执行任何动作**。
        // 有了它，"为什么没压缩 / 什么时候会压"才能从控制台直接看到，
        // 而不是靠猜或者把阈值调低去试（那会真的归档掉正在用的会话）。
        // 仅管理端：带 x-agent-token 的是模型调用，一律拒绝。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/idle-compact') {
          if (req.headers['x-agent-token']) {
            sendJson({ ok: false, error: '仅管理端可用' }, 403);
            return;
          }
          const at = Date.now();
          const rows = [];
          for (const [k, st] of socialV2.conversations) {
            const decision = idleCompactDecisionV2(k, st, at);
            const last = Math.max(st.lastActionAt || 0, st.lastIncomingAt || 0, st.lastAiReplyAt || 0);
            rows.push({
              key: k,
              session: state.sessions[k] ?? null,
              idleMinutes: last ? Math.round((at - last) / 60000) : null,
              contextTokens: currentContextTokensV2(k),
              compactedThisRound: !!st.idleCompactedAt,
              compacting: !!st.idleCompactingAt,
              wouldCompactNow: !!decision
            });
          }
          sendJson({
            ok: true,
            config: cfg.socialV2?.compaction ?? {},
            note: 'contextTokens 取的是「最近一次请求的输入量」；压缩之后要等下一次请求才会反映出变小，压缩刚完成时这里仍是旧值。',
            conversations: rows
          });
          return;
        }
        // 手动跑一次「写记忆 → 原地压缩」。运维/验证入口，平时不需要它。
        // 默认异步：完整流程要等模型写完记忆，HTTP 不能挂在那一轮上。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/idle-compact/run') {
          if (req.headers['x-agent-token']) {
            sendJson({ ok: false, error: '仅管理端可用' }, 403);
            return;
          }
          let body = {};
          try {
            body = await readBody();
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '请求体无效' }, error?.statusCode ?? 400);
            return;
          }
          const runKey = canonicalV2Key(String(body.key ?? ''));
          if (!runKey) { sendJson({ ok: false, error: 'key 无效' }, 400); return; }
          const runSt = socialV2.conversations.get(runKey);
          if (!runSt) { sendJson({ ok: false, error: '该会话还没有二代状态（先让它收一条消息）' }, 404); return; }
          if (!state.sessions[runKey]) { sendJson({ ok: false, error: '该会话还没有 DSH session' }, 409); return; }
          if (runSt.idleCompactingAt) { sendJson({ ok: false, error: '已经有一次压缩在跑' }, 409); return; }
          const decision = idleCompactDecisionV2(runKey, runSt);
          const force = body.force === true;
          if (!decision && !force) {
            sendJson({
              ok: false,
              error: `未到闲置边界：需要会话空闲满 ${Math.round((Number(cfg.socialV2?.compaction?.idleMs) || 1800000) / 60000)} 分钟，且上下文超过 ${Math.round((Number(cfg.socialV2?.compaction?.thresholdTokens) || 300000) / 1000)}k token。可传 force:true 强制跑一次。`
            }, 409);
            return;
          }
          const effective = decision ?? {
            idleMs: Date.now() - (runSt.lastIncomingAt || 0),
            ctxTokens: currentContextTokensV2(runKey)
          };
          // body.skipSummarize 已失效：压缩前不再有「记忆整理」这一步模型调用，
          // 现在压缩只是一次 /compact。参数保留但不影响行为（老调用方不会因此报错）。
          void idleCompactV2(runKey, effective).catch((error) => log(`[compaction] 手动触发异常 ${runKey}: ${error?.message ?? error}`));
          sendJson({ ok: true, started: true, forced: !decision, key: runKey, contextTokensBefore: effective.ctxTokens });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/agent-context') {
          // 给 DSH 侧插件用：按 DSH session 反查 QQ 会话，返回「每会话不变」的那几段。
          //
          // 为什么需要它：这些内容（身份/令牌/表情/长期记忆）现在混在每轮唤醒包里，
          // 让模型每轮都看到一大段"系统指令"。搬进 system prompt 后，user message 才能
          // 只剩"谁说了什么"。内容是同步渲染的（插件那边 text() 是同步函数），所以这里
          // 只返回拼好的字符串，不再做任何异步操作。
          const sid = String(url.searchParams.get('sessionId') ?? '').trim();
          const stateSessions = readJsonSafe(STATE_FILE, {})?.sessions ?? {};
          const key = Object.keys(stateSessions).find((k) => stateSessions[k] === sid);
          // 2026-11-17：临时加的访问日志。当初是为了确认"插件到底有没有来请求"——
          // 结论是**来了**，问题在时序（agent/created 早于 state.sessions[key] 落盘），
          // 已在 plugins/qq-agent-context 里修好。
          // 保留它：验证「新会话首轮是否拿到令牌」时，这一行（key=group:xxx）就是
          // 最直接的成功信号；非 QQ 会话会打 key=(未匹配到)，插件那边已带退避。
          // 嫌吵可以删，删掉后排查首轮问题只能翻会话 zstd。
          log(`[agent-context] 插件请求 sessionId=${sid.slice(0, 20)}… → key=${key || '(未匹配到)'}`);
          if (!sid || !key) { sendJson({ ok: false, error: 'unknown session' }, 404); return; }
          if (!isSessionAllowedInCurrentMode(key)) { sendJson({ ok: false, error: 'not allowed in current mode' }, 403); return; }
          const acSt = getSocialV2State(key);
          const parts = [];
          const idText = selfIdentityTextV2();
          if (idText) parts.push(idText.trim());
          parts.push(sessionTokenLineV2(key, acSt.agentToken));
          // ── 2026-11-18：**只保留身份 + 令牌，其余全部移出** ──────────────
          //
          // 这一段会进 **system prompt**，而 system prompt 在整个 prompt 的最前面：
          // 它一变，后面几十万 token 的对话历史前缀全部失效、整段重算。
          //
          // 实测 session-7e48ee50：52 步里 7 次缓存重建，吃掉 88.6% 的 cacheMiss，
          // 命中率从 98.8% 掉到 90.1%。已经移出的诱因：
          //   ① 长期记忆（16:23:34 多了 6 条 → +331 字符 → 42,000 token 重算）
          //   ② 可用表情包（她收藏/发送表情、useCount 涨了就变）← 本次移出
          //
          // 剩下的两样是真的几乎不变：
          //   · 身份：QQ 号 + 昵称，除非换号
          //   · 令牌：只在她重置会话 / 轮换时才变
          //
          // 表情包改由 preset 引导她「新会话/刚压缩完时调一次 qq_list_stickers」。
          // 代价是首轮多一次工具往返，但换来的是整段对话的命中率。
          sendJson({ ok: true, key, text: parts.join('\n\n') });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recall') {
          // 原文库检索：给模型一个「翻旧账」的入口。
          //
          // 为什么放在桥接而不是 MCP 里直接读文件：原文库路径、会话隔离、令牌校验
          // 本来都在桥接这一层；MCP 进程只该拿到「我能看哪些 key」的结果。
          // 边界：会话令牌 + 当前模式白名单 + 严格按 key 隔离（不跨会话翻别人的聊天）。
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim();
          const token = String(req.headers['x-agent-token'] ?? '');
          const limit = Math.max(1, Math.min(10, Number(url.searchParams.get('limit')) || 3));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!isSessionAllowedInCurrentMode(key)) { sendJson({ ok: false, error: '当前模式不允许该会话' }, 403); return; }
          if (!q) { sendJson({ ok: false, error: 'q 不能为空' }, 400); return; }
          try {
            const recall = getRecall();
            const hits = recall.search(q, { key, limit });
            sendJson({ ok: true, key, query: q, count: hits.length, hits, text: recall.format(hits, { query: q }) });
          } catch (error) {
            sendJson({ ok: false, error: `检索失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/artifact') {
          // 产物索引（L3）：大块文本/代码/文件落盘，对话里只留 id + 描述。
          // 边界：只有 owner 私聊能用（群聊不需要文件柜）；scope 固定等于当前 key，
          // 取回时还要校验 sha256 —— 文件被改过就明说，不让模型拿旧记忆当原文。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(req.headers['x-agent-token'] ?? body.token ?? '');
          const action = String(body.action ?? 'list').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!isSessionAllowedInCurrentMode(key)) { sendJson({ ok: false, error: '当前模式不允许该会话' }, 403); return; }
          if (sessionTier(key, currentMode, cfg) !== 'owner') {
            sendJson({ ok: false, error: '产物索引只对管理员私聊开放' }, 403);
            return;
          }
          try {
            const store = getArtifacts();
            if (action === 'put') {
              const artifact = store.put({
                desc: body.desc,
                content: body.content,
                sourcePath: body.path,
                kind: body.kind,
                scope: key
              });
              sendJson({ ok: true, artifact });
            } else if (action === 'get') {
              const artifact = store.get(String(body.id ?? ''), { scope: key });
              sendJson({ ok: true, artifact });
            } else {
              sendJson({ ok: true, artifacts: store.list({ scope: key, limit: body.limit }) });
            }
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/qzone') {
          // QQ 空间（说说）：SnowLuma v2.2.0 自带 send_qzone_msg / get_qzone_msg_list，
          // 之前只是桥接没把它暴露出来。
          //
          // 边界：只有**管理员私聊**能用。空间是"以机器人身份对外发布"，不属于群聊能力；
          // 群友让机器人"发条说说"必须被拒绝。加上每日条数上限，避免刷屏式发布。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(req.headers['x-agent-token'] ?? body.token ?? '');
          const action = String(body.action ?? 'publish').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (cfg.socialV2?.qzone?.enabled !== true) {
            sendJson({ ok: false, error: 'QQ 空间功能未启用（config 的 socialV2.qzone.enabled 设为 true 才可用）' }, 403);
            return;
          }
          if (sessionTier(key, currentMode, cfg) !== 'owner') {
            sendJson({ ok: false, error: '只有管理员私聊可以用 QQ 空间' }, 403);
            return;
          }
          const qzSt = getSocialV2State(key);
          try {
            if (action === 'publish') {
              const content = String(body.content ?? '').trim();
              if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
              if (content.length > 1000) { sendJson({ ok: false, error: 'content 太长（上限 1000 字）' }, 400); return; }
              const max = Math.max(1, Number(cfg.socialV2?.qzone?.maxPerDay) || 2);
              const now = Date.now();
              qzSt.qzonePostTimes = (Array.isArray(qzSt.qzonePostTimes) ? qzSt.qzonePostTimes : [])
                .map(Number).filter((t) => Number.isFinite(t) && now - t < 86400000);
              if (qzSt.qzonePostTimes.length >= max) {
                sendJson({ ok: false, error: `今天已经发过 ${qzSt.qzonePostTimes.length} 条说说，上限 ${max} 条/天` }, 429);
                return;
              }
              const params = { content, ugc_right: Number(body.ugcRight) || 1 };
              if (Array.isArray(body.images) && body.images.length) {
                params.images = body.images.slice(0, 9).map(String);
              }
              if (Array.isArray(body.targetUins) && body.targetUins.length) {
                params.target_uins = body.targetUins.map(Number).filter(Number.isFinite);
              }
              const r = await onebotHttpAction('send_qzone_msg', params, { timeoutMs: 60000 });
              qzSt.qzonePostTimes.push(now);
              saveSocialV2State();
              appendActivity(`${key} [qzone] 发了说说：${content.slice(0, 40)}`);
              sendJson({ ok: true, tid: r?.data?.tid ?? null, time: r?.data?.time ?? now, used: qzSt.qzonePostTimes.length, max });
              return;
            }
            if (action === 'list') {
              const limit = Math.min(20, Math.max(1, Number(body.limit) || 5));
              try {
                const r = await onebotHttpAction('get_qzone_msg_list', { pos: 0, num: limit }, { timeoutMs: 30000 });
                sendJson({ ok: true, data: r?.data ?? { total: 0, msglist: [] } });
              } catch (error) {
                // SnowLuma 在「空间里一条说说都没有」时会回 msglist:null，并附一句
                // 「无法获取空间说说列表（响应结构异常）」的 wording。对调用方来说这就是
                // 空列表，不该当成故障 —— 否则新号 / 清空空间后永远读不到自己的说说。
                const msg = String(error?.message ?? error);
                if (msg.includes('无法获取空间说说列表')) {
                  sendJson({ ok: true, data: { total: 0, msglist: [] } });
                  return;
                }
                throw error;
              }
              return;
            }
            if (action === 'delete') {
              const tid = String(body.tid ?? '').trim();
              if (!tid) { sendJson({ ok: false, error: 'tid 不能为空（先 list 拿到）' }, 400); return; }
              await onebotHttpAction('delete_qzone_msg', { tid }, { timeoutMs: 30000 });
              appendActivity(`${key} [qzone] 删了一条说说：${tid}`);
              sendJson({ ok: true, tid });
              return;
            }
            sendJson({ ok: false, error: `不支持的动作：${action}（可用 publish / list / delete）` }, 400);
          } catch (error) {
            sendJson({ ok: false, error: `QQ 空间操作失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          // 2026-11-10 增量语义：**只返回还没展示给模型的那些**。
          //
          // 原来的现象：唤醒包已经内联了最近 12 条未读，模型紧接着调 get_unread，
          // 又拿回同一批消息的完整 JSON（实测 466 条返回里有 235 条是唤醒包刚给过的），
          // 单次最长 5359 字符，全会话白烧约 43k token。
          //
          // 判定口径复用 modelSeenSeqs —— 它就是"已经出现在模型上下文里"的回执集合，
          // 唤醒包投递成功后会把这批 seq 记进去（见 sendWakePromptV2 里的 noteModelMessagesV2）。
          //
          // 水位安全性：readThroughSeqV2 只在 `seen.has(seq)` 时才放行水位，
          // 而被这里过滤掉的消息**本来就在 seen 里**，该推的水位照样推得上去；
          // 真正没看过的消息依然不在 seen 里，水位不会越过它们。
          //
          // 兜底：includeSeen=1 强制返回全部（排查用）。想重看某条已展示过的消息应该用
          // qq_get_recent_messages / qq_get_message_detail，不要靠这个工具翻旧账。
          const includeSeen = url.searchParams.get('includeSeen') === '1';
          const seenSet = st.modelSeenSeqs instanceof Set ? st.modelSeenSeqs : new Set(st.modelSeenSeqs || []);
          const pool = includeSeen ? st.unread : st.unread.filter((m) => !seenSet.has(m.seq));
          const skippedSeen = st.unread.length - pool.length;
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? pool.slice(-limit)
            : pool.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          // 全部已在上下文里时给一句明确的话：否则模型看到 unreadCount>0 却拿到空数组，会反复重试。
          const allSeenHint = messages.length === 0 && skippedSeen > 0
            ? '剩下的未读都已经在【本轮消息】里了；不用再读，直接收尾即可。'
            : undefined;
          // 2026-11-11：返回**纯文本行**，与【本轮消息】同一套渲染（renderOneMessageLine）。
          // 原来返回原始消息对象数组，单条约 190 字符；同样信息一行约 60 字符。
          // 实测一次 15 条的积压：2850 字符 → 约 950 字符。
          //
          // 为什么不再返回结构化 messages：模型读它只是为了知道「谁、何时、说了什么」，
          // 不需要 isOwner/ownerLabel/media[].subType 这些字段名；而它们会逐字进历史、
          // 之后每一步都随上下文重发一遍。需要结构化字段的场景（看图要 messageId、
          // 查转发要 forwardIds）已经内联进文本行（`图id=` / `转发id=`）。
          //
          // 兼容：includeRaw=1 返回旧的 messages 数组（排查/外部脚本用，模型用不到）。
          const wantRaw = url.searchParams.get('includeRaw') === '1';
          const now = Date.now();
          const label = chatLabelForV2(key);
          const lines = messages.map((m) => renderOneMessageLine(compactModelMessage(m, { now }), { label }));
          // 2026-11-12：首行把「总数 / 已给过 / 本次新增」三个数字讲清楚。
          // 之前只写「1 条（另有 2 条已在【本轮消息】里）」，而 unreadCount 字段是 3，
          // 模型看到 3 却只读到 1 条会以为工具漏了，于是反复重读。
          const totalUnread = (st.unread || []).length;
          const head = messages.length
            ? `【未读】本次给你 ${messages.length} 条新的`
              + (skippedSeen > 0
                ? `（未读总数 ${totalUnread} 条，另外 ${skippedSeen} 条之前已在【本轮消息】里给过、不重复给），`
                : `（未读总数 ${totalUnread} 条），`)
              + `读到 #${readThroughSeq}`
            : skippedSeen > 0
              ? `【未读】本次没有新内容 —— 未读总数 ${totalUnread} 条，但全部 ${skippedSeen} 条都已经在【本轮消息】里给过你了，不用再读，直接收尾即可，读到 #${readThroughSeq}`
              : `【未读】没有未读消息，读到 #${readThroughSeq}`;
          const text = [head, ...lines].join('\n');
          sendJson({
            ok: true, key, unreadCount: st.unread.length, readThroughSeq,
            // 文本行是主输出；模型直接读它。
            text,
            ...(skippedSeen > 0 ? { skippedSeen } : {}),
            ...(allSeenHint ? { hint: allSeenHint } : {}),
            ...(wantRaw ? { messages } : {})
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          // 2026-11-12：和 /api/socialV2/unread 保持同一种返回格式 —— 纯文本行。
          //
          // 原来直接回 messages 数组，每条 20 个字段（messageId / quoteTargetIsSelf /
          // isOwner / media / forwardIds / hasForward / kind / tail …），limit=20 时
          // 单次能到 6000+ 字符，其中绝大多数字段她从来不看。
          // unread 早就是文本行了（"[群] #seq 谁·多久前：内容"），这里跟着改，两边一致。
          const now = Date.now();
          const label = chatLabelForV2(key);
          const lines = messages.map((m) => renderOneMessageLine(compactModelMessage(m, { now }), { label }));
          const head = messages.length
            ? `【最近 ${messages.length} 条】`
            : '（这个会话还没有消息）';
          sendJson({ ok: true, key, text: [head, ...lines].join('\n'), readThroughSeq });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          // 注意：不带 throughSeq 的调用会清空全部未读，这是**有意保留的兼容语义**
          // （旧 preset 与「没有水位」的收尾调用；见 acknowledgeMessagesV2 的注释与
          // test-token-economy 的 legacy 用例）。当前 preset 会明确要求带上 readThroughSeq 水位。
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // ── 收尾前观望：**已删除**（2026-11-15，操作者要求）────────────────
          //
          // 这里原来会 `await observeForCloseV2(st, key)` 空转 10~20 秒盯新消息，
          // 抓到就把那几条贴在返回里。现在整个去掉了，原因：
          //
          //   ① **它解决不了问题**。操作者实测：如果消息落在「两个工具调用之间」，
          //      它照样进 unread，然后要等**下一次**等待才被带出来 ——
          //      见 2026-11-15 那条 `【2 条新消息】#127 / #131` 的例子。
          //      也就是说观望只覆盖了"收尾这一瞬间"，覆盖不了真正的空隙，
          //      而空隙才是丢消息的地方。
          //   ② **它很贵**。每次收尾都白等 10 秒起步（连发时更久），一天上百次收尾
          //      就是几十分钟的纯空转；而这期间她什么也做不了。
          //   ③ 真要"等对方说完"，正确工具是 `qq_wait_for_messages(purpose="reply")`，
          //      它有明确的静默窗语义，而且是她**主动**要等。
          //
          // 删掉之后，收尾的行为回到最朴素的：算 uncovered → 没读的贴出来 → 标已读。
          // 如果当前已经是“潜水”唤醒配置，且还有**模型没看过**的消息，不允许用 mark_read 直接收尾，
          // 避免把没看到的消息一起标成已读。
          //
          // 但有一条常见路径必须放行：模型直接给出覆盖式水位（throughSeq 已盖过全部未读），
          // 那就是「一次读完并收尾」的合法写法。以前这里会再要求它调一次 qq_get_unread_messages，
          // 等于给收尾凭空加一次工具往返 —— 私聊连续来消息时，这一来一回正好把后续消息全堵在
          // 「会话繁忙」里，用户体感就是「回得特别慢」。
          const seenSet = st.modelSeenSeqs instanceof Set ? st.modelSeenSeqs : new Set(st.modelSeenSeqs || []);
          const uncovered = (st.unread || []).filter((m) => !seenSet.has(m.seq));
          const uncoveredSeq = uncovered.reduce((mx, m) => Math.max(mx, Number(m.seq) || 0), 0);
          const coverAll = Number.isSafeInteger(throughSeq) && throughSeq >= uncoveredSeq;
          log(`[mark] ${key} throughSeq=${throughSeq} uncovered=` + JSON.stringify(uncovered.map((m) => m.seq)) + ` uncoveredSeq=${uncoveredSeq} coverAll=${coverAll} sleeping=${isSleepingConfigV2(st.wakeConfig)} blocked=${preSleepWaitBlockedV2(st, key)}`);
          // 判定（2026-11-15 简化）：原来这里还有一道 `observedFresh.length > 0`
          // （「观望期间真的来了新消息」），随收尾观望一起删掉。现在只剩：
          // 「这个会话本来就该拦」（潜水配置 + 还有她没看过的消息），
          // 且她自己没给出覆盖式水位（!coverAll 防止"读完即收尾"被硬拦回去）。
          const blockedBySleep = isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st, key);
          if (!coverAll && blockedBySleep) {
            // ── 2026-11-12：不再返回"错误"，直接把没读的消息给她 ────────────────
            //
            // 原来的行为是 400 + 一段错误文案，让她「自己去调 get_unread 再回来」。
            // 两个问题：
            //   ① 那个文案写的是「还需等待约 X 分钟」（观察窗口早已退役，纯属误导），
            //      而 wait_for_messages 立刻返回 ⇒ 她陷入 mark_read ↔ wait 的死循环；
            //   ② 本来就是「她没看到这几条」这么简单的事，让模型为此多跑一轮
            //      往返、再自己拼一次请求 —— 每一步都要重发整段历史。
            //
            // 现在：一次调用直接把**没读的那几条**按【本轮消息】的同一套格式贴回来，
            // 并告诉她「读完照常再 mark_read 一次就收尾了」。省掉一轮工具往返。
            //
            // 仍然返回 ok:false（因为它确实没标成功，不能骗它说收尾了），
            // 但把内容放在 `text` 里，模型直接读即可。
            const now = Date.now();
            const label = chatLabelForV2(key);
            // 贴给她那一批 = uncovered（她没看过的未读）。2026-11-15 收尾观望删掉后
            // 不再需要跟 observedFresh 取并集，直接用它，顺序按 seq 升序。
            const merged = uncovered.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
            const lines = merged.map((m) => renderOneMessageLine(compactModelMessage(m, { now }), { label }));
            const maxSeq = merged.reduce((mx, m) => Math.max(mx, Number(m.seq) || 0), 0);
            const totalUnread = (st.unread || []).length;
            const seenCount = Math.max(0, totalUnread - uncovered.length);
            // ⚠️ 关键（2026-11-12 修重复）：**贴出去就等于她看过了**。
            // 以前不记这一笔，于是 she 立刻再调 mark_read / set_wake_config 时，
            // 这批消息仍被判为"没读过"，又被完整贴一遍 —— 实测连着三轮同一条消息。
            // 记进 modelSeenSeqs 之后，下一次调用只会贴「这之后新到的」。
            try { noteModelMessagesV2(st, merged); } catch { /* 记录失败不影响本次返回 */ }
            // 2026-11-12：不再报"未读总数 / 另外 N 条已在【本轮消息】里"。
            // 那两个数字每次调用都在变（群友在持续说话、她已经看过一部分），
            // 既解释不清也没有决策价值 —— 她只需要知道「下面这几条是新的」。
            const head = `【${merged.length} 条新消息】`;
            const text = [head, ...lines].join('\n');
            // 观望期间被压掉的唤醒要补排：这批消息虽然贴给她了，但她**还没处理**，
            // 万一这一轮她因为别的原因没接上（比如马上又要收尾），也该有一次唤醒兜底。
            // 注意：贴出后已记进 modelSeenSeqs，所以下面这个判断会因此为假 ——
            // 这是有意的：贴过就等于她已经看见了，不再重复叫醒。
            try { resumeWakeAfterObserveV2(key); } catch { /* 补排失败不影响本次返回 */ }
            sendJson({
              ok: false,
              error: `还有 ${merged.length} 条没读，已经贴在下面了。`,
              text,
              uncoveredCount: merged.length,
              uncoveredSeq: maxSeq,
              suggestedThroughSeq: maxSeq
            }, 400);
            return;
          }
          const markedCount = acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          // ⚠️ 2026-11-11 修：这里原来写 confirmedBy = 'mark_read'，
          // 而 refreshDefaultWakeConfigV2() 只刷新 confirmedBy === 'default' 的会话 ——
          // 于是「她收尾过一次」就永久冻结了这个会话的唤醒配置，控制台的
          // 「推荐值」（比如关掉提问唤醒）从此再也管不到它。
          //
          // 实测症状：操作者把控制台的"推荐提问唤醒"取消勾选，群里一个问号仍然叫醒她，
          // 因为该会话的 triggers.question 早在某次 mark_read 时就被冻成 true 了。
          //
          // 语义上 mark_read 只是"我看完了"，不是"我改过唤醒配置"。所以这里**不动**
          // confirmedBy：让它保持 'default'，继续跟随全局推荐值。
          // 真正表示"我显式设置过"的只有 qq_set_wake_config（那边会写 'set_wake_config'）。
          if (!st.wakeConfig.confirmedBy) st.wakeConfig.confirmedBy = 'default';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          // 2026-11-10 瘦身：原来回显 wakeGuaranteed + wakeSafety + 完整 wakeConfig，
          // 单次 441 字符，全会话 268 次调用累计约 118k 字符（≈66k token）。
          // 那些字段是**常驻不变**的配置快照，模型第一次看过就够了；要查实时配置有
          // qq_social_state / qq_set_wake_config，不必每次收尾都回放。
          // 保留的四个字段是收尾真正会用到的：是否成功、标了几条、下一步水位、还剩多少未读。
          // 2026-11-12 精简：只回一行纯文本。
          // 砍掉的字段：
          //   · key —— 她传进来的，原样返回纯噪音
          //   · markedCount / readThroughSeq —— 那句话里已经说了数字
          //   · unreadCount —— **没用**：还有未读时走上面的拦截分支把正文贴给她，
          //     能走到这里的成功分支，未读一定是 0。这个字段永远说同一件事。
          sendJson({
            ok: true,
            text: markedCount > 0
              ? `✅ 收尾完成：标记 ${markedCount} 条已读，读到 #${readThroughSeqV2(st)}。`
              : `✅ 收尾完成：读到 #${readThroughSeqV2(st)}（没有新的要标记）。`
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
              ...pickWakeTriggersV2(inputTriggers, current.triggers),
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // ── 设置潜水前观望：**已删除**（2026-11-15，操作者要求）────────────
          // 与 mark_read 那处同一个决定，理由也相同（见那边的长注释）：
          // 观望覆盖不了「两个工具调用之间」的空隙，却很贵，所以整个去掉。
          // ── 沉睡前拦截（2026-11-12：改成"直接贴出没读的消息"）──────────────
          // 与 mark_read 用同一个 preSleepWaitBlockedV2，判定只有三条：
          //   ① preSleepWaitEnabled !== false ② 最近没有结束语 ③ st.unread 里有没展示的
          // 只要 ③ 成立就拦。**没有任何时间条件**（观察窗口已退役）。
          //
          // 原来返回 400 + 「还需等待约 X 分钟」的文案：那个数字是假的，
          // 而 wait_for_messages 立刻返回 ⇒ 模型只会白转一圈再撞同一面墙。
          // 现在直接把没读的几条贴出来，读完即可重新设置。
          //
          // 2026-11-15：收尾观望删掉后，这里只剩 blockedBySleep 一道门
          //（原来还有个 blockedByObserve，依赖观望抓到的消息，已经不存在）。
          const blockedBySleep = isSleepingConfigV2(next) && preSleepWaitBlockedV2(st, key);
          if (blockedBySleep) {
            const seenSet = st.modelSeenSeqs instanceof Set ? st.modelSeenSeqs : new Set(st.modelSeenSeqs || []);
            const uncovered = (st.unread || []).filter((m) => !seenSet.has(m.seq));
            // 同 mark_read：直接贴 uncovered，按 seq 升序。
            const merged = uncovered.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
            const uncoveredSeq = merged.reduce((mx, m) => Math.max(mx, Number(m.seq) || 0), 0);
            const now = Date.now();
            const label = chatLabelForV2(key);
            const lines = merged.map((m) => renderOneMessageLine(compactModelMessage(m, { now }), { label }));
            const totalUnread = (st.unread || []).length;
            const seenCount = Math.max(0, totalUnread - uncovered.length);
            // 同上：贴出即视为看过，避免下一次调用重复贴同一批。
            try { noteModelMessagesV2(st, merged); } catch { /* ignore */ }
            // 同上：不报总数之类的动态数字，只说「下面这几条是新的」。
            const head = `【${merged.length} 条新消息】`;
            sendJson({
              ok: false,
              error: `还没设置潜水：下面这 ${merged.length} 条你还没读过，已经直接贴给你了。`,
              text: [head, ...lines].join('\n'),
              uncoveredCount: merged.length,
              uncoveredSeq,
              suggestedThroughSeq: uncoveredSeq
            }, 400);
            return;
          }
          const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          clearGroupPendingWake(key);
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          // 2026-11-12 精简：成功回执只给一行纯文本。
          //   · key / ok —— 她自己传的、成功时恒定 true，纯噪音
          //   · markedCount / readThroughSeq —— 下面那句话里已经说了
          //   · unreadCount —— **没用**：还有未读时根本走不到这个分支
          //     （上面的拦截分支会把正文直接贴给她），能走到这里就一定是 0
          // 她只需要知道"收尾成功了 + 现在是什么唤醒状态"。
          const modeText = next.infinite ? '无限期潜水' : '有限期潜水';
          const tr = next.triggers || {};
          const onOff = (v) => (v ? '✓' : '✗');
          const kwText = Array.isArray(tr.keywords) && tr.keywords.length
            ? `[${tr.keywords.join('/')}]`
            : '[无]';
          const probPct = Math.round((Number(tr.probability) || 0) * 100);
          const wakeSummary = `@${onOff(tr.atMention)} 名字${onOff(tr.nameMention)} 关键词${kwText} `
            + `拍一拍${onOff(tr.poke)} 概率${probPct}%`
            + (Array.isArray(tr.speakerIds) && tr.speakerIds.length ? ` 只等${tr.speakerIds.length}人` : '');
          sendJson({
            ok: true,
            text: `✅ 收尾完成：标记 ${markedCount} 条已读，${modeText}，读到 #${readThroughSeqV2(st)}。`
              + `\n当前唤醒：${wakeSummary}`
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          clearGroupPendingWake(key);
          // 第一次唤醒必须走 bootstrap：只有 bootstrap 那条 prompt 会带上操作者为这个会话
          // 预写的初始提示词（群环境/氛围，见 formatInitialPromptV2）。若用手动唤醒的
          // admin 文案顶掉它，这个会话就永远拿不到那段背景了。
          //
          // ⚠️ 这跟"要不要给冷启动那两句提示"**无关** —— 那个只看 coldStartRegistry。
          // 这里保留组级判定只是因为初始提示词同样"整组只该注入一次"。
          const firstWake = !groupBootstrapSent(key);
          if (firstWake) markGroupBootstrapSent(key);
          const effectiveReason = firstWake ? 'bootstrap' : reason;
          saveSocialV2State();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void sendWakePromptV2(key, effectiveReason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
          log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
          sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
          return;
        }
        // 操作者预写的「会话初始提示词」：控制台专用（AI 既读不到也改不了 —— adminOnlyV2Paths）。
        // 内容只在该会话**首次唤醒**（bootstrap）时注入一次，见 buildWakePromptV2。
        if (url.pathname === '/api/socialV2/initial-prompt' && (req.method === 'GET' || req.method === 'POST')) {
          if (req.method === 'GET') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            if (!key) {
              const entries = [...initialPrompts.entries()]
                .map(([entryKey, entry]) => ({
                  key: entryKey,
                  chars: entry.text.length,
                  createdAt: entry.createdAt || 0,
                  updatedAt: entry.updatedAt || 0,
                  preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
                }))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
              sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: initialPromptsWritable });
              return;
            }
            const canonical = canonicalV2Key(key);
            if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const entry = initialPrompts.get(canonical) ?? null;
            sendJson({
              ok: true,
              key: canonical,
              exists: !!entry,
              text: entry?.text ?? '',
              createdAt: entry?.createdAt || 0,
              updatedAt: entry?.updatedAt || 0,
              maxChars: initialPromptMaxChars(),
              writable: initialPromptsWritable
            });
            return;
          }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const explicitDelete = body.delete === true;
          // 只接受 { key, text: string } 或 { key, delete: true }：
          // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
          if (!explicitDelete && typeof body.text !== 'string') {
            sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
            return;
          }
          const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
          if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return; }
          log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
          sendJson({
            ok: true,
            key: result.key,
            deleted: result.deleted,
            chars: result.chars,
            exists: !!result.entry,
            updatedAt: result.entry?.updatedAt || 0,
            maxChars: initialPromptMaxChars()
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            const auditMsg = auditOutbound(msg, { level: auditLevelFor(key), knownTokens: KNOWN_AGENT_TOKENS });
            if (auditMsg.blocked) {
              sendJson({ ok: false, error: `消息含${auditMsg.reason}，已阻止发送` }, 403);
              return;
            }
          }
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            noteSendCallV2(st, now);  // 节流按"调用"记账，不按条数
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages, sentMessages?.ids);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            // 发送后空转：代替"节流拦截"，只让这次调用慢一点，不产生额外回合。
            // 发送后空转 + 观察新消息（2026-11-14）：
            // 空转期间有新消息就提前结束，把那几条按【本轮消息】同格式带回去，
            // 让她能在同一个回合里接着回 —— 省掉一次完整唤醒。
            let postSendObserve = null;
            if (sentMessages.length > 0) {
              postSendObserve = await paceAfterSendV2(st, key, Date.now());
            }
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            // 2026-11-14 操作者要求：**不再回任何发送后提示**（warn / splitWarn）。
            // 理由：消息已经发出去了，事后再告诉她"第 1、2 条之间像把一句话拆开了"
            // 或者"消息内部有中文空格"，她既不能撤回、也没法改，纯属事后指责；
            // 而且每轮都往上下文里塞一句，白烧 token。这些检查（findCjkSpaceWarning /
            // findSplitBoundaryWarning）连同函数本体一起删掉了，见下方注释。
            sendJson({ ok: true, key, ...(postSendObserve?.text ? { text: postSendObserve.text, arrived: true, arrivedCount: postSendObserve.count } : {}), sent: sentMessages.length, failed: messages.length - sentMessages.length });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent, error?.sentIds);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            const auditMsg = auditOutbound(msg, { level: auditLevelFor(key), knownTokens: KNOWN_AGENT_TOKENS });
            if (auditMsg.blocked) {
              sendJson({ ok: false, error: `消息含${auditMsg.reason}，已阻止发送` }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }

          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          noteSendCallV2(st, now);  // 节流按"调用"记账，不按条数
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages, sentMessages?.ids);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            // 发送后空转：代替"节流拦截"，只让这次调用慢一点，不产生额外回合。
            // 发送后空转 + 观察新消息（2026-11-14）：
            // 空转期间有新消息就提前结束，把那几条按【本轮消息】同格式带回去，
            // 让她能在同一个回合里接着回 —— 省掉一次完整唤醒。
            let postSendObserve = null;
            if (sentMessages.length > 0) {
              postSendObserve = await paceAfterSendV2(st, key, Date.now());
            }
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            // 同上（send-message 路径）：不再回发送后提示，见 send-burst 那处的说明。
            sendJson({ ok: true, key, ...(postSendObserve?.text ? { text: postSendObserve.text, arrived: true, arrivedCount: postSendObserve.count } : {}), sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent, error?.sentIds);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 撤回（qq_recall_message）──────────────────────────────────────
        //
        // 操作者定的方式：**她按原文输入，桥接自动判断是哪一条**。
        //
        // 为什么不用 seq / messageId：
        //   · 她自己的消息**没有 seq**（seq 是入站未读水位的编号）；
        //   · messageId 是一长串可能为负的数字，让她记没意义。
        //   她复述自己刚说过的话，是最自然、也不需要动上下文格式的方式。
        //
        // 输入：{ key, text }。输出：成功一句 `✅ 已撤回`，失败一句中文原因。
        //
        // 超过 2 分钟直接不管（QQ 撤回时限就是 2 分钟）—— 提前拦下省一次网络往返。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/recall-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '撤回必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停' }, 403); return; }
          const wantText = String(body.text ?? '').trim();
          if (!wantText) {
            sendJson({ ok: false, error: '要撤回哪句？把她说过的那句原文传进来' }, 400);
            return;
          }
          if (wantText.length > 500) {
            sendJson({ ok: false, error: '原文太长，传那句话的关键部分就行' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          const receipt = findReceiptByTextV2(st, wantText);
          if (!receipt) {
            // 没有匹配 ⇒ 要么不是这个会话发的、要么早就撤过了。
            sendJson({ ok: false, error: '没找到这句（只记得最近 2 分钟内自己发的内容）' }, 400);
            return;
          }
          const ageMs = Date.now() - Number(receipt.at || 0);
          if (ageMs > RECALL_WINDOW_MS) {
            // 超过 2 分钟：操作者要求"别管了"，直接给一句话，不做任何尝试。
            sendJson({ ok: false, error: '超过 2 分钟，撤不回了' }, 400);
            return;
          }
          try {
            await onebotHttpAction('delete_msg', { message_id: Number(receipt.id) });
            dropSentReceiptV2(st, receipt);
            // recentMessages 里那条**保留**：她的上下文里还在，抹掉反而对不上；
            // 原文库是事实来源，撤回只影响 QQ 侧。
            saveSocialV2State();
            log(`[recall] ${key} 撤回「${String(receipt.text).slice(0, 20)}」（message_id=${receipt.id}，${Math.round(ageMs / 1000)}s 前发出）`);
            sendJson({ ok: true, text: '✅ 已撤回' });
          } catch (error) {
            const raw = String(error?.message ?? error);
            const text = /not found or not retractable/i.test(raw) ? '这条撤不了（可能已过期）'
              : /no authoritative QQ sequence/i.test(raw) ? '这条撤不了（QQ 没给可撤回的序列号）'
              : `撤回失败：${raw}`;
            sendJson({ ok: false, error: text }, 400);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          // 2026-11-17：**targetUserId 允许传昵称，自动换成 QQ 号**。
          //
          // 实测她传了 targetUserId="Ap0LoG1zE"（那是昵称，不是号），被这里拒了。
          // 消息行里只有昵称没有号，她照抄昵称是很自然的动作 —— 与其让她先查一次
          // qq_get_userid 再来拍（多一次工具往返），不如在这里直接用别名表换掉。
          //
          // 只在**唯一命中**时才换：昵称可能重复（同名/包含关系），
          // 猜错会把拍一拍发给别人，比报错难查得多。
          let resolvedTarget = targetUserId;
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            let candidates = [];
            try { candidates = lookupAliasV2(targetUserId) || []; } catch { candidates = []; }
            // 精确匹配优先：primary 或不区分大小写完全相等
            const exact = candidates.filter((c) => c.userId === targetUserId
              || String(c.primary).toLowerCase() === targetUserId.toLowerCase()
              || (c.names || []).some((n) => String(n).toLowerCase() === targetUserId.toLowerCase()));
            const pick = exact.length === 1 ? exact[0] : (candidates.length === 1 ? candidates[0] : null);
            if (!pick) {
              const hint = candidates.length > 1
                ? `「${targetUserId}」对应多个人（${candidates.slice(0, 3).map((c) => `${c.primary}/${c.userId}`).join('、')}），请用 qq_get_userid 确认后传 QQ 号`
                : `「${targetUserId}」不是一个 QQ 号，也没有对应的已知成员；先用 qq_get_userid(query=…）换成号`;
              sendJson({ ok: false, error: hint }, 400);
              return;
            }
            resolvedTarget = pick.userId;
          }
          const finalTarget = resolvedTarget;
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, finalTarget);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }

          st.sendTimes.push(now);
          noteSendCallV2(st, now);  // 节流按"调用"记账，不按条数
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
          // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
          const sendGuard = captureSendGuard(key);
          try {
            sendGuard();
            if (shouldBlockSilentReply(key)) {
              const blocked = new Error('静默模式已开启，当前不允许拍一拍');
              blocked.statusCode = 403;
              throw blocked;
            }
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(finalTarget) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            // 显示名用**她传的那个标签**（昵称），不是换出来的 QQ 号 ——
            // 她自己看到的记录要和她说的话对得上（"我拍了拍 Ap0LoG1zE"）。
            const pokeTargetLabel = String(body.targetLabel ?? '').trim()
              || (finalTarget !== targetUserId ? targetUserId : finalTarget);
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${pokeTargetLabel}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              // targetId 记**真实 QQ 号**（后续逻辑要拿它判断"拍的是谁"）。
              poke: { targetId: finalTarget || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            // 日志记**真实 QQ 号**：出问题时要知道到底拍到了谁（传昵称时尤其重要）。
            const logTarget = finalTarget !== targetUserId ? `${finalTarget}(原传 ${targetUserId})` : finalTarget;
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + logTarget : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + logTarget : ''}`);
            // 2026-11-12 精简：原来回 {ok, key, kind, targetUserId} —— 四个字段全是回显。
            //   ok            成功时恒 true
            //   key           她自己传的
            //   kind          group/private，她本来就知道自己在哪个会话
            //   targetUserId  她自己传的（私聊时是 id）
            // 她真正需要知道的只有一件事：拍到了没有。失败走 error 分支。
            sendJson({ ok: true, text: kind === 'group' ? '✅ 已拍一拍。' : '✅ 已拍了拍对方。' });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            const prep = await toModelMedia(fetched.buffer, mimeType, `收藏表情 ${entry.id}`);
            if (!prep.ok) {
              sendJson({ ok: false, error: `表情图片无法提供给模型：${prep.error}` }, 413);
              return;
            }
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType: prep.mimeType, data: prep.buffer.toString('base64') },
              ...(prep.note ? { note: prep.note } : {})
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-file') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const fc = fileCfg();
          if (!fc.enabled) { sendJson({ ok: false, error: '发文件功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 🔒 档位闸门：只有 Owner 档能发文件。走 sessionTier() 而不是自己比 ownerQQ ——
          // 档位口径只有一处（那里还含 deny 优先、前导零归一、群聊不升档等规则）。
          if (sessionTier(key, currentMode, cfg) !== 'owner') {
            sendJson({ ok: false, error: '发文件仅限管理员本人私聊（Owner 档）：群聊与白名单会话不能外发本机文件' }, 403);
            return;
          }
          if (!v2ToolEnabled('sendFile')) { sendJson({ ok: false, error: '工具未启用：qq_send_file' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          try {
            fileBudgetCheck(key, fc);
            const sent = await sendFileV2(key, body.path ?? body.filePath ?? body.file ?? '', { guard: true });
            fileBudgetCommit(key);
            recordFileSentV2(key, sent);
            const kb = Math.max(1, Math.round(sent.bytes / 1024));
            appendActivity(`${key} [reserved2] 发送文件：${sent.name}（${kb} KB）`);
            log(`已发送文件到 ${key}：${sent.name}（${kb} KB，file_id=${sent.fileId ?? '?'}）`);
            sendJson({ ok: true, key, file: sent.name, bytes: sent.bytes, fileId: sent.fileId });
          } catch (error) {
            // 额度只在真正发出后记账（fileBudgetCommit）⇒ 失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          // 表情不占文字发送配额（用户要求表情全开放）：
          // 既不做全局限流检查，也不写 sendTimes —— 否则一张表情会吃掉一条文字消息的额度。
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 通道）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, text: renderStickerListText({ ...list, query }), syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, text: renderStickerListText({ ...list, query }), syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        //
        // withUrl: true —— 这是**面板**（人看的），必须带图片地址才能渲染缩略图。
        // 模型走 /api/socialV2/sticker-list，那边保持精简（不带 url 省 token）。
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count, { withUrl: true });
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false, writable: stickerStoreWritable });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            // 删除后用 HTTP 重新同步：WS 侧的列表是旧的，用它判断"删没删掉"永远为否。
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/upload') {
          // 上传一张本地图片，直接加进**QQ 账号的收藏表情**（OneBot add_custom_face）。
          //
          // 为什么不自建"本地素材库 + 图片段发送"：加进收藏后这张图会自动出现在
          // qq_list_stickers 的结果里，因而既进得了 AI 的表情提示词（buildStickerContext），
          // 又能直接走既有的 sendStickerV2（含限流、引用、真人停顿、使用统计），
          // 不需要在桥接里再维护一条平行的发送链路。
          //
          // 与 collectStickerV2 一致：把字节转成 base64 交给网关，绝不让它自己去下载 URL。
          const body = await readBody();
          const raw = String(body.data ?? '').trim();
          const note = String(body.note ?? '').trim().slice(0, 50);
          if (!raw) { sendJson({ ok: false, error: 'data 不能为空（base64 或 data:image/...;base64,...）' }, 400); return; }
          let base64 = raw;
          const dataUri = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/is.exec(raw);
          if (dataUri) base64 = dataUri[2];
          base64 = base64.replace(/\s/g, '');
          if (!/^[A-Za-z0-9+/=]+$/.test(base64)) { sendJson({ ok: false, error: '不是合法的 base64 数据' }, 400); return; }
          let buffer;
          try {
            buffer = Buffer.from(base64, 'base64');
          } catch (error) {
            sendJson({ ok: false, error: `base64 解码失败：${error?.message ?? error}` }, 400);
            return;
          }
          if (!buffer.length) { sendJson({ ok: false, error: '解码后是空数据' }, 400); return; }
          const maxBytes = Math.max(64 * 1024, Number(cfg.socialV2?.sticker?.uploadMaxBytes) || 2 * 1024 * 1024);
          if (buffer.length > maxBytes) {
            sendJson({ ok: false, error: `图片 ${(buffer.length / 1048576).toFixed(2)}MB 超过上限 ${(maxBytes / 1048576).toFixed(1)}MB（可在 config.json 的 socialV2.sticker.uploadMaxBytes 调整）` }, 413);
            return;
          }
          if (!looksLikeImageBuffer(buffer)) {
            sendJson({ ok: false, error: '这不是可识别的图片（QQ 收藏表情支持 png / jpg / gif）' }, 400);
            return;
          }
          try {
            const addRes = await bot.request('add_custom_face', { file: 'base64://' + buffer.toString('base64') });
            if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
              throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}（QQ 收藏表情可能有数量上限）`);
            }
            const emojiId = String(addRes.data?.emoji_id || '');
            if (note && emojiId) {
              try {
                await bot.request('modify_custom_face', { emoji_id: emojiId, desc: note });
              } catch (error) {
                log(`[sticker] 上传后写备注失败（不影响收藏）：${error?.message ?? error}`);
              }
            }
            // 删除后用 HTTP 重新同步：WS 侧的列表是旧的，用它判断"删没删掉"永远为否。
            const synced = await syncStickerLibrary(true);
            const entry = emojiId ? findSticker(synced?.entries ?? stickerEntries, emojiId) : null;
            log(`[sticker] 上传表情成功 emojiId=${emojiId || '(未知)'} ${buffer.length}B${note ? ` 备注=${note}` : ''}`);
            appendActivity(`[sticker] 控制台上传表情：${note || emojiId || '新表情'}`);
            sendJson({ ok: true, emojiId, sticker: entry, total: synced?.entries?.length ?? stickerEntries.length });
          } catch (error) {
            sendJson({ ok: false, error: `上传表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/delete') {
          // 从 QQ 账号里删掉一张收藏表情（OneBot delete_custom_face）。
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const delRes = await bot.request('delete_custom_face', { emoji_id: stickerId });
            if (!delRes || delRes.status !== 'ok' || delRes.retcode !== 0) {
              throw new Error(`delete_custom_face 失败: ${delRes?.wording || delRes?.retcode || 'unknown'}`);
            }
            // 删除后用 HTTP 重新同步：WS 侧的列表是旧的，用它判断"删没删掉"永远为否。
            const synced = await syncStickerLibrary(true, { preferHttp: true });
            log(`[sticker] 删除表情 ${stickerId}`);
            appendActivity(`[sticker] 控制台删除表情：${stickerId}`);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length });
          } catch (error) {
            sendJson({ ok: false, error: `删除表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // ── 等待的真实语义（2026-11-12 重写）─────────────────────────────
          //
          // 旧行为：purpose="messages" 且 timeout>10s 时**直接返回**（passive），
          // 理由是"不该在 HTTP 里干等"。副作用是她几乎从不真正等 ——
          // 实测 73 次调用里 40 次走这条路，等于"发一句马上接下一句"，
          // 对方还没打完字她就回了。
          //
          // 现在两种 purpose 都真的等，只是等的目标不同：
          //   · reply    —— 等对方**把话说完**（静默窗口），然后她才回；
          //   · messages —— 等**下一条消息**（或静默窗口耗尽）。
          // 上限仍受 timeoutMs 约束，不会无限挂起；有租约防并发。
          //
          // 唯一保留的"秒回"情形：timeoutMs 被传到 ≤10 秒（她自己要求短等）。
          // ── 等待真的等（2026-11-12 重写）───────────────────────────────
          // 旧行为：purpose="messages" 且 timeout>10s 时直接返回（passive），
          // 副作用是她几乎从不真正等 —— 实测 73 次调用里 40 次走这条路，
          // 等于"发一句马上接下一句"，对方还没打完字她就回了。
          // 现在两种 purpose 都真的等，只把上限夹到 60 秒防占死 handler。
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约按**归一后的** key 记账：`group:0123` 与 `group:123` 是同一个会话，
          // 用原始 key 会给出两个租约槽（同一会话并发多个 5~10 分钟等待、互相踩水位）。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          const leaseKey = canonicalV2Key(key) ?? key;
          if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          const leaseStamp = Date.now();
          activeWaits.set(leaseKey, leaseStamp);
          // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
          const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
          req.on('close', finishWait);
          // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回一个 JSON，
          // 那条路径不会经过下面的 finishWait()，会留下 15 分钟的假 429。
          res.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          clearGroupPendingWake(key);
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = preSleepWaitMsForV2(key);
          // 闸门状态只算一次：既用于 preSleepWaitRemainingMs，也用于下面直接告诉模型"现在能不能收尾"。
          const preSleepBlocked = preSleepWaitBlockedV2(st, key);
          const preSleepRemainingMs = preSleepBlocked
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          // 这次等待「算不算沉睡前观察」：闸门只认单次 timeoutMs ≥ 观察窗口的调用。
          // 实测踩过：模型用 timeoutMs=90000 等了 90 秒，以为完成了观察，结果闸门不认，
          // 只能再补一次 180 秒 —— 白花一轮。所以要在返回里把这件事说破，而不是让它自己悟。
          const preSleepCountsAsObservation = !replyWait && timeoutMs >= preSleepWaitMs;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          // ── 漏消息窗口（2026-10-18 修）──────────────────────────────────
          //
          // 旧实现按 `seq > baseline` 取"本次等待期间新到的"，而 baseline 对普通等待是
          // **请求开始时的 lastUnreadSeq**。于是「模型思考/发消息那几秒里到达的消息」
          // 永远落在窗口外：本次不返回、下次请求的 baseline 已经越过它们 ⇒ 既没展示给模型，
          // 也没进 readThroughSeq（连续游标）⇒ 水位从此卡死。
          // 实测：会话末段 readThroughSeq 钉在 185，可模型已经看过 205，
          // 之后每次等待都要多读一次 unread 才能收尾；期间有人 @ 也完全没进本回合。
          //
          // 现在按**已读过水位**取：凡是没有进入 readThroughSeq 的消息，一律补给它。
          // `arrived` 仍按 requestSeq 判（"有没有新动静"语义不变），所以等待不会变成忙轮询；
          // 只要这次确实返回了，返回的就是「从水位起连续的一段」，模型据此能正常推进水位。
          const watermarkAtRequest = readThroughSeqV2(st);
          const pendingFloor = Math.min(baseline, watermarkAtRequest);
          const fullPending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > pendingFloor)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // 有上限：一次倒 30 条旧账会把上下文挤爆。**必须从最老的开始取**（连续，
          // 水位才推得动）；被截断时 partial=true，提示模型用 unread 工具续读。
          const waitCap = Math.min(50, Math.max(12, Number(cfg.socialV2?.context?.unreadLimit) || 30));
          const pending = fullPending.length > waitCap ? fullPending.slice(0, waitCap) : fullPending;
          const pendingTruncated = fullPending.length > pending.length;
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          // ── 2026-11-13：整块返回压成纯文本 ──────────────────────────────
          //
          // 原来回 21 个字段（purpose/quiet/quietMs/suggestedQuietMs/speakerLikelyDone/
          // timeout/waitedMs/preSleepWaitSatisfied/preSleepWaitObserved/preSleepWaitMs/
          // preSleepWaitRemainingMs/canSleepNow/countsAsObservation/hint/…），
          // 其中 5 个是**已退役的观察窗口**遗留，其余大多是内部状态。
          // 她真正需要的只有三样：有没有等到、等到了什么、水位到哪。
          //
          // 现在与 get_unread 统一成同一套文本行，引导写进末尾。
          const nowMs = Date.now();
          const label = chatLabelForV2(key);
          const lines = newMessages.map((m) => renderOneMessageLine(compactModelMessage(m, { now: nowMs }), { label }));
          const head = newMessages.length
            ? `【等到了 ${newMessages.length} 条】，读到 #${readThroughSeq}`
            : `【没等到新消息】，读到 #${readThroughSeq}`;
          const tailBits = [];
          if (replyWait) {
            // 回复前静默：告诉她对方大概说完了没有，决定要不要现在回。
            tailBits.push(quiet ? '对方大概说完了，可以回。' : '对方可能还没说完。');
            if (lastMessageUnfinished) tailBits.push('最后一句像是没说完。');
          } else if (preSleepBlocked) {
            tailBits.push(`还有 ${(st.unread || []).length} 条没读过，读完再收尾。`);
          } else {
            tailBits.push('可以直接收尾：qq_mark_read 或 qq_set_wake_config。');
          }
          if (pendingTruncated) tailBits.push('（更早的消息没显示完，可用 qq_get_unread_messages 继续读）');
          const text = [head, ...lines, tailBits.join(' ')].filter(Boolean).join('\n');
          sendJson({
            ok: true, key, arrived, newMessages, readThroughSeq,
            unreadCount: st.unread.length,
            text
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            // 本地正文同样只存前 200 字，但**未截断长度**必须留着：截断与否只能由它判断。
            // 以前用 text.length >= 200，恰好 200 字的完整消息会被误标成已截断，
            // 模型于是白跑一次 qq_get_message_full。
            const localInfo = (row) => {
              if (!row) return null;
              const full = String(row.text || row.plain || '');
              return {
                sender: String(row.sender || ''),
                text: full.slice(0, 200),
                textLength: full.length,
                userId: row.userId ? String(row.userId) : null,
                messageId: row.messageId ? String(row.messageId) : null,
                seq: row.seq
              };
            };
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = localInfo(found);
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) info = localInfo(found);
            }
            // 窗口外的 seq 既不在本地也不在 QQ 侧：以前返回 info:null，模型只会以为
            // 自己传错了 id，然后反复换 id 重试。这里给明确的 404 和当前可见范围。
            if (!info) {
              const rows = st.recentMessages || [];
              const seqs = rows.map((m) => Number(m?.seq)).filter(Number.isFinite);
              const range = seqs.length
                ? `（本地 seq ${Math.min(...seqs)}~${Math.max(...seqs)}，共 ${rows.length} 条）`
                : '';
              sendJson({
                ok: false,
                error: `查不到这条消息：本地最近记录里没有 ${messageId}${range}，按该 id 向 QQ 也取不到。要看当前可见范围请改用 qq_get_recent_messages / qq_get_unread_messages。`
              }, 404);
              return;
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (found) Object.assign(info, forwardFields);
            // textTruncated 由未截断长度判断，计算完就把内部字段摘掉（不让它进模型上下文）。
            const fullLen = Number(info.textLength);
            delete info.textLength;
            info.textTruncated = Number.isFinite(fullLen) && fullLen > String(info.text ?? '').length;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        // 单条消息完整原文：本地 social-v2.json / events 里的 text 都只存前 200 字，
        // 长消息（剧情、长吐槽）会被截断且看不出被截断。这里直接向 QQ 重新 get_msg，
        // 拿服务端的完整 message 段，把里面的 text 拼起来返回。
        // 安全边界：只允许查本会话确实收到过的 messageId（recent / unread 里出现过的）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-full') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该功能仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: '必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2ToolEnabled('getMessageDetail')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403);
            return;
          }
          // 只允许查本会话见过的那条，防止 AI 拿任意 messageId 去探测别人的消息。
          const stFull = getSocialV2State(key);
          const known = [...(stFull.recentMessages || []), ...(stFull.unread || [])]
            .some((m) => m && String(m.messageId ?? '') === messageId);
          if (!known) {
            sendJson({ ok: false, error: '该 messageId 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
            const res = await fetch(`${httpUrl}/get_msg`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
              },
              body: JSON.stringify({ message_id: Number(messageId) }),
              signal: AbortSignal.timeout(30000)
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
              sendJson({ ok: false, error: `QQ 拒绝读取该消息（retcode ${body.retcode ?? '?'}）` }, 502);
              return;
            }
            const segments = Array.isArray(body.data?.message) ? body.data.message : [];
            // 只取文本段；图片/语音/文件只报类型，不回传路径（避免把本机路径写进上下文）。
            const parts = [];
            const mediaKinds = [];
            for (const seg of segments) {
              const type = String(seg?.type || '');
              if (type === 'text') {
                const raw = seg?.data?.text;
                if (raw) parts.push(String(raw));
              } else if (type === 'json') {
                // 卡片消息整条只有一个 json 段、0 个 text 段。以前这里把它当纯媒体丢掉，
                // 于是 qq_get_message_full 对卡片返回 text:"" —— 模型按工具描述来「读全文」，
                // 结果拿到一片空白，还和 qq_get_message_detail 给出的摘要互相打架。
                // 卡片本来就没有「更长的原文」可读：能读到的就是这段 JSON 渲染出的摘要。
                mediaKinds.push(type);
                const cardData = seg?.data?.data;
                const rawCard = typeof cardData === 'string'
                  ? cardData
                  : (cardData && typeof cardData === 'object' ? JSON.stringify(cardData) : '');
                if (rawCard) {
                  try {
                    const cardLine = await summarizeCard(rawCard);
                    if (cardLine) parts.push(cardLine);
                  } catch { /* 卡片解析失败不影响其它段 */ }
                }
              } else if (type && !['reply', 'at'].includes(type)) {
                mediaKinds.push(type);
              }
            }
            const fullText = parts.join('');
            sendJson({
              ok: true,
              key,
              messageId,
              length: fullText.length,
              text: fullText,
              ...(mediaKinds.length ? { mediaKinds } : {}),
              note: fullText.length > 200
                ? '这是 QQ 服务端的完整原文（本地存储只保留前 200 字）。'
                : undefined
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取完整原文失败：${error?.message ?? error}` }, 502);
          }
          return;
        }


        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          // 可选上限：让模型在默认返回被截断时能主动要全文（qq_get_forward_msg 的 full 模式）。
          // 不传则维持上游默认（500 字 / 50 条）。
          const reqMaxChars = Number(url.searchParams.get('maxCharsPerMessage'));
          const reqMaxMsgs = Number(url.searchParams.get('maxMessages'));
          const skipMedia = url.searchParams.get('skipMedia') === '1';
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data, {
              ...(Number.isFinite(reqMaxChars) && reqMaxChars > 0 ? { maxCharsPerMessage: reqMaxChars } : {}),
              ...(Number.isFinite(reqMaxMsgs) && reqMaxMsgs > 0 ? { maxMessages: reqMaxMsgs } : {})
            });
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            // 截断提示写进返回体：模型看到的是序列化 JSON，一个布尔字段在长列表末尾
            // 很容易被忽略，实测它会把 500 字当成全文并据此判断「对方只写了这么多」。
            // 这里只说明事实和可选项，不强推——要不要读全文由它自己决定。
            const hints = [];
            if (formatted.textTruncated) {
              hints.push('正文被截断（每条上限 ' + (Number.isFinite(reqMaxChars) && reqMaxChars > 0 ? reqMaxChars : 500) + ' 字），后面还有内容没返回。');
            }
            if (formatted.truncated) {
              hints.push('共 ' + formatted.total + ' 条，本次只返回前 ' + (formatted.messages || []).length + ' 条。');
            }
            const truncationNote = hints.length
              ? hints.join(' ')
                + ' 读不读剩下那些，取决于你自己的感受：如果这段文本让你恶心、冒犯、不适，就别读了，'
                + '没必要勉强自己把别人的东西看完。确实想读完，才传 full:true 再调一次（每条最多 2000 字）。'
              : '';
            // skipMedia：不返回图片元数据，省 token
            if (skipMedia) {
              for (const m of formatted.messages || []) { if (m && typeof m === 'object') m.media = []; }
              for (const np of nestedPreviews || []) {
                for (const m of (np && np.messages) || []) { if (m && typeof m === 'object') m.media = []; }
              }
            }
            sendJson({
              ok: true, key, id, ...formatted,
              // 2026-11-11：主输出改成纯文本行（与【本轮消息】同风格）。
              // 原来整个 JSON 里带 media[].url（单条 400~600 字符的签名长链），
              // 40 条转发光 URL 就 2 万字符。模型只需要知道「这里有一张图」。
              text: renderForwardText(formatted),
              ...(truncationNote ? { truncationNote } : {}),
              ...(skipMedia ? { mediaSkipped: true } : {}),
              nestedPreviews
            });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          // 2026-11-12：新增 query —— **按昵称反查 QQ 号**。
          // 背景：消息行不再带 userId（那样每条多 18 字符），模型需要号时来这查。
          // 不带 query 时行为不变（返回最近活跃的人），只是现在多了别名表和更大的上限。
          const query = String(url.searchParams.get('query') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_userid' }, 403); return; }
          const st = getSocialV2State(key);
          // 优先用别名表（跨会话全量，包含所有见过的号）；
          // 没有别名记录的老数据再从 recentMessages 兜底。
          const aliasRows = (() => { try { return lookupAliasV2(query); } catch { return []; } })();
          if (aliasRows.length) {
            const rows = aliasRows.slice(0, limit).map((r) => ({
              userId: r.userId,
              name: r.primary,
              aliases: r.names.filter((n) => n !== r.primary),
              lastAt: r.lastAt
            }));
            // 纯文本一行一条（操作者指定格式 `昵称：userId:号码`）。
            const head = query
              ? `【查人】「${query}」命中 ${rows.length} 个`
              : `【已知的人】${rows.length} 个`;
            const lines = rows.map((r) => {
              const alias = r.aliases.length ? `（也叫 ${r.aliases.join('、')}）` : '';
              return `${r.name}：userId:${r.userId}${alias}`;
            });
            sendJson({
              ok: true, key, matched: rows.length, members: rows,
              text: [head, ...lines].join('\n')
            });
            return;
          }
          if (query) {
            // 别名表里没有：说明是没说过话、或者历史数据还没建表的人。
            sendJson({
              ok: true, key, matched: 0, members: [],
              text: `【查人】「${query}」没查到。可能他从没在这说过话；可以试试不带 query 列出全部已知的人。`
            });
            return;
          }
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          const text = members.length
            ? ['【最近活跃】' + members.length + ' 人', ...members.map((r) => `${r.sender}：userId:${r.userId || '未知'}`)].join('\n')
            : '【最近活跃】还没有人说过话';
          sendJson({ ok: true, key, members, text });
          return;
        }
        // ── 群成员列表（v2 读工具；替代只有 closed-agent 才能用的旧只读工具）────────
        //
        // 为什么需要这一条：qq-chat-v2 预设第 6 条明确要求「QQ 号从 qq_get_group_members 的
        // user_id 拿」，但旧版是无令牌工具、在 reserved2 下必然 403 —— 模型被自己的提示词
        // 引到一个永远失败的工具上（实测 turn10 白烧一步）。这里给它一个带会话令牌的 v2 形态。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const groupMatch = /^group:(\d+)$/.exec(key);
          if (!groupMatch) { sendJson({ ok: false, error: '群成员只能按 group:群号 查询' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          // ⚠️ 白名单/模式判定**不能**挂在「有令牌」条件里：closed-agent 的代理调用本来就不带令牌
          // （它走的是操作者路径），只按 header 判断会让它拿任意群号去枚举成员 ——
          // 那正是旧 qq_get_group_members 明确防住的事（先 legacyReadToolAllowed 再 isAllowed）。
          //
          // 也不能直接用 v2SessionAllowed：它的 closed-agent 分支只放行 `private:<ownerQQ>`，
          // 于是「管理员在私聊里让 AI 看看某群成员」会 403 —— 那是旧工具本来支持的能力，
          // 属于这次改动不该带走的回归。所以 closed-agent 下按**同样严格的白名单**放行群读取。
          const groupMembersAllowed = currentMode === 'closed-agent'
            ? allowed('group', Number(groupMatch[1]), cfg)
            : v2SessionAllowed(key);
          if (!groupMembersAllowed) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getGroupMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_group_members' }, 403); return; }
          const groupId = Number(groupMatch[1]);
          try {
            let response;
            try {
              response = await bot.request('get_group_member_list', { group_id: groupId });
            } catch (wsError) {
              // 与表情库同步同一条原则：WS 挂了不代表网关挂了，读接口走 HTTP 兜底。
              response = await onebotHttpAction('get_group_member_list', { group_id: groupId });
            }
            const payload = response && typeof response === 'object' && response.data !== undefined ? response.data : response;
            const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : null);
            if (!raw) { sendJson({ ok: false, error: '网关返回的成员列表格式异常，已拒绝' }, 502); return; }
            const members = raw.slice(0, limit).map((m) => ({
              userId: m?.user_id != null ? String(m.user_id) : '',
              nickname: truncateText(String(m?.nickname ?? ''), 40),
              card: truncateText(String(m?.card ?? ''), 40),
              ...(m?.role ? { role: String(m.role) } : {})
            })).filter((m) => m.userId);
            sendJson({ ok: true, key, count: raw.length, returned: members.length, truncated: raw.length > members.length, members });
          } catch (error) {
            log(`群成员查询失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `获取群成员失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 群友印象查询：给控制台面板用。只读，按最近互动时间降序。
        // 不传 key 时返回所有会话；面板默认只看群聊。
        // 自我认知（selfNote）查询：给控制台面板用。只读。
        // selfNote 是模型写的"我对这段关系的认识"，按时间顺序返回（旧的在前）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-notes') {
          try {
            // 2026-11-12 修：selfNote 已经迁到 globalMemory（全局一份），
            // 但这里还在按会话遍历 conversations —— 于是 DSH 面板的「自我」页永远是空的。
            // 现在直接读全局；key 参数保留但只作为展示用（数据不按会话分）。
            const wantKey = String(url.searchParams.get('key') ?? '').trim();
            const st = getSocialV2State(GLOBAL_MEMORY_KEY);
            const list = Array.isArray(st?.selfNotes) ? st.selfNotes : [];
            const out = [];
            for (const n of list) {
              if (!n || typeof n !== 'object') continue;
              const text = String(n.text ?? '').trim();
              if (!text) continue;
              out.push({
                key: wantKey || GLOBAL_MEMORY_KEY,
                text,
                createdAt: Number(n.createdAt) || 0,
                lastTouchedAt: Number(n.lastTouchedAt) || 0,
              });
            }
            out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
            sendJson({ ok: true, key: wantKey || null, total: out.length, notes: out });
          } catch (error) {
            sendJson({ ok: false, error: `读取自我认知失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/impressions') {
          try {
            // 同上：印象已经按 QQ 号存进 globalMemory，不再按会话分裂。
            // 展示名现取自别名表（桥接每条消息都会写，是名字的唯一真相）；
            // impression 里不再存 name 副本，避免昵称改了以后显示旧名字。
            const wantKey = String(url.searchParams.get('key') ?? '').trim();
            const st = getSocialV2State(GLOBAL_MEMORY_KEY);
            const mi = st?.memberImpressions;
            const out = [];
            if (mi && typeof mi === 'object') {
              for (const [uid, im] of Object.entries(mi)) {
                if (!im || typeof im !== 'object') continue;
                const traits = Array.isArray(im.traits) ? im.traits.filter(Boolean) : [];
                if (!traits.length) continue;
                out.push({
                  key: wantKey || GLOBAL_MEMORY_KEY,
                  // 展示名现取自别名表（名字的唯一真相），impression 不再存副本。
                  // 拿不到名字才退回 QQ 号。
                  name: String(displayNameOfV2(uid, '') || '').trim() || uid,
                  userId: uid,
                  traits,
                  interactionCount: Number(im.interactionCount) || 0,
                  lastSeenAt: Number(im.lastSeenAt) || 0,
                });
              }
            }
            out.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
            sendJson({ ok: true, key: wantKey || null, total: out.length, impressions: out });
          } catch (error) {
            sendJson({ ok: false, error: `读取群友印象失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 待办（2026-11-12 新增）：给 DSH 面板的「待办」页用。
        // 和 selfNote / impressions 一样是**全局一份**，不按会话分。
        // 只返回还没过期的 —— 过期的不该占用面板，也不该让她再看见。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/todos') {
          try {
            const wantKey = String(url.searchParams.get('key') ?? '').trim();
            const st = getSocialV2State(GLOBAL_MEMORY_KEY);
            const list = Array.isArray(st?.todos) ? st.todos : [];
            const now = Date.now();
            const out = [];
            for (const t of list) {
              if (!t || typeof t !== 'object') continue;
              const text = String(t.text ?? '').trim();
              if (!text) continue;
              if (t.expiresAt && now >= Number(t.expiresAt)) continue;
              out.push({
                key: wantKey || GLOBAL_MEMORY_KEY,
                text,
                done: t.done === true,
                createdAt: Number(t.createdAt) || 0,
                lastMentionAt: Number(t.lastMentionAt) || 0,
                expiresAt: Number(t.expiresAt) || 0,
              });
            }
            // 排序：没做完的在前，再按到期时间近的在前。
            out.sort((a, b) => {
              if (a.done !== b.done) return a.done ? 1 : -1;
              return (a.expiresAt || 0) - (b.expiresAt || 0);
            });
            sendJson({ ok: true, key: wantKey || null, total: out.length, todos: out });
          } catch (error) {
            sendJson({ ok: false, error: `读取待办失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 群友印象编辑：按 (key, name, traitIndex) 精确定位。
        // 面板的「编辑」用。traitIndex 是 traits 数组下标；传 -1 表示改动整个 traits 数组。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/impression-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          // 2026-11-12 修：印象存在 globalMemory（全局一份），这里原来还在
          // getSocialV2State(key) 查**某个会话**，于是面板编辑永远 404。
          const rawName = String(body.name ?? '').trim();
          if (!rawName) { sendJson({ ok: false, error: 'name 不能为空' }, 400); return; }
          if (['__proto__', 'constructor', 'prototype'].includes(rawName)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          try {
            const st = getSocialV2State(GLOBAL_MEMORY_KEY);
            if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
            const mi = st.memberImpressions;
            // 展示名 → QQ 号（键）。传 QQ 号则直接用。
            const resolveKey = (raw) => {
              const t = String(raw || '').trim();
              if (!t) return null;
              if (Object.prototype.hasOwnProperty.call(mi, t)) return t;
              for (const uid of Object.keys(mi)) {
                const shown = String(displayNameOfV2(uid, '') || '').trim() || uid;
                if (shown === t) return uid;
              }
              return null;
            };
            const target = resolveKey(rawName);
            if (!target) { sendJson({ ok: false, error: `没有这条印象：${rawName}` }, 404); return; }
            const im = mi[target];
            if (!im || typeof im !== 'object') { sendJson({ ok: false, error: '没有这条印象' }, 404); return; }
            const traits = Array.isArray(im.traits) ? im.traits.slice() : [];

            // 不支持改名：键是 QQ 号、名字由别名表提供，改名字不属于印象编辑的职责。
            // 只改 traits。

            // 改某一条 trait
            if (body.traitIndex !== undefined && body.traitIndex !== null) {
              const idx = Number(body.traitIndex);
              const text = String(body.text ?? '').trim();
              if (!Number.isInteger(idx) || idx < 0) { sendJson({ ok: false, error: 'traitIndex 非法' }, 400); return; }
              if (idx >= traits.length) { sendJson({ ok: false, error: 'traitIndex 越界' }, 400); return; }
              if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
              traits[idx] = text.slice(0, 50);
            } else if (Array.isArray(body.traits)) {
              // 整组替换
              const next = body.traits.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 10);
              if (!next.length) { sendJson({ ok: false, error: 'traits 不能全空' }, 400); return; }
              traits.length = 0;
              for (const t of next) traits.push(t.slice(0, 50));
            }

            mi[target] = {
              traits,
              interactionCount: Number(im.interactionCount) || 0,
              lastSeenAt: Number(im.lastSeenAt) || Date.now(),
            };
            saveSocialV2State();
            sendJson({ ok: true, key, name: rawName, userId: target });
          } catch (error) {
            sendJson({ ok: false, error: `编辑失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 群友印象删除：整人删掉（delete 该 key）。面板的删除按钮用。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/impression-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          // 2026-11-12 修：印象已经存进 globalMemory（全局一份），但这里还在用
          // getSocialV2State(key) 查**某个会话**，于是面板删的时候永远 404
          // 「没有这条印象」—— 数据其实在全局那份里。
          //
          // name 现在可能是「展示名」或「QQ 号」（面板两种都可能传），
          // 所以两种都认：先按展示名反查 QQ 号，找不到再当 QQ 号/键直接用。
          const rawName = String(body.name ?? '').trim();
          if (!rawName) { sendJson({ ok: false, error: 'name 不能为空' }, 400); return; }
          try {
            const st = getSocialV2State(GLOBAL_MEMORY_KEY);
            const mi = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
            let target = null;
            if (Object.prototype.hasOwnProperty.call(mi, rawName)) {
              target = rawName;
            } else {
              // 传的是展示名：在所有印象里找别名表解析后能对上的那个。
              for (const uid of Object.keys(mi)) {
                const shown = String(displayNameOfV2(uid, '') || '').trim() || uid;
                if (shown === rawName) { target = uid; break; }
              }
            }
            if (!target) {
              sendJson({ ok: false, error: `没有这条印象：${rawName}` }, 404);
              return;
            }
            delete mi[target];
            st.memberImpressions = mi;
            saveSocialV2State();
            sendJson({ ok: true, key, name: rawName, userId: target });
          } catch (error) {
            sendJson({ ok: false, error: `删除失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 长期事实（L2）查询：给控制台面板用。只读，按权重降序返回。
        // 不传 key 时返回所有会话的事实（面板要跨会话展示）。
        // ── 好感度查询（MCP qq_affinity 走这里）─────────────────────────────
        // 为什么单独给个端点，而不是塞进 qq_social_state：
        //   唤醒包只注入一行极简状态，完整细节（互动几次、认识多久）要给的时候
        //   才查 —— 这才是"想不起来才查"的真人模式，也避免每轮白烧 token。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/affinity') {
          const wantKey = String(url.searchParams.get('key') ?? '').trim();
          const wantUser = String(url.searchParams.get('userId') ?? '').trim();
          // scope=global：控制台面板用。好感度现在是全局一份，不再需要具体会话 key。
          // 仍然允许传 key（旧调用方/AI 工具都这么用），只是不强制。
          const scopeGlobal = String(url.searchParams.get('scope') ?? '') === 'global';
          if (!scopeGlobal && !canonicalV2Key(wantKey)) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号（或传 scope=global）' }, 400);
            return;
          }
          try {
            const now = Date.now();

            // ── 按名字反查（2026-11-13）────────────────────────────────
            // 她常把**人名**直接当 userId 传（消息行里显示的是名字，号码只在
            // qq_get_unread_messages 里）。以前把名字当号码查，得到"没聊过"，
            // 她就以为不认识这个人 —— 其实是同一个人，只是键错了。
            let wantUserResolved = wantUser;
            if (wantUser && !/^\d{1,20}$/.test(wantUserResolved)) {
              const aliasMap = socialV2.aliases && typeof socialV2.aliases === 'object' ? socialV2.aliases : {};
              const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
              const target = norm(wantUserResolved);
              const exact = [];
              const partial = [];
              for (const [uid, info] of Object.entries(aliasMap)) {
                const names = Array.isArray(info?.names) ? info.names : [];
                const primary = String(info?.primary ?? '');
                const all = [...names, primary].filter(Boolean);
                const label = primary || names[0] || uid;
                if (all.some((n) => norm(n) === target)) { exact.push([uid, label]); continue; }
                if (all.some((n) => norm(n).includes(target) || target.includes(norm(n)))) partial.push([uid, label]);
              }
              const pool = exact.length ? exact : partial;
              if (pool.length === 1) {
                wantUserResolved = pool[0][0];
              } else if (pool.length > 1) {
                // 对上多个人：把候选给她自己挑，不猜。
                const lines2 = pool.slice(0, 6).map(([uid, nm]) => `- ${nm}：${uid}`).join('\n');
                sendJson({
                  ok: true, userId: null, label: wantUser,
                  stage: 'ambiguous', stageLabel: '重名', count: 0,
                  text: `「${wantUser}」对上好几个人，你要查哪个？\n${lines2}\n把对应的 QQ 号填进 userId 再查一次。`,
                });
                return;
              }
            }

            // 好感度现在是**全局按 QQ 号**存的（socialV2.affinities），不再是每个会话一份。
            // 这里仍然扫一遍会话，只为了**回收昵称**（名字来自 recentMessages），
            // 分数与档位直接取全局表 —— 这样清空会话/重置上下文都不会再让关系归零。
            // 全局模式下（控制台面板）要扫**所有**会话来找昵称，因为没有指定 key。
            const pool = scopeGlobal ? [] : shareGroupOf(canonicalV2Key(wantKey));
            const keysToScan = scopeGlobal
              ? [...socialV2.conversations.keys()]
              : (pool.length > 1 ? pool : [canonicalV2Key(wantKey)]);
            const merged = new Map();
            const globalAff = socialV2.affinities && typeof socialV2.affinities === 'object'
              ? socialV2.affinities : {};
            for (const [uid, rec] of Object.entries(globalAff)) {
              if (!rec || !(Number(rec.count) > 0)) continue;
              merged.set(uid, decayAffinity(rec));
            }
            // 兼容：万一还有一些没迁移干净的会话内旧数据，也并进来（取高的那份）。
            // 迁移函数会在启动时处理，这里只是兜底，保证"数据不会凭空消失"。
            for (const ck of keysToScan) {
              let cst;
              try { cst = getSocialV2State(ck); } catch { continue; }
              const map = cst.affinities && typeof cst.affinities === 'object' ? cst.affinities : {};
              for (const [uid, rec] of Object.entries(map)) {
                if (!rec || !(Number(rec.count) > 0)) continue;
                const decayed = decayAffinity(rec);
                const prev = merged.get(uid);
                if (!prev || Number(decayed.score) > Number(prev.score)) merged.set(uid, decayed);
              }
            }
            // ── 昵称：从消息记录里回收，不额外调 OneBot API ──────────────────
            // 好感度表只存 userId（那是身份，不会变）。昵称是"展示用"的东西，
            // 每个人说话时桥接已经把 sender（群名片优先、其次昵称）存进 recentMessages 了，
            // 这里倒着扫一遍就能拼出 userId → 名字，比每个用户调一次 get_group_member_info
            // 快得多（12 个人就是 12 次 HTTP 往返，面板会明显卡）。
            // 取**最近**的那条：群名片会改，旧名字不该盖掉新名字。
            //
            // 清洗是必须的，不是洁癖：实测有的 sender 里混进了控制字符
            // （"\n\u0005\u0012\u0003小\n\u0005\n\u0003刀\u0010\u0000"，本该是"小刀"），
            // 那是 SnowLuma 解码 @ 段时漏出来的字节。直接渲染会撑坏卡片布局，
            // 也可能把零宽字符/方向控制符带进页面。
            const cleanName = (raw) => {
              let s = String(raw ?? '');
              // 去掉所有 C0/C1 控制字符、零宽字符与双向控制符；换行也一并压平。
              s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
              // 压掉多余空白（控制符删掉后常在中间留下空档）。
              s = s.replace(/\s+/g, ' ').trim();
              // 纯符号/纯数字的组合不像名字，交给调用方决定要不要用。
              return s.slice(0, 40);
            };
            // 私聊消息的 sender 固定写"私聊"/"我"，那不是人名，别拿来当昵称。
            const NON_NAME = new Set(['私聊', '我', '未知', '群友', '管理员']);
            const usableName = (nm, uid) => {
              const s = cleanName(nm);
              if (!s || s === String(uid) || NON_NAME.has(s)) return '';
              // 清洗后至少要剩一个字母、数字或汉字，否则视为脏数据。
              return /[\p{L}\p{N}]/u.test(s) ? s : '';
            };
            const nameOf = new Map();
            for (const ck of keysToScan) {
              let cst;
              try { cst = getSocialV2State(ck); } catch { continue; }
              const msgs = Array.isArray(cst.recentMessages) ? cst.recentMessages : [];
              for (let i = msgs.length - 1; i >= 0; i -= 1) {
                const m = msgs[i];
                const uid = m?.userId != null ? String(m.userId) : '';
                if (!uid || nameOf.has(uid)) continue;
                const nm = usableName(m?.sender, uid);
                if (!nm) continue;
                nameOf.set(uid, nm);
              }
            }
            // 私聊的对方没有"群名片"概念，名字就是私聊对象本身；补一条兜底。
            for (const ck of keysToScan) {
              const m = /^private:(\d+)$/.exec(ck);
              if (!m) continue;
              const uid = m[1];
              if (nameOf.has(uid) || uid === String(cfg.ownerQQ ?? '')) continue;
              const cst = (() => { try { return getSocialV2State(ck); } catch { return null; } })();
              const own = Array.isArray(cst?.recentMessages) ? cst.recentMessages : [];
              for (let i = own.length - 1; i >= 0; i -= 1) {
                const nm = usableName(own[i]?.sender, uid);
                if (nm) { nameOf.set(uid, nm); break; }
              }
            }
            // 一个人在群里可能用过多个名字，全量收一次当别名（面板 hover 里能看全）。
            const aliasesOf = new Map();
            for (const ck of keysToScan) {
              let cst;
              try { cst = getSocialV2State(ck); } catch { continue; }
              const msgs = Array.isArray(cst.recentMessages) ? cst.recentMessages : [];
              for (const m of msgs) {
                const uid = m?.userId != null ? String(m.userId) : '';
                if (!uid) continue;
                const nm = usableName(m?.sender, uid);
                if (!nm) continue;
                if (!aliasesOf.has(uid)) aliasesOf.set(uid, new Set());
                aliasesOf.get(uid).add(nm);
              }
            }
            // 展示名：主人优先叫"主人"，其次群名片/昵称，最后才退回 QQ 号。
            const displayNameOf = (uid) => {
              if (uid === String(cfg.ownerQQ ?? '')) return '主人';
              return nameOf.get(uid) || uid;
            };
            // 兜底：recentMessages 只留最近 200 条，久没说话的人名字会被轮转掉。
            // 这时才去问网关要（有 10 分钟缓存，且有并发上限），别为 12 个人打 12 个请求。
            const missing = [...merged.keys()].filter((uid) => !nameOf.has(uid) && uid !== String(cfg.ownerQQ ?? ''));
            if (missing.length && missing.length <= 20) {
              const groupIds = [...new Set(keysToScan.map((k) => /^group:(\d+)$/.exec(k)?.[1]).filter(Boolean))];
              // 并发拉取，失败静默（面板不该因为网关抽风而报错）。
              await Promise.all(missing.map(async (uid) => {
                for (const gid of groupIds) {
                  try {
                    const nm = await resolveGroupMemberName(gid, uid);
                    const ok = usableName(nm, uid);
                    if (ok) { nameOf.set(uid, ok); return; }
                  } catch {}
                }
              }));
            }
            // 面板要画档位刻度尺，所以把四档边界一起下发（唯一真源仍是 affinity.js）。
            const stages = AFFINITY_STAGES.map((s) => ({
              id: s.id,
              label: s.label,
              min: Number.isFinite(s.min) ? s.min : -20,
            }));
            if (wantUserResolved) {
              const rec = merged.get(wantUserResolved) || null;
              const label = displayNameOf(wantUserResolved);
              // 她查过了 —— 把"档位变了"的提醒**清掉**。
              // 不清的话，那条提醒会在之后每一轮唤醒里重复出现，等于又变回"每轮都在说这事"，
              // 而且会误导她以为关系还在变。
              try {
                // 提醒现在在**全局**表里（按 QQ 号），清除时也清全局那一份。
                if (socialV2.affinityStageChanges?.[wantUserResolved]) {
                  delete socialV2.affinityStageChanges[wantUserResolved];
                  saveSocialV2State();
                }
              } catch {}
              // ⚠️ 给**模型**的返回必须精简（2026-11-10 操作者要求）：
              //   这个端点的每一行都会进上下文，而 stages（五档边界表）、aliases、
              //   nickname、manualAt 这些字段模型一个都用不上 —— 但它们占了返回体积的大头。
              //   stages 尤其明显：5 个对象 × 3 个字段，每查一次就重复一遍。
              //   控制台面板要刻度尺数据，走的是同一个 URI 但由浏览器读，
              //   它有自己的 AFF_STAGE_FALLBACK，不依赖这里（见 console.html）。
              // ⚠️ isOwner 必须传：偏爱档对主人允许露骨描写，对其他人不。
              //   这个判断只能在这里做 —— affinity.js 不知道谁是主人（那是桥接的 cfg）。
              //   用 userId 和 cfg.ownerQQ 比，不依赖请求里的 key（同一个主人在群和私聊都是主人）。
              const isOwnerUser = wantUserResolved === String(cfg.ownerQQ ?? '');
              sendJson({
                ok: true,
                userId: wantUserResolved,
                label,
                stage: rec ? affinityStageOf(rec.score).id : 'new',
                stageLabel: rec ? affinityStageOf(rec.score).label : '没聊过',
                count: rec ? Number(rec.count) || 0 : 0,
                text: describeAffinity(rec || null, label, now, { isOwner: isOwnerUser }),
              });
              return;
            }
            const list = [...merged.entries()]
              .map(([uid, rec]) => {
                const label = displayNameOf(uid);
                return {
                  userId: uid,
                  label,
                  nickname: nameOf.get(uid) || '',
                  aliases: [...(aliasesOf.get(uid) || [])].slice(-6),
                  stage: affinityStageOf(rec.score).id,
                  stageLabel: affinityStageOf(rec.score).label,
                  score: rec.score,
                  count: Number(rec.count) || 0,
                  lastAt: Number(rec.lastAt) || 0,
                  createdAt: Number(rec.createdAt) || 0,
                  manualAt: Number(rec.manualAt) || 0,
                };
              })
              .sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
            // 列表形态也带上 createdAt：否则同一个人的"认识 N 天"在单人查询里有、
            // 在列表里没有，她会以为是两个人。
            const text = list.length
              ? list.map((it) => describeAffinity({
                score: it.score, count: it.count, lastAt: it.lastAt, createdAt: it.createdAt,
              }, it.label, now)).join('\n')
              : '还没有任何互动记录。';
            sendJson({ ok: true, key: wantKey, total: list.length, people: list, stages, text });
          } catch (error) {
            sendJson({ ok: false, error: `读取好感度失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 好感度手工调整（仅控制台）──────────────────────────────────────
        // 操作者拖动滑条直接改分。为什么需要这个入口：好感度本来只由聊天自动累积，
        // 但"刚认识就被当老朋友"或"想验证某个档位的表现"这类需求没法靠聊天凑出来。
        //
        // 三条硬约束：
        //   1. **只允许控制台**：带 agent token 的一律 403（已在上面的 adminOnlyV2Paths 拦下），
        //      否则 AI 能给自己刷好感度 —— 那等于把关系交给被评价的一方。
        //   2. **写入共享组内所有聊天**：同一个人只有一份关系（和 appendSocialV2Message 同口径），
        //      只写当前 key 的话私聊改完群聊还是旧分数。
        //   3. **保留 count/createdAt**：这里调的是"关系温度"，不是"抹掉历史"。
        //      没有记录的人被手工设置时补一条 count=1，否则 saveSocialV2State 会把 count=0 的丢掉。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/affinity') {
          const body = await readBody();
          const wantKey = String(body.key ?? '').trim();
          const wantUser = String(body.userId ?? '').trim();
          // scope=global：控制台面板用。好感度全局一份，不需要会话 key。
          const scopeGlobal = String(body.scope ?? '') === 'global' || wantKey === 'global';
          if (!scopeGlobal && !canonicalV2Key(wantKey)) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号（或传 scope=global）' }, 400);
            return;
          }
          if (!/^\d{1,20}$/.test(wantUser)) { sendJson({ ok: false, error: 'userId 必须是纯数字 QQ 号' }, 400); return; }
          const rawScore = Number(body.score);
          if (!Number.isFinite(rawScore)) { sendJson({ ok: false, error: 'score 必须是数字' }, 400); return; }
          // 与 affinity.js 的 bumpAffinity 同口径。
          // ⚠️ 必须用导出的 SCORE_MIN/SCORE_MAX，不能在这里重写数字：
          //   实测算过——加了 400 分的新档位、滑条也放开到 600，但这一行还写着
          //   `Math.min(200, …)`，于是控制台拖到 500 存进去立刻被夹回 200，
          //   看起来像"滑条坏了/后端存不住"，其实是这里的上限没跟着改。
          const score = Math.max(AFFINITY_SCORE_MIN, Math.min(AFFINITY_SCORE_MAX, Math.round(rawScore)));
          try {
            // 全局模式下没有具体会话 key，canonicalKey 只为兼容旧副本清理而保留。
            const canonicalKey = scopeGlobal ? '' : canonicalV2Key(wantKey);
            // 好感度现在**全局按 QQ 号**存：只写一处，不再往每个会话里铺副本。
            // 这样控制台拖一次滑条 = 改一条记录，也不会再出现"某个会话里少了那份"。
            if (!socialV2.affinities || typeof socialV2.affinities !== 'object') socialV2.affinities = {};
            const now = Date.now();
            const prev = socialV2.affinities[wantUser];
            socialV2.affinities[wantUser] = {
              score,
              stageId: affinityStageOf(score).id,
              // 手工设置也算一次接触，但不虚增互动次数（次数是"聊过几次"的事实）。
              count: Math.max(1, Number(prev?.count) || 0),
              createdAt: Number(prev?.createdAt) || now,
              lastAt: Number(prev?.lastAt) || now,
              // 留痕：区分"聊天聊出来的"和"操作者拖出来的"，排查时能看出来源。
              manualAt: now,
            };

            // ── 档位变化也要记 ────────────────────────────────────────────
            // 2026-11-12 修：原来只有"聊天计分"那条会写 affinityStageChanges，
            // 手工拖滑条不写 —— 于是操作者把某人拖进"喜欢"档，唤醒词却一声不响。
            // 档位变化就是档位变化，不管来源是聊天还是拖条。只在**档位 id 变了**时记。
            const prevStageId = prev ? affinityStageOf(Number(prev.score) || 0).id : null;
            const nextStageId = affinityStageOf(score).id;
            if (prevStageId && prevStageId !== nextStageId) {
              try {
                if (!socialV2.affinityStageChanges || typeof socialV2.affinityStageChanges !== 'object') {
                  socialV2.affinityStageChanges = {};
                }
                const fromLabel = AFFINITY_STAGES.find((s) => s.id === prevStageId)?.label ?? prevStageId;
                const toLabel = AFFINITY_STAGES.find((s) => s.id === nextStageId)?.label ?? nextStageId;
                socialV2.affinityStageChanges[wantUser] = { from: fromLabel, to: toLabel, at: now };
                log(`[affinity] 控制台调整导致档位变化 ${wantUser}: ${fromLabel} → ${toLabel}（已记入唤醒提醒）`);
              } catch {}
            }
            // 清掉会话里的旧副本（如果还有），避免以后被当成另一份数据。
            // 全局模式下没有具体会话，就把所有会话里的副本都清一遍。
            try {
              const cleanKeys = scopeGlobal
                ? [...socialV2.conversations.keys()]
                : [canonicalKey, ...shareGroupOf(canonicalKey)];
              for (const ck of cleanKeys) {
                const cst = getSocialV2State(ck);
                if (cst?.affinities?.[wantUser]) delete cst.affinities[wantUser];
              }
            } catch {}
            saveSocialV2State();
            // 回显用昵称（跟 GET 同一口径），日志里保留 QQ 号方便排查。
            // 这里同样要清洗：脏 sender 直接写进提示会把控制字符带进页面。
            const NON_NAME_W = new Set(['私聊', '我', '未知', '群友', '管理员']);
            const keysToScan = scopeGlobal
              ? [...socialV2.conversations.keys()]
              : [canonicalKey, ...shareGroupOf(canonicalKey)];
            const nickOfUser = (() => {
              for (const ck of keysToScan) {
                let cst;
                try { cst = getSocialV2State(ck); } catch { continue; }
                const msgs = Array.isArray(cst.recentMessages) ? cst.recentMessages : [];
                for (let i = msgs.length - 1; i >= 0; i -= 1) {
                  const m = msgs[i];
                  if (String(m?.userId ?? '') !== wantUser) continue;
                  let s = String(m?.sender ?? '')
                    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 40);
                  if (!s || s === wantUser || NON_NAME_W.has(s)) continue;
                  if (!/[\p{L}\p{N}]/u.test(s)) continue;
                  return s;
                }
              }
              return '';
            })();
            const label = wantUser === String(cfg.ownerQQ ?? '') ? '主人' : (nickOfUser || wantUser);
            const stage = affinityStageOf(score);
            log(`[好感度] 控制台调整 ${label}(${wantUser}) → ${score}（${stage.label}），全局记录已更新`);
            sendJson({
              ok: true,
              key: wantKey,
              userId: wantUser,
              label,
              score,
              stage: stage.id,
              stageLabel: stage.label,
              // 保留 written 字段的形状（前端/测试可能读它），但现在只有全局一份。
              written: ['*global*'],
              text: describeAffinity({ score, count: 1, lastAt: now }, label, now),
            });
          } catch (error) {
            sendJson({ ok: false, error: `设置好感度失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/facts') {
          const wantKey = String(url.searchParams.get('key') ?? '').trim();
          // 2026-11-10：不再有 mode=delta。操作者的要求是「每次调用都给她看完整的，
          // 只额外告诉她哪些忘掉了」——差集模式让她可能漏读中间写过又没变化的内容。
          // 现在固定返回：全部活跃事实 + forgotten（自上次看过之后掉出去的）。
          try {
            const now = Date.now();
            // 长期事实**全局一份**（2026-11-10 定稿）：不管请求带的是哪个会话 key，
            // 都去读同一份 —— 用 memoryKeyOf() 归一成 GLOBAL_MEMORY_KEY。
            //
            // ⚠️ 这里曾经是 `keys = wantKey ? [wantKey] : [...]`，直接拿请求里的 key
            // 当文件名，于是查 private:10001 会去找 private_10001.jsonl（不存在）
            // → 明明 global.jsonl 里有活跃事实，却回 0 条。这正是"她查不到那条旧约定"的原因。
            const keys = wantKey
              ? [memoryKeyOf(wantKey)]
              : [...new Set([...socialV2.conversations.keys()].filter(Boolean).map((k) => memoryKeyOf(k)))];
            const out = [];
            for (const k of keys) {
              const all = loadFacts(STATE_DIR, k);
              // loadFacts 返回 append-only 的全部行（同一 id 可能有多条修订），先按 id 折叠取最新。
              const latest = new Map();
              for (const f of all) if (f && f.id) latest.set(f.id, f);
              for (const f of latest.values()) {
                if (!f || !f.text) continue;
                out.push({
                  key: k,
                  id: f.id,
                  text: f.text,
                  tag: f.tag || 'misc',
                  weight: Number(weightOf(f, now).toFixed(2)),
                  hits: Number(f.hits) || 0,
                  archived: !!f.archived,
                  lastHit: f.lastHit || 0,
                  createdAt: f.createdAt || 0,
                  source: f.source || 'manual',
                });
              }
            }
            out.sort((a, b) => b.weight - a.weight || (b.lastHit || 0) - (a.lastHit || 0));

            // 「已经忘掉的」：上次看到过、这次不在活跃列表里了（被归档或权重掉出去）。
            // 长期事实是**全局一份**，所以「她看过什么」这个基准也必须全局 ——
            // 按会话记会让群和私聊各有一份 seen，同一批事实被各自判一次「忘了」。
            let forgotten = [];
            if (wantKey) {
              const stForSeen = getSocialV2State(GLOBAL_MEMORY_KEY);
              const seen = new Set(Array.isArray(stForSeen?.factSeenIds) ? stForSeen.factSeenIds : []);
              const live = out.filter((f) => !f.archived);
              const nowIds = new Set(live.map((f) => f.id));
              const byId = new Map(out.map((f) => [f.id, f]));
              forgotten = [...seen]
                .filter((id) => !nowIds.has(id))
                .map((id) => byId.get(id))
                .filter(Boolean)
                .map((f) => ({ id: f.id, text: f.text, tag: f.tag }));
              // 把这次看到的活跃 id 记下来，下次再比。
              stForSeen.factSeenIds = [...nowIds].slice(-200);
              try { saveSocialV2State(); } catch {}
            }

            sendJson({
              ok: true,
              key: wantKey || null,
              total: out.length,
              facts: out,
              forgotten,
              // 没有变化时也照常返回全量；changed 只是给调用方一个"要不要额外提一句"的提示。
              changed: forgotten.length > 0,
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取长期事实失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 长期事实编辑：按 id 精确改 text / tag。
        // facts 是 append-only 文件，这里走「追加一条修订记录」而不是原地改
        // （与 bumpFact / archiveFact 同一手法，读取时同 id 以最后一条为准）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/fact-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const id = String(body.id ?? '').trim();
          if (!key || !id) { sendJson({ ok: false, error: 'key/id 不能为空' }, 400); return; }
          try {
            const now = Date.now();
            const all = loadFacts(STATE_DIR, key);
            const target = all.filter((f) => f && f.id === id).pop();
            if (!target) { sendJson({ ok: false, error: '没有找到这条事实' }, 404); return; }
            const next = { ...target, revisedAt: now };
            if (body.text !== undefined) {
              const text = String(body.text).trim().slice(0, 200);
              if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
              next.text = text;
            }
            if (body.tag !== undefined) {
              const tag = String(body.tag).trim();
              // tag 决定基础权重：换 tag 就要重算 baseWeight，否则权重和分类对不上。
              if (TAG_WEIGHTS[tag]) {
                next.tag = tag;
                next.baseWeight = TAG_WEIGHTS[tag];
              }
            }
            const file = factsFileOf(STATE_DIR, key);
            fs.appendFileSync(file, JSON.stringify(next) + '\n', 'utf8');
            sendJson({ ok: true, key, fact: next });
          } catch (error) {
            sendJson({ ok: false, error: `编辑失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 长期事实删除：按 id 归档（不物理删，保留记录）。控制台面板的删除按钮用。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/fact-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const id = String(body.id ?? '').trim();
          if (!key || !id) { sendJson({ ok: false, error: 'key/id 不能为空' }, 400); return; }
          try {
            const hit = archiveFact(STATE_DIR, key, id);
            if (!hit) { sendJson({ ok: false, error: '没有找到这条事实' }, 404); return; }
            sendJson({ ok: true, key, id });
          } catch (error) {
            sendJson({ ok: false, error: `删除失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          // 2026-11-12：顶层 target 也认。原来只认 extra.target，而模型很容易把
          // "给谁记"和 category/content 平铺在顶层 —— 结果明明填了名字却报
          // 「memberImpression 需要 extra.target」（实测踩过）。
          // 顶层优先、extra 兜底，两种写法都收。
          const bodyTarget = String(body.target ?? '').trim();
          if (bodyTarget && !extra.target) extra.target = bodyTarget;
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', 'selfNote', 'longTerm', 'todo'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / selfNote / longTerm / todo' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要指定 target（这个人的名字）：传顶层 target 或 extra.target 都行' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          // 长期事实（2026-11-10 并入本端点，原 /api/socialV2/fact-add 与 qq_fact_add 工具已删除）：
          // 走 facts 库而不是 socialV2 状态，因为它是按权重衰减、可归档、append-only 修订的独立存储。
          if (category === 'longTerm') {
            const tag = String(extra.tag || 'misc').trim();
            if (!['identity', 'agreement', 'emotion', 'preference', 'meme', 'misc'].includes(tag)) {
              sendJson({ ok: false, error: 'extra.tag 必须是 identity / agreement / emotion / preference / meme / misc' }, 400);
              return;
            }
            try {
              // addFact 内部按 text 完全相等去重：同一条再写一次只会加权，不会多存一份。
              // 长期事实**全局一份**（memoryKeyFor 对 longTerm 返回 GLOBAL_MEMORY_KEY）。
              const memKey = memoryKeyFor('longTerm', key);
              const fact = addFact(STATE_DIR, memKey, { text: content, tag, source: 'ai' });
              sendJson({ ok: true, key, category, fact, preview: selectFactsForInjection(STATE_DIR, memKey).text });
            } catch (error) {
              sendJson({ ok: false, error: `长期事实写入失败：${error?.message ?? error}` }, 500);
            }
            return;
          }
          const st = getSocialV2State(key);
          // 记忆归属见文件上游的「记忆归属」注释块：
          //   selfNote / memberImpression → 全局一份；
          //   activeTopic / pendingThought → 当前会话自己。
          const memKey = memoryKeyFor(category, key);
          const memSt = memKey === key ? st : getSocialV2State(memKey);
          // extra.sessionKey：memberImpression 要用它把 target（名字）反查成 QQ 号，
          // 反查的数据源是"发这条消息的那个会话"的消息列表 —— 而 memSt 在全局记忆下
          // 不是任何真实会话，所以必须把请求里的 key 单独带进去。
          appendMemoryV2(memSt, category, content, { ...extra, sessionKey: key });
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(memSt, key) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', 'selfNote', 'todo'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / selfNote' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          // 编辑也要去记忆真正所在的那一份改，否则「编辑了记忆」其实一个字节都没动（404）。
          const st = getSocialV2State(memoryKeyFor(category, key));
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            // 必须命中**已有**条目（own property）：否则任意 target 都能凭空建一条，
            // 而 'toString'/'valueOf' 这类名字会从 Object.prototype 上取到继承来的函数，
            // 往函数对象上写 traits —— JSON.stringify 又会把它整个丢掉（静默数据丢失）。
            if (!Object.prototype.hasOwnProperty.call(st.memberImpressions, oldTarget)) {
              sendJson({ ok: false, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' }, 404);
              return;
            }
            const im = st.memberImpressions[oldTarget];
            const newTarget = String(cleanNewExtra.target || oldTarget).trim().slice(0, 64);
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
            // 与控制台/AI 的 append 路径保持一致：条目数上限 50，超了按 lastSeenAt 淘汰最旧，
            // 否则 memory-update 能无限塞名字（每次 1MB 请求 → 状态文件与每轮 prompt 一起膨胀）。
            const impressionEntries = Object.entries(st.memberImpressions);
            if (impressionEntries.length > 50) {
              impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
              for (let i = 0; i < impressionEntries.length - 50; i += 1) delete st.memberImpressions[impressionEntries[i][0]];
            }
          } else if (category === 'selfNote' && Array.isArray(st.selfNotes)) {
            // 改主意：按原文定位，替换掉那句话。这是"我以前的看法变了"的唯一入口。
            const idx = st.selfNotes.findIndex((n) => String(n?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 selfNote' }, 404); return; }
            if (newContent !== undefined) {
              st.selfNotes[idx].text = newContent.slice(0, 300);
              st.selfNotes[idx].lastTouchedAt = Date.now();
            }
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st, key) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          // 记忆归属见文件上游的「记忆归属」注释块：
          //   selfNote / memberImpression / todo 是全局一份（所有会话都读同一份）；
          //   activeTopic / pendingThought 各聊各的。
          // 不带 category 时两边都要取：全局的来自 GLOBAL，会话级来自本会话。
          const localSt = getSocialV2State(key);
          const globalSt = getSocialV2State(GLOBAL_MEMORY_KEY);
          const isSessionScope = category === 'activeTopic' || category === 'pendingThought';
          const longTermSt = isSessionScope ? localSt : globalSt;
          const raw = {
            activeTopics: Array.isArray(localSt.activeTopics) ? localSt.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(localSt.pendingThoughts) ? localSt.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: longTermSt.memberImpressions && typeof longTermSt.memberImpressions === 'object' ? longTermSt.memberImpressions : {},
            selfNotes: Array.isArray(longTermSt.selfNotes) ? longTermSt.selfNotes.slice(-40) : [],
            // 待办是全局的，且只给还没过期的（过期的对她没有意义）。
            todos: Array.isArray(longTermSt.todos)
              ? longTermSt.todos.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)).slice(-20)
              : []
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
            raw.selfNotes = [];
            raw.todos = [];
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
            raw.selfNotes = [];
            raw.todos = [];
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
            raw.selfNotes = [];
            raw.todos = [];
          } else if (category === 'selfNote') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
            raw.todos = [];
          } else if (category === 'todo') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
            raw.selfNotes = [];
          }
          // formatMemoryV2 只看传入对象上的字段，raw 已经按类别把该隐藏的置空了，
          // formatMemoryV2 只看传入对象上的字段，raw 已经按类别把该隐藏的置空了。
          // 基底：先 localSt（短期两类在它身上），再 longTermSt（长期三类在它身上），
          // 最后 raw 覆盖 —— 三者的字段名不重叠，顺序只是防止同名时读错来源。
          // ⚠️ 这里曾经写成 `...sharedSt`，而 sharedSt 在改成全局记忆时已被删除 ——
          //   结果是每次 qq_memory_query 都 500 "sharedSt is not defined"。
          //   加字段/改变量名时，务必跑一遍 test-global-memory.mjs（它覆盖这条读路径）。
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...localSt, ...longTermSt, ...raw }, key), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', 'selfNote', 'todo'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / selfNote' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          // 删也得去记忆真正所在的那一份删（长期三类在全局，短期两类在会话）。
          const st = getSocialV2State(memoryKeyFor(category, key));
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          } else if (category === 'selfNote' && Array.isArray(st.selfNotes)) {
            // 过时的自我认知要能删（"我以前觉得自己…，现在不这么想了"）。
            st.selfNotes = st.selfNotes.filter((n) => String(n?.text ?? '') !== content);
          } else if (category === 'todo' && Array.isArray(st.todos)) {
            // 待办也能删（做完了 / 不用做了）。
            st.todos = st.todos.filter((t) => String(t?.text ?? '') !== content);
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st, key) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression', 'selfNote', 'todo'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / selfNote / todo' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          // category 为空 = 清全部：全局那份（印象/自我认知/待办）和本会话那份（话题/想法）都要清。
          // 2026-11-12：之前漏了 selfNote 和 todo —— 面板上加了这两块之后，
          // 它们的"清空"按钮点了不会有任何效果，等于假按钮。
          const clearAll = !category;
          const globalSt = getSocialV2State(GLOBAL_MEMORY_KEY);
          const localSt = getSocialV2State(key);
          if (!category || category === 'activeTopic') localSt.activeTopics = [];
          if (!category || category === 'pendingThought') localSt.pendingThoughts = [];
          if (!category || category === 'memberImpression') globalSt.memberImpressions = {};
          if (!category || category === 'selfNote') globalSt.selfNotes = [];
          if (!category || category === 'todo') globalSt.todos = [];
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(localSt, key) });
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          const auditTest = auditOutbound(message, { level: auditLevelFor(key), knownTokens: KNOWN_AGENT_TOKENS });
          if (auditTest.blocked) { sendJson({ ok: false, error: `消息含${auditTest.reason}，已阻止发送` }, 403); return; }
          // st/now 必须声明在 try **之外**：下面的 catch 要用它们回滚预占的发送额度。
          // 写在 try 里时 catch 拿到的是块作用域外的名字 ⇒ ReferenceError（send-burst
          // 曾整段踩过同型问题，见体检报告 #1 / R2）。后果不是"少一行日志"，而是
          // 失败响应变成「st is not defined」、额度不回滚（接下来一分钟全是假 429），
          // 且部分成功的已发消息不会被记进 recentMessages。
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }

            noteSendCallV2(st, now);  // 节流按"调用"记账，不按条数
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages, sentMessages?.ids);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            // 发送后空转：代替"节流拦截"，只让这次调用慢一点，不产生额外回合。
            // 发送后空转 + 观察新消息（2026-11-14）：
            // 空转期间有新消息就提前结束，把那几条按【本轮消息】同格式带回去，
            // 让她能在同一个回合里接着回 —— 省掉一次完整唤醒。
            let postSendObserve = null;
            if (sentMessages.length > 0) {
              postSendObserve = await paceAfterSendV2(st, key, Date.now());
            }
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, ...(postSendObserve?.text ? { text: postSendObserve.text, arrived: true, arrivedCount: postSendObserve.count } : {}), sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent, error?.sentIds);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sessionEpoch++;
          const oldSessionId = state.sessions[key];
          delete state.sessions[key];
          // 共用会话：清一个 = 清整组。
          //
          // 2026-11-10 修的第二个坑（上一版写错了）：最初这里只清
          // `memberSession === oldSessionId` 的成员，可是**共用组里的每个 key
          // 会各持一份自己的 sessionId**（ensureSession 按 key 建映射，只是复用同一个
          // DSH 会话）—— 于是那个条件永远不成立，整段等于没写。
          // 实测后果：清了群，私聊仍拿着旧映射继续用，且 bootstrapSent 还是 true；
          // 随后私聊来了条消息，走普通唤醒（reason=private），既不补引导也不提记忆，
          // 看上去就是"新会话第一轮却什么都没注入"。
          //
          // 现在的语义：组内**所有** key 的会话映射一起清、bootstrapSent 一起复位。
          // 这才对得上"共用会话"的模型 —— 它们本来就是同一个 DSH 会话、同一份记忆、同一段引导。
          const resetPool = (() => { try { return shareGroupOf(key); } catch { return [key]; } })();
          const alsoCleared = [];
          for (const memberKey of resetPool) {
            if (memberKey === key) continue;
            const memberCanonical = canonicalV2Key(memberKey) || memberKey;
            const memberSession = state.sessions[memberKey];
            if (memberSession) {
              // 各 key 的 sessionId 可能不同（同一 DSH 会话复用），所以这里不能比对 id，
              // 只能"凡在组内的都清掉"。
              delete state.sessions[memberKey];
              reverse.delete(memberSession);
              collectors.delete(memberSession);
              sendToolSucceededSessions.delete(memberSession);
              pendingSendToolCalls.delete(memberSession);
              v2TurnStartAt.delete(memberSession);
              turnLeaseNoted.delete(memberSession);
              toolCallNames.delete(memberSession);
              alsoCleared.push(memberKey);
            }
            delete state.sessionPolicies[memberKey];
            const memberSt = socialV2.conversations.get(memberCanonical);
            if (memberSt) memberSt.bootstrapSent = false;
            // 让这个成员的下一条消息重新走一遍 bootstrap（引导 + 记忆提示）。
            const memberPe = pending.get(memberKey);
            if (memberPe) {
              clearTimeout(memberPe.timer);
              cancelPendingEntry(memberPe).catch(() => {});
              pending.delete(memberKey);
            }
            clearSocialV2Timers(memberKey);
            pendingWakeKeys.delete(memberKey);
            wakeConfigUpdatedKeys.delete(memberKey);
            markReadCalledKeys.delete(memberKey);
            wakeConfigMissCount.delete(memberKey);
            forgetAgentToken(memberKey);
          }
          if (alsoCleared.length) {
            log(`控制台：共用会话 ${key} 清上下文，连带复位 ${alsoCleared.join('、')}（整组重走一次引导）`);
          }
          modelAppliedSessions.delete(oldSessionId);
          // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
          delete state.sessionPolicies[key];
          reverse.delete(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          turnLeaseNoted.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
                cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await withTimeout(api.stopSessionWork(oldSessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await withTimeout(api.stopSessionWork(item.sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await withTimeout(api.workspace.archiveSession({ sessionId: item.sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          socialV2.conversations.clear();
          CONVERSATION_TOKENS.clear();
          KNOWN_AGENT_TOKENS.clear();
          saveSocialV2State();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        // 主动对齐 DSH 端口。
        //
        // 为什么需要这个端点：桥接平时只在「探测到 DSH 连不上」时才重新跟随（有 60 秒
        // 冷却）。但有些时机使用者希望**立刻**对齐 —— 比如刚重启完 DSH、点「启动
        // SnowLuma」时。那次请求顺带调一下这里，桥接就跳过冷却直接重探一次。
        //
        // 语义是"促一次探测"，不是"强制改写"：如果当前 baseUrl 仍然可用，
        // followDshEndpoint 会原样返回（changed=false），不会无谓改配置。
        if (req.method === 'POST' && url.pathname === '/api/dsh/follow-endpoint') {
          try {
            // ⚠️ 必须先把磁盘上的值读回来再判断。
            // followDshEndpoint 的第一条是「配置里的 baseUrl 还能用就什么都不做」，
            // 而 cfg.dsh.baseUrl 是**启动时**加载进内存的 —— 如果配置文件在运行期间
            // 被改过（换端口、手工编辑、另一个进程写回），内存里还是旧值，
            // 于是这一步会拿旧值去探活、探通了就返回 changed:false，
            // 看起来"对齐成功"、实际磁盘上的错误值一个字都没动（实测踩过）。
            try {
              const diskCfg = loadConfig();
              if (diskCfg?.dsh?.baseUrl) cfg.dsh.baseUrl = String(diskCfg.dsh.baseUrl).trim();
            } catch { /* 读不到就沿用内存值，不阻断 */ }

            // ── 端口提示：调用方把自己**确切的** DSH 端口告诉我们 ────────────
            // 面板（qq-dsh-panel）就跑在 DSH 进程里，`req.socket.localPort` 就是
            // DSH 正在服务的端口 —— 那是**权威答案**，比扫监听列表靠谱得多。
            //
            // 为什么这条提示是「立刻连上」的关键：以前这条路径无论谁调都只能
            // 「扫一遍回环监听端口 + 逐个验指纹」。桌面版 DSH 每次启动换端口，
            // 于是每次都得白扫一遍；更糟的是它只能从端口列表里**猜**，猜错就是
            // 看起来对齐了、其实还连着旧端口。有了提示，一次指纹验证就够了。
            let body = {};
            try { body = await readBody(); } catch { body = {}; }

            // 先做一次掉线判定，让 dshReady 反映「对齐前」的真实情况（下面要用）。
            const wasReady = dshReady;
            await checkDsh();

            const r = await followDshEndpoint(cfg, { port: Number(body?.port) || 0 });
            if (r.changed) {
              // 端口变了要同步换掉 NodeApiClient 的 baseUrl，否则只改了 cfg 和
              // config.json，实际请求还打旧端口。
              api.baseUrl = r.baseUrl;
              api.invalidateAuth();
              log(`[dsh] 控制台请求主动对齐：${r.from || '(空)'} → ${r.baseUrl}（来源 ${r.reason || 'scan'}）`);
            }
            lastDshFollowAt = Date.now();

            // ── 对齐完必须**真的**验一次，而不是把「写了配置」当成「连上了」 ──
            // 旧实现的毛病：只把新值写进 cfg/config.json 就返回 ok，dshReady 仍然是
            // 下一轮 5 秒轮询才会更新。于是面板点完按钮立刻读 /api/status，看到的
            // 还是 dshReady=false，表现成「点了没反应」。这里同步跑一次 checkDsh()，
            // 用真实的 RPC 结果回答调用方。
            await checkDsh();

            // ── 把正在退避等待的事件流**立刻**叫起来 ──────────────────────
            // pumpMux 在「连上但 0 帧」时会指数退避（最长 30 秒）。端口刚对齐完，
            // 那个退避窗口还在睡，于是「端口对了、事件流却还要再等半分钟」。
            // 这里把等待打断，让它马上用新端口重连。
            if (!wasReady || r.changed) wakeMuxPump();

            sendJson({
              ok: true,
              changed: r.changed === true,
              baseUrl: r.baseUrl,
              from: r.from ?? null,
              reason: r.reason ?? null,
              dshReady,
            });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
            try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  /**
   * 纯语音模式：把一条文本合成为语音，返回可发送的 record 段。
   *
   * 为什么改在这里（onebotSend 是**所有**文本消息的唯一出口）：
   *   她照常调 qq_send_message 打字，语音这件事完全由桥接决定 ——
   *   她自己不知道、也不需要知道。这样人设不会被"要不要发语音"污染。
   *
   * 失败必须**降级成文字**，不能吞消息：TTS 只是表达方式，
   *   不是内容本身；合不出来还照样把字发出去，比静默失败好得多。
   */
  async function maybeSendAsVoice(kind, id, rawMessage, voiceCfg) {
    if (!voiceCfg?.enabled) return null;
    const text = String(rawMessage ?? '').trim();
    if (!text) return null;
    // 纯表情/纯符号没必要念出来（TTS 会把它们念成奇怪的东西）。
    if (!/[\p{L}\p{N}]/u.test(text)) return null;

    try {
      const r = await synthesizeTts(text, voiceCfg, { cacheDir: TTS_CACHE_DIR, log });
      return { type: 'record', data: { file: r.path } };
    } catch (error) {
      log(`[tts] 合成失败，降级为文字（${kind}:${id}）：${error?.message ?? error}`);
      appendActivity(`[tts] 合成失败，已降级为文字：${String(error?.message ?? error).slice(0, 80)}`);
      return null;
    }
  }

  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    // 纯语音：把文字换成语音条。带引用/@ 的消息不转（语音段放不下引用），
    // 合成失败也自动降级回文字。
    const voiceCfg = socialV2?.tts ?? null;
    const canVoice = voiceCfg?.enabled === true
      && (!segments.length)   // 没有引用/@ 前置段
      && kind;                // 群聊/私聊都支持
    const recordSegment = canVoice ? await maybeSendAsVoice(kind, id, rawMessage, voiceCfg) : null;
    if (recordSegment) {
      segments.push(recordSegment);
    } else {
      segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    }
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      // 语音条要过一次 SILK 转码，比纯文本慢，给足预算。
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(recordSegment ? 60000 : 15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  // 媒体上限（config.json 可调，但必须收敛到安全区间）：
  //   maxBytes  —— 单条消息里图片/表情的总字节上限。8MB 能覆盖绝大多数动图表情；
  //                太大会让 base64 常驻内存（×1.33）并拖慢 DSH 上传。
  //   maxPixels —— 单张图解码像素上限（防图片炸弹），与 DSH 的 64MP 默认一致。
  //   maxCount  —— 单条消息最多处理几张（防止一次 @ 带 20 张图把模型上下文撑爆）。
  const maxMediaBytesLimit = (() => {
    const n = Number(cfg.socialV2?.media?.maxBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(n))) : 8 * 1024 * 1024;
  })();
  const MAX_MEDIA_COUNT = (() => {
    const n = Number(cfg.socialV2?.media?.maxCount);
    return Number.isFinite(n) && n > 0 ? Math.min(8, Math.max(1, Math.round(n))) : 5;
  })();
  const MAX_MEDIA_BYTES = maxMediaBytesLimit; // 单条消息图片总字节上限
  const MAX_MEDIA_PIXELS = (() => {
    const n = Number(cfg.socialV2?.media?.maxPixels);
    return Number.isFinite(n) && n > 0 ? Math.min(64_000_000, Math.max(1_000_000, Math.round(n))) : 64_000_000;
  })(); // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  // ── 喂给模型的那一份：体积与动图形态归一化 ────────────────────────────────
  //
  // 为什么必须在这里动手（而不是"让 DSH 自己处理"）：
  //   ① DSH 的 MCP 图片入口用正则校验 base64，实测量级 ≥4,474,880 字符（原始字节 ≥3.20 MiB）
  //      必抛 RangeError: Maximum call stack size exceeded，工具结果被降级成
  //      `[image unavailable: image/gif; Maximum call stack size exceeded; …]` —— 模型只看到一行错误。
  //      而下面的 MAX_MEDIA_BYTES 是**抓取**上限（默认 8 MiB），故意留着不动：
  //      得先把大图抓下来，才有机会压小它。
  //   ② DSH 对 image/gif 一律归一化成单帧，模型永远只看第一帧，且不知道那是动图。
  //      动图在桥接侧抽帧拼图后，信息量反而更高（实测 4.83MB/200 帧 → 92KB/269ms）。
  //
  // 上限默认值见 media-normalize.js 的 MEDIA_DEFAULTS；config.json 的 socialV2.media 可覆盖。
  // ⚠️ 只用于**喂模型**的出口。collectStickerV2 走 fetchOneBotImage 的原始字节，不能经过这里，
  //    否则收藏下来的表情会变成拼图/降采样版本。
  const modelMediaLimits = (() => {
    const m = cfg.socialV2?.media ?? {};
    return {
      enabled: m.normalize !== false,
      maxModelBytes: m.maxModelBytes,
      maxLongEdge: m.maxLongEdge,
      gifFrames: m.gifFrames,
      gifTile: m.gifTile,
      timeoutMs: m.normalizeTimeoutMs,
      ffmpegPath: process.env.FFMPEG_PATH || cfg.socialV2?.voice?.ffmpegPath || null
    };
  })();

  /**
   * 把一张已抓到的图片整理成模型可安全消费的形态。
   * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string}>}
   *          ok=false 表示"压不到可用体积"——调用方必须把它变成一句可读的失败原因，
   *          绝不发注定被 DSH 丢掉的字节（那样模型只会看到看不懂的英文错误）。
   */
  async function toModelMedia(buffer, mimeType, label = '图片') {
    const out = await normalizeImageForModel(buffer, mimeType, { ...modelMediaLimits, label });
    if (!out.ok) {
      log(`[media] ${label} 不提供：${out.error}`);
      return out;
    }
    if (out.note) log(`[media] ${label}: ${out.note}`);
    return out;
  }

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  // QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
  // https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。
  // 市场表情不在网关缓存里（get_image 返回 image not found in cache），url 又可能缺失，
  // 这条兜底能救回这一类；只接受纯十六进制 id，绝不把任意字符串拼进 URL。
  function emojiCdnCandidates(emojiId) {
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }

  // 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。
  function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }

  /** 校验一张图片字节：格式、大小（调用方已限）、像素上限；不通过返回 null。 */
  function acceptImageBuffer(buf, label = '图片') {
    if (!buf || !buf.length) return null;
    if (!looksLikeImageBuffer(buf)) {
      log(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
      return null;
    }
    const dims = getImageDimensions(buf);
    if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
      log(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
      return null;
    }
    return { buffer: buf, mimeType: mimeFromBuffer(buf) };
  }

  async function fetchOneBotImage(media) {
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    // 统一用 media-kind.js 的判定（含 sub_type=7），别在这里另写一套。
    const isSticker = isStickerLike(media) || Boolean(emojiId);
    const label = isSticker ? '表情' : '图片';
    const failures = [];
    const urls = [];
    const pushUrl = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    pushUrl(media.url);
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate);

    const tryUrls = async () => {
      for (const url of urls) {
        try {
          const fetched = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
          const accepted = acceptImageBuffer(fetched.buffer, `${label} URL `);
          if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(url) };
          failures.push(`${url} 不是有效图片`);
        } catch (error) {
          failures.push(`${url}: ${error?.message ?? error}`);
        }
      }
      return null;
    };
    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker')) return null;
      if (!media.file || !isProbablySafeImageFileRef(media.file)) return null;
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          try {
            const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
          } catch (error) {
            failures.push(`get_image url: ${error?.message ?? error}`);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const accepted = acceptImageBuffer(fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
          }
        }
      } catch (error) {
        failures.push(`get_image: ${error?.message ?? error}`);
      }
      return null;
    };

    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      log(`[media] ${label}获取失败（${failures.length} 次尝试）：${failures.slice(0, 3).join(' | ')}`);
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    // 系统小表情（face 段）：只有数字 id 才有对应实体；拿不到时至少保留 summary 文案。
    const fallbackText = media.summary ? `[表情:${media.summary}]` : `[表情#${media.faceId}]`;
    if (!Number.isInteger(faceId)) return { text: fallbackText };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, '表情图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : fallbackText };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: fallbackText };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += prep.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `face-${media.faceId}.${(prep.mimeType || 'png').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          // 压不到可用体积：明确说明原因，别让模型对着「（获取失败）」瞎猜。
          parts.push({ type: 'text', text: `[表情${index}（${prep.error}）]` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
        const label = sticker ? (summary ? `[表情${summary}]` : `[表情${index}]`) : `[图片${index}]`;
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, `${label}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `${label}（图片总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          parts.push({ type: 'text', text: label });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}.${(prep.mimeType || 'image/jpeg').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          parts.push({ type: 'text', text: `${label}（${prep.error}）` });
        } else {
          parts.push({ type: 'text', text: `${label}（获取失败）` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' ? 'sticker' : 'image'), text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: [face.text || '', prep.note ? `（${prep.note}）` : ''].filter(Boolean).join(' ')
          });
        } else if (prep && !prep.ok) {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: `（获取失败：${prep.error}）` });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        // 表情包在 QQ 里也是 image 段（sub_type=1 或有 emoji_id），
        // 只认 kind==='sticker' 会把用户的收藏/斗图表情统统叫成「图片」。
        const stickerLike = isStickerLike(media);
        const kind = stickerLike ? 'sticker' : 'image';
        const noun = stickerLike ? '表情包' : '图片';
        const base = {
          index,
          kind,
          sticker: stickerLike,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, `${noun}${index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            ...base,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: prep.note ? `（${prep.note}）` : ''
          });
        } else if (prep && !prep.ok) {
          out.push({ ...base, text: `（${noun}获取失败：${prep.error}）` });
        } else {
          out.push({ ...base, text: `（${noun}获取失败）` });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    // 把「表情包」和「图片」分开报数：两者该有的反应完全不同
    // （表情包该接梗/回应情绪，图片该看内容），混成一个数字等于把判断依据抹掉。
    const stickerCount = mediaList.filter((m) => m && isStickerLike(m)).length;
    const imageCount = mediaList.length - stickerCount;
    const parts = [];
    if (stickerCount) parts.push(`${stickerCount} 个表情包`);
    if (imageCount) parts.push(`${imageCount} 张图片`);
    const what = parts.join(' + ') || `${mediaList.length} 个媒体`;
    const stickerNote = stickerCount
      ? '（表情包是在表达情绪/态度，通常不需要「描述画面」，而是接住那个情绪。）'
      : '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${what}${stickerNote}（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${what}${stickerNote}（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  // ── 发送节流（2026-11-13 新增）──────────────────────────────────────────
  //
  // 现象：她会在收尾观望循环里连续回话（观望 10 秒 → 有新消息 → 回 2~3 条 →
  // 再观望 → 又回…），一分钟内攒到 8 条就撞上 maxSendPerMinute 的限流。
  // 实测 01:13–01:17 四分钟发了 17 条，其中 01:14:49 → 01:15:07 的 18 秒里就 5 条。
  //
  // 这里加一道「同一会话两次发送之间至少隔 N 秒」的软节流：
  //   · 和 maxSendPerMinute 不同，它不看窗口总数，只看**上一次发送的时刻**；
  //   · 撞上时返回 429 + 剩余秒数，让她知道再等多久（而不是一句"频率超限"）；
  //   · 配置项 socialV2.send.minSendIntervalMs，默认 10000。
  //
  // 为什么不用"放宽 maxSendPerMinute"：那个阈值是防 QQ 风控的最后一道闸，
  // 调高换来的快，代价是真被冻结 —— 比一次 429 严重得多。
  //
  // ⚠️ 2026-11-15：**本函数目前没有调用方（死代码）**。
  // 它读的 `lastSendCallAt` 现在由 paceAfterSendV2 写成"预期返回时刻"，
  // 语义已经不对（那个值恒在未来 20 秒），如果哪天要接回节流，
  // 必须先改成用"上一次发送完成时刻"或独立的字段，否则一接回来就会
  // 把每次发送都判成超频。
  function sendThrottleRemainMsV2(st, now = Date.now()) {
    const minGap = Math.max(0, Number(cfg.socialV2?.send?.minSendIntervalMs ?? 10000));
    if (!minGap) return 0;
    // 2026-11-13 修：**按"上一次调用"算，不按"上一次发出去的消息"算**。
    //
    // 原来用 sendTimes 的 max：一次 send_message 发 3 条会压进 3 个相同时间戳，
    // 于是"发完 3 条后立刻补一句"被判成连发（实测报「再等 1 秒」）。
    // 但她一回合发 2~3 条本来就是允许的行为（burst 设计如此），
    // 节流要拦的是**跨回合的砸屏**，不是同一回合内的连续表达。
    //
    // 现在用独立的 lastSendCallAt：只有「一次新的工具调用」才会刷新它。
    const last = Number(st?.lastSendCallAt);
    if (!Number.isFinite(last) || last <= 0) return 0;
    const remain = minGap - (now - last);
    return remain > 0 ? Math.round(remain) : 0;
  }

  /** 记一次「发送调用」的时刻（节流用；与 sendTimes 的条数记账分开）。 */
  function noteSendCallV2(st, now = Date.now()) {
    if (!st) return;
    st.lastSendCallAt = now;
  }

  /**
   * 发送成功后的短暂空转（2026-11-13，2026-11-14 加"观察新消息"）。
   *
   * 两件事一起做：
   *   ① **节流**：保证「上一次发送调用」与「这一次」至少隔 minSendIntervalMs，
   *      避免跨回合砸屏。撞上时不是回 429（那会让模型重新思考、重新组句、重新发，
   *      一个回合变两个，每步都要重发整段历史），而是让这次调用多停一会儿。
   *   ② **观察**：空转期间如果有新消息进来，**提前结束等待**并把消息带回去
   *      （见返回值 `arrived`），行为与 qq_mark_read 的 10 秒观望一致。
   *
   * 为什么②重要：她刚说完话时对方最可能接话。如果只是干等 5 秒然后返回"发送成功"，
   * 那条新消息要等到下一个回合才被看到（多一次完整唤醒）。提前返回能让她
   * 在同一个回合里接着回，省一轮上下文重发。
   *
   * @returns {{arrived: boolean, waitedMs: number}} 是否等到了新消息
   */
  async function paceAfterSendV2(st, key, now = Date.now(), opts = {}) {
    if (!st) return { arrived: false, waitedMs: 0, text: '', count: 0 };
    const observeMs = Math.max(0, Number(cfg.socialV2?.send?.observeAfterSendMs ?? 30000));
    // ── 2026-11-15 操作者定义的语义 ─────────────────────────────────────
    //
    // 「她调用 qq_send_message 后，空转的时间 = 每条数组之间的随机间隔之和 + 20 秒」
    //
    // 关键事实：数组间隔**已经真实流逝了** —— sendMessagesV2 里的
    // `sendChain.then(() => sleep(d))` 是硬等（见那边的实现），
    // 所以走到这里时那 1~3 秒 × (N-1) 的间隔已经过去。
    //
    // 因此这里只需要补「20 秒」这一截，**不需要**再加间隔时间，
    // 也不该像旧实现那样拿 minSendIntervalMs 去抵减（那是"两次调用之间的节流"，
    // 和操作者要的"发完等对方接话"是两件事）。
    //
    // 连发 N 条时总等待自然变成 `Σ间隔 + 20s`：
    //   1 条 → 0 + 20 = 20s
    //   3 条 → 约 2~6 + 20 = 22~26s
    //   5 条 → 约 4~12 + 20 = 24~32s
    // 这正是操作者要的形状（条数越多，整体等得越久，因为前面已经花掉了间隔）。
    const waitMs = observeMs;
    st.lastSendCallAt = now + waitMs;
    try { saveSocialV2State(); } catch { /* ignore */ }
    if (waitMs <= 0) return { arrived: false, waitedMs: 0, text: '', count: 0 };
    // ── 观察期间等新消息（2026-11-14）────────────────────────────────────
    // 与 qq_mark_read 的观望同款：期间来了新消息就提前结束，把那几条贴回去，
    // 让她在同一个回合里接着回 —— 省掉一次完整唤醒（约 5~9 万 token 的重发）。
    //
    // ⚠️ 过滤依据必须是**快照差集**，不能用 `seq > beforeSeq`。
    // 因为 lastUnreadSeq 在消息入库那一刻就推进了：如果消息恰好在
    // "发送完成 → 这里"之间到达，beforeSeq 读到的已经是新值，那批消息全被漏掉。
    // 实测 13:23:09 的日志就是 `arrived=false waitedMs=7011 lastUnreadSeq=92 unread=1`
    // —— unread 里躺着一条，却被判成"没来新消息"。
    const seenAtStart = new Set(
      (Array.isArray(st.unread) ? st.unread : [])
        .map((m) => (m && Number.isSafeInteger(m.seq) ? m.seq : null))
        .filter((s) => s !== null)
    );
    log(`[pace] ${key} 开始观望 waitMs=${waitMs} 已有未读=${seenAtStart.size}`);
    // ⚠️ 2026-11-14：这里也改成「安静窗」语义，与 mark_read 完全一致。
    // 原来的 waitMs 只当总预算用，而且见第一条消息就返回 —— 她刚说完话、对方
    // 连发两句时，第一句就被单独贴回去，第二句又得等下一次唤醒，正是操作者
    // 要避免的"碎着给"。
    //
    // 参数：waitMs 仍是"没人说话时的干等时长"（= 节流间隔），
    //       安静窗取 socialV2.send.observeQuietMs（默认 5s，与收尾观望同口径），
    //       硬上限要**额外**加在 waitMs 之上 —— 不能沿用收尾那边的 20s 绝对值，
    //       因为这里的节流等待本身就可能接近 10s。
    const quietMs = Math.max(0, Number(cfg.socialV2?.send?.observeQuietMs ?? 10000));
    // 硬上限（2026-11-15 重算）：waitMs 已经是 20 秒（minSendIntervalMs），
    // 再叠加一个安静窗就会到 25~30 秒，逼近/超过传输层能容忍的范围。
    //
    // 现在的口径：**总时长封顶在 waitMs + 一个安静窗**，且再兜一个绝对上限。
    //   · 没人说话 ⇒ 等满 waitMs（20s）就返回，这是"发送后空转"的本体；
    //   · 有人说话 ⇒ 最多再多等一个 quietMs（把连发的几条合并），然后无论
    //     安静窗满没满都返回 —— 消息已经带上了，没必要求"满"。
    //
    // 为什么不一味抬高：这个 HTTP 请求一挂，她那个回合就卡着，
    // 而 MCP 侧 agentApi 虽然是 300s、DSH 侧 toolCallTimeoutMs 是 725s，
    // 但真正体感差的是「等 30 秒才回」本身。20+5=25 秒已经是能接受的上界。
    const hardCapMs = waitMs + quietMs;
    // ⚠️ 2026-11-15：观望期间**必须**压住唤醒调度，否则这 20 秒里消息一到
    // scheduleWakeV2 就会排一个 batchWindowMs 的唤醒，在她还在等的时候就
    // 准备下一个回合 —— 那批消息会被处理两遍（观望贴一次、唤醒再处理一次）。
    // 这个 Set 以前只有收尾观望在用，收尾观望删掉后就成了死代码，现在补到这里。
    const observeStamp = canonicalV2Key(key) ?? key;
    observingKeys.add(observeStamp);
    let ob;
    try {
      ob = await observeBeforeSleepV2(st, key, waitMs, { quietMs, hardCapMs });
    } finally {
      observingKeys.delete(observeStamp);
    }
    log(`[pace] ${key} 观望结束 arrived=${ob?.arrived} waitedMs=${ob?.waitedMs} 条数=${ob?.fresh?.length ?? 0} lastUnreadSeq=${st.lastUnreadSeq} unread=${(st.unread || []).length}`);
    let text = '';
    let count = 0;
    let maxSeq = 0;
    if (ob?.arrived) {
      // 只取观望期间**新出现**的那几条（不在开始时快照里的）。
      const fresh = (Array.isArray(st.unread) ? st.unread : [])
        .filter((m) => m && Number.isSafeInteger(m.seq) && !seenAtStart.has(m.seq));
      if (fresh.length) {
        const label = chatLabelForV2(key);
        const nowMs = Date.now();
        const rows = fresh.map((m) => renderOneMessageLine(compactModelMessage(m, { now: nowMs }), { label }));
        count = rows.length;
        // 格式与 qq_mark_read 的观望输出**完全一致**：`【N 条新消息】` + 消息行。
        // 两边用同一套排版，她不必为"这是哪个工具贴的"分神。
        if (count) text = [`【${count} 条新消息】`, ...rows].join('\n');
        // 水位对齐 mark_read 的 suggestedThroughSeq：她收尾时直接抄这个数，
        // 不用自己算"我读到哪儿了" —— 那正是以前标错已读的来源。
        maxSeq = fresh.reduce((mx, m) => Math.max(mx, Number(m.seq) || 0), 0);
        // 记成"已展示过"：下一轮 get_unread / wait 不会重复贴同一批。
        try { noteModelMessagesV2(st, fresh); } catch { /* ignore */ }
        try { saveSocialV2State(); } catch { /* ignore */ }
      }
    }
    return { arrived: !!ob?.arrived, waitedMs: ob?.waitedMs ?? 0, text, count, suggestedThroughSeq: maxSeq || undefined };
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    // 2026-11-15：把每条真正发出去的 message_id 也留下来。
    // 之前只 push 文本，于是「发出去之后想撤回」根本无 id 可用
    // （qq_recall_message 需要它）。顺序与 messages 一一对应。
    const sentIds = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          const receipt = await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
          // OneBot 的发送回执形如 { message_id: 123 }；拿不到就记 null（不编造）。
          const mid = receipt && (receipt.message_id ?? receipt.messageId);
          sentIds.push(Number.isFinite(Number(mid)) ? Number(mid) : null);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        err.sentIds = sentIds.slice();
        throw err;
      }
      // 返回值形状保持"数组"（既有调用方都在用 .length / 遍历），
      // 但把 id 挂在数组属性上 —— 这样不用改任何既有调用点就能拿到回执。
      // `${sent}` / for...of 仍然只看到文本，行为不变。
      const out = sent.slice();
      out.ids = sentIds.slice();
      return out;
    });
  }

  /**
   * 出站审计级别（三档权限分级后新增 'secret' 档）：
   *   'none'   —— 完全不拦。closed-agent 的 owner 私聊（既有设计：收件人就是机器主人）。
   *   'secret' —— 只拦凭据/令牌，**放行本机路径**。Owner 档（`private:<ownerQQ>`）：
   *              管理员让 AI"读一下桌面那个文件"之后，回复里带完整路径是正常且必要的；
   *              用 full 会把整条回复静默拦掉，表现为"AI 没反应"。
   *              但凭据/令牌仍然拦 —— 那是发到 QQ（会落进腾讯服务器与聊天记录）的东西。
   *   'full'   —— 路径 + 凭据 + 令牌全拦。群聊 / 白名单档 / 陌生会话（默认）。
   */
  function auditLevelFor(key) {
    if (currentMode === 'closed-agent') {
      return key === `private:${String(cfg.ownerQQ ?? '')}` ? 'none' : 'full';
    }
    if (sessionTier(key, currentMode, cfg) === 'owner') return 'secret';
    return 'full';
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计（级别见 auditLevelFor）。
  function shouldAuditKey(key) {
    return auditLevelFor(key) !== 'none';
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const audit = auditOutbound(text, { level: auditLevelFor(key), knownTokens: KNOWN_AGENT_TOKENS });
    if (audit.blocked) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含${audit.reason}`);
      appendActivity(`${key} agent 回复被拦截（疑似${audit.reason}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, `⚠️ 本条回复因疑似包含${audit.reason}被安全策略拦截，已记录并通知管理员。`);
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === modelSelectionEpoch) return 'applied';
    let provider = String(cfg.dsh?.provider ?? '').trim();
    let model = String(cfg.dsh?.model ?? '').trim();
    // **留空 = 不干预**（默认行为）：完全跟随 DSH 当前会话的模型。
    //
    // 为什么改成这样：别的机器上 DSH 接的可能是官方 DeepSeek、百炼、Kimi、本地 Ollama……
    // 桥接无从知道。强行 selectModel 的代价是双重的：
    //   ① 配错就每轮报错（会话其实还能跑，但用户会以为坏了）；
    //   ② 配对了会**写穿 DSH 全局默认**（~/.dsh/settings.yaml 的 agent-default-model），
    //      把用户桌面端新建对话的默认模型一起改掉。装个 QQ 机器人不该有这种副作用。
    if (!provider && !model) {
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'applied';
    }
    // 只配了一半：用已知的模型记录补齐；补不齐就不干预，而不是猜一个。
    if (!provider || !model) {
      const known = sessionModels.get(sessionId);
      provider = provider || String(known?.provider ?? '').trim();
      model = model || String(known?.model ?? '').trim();
      if (!provider || !model) {
        log(`[model] 只配了 ${provider ? 'model' : 'provider'}，另一半取不到 → 本次不干预，跟随 DSH 当前模型`);
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        return 'applied';
      }
    }
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    try {
      const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
      return 'applied';
    } catch (error) {
      const message = String(error?.message ?? error ?? '');
      // 会话**真的不存在**（DSH 重启/归档竞态）：调用方要退役重建，不能吞掉。
      if (/not[- ]?found/i.test(message)) {
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        return 'not-found';
      }
      // 模型/provider 配错了：**降级为不干预**，用 DSH 当前的模型继续跑。
      // 以前这里是重试 2 次再返回 'failed' —— 每条消息白等 1 秒、日志刷错，
      // 而会话其实一直能用。对一个"装上去就该能用"的桥接来说，这是错误的取舍。
      log(`⚠️ 设置会话模型失败（${provider}/${model} 可能在你的 DSH 里不存在）：${message}；已降级为跟随 DSH 当前模型`);
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'applied';
    }
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // 共用会话：组内任何成员先建出会话，其余成员直接复用同一个 sessionId。
    // 先扫一遍同组已存在的映射，命中就登记双向关系后返回 —— 这正是"两个 key 共用一个会话"。
    const group = shareGroupOf(key);
    if (group.length > 1) {
      for (const member of group) {
        if (member !== key && state.sessions[member]) {
          const shared = state.sessions[member];
          if (isCurrentSession(member, shared)) {
            state.sessions[key] = shared;
            state.sessionPolicies[key] = policy;
            if (!keysForSession.has(shared)) keysForSession.set(shared, new Set());
            keysForSession.get(shared).add(key);
            reverse.set(shared, sharedOwnerKeyOf(cfg, member));
            // ⚠️ 复用分支过去完全没碰 bootstrapSent（直接 return），
            // 于是"复用一个刚建好的会话"和"新建一个会话"在引导语义上不一致：
            // 新建分支会复位整组，复用分支不会。
            // 实测后果：清了某个 key 的上下文后，另一个 key 走复用路径拿到旧会话，
            // 那轮就只是普通唤醒 —— 没有【引导】、没有记忆提示。
            // 这里不主动复位（复用意味着会话还有上下文，不该当冷启动），
            // 只在**整组都还是未引导**时保持未引导，让下一次真正的新会话去处理。
            // 真正的复位点只有两个：ensureSession 的新建分支、/api/session/reset。
            saveState();
            log(`共用会话：${key} 复用 ${member} 的会话 ${shared}`);
            await ensureChatModel(shared);
            return shared;
          }
        }
      }
    }
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      // 共用组取组内最低权限档的 preset（见 sharedPresetName 的说明）；
      // 不在共享组里时就是本来的单会话 preset。
      const shareGroup = shareGroupOf(key);
      const preset = shareGroup.length > 1
        ? sharedPresetName(shareGroup, currentMode, cfg)
        : modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = wantedPresetName(key, currentMode, cfg);
        const tier = sessionTier(key, currentMode, cfg);
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode}${tier ? `、权限档位 ${tier}` : ''} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      // ── 条件 A「新会话」的唯一写入点（2026-11-13 重建）──────────────────
      //
      // 按 **DSH sessionId** 登记，不按 QQ key：共用会话下私聊和群拿到的是同一个
      // sessionId，登记一份就是全组一份，两个入口不可能各发一遍。
      // sessionId 变了 = 上下文一定没了，这是硬事实，比任何 reason 都可靠。
      //
      // ⚠️ 这里**不再复位 bootstrapSent**。
      // 旧实现靠"新会话 → bootstrapSent=false"来标记冷启动，于是它必须在这里清；
      // 而清完之后，调用方（控制台手动唤醒）刚刚 markGroupBootstrapSent 置的位
      // 会被紧随其后的 ensureSession 抹掉 —— 第二次手动唤醒又被判成首次，无限重复。
      // 现在冷启动由登记表回答，bootstrapSent 只剩"初始提示词注入过没有"这一个用途，
      // 而初始提示词本来就该跟着**新会话**重新注入一次，所以只在确实需要时清
      // ——那种情况由 reset 路径负责，不在这里顺手清。
      markColdStart(sessionId, 'new', `新建会话 ${key}`);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（小写；启动时从网关获取，识别"被提到"用）
  // 给 agent 看的身份（保留原始大小写）与机器人自己的 QQ 号。
  // 为什么必须单独存：消息里只有 "@樰" 这一串文本，agent 没有任何途径知道"樰"就是它自己，
  // 于是会把 @自己 当成 @别人、已读不回（issue #29）。昵称与 QQ 号要显式写进 prompt。
  let selfDisplayName = '';
  let selfUserId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
    // ── 好感度：**全局按 QQ 号存**，不再挂在会话上 ────────────────────────
    // 为什么改（2026-11-10 操作者要求，也是踩坑后的结论）：
    //   原来 affinities 存在 conversations[key].affinities 里，于是：
    //     · 「清除上下文」/「重置二代状态」/清空工作区 都会连它一起删掉；
    //     · 私聊和群各自存一份，靠 shareGroup 合并，逻辑本来就绕。
    //   操作者清了一次上下文，18 个人的好感度直接归零 —— 那是攒了很久的数据。
    //   关系是"我和这个人之间"的事实，不该因为某个聊天窗口重建而消失。
    // 现在：userId -> { score, stageId, lastAt, count, createdAt }
    //   与 key 无关；私聊/群、重置会话、换会话都不影响它。
    // 旧数据（会话里那份）在加载时会被合并进来，见 loadSocialV2 / migrateAffinitiesToGlobal。
    affinities: {},
    // 档位变化提醒：userId -> { from, to, at }。同样全局，不再按会话分。
    affinityStageChanges: {},
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  // triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
  // 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
  // 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
  // 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
  const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);
  function pickWakeTriggersV2(source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0)),
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 显式设置过的
  // （set_wake_config 写入的 'set_wake_config'）不会被覆盖。
  //
  // 2026-11-11：mark_read **不再**写 confirmedBy（旧注释把它和 set_wake_config
  // 并列是错的）。mark_read 只表示"我看完了"，不代表改过唤醒配置；让它冻结配置的
  // 后果是"控制台关掉提问唤醒也不生效"（实测踩过：一个问号仍会叫醒她）。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // ── 沉睡前拦截（2026-11-12 简化）──────────────────────────────────────
  //
  // 旧版这里有三套机制叠加：观察窗口（wait 满 N 分钟）、结束语识别、连续水位。
  // 观察窗口已经退役（wait 变成 passive，立刻返回），现在只剩一条真正有意义：
  //
  //   **还有她没看过的消息时，先让她看到，再让她决定收尾还是继续。**
  //
  // 具体表现放在调用方（mark_read / set_wake_config 的拦截分支）：
  // 不是回一句错误，而是把 `uncovered` 那几条按【本轮消息】的格式贴出来。
  //
  // 结束语识别保留：对方明确说了"晚安/拜拜/睡了"，说明对话结束，
  // 这时即使有零星的未读也不该拦她 —— 那几句大概率是无关闲聊。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|晚安啦|睡了|先睡了|睡啦|困了|下了|先下了|拜拜|再见|明天见|see\s*you|good\s*night|走了|先走|撤了|溜了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    // 只认最近 10 分钟内的结束语：三小时前的「晚安」不该放行今晚的收尾。
    // 用 text 优先而不是 tail：tail 只是最后的一小段，带表情/引用时可能把「晚安」吃掉。
    if (last.time && Date.now() - Number(last.time) > 10 * 60000) return false;
    return EXPLICIT_END_RE.test(String(last.text || last.plain || last.tail || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitMsForV2(key) {
    // 按会话区分：私聊默认 0（不用等），群聊默认 60 秒。
    // 理由：私聊来了就是找你，回完就能收；群里没人理的"等满"纯浪费时间。
    // 配置：wake.preSleepWaitMsPrivate / preSleepWaitMsGroup；未设置时回退到 preSleepWaitMs。
    const w = cfg.socialV2?.wake ?? {};
    const base = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const pick = String(key || '').startsWith('group:') ? w.preSleepWaitMsGroup : w.preSleepWaitMsPrivate;
    const n = Number(pick);
    return Number.isFinite(n) ? Math.max(0, n) : base;
  }

  function preSleepWaitBlockedV2(st, key) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    // 观察窗口退役：桥接会在后台盯回复（见 armReplyWindowV2），模型不需要在 wait 里等满。
    // 现在只剩一条硬约束：还有**没展示给模型**的新消息时先看完再收，
    // 避免把没看到的消息一起标成已读。
    const seen = st.modelSeenSeqs instanceof Set ? st.modelSeenSeqs : new Set(st.modelSeenSeqs || []);
    if ((st.unread || []).some((m) => !seen.has(m.seq))) return true;
    return false;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 全局记忆是**不是会话**：它没有唤醒配置、没有未读队列、没有定时器。
    // 但记忆相关的函数（appendMemoryV2 / formatMemoryV2 / 各端点）都要一个
    // "长得像会话状态"的对象来读写，所以这里把 globalMemory 补齐成同形状返回。
    // 绝不会被放进 socialV2.conversations —— 那会让十几处"遍历会话"的逻辑
    // 把它当成一个真实 QQ 聊天（见 globalMemory 定义处的说明）。
    if (key === GLOBAL_MEMORY_KEY) return globalMemory;
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(8).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        // 自我认知（selfNote）：它**对自己**的叙述，由它自己写。
        // 和上面几类的区别很关键：activeTopics 记"聊天进行到哪"，memberImpressions
        // 记"对方是什么人"，而这一条记的是"我变成了什么样"。
        // **刻意不进 formatMemoryV2**：每轮灌给它就成了新的灌输，成长必须是它自己
        // 想起来的。只在冷启动（新会话第一次唤醒）读一次，平时靠 qq_memory_query。
        selfNotes: [],
        // 好感度：userId → { score, stageId, lastAt, count, createdAt }。
        // 按人记而不是按聊天记 —— 同一个群里跟 A 熟、跟 B 生疏是两回事。
        affinities: {},
        // 档位变化提醒：userId → { from, to, at }。
        // 只在**档位真的变了**时写入，由唤醒包提示"某某的档位变了，回他之前先查一次"。
        // 目的：不再要求"每轮必查"，把那次工具调用省下来。
        affinityStageChanges: {},
        // 闲置压缩：idleCompactedAt 非 0 表示「这一轮对话已经压过」，直到用户
        // 再发消息才清零；idleCompactingAt 是正在压的防重入锁（跨扫描周期）。
        idleCompactedAt: 0,
        idleCompactingAt: 0
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      // 纯语音配置：从文件读回（2026-11-13 补）。
      // 之前 saveSocialV2State 不写 tts、loadSocialV2State 也不读 ——
      // 于是"纯语音开着的状态"活不过一次重启。现在两边都接上了。
      if (raw && raw.tts && typeof raw.tts === 'object') {
        socialV2.tts = normalizeTtsConfig(raw.tts);
      }
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(8).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(8).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
              triggers: pickWakeTriggersV2((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            // 只恢复「已压过」的标记；idleCompactingAt 属于进程内的锁，不落盘，
            // 否则崩溃/重启后会永久卡在「正在压缩」。
            idleCompactedAt: Number(val.idleCompactedAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            selfNotes: Array.isArray(val.selfNotes) ? val.selfNotes : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            // 好感度：按人记（userId → {score, stageId, lastAt, count}）。
            // 与 memberImpressions 分开存：印象是文字描述，好感是数值档位。
            affinities: (() => {
              const raw = (val.affinities && typeof val.affinities === 'object') ? val.affinities : {};
              const clean = {};
              for (const [k, v] of Object.entries(raw)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                if (!v || typeof v !== 'object') continue;
                const score = Number(v.score);
                clean[k] = {
                  score: Number.isFinite(score) ? score : AFFINITY_INITIAL,
                  stageId: String(v.stageId || affinityStageOf(Number.isFinite(score) ? score : AFFINITY_INITIAL).id),
                  lastAt: Number(v.lastAt) || 0,
                  count: Number(v.count) || 0,
                  createdAt: Number(v.createdAt) || 0,
                };
              }
              return clean;
            })(),
            // 档位变化提醒：{ userId: { from, to, at } }。只恢复 7 天内的，防脏数据无限堆积。
            affinityStageChanges: (() => {
              const raw = (val.affinityStageChanges && typeof val.affinityStageChanges === 'object')
                ? val.affinityStageChanges : {};
              const cutoff = Date.now() - 7 * 86400000;
              const clean = {};
              for (const [k, v] of Object.entries(raw)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                if (!v || typeof v !== 'object') continue;
                if (!(Number(v.at) > cutoff)) continue;
                clean[k] = { from: String(v.from || ''), to: String(v.to || ''), at: Number(v.at) || 0 };
              }
              return clean;
            })(),
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // ── 别名表：从顶层读（昵称 ↔ QQ 号）────────────────────────────────
        // 缺失时不报错：第一次启动没有这个字段很正常，运行中会自动建起来。
        try {
          const rawAliases = raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {};
          socialV2.aliases = {};
          for (const [uid, v] of Object.entries(rawAliases)) {
            if (!/^\d{4,12}$/.test(uid) || !v || !Array.isArray(v.names)) continue;
            const names = v.names.filter((n) => typeof n === 'string' && n.trim()).slice(0, 12);
            if (!names.length) continue;
            socialV2.aliases[uid] = {
              names,
              primary: String(v.primary || names[0]).slice(0, 64),
              lastAt: Number(v.lastAt) || 0
            };
          }
          // 回填：老数据的别名表是空的（这个字段 2026-11-12 才出现），
          // 不回填的话要等群里每个人都再说一句话才能查到号 —— 那要好几天。
          // 这里从各会话的 recentMessages / unread 里扫一遍 (userId, sender) 补进去。
          // 幂等：已有的号只是刷新 lastAt，不会重复建。
          let backfilled = 0;
          for (const [, st] of socialV2.conversations) {
            for (const m of [...(Array.isArray(st?.unread) ? st.unread : []),
              ...(Array.isArray(st?.recentMessages) ? st.recentMessages : [])]) {
              if (!m || m.isSelf) continue;
              if (m.userId == null || !m.sender) continue;
              const before = socialV2.aliases[String(m.userId)]?.names?.length ?? 0;
              if (noteAliasV2(m.userId, m.sender)) backfilled++;
              const after = socialV2.aliases[String(m.userId)]?.names?.length ?? 0;
              if (after > before) backfilled++;
            }
          }
          if (backfilled > 0) {
            log(`[alias] 别名表已从历史消息回填（${Object.keys(socialV2.aliases).length} 人）`);
          }
        } catch (error) {
          log('[alias] 别名表恢复失败（已跳过）:', error?.message ?? error);
          if (!socialV2.aliases) socialV2.aliases = {};
        }
        // ── 全局记忆：从**顶层**读（新格式），并把会话里的旧数据迁移进来 ──────
        // 迁移规则（去重合并，不丢内容）：
        //   · memberImpression：同一个 target 的多条 traits 合并去重；
        //     target 若是「私聊」这类非人名，换成对应的 QQ 号/主人名。
        //   · selfNote：按文本去重，保留最早 createdAt 与最新 lastTouchedAt。
        // 迁移只做一次：完成后会话里的旧副本会在下次落盘时消失
        // （saveSocialV2State 的会话段不再写这两类）。
        try {
          const rawGlobal = raw.globalMemory && typeof raw.globalMemory === 'object' ? raw.globalMemory : {};
          const imp = {};
          const noteMap = new Map();
          // 1) 顶层（新格式）
          for (const [name, v] of Object.entries(rawGlobal.memberImpressions || {})) {
            if (!v || !Array.isArray(v.traits)) continue;
            imp[name] = {
              traits: v.traits.filter(Boolean).slice(0, 10),
              interactionCount: Number(v.interactionCount) || 0,
              lastSeenAt: Number(v.lastSeenAt) || 0
            };
          }
          for (const n of (Array.isArray(rawGlobal.selfNotes) ? rawGlobal.selfNotes : [])) {
            if (!n || !n.text) continue;
            const text = String(n.text);
            const prev = noteMap.get(text);
            if (!prev) {
              noteMap.set(text, {
                text,
                createdAt: Number(n.createdAt) || Number(n.at) || Date.now(),
                lastTouchedAt: Number(n.lastTouchedAt) || Number(n.at) || Date.now()
              });
            } else {
              prev.createdAt = Math.min(prev.createdAt, Number(n.createdAt) || prev.createdAt);
              prev.lastTouchedAt = Math.max(prev.lastTouchedAt, Number(n.lastTouchedAt) || 0);
            }
          }
          // 2) 从各会话的旧副本迁移进来
          let migratedImp = 0;
          let migratedNote = 0;
          for (const [convKey, conv] of Object.entries(raw.conversations || {})) {
            if (!conv || typeof conv !== 'object') continue;
            for (const [name, v] of Object.entries(conv.memberImpressions || {})) {
              if (!v || !Array.isArray(v.traits) || !v.traits.length) continue;
              const merged = imp[name] || { traits: [], interactionCount: 0, lastSeenAt: 0 };
              for (const t of v.traits.filter(Boolean)) {
                if (!merged.traits.includes(t)) merged.traits.push(t);
              }
              merged.traits = merged.traits.slice(0, 10);
              merged.interactionCount += Number(v.interactionCount) || 0;
              merged.lastSeenAt = Math.max(merged.lastSeenAt, Number(v.lastSeenAt) || 0);
              imp[name] = merged;
              migratedImp += 1;
            }
            for (const n of (Array.isArray(conv.selfNotes) ? conv.selfNotes : [])) {
              if (!n || !n.text) continue;
              const text = String(n.text);
              const prev = noteMap.get(text);
              if (!prev) {
                noteMap.set(text, {
                  text,
                  createdAt: Number(n.createdAt) || Number(n.at) || Date.now(),
                  lastTouchedAt: Number(n.lastTouchedAt) || Number(n.at) || Date.now()
                });
                migratedNote += 1;
              } else {
                prev.createdAt = Math.min(prev.createdAt, Number(n.createdAt) || prev.createdAt);
                prev.lastTouchedAt = Math.max(prev.lastTouchedAt, Number(n.lastTouchedAt) || 0);
              }
            }
          }
          globalMemory.memberImpressions = imp;
          globalMemory.selfNotes = [...noteMap.values()].slice(-40);
          // 待办：读进来时把过期的丢掉（文件里可能残留旧的、或时钟被改过）。
          //
          // ⚠️ 但有一个必须留：**刚过期、还没提醒过**的那条。
          // 场景：她写了「六点提醒他拿快递」，桥接在 5:59 重启 ——
          // 如果这里严格按"没过期"过滤，那条就被吃掉，她永远收不到提醒。
          // 所以保留窗口是「过期后 10 分钟内且 notifiedAt 还是 0」，
          // 让 setupTodoTimerV2 有机会立刻补发一次，然后正常丢弃。
          const TODO_GRACE_MS = 10 * 60 * 1000;
          globalMemory.todos = (Array.isArray(rawGlobal.todos) ? rawGlobal.todos : [])
            .filter((t) => {
              if (!t || !t.text) return false;
              if (!t.expiresAt) return true;
              const due = Number(t.expiresAt);
              if (Date.now() < due) return true;
              // 已过期：只有"还没提醒过 + 在宽限期内"才留。
              return !t.notifiedAt && Date.now() - due < TODO_GRACE_MS;
            })
            .slice(-TODO_MAX);
          // 长期事实的"变化基线"也挂在全局：指纹 + 已见 id。
          // 不给默认值会让第一轮把整库当"新变化"提示一遍。
          globalMemory.factFingerprint = String(rawGlobal.factFingerprint || '');
          globalMemory.factSeenIds = Array.isArray(rawGlobal.factSeenIds) ? rawGlobal.factSeenIds.slice(-200) : [];
          if (migratedImp || migratedNote) {
            log(`[memory] 已把旧数据迁移进全局记忆：印象 ${migratedImp} 条、selfNote ${migratedNote} 条`);
          }
        } catch (error) {
          log('[memory] 全局记忆恢复失败（已跳过）:', error?.message ?? error);
        }
        // ── 好感度：从**顶层**读（新格式），并把会话里的旧数据迁移进来 ────────
        // 迁移规则（只增不减，取分最高的那份）：同一个 uid 可能分散在多个会话里，
        // 取 score 最大的；count 取最大的（它是"聊过几次"的累计事实，不该因为迁移变小）。
        // 迁移只做一次：完成后会话里的旧副本会在下次落盘时消失（saveSocialV2State 不再写它）。
        try {
          if (!socialV2.affinities || typeof socialV2.affinities !== 'object') socialV2.affinities = {};
          if (!socialV2.affinityStageChanges || typeof socialV2.affinityStageChanges !== 'object') {
            socialV2.affinityStageChanges = {};
          }
          // 1) 顶层已有的（新格式）
          const top = raw.affinities && typeof raw.affinities === 'object' ? raw.affinities : {};
          let migrated = 0;
          for (const [uid, rec] of Object.entries(top)) {
            if (!rec || !(Number(rec.count) > 0)) continue;
            socialV2.affinities[uid] = {
              score: Number(rec.score) || AFFINITY_INITIAL,
              stageId: String(rec.stageId || affinityStageOf(Number(rec.score) || AFFINITY_INITIAL).id),
              lastAt: Number(rec.lastAt) || 0,
              count: Number(rec.count) || 0,
              createdAt: Number(rec.createdAt) || 0,
              ...(Number(rec.manualAt) > 0 ? { manualAt: Number(rec.manualAt) } : {}),
            };
          }
          // 2) 会话里的旧数据（一次性迁移）
          for (const [, cst] of socialV2.conversations) {
            const old = cst.affinities && typeof cst.affinities === 'object' ? cst.affinities : {};
            for (const [uid, rec] of Object.entries(old)) {
              if (!rec || !(Number(rec.count) > 0)) continue;
              const cur = socialV2.affinities[uid];
              const candScore = Number(rec.score) || 0;
              const candCount = Number(rec.count) || 0;
              if (!cur) {
                socialV2.affinities[uid] = {
                  score: candScore,
                  stageId: String(rec.stageId || affinityStageOf(candScore).id),
                  lastAt: Number(rec.lastAt) || 0,
                  count: candCount,
                  createdAt: Number(rec.createdAt) || 0,
                };
                migrated += 1;
              } else {
                // 取更高的分（关系只增不减），次数取更大值。
                if (candScore > Number(cur.score)) {
                  cur.score = candScore;
                  cur.stageId = String(rec.stageId || affinityStageOf(candScore).id);
                  migrated += 1;
                }
                if (candCount > Number(cur.count)) cur.count = candCount;
                if ((Number(rec.lastAt) || 0) > (Number(cur.lastAt) || 0)) cur.lastAt = Number(rec.lastAt) || 0;
              }
            }
            // 迁移完就把会话里的旧副本清掉，避免以后又被当成"另一份数据"读出来。
            if (Object.keys(old).length) cst.affinities = {};
          }
          // 3) 档位变化提醒同样从顶层读（外层变量是 raw，不是循环里的 val）
          const topCh = raw.affinityStageChanges && typeof raw.affinityStageChanges === 'object'
            ? raw.affinityStageChanges : {};
          for (const [uid, v] of Object.entries(topCh)) {
            if (!v || typeof v !== 'object') continue;
            socialV2.affinityStageChanges[uid] = {
              from: String(v.from || ''), to: String(v.to || ''), at: Number(v.at) || 0,
            };
          }
          const total = Object.keys(socialV2.affinities).length;
          if (migrated > 0 || total > 0) {
            log(`[affinity] 全局好感度已加载：${total} 人${migrated > 0 ? `（本次从会话迁移 ${migrated} 条）` : ''}`);
          }
        } catch (error) {
          log(`[affinity] 加载全局好感度失败（已跳过）：${error?.message ?? error}`);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      // ── 别名表（昵称 ↔ QQ 号）：**顶层全局**一份 ──────────────────────────
      // 2026-11-12：为了让模型"只看人名、不带 QQ 号"，桥接必须能反查。
      // 结构：{ [userId]: { names: [...], lastAt, primary } }
      //   · names —— 这个号用过的所有昵称/群名片（自动合并，去重、按最近使用排序）
      //   · primary —— 最近一次用的名字（渲染时优先用它，保证同一个号显示同一个名）
      //   · lastAt —— 最近一次见到的时间
      // 与会话无关，且必须活过「清除上下文」（那是清会话，不该清"这人是谁"）。
      obj.aliases = (() => {
        const raw = socialV2.aliases && typeof socialV2.aliases === 'object' ? socialV2.aliases : {};
        const entries = Object.entries(raw)
          .filter(([uid, v]) => /^\d{4,12}$/.test(uid) && v && Array.isArray(v.names) && v.names.length)
          .map(([uid, v]) => [uid, {
            names: v.names.filter((n) => typeof n === 'string' && n.trim()).slice(0, 12),
            primary: String(v.primary || v.names[0] || '').slice(0, 64),
            lastAt: Number(v.lastAt) || 0
          }]);
        // 上限 1000 人：全局一份，比会话级宽得多。
        entries.sort((a, b) => b[1].lastAt - a[1].lastAt);
        return Object.fromEntries(entries.slice(0, 1000));
      })();
      // ── 好感度：**顶层全局**存一份（按 QQ 号），与会话无关 ────────────────
      // 放顶层的原因：它必须活过「清除上下文」「重置二代状态」「清空工作区」，
      // 因为那些操作只该清会话，不该清关系。之前挂在 conversations[key] 下，
      // 清一次上下文 18 个人的记录就全没了（2026-11-10 实际发生过）。
      obj.affinities = (() => {
        const raw = socialV2.affinities && typeof socialV2.affinities === 'object' ? socialV2.affinities : {};
        const entries = Object.entries(raw).filter(([, v]) => v && Number(v.count) > 0);
        // 上限 500 人：比原来每会话 200 宽，因为现在是全局一份，不该被截断得太狠。
        entries.sort((a, b) => (Number(b[1].lastAt) || 0) - (Number(a[1].lastAt) || 0));
        return Object.fromEntries(entries.slice(0, 500));
      })();
      // ── 纯语音（TTS）配置：必须落盘，否则重启后开关被重置 ──────────────────
      // 2026-11-13 修：以前这个字段压根没被保存，于是每次重启"纯语音"都变回关闭。
      //   之前一直当成"重启会重置开关"，其实是数据从来没写进文件。
      //   只存**开关 + 关键参数**，不存缓存路径之类的运行时东西。
      obj.tts = socialV2.tts && typeof socialV2.tts === 'object'
        ? { ...socialV2.tts }
        : {};

      // 档位变化提醒：只留最近 20 条、7 天内的。
      obj.affinityStageChanges = (() => {
        const raw = socialV2.affinityStageChanges && typeof socialV2.affinityStageChanges === 'object'
          ? socialV2.affinityStageChanges : {};
        const cutoff = Date.now() - 7 * 86400000;
        return Object.fromEntries(
          Object.entries(raw)
            .filter(([, v]) => v && Number(v.at) > cutoff)
            .slice(-20),
        );
      })();
      // ── 全局记忆：**顶层存一份**，与会话无关 ────────────────────────────────
      // 和 affinities 同理：memberImpressions / selfNotes 必须活过「清除上下文」
      // 和「重置二代状态」——那些操作只该清会话，不该把"她是谁、她认识谁"一起抹掉。
      // 以前这两类挂在 conversations[key] 下，清一次上下文就全没了，
      // 而且同一个群友在不同 key 下会各存一条（"印象里出现两个我"就是这么来的）。
      obj.globalMemory = {
        memberImpressions: (() => {
          const raw = globalMemory.memberImpressions && typeof globalMemory.memberImpressions === 'object'
            ? globalMemory.memberImpressions : {};
          const entries = Object.entries(raw)
            .filter(([, v]) => v && Array.isArray(v.traits) && v.traits.length);
          // 上限 500：全局一份，别截得太狠。
          entries.sort((a, b) => (Number(b[1].lastSeenAt) || 0) - (Number(a[1].lastSeenAt) || 0));
          return Object.fromEntries(entries.slice(0, 500));
        })(),
        // selfNote 上限 40：慢变量，堆太多互相稀释。
        selfNotes: (Array.isArray(globalMemory.selfNotes) ? globalMemory.selfNotes : []).slice(-40),
        // 待办：全局一份，但**只存还没过期的** —— 过期的事不该占用文件，
        // 也没必要让她下次读到一堆早已经过去的事。
        todos: (Array.isArray(globalMemory.todos) ? globalMemory.todos : [])
          .filter((t) => {
            if (!t || !t.text) return false;
            if (!t.expiresAt) return true;
            const due = Number(t.expiresAt);
            if (Date.now() < due) return true;
            // 和加载那边同一条规则：刚过期还没提醒过的要留着，否则重启就丢了。
            return !t.notifiedAt && Date.now() - due < 10 * 60 * 1000;
          })
          .slice(-TODO_MAX),
        // 长期事实的「变化基线」：全局一份（事实本身也是全局的）。
        factFingerprint: String(globalMemory.factFingerprint || ''),
        factSeenIds: Array.isArray(globalMemory.factSeenIds) ? globalMemory.factSeenIds.slice(-200) : []
      };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          idleCompactedAt: st.idleCompactedAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          // 长期事实的内容指纹（id 序列 + hits）：判断「内容变了没有」，没变就不提示。
          factFingerprint: String(st.factFingerprint || ''),
          // 上一次「全量看到过」的事实 id 列表（冷启动注入时写入）。
          // 工具据此只返回「新增的」和「已经掉出去的」，而不是每次都给全部 30 条。
          factSeenIds: Array.isArray(st.factSeenIds) ? st.factSeenIds.slice(-200) : [],
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          selfNotes: Array.isArray(st.selfNotes) ? st.selfNotes.slice(-40) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          // ⚠️ 好感度**不再**按会话落盘（2026-11-10）：
          //   它现在存在顶层的 socialV2.affinities 里，见下面 obj 的组装。
          //   这里保留一个空对象，是为了让老版本读完不炸、以及迁移期间不丢字段。
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  // ── 二代仿真：操作者预写的「初始提示词」（每个会话一份，只在首次唤醒时注入） ──────
  //
  // 用途：让操作者在控制台提前告诉 AI「这个群是什么圈子、什么氛围、有什么忌讳」。
  // 为什么单独一个文件、而不是塞进 social-v2.json 的会话状态：
  //   · 会话状态会被 /api/session/reset 与 /api/socialV2/reset 整体删除，而这份是操作者
  //     手写的配置 —— 重置一次 AI 上下文不该把它一起清掉；
  //   · 控制台需要能在群还没说过话（连会话状态都还不存在）时就写好。
  // 为什么只在首次唤醒（bootstrap）注入：这是一份「接入这个群时的背景介绍」，每轮都塞
  // 既白烧 token，又会让 AI 把它当成新指令；首次唤醒后它已在 DSH 会话上下文里。
  const initialPrompts = new Map(); // key -> { text, createdAt, updatedAt }
  let initialPromptsWritable = true;

  function initialPromptMaxChars() {
    const n = Number(cfg.socialV2?.initialPromptMaxChars);
    return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.max(100, Math.round(n))) : 2000;
  }

  /** 归一化操作者输入：统一行尾、去掉 BOM 与控制字符，只裁首尾空白（保留段落换行）。 */
  function normalizeInitialPromptText(raw) {
    return String(raw ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  /**
   * 读取 state/initial-prompts.json。
   * 读不动/读坏时降级为「只读不写」（与 sessions.json、表情库、黑话库同一口径）：
   * 否则内存里的空映射会在下一次保存时把原文件覆盖掉，操作者写的内容永久丢失。
   */
  function loadInitialPrompts() {
    let raw;
    try {
      raw = fs.readFileSync(INITIAL_PROMPTS_FILE, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        initialPromptsWritable = false;
        log(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      initialPromptsWritable = false;
      log(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      initialPromptsWritable = false;
      log('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受规范 key；__proto__/constructor 这类脏键在这里就被过滤掉。
      const canonical = canonicalV2Key(key);
      if (!canonical) continue;
      // 注意：这里**不按上限截断**。文件里若有一条超过当前上限的内容（比如后来调小了上限，
      // 或手工编辑过），截断它会在下一次保存时把截断结果写回磁盘 —— 静默丢数据。
      // 上限只在「保存」和「注入」两个出口生效。
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      initialPrompts.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (initialPrompts.size) log(`已加载 ${initialPrompts.size} 条会话初始提示词`);
  }

  function saveInitialPrompts() {
    if (!initialPromptsWritable) {
      log('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of initialPrompts) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      atomicWriteJson(INITIAL_PROMPTS_FILE, obj);
      return true;
    } catch (error) {
      log('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }

  function getInitialPrompt(key) {
    const canonical = canonicalV2Key(key);
    return canonical ? (initialPrompts.get(canonical) ?? null) : null;
  }

  /**
   * 保存/删除一份初始提示词。空内容 = 删除。
   * 写入失败时把内存改动回滚，保证「接口说失败」与「内存里确实没变」一致。
   * @returns {{ok: boolean, statusCode?: number, error?: string, key?: string, deleted?: boolean, chars?: number, entry?: object|null}}
   */
  function setInitialPrompt(key, rawText) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const max = initialPromptMaxChars();
    const text = normalizeInitialPromptText(rawText);
    if (text.length > max) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${max}）；请精简后重试` };
    }
    const prev = initialPrompts.get(canonical) ?? null;
    const rollback = () => { if (prev) initialPrompts.set(canonical, prev); else initialPrompts.delete(canonical); };
    if (!text) {
      initialPrompts.delete(canonical);
      if (!saveInitialPrompts()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    initialPrompts.set(canonical, entry);
    if (!saveInitialPrompts()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }

  /**
   * 首次唤醒时插入的环境段；没有配置就返回空串（不影响原有 prompt）。
   * 超长内容按上限截断后注入（文件可能被手工改过），并在截断处留省略号。
   */
  function formatInitialPromptV2(key) {
    const entry = getInitialPrompt(key);
    if (!entry?.text) return '';
    const max = initialPromptMaxChars();
    const body = entry.text.length > max ? `${truncateText(entry.text, max)}…（已按上限截断，完整内容见控制台）` : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你。';
    } else if (recentAi2m >= 2) {
      hint = '你刚连说了几次。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话。';
    } else if (aiCount >= 5) {
      hint = '你这一小时说得比较多。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `近 5 分钟 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}在聊，比较热闹。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群里聊得多，没人叫你。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群里话不多。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    // 只给事实（谁在聊、聊了多少），不给"该不该开口"的指令：说什么、说不说是角色自己的事。
    return `【群聊现状】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  /**
   * 把记忆渲染成给模型看的纯文本。
   *
   * 2026-11-11 重排（操作者要求「做成和长期记忆一样的」+「会话级的两类要带上 key」）：
   *   · 每类记忆**各占一段**，段间空行（与 formatFactsBlock 同一排版）；
   *   · 段首统一「【标题】N 条（一句说明）」；
   *   · 没内容也输出一行，不再整段消失（否则 formatted 为空 → MCP 回退成裸 JSON）；
   *   · **activeTopic / pendingThought 是会话级的**，段首必须标出属于哪个 key，
   *     否则她分不清"这个话题是群里的还是私聊的"——共用会话下尤其危险，
   *     会把群里的话题当成私聊的接着说。
   *
   * @param {object} st   记忆状态（会话级的来自本会话、长期三类来自全局）
   * @param {string} key 这个会话的 key（如 group:20001），用于标注会话级记忆的归属
   */
  function formatMemoryV2(st, key = '') {
    if (!st) return '';
    const blocks = [];
    const now = Date.now();
    // 会话级记忆的归属标注：有 key 就写「属于 xxx」，没有就留空说明是"当前会话"。
    // key 原样输出（group:20001 / private:10001），因为模型发言时要照抄它。
    const scope = key ? `属于 ${key}` : '属于当前会话';

    // ① 进行中的话题（会话级）
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      const lines = [`【进行中的话题】${topics.length} 条（${scope}；只在那个聊天里成立，不要搬到别的聊天去接）`];
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((now - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && now - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? `${ago} 分钟前` : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
      blocks.push(lines.join('\n'));
    }
    // ② 想说但还没说的（会话级）
    const thoughts = Array.isArray(st.pendingThoughts)
      ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || now < t.expiresAt))
      : [];
    if (thoughts.length) {
      const lines = [`【你想说但还没说的】${thoughts.length} 条（${scope}；说出去或过期就没了）`];
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
      blocks.push(lines.join('\n'));
    }
    // ②b 待办（全局；一两天内要兑现的事，到期自动消失）
    const todos = Array.isArray(st.todos)
      ? st.todos.filter((t) => t && t.text && (!t.expiresAt || now < t.expiresAt))
      : [];
    if (todos.length) {
      const lines = [`【待办】${todos.length} 条（一两天内要做完的事；到期自动消失，不用一直记着）`];
      for (const t of todos.slice(-10)) {
        // 剩余时间用"还剩几小时/几天"表达，比绝对时间戳好读。
        const leftMs = Number(t.expiresAt) ? Number(t.expiresAt) - now : 0;
        const leftText = leftMs > 0
          ? (leftMs >= 24 * 3600 * 1000
            ? `还剩 ${Math.round(leftMs / (24 * 3600 * 1000))} 天`
            : `还剩 ${Math.max(1, Math.round(leftMs / 3600000))} 小时`)
          : '';
        lines.push(`- ${t.done ? '[已完成] ' : ''}${t.text}${leftText ? `（${leftText}）` : ''}`);
      }
      blocks.push(lines.join('\n'));
    }
    // ③ 对群友的印象（全局一份，按 QQ 号记）
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const uids = Object.keys(impressions);
    if (uids.length) {
      const lines = [`【对群友的印象】${uids.length} 人（按 QQ 号记，所有聊天共用同一份）`];
      for (const uid of uids.slice(-10)) {
        const im = impressions[uid] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        // 键是 QQ 号（全局唯一）。展示名**现取自别名表** ——
        // 名字的唯一真相在那里（桥接每条消息都会写），impression 里不再存副本。
        // 拿不到名字才退回号码，不猜。
        const label = String(displayNameOfV2(uid, '') || '').trim() || uid;
        const shown = label === '私聊' ? `QQ${uid}` : label;
        lines.push(`- ${shown}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
      blocks.push(lines.join('\n'));
    }
    // ④ 自我认知（全局一份，只有她能写）
    const selfNotes = Array.isArray(st.selfNotes) ? st.selfNotes.filter((n) => n && n.text) : [];
    if (selfNotes.length) {
      const lines = [`【你对自己的认识】${selfNotes.length} 条（全局一份；你自己一路写下来的，不是别人告诉你的）`];
      for (const n of selfNotes.slice(-10)) lines.push(`- ${n.text}`);
      blocks.push(lines.join('\n'));
    }

    // 段间空行 —— 和 formatFactsBlock（长期记忆）保持同一种排版。
    return blocks.join('\n\n');
  }

  /**
   * 冷启动时给模型看它自己写下的自我认知。
   *
   * ⚠️ 2026-11-10 起**不再被唤醒包调用**：操作者要求唤醒词里不带记忆正文，
   * 三类记忆统一改成她自己调 qq_memory_query 查。函数保留是因为控制台/调试脚本
   * 还在用同款格式，删掉会连累那边的输出。别再把它接回 buildWakePromptV2。
   *
   * 为什么当初只在 bootstrap 给：这层如果每轮注入，就变成"别人告诉你你是谁"，
   * 和它自己慢慢长出来的叙述是两回事。
   */
  function formatSelfNotesV2(st, limit = 20) {
    const notes = Array.isArray(st?.selfNotes) ? st.selfNotes.filter((n) => n && n.text) : [];
    if (!notes.length) return '';
    return `【你对自己的认识】这些是你自己一路写下来的，不是别人告诉你的：\n${notes.slice(-limit).map((n) => `- ${n.text}`).join('\n')}\n\n`;
  }

  /**
   * 群友印象：按人列，一人一段，traits 用 · 连起来。
   *
   * ⚠️ 同 formatSelfNotesV2：2026-11-10 起不再进唤醒包，改由 qq_memory_query 返回。
   */
  function formatMemberImpressionsV2(st, limit = 30) {
    const im = st?.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const rows = Object.entries(im)
      .filter(([, v]) => v && Array.isArray(v.traits) && v.traits.length)
      .map(([uid, v]) => ({
        // 展示名现取自别名表（名字的唯一真相），impression 里不存副本。
        name: String(displayNameOfV2(uid, '') || '').trim() || (uid === '私聊' ? `QQ${uid}` : uid),
        traits: v.traits.filter(Boolean),
        seen: Number(v.lastSeenAt) || 0
      }))
      .sort((a, b) => b.seen - a.seen)
      .slice(0, limit);
    if (!rows.length) return '';
    const lines = rows.map((r) => `- ${r.name}：${r.traits.join(' · ')}`);
    return `【群友印象】你记下的这些人（不是评价，是你观察到的小事）：\n${lines.join('\n')}\n\n`;
  }

  // todo 的常量（TODO_DEFAULT_TTL_MS / TODO_MAX）定义在文件前面的 GLOBAL_MEMORY_KEY 旁边，
  // 因为 loadSocialV2State 也要用；这里不要再重复声明。

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    // todo：过期的直接丢掉（这是它和 longTerm 的根本区别 —— 事情过了就不该再记着）。
    if (Array.isArray(st.todos)) {
      st.todos = st.todos.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'todo' && text) {
      // 待办：一两天内要兑现的事（「明天讲那张卡片」「六点十分提醒他拿快递」）。
      //
      // 为什么单独一类：这类事塞进 longTerm 会污染长期记忆（几个月后不成立），
      // 塞进 pendingThought 又不对（那是"想说没说出口的话"，不是"要做的事"）。
      // 区别在于 todo 有明确的**到期时间**，过了就自动消失。
      //
      // extra.dueAtMs：距离现在多少毫秒到期。不传就按 TODO_DEFAULT_TTL_MS（48h）。
      // 传了负值/0 视为"现在就过期"，等于写了个立刻失效的待办 —— 允许，
      // 因为有时候她只是想确认一下"这条不用记了"。
      if (!Array.isArray(st.todos)) st.todos = [];
      const ttl = extra.dueAtMs !== undefined && extra.dueAtMs !== null
        ? Math.max(0, Number(extra.dueAtMs) || 0)
        : TODO_DEFAULT_TTL_MS;
      const dueAt = Date.now() + ttl;
      // 2026-11-12：记下是哪个会话排的，到点好按会话唤醒。
      // todo 存在全局，但唤醒定时器必须挂在具体 key 上（见 setupTodoTimerV2）。
      const wakeKey = canonicalV2Key(extra.sessionKey || extra.key || '') || '';
      const existing = st.todos.find((t) => t && String(t.text || '') === text);
      if (existing) {
        // 同一件事再提一次：延后到期时间（等于"又提到了，还没做"），不新增一条。
        existing.expiresAt = dueAt;
        existing.lastMentionAt = Date.now();
        if (wakeKey) existing.wakeKey = wakeKey;
        // 到期时间变了 → 之前那次提醒作废，重新排。
        existing.notifiedAt = 0;
        if (extra.done === true) existing.done = true;
      } else {
        st.todos.push({
          text: truncateText(text, 200),
          createdAt: Date.now(),
          lastMentionAt: Date.now(),
          expiresAt: dueAt,
          // wakeKey：哪个会话写的，到点就在那个会话里叫醒她。
          wakeKey,
          // notifiedAt：已经提醒过的毫秒时间戳，0/空表示还没提醒。
          notifiedAt: 0,
          // done 标记：做完了但还想留个痕（下次清理时按过期时间丢掉）。
          done: extra.done === true
        });
      }
      // 上限 20 条：先丢已完成的，再丢最早到期的。
      if (st.todos.length > TODO_MAX) {
        st.todos.sort((a, b) => {
          const ad = a.done ? 0 : 1;
          const bd = b.done ? 0 : 1;
          if (ad !== bd) return ad - bd;
          return (Number(a.expiresAt) || 0) - (Number(b.expiresAt) || 0);
        });
        st.todos.splice(0, st.todos.length - TODO_MAX);
      }
      // 排/重排这个会话的待办定时器（做了 mark_read 之类的不影响它）。
      // 放在 appendMemoryV2 外面的调用方去排也行，但那样每个调用点都要记得，
      // 集中在这里最不容易漏。
      try { if (wakeKey) setupTodoTimerV2(wakeKey); } catch (error) {
        log(`[todo] 排待办定时器失败（不影响写入）：${error?.message ?? error}`);
      }
    } else if (cat === 'memberImpression') {
      // 2026-11-10：按**全局 QQ 号**记，不按昵称（见 resolveImpressionTarget 的说明）。
      // 全局存储下同一个人只会有一条，不会因为出现在多个群/私聊而分裂。
      const resolved = resolveImpressionTarget(extra.sessionKey || extra.key || '', extra.target);
      if (!resolved || !resolved.id) return;
      const target = resolved.id;
      if (['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      // 每个人的印象最多 10 条。
      //
      // 2026-11-12 修：旧代码是 `old.traits.slice(0, 10)` 再 push —— 读的时候取前 10 条，
      // 但 push 之后**没有再截断**，于是 traits 会涨到 11、12 条。
      // 下次再读又只取前 10 条，第 11 条之后的内容写进去了却显示不出来（静默丢失）。
      // 现在：先过滤掉重复，push 之后立刻截到最后 10 条 —— 满了就丢最旧的，而不是丢最新的。
      const traits = Array.isArray(old.traits) ? old.traits.filter(Boolean) : [];
      const one = String(text || '').slice(0, 50);
      if (one && !traits.includes(one)) traits.push(one);
      const capped = traits.slice(-10);
      st.memberImpressions[target] = {
        traits: capped,
        // 2026-11-12：**不再自己存 name**。
        // 名字的唯一真相是别名表（socialV2.aliases），桥接每收到一条消息都会写
        // （noteAliasV2），人会改昵称、会有多个昵称，那是它该管的事。
        // 这里再存一份只会变成过期副本 —— 展示时统一用 displayNameOfV2 现取。
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      // 全局上限 500：印象是全局一份，别按会话那个 50 条截。
      if (impressionEntries.length > 500) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 500; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    } else if (cat === 'selfNote' && text) {
      // 自我认知：它对自己的叙述（"我最近好像越来越爱用省略号了"、
      // "他其实不太聊私事，但会跟我说工作上的糟心事"）。
      // 去重按整句文本；同一句再写一次只刷新"最近碰过"的时间，不再堆一条。
      if (!Array.isArray(st.selfNotes)) st.selfNotes = [];
      const noteText = truncateText(text, 300);
      const existing = st.selfNotes.find((n) => n && String(n.text || '') === noteText);
      if (existing) {
        existing.lastTouchedAt = Date.now();
      } else {
        st.selfNotes.push({ text: noteText, createdAt: Date.now(), lastTouchedAt: Date.now() });
      }
      // 上限 40 条：自我认知是慢变量，堆太多反而互相稀释。超了就丢最久没碰的。
      if (st.selfNotes.length > 40) {
        st.selfNotes.sort((a, b) => (Number(a.lastTouchedAt) || 0) - (Number(b.lastTouchedAt) || 0));
        st.selfNotes.splice(0, st.selfNotes.length - 40);
      }
    }
    saveSocialV2State();
  }

  loadSocialV2State();
  // 操作者预写的会话初始提示词（与控制台入口同样在 main() 里；损坏时只读降级，不阻塞启动）。
  loadInitialPrompts();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    // 这一轮渲染时看到的冷启动登记时刻：投递被接受后用它消费标记（见 commitColdStart）。
    let coldStartAnchor = 0;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      // ★ 全桥接唯一的唤醒词渲染点（2026-11-13 重建）。
      //   sendWakePromptV2 传进来的是空串，这里渲染出来才是真正要发的内容。
      promptText = buildWakePromptV2(key, opts.wakeReason);
      coldStartAnchor = coldStartStateOf(key).anchor || 0;
      wakeSnapshot = buildWakeSnapshotV2(key);
      if (wakeSnapshot) {
        // 纯文本渲染，不再 JSON.stringify；使用说明（partial / throughSeq / reply 静默）
        // 全部收进 persona，不再每轮跟着消息一起灌进去。
        // base 可能为空（身份/令牌/facts 都进了 system prompt 且没有角色），
        // 这时不要留下前导空行。
        const snap = renderWakeSnapshotV2(wakeSnapshot, key);
        if (snap) promptText = promptText ? `${promptText}\n\n${snap}` : snap;
      }
    }
    let content = [{ type: 'text', text: promptText }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: promptText }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    // 登记"这一轮是替谁发的"：共用会话时私聊与群共用一个 sessionId，
    // 回复必须发回它自己的聊天。必须在 prompt 之前登记 —— turn/start 可能比响应先到。
    pushTurnKey(sessionId, key);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      // 投递失败：撤回刚登记的归属，否则后续回合的回复会错位到这条聊天上。
      const arr = turnKeyQueue.get(sessionId);
      if (arr) {
        const idx = arr.lastIndexOf(key);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) turnKeyQueue.delete(sessionId);
      }
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      // 同上：没被接受就没有对应的回合，归属记录必须撤回。
      const arr = turnKeyQueue.get(sessionId);
      if (arr) {
        const idx = arr.lastIndexOf(key);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) turnKeyQueue.delete(sessionId);
      }
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    // ★ 冷启动提示**已经真的投递出去**了，消费掉标记（2026-11-13 重建）。
    //
    // 放在这里而不是渲染时：上面所有 return 都是"还没发出去"（被拒 / 阻塞 / 跳过），
    // 那些路径必须保留标记，否则提示随失败一起消失 —— 旧实现压缩后那句永远发不出去，
    // 就是因为它在渲染时就把标记清了。
    if (coldStartAnchor) commitColdStart(sessionId, coldStartAnchor);
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      if (wakeSnapshot.shared) {
        // 共用会话：消息来自多个聊天，必须**各记各的**——每条登记到它自己那个 chat 的状态里。
        // 以前这里一律记到 wakeState（= 当前唤醒的聊天），于是群里的消息被记进私聊的
        // modelSeenSeqs，两个聊天的水位都算不出来，mark_read 永远 400
        //（"throughSeq 必须是不超过已展示连续消息水位"）。
        const byChat = new Map();
        for (const row of wakeSnapshot.messages || []) {
          const ck = row.chatKey;
          if (!ck) continue;
          if (!byChat.has(ck)) byChat.set(ck, []);
          if (row.message) byChat.get(ck).push(row.message);
        }
        for (const [ck, msgs] of byChat) {
          try { noteModelMessagesV2(getSocialV2State(ck), msgs); } catch { /* 单聊状态坏了不影响整轮 */ }
        }
      } else {
        noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
      }
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记、以及共用会话下的回复归属都能准确对上自己的 turn。
  //
  // ⚠️ 队列键用 queueKeyOf（共享组代表 key），不是原本的 QQ key：
  // 共用会话时私聊与群是同一条 DSH 会话，若各自并发投递，两个 turn 会交错，
  // 回复必然串号。按组串行才是正确粒度。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      const qkey = queueKeyOf(key);
      let entry = promptQueues.get(qkey);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(qkey, entry);
      }
      // 真正要发给谁记在 item 里 —— 队列按组串行，但每条仍然发回自己的聊天。
      entry.queue.push({ key, promptText, opts, resolve, reject });
      processPromptQueue(qkey);
    });
  }

  async function processPromptQueue(qkey) {
    const entry = promptQueues.get(qkey);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(qkey);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(item.key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(qkey) === entry) {
        if (entry.queue.length) processPromptQueue(qkey);
        else promptQueues.delete(qkey);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    return selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
  }
  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // ── 发送后提示已移除（2026-11-14，操作者要求）──────────────────────────
  //
  // 这里原来有两个"事后检查"，在消息**已经发出去之后**把结果塞进工具返回值：
  //
  //   findCjkSpaceWarning(messages)
  //     → 「第 N 条消息内部有中文空格，真人一般不这么打；可删掉空格用标点」
  //   findSplitBoundaryWarning(messages)
  //     → 「第 1、2 条之间像是把同一句话拆开了；如果两条拼起来才完整，
  //        请合并成一条，或把断点移到完整句子的边界。」
  //
  // 操作者的原话：「这她已经发完了，一点用都没用，而且还占上下文」。
  //
  // 判断是对的，而且有两层：
  //   ① **无法执行**：消息已经在 QQ 上了，看见提示也撤不回、改不了。
  //      真正能作用于内容的时刻是**发送前**，而那时她没有这些信息。
  //   ② **纯开销**：每轮发送都往上下文里加一句（短的 30 字、长的 60+ 字），
  //      而这两个检查本身就是对每条消息做逐字符扫描 / 正则回扫。
  // 更糟的是它还会**干扰她**：一条本来自然的短句结尾（「那我就先回去了的」这种
  // 口语）被判成"拆开了"，她可能为了消掉提示而改变自己说话的方式。
  //
  // 所以不是"关掉"，是**连同这两个函数一起删掉** —— 留着函数没人调是死代码，
  // 以后有人看见还会把调用接回去。要恢复请参考 git 历史（v0.2.1-r1 之前）。
  //
  // 顺带：MCP 侧 `for (const k of ['hint','warn','splitWarn'])` 的那段遍历也一并删了，
  // 那边原本是"把桥接回传的提示拼到工具结果后面"的出口。

  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是二代内容、
    // 这里却把一代指令漏进二代提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const fullText = String(text ?? '');
      const info = {
        sender: String(sender ?? ''),
        text: fullText.slice(0, 200),
        // 未截断长度：调用方据此判断 textTruncated，不会把「恰好 200 字」误判成截断。
        textLength: fullText.length,
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 原文库增量写入（B0）────────────────────────────────────────────────
  //
  // 为什么需要：state/social-v2.json 每个会话只保留最近 40/100 条，更早的会被
  // 滑动窗口直接挤掉；DSH 侧的 session 文件虽然更全，但它是私有格式、会被 compaction
  // 改写。两边都靠不住，所以每条进出消息都往 state/memory/ 追加一份原文。
  //
  // 三条硬约束：
  //   1. 只追加、不修改 —— 这是资产，纠错靠追加新记录，不靠原地改写。
  //   2. 失败即忽略 —— 它是记忆层，不是主链路。写库失败绝不能影响消息收发。
  //   3. 只记一次警告 —— 磁盘满/权限错时不要每条消息刷一次日志。
  let memoryStoreHandle = null;
  let memoryWarned = false;
  function memoryNote(record) {
    try {
      if (!memoryStoreHandle) memoryStoreHandle = createMemoryStore({ dir: STATE_DIR });
      memoryStoreHandle.append([record]);
    } catch (error) {
      if (!memoryWarned) {
        memoryWarned = true;
        try { log(`[memory] 原文库写入失败（不影响消息收发）：${error?.message ?? error}`); } catch { /* log 不可用就安静失败 */ }
      }
    }
  }

  // ── 别名表：昵称 ↔ QQ 号 ───────────────────────────────────────────────
  //
  // 2026-11-12（操作者方案）：让模型只看到**人名**，不想让它每条消息都读一个
  // 18 字符的 `userId:123456789`。但 @人、拍人、查好感度都必须要号，所以桥接
  // 侧维护这张表，模型需要时用 qq_get_userid 按名字反查。
  //
  // 合并规则（操作者原话）："如果有没见过的人带见过的 QQ 号，就把第二个昵称
  // 绑定那个 QQ 号"。也就是**以 QQ 号为主键**，昵称是它的属性：
  //   · 同一个号出现新名字 → 追加进 names，并把 primary 换成新名字
  //   · 同一个名字出现新号 → 不合并（不同人可能重名，宁可分开也不认错人）
  //   · primary 决定渲染用哪个名字：保证同一个号始终显示同一个称呼，
  //     否则同一个人在历史里以两个名字出现，模型会当成两个人。

  function ensureAliasStore() {
    if (!socialV2.aliases || typeof socialV2.aliases !== 'object') socialV2.aliases = {};
    return socialV2.aliases;
  }

  /**
   * 记一次「这个号叫这个名字」。幂等：同样的 (uid, name) 重复调用只是刷新 lastAt。
   * @returns {boolean} 是否发生了实际变化（新号或新名字），调用方据此决定要不要落盘
   */
  function noteAliasV2(userId, rawName) {
    const uid = String(userId ?? '').trim();
    const name = String(rawName ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, 64);
    if (!/^\d{4,12}$/.test(uid) || !name) return false;
    // 2026-11-14 修：**名字等于号码时直接拒绝**。
    //
    // 起因：拍一拍事件的 sender 在私聊分支里直接取 senderId（那是 QQ 号），
    // 于是 noteAliasV2(10001, "10001") 把 primary 设成了号码本身 ——
    // 之后 displayNameOfV2 每次都返回号码，群友印象面板、记忆渲染全显示成一串数字。
    //
    // 为什么这类"名字"没有任何信息量：它和 uid 完全相同，等价于"没有名字"。
    // 真正该做的是**不写这条**，让 displayNameOfV2 回退到调用方给的原名 / 上一版昵称；
    // 如果允许写入，它还会把已有的正常昵称顶掉（rec.primary = name）。
    if (name === uid || /^\d{4,12}$/.test(name)) return false;
    const store = ensureAliasStore();
    const now = Date.now();
    let rec = store[uid];
    if (!rec || typeof rec !== 'object') {
      store[uid] = { names: [name], primary: name, lastAt: now };
      return true;
    }
    if (!Array.isArray(rec.names)) rec.names = [];
    rec.lastAt = now;
    let changed = false;
    if (!rec.names.includes(name)) {
      // 新名字：放到最前（最近使用的在前），上限 12 个防止被刷爆。
      rec.names = [name, ...rec.names].slice(0, 12);
      changed = true;
    } else if (rec.primary !== name) {
      // 已知名字但换了称呼：把 primary 切过去，让渲染保持一致。
      changed = true;
    }
    rec.primary = name;
    return changed;
  }

  /** 这个号当前该显示的名字（没有记录就回退到调用方给的原名）。 */
  function displayNameOfV2(userId, fallback) {
    const uid = String(userId ?? '').trim();
    if (/^\d{4,12}$/.test(uid)) {
      const rec = ensureAliasStore()[uid];
      if (rec && typeof rec === 'object') {
        const p = String(rec.primary || '').trim();
        if (p) return p;
        if (Array.isArray(rec.names) && rec.names.length) {
          const n = String(rec.names[0] || '').trim();
          if (n) return n;
        }
      }
    }
    return String(fallback ?? '').trim();
  }

  /** 反查：给一个名字（或 QQ 号），找出可能是谁。用于 qq_get_userid。 */
  function lookupAliasV2(query) {
    const q = String(query ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().toLowerCase();
    const store = ensureAliasStore();
    const rows = Object.entries(store)
      .filter(([uid, v]) => /^\d{4,12}$/.test(uid) && v && Array.isArray(v.names) && v.names.length)
      .map(([uid, v]) => ({
        userId: uid,
        primary: String(v.primary || v.names[0] || ''),
        names: v.names.map((n) => String(n)),
        lastAt: Number(v.lastAt) || 0
      }));
    if (!q) {
      rows.sort((a, b) => b.lastAt - a.lastAt);
      return rows;
    }
    const hit = rows.filter((r) =>
      r.userId === q
      || r.primary.toLowerCase().includes(q)
      || r.names.some((n) => n.toLowerCase().includes(q)));
    hit.sort((a, b) => {
      // 精确命中优先，然后按最近活跃。
      const exact = (r) => (r.userId === q || r.primary.toLowerCase() === q ? 0 : 1);
      return exact(a) - exact(b) || b.lastAt - a.lastAt;
    });
    return hit;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：reserved2 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    // 记进别名表：以 QQ 号为主键，昵称是它的属性（一人多昵称会自动合并）。
    // 放在建 msg 之前：这样下面的 `sender` 可以直接用**归一后的名字**，
    // 保证同一个号在历史里始终显示同一个称呼（否则她会把同一人当成两个人）。
    // 失败不影响收发：别名表只是"查号"的加速缓存，坏了顶多是查不到。
    if (userId != null) {
      try { noteAliasV2(userId, sender); } catch { /* 忽略 */ }
    }
    const displaySender = userId != null ? (displayNameOfV2(userId, sender) || sender) : sender;
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender: displaySender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    // 用户开口了：这一轮对话重新开始，允许下一次「闲置边界」再压。
    // 关键语义 —— 压缩后如果不清这个标记，会话会永远停在「已压过」状态，
    // 之后聊多久都不会再压；清了也不会在同一轮里连压，因为判定要求安静
    // 满 idleMs（中间只要有消息就一直往后推）。
    st.idleCompactedAt = 0;
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // ── 好感度：每次真人说话都记一笔 ──────────────────────────────────────
    // **全局按 QQ 号记**（socialV2.affinities），不再挂在会话上。
    // 改动原因（2026-11-10）：原来存在 conversations[key].affinities，
    // 于是「清除上下文」「重置二代状态」「清空工作区」都会连它一起删掉 ——
    // 操作者清了一次上下文，18 个人的关系直接归零。
    // 关系是"我和这个人之间"的事实，不该因为某个聊天窗口重建而消失。
    // 只算真的有人跟她说话；自己发的、机器人自己发的不加。
    try {
      const uid = msg.userId ? String(msg.userId) : '';
      if (uid) {
        if (!socialV2.affinities || typeof socialV2.affinities !== 'object') socialV2.affinities = {};
        // 直接读全局表；同一个人无论在群还是私聊，都是同一条记录。
        const base = socialV2.affinities[uid] || {
          score: AFFINITY_INITIAL,
          stageId: affinityStageOf(AFFINITY_INITIAL).id,
          lastAt: Date.now(),
          count: 0,
          createdAt: Date.now(),
        };
        const prev = decayAffinity(base);
        const delta = scoreForMessage({ text: String(msg.text || ''), isSelf: !!msg.isSelf, isOwner: !!msg.isOwner });
        const next = delta !== 0 ? bumpAffinity(prev, delta) : { ...prev, lastAt: Date.now() };
        // ── 档位变化 → 记一条「下次回复她之前要先查一次」的提醒 ──────────
        // 只在**档位 id 变了**时记：分数涨 1 分、或同档内爬 20 分，都不算变化。
        const prevStageId = affinityStageOf(prev.score).id;
        const nextStageId = affinityStageOf(next.score).id;
        if (prevStageId !== nextStageId) {
          try {
            if (!socialV2.affinityStageChanges || typeof socialV2.affinityStageChanges !== 'object') {
              socialV2.affinityStageChanges = {};
            }
            const fromLabel = AFFINITY_STAGES.find((s) => s.id === prevStageId)?.label ?? prevStageId;
            const toLabel = AFFINITY_STAGES.find((s) => s.id === nextStageId)?.label ?? nextStageId;
            socialV2.affinityStageChanges[uid] = { from: fromLabel, to: toLabel, at: Date.now() };
            log(`[affinity] 档位变化 ${uid}: ${fromLabel} → ${toLabel}（已记入唤醒提醒）`);
          } catch {}
        }
        socialV2.affinities[uid] = next;
        // 顺手清掉会话里可能残留的旧副本，避免以后又被当成"另一份数据"读出来。
        try {
          if (st.affinities && typeof st.affinities === 'object' && st.affinities[uid]) {
            delete st.affinities[uid];
          }
        } catch {}
      }
    } catch (error) {
      log(`[affinity] 好感度更新失败（已跳过）：${error?.message ?? error}`);
    }
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    memoryNote({
      src: 'qq', key, seq: msg.seq, t: msg.time, kind: 'msg', role: msg.sender,
      text: msg.text || msg.plain || '',
      meta: {
        messageId: msg.messageId || undefined,
        userId: msg.userId || undefined,
        media: msg.hasMedia || undefined,
        forward: msg.hasForward || undefined
      }
    });
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    memoryNote({
      src: 'qq', key, seq: msg.seq, t: msg.time, kind: 'poke', role: msg.sender,
      text: msg.text,
      meta: { targetId: msg.poke?.targetId, targetIsSelf: msg.poke?.targetIsSelf, groupId: msg.poke?.groupId }
    });
    saveSocialV2State();
    return msg;
  }

  // ── 撤回用的发送回执（2026-11-15）────────────────────────────────────
  //
  // 键不编号，存的是一条「我发出去过什么」的记录：
  //   { text: 正文, id: QQ message_id, at: 发送时刻 }
  //
  // 为什么按**正文**索引（操作者定的）：
  //   她自己的消息**没有 seq**（seq 是入站未读水位的编号，自己的消息本来就没号）。
  //   所以让她「用 seq 撤回」根本无号可指。最自然的方式是她复述自己说过的那句话，
  //   桥接自己去匹配是哪一条。
  //
  // 有界：最多 50 条。撤回窗口只有 2 分钟，一次对话发不到 50 条。
  const RECALL_RECEIPT_LIMIT = 50;
  // QQ 私聊与群聊的撤回时限都是 2 分钟。超过就必然失败，直接拦下省一次往返。
  const RECALL_WINDOW_MS = 120000;

  /** 记一条「我发出去的」回执。 */
  function noteSentReceiptV2(st, text, messageId, at = Date.now()) {
    const body = String(text ?? '');
    if (!st || !body) return;
    if (!Number.isSafeInteger(messageId) || messageId === 0) return;
    if (!Array.isArray(st.sentReceipts)) st.sentReceipts = [];
    st.sentReceipts.push({ text: body, id: messageId, at });
    if (st.sentReceipts.length > RECALL_RECEIPT_LIMIT) {
      st.sentReceipts.splice(0, st.sentReceipts.length - RECALL_RECEIPT_LIMIT);
    }
  }

  /**
   * 按正文找最匹配的那条回执。
   *
   * 匹配策略（从严格到宽松，命中即返回）：
   *   ① 完全相等 —— 最常见：她原样复述自己刚说的话；
   *   ② 包含 —— 她只说了其中一段（或加了引号/省略号）；
   *   ③ 互相包含 —— 她话里带了额外修饰。
   *
   * 多条命中时取**最新**的那条（`at` 最大）：她说"撤回我刚才那句"，
   * 指的几乎总是最后说的那句；说早期那句时会补上更多上下文让它变成①/②。
   *
   * @returns {{id:number, at:number, text:string}|null}
   */
  function findReceiptByTextV2(st, text) {
    const want = String(text ?? '').trim();
    if (!want || !Array.isArray(st?.sentReceipts) || !st.sentReceipts.length) return null;
    const norm = (s) => String(s ?? '').trim();
    const usable = st.sentReceipts.filter((r) => r && Number.isSafeInteger(Number(r.id)));
    if (!usable.length) return null;
    const newest = (list) => list.slice().sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0];
    const exact = usable.filter((r) => norm(r.text) === want);
    if (exact.length) return newest(exact);
    const contains = usable.filter((r) => norm(r.text).includes(want) || want.includes(norm(r.text)));
    if (contains.length) return newest(contains);
    return null;
  }

  /** 撤回成功后删掉对应回执：同一条不该被反复撤（第二次必然失败）。 */
  function dropSentReceiptV2(st, receipt) {
    if (!Array.isArray(st?.sentReceipts) || !receipt) return;
    const i = st.sentReceipts.indexOf(receipt);
    if (i >= 0) st.sentReceipts.splice(i, 1);
  }

  function recordSentMessagesV2(key, messages, ids = null) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      // ── 自己的消息**不带 seq**（2026-11-15 操作者明确要求）──────────────
      //
      // 曾经试过给自己的消息也编 seq（独立高位段 1e9+），好让 qq_recall_message
      // 按 seq 撤。操作者否掉了，理由很直接：**入站消息的 seq 是"未读/已读水位"
      // 的那套编号，自己的消息本来就没有号**。硬塞一个高位号进来，她看到的消息
      // 列表会变成混着两种编号的怪物，而那个号对水位毫无意义。
      //
      // 现在的做法：自己发的消息照旧不带 seq；撤回按**原文匹配**去找是哪条
      // （见 /api/socialV2/recall-message 的实现）。
      const item = {
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      };
      // 回执：正文 + message_id + 时刻。撤回时按正文匹配、按时刻判 2 分钟窗口。
      noteSentReceiptV2(st, text, Number(ids?.[i]), now + i * 1000);
      st.recentMessages.push(item);
      // 自己发出去的话也是原文的一部分：以后复盘"当时我怎么说的"只能靠它。
      // 用时间戳当 seq，避免与入站消息的本地 seq 撞号。
      //
      // 2026-11-13 修：role 原来硬编码成 'Deepdeep' —— 那是早期模型名，跟她的角色无关。
      // 结果原文库里 1384 条她自己说的话全挂在 "Deepdeep" 名下，搜"睦说过什么"
      // 一条都命不中。改成用机器人真实昵称。
      // 注意用 selfDisplayName（保留大小写）而不是 selfNickname（被 toLowerCase 过，
      // 那是给"被提到"匹配用的，拿来当展示名会变成角色名全小写）。
      memoryNote({
        src: 'qq', key, seq: now + i * 1000, t: now + i * 1000, kind: 'ai',
        role: String(selfDisplayName || '').trim() || '我',
        text: text.slice(0, 4000), meta: { self: true }
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      // 用 plainContent（当前消息自己的文字）：textContent 含 `[引用 某人：原文]`，
      // 引用一条恰好提到机器人昵称的旧消息不该算「叫了名字」（那是被动触发的付费回合）。
      const lower = String(plainContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    // 2026-11-12：question 触发已移除。群聊里"你…吗"绝大多数是在跟别的群友说话，
    // 按文本特征判"在问 AI"误判率 60%（实测 10 条错 6 条）。
    // 想让她被点名就醒，用 atMention / nameMention / keywords；
    // 想让她对任何消息都醒，用 anyMessage 或 probability。
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  //
  // ── 2026-11-12 重写：去掉「连续水位」算法 ──────────────────────────────
  //
  // 旧实现是 `while (through < lastUnread && reachable(through + 1)) through += 1;`
  // —— 只有**连续可达**才往前推，遇到第一条没展示过的 seq 就永久卡住。
  //
  // 那个"连续"要求是整套复杂度的根：为了不让水位跳过一个还没给模型看过的消息，
  // 它必须一条一条数过去。而唤醒包有截断（wakeMessageLimit=12），
  // 更早的未读可能从未展示 ⇒ 水位就停在半路 ⇒ 她传任何更大的 throughSeq 都被判非法
  // （「必须是不超过已展示连续消息水位」）。实测这是 mark_read 反复失败的第三大来源。
  //
  // 现在的语义非常简单：
  //   **返回「已经展示给模型的最大 seq」**，不再要求连续。
  //   没展示过的那些不参与计算，它们会由 mark_read 的拦截分支直接贴给模型看。
  //
  // 为什么这样是安全的：真正防"划过去没看"的责任已经从"水位算法"转移到了
  // mark_read / set_wake_config 的拦截分支 —— 那里会明确列出 `uncovered`
  // （模型没看过的未读），并把正文贴出来。职责单一，不会再出现两个地方各算一遍。
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    const base = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // 已展示过的最大 seq（只算真实存在的未读区间内的，避免旧回执残留把水位顶飞）。
    let through = base;
    for (const seq of seen) {
      if (seq > through && seq <= lastUnread) through = seq;
    }
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  // ── 收尾前观望（2026-11-12 新增）────────────────────────────────────────
  //
  // 操作者的方案：她收尾时先空转 10 秒；这期间来了新消息就直接把消息给她，
  // 让她决定要不要接；没来就照常收尾。
  //
  // 为什么要它：以前靠"回复窗口"（armReplyWindowV2）在后台盯，问题是一句话
  // 就能触发一次完整唤醒 —— 群里连发几句就是几次唤醒，每次都要重发整段历史。
  // 改成"她自己等 10 秒"之后，同一段时间内的多条消息是**一次**给她，
  // 她也能在同一条上下文里连续处理，不会被切成多个回合。
  //
  // 只做被动等待，不主动改状态：水位、未读都由调用方在这之后重新计算。
  /**
   * 观望：在 waitMs 内盯新消息。
   *
   * ⚠️ 2026-11-14 **重写判定依据**。原实现比较 `st.lastUnreadSeq > baseSeq`，
   * 但 lastUnreadSeq 在消息**入库那一刻**就推进了 —— 如果消息恰好在
   * "发送完成 → 开始观望"之间到达，baseSeq 读到的已经是新值，于是永远
   * `nowSeq === baseSeq`，判定 arrived=false 却眼睁睁看着 unread 里躺着消息。
   * 实测日志：`arrived=false waitedMs=7011 lastUnreadSeq=92 unread=1`。
   *
   * 现在改成**按未读数组的 seq 集合**判断：观望开始时记下当时 unread 里
   * 已有的所有 seq（快照），之后只要出现任何**不在快照里**的 seq，就是新消息。
   * 这样不受 lastUnreadSeq 提前推进的影响，也不怕消息在缝隙里到达。
   *
   * ⚠️ 2026-11-14 **二次修：返回值必须真的被用起来**。
   * 原来只回 `{arrived, waitedMs}`，mark_read / set_wake_config 拿到后压根没读，
   * 指望后面那个「uncovered 拦截分支」替它把消息贴出去 —— 可那道分支有两道门：
   *   `isSleepingConfigV2()` 在 active / anyMessage 会话上恒为 false（私聊正是这种），
   *   `preSleepWaitBlockedV2()` 在最近一句是结束语时也返回 false。
   * 于是「观望第 1 秒就到消息、空转正确地提前结束」，她收到的却是一句
   * 「✅ 收尾完成」，那几条消息只躺在 unread 里，要等下一次唤醒才看得见。
   * 现在把观望期间新到的 `fresh` 一并带出去，由调用方**无条件**贴给她。
   *
   * 只做被动等待，不主动改状态：水位、未读都由调用方在这之后重新计算。
   *
   * ⚠️ 2026-11-14 **三次修：改成「安静窗」语义（操作者要求）**。
   *
   * 原语义是「见到第一条新消息就立刻结束观望」。问题是真人聊天是**连发**的：
   * 第一句「在吗」到了就返回，她马上开始回，第二句「我跟你说个事」紧跟其后，
   * 又变成需要下一次唤醒 —— 消息被切成碎片给她，她也容易抢话。
   *
   * 现在的语义与 `qq_wait_for_messages` 的 reply 静默窗口**完全一致**：
   *   · 观望期间来了新消息 ⇒ **不立刻返回**，把「最后一条新消息」的时刻往后推；
   *   · 只要在 `quietMs` 内又来了新消息，就继续等（再推一次）；
   *   · 安静满 `quietMs` 没有任何新消息 ⇒ 返回，把那几条**拼成一次**给她。
   *
   * 必须有硬上限，否则「一直有人说话」会把她永久挂在这个 HTTP 请求里：
   *   `hardCapMs` 到了就无条件返回（不管安静窗有没有满），把已经收到的带走。
   * 这个上限还必须小于 MCP 侧的 `timeoutMs: 25000`（mark_read / wake-config），
   * 否则工具会先被 AbortSignal 掐断，模型看到的是「超时」而不是消息。
   */
  function observeBeforeSleepV2(st, key, waitMs = 10000, opts = {}) {
    // waitMs 仍然兼容旧调用（= 总预算）。安静窗默认取 waitMs，由调用方覆盖成配置值。
    const budget = Math.max(0, Math.min(120000, Number(waitMs) || 0));
    const quietMs = Math.max(0, Math.min(120000,
      opts.quietMs === undefined ? budget : Number(opts.quietMs) || 0));
    // 硬上限：默认比 budget 多留出一个安静窗的余量（允许"来消息→再等一轮"），
    // 但绝不超过 20 秒 —— MCP 那边是 25 秒超时，必须留出网络与序列化余量。
    const hardCapMs = Math.max(budget, Math.min(20000,
      opts.hardCapMs === undefined ? budget + quietMs : Number(opts.hardCapMs) || 0));
    if (!budget && !quietMs) return Promise.resolve({ arrived: false, waitedMs: 0, fresh: [] });
    // 快照：观望开始的那一刻，unread 里都已经有谁。
    const seenAtStart = new Set(
      (Array.isArray(st.unread) ? st.unread : [])
        .map((m) => (m && Number.isSafeInteger(m.seq) ? m.seq : null))
        .filter((s) => s !== null)
    );
    const startedAt = Date.now();
    // 最后一条「新消息」到达的观测时刻；0 表示观望期间还没来过新消息。
    let lastNewAt = 0;
    // 已经见过的最大 seq：用来判断"又来了一条新的"，与快照差集配合。
    let seenMaxSeq = seenAtStart.size ? Math.max(...seenAtStart) : 0;
    return new Promise((resolve) => {
      let done = false;
      const collectFresh = () => (Array.isArray(st.unread) ? st.unread : []).filter((m) => {
        const s = m && Number.isSafeInteger(m.seq) ? m.seq : null;
        return s !== null && !seenAtStart.has(s);
      });
      const finish = (arrived) => {
        if (done) return;
        done = true;
        try { clearInterval(timer); } catch { /* ignore */ }
        // 一并把「观望期间新到的」挑出来带走：调用方不必再自己算一遍差集，
        // 也就不会因为漏算/顺序问题又把消息吞回去。
        const fresh = arrived ? collectFresh() : [];
        resolve({ arrived, waitedMs: Date.now() - startedAt, fresh, quietSatisfied: arrived });
      };
      const timer = setInterval(() => {
        const now = Date.now();
        // 这一轮有没有出现快照之外的新 seq（且 seq 比上次见到的更大）。
        let newest = 0;
        for (const m of (Array.isArray(st.unread) ? st.unread : [])) {
          const s = m && Number.isSafeInteger(m.seq) ? m.seq : null;
          if (s === null || seenAtStart.has(s)) continue;
          if (s > newest) newest = s;
        }
        if (newest > seenMaxSeq) {
          // 又来了一条新消息 ⇒ 安静计时器重置（连发场景下继续等）。
          seenMaxSeq = newest;
          lastNewAt = now;
        }
        // ① 还没有任何新消息：等满最初的 budget 就收（与旧行为一致，不拖长空等）。
        if (!lastNewAt) {
          if (now - startedAt >= budget) finish(false);
          return;
        }
        // ② 来过新消息：等安静满 quietMs 再返回（把连发的几条合并成一次）。
        if (now - lastNewAt >= quietMs) { finish(true); return; }
        // ③ 硬上限兜底：一直有人在说话也不能把她永久挂住。
        if (now - startedAt >= hardCapMs) finish(true);
      }, 250);
      // 不要 unref：这个定时器在 HTTP handler 里等待 Promise resolve，
      // unref 会让它不参与事件循环存活判定，极端情况下请求可能永远挂着。
    });
  }

  // ── observeForCloseV2 已删除（2026-11-15）─────────────────────────────
  //
  // 它是 mark_read / set_wake_config 收尾观望的统一入口。那两个观望已经被
  // 操作者要求整个去掉（理由见 mark-read 处理函数里的长注释：观望覆盖不了
  // 「两个工具调用之间」的空隙，却很贵），所以这个入口也不需要了。
  //
  // `observeBeforeSleepV2` 本身**保留** —— `paceAfterSendV2`（发送后等 20 秒）
  // 仍然用它。两者的区别只是调用参数：发送后那份用 send.minSendIntervalMs
  // 当"没人说话时的干等时长"。
  //
  // `observingKeys` 也保留：paceAfterSendV2 期间同样要压住唤醒调度，
  // 否则那 20 秒里消息一到就排唤醒，会在她还在等的时候就准备新回合。

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > st.lastUnreadSeq) {
      const error = new Error(
        `throughSeq 必须是 0~${st.lastUnreadSeq} 之间的安全整数（你传的是 ${JSON.stringify(seq)}）。`
        + `正常用法：直接抄读取结果里的 readThroughSeq。`
      );
      error.statusCode = 400;
      throw error;
    }
    // ── 2026-11-12 放宽（操作者要求）──────────────────────────────────────
    //
    // 原来这里还有一条 `seq > max` 的判断（max = readThroughSeqV2(st)，只放行
    // "连续可达"的水位），不满足就报「必须是不超过已展示连续消息水位」。
    //
    // 那个限制的问题是：**水位可能卡在半路**。readThroughSeqV2 用 while 递增，
    // 遇到第一条"没展示过"的 seq 就停 —— 于是她明明读完了 #156~#160，
    // 但只要中间某条没进过 modelSeenSeqs（唤醒包只内联了最近 N 条，
    // 更早的几条从未展示），水位就停在前面，她传任何更大的值都被判非法。
    //
    // 结果是她反复撞墙、反复 get_unread，仍然标不掉。实测 mark_read 失败里
    // 有相当一部分是这个（18 次/全会话 441 次，且集中在积压较多的时段）。
    //
    // 现在的语义：**她可以标到任何一个"已经入库"的 seq**（上限仍是 lastUnreadSeq，
    // 防止标到还没到达的消息）。这符合操作者的意图：
    //   「她读过唤醒词里的未读的就让她标记啊，还有新的消息就她看完继续标记那些」
    //
    // 仍然保留的防线：
    //   · 不能超过 lastUnreadSeq（不存在未来消息）
    //   · 沉睡前拦截（preSleepWaitBlockedV2）依然生效 —— 如果还有**她确实没看过**的，
    //     会把那几条直接贴给她，让她决定读完还是明确放弃。
    //   · 非 agent 调用（控制台）上限仍是 lastUnreadSeq，行为不变。
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  // ── 时间观念（沉睡后醒来最容易犯的错） ────────────────────────────────────
  //
  // 现象（操作者报告 + 会话实证）：AI 沉睡很久后被唤醒，看到一小时前的话仍然当成"刚发的"去接，
  // 甚至抢进早已散场的话题。根因有两层：
  //   ① 模型看到的时间是裸 epoch（`time: 1792294529471`），它根本算不出"这是 38 分钟前"
  //      → 已由 qq-model-view.js 换成 `at`/`ago`；
  //   ② 提示词里**没有任何一条规则**告诉它"旧消息不该按实时对话接"。
  // 这里补第二层：把「现在 / 最新一条多旧 / 唤醒原因那条多旧」算好直接写进去，并给分档规则。
  // 阈值可调（config.json 的 socialV2.wake.staleChatMinutes / staleSilentMinutes）。
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

  /** 本地 HH:MM（与消息 at 字段同一口径）。 */
  function localClockText(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function timeSenseCfg() {
    const wake = cfg.socialV2?.wake ?? {};
    const boundedMin = (value, fallback, min, max) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : fallback;
    };
    const chatMin = boundedMin(wake.staleChatMinutes, 10, 1, 600);
    // 「默认不回」必须不早于「不算实时对话」，否则两档规则会互相打架。
    const silentMin = Math.max(chatMin, boundedMin(wake.staleSilentMinutes, 120, 5, 2880));
    return { chatMin, silentMin };
  }

  /** 唤醒原因里带的本地 seq（形如 `atMention@seq194`），没有就 null。 */
  function wakeReasonSeq(reason) {
    const match = /@seq(\d+)$/.exec(String(reason ?? '').trim());
    if (!match) return null;
    const seq = Number(match[1]);
    return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
  }

  function findV2MessageBySeq(st, seq) {
    if (!st || !Number.isSafeInteger(seq)) return null;
    for (const list of [st.unread, st.recentMessages]) {
      const hit = (Array.isArray(list) ? list : []).find((m) => m && m.seq === seq);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 【时间感】规则块。没有可判断的消息时返回空串（引导/定时唤醒不必背这段）。
   *
   * 注意阈值必须和 §timeSenseCfg 一致，否则模型会看到自相矛盾的两档。
   */
  // 时间感只输出**本轮数值**：分档规则已经在 persona 的【时间感】里写死了，
// 这里再抄一遍等于每轮把同一段规则重发一次（350 字），而且两处措辞迟早会漂移。
  function buildTimeSenseLine(st) {
    // 精简版：只报「最新一条有多旧」。分档规则（10 分钟 / 120 分钟怎么处理）在 persona【时间感】。
    // 以前这三处各写一份，改一处忘两处，还让每轮唤醒多出 80 字。
    const now = Date.now();
    const newest = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf)
      || [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf)
      || null;
    if (!newest) return '';
    const ageText = describeAge(newest.time, now);
    if (!ageText) return '';
    return `【时间】最新一条是 ${ageText} 前。\n\n`;
  }

  /**
   * 群友印象的 target → 稳定标识（QQ 号）。
   *
   * 2026-11-10 操作者要求：**memberImpression 按全局 QQ 号记**，不按昵称/群名片。
   * 理由：同一个人在不同群有不同群名片、还可能改昵称，按名字记就会一人多条
   * （"印象里出现两个我"就是这个）。QQ 号是唯一稳定的。
   *
   * 解析顺序：
   *   1. target 本身就是纯数字 → 直接用（大概率已经是 QQ 号）
   *   2. 在该会话的 recentMessages / unread 里按 sender 反查 userId
   *   3. 反查不到 → 原样返回（宁可用名字，也不要丢这条印象；
   *      而且下次同一个人发言时会再由 2 收敛成 QQ 号）
   *
   * 返回值同时给出展示名，写入时存 `name` 便于她读。
   */
  function resolveImpressionTarget(key, rawTarget) {
    const target = String(rawTarget || '').trim();
    if (!target) return null;
    // 1) 本来就是 QQ 号
    if (/^\d{5,12}$/.test(target)) return { id: target, name: target };
    // 2) 在会话消息里找这个名字对应的 userId
    try {
      const st = getSocialV2State(key);
      const lists = [Array.isArray(st.unread) ? st.unread : [], Array.isArray(st.recentMessages) ? st.recentMessages : []];
      for (const list of lists) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const m = list[i];
          if (!m || m.isSelf) continue;
          const sender = String(m.sender ?? '').trim();
          const uid = m.userId != null ? String(m.userId) : '';
          if (!uid) continue;
          if (sender === target) return { id: uid, name: target };
        }
      }
    } catch { /* 拿不到会话状态就退回名字 */ }
    // 3) 反查失败：仍按名字记，不丢数据
    return { id: target, name: target };
  }

  /**
   * 共用会话：把组内**所有聊天**的消息收成一份，给每条打上"回哪儿"的标签。
   *
   * 需求场景（原文）：群里有人骚扰她、主人私聊让她骂回去 —— 她要能在一轮里同时看见
   * 这两条，自己决定先回哪个、回在哪里。
   *
   * 产出两块（与旧版单会话结构一致）：
   *   unread —— 真·未读，必须处理，带 #seq 与水位
   *   recent —— 各聊天最近几条已读，给她"刚才在聊什么"的上下文
   * 两条都必须带聊天标签，否则模型分不清该发到群还是私聊 —— 那正是串号的根源。
   *
   * 每块各自按时间升序混排：模型读的是"事情发生的顺序"，不是"两个聊天各自的顺序"。
   */
  function collectSharedMessagesV2(key, opts = {}) {
    const group = shareGroupOf(key);
    if (group.length <= 1) return null; // 不在共享组：走原来的单会话逻辑
    const now = Date.now();
    const maxPerChat = Number.isFinite(Number(opts.maxPerChat))
      ? Math.max(1, Math.round(Number(opts.maxPerChat)))
      : 12;
    const maxRecentPerChat = Number.isFinite(Number(opts.maxRecentPerChat))
      ? Math.max(0, Math.round(Number(opts.maxRecentPerChat)))
      : 4;
    const unreadRows = [];
    const recentRows = [];
    const perChatThrough = {};
    for (const member of group) {
      let st;
      try { st = getSocialV2State(member); } catch { continue; }
      const label = chatLabelForV2(member);
      try { perChatThrough[member] = readThroughSeqV2(st); } catch { perChatThrough[member] = 0; }
      const unread = Array.isArray(st.unread) ? st.unread : [];
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      for (const m of unread.slice(-maxPerChat)) {
        if (!m) continue;
        unreadRows.push({
          message: compactModelMessage(m, { now }),
          chatKey: member,
          chatLabel: label,
          isUnread: true,
        });
      }
      if (maxRecentPerChat > 0) {
        // 已读上下文排除掉仍在未读里的那些，避免同一条出现两遍。
        //
        // 2026-11-10（操作者方案）：私聊的【之前】**仅在它本轮有未读时才带**。
        //   · 私聊有未读 → 说明正在私聊，把上下文补上（和原来一样，4 条）；
        //   · 私聊没未读 → 跳过，不再每轮固定塞 4 条陈年私聊。
        // 群聊永远带（群里人多、上下文容易被刷掉，那几条是真缺的）。
        // 2026-11-13：曾试过把群聊也改成"有未读才带"，操作者决定回退，保持原样。
        const isPrivateChat = member.startsWith('private:');
        const includeRecent = !isPrivateChat || unread.length > 0;
        if (includeRecent) {
          const unreadSeqs = new Set(unread.map((m) => m.seq));
          // 2026-11-13 修：**排除她自己发的消息**。
          // 原来只排除了"仍在未读里的"，于是【之前】里会混进她刚说过的话 ——
          // 她读起来像是"对方把我的话又说了一遍"，也被逼着回应自己。
          // 未读那边本来就不含 isSelf（入站才进 unread），所以只有这里要补。
          const past = recent
            .filter((m) => m && !m.isSelf && (!Number.isSafeInteger(m.seq) || !unreadSeqs.has(m.seq)))
            .slice(-maxRecentPerChat);
          for (const m of past) {
            recentRows.push({
              message: compactModelMessage(m, { now }),
              chatKey: member,
              chatLabel: label,
              isUnread: false,
            });
          }
        }
      }
    }
    const byTime = (a, b) => (Number(a.message?.at ? Date.parse(a.message.at) : 0) || 0)
      - (Number(b.message?.at ? Date.parse(b.message.at) : 0) || 0);
    unreadRows.sort(byTime);
    recentRows.sort(byTime);
    return { unread: unreadRows, recent: recentRows, perChatThrough };
  }

  /**
   * 消息的发送者标签（写进 recentMessages / 未读队列，也是 memberImpression 的 target）。
   *
   * 为什么不能再用 `'私聊'` 这个字面量（2026-11-10 修复）：
   *   私聊消息原本一律记成 sender='私聊'。她记群友印象时 `target` 填的就是这个名字，
   *   于是同一个人会出现两条——群里一条「群友A」，私聊一条「私聊」。
   *   更糟的是「私聊」根本不是人名，她没法判断这两条其实指同一个人。
   *
   * 现在的规则：
   *   · 群聊：群名片 → 群昵称 → QQ 号（原样，群名片就是她认人的依据）
   *   · 私聊：**用真实昵称**，并带主人标记；拿不到昵称就退回 QQ 号。
   *     共用会话下私聊和群指向同一个人，标签一致才能合并成同一条印象。
   */
  function v2SenderLabelFor(key, kind, event) {
    const nick = event?.sender?.card || event?.sender?.nickname || '';
    const uid = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (kind === 'group') return nick || uid || '群友';
    // 私聊：昵称优先，其次是「主人」/QQ 号。
    const isOwnerUid = uid && String(cfg.ownerQQ ?? '') === uid;
    if (nick) return nick;
    if (isOwnerUid) return '主人';
    return uid || '私聊';
  }

  /** 聊天标签：与发言时 key 参数一一对应，模型照着抄即可。 */
  function chatLabelForV2(key) {
    const canonical = canonicalV2Key(key) || key;
    // 2026-11-10（操作者要求）：**只简化群聊**，私聊保持原样带 QQ 号。
    //   群：`群20001` → `群`（消息行每条都带，实测 2113 行；群号在同一会话里恒等，
    //       对模型决策零信息量，真正要抄的 key 由【令牌】行给一次就够）
    //   私聊：维持 `私聊10001（主人）` —— 私聊可能不止一个，号码是天然消歧符，
    //       不简化（操作者明确要求）。
    //
    // 群聊仍需消歧：组内有两个以上群时退回带号码，否则两个群都叫「群」就串号了。
    try {
      const group = shareGroupOf(canonical);
      if (canonical.startsWith('group:')) {
        const kindOf = (k) => (String(k).startsWith('group:') ? 'group' : 'private');
        const sameKind = group.filter((k) => kindOf(canonicalV2Key(k) || k) === 'group');
        return sameKind.length > 1 ? `群${canonical.slice('group:'.length)}` : '群';
      }
      const uid = canonical.slice('private:'.length);
      return String(cfg.ownerQQ ?? '') === uid ? `私聊${uid}（主人）` : `私聊${uid}`;
    } catch {
      // 兜底：拿不到共享组就退回旧行为，宁可啰嗦也不能让两个聊天撞名。
      if (canonical.startsWith('group:')) return `群${canonical.slice('group:'.length)}`;
      const uid = canonical.slice('private:'.length);
      return String(cfg.ownerQQ ?? '') === uid ? `私聊${uid}（主人）` : `私聊${uid}`;
    }
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);

    // 共用会话：组内所有聊天的消息合并成一份，每条带来源标签。
    // 这就是"群里有人骚扰、主人私聊让她骂回去，她一轮里全看得见"的实现点。
    const shared = collectSharedMessagesV2(key);
    const bounded0 = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    if (shared) {
      const maxChars0 = bounded0('wakeMaxChars', 6500, 500, 20000);
      // 预算按"未读优先、之前其次"的顺序扣：未读是必须处理的，不能被上下文挤掉。
      const unreadRows = [];
      for (const row of shared.unread) {
        unreadRows.push(row);
        if (JSON.stringify({ u: unreadRows, r: [] }).length > maxChars0 * 0.75) { unreadRows.pop(); break; }
      }
      const recentRows = [];
      for (const row of shared.recent) {
        recentRows.push(row);
        if (JSON.stringify({ u: unreadRows, r: recentRows }).length > maxChars0) { recentRows.pop(); break; }
      }
      // 最新一条（未读优先，没有再退到 recent）有多旧。
      //
      // 共用会话下模型更要紧这一个数：私聊和群的消息混在一起，"刚刚有人在群里问"
      // 和"三小时前的旧账"在渲染上长得一模一样，只能靠年龄分。之前这个分支
      // 直接 return 了不带 newestAgo，于是共用会话（就是当前生产配置）下
      // 唯一能看的时间线索只剩每条消息自己的 ago —— 而 persona 的【时间感】
      // 第一句就写着"每轮提示里会给出最新一条消息是多久以前"。
      //
      // ⚠️ 这里的 row.message 已是**模型视图**（compactModelMessage 的产物），
      // 只有 at / ago，裸 time 已被刻意剥掉 —— 所以年龄直接取 ago，不要再去读 time。
      const sharedNewest = [...unreadRows].reverse().find((row) => row && row.message && !row.message.isSelf)
        ?? [...recentRows].reverse().find((row) => row && row.message && !row.message.isSelf)
        ?? null;
      const sharedNewestAgo = sharedNewest ? String(sharedNewest.message.ago || '') : '';
      return {
        shared: true,
        messages: unreadRows,
        recent: recentRows,
        now: localClockText(Date.now()),
        ...(sharedNewestAgo ? { newestAgo: sharedNewestAgo } : {}),
        unreadCount: unreadRows.length,
        includedUnreadCount: unreadRows.length,
        partial: false,
        // 每个聊天各自的水位：模型收尾时按聊天分别提交，不会把另一个聊天的消息一起标已读。
        perChatThrough: shared.perChatThrough,
      };
    }

    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6500, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    // 一次快照只取一次 now：同一批消息的 ago 必须彼此可比。
    const now = Date.now();
    const newestIncoming = [...(Array.isArray(st.unread) ? st.unread : [])].reverse()
      .find((m) => m && !m.isSelf) || null;
    const newestAgo = newestIncoming ? describeAge(newestIncoming.time, now) : '';
    const packet = {
      messages: [],
      recent: [],
      // now / newestAgo 让模型不必自己换算：最新一条多旧，直接写在快照头上。
      now: localClockText(now),
      ...(newestAgo ? { newestAgo } : {}),
      unreadCount: st.unread.length,
      includedUnreadCount: 0,
      readThroughSeq: readThroughSeqV2(st),
      partial: st.unread.length > 0
    };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg, { now }));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages
        // 2026-11-13 修：同共享会话那条路径 —— 排除她自己发的。
        // 【之前】是"对方之前说过什么"的上下文，把她自己的话塞进去只会让她回自己。
        .filter((m) => m && !m.isSelf && (!Number.isSafeInteger(m.seq) || !unread.has(m.seq)))
        .slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  /** 把 ageText 的 "52s"/"1m"/"2h"/"3d" 转成中文；模型读中文比读缩写稳。 */
  function humanAgoV2(ago) {
    const m = /^(\d+)([smhd])$/.exec(String(ago ?? '').trim());
    if (!m) return '';
    return `${m[1]}${{ s: '秒', m: '分钟', h: '小时', d: '天' }[m[2]]}前`;
  }

  /**
   * 把唤醒快照渲染成**纯文本**给模型看。
   *
   * 以前是 `JSON.stringify(snapshot)` 直接塞进去。快照本身是结构化数据，但模型只
   * 需要「谁、多旧、说了什么、读到哪」；JSON 的字段名（isOwner / ownerLabel /
   * unreadCount / includedUnreadCount / messageId…）每轮都进历史、每轮重算。
   * 实测同样信息 JSON 约 600 字符、文本约 70 字符。
   *
   * `messageId` 不再给：引用走本地 seq 就够了 —— `resolveReplyTargetV2` 先按
   * seq 在 recentMessages 里查，命中就换成真实 messageId。
   */
  /**
   * 单条消息 → 一行文本。**唤醒快照与 qq_get_unread_messages 共用这一份**。
   *
   * 2026-11-11：`get_unread` 原来返回原始 JSON（`{seq,messageId,sender,userId,text,
   * isOwner,ownerLabel,at,ago,media:[{kind,summary,subType,index}]}`），单条约 190 字符，
   * 而同样的信息渲染成一行只要约 60 字符。用它自己的话说是"太繁杂了"。
   *
   * 字段取舍（保留 / 压缩 / 删）：
   *   · `seq`      → `#123`                        保留（引用、水位）
   *   · `sender`   → 原样                          保留
   *   · `userId`   → **不输出**（2026-11-12）：模型只看人名，需要号时用
   *                 qq_get_userid 按名字反查（桥接侧别名表自动维护）。
   *                 这样每条消息省 18 字符；实测 73 次 affinity 里只有少数需要现查。
   *   · `text`     → 原样（超 300 字截断）          保留
   *   · `at`       → `16:34`                       保留（操作者要求）
   *   · `ago`      → `（1小时前）`                  保留，与 at 并列
   *   · `isOwner`+`ownerLabel` → `（主人）`          合并，省约 52 字符
   *   · `messageId`→ 仅媒体/转发时 `图id=`/`转发id=` 其余删（引用走 seq）
   *   · `media[]`  → 删（正文已有 `[图片]`/`[表情]`） 省约 80 字符
   */
  function renderOneMessageLine(m, opts = {}) {
    const label = opts.label ? `[${opts.label}] ` : '';
    const seq = Number.isSafeInteger(m?.seq) && m.seq > 0 ? `#${m.seq} ` : '';
    // sender 来自群名片/昵称，是**群友可控的**。实测有人在里面塞
    // `\n\u0005\u0012\u0003小\n\u0005\n\u0003刀\u0010\u0000`（控制字符 + 换行），
    // 拼进单行文本就能伪造出假的「新段落 / 系统提示」。和 sanitizeMediaSummary
    // 用同一套清洗：控制字符、行分隔符一律压成空格。
    const who = m?.isSelf ? '我' : String(m?.sender || '某人').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim() || '某人';
    // 正文同样要清洗：@段 解析出来的名字也可能带控制字符
    // （实测 `@ \u0005\u0012\u0003小 \u0005 \u0003刀\u0010\u0000`）。
    // 注意顺序：先削控制字符（\n \t 之外的），再收拢空白。
    const raw = String(m?.text ?? m?.plain ?? '')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const text = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
    // at / ago 并列：`·16:34（1小时前）`。at 缺失时只给 ago，反之亦然。
    const ago = humanAgoV2(m?.ago);
    const at = String(m?.at ?? '').trim();
    const when = at && ago ? `·${at}（${ago}）` : at ? `·${at}` : ago ? `·${ago}` : '';
    // 精确句柄只在真需要时给。
    const refs = [];
    if ((m?.hasMedia || (Array.isArray(m?.media) && m.media.length)) && m?.messageId) {
      refs.push(`图id=${m.messageId}`);
    }
    // 正文里已有 `[转发消息 id=xxx]` 就不再重复追加（单条 id 长达 84 字符）。
    if (Array.isArray(m?.forwardIds) && m.forwardIds.length
        && !m.forwardIds.every((fid) => raw.includes(String(fid)))) {
      refs.push(`转发id=${m.forwardIds.join(',')}`);
    }
    const tail = refs.length ? `（${refs.join(' ')}）` : '';
    const selfMark = m?.quoteTargetIsSelf ? '↩你 ' : '';
    const ownerMark = m?.isOwner ? '（主人）' : '';
    // 2026-11-12（操作者方案）：**消息行不再带 QQ 号**。
    // 以前每条都挂 `userId:123456789`（18 字符），唤醒词 2113 行加起来是白烧。
    // 现在只显示人名；需要号时用 qq_get_userid（query=人名）反查 ——
    // 桥接侧的别名表（昵称 ↔ QQ 号）会自动维护，见 noteAliasV2。
    // opts.withUserId 保留作为调试开关，正常路径不再传。
    const uid = (opts.withUserId && m?.userId) ? ` userId:${m.userId}` : '';
    return `${label}${seq}${who}${uid}${when}：${selfMark}${text}${tail}${ownerMark}`;
  }

  function renderWakeSnapshotV2(snapshot, wakeKey = '') {
    if (!snapshot || typeof snapshot !== 'object') return '';
    const unread = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
    const one = (m) => renderOneMessageLine(m);
    // ── 共用会话：组内多条聊天混排，每条标来源 ────────────────────────────
    // 格式：`[群] 阿三·16:34（2分钟前）：…` / `[私聊10001（主人）] 主人·…：…`
    // 标签写的就是发言时要传的 key 的"人话版"，模型照着标签就知道回哪儿。
    if (snapshot.shared) {
      const rows = Array.isArray(snapshot.messages) ? snapshot.messages : [];
      const past = Array.isArray(snapshot.recent) ? snapshot.recent : [];
      const oneRow = (row) => renderOneMessageLine(row.message, { label: row.chatLabel });
      // 首行带**每个聊天各自的**水位：她收尾时要按聊天分别传 throughSeq，
      // 只给一个总水位会导致另一个聊天永远标不完（或一次性清空）。
      const through = snapshot.perChatThrough && typeof snapshot.perChatThrough === 'object'
        ? Object.entries(snapshot.perChatThrough)
          .filter(([k]) => canonicalV2Key(k))
          .map(([k, v]) => `${chatLabelForV2(k)} 读到 #${v}`)
          .join('，')
        : '';
      const unreadChats = new Set(rows.map((r) => r.chatKey)).size;
      const head = rows.length
        ? `${rows.length} 条未读${unreadChats > 1 ? `（来自 ${unreadChats} 个聊天）` : ''}`
        : '没有新消息';
      const out = [`【本轮消息】${head}${through ? `，${through}` : ''}`];
      if (rows.length) {
        for (const row of rows) out.push(oneRow(row));
        // 「上面带方括号的就是去处…」这句删了：标签现在是 `[群]` / `[私聊10001（主人）]`，
        // 和【令牌】行的「群 → key "group:…"」一眼对得上，再解释一遍纯属重复。
      }
      if (past.length) {
        out.push('【之前】');
        for (const row of past) out.push(oneRow(row));
      }
      return out.join('\n');
    }

    const head = [];
    if (unread.length) head.push(`${unread.length} 条未读`);
    if (Number.isSafeInteger(snapshot.readThroughSeq)) head.push(`读到 #${snapshot.readThroughSeq}`);
    const out = [`【本轮消息】${head.join('，')}`];
    if (unread.length) for (const m of unread) out.push(one(m));
    else out.push('（本轮没有新消息）');
    if (recent.length) {
      out.push('【之前】');
      for (const m of recent) out.push(one(m));
    }
    if (snapshot.partial) {
      out.push(`（还有消息没显示，用 qq_get_unread_messages(afterSeq=${snapshot.readThroughSeq}) 继续看）`);
    }
    return out.join('\n');
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // 机器人自己的身份（昵称 + QQ 号）。**必须显式写进 prompt**：
  // agent 能看到的消息里只有 "@樰" 这串文本，没人告诉它"樰"就是它自己，于是它会把
  // @自己 当成 @别人、已读不回（issue #29）。群名片可能与昵称不同，但 at/引用段里
  // 带的是 QQ 号，所以两条都给。
  function selfIdentityTextV2() {
    const name = String(selfDisplayName || '').trim();
    const id = String(selfUserId || '').trim();
    if (!name && !id) return '';
    // 2026-11-10 压成一行（原版 132 字）：
    // 保留「@昵称 / @QQ号 都是在叫你」是**必要**的 —— 消息里的 at 段只渲染成 `@昵称`
    // （见 segmentsToText 的 'at' 分支），没有这句她会把 @自己 当成群里另一个人
    // （issue #29；实测 @角色A 出现 80 次，是高频事件）。
    // 「或引用你的消息」可以删：引用自己渲染时会带 `↩你` 前缀（renderWakeSnapshotV2），
    // 触发判定也不依赖这句（evaluateWakeTriggerV2 用 quoteTargetIsSelf）。
    // 「群名片可能与昵称不同」删掉：解析不到昵称时本来就会回退成 `@QQ号`，下半句覆盖了。
    const callBits = [name ? `@${name}` : '', id ? `@${id}` : ''].filter(Boolean).join(' 或 ');
    return `【你的身份】QQ ${id || '?'}${name ? `，昵称 ${name}` : ''}；${callBits} 都是在叫你。\n\n`;
  }

  /**
   * 角色卡注入：**默认一律不内联，只给名字**。
   *
   * 历史与取舍（2026-11-12 定稿，操作者决定）：
   *   旧版按长度分档：小卡（≤1200 字）全文内联，大卡退回"按需查"。
   *   但实测发现两件事：
   *     ① 卡里大量内容是模型**光凭角色名就知道**的（"话少""用省略号""情绪不写在脸上"），
   *        写不写进去表现几乎一样 —— 内联这些等于白烧 token。
   *     ② 卡越短越容易掉进"内联"档，于是"人格卡到底进没进上下文"这件事
   *        变得依赖卡的长度，随时会随着编辑翻转，行为不可预期。
   *
   *   现在改成阈值 = 1：**任何卡都不会内联**。人格统一走 `qq_get_prompt`，
   *   由 preset 规定"新会话第一轮 / 压缩后必须读一遍"。
   *   好处：注入路径唯一、可预期；卡写多长都不会悄悄改变行为。
   *   代价：冷启动那轮多一次工具调用（其余轮次靠会话历史里已有的内容）。
   *
   * ⚠️ 改成 1 之后，`hint.length <= 1` 只有空/单字符卡才会命中，等价于禁用内联。
   *   如果哪天要恢复内联，直接调这个数字即可，不要另加开关。
   */
  const ROLE_INLINE_MAX_CHARS = 1;
  /**
   * 角色行。
   *
   * 2026-11-12：加了 `coldStart` 参数 —— 之前每轮都输出同样一句
   * 「（完整角色卡请调用 qq_get_prompt 查看）」，于是她在普通轮次里看到它
   * 也会以为"随时可以调但不必现在调"，而真正的时机（新会话第一轮 / 压缩后）
   * 反而没有任何区别性提示。实测 12 小时、16 个回合、70 次工具调用里
   * qq_get_prompt 一次都没被主动调过（唯一一次是操作者手动要求的）。
   *
   * 现在分两种口吻：
   *   · 冷启动：明确写成「先调」，和【记忆】那句并列，都属于"开口前必须先做的事"；
   *   · 普通轮次：只报名字，不催 —— 那时人设已经在这个会话的上下文里了。
   *
   * @param {string} roleName 角色名
   * @param {boolean} coldStart 是否新会话第一轮 / 刚压缩完
   */
  function buildRoleLineV2(roleName, coldStart = false) {
    const name = String(roleName || '').trim();
    if (!name) return '';
    let hint = '';
    try { hint = currentRoleHintV2() || ''; } catch { hint = ''; }
    // 阈值已是 1：正常人格卡（哪怕只有几百字）都不会命中这条，一律走"只给名字"。
    // 保留这个分支只是为了空卡时不输出一个字（否则会拼出「【当前角色】X\n\n\n」）。
    if (hint && hint.length <= ROLE_INLINE_MAX_CHARS) {
      return `【当前角色】${name}\n${hint.trim()}\n\n`;
    }
    // 大卡：冷启动必须点名去调；平时只报名字。
    if (coldStart) {
      return `【当前角色】${name}（你的完整人设不在上下文里 —— 开口前先调 qq_get_prompt 读一遍人格卡，它只返回人格卡正文。）\n\n`;
    }
    return `【当前角色】${name}（完整角色卡请调用 qq_get_prompt 查看）\n\n`;
  }

  /**
   * 【当前场景】只交代"有哪些聊天、各自的 key 是什么"，语气分寸那类建议不写。
   *
   * 为什么砍到这么短：manager 明确要求这里只给群号、私聊 QQ 号、key。
   * 场景判断交给模型看【本轮消息】的标签自己决定 —— 那才是真正有信息量的地方。
   */
  function buildSceneLineV2(key) {
    const canonical = canonicalV2Key(key) || key;
    const group = shareGroupOf(canonical);
    // 2026-11-10 起不再单独出这段：群聊标签已缩成「群」，私聊保持带 QQ 号，
    // 而「标签 → key → 令牌」的三元组统一由 sessionTokenLineV2 给一次。
    // 同一个映射写两遍（场景段给 key、令牌段再给 key+令牌）是纯重复。
    // 【怎么回】那段也删了：消息行本身就带 `[群]` / `[私聊10001（主人）]` 前缀，
    // 「想回哪个就把 key 填成对应的那个」属于一眼可推的推论。
    if (group.length > 1) return '';
    // 非共享组（只有一个聊天）保留一句最短定位，它没有"多聊天"的上下文可推。
    return `【场景】${chatLabelForV2(canonical)}\n`;
  }

  /**
   * 好感度注入：按「这轮是谁在跟她说话」取对应的人，渲染成一行状态提示。
   *
   * ⚠️ 关键：好感度是**按人**记的，不是按聊天。
   * 私聊里的你和群里的你是同一个人，所以在哪说话都该算到同一个 QQ 号头上。
   * 因此读取时要遍历整个共享组，取这个人**分数最高的那条记录** ——
   * 同一个人的记录理论上只有一份，但共用会话开启前后可能各存过一份，
   * 取高的那个才不会让已有的亲密度凭空消失。
   *
   * 取谁为准的顺序：
   *   1. 本轮未读里最后一条真人消息的 userId（最贴近"现在在跟谁说话"）
   *   2. 私聊时就是聊天对象本人
   *   3. 群聊且没有未读时，退回合里最近说话的人
   * 取不到人就不注入 —— 宁可没有，也不要给一个错的对象。
   */
  /**
   * 好感度**不注入唤醒包**，这里只保留一个空实现，避免调用点报错。
   *
   * 历史（四次修订，全部保留教训）：
   *   ① 写行为指令（"保持距离、一条就够"）→ 直接盖掉人格卡，她开始解释自己。
   *   ② 压到一行状态描述 → 仍然每轮进上下文、仍然跟人格卡抢注意力。
   *   ③ 整个退掉、一个字不提，只在 preset 里说"拿不准就 qq_affinity 查"。
   *      → 300 条工具调用里 qq_affinity 只出现 1 次（还是操作者手动测的）。
   *      等于**机制建好了却完全没接上**：她根本不知道谁是谁。
   *   ④ 把 [依赖] 这类标记贴在每条消息的人名后面 → 有效，但用户选择走工具路线
   *      （"规定一定要在回复人之前查好感度"），所以又撤掉了。
   *
   * 现在的方案：**不注入任何关系信息**，由 preset 里那条硬规则要求她在回复前
   * 调 qq_affinity 查。好处是关系状态由她自己"想起来"、按需查，不占每轮上下文；
   * 代价是多一次工具调用。
   */
  function buildAffinityLineV2() {
    return '';
  }

  function buildAffinityStageChangeLineV2(key) {
    // 档位变化现在存在**全局** socialV2.affinityStageChanges（按 QQ 号），
    // 不再按会话存 —— 所以这里不需要 key 也能读到，保留参数只是为了签名一致。
    let st;
    try { st = getSocialV2State(key); } catch { st = null; }
    const changes = socialV2.affinityStageChanges && typeof socialV2.affinityStageChanges === 'object'
      ? socialV2.affinityStageChanges : null;
    if (!changes) return '';
    const entries = Object.entries(changes).filter(([, v]) => v && v.to);
    if (!entries.length) return '';

    // 名字：优先用这个会话最近消息里的群名片/昵称，取不到就退回 QQ 号。
    // （好感度表只存 userId，昵称是展示用的东西，不该为了它去额外调 OneBot。）
    const nameOf = (uid) => {
      try {
        const msgs = Array.isArray(st.recentMessages) ? st.recentMessages : [];
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          const m = msgs[i];
          if (!m || String(m.userId ?? '') !== uid) continue;
          const s = String(m.sender ?? '').trim();
          if (s && s !== uid && !['私聊', '我', '未知', '群友', '管理员'].includes(s)) return s;
        }
      } catch {}
      return uid === String(cfg.ownerQQ ?? '') ? '主人' : uid;
    };

    // 一次最多提 3 个人：再多就不是"提醒"，是一张待办清单了。
    const names = entries.slice(-3).map(([uid]) => nameOf(uid));
    const who = names.length === 1 ? names[0] : names.join('、');
    // 2026-11-12 操作者要求：在后面补一句"查一下某某的好感度"。
    // 原来只有「（某某的好感度发生了变化）」，是个**陈述**——她可能只是"知道了"就照旧凭记忆回话。
    // 补上动作后，它变成指令，和前面的「（有人拍了一拍。）」区分开：
    //   拍一拍 = 告知发生了什么；好感度变化 = 告知 + 要她做一件具体的事。
    // 只对单个人时写名字，多人时写"他们的"——避免一句话里出现三个名字还得各自查。
    const action = names.length === 1
      ? `查一下${who}的好感度`
      : `查一下他们的好感度`;
    return `（${who} 的好感度发生了变化，${action}）`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 冷启动引导：**唯一一条链路**（2026-11-13 重建）
  //
  // 要解决的事只有一件：什么时候该在唤醒词里挂那两句提示
  //   ①（新会话或上下文刚压缩过，你记下的东西现在不在上下文里。开口前先调 qq_memory_query，不带 category。）
  //   ②（你的完整人设不在上下文里 —— 开口前先调 qq_get_prompt 读一遍人格卡。）
  //
  // 旧实现的问题（这是重建的动因，写在这里免得哪天又被改回去）：
  //   · 判定散在三处：reason==='bootstrap'、st.memNeedsSync、组级 bootstrapSent。
  //   · 渲染跑两遍：sendWakePromptV2 渲一次（结果被丢弃），deliverPromptNow 又渲一次。
  //     而第一遍已经把 memNeedsSync 清掉了 ⇒ 压缩后那句**从来没真正发出去过**。
  //   · 降级判定（组内已引导就按普通唤醒）只作用于第一遍，第二遍按原始
  //     reason 重渲 ⇒ 同一个会话里冷启动提示发了两遍（12:56:09 / 12:56:42 实测）。
  //
  // 新结构：**写标记 → 唯一渲染点读标记 → 消费即清**。
  //   · 标记按 DSH sessionId 存（shared 组天然一份，两个入口不可能各发一遍）；
  //   · 渲染全桥接只有 buildWakePromptV2 一处；
  //   · 消费在 deliverPromptNow 投递被接受之后（见 commitColdStart），
  //     失败/入队/被拒都不消费，下次补投照样带着提示。
  //
  // 两个条件都在这里判定，不许在别处再判一次：
  //   条件 A「新会话」：DSH 没有"会话是新的"这样的事件，所以由桥接在会话被创建时登记
  //                     （ensureSession 新建分支）。sessionId 变了 = 上下文没了，这是硬事实。
  //   条件 B「刚压缩过」：**优先用 DSH 原生事件** compaction/end（桥接一直能收到
  //                     session/event，不需要新接口）。事件流断线期间漏掉的压缩，
  //                     由 idleCompactV2 自己调 /compact 成功后补记一次作兜底。
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 登记"这个 DSH 会话要重新想起来一次"。
   *
   * @param {string} sessionId DSH 会话 id（= agent.id）
   * @param {'new'|'compacted'} kind new=新会话；compacted=刚压缩过
   * @param {string} why 只用于日志
   */
  function markColdStart(sessionId, kind, why = '') {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const now = Date.now();
    const prev = coldStartRegistry.get(sid) ?? { newAt: 0, compactedAt: 0, consumedAt: 0, at: 0 };
    const next = { ...prev, at: now };
    if (kind === 'new') next.newAt = now; else next.compactedAt = now;
    // 重新登记 = 一次全新的"上下文没了"，之前那次消费记录作废。
    next.consumedAt = 0;
    coldStartRegistry.set(sid, next);
    saveColdStarts();
    log(`[coldStart] 已登记 ${kind} ${sid}${why ? `（${why}）` : ''}`);
  }

  /**
   * 这个会话此刻是否处于"上下文没了"的状态。
   *
   * 判据只有"标记还在、且没被消费" —— 刻意**不看** reason、不看 bootstrapSent、
   * 不看 memNeedsSync：那些是"为什么醒"和"引导发没发过"，跟"她脑子里还有没有东西"是两件事。
   *
   * @returns {{coldStart: boolean, kind: string, anchor: number}}
   */
  function coldStartStateOf(key) {
    const sid = state.sessions[key];
    if (!sid) return { coldStart: false, kind: '', anchor: 0 };
    const rec = coldStartRegistry.get(sid);
    if (!rec) return { coldStart: false, kind: '', anchor: 0 };
    // 消费过（且之后没有再登记）就不算 —— consumedAt 在重新登记时会被清零。
    const anchor = Math.max(Number(rec.newAt) || 0, Number(rec.compactedAt) || 0);
    if (!anchor || Number(rec.consumedAt) >= anchor) return { coldStart: false, kind: '', anchor: 0 };
    return {
      coldStart: true,
      kind: (Number(rec.compactedAt) || 0) >= (Number(rec.newAt) || 0) ? 'compacted' : 'new',
      anchor
    };
  }

  /**
   * 提示已经**真的投递出去**了：把这个标记就地消费掉。
   *
   * 为什么消费点放在 deliverPromptNow 而不是渲染时：渲染会跑在
   * "会话繁忙 → 暂存 → 限频重试 → 入队补投" 这些还没落地的路径上。
   * 在渲染时清，等于"提示被丢弃了但标记已经没了" —— 旧实现压缩后那句永远发不出去，
   * 就是这么来的。只有 DSH 真的接受了这条 prompt，才算提示过。
   *
   * @param {string} sessionId
   * @param {number} anchor 渲染时看到的那次登记时刻（防止消费掉渲染之后新来的登记）
   */
  function commitColdStart(sessionId, anchor) {
    const sid = String(sessionId || '').trim();
    if (!sid || !anchor) return;
    const rec = coldStartRegistry.get(sid);
    if (!rec) return;
    const cur = Math.max(Number(rec.newAt) || 0, Number(rec.compactedAt) || 0);
    // 渲染之后又登记过一次（比如投递等待期间正好压完一轮）：那次提示还没发，不能清。
    if (cur !== anchor) return;
    rec.consumedAt = Date.now();
    saveColdStarts();
    log(`[coldStart] 已消费 ${sid}`);
  }

  function buildWakePromptV2(key, reason) {
    const roleState = readRoleState();
    // viaSystemPrompt 要先算：下面几段的拼法取决于它。
    const viaSystemPrompt = cfg.socialV2?.injectViaSystemPrompt === true;
    const st = getSocialV2State(key);
    // 冷启动判定走登记表（唯一来源）。必须在角色行之前算：角色行要用它决定口吻
    // （冷启动时明确催她调 qq_get_prompt，平时只报名字）。
    const coldStartInfo = coldStartStateOf(key);
    const coldStart = coldStartInfo.coldStart;
    log(`[coldStart] key=${key} reason=${reason} → ${coldStart}${coldStart ? `（${coldStartInfo.kind}）` : ''}`);
    const roleLine = roleState.role ? buildRoleLineV2(roleState.role, coldStart) : '';
    // 这几段（身份 / 令牌 / 表情 / 长期记忆）现在由 DSH 插件
    // `plugins/qq-agent-context` 注入到**系统提示词**里：模型照样看得到，但不再进对话历史，
    // 也就不会让每一轮唤醒读起来像一张工单。开关关掉就回到旧行为（全部塞进 user message）。
    const identityLine = viaSystemPrompt ? '' : selfIdentityTextV2();
    const tokenLine = viaSystemPrompt ? '' : `${sessionTokenLineV2(key, st.agentToken)}\n\n`;
    // 【进行中的话题】不再逐轮注入：那是跨轮记忆，该走静态 facts（可缓存）或者
    // 让它自己 qq_recall，不该每轮塞进 user message 里重复计费。
    // 长期记忆（L2）也不再整段注入唤醒包：30 条事实每轮几百字，且会进历史反复重算。
    // 单独 try：事实库坏了不能影响整轮唤醒。
    // 记忆注入策略（2026-11-10 二次修订，操作者定）：
    //   · **唤醒包里一律不带记忆正文**，三类记忆（selfNote / 群友印象 / 长期事实）都改成她自己调工具查；
    //   · 冷启动（新会话第一轮）或刚压缩完 —— 挂一句「先查什么」的提示，因为这时她手上确实什么都没有；
    //   · 其他轮次 —— 只在长期事实内容变了时提示一句（30 条里换掉一条也算变化，靠指纹判断）。
    // 为什么冷启动/压缩后要提示：压缩会把历史压成摘要，selfNote/印象/事实都不在上下文里了，
    // 而实测她 5471 次工具调用里 qq_memory_query 只用过 2 次 —— 不提示 = 等于失忆。
    // 为什么不再注入正文：正文进唤醒包就是进对话历史，压缩时照样被摘要掉，而且每轮重复计费；
    // 让她调工具拿，内容只在她真正开口的那一轮出现一次。
    // 长期三类记忆（印象/自我认知）现在在全局存储里，和当前会话无关。
    const memSt = getSocialV2State(GLOBAL_MEMORY_KEY);
    // coldStart 已在函数开头算好（角色行要用它）。

    let factsLine = '';
    if (!viaSystemPrompt) {
      try {
        const facts = selectFactsForInjection(STATE_DIR, memoryKeyOf(key));
        const picked = Array.isArray(facts.picked) ? facts.picked : [];
        const nowCount = picked.length;
        // 内容指纹：30 条时新写一条把权重最低的顶掉，条数还是 30 但内容变了 —— 只比条数会漏。
        // 取「按权重排好序的 id + hits」，任何 id 进出或加权都会变。
        const fingerprint = nowCount
          ? crypto.createHash('sha1')
            .update(picked.map((f) => `${f.id}:${f.hits || 0}`).join('|'))
            .digest('hex')
            .slice(0, 16)
          : '';
        // 指纹 / 已见 id 都跟着**长期事实**走，而长期事实是全局一份，
        // 所以这两个字段也必须存在全局存储上 —— 否则群和私聊各有各的基线，
        // 同一批事实会被两边各判一次「有变化」，各提示一遍。
        const factState = getSocialV2State(GLOBAL_MEMORY_KEY);
        const prevFingerprint = String(factState.factFingerprint || '');

        if (coldStart) {
          // 冷启动 / 刚压缩完：**只给提示，不注入正文**。
          //
          // 记忆正文不进唤醒包（2026-11-10 操作者定）：正文进了历史，压缩时照样被摘要掉，
          // 而且每轮重复计费。让她调工具拿，内容只在她真正开口的那一轮出现一次。
          // 提示只教一种查法（不带 category 一次拿全部）：上一版并列写两条时，
          // 她只执行了参数更明确的那条，selfNote / 群友印象整块被跳过。
          // 也不写"会返回什么"：那是工具自己的说明，写在这里就是一份可能过期的副本。
          const hasSelf = Array.isArray(memSt?.selfNotes)
            && memSt.selfNotes.some((n) => n && n.text);
          const imMap = memSt?.memberImpressions;
          const hasImp = !!imMap && typeof imMap === 'object'
            && Object.values(imMap).some((v) => v && Array.isArray(v.traits) && v.traits.length);
          const hasFact = nowCount > 0;
          // 库里什么都没有时不点名工具：点名了她会白调一次，然后拿到一片空。
          if (hasSelf || hasImp || hasFact) {
            // 2026-11-18：点明 qq_memory_query **带不带 category 都含长期记忆**，
            // 并额外提醒她拿一次表情包列表（表情包已从系统提示词移出，见
            // /api/socialV2/agent-context 的说明：它会话可变，留在系统提示词里
            // 会让整段缓存前缀失效）。
            factsLine = '（新会话或上下文刚压缩过，你记下的东西现在不在上下文里 —— 包括长期记忆。'
              + '开口前先调 qq_memory_query（不带 category，一次拿到轻量记忆和长期记忆），'
              + '再调一次 qq_list_stickers 看看自己有哪些表情包。）\n\n';
          } else {
            factsLine = '（新会话或上下文刚压缩过 —— 你记下的东西现在不在上下文里。'
              + '先调 qq_list_stickers 看看自己有哪些表情包。）\n\n';
          }
          // 记录当前指纹作为基线：这一轮已经明确提示过"去查"，下一轮内容没变就不该再提示。
          // （写基线不会漏检 —— 指纹是内容哈希，内容变了哈希必然变。留空反而会让
          //   冷启动后的下一轮必然误报一次「长期记忆有变化」。）
          factState.factFingerprint = fingerprint;
          // 记下此刻活跃的 id：她按提示全量查过之后，delta 只需要给「新增 + 已消失」。
          factState.factSeenIds = picked.map((f) => f.id).filter(Boolean);
        } else if (nowCount > 0 && fingerprint !== prevFingerprint) {
          // 2026-11-17：**不再提示「长期记忆有变化」**。
          //
          // 原来这里会写一句「先调 qq_memory_query 看一眼你记得什么」。
          // 但现在长期记忆由 qq-agent-context 插件**自动装配进系统提示词**（每轮都在），
          // 内容变了插件那边下一轮就自动更新 —— 让她再去查一遍纯属重复劳动，
          // 还得等 2 分钟插件刷新期，反而更容易让她以为"我记得的和现在不一样"。
          //
          // 只更新基线，不产生任何提示。
          factState.factFingerprint = fingerprint;
        } else if (nowCount === 0 && prevFingerprint) {
          factState.factFingerprint = '';
        }
        // ⚠️ 这里**不再清除任何"提示过"的标记**。
        // 消费统一在 deliverPromptNow 投递被接受之后（commitColdStart）：
        // 渲染会跑在"会话繁忙 → 暂存 → 限频重试 → 入队补投"这些还没落地的路径上，
        // 在渲染时清 = 提示被丢弃但标记已经没了。
        saveSocialV2State();
      } catch (error) {
        log(`[memory] 记忆注入失败（已跳过）：${error?.message ?? error}`);
      }
    }
    // 参与度统计不再每轮注入：实测模型基本不看它，看了也不改行为。
    // 需要时由控制台或 qq_social_state 查。
    // 【反AI味】不再写进唤醒包：`qq-chat-v2` 的 persona 已有更完整的
    // 【反 AI 味：拒绝有求必应】段落（系统提示词，常驻且可缓存）。这里再拼一份
    // 既重复、又让每轮 user message 无谓变长。
    // 表情策略 / 积极性 / 状态提示都不再进唤醒包：
    // 表情策略和积极性在 persona 里已有完整版本；状态（"对方可能没说完"）
    // 模型看一眼快照自己就能判断。这些每轮几百字符，而且会进历史反复重算。
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    // 召回提示：只在这句话「像在问过去的事」时出现，避免每轮都塞一句（那是另一种噪声）。
    // 体感来源：qq_recall 只在 bootstrap 提过一次，之后模型不觉得自己缺信息，也就不会去查。
    const RECALL_HINT_RE = /(记得|上次|之前|以前|那个|说过|忘|聊过|还记)/;
    const recallHint = lastMsg && RECALL_HINT_RE.test(String(lastMsg.text || lastMsg.plain || ''))
      ? '【回忆】这句可能在问过去的事；想不起来就用 qq_recall(query=关键词) 查原文库，别硬编。\n\n'
      : '';
    // 【唤醒】状态行（潜水/触发条件/未读条数/水位）不再注入：私聊里它对模型零信息量，
    // 收尾要用的水位已经在下面的快照里（"读到 #N"）。
    // 操作者预写的「初始提示词」（圈子主题/群内氛围等）：**只在首次唤醒**注入。
    // 放在最前面几段（角色/令牌之后）而不是末尾，是为了让它在长 prompt 里足够显眼；
    // 后续唤醒不再带它 —— 那时它已经在这条 DSH 会话的上下文里了。
    const initialPromptText = reason === 'bootstrap' ? formatInitialPromptV2(key) : '';
    const initialPromptLine = initialPromptText ? `${initialPromptText}\n\n` : '';
    // 绝对时间也不再单独给一行【当前时间】：每条消息自带"多久前"，模型判断新鲜度
    // 够用；而绝对时间每轮都变，会挡住前缀缓存（那是延迟和成本的大头）。
    const base = roleLine + identityLine + tokenLine + initialPromptLine + factsLine + recallHint;
    // 【当前场景】共用会话时私聊与群共用一个 DSH 会话，历史是连着的一份，
    // 模型很容易把上一个场景的对话习惯带过来（在群里用私聊口吻、在私聊里以为有别人）。
    // 所以每轮都明确写一次"这是哪儿、谁是对方、地址该填什么"，这是不串号的第一道保障
    // （第二道是 turnKeyQueue 的回复路由）。
    const sceneLine = buildSceneLineV2(key);
    // 好感度**不再注入唤醒包**（2026-11-07 三次修订，操作者要求）。
    // 理由：任何每轮都出现的状态描述都会跟人格卡抢注意力，实测她开始用解释口吻回话。
    // 现在改成"她想起来才查"：流程写在 preset 里（发言前可先 qq_affinity 看一眼分寸），
    // 工具是 qq_affinity，细节由它按需返回。
    // 各分支的"为什么叫醒你"都砍成一行：原文案（原因解释 + 行动要求 + 收尾提示）
    // 已经在 persona 和工具描述里，每轮再说一遍只是把历史撑长。
    if (reason === 'bootstrap') {
      // 冷启动把"它自己写下的自我认知"带上：新会话开始时读一次，等于想起来了。
      // 之后不再每轮注入 —— 那会变成别人告诉它"你是谁"。
      // 共用会话：读组内代表 key 的 selfNotes，私聊与群共用同一份自我认知。
      // selfNote / 群友印象 / 长期事实**都不再注入正文**（2026-11-10 操作者定）：
      // factsLine 只在冷启动时给一句「先查 qq_memory_query」的提示，正文由她自己调工具拿。
      const selfText = '';
      // 2026-11-13（操作者要求）：**【引导】整段删除**。
      //
      // 那段原本写"你已接入 XX、发言必须调 qq_send_message 带 key、记得收尾"。
      // 删掉的理由：
      //   · 这些要求 preset 里已经常驻（system prompt，不占历史）；
      //   · 引导本身经常发不出去 —— wakePriorityV2 里 bootstrap 的优先级是 0，
      //     撞上合并窗口就会被丢弃；就算没丢，sendWakePromptV2 里还有一层
      //     "组内已置位就降级"的判定。实测 18/48 个会话首轮没有引导。
      //   · 它只在第一轮出现一次，多这 100 字符对模型行为的实际影响很小。
      // 注意：**括号提示（factsLine）不受影响** —— 那段仍然只在冷启动/压缩后出现。
      return `${sceneLine}${base}${selfText}`;
    }
    // 档位变化提醒：和「（有人拍了一拍。）」一样的口吻与位置。
    // 挂在末尾而不是开头，是因为它只是"补充说明"，不该抢走"为什么叫醒你"的位置。
    const stageChangeLine = buildAffinityStageChangeLineV2(key);
    const tail = stageChangeLine ? `\n${stageChangeLine}` : '';
    if (reason === 'timeout') return `${sceneLine}${base}（你设的潜水时间到了。）${tail}`;
    if (reason === 'replyCheck') return `${sceneLine}${base}（对方回你了。）${tail}`;
    // 主动机会唤醒（2026-11-15 修）：**按会话类型分句**。
    //
    // 原来不管群聊私聊都说「群里安静了一阵」。私聊收到这句时，她的处境其实是
    // 「这个人有一阵没说话了，你要不要主动找他」，跟"群"没关系 ——
    // 实测 15:50:37 私聊 proactiveCheck 唤醒了，但她看到"群里"就当成别人的事，
    // 不开口。操作者的反馈正是「群聊的主动唤醒就有提示词，私聊的怎么没有」。
    //
    // 两句都保持和上面 `（对方回你了。）` 一样的短口吻：
    // 只说"为什么叫醒你"，不写行动要求（那些在 preset 里）。
    if (reason === 'proactiveCheck') {
      const isPrivate = String(key).startsWith('private:');
      const hint = isPrivate
        ? '（这个人有阵子没说话了，想找他可以说。）'
        : '（群里安静了一阵，想说什么可以说。）';
      return `${sceneLine}${base}${hint}${tail}`;
    }
    if (reason === 'poke') return `${sceneLine}${base}（有人拍了一拍。）${tail}`;
    // 待办到点：和「（有人拍了一拍。）」同样的位置和口吻，但要把是哪件事说出来 ——
    // 只写"有件事到点了"她还得自己去查记忆，等于多一次工具往返。
    // reason 形如 todo:明天讲那张卡片（写 todo 时把文本塞进子类型）。
    if (String(reason).startsWith('todo:')) {
      const what = String(reason).slice('todo:'.length).trim();
      return `${sceneLine}${base}（待办到点了：${what}）${tail}`;
    }
    if (reason === 'todo') return `${sceneLine}${base}（你有待办到点了。）${tail}`;
    return `${sceneLine}${base}${tail}`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = cfg.socialV2?.injectViaSystemPrompt === true ? '' : selfIdentityTextV2();
    const st = getSocialV2State(key);
    const tokenLine = cfg.socialV2?.injectViaSystemPrompt === true ? '' : `${sessionTokenLineV2(key, st.agentToken)}\n\n`;
    // 观察窗口已退役（桥接在后台盯回复），提醒只说"忘了收尾会永眠"。
    return `${roleLine}${identityLine}${tokenLine}【提醒】本轮还没收尾：用 qq_set_wake_config 或 qq_mark_read 收尾（忘了会「永眠」）。不用等任何观察窗口。`;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    // 唤醒频率硬限制：超限则**延后重试**，不能直接丢弃。直接 return 的后果：
    //   · timeout 唤醒时 setupSleepTimerV2 已经清空 sleepTimer，丢弃后这个会话会停在
    //     「infinite=false、sleepUntil 已过期、没有任何定时器」的静默态，除非重启或
    //     主动机会兜底（默认 30~90 分钟）才可能恢复；
    //   · @/提问被丢弃则要等下一条消息才可能再唤醒。
    // 重试仍然遵守限频（等到窗口腾出位置），只是把「这一枪」补回来。
    const now = Date.now();
    // 私聊是一对一说话，限流按「别刷屏」而不是「别话痨」来定：
    // 群里一分钟 1 次合理（防抢麦），私聊一分钟 1 次会把正常对话卡成 30~60 秒延迟。
    // 私聊值可单独配（maxWakePerMinutePrivate / maxWakePerHourPrivate），未配置时沿用全局。
    const isPrivateConvRate = key.startsWith('private:');
    const privatePerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinutePrivate);
    const privatePerHour = Number(cfg.socialV2?.wake?.maxWakePerHourPrivate);
    const maxPerMinute = isPrivateConvRate && Number.isFinite(privatePerMinute) && privatePerMinute > 0
      ? privatePerMinute
      : Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = isPrivateConvRate && Number.isFinite(privatePerHour) && privatePerHour > 0
      ? privatePerHour
      : Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      let retryAfterMs = 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 60000 - (now - times[0]) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - times[0]) + 500);
      }
      // 每次只等一小段（最长 60s）：小时级限频不会一次性睡满一小时而错过中途可用的窗口。
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      if (!st.rateLimitRetryTimer) {
        st.rateLimitRetryTimer = setTimeout(() => {
          st.rateLimitRetryTimer = null;
          // 消息类原因在重试前再确认一次：等待窗口里消息可能已被别的回合处理掉，
          // 没必要为一条已经处理过的消息再唤醒一次（定时器类原因与未读无关，不检查）。
          if (!isTimerWakeReason(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            log(`[reserved2] 限频重试前发现未读已清空，跳过 ${key}（${reason}）`);
            return;
          }
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        st.rateLimitRetryTimer.unref?.();
      }
      log(`[reserved2] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${reason}）`);
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    // ⚠️ 这里**不渲染 prompt，也不做任何降级判定**（2026-11-13 重建）。
    //
    // 旧实现在这里 buildWakePromptV2 一次、把结果交给 deliverPrompt，
    // 而 deliverPromptNow 拿到 wakeReason 后**又渲染一次**并覆盖前者。后果：
    //   · 第一遍渲染时清掉的 memNeedsSync 让压缩提示永远发不出去；
    //   · 这里的降级（组内已引导→按普通唤醒）只作用于被丢弃的那一份，
    //     第二遍按原始 reason（bootstrap）重渲 ⇒ 同一会话里提示发两遍。
    // 现在渲染只在 deliverPromptNow 一处发生，这里只负责"叫醒"。
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      // promptText 传空串：deliverPromptNow 见到 wakeReason 会自己渲染（唯一渲染点）。
      const result = await deliverPrompt(key, '', { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  /**
   * 回复窗口：AI 刚发完消息，桥接在后台盯一段时间。
   *
   * 为什么不再用「30 秒后叫醒看一眼」：那是**定时轮询**，没人回也白醒一次。
   * 现在改成**事件驱动**——窗口内有指向 AI 的新消息就立刻唤醒；没有就什么都不做。
   *
   * 只给私聊挂窗口：私聊任何新消息都算"回应你"；群聊靠 @/引用规则唤醒，
   * 挂窗口会让每条群聊闲话都可能叫醒它，成本反而涨。
   */
  function armReplyWindowV2(key, ms) {
    // 2026-11-12 停用：回复窗口会被"几句话"反复触发多次唤醒，吃上下文。
    // 改用收尾前的空转等待（mark_read / set_wake_config 的 10 秒观望），
    // 那一段时间里她还没睡，新消息直接看到，不需要后台再叫一次。
    // 保留函数签名，避免调用点报错。
    void key; void ms;
    return;
  }

  // ── 闲置压缩（上下文边界）────────────────────────────────────────────────
  //
  // 为什么需要它：DSH 的 `compaction-basic` 是在 agent loop 里按 token 阈值触发
  // 的 —— 也就是**对话中途**。而压缩会改写历史前缀，前缀一变 provider 的
  // KV cache 就整段失效，之后每一步都要重算全部历史（实测 15 万 token ≈
  // 45 秒/步）。于是「压缩」本意是省钱，实际制造了最贵的一类请求。
  //
  // 这里的策略正好相反：
  //   · 对话进行中：preset 的 thresholdRatio 保持 0.95（≈95 万），永不触发；
  //   · 用户安静 idleMs、DSH 没在跑、且上下文超过 thresholdTokens 时：
  //     **原地压缩**（调 DSH 的 /compact）—— 会话 id 不变、桥接映射不变，
  //     dsh-compaction-basic 把尾部 retainTokens 原样保留、前面压成摘要。
  //     当前配置：50 万触发、安静 30 分钟、保留后 20 万。
  //   · 压完置 idleCompactedAt，**直到用户下一条消息才解锁**，绝不反复触发。
  //
  // 【2026-11-13 更正】旧注释写的是"轮换一个新的 DSH 会话、旧会话归档、
  // 上下文真正归零"—— 那是更早的实现，现在**不换会话、不清上下文**，
  // 只做原地压缩，所以压缩后她仍看得到最近的那段对话。
  //
  // 代价：压缩那一步要重算整段历史（缓存失效），之后的请求恢复正常。

  /** 该会话当前上下文有多大：取账本里最近一步的**输入侧** token。 */
  function currentContextTokensV2(key) {
    try {
      const row = tokenLedger.recent(300).find((r) => r && r.key === key);
      if (!row) return 0;
      return (row.cacheMiss || 0) + (row.cacheHit || 0) + (row.cacheWrite || 0);
    } catch (error) {
      log(`[compaction] 读取上下文大小失败 ${key}: ${error?.message ?? error}`);
      return 0;
    }
  }

  /**
   * 判定是否到了「闲置边界」。返回判定依据（用于日志），不满足返回 null。
   *
   * 刻意保守：任何一项不确定都不压。压缩是不可逆的（旧上下文被归档），
   * 误压一次就等于让模型忘掉一段对话，代价远大于少省一点钱。
   */
  function idleCompactDecisionV2(key, st, now = Date.now()) {
    const c = cfg.socialV2?.compaction ?? {};
    if (c.enabled === false) return null;
    if (c.onlyPrivate !== false && !String(key).startsWith('private:')) return null;
    // 一轮对话只压一次：等下一条用户消息把 idleCompactedAt 清零。
    if (st.idleCompactedAt) return null;
    // 正在压 / 会话忙（turn 在跑、排队中、有 pendingWake）都不动。
    if (st.idleCompactingAt) return null;
    if (isConversationBusyV2(key, st)) return null;
    if (!state.sessions[key]) return null;
    const lastUser = st.lastIncomingAt || 0;
    if (!lastUser) return null;
    const idleMs = Math.max(60000, Number(c.idleMs) || 1800000);
    if (now - lastUser < idleMs) return null;
    // 模型自己刚动过（主动冒泡/工具调用）就先不动手：那说明它还在为这条会话干活，
    // 压缩会把正在用的上下文改掉。半程保护，避免它频繁主动发言导致永远压不了。
    if (now - (st.lastActionAt || 0) < Math.floor(idleMs / 2)) return null;
    const threshold = Math.max(10000, Number(c.thresholdTokens) || 300000);
    const ctxTokens = currentContextTokensV2(key);
    if (ctxTokens < threshold) return null;
    return { idleMs: now - lastUser, ctxTokens };
  }

  /**
   * 原地压缩：用 DSH 的 `/compact` 压当前会话的历史，**不换会话、不清映射**。
   *
   * 为什么走 `commands/execute` 而不是发一条 `/compact` 文本：命令由 DSH 的
   * commands 服务解析（`parseCommand(line)` → 查命令表 → 调
   * `compaction.compactNow`），**不是** agent loop 拦截 user message。把
   * `/compact` 当普通 prompt 发出去，模型只会收到一句看不懂的话，白烧一次调用。
   *
   * `commands/execute` 是这个能力的官方 RPC 出口。注意参数名是 `agentId` 而不是
   * `sessionId` —— DSH 里 `agent.id` 就等于 `session.id`（qq-agent-context 插件
   * 也是这么反查的）。
   */
  async function compactSessionV2(key) {
    const sessionId = state.sessions[key];
    if (!sessionId) return { ok: false, error: '会话未建立' };
    try {
      const res = await withTimeout(
        api.callUnary('commands/execute', { agentId: sessionId, line: '/compact', submittedAttachments: [] }),
        COMPACT_TIMEOUT_MS,
        'commands/execute(/compact)'
      );
      // callUnary 返回 { rpcId, result }，而 result 本身是 RPC 信封 { ok, value }，
      // 真正的命令结算结果在 value 里：{ commandId, result: { kind, text } }。
      const envelope = res?.result;
      if (envelope && envelope.ok === false) {
        return { ok: false, error: envelope.error?.message ?? 'commands/execute 返回失败' };
      }
      const settled = envelope?.value;
      const kind = settled?.result?.kind;
      const text = settled?.result?.text ?? '';
      if (!settled || !kind) {
        // execute 在「命令解析不出来 / 命令表里没这个命令」时返回 undefined。
        // 说明这个 DSH 版本没挂 command-compact —— 必须显式失败，绝不假装成功。
        return { ok: false, error: 'DSH 未识别 /compact（preset 里可能没挂 command-compact）' };
      }
      return { ok: kind === 'success', kind, text, commandId: settled.commandId ?? null };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  async function idleCompactV2(key, decision) {
    const st = getSocialV2State(key);
    st.idleCompactingAt = Date.now();
    saveSocialV2State();
    const mins = Math.round(decision.idleMs / 60000);
    log(`[compaction] 闲置边界：${key} 已安静 ${mins} 分钟、上下文约 ${Math.round(decision.ctxTokens / 1000)}k token，开始压缩`);
    try {
      // ① 原地压缩：会话 id 和桥接映射都不变，只是 DSH 把历史压成摘要 + 保留尾部。
      //    （2026-11-10：压缩前的「记忆整理」投递已删除 —— 那是一次模型调用，
      //     现在长期记忆由她自己在聊天中用 qq_memory_append(category='longTerm') 写。）
      const result = await compactSessionV2(key);
      st.idleCompactedAt = Date.now();
      if (result.ok) {
        log(`[compaction] 闲置压缩完成 ${key}：${result.text || '已压缩'}（会话 ${state.sessions[key] ?? '无'} 未变）`);
        // 压缩把历史压成摘要 —— 记忆和人格卡都不在上下文里了。
        //
        // 主来源是 DSH 原生的 compaction/end（pumpMux 里登记），这里只是**兜底**：
        // 事件流断线 / DSH 没推 end 的时候，桥接自己调的这次 /compact 成功了，
        // 事实同样成立。同一次压缩登记两次没有副作用 —— markColdStart 只是刷新时刻，
        // 而判据是"没被消费过"，不是"登记了几次"。
        const sid = state.sessions[key];
        if (sid) markColdStart(sid, 'compacted', '闲置压缩（兜底）');
      } else {
        // 失败也置 idleCompactedAt：否则每个扫描周期都会重试一次，每次都白跑
        // 一遍记忆整理（那是真金白银的模型调用）。等下一条用户消息再解锁。
        log(`[compaction] 闲置压缩失败 ${key}：${result.error}`);
      }
    } catch (error) {
      log(`[compaction] 闲置压缩异常 ${key}: ${error?.message ?? error}`);
    } finally {
      st.idleCompactingAt = 0;
      saveSocialV2State();
    }
  }

  let idleCompactionTimer = null;
  function startIdleCompactionWatch() {
    if (idleCompactionTimer) return;
    const c = cfg.socialV2?.compaction ?? {};
    if (c.enabled === false) {
      log('[compaction] 闲置压缩已关闭（socialV2.compaction.enabled=false）');
      return;
    }
    const every = Math.max(10000, Number(c.checkIntervalMs) || 60000);
    idleCompactionTimer = setInterval(() => {
      try {
        if (currentMode !== 'reserved2' || socialV2.paused) return;
        const now = Date.now();
        for (const key of socialV2.conversations.keys()) {
          const st = socialV2.conversations.get(key);
          if (!st) continue;
          const decision = idleCompactDecisionV2(key, st, now);
          if (!decision) continue;
          void idleCompactV2(key, decision).catch((error) => log(`[compaction] 闲置压缩异常 ${key}: ${error?.message ?? error}`));
          // 一个周期只处理一个会话：同时归档多个会把 DSH 的模型调用打满，
          // 而这件事本来就没有时效性，慢一点无所谓。
          break;
        }
      } catch (error) {
        log('[compaction] 闲置压缩扫描异常:', error?.message ?? error);
      }
    }, every);
    idleCompactionTimer.unref?.();
    log(`[compaction] 闲置压缩已启用：安静 ${Math.round((Number(c.idleMs) || 1800000) / 60000)} 分钟且上下文超过 ${Math.round((Number(c.thresholdTokens) || 200000) / 1000)}k token 时触发`);
  }

  function scheduleReplyCheckV2(key) {
    // 2026-11-12 停用：见 armReplyWindowV2。
    // 发完消息不再挂任何"后台盯回复"的机制 —— 她收尾时自己会等 10 秒看有没有新的。
    void key;
    return;
  }

  /** 会话此刻算忙的具体原因（只用于日志，避免排查时只能反复重启加猜）。 */
  // 正在做「收尾前观望」的会话：观望期间**压住唤醒调度**，观望结束再放开。
  //
  // 为什么必须压（2026-11-14）：观望语义从「见消息即返回」改成「安静窗合并」之后，
  // 它会长到 5~20 秒。而新消息一到，scheduleWakeV2 就会挂一个 batchWindowMs（默认 8 秒）
  // 的唤醒定时器 —— 定时器会在观望**还没结束**时就到点，于是：
  //   ① 那一刻她的回合仍在 tool call 里，判定"会话繁忙"，记 pendingWakeReasons；
  //   ② 回合结束后 replayPendingWakeReasonsV2 补一次唤醒；
  //   ③ 而观望已经把同一批消息贴给她、她也在同一回合里回过了。
  // 结果同一批消息被处理两遍：一次在回合内（观望贴出），一次在回合后（补发唤醒）。
  // 实测日志里 13:52:55 的「计划唤醒 … 8s 后发送」正好落在观望窗口内。
  //
  // 压制方式：只**推迟**不丢弃 —— scheduleWakeV2 见到有观望在进行就直接返回，
  // 观望结束（observeForCloseV2 / paceAfterSendV2）时再把期间来的消息重新排一次。
  // 用 Set 而不是挂在 st 上：观望是 HTTP handler 内的同步等待，跨会话不会互相影响。
  const observingKeys = new Set();

  /**
   * 观望结束后补排唤醒。
   * 观望期间被压掉的唤醒不会自己回来，必须在这里重新问一次。
   * 只在她**确实没在收尾**的情况下补：她已经 mark_read 成功、或已设好唤醒配置，
   * 那批消息她已经看过并处理了，不该再叫醒她。
   */
  function resumeWakeAfterObserveV2(key) {
    if (!key) return;
    observingKeys.delete(canonicalV2Key(key) ?? key);
    const st = getSocialV2State(key);
    if (!st) return;
    // 还有她没看过的消息 ⇒ 那一轮唤醒仍然值得发（她可能因为繁忙没处理完）。
    const seen = st.modelSeenSeqs instanceof Set ? st.modelSeenSeqs : new Set(st.modelSeenSeqs || []);
    if ((st.unread || []).some((m) => !seen.has(m.seq))) {
      scheduleWakeV2(key, 'message');
    }
  }

  function busyReasonV2(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (pendingWakeKeys.has(key)) return 'pendingWakeKey';
    const q = promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = state.sessions[key];
    if (sid) {
      const startedAt = Number(v2TurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (!sid) return false;
    // 回合只按「起始时间 + 租约」判忙，**不再**只看 Map 里有没有键：
    //   · 有 collector 但没起始时间（杂散事件重建出来的）→ 无法证明还活着，不判忙；
    //   · 起始时间超过租约（turn/end 丢了 / DSH 重启把回合丢了）→ 不判忙；
    // collector 保留，所以万一回合其实还活着，它的回复仍会被 flush，只是允许新唤醒排队。
    const startedAt = Number(v2TurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < TURN_BUSY_LEASE_MS) return true;
    if (collector && !turnLeaseNoted.has(sid)) {
      turnLeaseNoted.add(sid);
      log(`[reserved2] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    // 待办到点：和 timeout 同级 —— 都是"时间到了"的提醒，不该抢消息类唤醒的位置。
    // 2026-11-12：她写 todo 时顺手排一个定时器，到点用这个原因唤醒自己。
    todo: 35,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 与「未读消息」无关的唤醒原因（定时器/引导）。这些原因在会话繁忙时被暂存后，
  // 不能用「unread 里还有没有对应 seq」来判断是否还要补发 —— 那一轮很可能已经把
  // 未读全部标读了，结果就是 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
  const TIMER_WAKE_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin', 'todo']);
  function isTimerWakeReason(reason) {
    return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    // 观望进行中：压住唤醒，等观望结束后由 resumeWakeAfterObserveV2 补排。
    // 见 observingKeys 处的说明 —— 不压的话同一批消息会在观望内、观望后各处理一遍。
    if (observingKeys.has(canonicalV2Key(key) ?? key)) {
      log(`[reserved2] 观望进行中，暂缓计划唤醒 ${key}（${reason}）`);
      return;
    }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // ── 组级去重（2026-11-13）──────────────────────────────────────────────
    //
    // 现象：私聊和群**共用同一个 DSH 会话**，但 `pendingWakeTimer` 是挂在各自的
    // `st` 上的。两条消息几乎同时到达时，两边各排一个 8 秒唤醒 ——
    // 在 DSH 看来是同一个会话的两次 prompt ⇒ 两个 turn ⇒ 引导词/冷启动提示发两遍。
    // 实测 12:24:50 与 12:25:34 连续两轮都带了冷启动提示。
    //
    // 修法：用**组级集合**记录"这个组已经排了唤醒"，而不是依赖各自 st 上的 timer。
    // 集合的键是组代表 key（sharedOwnerKeyOf），进组时加、定时器触发/取消时删。
    // 这样无论哪个成员先来，第二个都会被挡住，且不需要在两个 st 之间同步状态。
    const groupKeys = (() => { try { return shareGroupOf(key); } catch { return [key]; } })();
    const groupOwner = groupKeys.length > 1 ? sharedOwnerKeyOf(cfg, key) : key;
    const groupKey = canonicalV2Key(groupOwner) || groupOwner;
    if (groupKeys.length > 1 && groupHasPendingWake.has(groupKey)) {
      // 组内已经有待发唤醒 → 不再排第二个。
      //
      // ⚠️ 这里**刻意不去"升级原因"**：定时器挂在发起那个 key 的 st 上，
      // 而 groupOwner 可能是另一个 key（组代表）。去 `getSocialV2State(groupOwner)`
      // 改它的 pendingWakeReason 有两个问题：
      //   ① 那个 st 上根本没有 timer（pendingWakeTimer 恒为 null），改了也没人读；
      //   ② getSocialV2State 是**惰性创建**的 —— 调它会在 socialV2.conversations
      //      里凭空建出一个假会话（有 wakeConfig、空 unread），污染状态文件。
      // 反正那一轮唤醒的快照是按组收集的（collectSharedMessagesV2），
      // 组内所有消息都会被带上，不需要靠"升级原因"来保证覆盖。
      log(`[reserved2] 组内已有待发唤醒（${groupPendingReason.get(groupKey) || '未知'}），跳过 ${key} 的 ${reason}`);
      return;
    }
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    // 私聊默认用更短的合并窗口：私聊一来一回就是正经对话，硬等 8 秒纯属折磨。
    // 群里保留长窗口（多人抢话需要合并），私聊可用 batchWindowMsPrivate 单独调。
    const isPrivateConvBatch = key.startsWith('private:');
    const privateBatchMs = Number(cfg.socialV2?.wake?.batchWindowMsPrivate);
    const batchMs = isPrivateConvBatch && Number.isFinite(privateBatchMs) && privateBatchMs > 0
      ? Math.max(1000, privateBatchMs)
      : Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      // 组级登记同步清掉：下一次组内任何成员都能重新排唤醒。
      groupHasPendingWake.delete(groupKey);
      groupPendingReason.delete(groupKey);
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    // 登记到组级：共用会话下，代表 key 是固定的（sharedOwnerKeyOf 是组内容的纯函数），
    // 所以这里用 groupKey 记，下一个成员进来能看见。
    if (groupKeys.length > 1) {
      groupHasPendingWake.add(groupKey);
      groupPendingReason.set(groupKey, reason);
    }
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  /**
   * 回合结束后补发「繁忙期间暂存」的唤醒原因。
   *
   * 两类原因必须分开处理：
   *   · 消息类（@/关键词/提问/私聊/拍一拍…）只有在那条消息还没被本回合处理掉时才补发
   *     （unread 里还能找到它的 seq）；
   *   · 定时器类（timeout/replyCheck/proactiveCheck/bootstrap/admin）与未读水位无关：
   *     那一轮很可能已经把未读全部标读，用 unread 判断会让「到点唤醒」被静默吞掉 ——
   *     timeout 时 sleepTimer 已被清空，结果是会话停在「sleepUntil 已过期、无任何定时器」。
   */
  function replayPendingWakeReasonsV2(key) {
    const st = getSocialV2State(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    const item = st.pendingWakeReasons.shift();
    if (!item || typeof item !== 'object') return null;
    if (isTimerWakeReason(item.reason)) {
      if (item.reason === 'timeout') {
        log(`[reserved2] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimerV2(key);
      } else if (item.reason === 'replyCheck') {
        log(`[reserved2] ${key} 补排繁忙期间的回复检查`);
        scheduleReplyCheckV2(key);
      } else if (item.reason === 'proactiveCheck') {
        // 主动机会有周期性重排，错过一次可接受（也不该在回合结束时立刻补一刀）。
        log(`[reserved2] ${key} 繁忙期间的主动机会已过期，跳过补发`);
      } else {
        log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWakeV2(key, item.reason);
      }
      return { reason: item.reason, action: 'timer' };
    }
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    if (stillRelevant) {
      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
      scheduleWakeV2(key, item.reason);
      return { reason: item.reason, action: 'replayed' };
    }
    log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
    return { reason: item.reason, action: 'skipped' };
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等一小段后重新续期，
    // 而不是提前唤醒。这里刻意用 100 秒级的小步长（而不是 24 天的上限）：
    // 每次续期都会用 Date.now() 重新算剩余时间，系统时钟被校正/跳变时能很快纠正过来。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  // ── 待办到期提醒（2026-11-12 新增）──────────────────────────────────────
  //
  // 需求：她写 todo 时顺手排一个定时唤醒，到点提醒她"该做这件事了"，
  // 语气和位置跟「（有人拍了一拍。）」一样。
  //
  // 为什么不用 setInterval 扫全表：那样每个会话都要周期醒来看一遍，
  // 而且时间精度差。这里按"最近一条待办"排一个 setTimeout，
  // 到点唤醒后重新排下一个 —— 和 sleepTimer 的续期模式一致。
  //
  // 待办本身存在 globalMemory.todos（全局），但**唤醒必须按会话**：
  // 她的定时器挂在具体 key 上，所以要记住"这条 todo 是哪个会话的"。
  // 存在 todo 自己身上（wakeKey 字段），跟着 todo 一起持久化。
  const TODO_TIMER_MAX_MS = 100009; // 和 sleepTimer 同一个上限，避免 2^31 溢出

  /** 找出这个会话里**最早到期且还没提醒过**的待办。 */
  function nextDueTodoFor(key) {
    const g = getSocialV2State(GLOBAL_MEMORY_KEY);
    const list = Array.isArray(g.todos) ? g.todos : [];
    const now = Date.now();
    let best = null;
    for (const t of list) {
      if (!t || !t.text || t.done) continue;
      if (String(t.wakeKey || '') !== key) continue;   // 不是这个会话排的
      if (t.notifiedAt) continue;                       // 已经提醒过了
      const due = Number(t.expiresAt) || 0;
      if (!due) continue;
      if (!best || due < Number(best.expiresAt)) best = t;
    }
    return best;
  }

  /** 给这个会话重新排待办定时器（先取消旧的）。 */
  function setupTodoTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.todoTimer) {
      clearTimeout(st.todoTimer);
      st.todoTimer = null;
    }
    if (socialV2.paused) return;
    const next = nextDueTodoFor(key);
    if (!next) return;
    const delay = Number(next.expiresAt) - Date.now();
    if (delay <= 0) {
      // 已经到点了：直接唤醒（不等 setTimeout(0)，那条路径容易被合并窗口吞掉）。
      const text = String(next.text || '').slice(0, 60);
      log(`[reserved2] 待办已到点，立即唤醒 ${key}：${text}`);
      next.notifiedAt = Date.now();
      saveSocialV2State();
      scheduleWakeV2(key, `todo:${text}`);
      return;
    }
    if (delay > TODO_TIMER_MAX_MS) {
      st.todoTimer = setTimeout(() => {
        st.todoTimer = null;
        setupTodoTimerV2(key);
      }, TODO_TIMER_MAX_MS);
      st.todoTimer.unref?.();
      log(`[reserved2] 设置远未来待办定时器 ${key}，首段 ${Math.round(TODO_TIMER_MAX_MS / 1000)} 秒后续期`);
      return;
    }
    st.todoTimer = setTimeout(() => {
      st.todoTimer = null;
      const due = nextDueTodoFor(key);
      if (!due) return;
      const text = String(due.text || '').slice(0, 60);
      due.notifiedAt = Date.now();
      saveSocialV2State();
      log(`[reserved2] 待办到点唤醒 ${key}：${text}`);
      scheduleWakeV2(key, `todo:${text}`);
      // 排下一个（可能还有别的待办）
      setupTodoTimerV2(key);
    }, delay);
    st.todoTimer.unref?.();
    log(`[reserved2] 设置待办定时器 ${key}，剩余 ${Math.round(delay / 1000)}s：${String(next.text || '').slice(0, 40)}`);
  }

  /** 取消这个会话的待办定时器。 */
  function cancelTodoTimerV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.todoTimer) return;
    clearTimeout(st.todoTimer);
    st.todoTimer = null;
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
          clearGroupPendingWake(key);
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    // 待办到点提醒（2026-11-12）：模式切换/暂停时也要清掉，否则会绕过模式守卫。
    if (st.todoTimer) {
      clearTimeout(st.todoTimer);
      st.todoTimer = null;
    }
    if (st.rateLimitRetryTimer) {
      clearTimeout(st.rateLimitRetryTimer);
      st.rateLimitRetryTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          turnLeaseNoted.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
                cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await withTimeout(api.stopSessionWork(old), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: old }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      const sender = v2SenderLabelFor(key, kind, event);
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      // 引导判定按共用组：组里任何一方已经引导过就不再重复发（见 groupBootstrapSent）。
      if (!groupBootstrapSent(key)) {
        markGroupBootstrapSent(key);
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        // 2026-11-12：回复窗口已停用（见 armReplyWindowV2）。
        // 唤醒只走正常触发判定；"发完消息后还有人接话"由收尾前的 10 秒观望处理，
        // 不在这里另开一条唤醒路径 —— 那条路会让几句话触发多次唤醒，很吃上下文。
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = v2SenderLabelFor(key, kind, event);
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: promptText }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: promptText }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    // 2026-11-14 修：**先查别名表**，再看群成员接口。
    //
    // 原来只有群聊分支会解析昵称（resolveGroupMemberName），私聊拍一拍的 sender
    // 直接就是 QQ 号 —— 那条消息进 recentMessages 后，noteAliasV2 会把号码当成
    // "名字"写进别名表，把已有的正常昵称顶掉（详见 noteAliasV2 的注释）。
    //
    // 现在三级回退：别名表（最快、最准，正常消息早就写进去了）→ 群成员接口 → QQ 号。
    // 私聊也能命中别名表，因为同一个人只要在群里说过话就已经有记录了。
    let sender = senderId;
    if (senderId) {
      const known = displayNameOfV2(senderId, '');
      if (known && known !== senderId) {
        sender = known;
      } else if (kind === 'group') {
        try {
          sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
        } catch {}
      }
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    // 拍一拍也走同一套组级判定：防止「群里先被拍一下就发一次引导、
    // 私聊第一次说话时又发一次」。
    if (!groupBootstrapSent(key)) {
      markGroupBootstrapSent(key);
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ

  /**
   * 把一条 session/event 喂给该会话的 turn collector，并维护 collectors 的生命周期。
   *
   * 两条不变量（都曾被真实故障踩过）：
   *   ① 只为 turn/start 建 collector —— 任何事件都建的话，一条重连后补发的
   *      assistant/message 就会留下永不结束的空 collector，而「会话是否繁忙」正是按
   *      collectors.has() 判断的 ⇒ 这个会话从此再也收不到唤醒；
   *   ② turn/end 即使没有匹配的 turn/start（重连快照没带上）也要清掉已成空壳的
   *      collector，否则同样会永久繁忙。
   */
  function trackTurnEvent(sessionId, event) {
    let collector = collectors.get(sessionId);
    if (!collector && event?.type === 'turn/start') {
      collector = createTurnCollector();
      collectors.set(sessionId, collector);
    }
    const ended = collector ? collector.push(event) : null;
    if (ended) {
      // 回合正常收尾：collector 立刻释放。v2TurnStartAt 留给调用方（无行动判定要用它），
      // 调用方在 `if (ended)` 分支里用完再删。
      collectors.delete(sessionId);
      // 本轮归属用完即清：下一次 turn/start 重新从 turnKeyQueue 取。
      turnKeyLatch.delete(sessionId);
    } else if (event?.type === 'turn/end' && (!collector || collector.size?.() === 0)) {
      collectors.delete(sessionId);
      v2TurnStartAt.delete(sessionId);
      turnLeaseNoted.delete(sessionId);
      turnKeyLatch.delete(sessionId);
    }
    return { collector, ended };
  }

  async function pumpMux() {
    // 事件流重连退避：DSH 侧流被立刻关闭时（例如版本不兼容，见 issue #34），
    // 固定 3 秒重连会以每分钟 20 行的速度刷屏，真正有用的错误反而被淹没。
    let retryMs = 3000;
    let failureStreak = 0;
    for (;;) {
      let framesThisStream = 0;
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          framesThisStream += 1;
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // ── 条件 B「刚压缩过」的原生来源（2026-11-13 重建）──────────────
            // DSH 压缩会话时会推 compaction/start → compaction/summary → compaction/end。
            // 这里**必须先于**下面所有 "key 不匹配就 continue" 的分支处理：
            // 学习会话、未映射会话的压缩同样把上下文压没了，而那些分支会直接跳过。
            if (frame.event?.type === 'compaction/start') {
              compactionInFlight.set(String(frame.sessionId), Date.now());
            } else if (frame.event?.type === 'compaction/end') {
              compactionInFlight.delete(String(frame.sessionId));
              // 只认"真的产生了摘要"的压缩：失败/中止的压缩没有把历史压成摘要，
              // 挂提示只会让她白查一次。
              markColdStart(frame.sessionId, 'compacted', 'DSH 原生 compaction/end');
            }
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            // 回复归属：共用会话下 reverse 记的是组内代表 key，分不出私聊还是群，
            // 所以以「本轮是谁投递的」为准（turnKeyQueue 按投递顺序排队，turn/start 出队并锁存）。
            let key = turnKeyLatch.get(frame.sessionId);
            if (frame.event.type === 'turn/start') {
              const queuedKey = shiftTurnKey(frame.sessionId);
              if (queuedKey) { key = queuedKey; turnKeyLatch.set(frame.sessionId, queuedKey); }
            }
            if (!key) key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                // 与主 collector 同样的道理（issue #26 的补充）：**只有 turn/start 才建** collector。
                // 迟到事件（session/end-seed、session/title、model/selection…）不会有 turn/end，
                // 若在这里顺手建一个，它会永远留在 learnerCollectors 里并吞掉后续 turn 事件，
                // 等待者要么拿不到结果、要么拿到错位的文本。
                let learnerCollector = learnerCollectors.get(frame.sessionId) ?? null;
                if (!learnerCollector && frame.event.type === 'turn/start') {
                  learnerCollector = createTurnCollector();
                  learnerCollectors.set(frame.sessionId, learnerCollector);
                }
                const learnerEnded = learnerCollector ? learnerCollector.push(frame.event) : null;
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              turnLeaseNoted.delete(frame.sessionId);
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // collector 生命周期见 trackTurnEvent()：只为 turn/start 建、空壳 turn/end 即清。
            const { ended } = trackTurnEvent(frame.sessionId, frame.event);
            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const sendToolHit = sendToolSucceededSessions.has(frame.sessionId);
                // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
                // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
                if (turnStart > 0 || sendToolHit) {
                  const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
                  if (actionTaken) {
                    st.wakeConfig.noActionCount = 0;
                  } else {
                    st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                    const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                    if (st.wakeConfig.noActionCount >= limit) {
                      log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                      st.wakeConfig = defaultWakeConfigV2();
                      // 这里曾经写 st.bootstrapSent = true（"配置都重置了，别再补引导"）。
                      // 现在 bootstrapSent 只管【初始提示词】是否注入过，跟"要不要给冷启动提示"
                      // 无关，在一个跟它无关的失败兜底里改它只会让语义更乱 —— 删掉。
                      st.wakeConfig.noActionCount = 0;
                    }
                  }
                  saveSocialV2State();
                } else {
                  log(`[reserved2] ${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数`);
                }
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              turnLeaseNoted.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次（定时器类与消息类语义不同，
              // 详见 replayPendingWakeReasonsV2 的注释）。
              replayPendingWakeReasonsV2(key);
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const audit = auditOutbound(plain, { level: auditLevelFor(key), knownTokens: KNOWN_AGENT_TOKENS });
                if (audit.blocked) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含${audit.reason}`);
                  appendActivity(`${key} agent 回复被拦截（疑似${audit.reason}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, `⚠️ 本条回复因疑似包含${audit.reason}被安全策略拦截，已记录并通知管理员。`);
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 以前这里只发 QQ、不写日志：出问题时 bridge.log 里什么都没有，排查只能靠猜（PR #24）。
                log(`⚠️ agent 处理出错 (${key})：${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 80)}`);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                log(`⏹️ 回合被中止 (${key})`);
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
        // 流正常关闭（服务端主动断开）不会抛错。以前这里什么都不打，日志看起来
        // 就像「连上了、然后又连一次」，完全看不出 DSH 把流关了。
        log(`DSH 事件流已结束（本次收到 ${framesThisStream} 帧）`);
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      if (framesThisStream > 0) {
        failureStreak = 0;
        retryMs = 3000;
      } else {
        failureStreak += 1;
        retryMs = Math.min(30000, retryMs * 2);
        if (failureStreak === 3) {
          log('⚠️ 连续多次连上 DSH 事件流后一帧都没收到就断开：多半是 DSH 侧事件流协议/版本不匹配'
            + '（可在 DSH 里核对版本，或查看 issue #34）。已改为指数退避重连，不再每 3 秒刷屏。');
        }
      }
      // 用可打断的 sleep：端口对齐 / DSH 重新可用时会被 wakeMuxPump() 立刻叫醒，
      // 不必再干等满退避窗口（最长 30 秒）。被叫醒说明「环境变了」，退避计数清零重来。
      if (await sleepUnlessWoken(retryMs)) {
        failureStreak = 0;
        retryMs = 3000;
      }
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
    // 用 `===` 漏掉自己发的消息会进入正常处理（reserved2 下 AI 会回答自己 / chat 下可能回复循环）。
    if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
      || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        selfDisplayName = String(login.nickname).trim();
        log(`机器人昵称: ${login.nickname}`);
      }
      if (login?.user_id != null) selfUserId = String(login.user_id);
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => {
    // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
    // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
    // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
    const detail = error && typeof error === 'object'
      ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ') || JSON.stringify(error)
      : String(error ?? '');
    log(`SnowLuma 错误：${detail || '(无详情)'}`);
    void healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
  });

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();
  // 上下文只在「闲置边界」压缩：对话进行中一律不压（见 idleCompactV2 的说明）。
  startIdleCompactionWatch();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
