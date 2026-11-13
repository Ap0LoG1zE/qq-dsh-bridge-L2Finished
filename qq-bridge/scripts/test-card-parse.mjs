// B站分享卡片解析自检（离线优先，不依赖网络是否通）。
//
// 覆盖：
//   1. parseCardJson 从小程序卡片 / 结构化分享里抽标题、链接
//   2. classifyBiliUrl 把短链/长链/番剧/直播归到稳定的 key
//   3. sanitizeCardText 把外网可控文本压成单行（防伪造桥接标记）
//   4. formatDuration / formatCount 的边界
//   5. summarizeCard 的降级链（开关关掉、非 B站、接口失败都要回到空串）
//   6. 真实网络（可选）：用一张真实卡片跑通端到端，失败只告警不算红
//
// 运行：node scripts/test-card-parse.mjs
import {
  parseCardJson,
  classifyBiliUrl,
  sanitizeCardText,
  formatDuration,
  formatCount,
  buildCardLine,
  summarizeCard,
  setCardConfig,
  clearCardCache,
  isBiliHost,
} from '../src/card-parse.js';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 实测抓到的真实小程序卡片（2026-11，群 group:20001）
const MINIAPP_CARD = JSON.stringify({
  ver: '1.0.0.19',
  prompt: '[QQ小程序]这是研学能看到的吗',
  config: { type: 'normal', width: 0, height: 0, forward: 1, autoSize: 0, ctime: 1794373232, token: '9832a2658feeddf9610f87ec6995a5fc' },
  needShareCallBack: false,
  app: 'com.tencent.miniapp_01',
  view: 'view_8C8E89B49BE609866298ADDFF2DBABA4',
  meta: {
    detail_1: {
      appid: '1109937557',
      appType: 0,
      title: '哔哩哔哩',
      desc: '这是研学能看到的吗',
      icon: 'http://miniapp.gtimg.cn/public/appicon/432b76be3a548fc128acaa6c1ec90131_200.jpg',
      preview: 'https://qq.ugcimg.cn/v1/90l2fj452ueusetgle7i3le8fobkrjc2uhnd1s8rj6a0csh2122fgr58ui9j8kqnirpa43mnlgojvq1dt525urkgosmd45vamu04s4h09avqmsq3lagpstclmma6206m/e9vf2tsqr6j29hl2kodb3vahlc',
      url: 'm.q.qq.com/a/s/df7d5a5c5bdf23618a7b06c04004e4ad',
      scene: 1036,
      host: { uin: 3554451149, nick: '玫玖璃真没救力' },
      shareTemplateId: '8C8E89B49BE609866298ADDFF2DBABA4',
      shareTemplateData: {},
      qqdocurl: 'https://b23.tv/hUW6qRa?share_medium=android&share_source=qq&bbid=XUED2EEE041FF5A9BD1F33504D821E1ED155C&ts=1794373230826',
      showLittleTail: '',
      gamePoints: '',
      gamePointsUrl: '',
      shareOrigin: 0,
    },
  },
});

// 结构化分享（structmsg）：真实链接在 jumpUrl，没有 qqdocurl
const STRUCT_CARD = JSON.stringify({
  app: 'com.tencent.structmsg',
  meta: {
    news: {
      appid: 100951776,
      desc: '【测试】这么近那么美',
      jumpUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
      preview: 'https://i0.hdslb.com/bfs/archive/abc.jpg',
      title: '某UP主又整活了',
      tag: '哔哩哔哩',
    },
  },
});

// ── 1. parseCardJson ────────────────────────────────────────────────────────
const mini = parseCardJson(MINIAPP_CARD);
check('小程序卡片：抽到 meta 标题', mini?.title === '哔哩哔哩', mini?.title);
check('小程序卡片：抽到真实目标链接（qqdocurl 而非 m.q.qq.com）', /^https:\/\/b23\.tv\/hUW6qRa/.test(mini?.biliUrl || ''), mini?.biliUrl);

const struct = parseCardJson(STRUCT_CARD);
check('结构化分享：抽到标题', struct?.title === '某UP主又整活了', struct?.title);
check('结构化分享：从 jumpUrl 抽到 B站长链', struct?.biliUrl?.includes('BV1xx411c7mD'), struct?.biliUrl);

check('非 JSON 输入返回 null', parseCardJson('not json') === null && parseCardJson('') === null && parseCardJson(null) === null);
check('没有链接的卡片 biliUrl 为空', parseCardJson(JSON.stringify({ meta: { detail_1: { title: 'x' } } }))?.biliUrl === '');
check('prompt 兜底标题（去掉 [QQ小程序] 前缀）', parseCardJson(JSON.stringify({ prompt: '[QQ小程序]标题在这' }))?.title === '标题在这');
check('裸域名也能兜出链接', /b23\.tv\/abc/.test(parseCardJson(JSON.stringify({ meta: { detail_1: { qqdocurl: 'b23.tv/abc' } } }))?.biliUrl || ''));

