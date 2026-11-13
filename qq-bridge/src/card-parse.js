// QQ 分享卡片（json 段）解析 —— 把「[卡片消息]」变成一行可读摘要。
//
// 为什么在桥接侧做，而不是给她一个独立工具：
//   1. **省 token**。每个注册的工具，其描述 + 参数 schema 都会随 system prompt 在
//      **每一次**请求里重发（本仓库实测 44 个工具约 9,974 token/轮）。加一个工具是
//      「每轮都付费」，而在卡片进消息流时内联一行摘要只是「这条消息多 40 个字符」。
//      她一年看到几百张卡片，工具却要陪她走几十万轮。
//   2. **省一次往返**。有工具就得「先看到卡片 → 决定要不要点 → 调工具 → 等结果 →
//      再回话」，至少多一步模型推理（一步就是几千 token 的上下文重算）。内联则是
//      卡片一到，摘要已经在正文里了。
//   3. 她本来就不需要「操作」B站，只需要「知道这个视频是什么」。
//
// 安全边界（和 web_fetch 同一套）：
//   · 所有出网请求走 safe-fetch.js（禁内网/环回/DNS rebinding，手动跟随重定向）；
//   · 只打 bilibili 官方只读 API，不抓 HTML、不带任何本机凭据、不带 cookie；
//   · 解析失败一律**静默降级**成原来的「[卡片消息]」，绝不因为网络问题耽误消息投递。
//
// 注入边界：
//   视频标题、UP 主名字、简介都是**外网可控文本**，会逐字进入她的上下文，和群友消息
//   同权。所以进摘要前必须清洗：控制字符、换行、方括号一律压掉 —— 否则一个标题就能
//   伪造出 `【令牌】`、`[图片]`、`[转发消息 id=...]` 这类桥接自己的结构标记。
import { safeFetch } from './safe-fetch.js';

/** 解析配置。除 timeoutMs 外都只是「省不省」的取舍，不是安全边界。 */
const CARD_DEFAULTS = Object.freeze({
  // 总开关。关掉后行为与上游完全一致（卡片一律显示「[卡片消息]」）。
  enabled: true,
  // 只展开 B站卡片。非 B站的卡片保持「[卡片消息]」——给所有卡片都抽标题是纯加字，
  // 而绝大多数卡片（小程序、投票、抽奖）看一眼标题也没用。
  bili: true,
  // 单张卡片的**总**预算（短链解析 + 元数据接口）。超时即降级。
  // 实测：b23.tv 跟随重定向约 400ms、视频接口约 50ms，正常一张卡片 0.5 秒以内。
  timeoutMs: 2500,
  // 同一个视频在多久内不重复请求（群里几个人转同一个视频是常态）。
  cacheTtlMs: 30 * 60 * 1000,
  cacheMax: 200,
  // 摘要各字段的字数上限。标题 40 字足够认出是哪个视频，再长就是白烧。
  titleMaxChars: 40,
  upMaxChars: 14,
  // 播放量/弹幕数。8 个字符换来「这个词儿值不值得接」的判断依据，划算。
  includeStats: true,
  // 简介默认**不要**：B站简介十有八九是空的或一串话题标签，纯噪声。
  includeDesc: false,
  descMaxChars: 60,
});

let options = { ...CARD_DEFAULTS };

/** 由 bridge 在读到 config.json 之后调用；非法值一律回落到默认，不让配置成为故障源。 */
export function setCardConfig(partial) {
  const src = partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  options = {
    enabled: src.enabled !== false,
    bili: src.bili !== false,
    timeoutMs: num(src.timeoutMs, CARD_DEFAULTS.timeoutMs, 300, 10000),
    cacheTtlMs: num(src.cacheTtlMs, CARD_DEFAULTS.cacheTtlMs, 0, 24 * 60 * 60 * 1000),
    cacheMax: num(src.cacheMax, CARD_DEFAULTS.cacheMax, 1, 2000),
    titleMaxChars: num(src.titleMaxChars, CARD_DEFAULTS.titleMaxChars, 4, 120),
    upMaxChars: num(src.upMaxChars, CARD_DEFAULTS.upMaxChars, 2, 40),
    includeStats: src.includeStats !== false,
    includeDesc: src.includeDesc === true,
    descMaxChars: num(src.descMaxChars, CARD_DEFAULTS.descMaxChars, 0, 300),
  };
  return { ...options };
}

