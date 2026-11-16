// QQ 会话上下文注入（Host 插件）。
//
// 解决的是这个具体现象：桥接每轮唤醒都会把「身份 / 会话令牌 / 可用表情 / 长期记忆」
// 拼进一条 user message 发给模型，于是模型的每一轮开场白都是系统指令，而不是人话；
// 这些内容还会随对话历史一起累积，压缩（compaction）之后可能被摘要掉，令牌一丢工具全废。
//
// 做法：在**每个 QQ 会话自己的 agent 作用域**里注册一个系统提示词段。
//   1. 只在 system prompt 里出现，不进对话历史 —— 模型看到的第一句人话就是「hello」；
//   2. 每轮重新装配，不会因为压缩而消失；
//   3. 内容按会话隔离，群聊与私聊各是各的。
//
// 注意：`text` 是同步函数（DSH 每步装配时同步求值），所以内容必须来自本地缓存，
// 不能在里面发请求。缓存由「首次装配前补一次」+ 定时刷新维护。
//
// ── 2026-11-17 关键修复：首轮拿不到令牌 ──────────────────────────────────────
//
// 症状：新会话的第一轮系统提示词里没有【令牌】，模型只能自己 grep 文件翻令牌
// （实测 107 个历史会话，首轮带令牌的 **0 个**；个别会话到第 6 轮才出现）。
//
// 根因（时序，不是配置）：桥接的 `ensureSession()` 里，`api.sessions.create()`
// **返回之后**才执行 `state.sessions[key] = sessionId`（bridge.js 约 10134 行）。
// 而 DSH 的 `agents.announce()` 在 create 内部就把 `agent/created` 事件**串行 await**
// 完了 —— 也就是说插件那次 refresh 一定发生在「映射还没落盘」的窗口里，
// 桥接按 sessionId 反查不到 key，只能回 404。
//
// 于是旧实现（只有拿到数据才 install）在新建会话的第一轮必然装不上；
// 之后定时器又只补装「没装过」的会话，第一轮就永久缺令牌。
//
// 现在的链条（尽量短，只有两跳）：
//   ① `agent/created`：**无条件**注册提示词段（text() 读缓存，可能暂时是空的）；
//   ② `system-prompt/assemble`（waterfall，可 await）：装配时若缓存是冷的，
//      先同步等一次 HTTP（本机回环，毫秒级，最多 1.2s 超时），再 `next()` 取结果，
//      把我们那段文本按段名覆盖进去。
//
// 为什么这样就一定能拿到：**首次装配发生在这条 prompt 被投递之后**，也就是
// `ensureSession()` 已经 return、`state.sessions[key]` 已经落盘的时刻。
// 因此第一次装配时桥接一定认得这个 sessionId。（这一点是官方
// dsh-working-directory 的同款写法：context 声明 + assemble 时刷新。）
//
// 限流：负结果（桥接不认识这个 session / 桥接连不上）各自带一段冷却，
// 避免 GUI 会话、子 agent 这类非 QQ 会话每一步都打一次 404。

// 这两个是纯函数模块，顶层 import 没有副作用。
// fileURLToPath 在 Windows 上才能把 import.meta.url 正确转成盘符路径
// （new URL().pathname 会给 /D:/... 这种形式，拼路径会出错）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BRIDGE = 'http://127.0.0.1:3100';
// 控制台令牌文件：**不要写死绝对路径**（换台机器就再也读不到，而且开源会泄露作者目录）。
// 优先级：插件 config.tokenFile > 环境变量 QQ_BRIDGE_TOKEN_FILE > **自动推导**。
//
// ⚠️ 2026-11-15 修：原来最后一档是"空" —— 插件于是静默降级成"不注入"，
// 配置看起来完全正确、也不报任何错，模型却拿不到【令牌】，QQ 工具全部被拒。
// 协助者部署时在这个坑上卡了三轮（每轮都以为改对了，实际插件一直在空转）。
//
// 现在改成自动推导：插件本体位于 `<仓库>/qq-bridge/plugins/qq-agent-context/index.js`，
// 往上两级就是 `<仓库>/qq-bridge`，令牌在它下面的 `state/console-token`。
// 推导成功就不用配任何东西；推导失败会**明确报错**到日志，不再装聋作哑。
const AUTO_TOKEN_FILE = (() => {
  try {
    // 用 fileURLToPath 而不是 new URL().pathname —— Windows 上前者才给正确的盘符路径。
    const here = fileURLToPath(import.meta.url);          // .../plugins/qq-agent-context/index.js
    const pluginDir = path.dirname(here);                  // .../plugins/qq-agent-context
    const pluginsDir = path.dirname(pluginDir);            // .../plugins
    const bridgeDir = path.dirname(pluginsDir);            // .../qq-bridge
    return path.join(bridgeDir, 'state', 'console-token');
  } catch {
    return '';
  }
})();
const DEFAULT_TOKEN_FILE = process.env.QQ_BRIDGE_TOKEN_FILE || AUTO_TOKEN_FILE;
const FETCH_TIMEOUT_MS = 1200;
const REFRESH_MS = 120000;
const TOKEN_TTL_MS = 60000;
// 桥接说「这个 sessionId 不是 QQ 会话」：隔久一点再问（映射可能稍后才落盘）。
const MISS_RETRY_MS = 30000;
// 桥接连不上 / 超时：很快重试，别让一次网络抖动把令牌卡掉两分钟。
const ERROR_RETRY_MS = 5000;
const SECTION_NAME = 'qq:session-context';

