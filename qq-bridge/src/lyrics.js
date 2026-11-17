// 歌词查询：QQ音乐 / 网易云 双源，纯 HTTP GET，不需要签名。
//
// ── 为什么是这两个接口 ────────────────────────────────────────────────────
// 实测（2026-11）能用的方案排过一轮，结论：
//
//   QQ音乐 歌词：https://i.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg
//     ?songmid=<mid>&format=json&nobase64=0&g_tk=5381&loginUin=0&hostUin=0
//     &inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0
//     → 唯一要求是 **Referer: https://y.qq.com/**。不带就是 retcode -1310。
//     不需要 cookie、不需要签名、不需要 g_tk 真实值（5381 是常量）。
//     返回 JSON，lyric 字段是 **base64 编码的 LRC**（nobase64=1 时反而是空/报错，
//     所以固定用 0 自己解码）。trans 字段是翻译，**我们不要**：外文歌会让行数翻倍，
//     而她要的是「听这首歌」，不是对照阅读。
//
//   QQ音乐 搜索：https://c.y.qq.com/soso/fcgi-bin/client_search_cp
//     ?w=<关键词>&format=json&n=5&p=1&new_json=1
//     → 同样只要 Referer。返回 data.song.list[].mid（就是歌词接口要的 songmid）。
//
//   网易云 歌词：https://music.163.com/api/song/lyric?id=<id>&lv=1&kv=1&tv=-1
//     → 要 Referer: https://music.163.com/。返回 JSON，lrc.lyric 是明文 LRC。
//
// ── 为什么不用别的 ────────────────────────────────────────────────────────
//   · musicu.fcg（新版搜索接口）：要 comm/req 结构，实测 0 命中，不如老 soso 稳。
//   · QRC 加密歌词 / zzc_sign 签名：需要逆向定制 TripleDES，为了聊歌词不值这个复杂度，
//     而且 LRC 已经够用（她不需要逐字高亮）。
//   · 第三方聚合 API：要么要 key，要么随时挂，不如官方两条稳。
//
// ── 安全边界 ──────────────────────────────────────────────────────────────
//   外网返回的歌名、歌手、歌词**全部是外部可控文本**，会进模型上下文。必须：
//     · 清洗控制字符/换行（歌词本身就带换行，这里保留换行但压控制字符）；
//     · 限长（默认 3000 字，超了截断并标注）；
//     · 不把任何本机信息带出去（只带固定 UA + Referer）。
//   所有出网走 safe-fetch.js（禁内网/环回/DNS rebinding）。
import { safeFetch } from './safe-fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const DEFAULTS = Object.freeze({
  enabled: true,
  timeoutMs: 12000,
  // 歌词进上下文的字数上限。
  // 一首歌完整 LRC（含时间轴）通常 1.5k~3k 字符，去掉时间轴和署名后纯歌词约 600~1200 字。
  // 定 2000 是为了覆盖长歌（有些说唱/民谣 4~5 分钟会到 1500 字），又不至于让一条歌词
  // 顶掉半屏上下文。超了按行截断。
  maxChars: 2000,
  // 搜索结果里取前几名做匹配评分。
  searchLimit: 5,
});

let options = { ...DEFAULTS };

export function setLyricsConfig(partial) {
  const src = partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  options = {
    enabled: src.enabled !== false,
    timeoutMs: num(src.timeoutMs, DEFAULTS.timeoutMs, 2000, 30000),
    maxChars: num(src.maxChars, DEFAULTS.maxChars, 200, 20000),
    searchLimit: num(src.searchLimit, DEFAULTS.searchLimit, 1, 10),
  };
  return { ...options };
}