export function getCardConfig() {
  return { ...options };
}

/** 仅供测试/排障：清掉所有缓存。 */
export function clearCardCache() {
  cardMemo.clear();
  biliCache.clear();
}

// ── 缓存 ────────────────────────────────────────────────────────────────────
//
// 两层，因为两个维度的重复是独立的：
//   · cardMemo：**同一段卡片 JSON** → 摘要。segmentsToText 对同一条消息会被调用两次
//     （带引用版 / 不带引用版），没有这层就是每条卡片都解析两遍。
//   · biliCache：**同一个视频** → 元数据。群里三小时前有人转过、现在又有人转，第二层
//     命中就能省掉一次完整解析；短链也好、BV 长链也好，最后都归一到同一个 key。
const cardMemo = new Map();   // rawCardJson → Promise<string>
const biliCache = new Map();  // biliKey    → { at, value }

function cacheGet(map, key, ttlMs) {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    map.delete(key);
    return undefined;
  }
  // Map 保持插入序：命中就挪到队尾，实现「最近用过的留得住」。
  map.delete(key);
  map.set(key, hit);
  return hit.value;
}

function cacheSet(map, key, value, max) {
  map.set(key, { at: Date.now(), value });
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// ── 文本清洗 ────────────────────────────────────────────────────────────────

/**
 * 外网/群友可控文本 → 可以安全拼进单行摘要的片段。
 *
 * 压掉的东西及其理由：
 *   · 控制字符、换行、U+2028/2029 —— 换个行就能伪造出「新段落」或桥接的提示结构；
 *   · `[` `]` `【` `】` —— 桥接用方括号标注 `[图片]` `[转发消息 id=…]`、用【】分段，
 *     标题里带这些字符就能冒充系统标记；全角括号一并清掉，免得半角被过滤后仍能凑出。
 *   · `CQ:` 片段 —— 部分网关会把 CQ 码原样塞进字段。
 */
export function sanitizeCardText(value, maxChars) {
  const s = String(value ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/[[\]【】]/g, ' ')
    .replace(/CQ:/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!Number.isFinite(Number(maxChars)) || Number(maxChars) <= 0) return s;
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

// ── 卡片 JSON 解析 ──────────────────────────────────────────────────────────

/** 递归收集 JSON 里所有字符串值。卡片结构在不同分享来源下差别很大，逐个字段认不可靠。 */
function collectStrings(node, out, depth = 0) {
  if (depth > 6 || node == null) return out;
  if (typeof node === 'string') {
    if (node.length && node.length <= 4000) out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 40)) collectStrings(item, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node)) collectStrings(value, out, depth + 1);
  }
  return out;
}

const BILI_SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn', 'bili22.cn', 'bili33.cn', 'bili23.cn']);
const BILI_HOST_SUFFIX = /(^|\.)bilibili\.com$/i;

export function isBiliHost(host) {
  const h = String(host ?? '').toLowerCase();
  if (!h) return false;
  return BILI_SHORT_HOSTS.has(h) || BILI_HOST_SUFFIX.test(h);
}

/**
 * 从一张卡片里抽出「标题 / 简短描述 / 指向的链接」。
 *
 * 两种卡片形态都要认（实测群里都在用）：
 *   · 小程序卡片 `com.tencent.miniapp_01`：meta.detail_1，真实链接在 `qqdocurl`，
 *     同名字段还有 `url`（m.q.qq.com 的跳板，不是目标）；
 *   · 结构化分享 `com.tencent.structmsg`：meta.news，真实链接在 `jumpUrl`。
 * 所以不按字段名取值，而是「把所有字符串捞出来，找第一个 B站域名」——
 * 字段换名字不会让它失效，最多是抽不到标题。
 */