export const name = 'qq-agent-context';
export const inject = ['systemPrompt', 'agents'];

export function apply(ctx, config) {
  const bridgeUrl = String(config?.bridgeUrl || DEFAULT_BRIDGE).replace(/\/+$/, '');
  const tokenFile = String(config?.tokenFile || DEFAULT_TOKEN_FILE);
  // sessionId → { text, key, at, freshMs }
  const cache = new Map();
  // sessionId → Promise（同一会话的并发装配只发一次请求）
  const loading = new Map();
  // sessionId → fiber
  const fibers = new Map();
  let tokenCache = { value: '', at: 0 };
  // 令牌文件相关的问题只报警一次：每轮都刷会把 DSH 日志冲爆。
  let tokenFileWarned = false;

  const textOf = (agent) => cache.get(String(agent.id))?.text ?? '';

  // 控制台令牌：桥接的所有 HTTP 路由都要求它。读文件而不是写进配置，
  // 这样令牌轮换后插件自动跟上（缓存 60 秒，避免每轮都读盘）。
  async function consoleToken() {
    // 2026-11-15：不再"没配就静默返回空"。
    // 实测这个静默降级是部署时最难查的问题 —— 插件看起来装好了、配置也写了，
    // 但模型拿不到【令牌】，QQ 工具全被拒，日志里一个字都不提。
    // 现在：解析不到就**明确写一条警告**（只写一次，避免每轮刷屏）。
    if (!tokenFile) {
      if (!tokenFileWarned) {
        tokenFileWarned = true;
        console.warn('[qq-agent-context] 没有可用的 tokenFile —— 插件将不注入任何内容。'
          + ' 请设置环境变量 QQ_BRIDGE_TOKEN_FILE，或在 cordis.patch.yml 的 config.tokenFile 指定。'
          + ' （正常安装时应当能自动推导到 <仓库>/qq-bridge/state/console-token）');
      }
      return '';
    }
    const now = Date.now();
    if (now - tokenCache.at < TOKEN_TTL_MS) return tokenCache.value;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(tokenFile, 'utf8');
      tokenCache = { value: raw.trim(), at: now };
    } catch (error) {
      // 读失败也要说清楚：路径错 / 权限不足 / 桥接还没跑过（文件未生成）。
      if (!tokenFileWarned) {
        tokenFileWarned = true;
        console.warn(`[qq-agent-context] 读不到 tokenFile: ${tokenFile} —— ${error?.message ?? error}。`
          + ' 桥接首次启动后才会生成这个文件；如已启动仍报错，检查路径与权限。');
      }
      tokenCache = { value: tokenCache.value, at: now };
    }
    return tokenCache.value;
  }

  /**
   * 问桥接要这个会话的固定段落。
   * 三种结果必须分开：`ok`（有内容）、`miss`（这 session 不是 QQ 会话）、
   * `error`（桥接没起来 / 超时）。混成一个 null 会让"暂时失败"被当成
   * "永远没有"，正是首轮缺令牌的老问题。
   */
  async function fetchContext(sessionId) {
    const url = `${bridgeUrl}/api/socialV2/agent-context?sessionId=${encodeURIComponent(sessionId)}`;
    try {
      const token = await consoleToken();
      const res = await fetch(url, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      // 404 是桥接的明确回答：「这个 session 不是 QQ 会话」（见 bridge.js 的 agent-context 路由）。
      if (res.status === 404 || res.status === 403) return { kind: 'miss' };
      if (!res.ok) return { kind: 'error' };
      const data = await res.json();
      if (!data?.ok || typeof data.text !== 'string') return { kind: 'miss' };
      return { kind: 'ok', text: data.text, key: data.key };
    } catch {
      // 桥接没启动 / 超时。
      return { kind: 'error' };
    }
  }

  /** 拉一次并写缓存；并发调用共享同一个 promise。 */
  function load(agent) {
    const sid = String(agent.id);
    const pending = loading.get(sid);
    if (pending) return pending;
    const task = (async () => {
      const res = await fetchContext(sid);
      const now = Date.now();
      const prev = cache.get(sid);
      if (res.kind === 'ok') {
        cache.set(sid, { text: res.text, key: res.key, at: now, freshMs: REFRESH_MS });
        return true;
      }
      if (res.kind === 'miss') {
        // 连续 miss 指数退避（30s → 60s → 120s 封顶）。
        // 原因：GUI 会话/子 agent 每步都要装配，固定 30s 冷却时它们会一直重打 404
        // （实测 30 秒一条，全是 key=(未匹配到)）。真正晚到的 QQ 映射最多也只多等 2 分钟，
        // 而那 2 分钟里装配路径每次都会重新判断，不会漏掉。
        const misses = (prev?.misses ?? 0) + 1;
        cache.set(sid, {
          text: '',
          key: '',
          at: now,
          misses,
          freshMs: Math.min(MISS_RETRY_MS * 2 ** (misses - 1), REFRESH_MS)
        });
        return false;
      }
      // error：保留旧内容（宁可旧，不要空），只把重试时间提前。
      cache.set(sid, {
        text: prev?.text ?? '',
        key: prev?.key ?? '',
        at: now,
        freshMs: ERROR_RETRY_MS
      });
      return false;
    })().finally(() => { loading.delete(sid); });
    loading.set(sid, task);
    return task;
  }

  /**
   * 确保缓存是新鲜的：新鲜就直接给文本，否则等一次请求。
   * 装配路径上唯一的 await 点，返回当前能用的文本（可能为空）。
   */
  async function ensureFresh(agent) {
    const sid = String(agent.id);
    const entry = cache.get(sid);
    if (entry && Date.now() - entry.at < (entry.freshMs ?? REFRESH_MS)) return entry.text;
    await load(agent);
    return textOf(agent);
  }

  function install(agent) {
    const sid = String(agent.id);
    if (fibers.has(sid)) return fibers.get(sid);
    // 注册在 agent 自己的作用域里：只对这个会话的系统提示词生效。
    // 一律注册（不再"拿到数据才装"）：段永远在，内容由缓存决定，
    // 这样第一轮装配时它一定存在，只等我们把文本填进去。
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: SECTION_NAME,
        // persona 之后（0）、工具说明之前（1000）：模型先建立"我是谁"，再读工具。
        order: 100,
        // 内容是纯文本，不做 {{变量}} 插值（令牌里可能有花括号之类）。
        interpolate: false,
        text: () => textOf(agent)
      });
      // 装配时兜底刷新（可 await）。这是首轮能拿到令牌的关键：
      // 首次装配一定发生在 prompt 投递之后，此时桥接已经写好 sessionId → key 的映射。
      scope.on('system-prompt/assemble', async (_assembly, context, next) => {
        if (context?.agent !== undefined && context.agent !== agent) return next();
        // 冷缓存才等；热缓存在这里零开销。
        const text = await ensureFresh(agent);
        const result = await next();
        if (!text) return result;
        // 段文本在 waterfall 之前就已渲染（system-prompt 的 assemble 先算 sections），
        // 所以必须在这里覆盖，否则拿到的是装配开始那一刻的旧值。
        const sections = Array.isArray(result?.sections) ? result.sections : [];
        const mine = sections.find((s) => s && s.name === SECTION_NAME);
        if (mine) {
          mine.text = text;
          mine.interpolate = false;
        } else {
          // 理论上不会走到（段是无条件注册的）；走到也只是兜底，别让内容丢掉。
          sections.push({ name: SECTION_NAME, text, interpolate: false });
        }
        return result;
      });
    });
    fibers.set(sid, fiber);
    return fiber;
  }

  function uninstall(agent) {
    const sid = String(agent.id);
    const fiber = fibers.get(sid);
    fibers.delete(sid);
    cache.delete(sid);
    // fiber.dispose() 同时撤掉提示词段与 assemble 监听（两者都由这个 fiber 拥有）。
    if (fiber) Promise.resolve(fiber.dispose()).catch(() => {});
  }

  ctx.on('agent/created', ({ agent }) => {
    // 不在这里 await 请求：那一刻桥接还没写 sessions.json（见文件头），问了也是白问，
    // 反而拖慢会话创建。数据交给首次装配补。
    install(agent);
  });

  ctx.on('agent/disposed', ({ agent }) => uninstall(agent));

  // 插件热重载/后加载时，已经在跑的会话也要补上。
  for (const agent of ctx.agents.list()) install(agent);

  // 定时刷新：令牌轮换、表情库变化、长期记忆每天整理，都靠它带进下一轮。
  //
  // ⚠️ 只刷「已经确认是 QQ 会话」的那些（缓存里有 key）。定时器**不负责识别**：
  // 识别由装配路径完成（那时桥接一定已登记）。否则这台机器上每个 GUI 会话、
  // 每个子 agent 会话每 2 分钟都会白打一次 404 —— 实测插件重载后一轮就刷出 13 条
  // "key=(未匹配到)"，正是这份日志噪音让最初的排查方向跑偏到"插件没来请求"。
  const timer = setInterval(() => {
    for (const agent of ctx.agents.list()) {
      if (cache.get(String(agent.id))?.key) void load(agent);
    }
  }, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();

  ctx.effect(() => () => {
    clearInterval(timer);
    for (const agent of ctx.agents.list()) uninstall(agent);
  }, 'qq-agent-context: timers and per-agent sections');
}