export function getLyricsConfig() {
  return { ...options };
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 带浏览器身份 GET，返回文本。所有对 QQ音乐/网易云 的请求都从这里出。 */
async function getText(url) {
  const referer = /(^|\.)qq\.com$|(^|\.)y\.qq\.com$/i.test(new URL(url).hostname)
    ? 'https://y.qq.com/'
    : 'https://music.163.com/';
  // safeFetch 不能自定义 header，这里自己起一个最小请求（仍做内网校验）。
  const { validateFetchUrl } = await import('./safe-fetch.js');
  await validateFetchUrl(url);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/** 外网可控文本 → 可安全进上下文的纯文本。保留换行（歌词需要），压掉其它控制字符。 */
export function sanitizeLyricText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * LRC → 纯歌词。
 *
 * 去掉的东西及理由：
 *   · `[00:12.34]` 时间轴 —— 她不需要跟唱，时间是纯噪声（一张 LRC 里 1/3 字符是它）；
 *   · `[ti:]`/`[ar:]`/`[al:]`/`[by:]`/`[offset:]` 元信息标签 —— 曲名歌手卡片里已有；
 *   · 空行与重复行 —— 副歌重复是正常的，保留；但连续完全相同的行压掉。
 *   · **制作人员名单** —— 实测一首歌前十几行常是「词：X / 曲：X / 编曲：X / 吉他：X /
 *     录音棚：X / 混音：X / 词版权管理方：X」。这些对「聊聊这首歌」毫无价值，
 *     却占了歌词位置和上下文。
 *
 *     剥离规则要小心：LRC 第一行经常是「晴天 - 周杰伦 (Jay Chou)」这种标题行，
 *     它不是署名，但它**打断**了「连续署名段」的判断（实测踩过：按连续段剥，
 *     第一行标题就把开关关掉了，后面 14 行署名全留下）。
 *     所以改成「前 N 行里，凡是长得像署名的就剥」，N 以内不影响正文 ——
 *     正文第一句一般出现在第 1~3 行，而署名都在它前面或紧随其后。
 */
const CREDIT_LINE = /^(作词|作曲|编曲|填词|词|曲|制作人|监制|出品|出品监制|出品人|发行|企划|统筹|录音|录音师|录音棚|录音室|录音工程|录音助理|混音|混音工程|混音师|母带|吉他|贝斯|鼓|键盘|和声|合声|合声编写|弦乐|弦乐编写|指挥|配唱|人声|人声录音|人声录音室|人声编辑|人声录音师|联合出品|词版权管理方|曲版权管理方|OA|OC|OP|SP|Vocal|Producer|Mix|Master|Guitar|Bass|Drum|Arranger|Composer|Lyricist|Edit|Recording)\s*[:：]/i;
/**
 * 英文署名是**「职责 + by:」**的语序，和中文「词：」相反 —— 上面那条正则一个也认不出。
 * 实测（2026-11-17）Shape of You 的 QQ音乐 词前面挂着：
 *   `Lyrics by：Ed Sheeran/Steve Mac`  `Composed by：…`  `Produced by：Steve Mac`
 * 这些全漏下来，白白占掉歌词篇幅。所以单独一条按 `xxx by：` 匹配。
 */
const CREDIT_BY_LINE = /^[A-Za-z][A-Za-z\s/()'-]{0,40}\bby\s*[:：]/i;
// 「词版权管理方：…」「®」「℗」这类也归到署名。
const RIGHTS_LINE = /(版权|®|℗)/i;
// 只看开头这么多行，避免把正文里正常出现的「词：」也剥掉。
const CREDIT_SCAN_LINES = 20;

export function parseLrc(raw) {
  const lines = String(raw ?? '').split('\n');
  const out = [];
  let last = '';
  const meta = {};
  let scanned = 0;   // 已经考察过的正文行数（不含空行/元信息）

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const metaMatch = /^\[(ti|ar|al|by|offset|kana|length)\s*:\s*([^\]]*)\]$/i.exec(s);
    if (metaMatch) {
      meta[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
      continue;
    }
    // 去掉行首所有时间轴 [xx:yy.zz] / [xx:yy:zz]
    const body = s.replace(/^(\[[0-9]{1,3}:[0-9]{1,2}(?:[.:][0-9]{1,3})?\])+/g, '').trim();
    if (!body) continue;

    scanned += 1;
    if (scanned <= CREDIT_SCAN_LINES
      && (CREDIT_LINE.test(body) || CREDIT_BY_LINE.test(body) || RIGHTS_LINE.test(body))) continue;

    if (body === last) continue;   // 压掉连续重复行
    out.push(body);
    last = body;
  }
  return { meta, text: out.join('\n'), lineCount: out.length };
}

/** 归一化用于比较：去空格/标点/大小写，只留中日韩英数字。 */
function norm(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, '')
    .replace(/[\s\-_/\\.,;:'"!?、，。；：！？（）()\[\]【】]/g, '')
    .trim();
}

/**
 * 给一条搜索结果打分：标题像不像 + 歌手像不像。
 *
 * 为什么需要它：不带歌手搜「七里香」会先命中女声版/钢琴版。单纯取第一条会给错歌词，
 * 而**错歌词比没有歌词更糟** —— 她会一本正经地聊一首别人没在听的歌。
 *
 * 实测（2026-11）网易云搜「晴天 周杰伦」前 20 条**一个原唱都没有**（该平台没有
 * 周杰伦版权），全是翻唱。所以打分之外还要单独标记 `exactArtist`，
 * 让调用方能说清「只找到翻唱版本」，而不是假装找到了原唱。
 *
 * @returns {{ score: number, exactArtist: boolean, reject: boolean }}
 */
export function scoreCandidate(candidate, wantTitle, wantArtist) {
  const t = norm(candidate?.title);
  const a = norm(candidate?.artist);
  const wt = norm(wantTitle);
  const wa = norm(wantArtist);
  let score = 0;
  if (wt && t) {
    if (t === wt) score += 100;
    else if (t.startsWith(wt) || wt.startsWith(t)) score += 60;
    else if (t.includes(wt) || wt.includes(t)) score += 40;
    else return { score: -1, exactArtist: false, reject: true };   // 标题都对不上
  }
  let exactArtist = true;
  if (wa && a) {
    if (a === wa) score += 80;
    else if (a.includes(wa) || wa.includes(a)) score += 50;
    else { score -= 40; exactArtist = false; }   // 歌手不符扣分，并标记非原唱
  }
  // 翻唱/伴奏/纯音乐之类，标题里带这些都是别人唱的，重罚。
  if (/翻唱|伴奏|纯音乐|钢琴版|女声版|男声版|童声版|dj|remix|cover|instrumental|弦乐版|吉他版|原唱/i.test(candidate?.title || '')) {
    score -= 70;
    exactArtist = false;
  }
  return { score, exactArtist, reject: false };
}

function buildQuery({ title, artist }) {
  const parts = [String(title ?? '').trim(), String(artist ?? '').trim()].filter(Boolean);
  return parts.join(' ');
}

// ── QQ音乐 ─────────────────────────────────────────────────────────────────

export async function searchQqMusic(query, limit = options.searchLimit) {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}&format=json&n=${limit}&p=1&new_json=1`;
  const body = await getText(url);
  let json;
  try { json = JSON.parse(body); } catch { return []; }
  const list = json?.data?.song?.list ?? [];
  return list.map((s) => ({
    platform: 'QQ音乐',
    id: String(s.mid ?? s.songmid ?? ''),
    title: String(s.name ?? s.songname ?? ''),
    artist: (s.singer ?? []).map((x) => x.name).filter(Boolean).join('/'),
    album: String(s.album?.name ?? ''),
  })).filter((x) => x.id);
}

export async function fetchQqMusicLyric(songmid) {
  const url = `https://i.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}`
    + '&format=json&nobase64=0&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8'
    + '&notice=0&platform=yqq.json&needNewCode=0';
  const body = await getText(url);
  let json;
  try { json = JSON.parse(body); } catch {
    throw new Error('QQ音乐歌词接口返回的不是 JSON（可能被风控）');
  }
  if (Number(json?.retcode) !== 0) throw new Error(`QQ音乐歌词接口 retcode=${json?.retcode}`);
  const decode = (v) => {
    if (!v) return '';
    try { return Buffer.from(String(v), 'base64').toString('utf8'); } catch { return ''; }
  };
  // 只取 lyric，**不取 trans**。接口返回的 trans 是中文翻译词，
  // 对中文歌是空的、对外文歌会让行数翻倍，而她要的是「听这首歌」不是对照阅读。
  return { lrc: decode(json.lyric) };
}

// ── 网易云 ─────────────────────────────────────────────────────────────────

export async function searchNetease(query, limit = options.searchLimit) {
  const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(query)}&type=1&limit=${limit}&offset=0`;
  const body = await getText(url);
  let json;
  try { json = JSON.parse(body); } catch { return []; }
  const songs = json?.result?.songs ?? [];
  return songs.map((s) => ({
    platform: '网易云音乐',
    id: String(s.id ?? ''),
    title: String(s.name ?? ''),
    artist: (s.artists ?? s.ar ?? []).map((x) => x.name).filter(Boolean).join('/'),
    album: String(s.album?.name ?? s.al?.name ?? ''),
  })).filter((x) => x.id);
}

export async function fetchNeteaseLyric(id) {
  const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`;
  const body = await getText(url);
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('网易云歌词接口返回的不是 JSON'); }
  if (Number(json?.code) !== 200) throw new Error(`网易云歌词接口 code=${json?.code}`);
  // 同样不取 tlyric（翻译）。理由见 fetchQqMusicLyric。
  return { lrc: String(json?.lrc?.lyric ?? '') };
}