export function parseCardJson(rawJson) {
  let card;
  try {
    card = JSON.parse(String(rawJson ?? ''));
  } catch {
    return null;
  }
  if (!card || typeof card !== 'object') return null;

  const strings = collectStrings(card, []);
  let title = '';
  let desc = '';
  // 标题优先取 meta 里那一层（小程序与 structmsg 的 meta 值里都有 title/desc）。
  const metaKeys = card?.meta && typeof card.meta === 'object' ? Object.keys(card.meta) : [];
  for (const key of metaKeys) {
    const entry = card.meta[key];
    if (!entry || typeof entry !== 'object') continue;
    if (!title && typeof entry.title === 'string' && entry.title.trim()) title = entry.title;
    if (!desc && typeof entry.desc === 'string' && entry.desc.trim()) desc = entry.desc;
  }
  // 标题兜底：prompt 形如 `[QQ小程序]这是研学能看到的吗`，去掉前缀就是标题。
  if (!title && typeof card.prompt === 'string' && card.prompt.trim()) {
    title = card.prompt.replace(/^\[[^\]]{1,20}\]/, '').trim();
  }

  // 找链接：先找 B站域名，找不到再退回第一个 http(s) 完整链接。
  let biliUrl = '';
  let anyUrl = '';
  for (const s of strings) {
    const matches = String(s).match(/https?:\/\/[^\s"'<>]+/gi);
    if (!matches) continue;
    for (const raw of matches) {
      let parsed;
      try { parsed = new URL(raw); } catch { continue; }
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (!anyUrl) anyUrl = parsed.toString();
      if (!biliUrl && isBiliHost(parsed.hostname)) biliUrl = parsed.toString();
    }
    if (biliUrl) break;
  }
  // 没有 http(s) 前缀的裸域名（个别卡片只给 `b23.tv/xxx`）也兜一下。
  if (!biliUrl) {
    for (const s of strings) {
      const m = String(s).match(/\b((?:b23\.tv|bilibili\.com)\/[^\s"'<>]+)/i);
      if (m) {
        try { biliUrl = new URL(`https://${m[1]}`).toString(); } catch { /* 忽略 */ }
        if (biliUrl) break;
      }
    }
  }

  return {
    app: typeof card.app === 'string' ? card.app : '',
    title: String(title ?? '').trim(),
    desc: String(desc ?? '').trim(),
    biliUrl,
    anyUrl,
  };
}

// ── B站链接归类 ─────────────────────────────────────────────────────────────

/**
 * URL → { kind, key, api }。
 *
 * key 是「同一个视频」的规范标识，两层缓存都按它归并：短链 `b23.tv/xxx` 与长链
 * `/video/BV1xx` 都落到 `video:BV1xx`，所以同一视频无论从哪条链接进来都只解析一次。
 */
export function classifyBiliUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  // 短链：必须先跟随重定向才知道是什么。
  if (BILI_SHORT_HOSTS.has(host)) {
    return { kind: 'short', key: `short:${url.toString()}`, url: url.toString() };
  }
  if (!BILI_HOST_SUFFIX.test(host)) return null;

  // 直播（独立子域 live.bilibili.com/房间号）
  if (host === 'live.bilibili.com') {
    const m = /^\/(\d{1,12})\/?$/.exec(path);
    if (m) return { kind: 'live', key: `live:${m[1]}`, roomId: m[1] };
    return { kind: 'other', key: `other:${url.toString()}` };
  }

  // 视频：/video/BVxxx 或 /video/av12345（可能带 /?p=2）
  const bv = /\/video\/(BV[0-9A-Za-z]{8,12})/i.exec(path);
  if (bv) {
    const id = bv[1];
    const page = Number(url.searchParams.get('p') || 1);
    return {
      kind: 'video',
      key: `video:${id.toUpperCase()}${Number.isSafeInteger(page) && page > 1 ? `:p${page}` : ''}`,
      bvid: id,
      page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    };
  }
  const av = /\/video\/av(\d{1,18})/i.exec(path);
  if (av) return { kind: 'video', key: `video:av${av[1]}`, aid: av[1] };

  // 番剧/影视：/bangumi/play/ep123 或 /bangumi/play/ss123
  const ep = /\/bangumi\/play\/ep(\d{1,12})/i.exec(path);
  if (ep) return { kind: 'bangumi', key: `bangumi:ep${ep[1]}`, epId: ep[1] };
  const ss = /\/bangumi\/play\/ss(\d{1,12})/i.exec(path);
  if (ss) return { kind: 'bangumi', key: `bangumi:ss${ss[1]}`, seasonId: ss[1] };

  // 动态、专栏、空间等：只认这是 B站的内容，不调接口（收益太低、接口也不稳）。
  return { kind: 'other', key: `other:${host}${path}` };
}

// ── 数值/时长格式化 ─────────────────────────────────────────────────────────

export function formatDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatCount(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(Math.round(value));
}

/** 把若干片段拼成 `[标签] a · b · c`，空片段自动跳过（不能留下 `· ·`）。 */
export function buildCardLine(label, parts) {
  const body = (Array.isArray(parts) ? parts : [])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(' · ');
  if (!body) return '';
  return `[${label}] ${body}`;
}

// ── 出网（受 safe-fetch 约束）───────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`卡片解析超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, budgetMs) {
  // 只读前若干字符的 JSON：band 接口正常 < 20KB，给 200KB 上限只是防「异常大的响应」。
  const res = await withTimeout(safeFetch(url, 200_000), budgetMs, url);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
  const body = JSON.parse(res.body);
  return body;
}

async function resolveShortLink(url, budgetMs) {
  // 只读到 64 个字符就停：目标页 45KB 的 HTML 对这里毫无用处，早停既快又省流量。
  const res = await withTimeout(safeFetch(url, 64), budgetMs, url);
  return res.url;
}

function fmtVideoLine(meta, opts) {
  const parts = [];
  const title = sanitizeCardText(meta.title, opts.titleMaxChars);
  if (title) parts.push(title);
  const up = sanitizeCardText(meta.up, opts.upMaxChars);
  if (up) parts.push(`UP ${up}`);
  const duration = formatDuration(meta.duration);
  if (duration) parts.push(duration);
  if (opts.includeStats) {
    const views = formatCount(meta.view);
    if (views) parts.push(`${views}播放`);
  }
  if (opts.includeDesc && opts.descMaxChars > 0) {
    const desc = sanitizeCardText(meta.desc, opts.descMaxChars);
    // 简介是视频标题/UP 名的复读机时不要再占一遍字。
    if (desc && !title.includes(desc) && !desc.includes(title)) parts.push(desc);
  }
  if (meta.bvid) parts.push(meta.bvid);
  return buildCardLine('B站', parts);
}

async function fetchVideoMeta(ref, budgetMs) {
  const query = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(ref.aid)}`;
  const body = await fetchJson(`https://api.bilibili.com/x/web-interface/view?${query}`, budgetMs);
  if (Number(body?.code) !== 0 || !body?.data) return null;
  const d = body.data;
  const page = Number(ref.page) > 0 ? ref.page : 1;
  const pageInfo = Array.isArray(d.pages) ? d.pages.find((p) => Number(p?.page) === page) : null;
  return {
    title: d.title || '',
    up: d?.owner?.name || '',
    duration: Number(pageInfo?.duration ?? d.duration) || 0,
    view: Number(d?.stat?.view) || 0,
    desc: d.desc || '',
    bvid: d.bvid || ref.bvid || '',
  };
}

async function fetchBangumiMeta(ref, budgetMs) {
  const query = ref.epId ? `ep_id=${encodeURIComponent(ref.epId)}` : `season_id=${encodeURIComponent(ref.seasonId)}`;
  const body = await fetchJson(`https://api.bilibili.com/pgc/view/web/season?${query}`, budgetMs);
  const result = body?.result ?? body?.data;
  if (Number(body?.code) !== 0 || !result) return null;
  const episodes = Array.isArray(result.episodes) ? result.episodes : [];
  const ep = ref.epId ? episodes.find((e) => String(e?.id) === String(ref.epId)) : null;
  return {
    title: ep?.long_title ? `${result.title || ''} ${ep.long_title}`.trim() : (result.title || ''),
    up: '',
    duration: 0,
    view: 0,
    desc: result.evaluate || '',
  };
}

async function fetchLiveMeta(ref, budgetMs) {
  const body = await fetchJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(ref.roomId)}`, budgetMs);
  if (Number(body?.code) !== 0 || !body?.data) return null;
  const d = body.data;
  return {
    title: d.title || '',
    up: d.uname || '',
    duration: 0,
    view: Number(d.online) || 0,
    desc: d.description || '',
  };
}

/**
 * 解析一张卡片，产出可以直接进消息流的一行摘要。
 *
 * 返回 `''` 表示「这张卡片不归我展开」——调用方据此回退成原来的 `[卡片消息]`。
 * **本函数永不抛异常**：卡片解析是锦上添花，任何失败都不该影响消息投递。
 */
export async function summarizeCard(rawJson) {
  const opts = options;
  if (!opts.enabled) return '';

  const memoKey = String(rawJson ?? '');
  const memoHit = cardMemo.get(memoKey);
  if (memoHit) return memoHit;

  const task = (async () => {
    try {
      const card = parseCardJson(memoKey);
      if (!card) return '';
      if (!opts.bili) return '';
      if (!card.biliUrl) return '';
      const ref = classifyBiliUrl(card.biliUrl);
      if (!ref) return '';

      const cached = cacheGet(biliCache, ref.key, opts.cacheTtlMs);
      if (cached !== undefined) return cached;

      const deadline = Date.now() + opts.timeoutMs;
      const remaining = () => Math.max(200, deadline - Date.now());

      // 短链先解析成真实链接，再重新归类；解不出来就只剩卡片自带的标题可用。
      let real = ref;
      if (ref.kind === 'short') {
        let finalUrl = '';
        try { finalUrl = await resolveShortLink(ref.url, remaining()); } catch { finalUrl = ''; }
        const again = finalUrl ? classifyBiliUrl(finalUrl) : null;
        if (again && again.kind !== 'short') real = again;
      }

      let line = '';
      if (real.kind === 'video') {
        const meta = await fetchVideoMeta(real, remaining()).catch(() => null);
        line = meta ? fmtVideoLine(meta, opts) : '';
      } else if (real.kind === 'bangumi') {
        const meta = await fetchBangumiMeta(real, remaining()).catch(() => null);
        line = meta ? fmtVideoLine(meta, opts) : '';
      } else if (real.kind === 'live') {
        const meta = await fetchLiveMeta(real, remaining()).catch(() => null);
        line = meta
          ? buildCardLine('B站 直播', [sanitizeCardText(meta.title, opts.titleMaxChars), sanitizeCardText(meta.up, opts.upMaxChars)])
          : '';
      }

      // 接口失败/未归类：退到卡片自带信息。标题是腾讯给的，不额外花钱，比「[卡片消息]」有用。
      if (!line) {
        const title = sanitizeCardText(card.title, opts.titleMaxChars);
        if (title) {
          const label = real.kind === 'bangumi' ? 'B站 番剧'
            : real.kind === 'live' ? 'B站 直播'
              : real.kind === 'video' ? 'B站 视频'
                : 'B站';
          line = buildCardLine(label, [title]);
        }
      }

      cacheSet(biliCache, ref.key, line, opts.cacheMax);
      return line;
    } catch {
      // 任何异常都当成「这张卡片不展开」，并缓存成空串避免反复失败重试。
      cacheSet(biliCache, `err:${memoKey.slice(0, 64)}`, '', opts.cacheMax);
      return '';
    }
  })();

  cardMemo.set(memoKey, task);
  while (cardMemo.size > opts.cacheMax) {
    const oldest = cardMemo.keys().next().value;
    if (oldest === undefined) break;
    cardMemo.delete(oldest);
  }
  return task;
}
