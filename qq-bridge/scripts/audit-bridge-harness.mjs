// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
import * as forward from '../src/forward.js';
// slang-learner.js 已随黑话功能下线而删除（qq_slang_* 工具一并移除）。
// 这里不再 import，改成空对象摊入 —— 保持下面 `...slang` 的写法不破，且不会引到不存在的模块。
const slang = {};
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as ttsLib from '../src/tts.js';
// 记忆子系统：bridge.js 顶层从这三个模块解构了十几个函数（selectFactsForInjection /
// addFact / createStore / createRecall / bumpAffinity …）。它们以前**从没注入过 VM**，
// 于是 selectFactsForInjection 在 VM 里是 undefined —— buildWakePromptV2 里那个
// 「事实库坏了不能影响整轮唤醒」的 try/catch 把 ReferenceError 悄悄吞了。
// 后果：所有依赖记忆注入的断言其实都在测「注入失败」这条分支，长期是假绿。
import * as memoryFacts from '../src/memory-facts.js';
import * as memorySearch from '../src/memory-search.js';
import * as memoryStore from '../src/memory-store.js';
import * as affinity from '../src/affinity.js';
// 角色卡：bridge.js 顶层从 role-card.js 解构了 selectRoleText / parseRoleSections 等。
// 之前没注入，于是 /api/socialV2/prompt 在这个 VM 里直接 500「selectRoleText is not defined」——
// 真实进程里没事（那是真 import），但测试里整条 prompt 路径都测不了。
import * as roleCard from '../src/role-card.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as sendFileLib from '../src/send-file-lib.js';
import * as stateAcl from '../src/state-acl.mjs';
// B站分享卡片内联展开（2026-11-12）。bridge.js 顶层 import 了 setCardConfig /
// summarizeCard，VM 里 import 被剥掉、必须在这里摊进 context —— 否则 loadConfig 在
// `cfg.socialV2.cards = setCardConfig(...)` 处直接 ReferenceError，整个 harness 起不来。
// 注意别用 `...card` 整包摊：它导出的 formatDuration（m:ss）会和 card-parse 的
// 同名导出（给人读的时长文案）撞车，后摊的覆盖前者 ⇒ 语音相关的既有断言会静默失真。
import { setCardConfig, summarizeCard } from '../src/card-parse.js';
// 图片/表情的语义分类（2026-11-17 新增）。bridge.js 顶部从它 import
// isStickerLike / describeInlineImage / stickerLabelFromSummary ——
// VM 里 import 被剥掉，不在这里摊进 context 就会是 undefined，
// 表现为测试里 `ReferenceError: isStickerLike is not defined`。
// 注意**不要** `...mediaKind` 整包摊：它导出的名字较通用，容易和别的模块撞车。
import {
  isStickerLike as _isStickerLike,
  describeInlineImage as _describeInlineImage,
  stickerLabelFromSummary as _stickerLabelFromSummary,
} from '../src/media-kind.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [], onebotRequests: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // fetch_custom_face_detail：同步收藏表情的 HTTP 兜底路径要拿到**数组**（WS 失败时用）。
    if (action === 'fetch_custom_face_detail') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 记录所有 OneBot 动作：发文件（upload_private_file / upload_group_file）这类
      // "真的把东西送出去"的调用必须在测试里可断言，不能只靠返回值。
      calls.onebotRequests.push({ action, params });
      // 群成员列表：v2 读工具 qq_get_group_members 会用到（含 WS 不可用时的 HTTP 兜底路径）。
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    // 唤醒调度：给「观望期间必须压住唤醒」这条回归用（test-observe-before-sleep.mjs）。
    // 不导出的话那条断言只能靠等定时器真的触发，慢 8 秒还测不稳定。
    scheduleWakeV2,
    // 唤醒判定与优先级：直接断言"什么样的事件会唤醒她"，不必真的投递 prompt。
    evaluateWakeTriggerV2, wakePriorityV2, defaultWakeConfigV2,
    // 别名表：昵称 ↔ QQ 号。test-alias-no-number 要直接断言"号码不会当名字写进去"。
    noteAliasV2, displayNameOfV2, lookupAliasV2,
    syncStickerLibrary, listStickersForV2, getStickerImageData,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    // 三档权限分级：档位判定与「该用哪个 preset」都暴露出来，方便直接断言（不必真建会话）。
    sessionTier, wantedPresetName, isAllowListed, TIER_PRESETS, modePreset,
    collectors, setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    // 唤醒在途租约的原始状态：新链路测试要模拟「一轮真的跑完了」，
    // 就必须像 pumpMux 在 turn/end 里那样解除 key 的在途标记，
    // 否则第二次唤醒会被判忙、压根不投递，测出来的"没有重复提示"是假的。
    pendingWakeKeys, disarmPendingWakeLease, busyReasonV2,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    // 共用组级的「初始提示词是否已注入」判定（bootstrapSent）。
    // ⚠️ 它**不再**决定冷启动那两句提示发不发 —— 那个只看 coldStartRegistry。
    // 判据按组算，否则同一段初始提示词会发两遍。
    groupBootstrapSent,
    markGroupBootstrapSent,
    // 冷启动（新会话 / 刚压缩过）的唯一判定与写入点。测试必须能直接观察到它，
    // 而不是绕过真实投递路径去调 buildWakePromptV2 —— 那个函数现在只是"读标记"的一方。
    coldStartRegistry,
    markColdStart,
    coldStartStateOf,
    commitColdStart,
    shareGroupOf,
    memoryKeyOf,
    // 全局记忆（2026-11-10 定稿）：长期三类全局一份、短期两类按会话。
    memoryKeyFor,
    globalMemoryOf,
    resolveImpressionTarget,
    formatMemberImpressionsV2,
    // 记忆写入/发送者标签：共用组下三类长期记忆都要按组绑定，
    // 私聊的 sender 也不能再是字面量「私聊」（见 test-memory-sharing.mjs）。
    appendMemoryV2,
    v2SenderLabelFor,
    formatMemoryV2,
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession,
    assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  // 注意：setInterval **不能桩成空函数**。
  // 这里原来写的是 `setInterval: () => ({ unref() {} })`，于是 bridge.js 里
  // observeBeforeSleepV2 的 250ms 轮询定时器永远不回调 ⇒ 它的 Promise 永不 resolve
  // ⇒ /api/socialV2/mark-read 整个请求挂死，直到调用方的 4s 超时才断。
  // 表现为 test-token-economy 里 26 个用例集体超时（而不是断言失败），
  // 让人误以为是水位算法坏了 —— 其实那条路在测试里从没跑通过。
  // 现在给真定时器，并登记到 timers，close() 时一并清掉，避免测试进程挂住。
  const intervals = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout,
    // setInterval 用真实实现（见上面 timers 处的说明）：观望轮询必须真的跑起来。
    setInterval: (fn, ms) => { const timer = setInterval(fn, ms); intervals.add(timer); return timer; },
    // clearInterval 也要真的清：否则 close() 之后残留的轮询会一直阻着事件循环。
    clearInterval: (timer) => { if (timer) intervals.delete(timer); clearInterval(timer); },
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...stateAcl, ...presetPrompt, ...sendFileLib,
    // 记忆子系统（见顶部 import 处的说明）：bridge.js 里大多用具名解构，名字与导出名一致，
    // 直接摊开即可；只有下面这几个是**改名解构**的，必须显式补，否则那条路径在 VM 里
    // 依然是 undefined（异常被 try/catch 吞掉 = 永久假绿）。
    ...memoryFacts,
    ...memorySearch,
    ...memoryStore,
    ...affinity,
    ...roleCard,
    selectFactsForInjection: memoryFacts.selectForInjection,
    createMemoryStore: memoryStore.createStore,
    AFFINITY_INITIAL: affinity.INITIAL_SCORE,
    AFFINITY_STAGES: affinity.STAGES,
    AFFINITY_SCORE_MIN: affinity.SCORE_MIN,
    AFFINITY_SCORE_MAX: affinity.SCORE_MAX,
    affinityStageOf: affinity.stageOf,
    synthesizeTts: ttsLib.synthesize,
    ttsServerReady: ttsLib.ttsReady,
    // bridge.js 顶层 import 了 tts.js 的 TTS_DEFAULTS / synthesize / ensureTtsServer /
    // ttsReady / normalizeTtsConfig；VM 里 import 被剥掉，缺了这些绑定时 loadConfig
    // 会在 `tts: { ...TTS_DEFAULTS }` 处直接 ReferenceError，整个 harness 起不来。
    // 只摊入纯函数与常量；ensureTtsServer 真会 spawn 进程，这里桩掉。
    TTS_DEFAULTS: ttsLib.TTS_DEFAULTS,
    synthesize: ttsLib.synthesize,
    ttsReady: ttsLib.ttsReady,
    normalizeTtsConfig: ttsLib.normalizeTtsConfig,
    ensureTtsServer: async () => ({ ok: false, reason: 'stub: 测试环境不启动 TTS 进程' }),
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    // B站分享卡片：setCardConfig 会改写模块级配置（VM 与真实环境共用同一份模块实例），
    // 所以测试里改开关后必须显式复原；summarizeCard 直通真实实现，但测试不该出网 —— 
    // 卡片断言用 fixture JSON 且不开 enabled，需要真实解析的用例放到 test-card-parse.mjs。
    setCardConfig,
    summarizeCard,
    // 图片/表情语义分类（2026-11-17）：bridge.js 顶部 import 了这三个，
    // VM 里必须显式注入，否则是 undefined —— 调用点会抛
    // `ReferenceError: isStickerLike is not defined`。
    isStickerLike: _isStickerLike,
    describeInlineImage: _describeInlineImage,
    stickerLabelFromSummary: _stickerLabelFromSummary,
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  // preset 清单要与真实安装一致。
  //
  // 2026-11-15 修：这里原来只有旧名字（qq-chat / qq-chat-v2 / qq-chat-owner /
  // qq-chat-readonly），而四个旧预设早已合并成唯一的 `qq-chat-agent`。
  // 清单不含新名字的后果：任何走 owner 档建会话的测试都会撞上 fail-closed
  // （「需要 preset qq-chat-agent，但它不在 DSH 可用清单中」），
  // 于是那些用例变成在测失败路径 —— 看着通过，其实什么都没验证。
  // 现在同时保留旧名（历史用例引用它们）与新名（当前代码用）。
  bridge.setPresets([
    'standard',
    'qq-chat-agent',
    'qq-chat', 'qq-chat-v2', 'qq-chat-owner', 'qq-chat-readonly',
  ]);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    // 观望轮询（observeBeforeSleepV2 的 250ms setInterval）也要在这里停掉，
    // 否则一个用例跑完它的定时器还活着，拖住事件循环、甚至跨用例误触发。
    for (const interval of intervals) clearInterval(interval);
    timers.clear();
    intervals.clear();
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