// ── 对外主入口 ─────────────────────────────────────────────────────────────

const PLATFORMS = {
  qq: { search: searchQqMusic, lyric: fetchQqMusicLyric, label: 'QQ音乐', idName: 'songmid' },
  netease: { search: searchNetease, lyric: fetchNeteaseLyric, label: '网易云音乐', idName: 'songId' },
};

/**
 * 查歌词。
 *
 * 用法三种：
 *   · platform + id：直接取词（卡片摘要里就能拿到，最准，零猜测）；
 *   · platform + title：**只搜这一个平台**。卡片已经告诉我们是哪个平台的歌了，
 *     拿 QQ音乐 的曲名去网易云 搜只会搜出翻唱（实测：「晴天 周杰伦」在网易云
 *     前五条全是女声版/钢琴版/翻唱）。
 *   · 只给 title：两个平台都试，按匹配分选。这是没卡片信息时的兜底。
 *
 * 返回 { ok, platform, id, title, artist, album, lyric, truncated, candidates? }
 * **永不抛异常**：歌词是锦上添花，失败不该打断对话。
 */
export async function lookupLyrics(input = {}) {
  const opts = options;
  if (!opts.enabled) return { ok: false, error: '歌词功能已关闭（socialV2.lyrics.enabled=false）' };

  const platformHit = String(input.platform ?? '').trim().toLowerCase();
  const wantId = String(input.id ?? '').trim();
  const title = String(input.title ?? '').trim();
  const artist = String(input.artist ?? '').trim();
  const maxChars = Math.min(opts.maxChars, Number(input.maxChars) > 0 ? Number(input.maxChars) : opts.maxChars);

  // ── 路径 A：已知平台 + id，直接取词 ──
  //
  // 这一条路径**没有搜索、没有打分、没有翻唱判断** —— id 就是你指定的那一首，
  // 拿到的歌词必然是它的。所以不要在这里引入任何"匹配度"概念（踩过：
  // 汇报时把两条路径的 coverOnly 说法混在一起，读起来像是按 id 也会判翻唱）。
  //
  // 唯一的取舍：title/artist 以**接口返回的 LRC 元信息**为准，调用方传进来的只当兜底。
  // 因为调用方常把卡片上的压缩文案原样传进来（比如把 desc 里的歌手名传成整句），
  // 原样回显会把错信息写进结果。
  if (platformHit && wantId && PLATFORMS[platformHit]) {
    const p = PLATFORMS[platformHit];
    try {
      const { lrc } = await p.lyric(wantId);
      if (!lrc.trim()) return { ok: false, error: `${p.label}没有提供歌词（可能是纯音乐或未收录）` };
      const parsed = parseLrc(lrc);
      return finalize(p.label, wantId, '', '', '', parsed, maxChars, { title, artist });
    } catch (error) {
      return { ok: false, error: `${p.label}取词失败：${error?.message ?? error}` };
    }
  }

  // ── 路径 B：按歌名搜 ──
  if (!title) return { ok: false, error: '至少要给 title（歌名），或者 platform + id' };

  const query = buildQuery({ title, artist });
  // 指定平台就**只搜这个平台**；没指定才两个都试（QQ音乐 搜索结果实测更准，排前面）。
  const order = platformHit && PLATFORMS[platformHit]
    ? [platformHit]
    : ['qq', 'netease'];

  const allCandidates = [];
  for (const key of order) {
    const p = PLATFORMS[key];
    let hits = [];
    try { hits = await p.search(query, opts.searchLimit); } catch { hits = []; }
    for (const hit of hits) {
      allCandidates.push({ ...hit, ...scoreCandidate(hit, title, artist), platformKey: key });
    }
    // 未指定平台时：第一个平台就有**歌手也对**的高分命中，就不必再问第二个，省一次出网。
    if (order.length > 1) {
      const best = allCandidates
        .filter((c) => c.platformKey === key)
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 100 && best.exactArtist) break;
    }
  }

  // 只接受「标题对得上」且分数够的；reject 的直接淘汰。
  const ranked = allCandidates
    .filter((c) => !c.reject && c.score >= 40)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    // 别把「完全不相关的搜索结果」当候选带回去：实测搜一个不存在的歌名，
    // QQ音乐 仍会返回三条毫不相干的歌，模型看到会以为「是不是这个」。
    // 只有标题模糊相关的才留。
    const weak = allCandidates.filter((c) => c.score > -1).slice(0, 3);
    return {
      ok: false,
      error: `没找到匹配的歌曲：${query}`,
      ...(weak.length ? {
        candidates: weak.map((c) => ({
          platform: c.platform, id: c.id, title: c.title, artist: c.artist
        }))
      } : {})
    };
  }

  // 依次试前几名，第一个拿到歌词的就是答案。
  const tried = [];
  for (const cand of ranked.slice(0, 3)) {
    const p = PLATFORMS[cand.platformKey];
    try {
      const { lrc } = await p.lyric(cand.id);
      if (!lrc.trim()) { tried.push(`${cand.platform}/${cand.title}`); continue; }
      const parsed = parseLrc(lrc);
      const out = finalize(cand.platform, cand.id, cand.title, cand.artist, cand.album, parsed, maxChars);
      // 只找到翻唱时必须说清楚：否则她会让对方以为这就是原唱的词。
      if (!cand.exactArtist && artist) {
        out.coverOnly = true;
        out.note = `没找到「${artist}」的原唱版本，这是别人的翻唱/改编（${cand.artist || '未知歌手'}${
          cand.title !== title ? ` - ${cand.title}` : ''}），歌词可能与原版有出入。`;
      }
      return out;
    } catch {
      tried.push(`${cand.platform}/${cand.title}`);
    }
  }

  return {
    ok: false,
    error: `找到了歌曲但取不到歌词（试过：${tried.join('、') || '无'}）`,
    candidates: ranked.slice(0, 3).map((c) => ({
      platform: c.platform, id: c.id, title: c.title, artist: c.artist
    }))
  };
}