// ── 2. classifyBiliUrl ─────────────────────────────────────────────────────
check('短链归类为 short', classifyBiliUrl('https://b23.tv/hUW6qRa')?.kind === 'short');
check('BV 长链归类为 video', classifyBiliUrl('https://www.bilibili.com/video/BV1Mf4i6XEM8')?.kind === 'video');
check('BV 长链 key 归一到 BV 号', classifyBiliUrl('https://www.bilibili.com/video/BV1Mf4i6XEM8?share_source=qq')?.key === 'video:BV1MF4I6XEM8');
check('BV 多P 的 key 带 p 后缀', classifyBiliUrl('https://www.bilibili.com/video/BV1Mf4i6XEM8?p=3')?.key === 'video:BV1MF4I6XEM8:p3');
check('av 号归类为 video', classifyBiliUrl('https://www.bilibili.com/video/av12345')?.key === 'video:av12345');
check('番剧 ep 归类', classifyBiliUrl('https://www.bilibili.com/bangumi/play/ep123456')?.kind === 'bangumi');
check('番剧 ss 归类', classifyBiliUrl('https://www.bilibili.com/bangumi/play/ss98765')?.kind === 'bangumi');
check('直播间归类', classifyBiliUrl('https://live.bilibili.com/6')?.key === 'live:6');
check('非 B站 域名返回 null', classifyBiliUrl('https://example.com/video/BV1xx') === null);
check('非 http(s) 返回 null', classifyBiliUrl('ftp://b23.tv/x') === null && classifyBiliUrl('javascript:alert(1)') === null);
check('isBiliHost 认子域不认伪装域', isBiliHost('www.bilibili.com') && isBiliHost('b23.tv') && !isBiliHost('bilibili.com.evil.cn') && !isBiliHost('evilbilibili.com'));

// ── 3. sanitizeCardText ───────────────────────────────────────────────────
check('清洗掉换行/控制字符', sanitizeCardText('a\nb\u0000c') === 'a b c');
check('清洗掉方括号（防伪造 [图片] 标记）', sanitizeCardText('标题[图片]尾巴') === '标题 图片 尾巴');
check('清洗掉全角方括号（防伪造 【令牌】）', sanitizeCardText('【令牌】x') === '令牌 x');
check('清洗掉 CQ 码', sanitizeCardText('a[CQ:at,qq=1]b') === 'a b');
check('超长截断带省略号', sanitizeCardText('x'.repeat(50), 10) === 'x'.repeat(10) + '…');
check('不超长时不加省略号', sanitizeCardText('短标题', 20) === '短标题');

// ── 4. formatDuration / formatCount ───────────────────────────────────────
check('时长 <1h 用 m:ss', formatDuration(54) === '0:54');
check('时长 ≥1h 用 h:mm:ss', formatDuration(3725) === '1:02:05');
check('时长非法返回空串', formatDuration(0) === '' && formatDuration(NaN) === '' && formatDuration(-5) === '');
check('播放量用万', formatCount(513280) === '51.3万');
check('播放量用亿', formatCount(123_456_789) === '1.2亿');
check('播放量千以下原样', formatCount(999) === '999');
check('播放量尾零不显示 .0', formatCount(20_000) === '2万');

// ── 5. buildCardLine ──────────────────────────────────────────────────────
check('空片段自动跳过不产生 `· ·`', buildCardLine('B站', ['标题', '', null, 'UP 甲']) === '[B站] 标题 · UP 甲');
check('全空返回空串', buildCardLine('B站', ['', null]) === '');

// ── 6. summarizeCard 降级链 ───────────────────────────────────────────────
clearCardCache();
setCardConfig({ enabled: false });
check('总开关关掉时返回空串（回到 [卡片消息]）', await summarizeCard(MINIAPP_CARD) === '');

clearCardCache();
setCardConfig({ enabled: true, bili: false });
check('bili 子开关关掉时返回空串', await summarizeCard(MINIAPP_CARD) === '');

clearCardCache();
setCardConfig({});
check('非 B站卡片返回空串', await summarizeCard(JSON.stringify({ app: 'x', meta: { detail_1: { title: 't', qqdocurl: 'https://example.com/a' } } })) === '');
check('坏 JSON 返回空串且不抛', await summarizeCard('{oops') === '');

// 指向不可达的短链：必须超时降级而不是抛异常/挂住
clearCardCache();
setCardConfig({ timeoutMs: 400 });
const t0 = Date.now();
const failedLine = await summarizeCard(MINIAPP_CARD);
const elapsed = Date.now() - t0;
check('短链解析失败时降级为卡片自带标题', failedLine === '' || failedLine.startsWith('[B站'), JSON.stringify(failedLine));
check('降级不会无限等待（<3s）', elapsed < 3000, `${elapsed}ms`);
setCardConfig({});

// ── 7. 真实网络端到端（可选）──────────────────────────────────────────────
clearCardCache();
setCardConfig({});
const line = await summarizeCard(MINIAPP_CARD);
if (line.startsWith('[B站]') && line.includes('BV1Mf4i6XEM8')) {
  console.log(`ℹ️ 真实网络端到端：${line}`);
} else {
  console.log(`⚠️ 真实网络端到端未通（可能是离线/接口限流），返回：${JSON.stringify(line)}`);
}
// 同一个视频第二次必须命中缓存（不再出网，返回一致）
const again = await summarizeCard(MINIAPP_CARD);
check('同一张卡片二次调用命中缓存且结果一致', again === line);

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