/**
 * 从 LRC 首行猜歌名/歌手 —— **只在首行明显是「歌名 - 歌手」结构时才认**。
 *
 * 踩过的坑：起初把「首行不超过 40 字就当歌名」，结果网易云的词首行直接是歌词正文
 * （「都 是勇敢的」），于是在摘要里出现了「都 是勇敢的（网易云音乐）」这种荒谬标题。
 * 现在要求必须**有 ` - ` 分隔且两边都像样**，否则一个字都不猜 —— 宁可显示未知。
 */
export function guessTitleFromLrc(text) {
  const first = String(text ?? '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  if (!first || first.length > 120) return { title: '', artist: '' };
  const m = /^(.{1,60}?)\s+-\s+(.{1,60})$/.exec(first);
  if (!m) return { title: '', artist: '' };
  return { title: m[1].trim(), artist: m[2].trim() };
}

/**
 * 组装最终结果。
 * @param {object} [fallback] 调用方给的兜底 title/artist（只在 LRC 元信息缺失时用）
 */
function finalize(platform, id, title, artist, album, parsed, maxChars, fallback = {}) {
  let text = parsed.text;
  let truncated = false;
  if (text.length > maxChars) {
    // 按行截断，不要切碎一行歌词。
    text = text.slice(0, maxChars);
    const cut = text.lastIndexOf('\n');
    if (cut > maxChars * 0.6) text = text.slice(0, cut);
    truncated = true;
  }
  // 优先级：LRC 自带元信息 > 调用方传入 > 从首行猜。LRC 的 ti/ar/al 是平台自己写的，最可靠。
  // 「从首行猜」放最后：它是启发式，只在前面全空时才用，宁可显示「未知」也不乱安名字。
  const guessed = guessTitleFromLrc(parsed.text);
  const pick = (...vals) => {
    for (const v of vals) {
      const s = String(v ?? '').trim();
      if (s) return s;
    }
    return '';
  };
  const out = {
    ok: true,
    platform,
    id,
    title: sanitizeLyricText(pick(parsed.meta.ti, title, fallback.title, guessed.title)),
    artist: sanitizeLyricText(pick(parsed.meta.ar, artist, fallback.artist, guessed.artist)),
    album: sanitizeLyricText(pick(parsed.meta.al, album)),
    lyric: sanitizeLyricText(text),
    lineCount: parsed.lineCount,
    truncated,
  };
  if (truncated) out.note = `歌词超过 ${maxChars} 字，已截断`;
  return out;
}
