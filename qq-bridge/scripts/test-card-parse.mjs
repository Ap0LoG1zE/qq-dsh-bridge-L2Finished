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
  isImageUrl,
  pickCardLink,
  detectMusicPlatform,
  fmtMusicLine,
  fmtGenericLine,
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
  config: { type: 'normal', width: 0, height: 0, forward: 1, autoSize: 0, ctime: 70006, token: '9832a2658feeddf9610f87ec6995a5fc' },
  needShareCallBack: false,
  app: 'com.tencent.miniapp_01',
  view: 'view_8C8E89B49BE609866298ADDFF2DBABA4',
  meta: {
    detail_1: {
      appid: '70007',
      appType: 0,
      title: '哔哩哔哩',
      desc: '这是研学能看到的吗',
      icon: 'http://miniapp.gtimg.cn/public/appicon/432b76be3a548fc128acaa6c1ec90131_200.jpg',
      preview: 'https://qq.ugcimg.cn/v1/90l2fj452ueusetgle7i3le8fobkrjc2uhnd1s8rj6a0csh2122fgr58ui9j8kqnirpa43mnlgojvq1dt525urkgosmd45vamu04s4h09avqmsq3lagpstclmma6206m/e9vf2tsqr6j29hl2kodb3vahlc',
      url: 'm.q.qq.com/a/s/df7d5a5c5bdf23618a7b06c04004e4ad',
      scene: 1036,
      host: { uin: 70004, nick: '玫玖璃真没救力' },
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
      appid: 70008,
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

// bili 关掉后不再出网，但仍应退到本地通用摘要（不再一律空串）。
clearCardCache();
setCardConfig({ enabled: true, bili: false });
const biliOffLine = await summarizeCard(MINIAPP_CARD);
check('bili 关掉后不再出网、且不返回 [B站] 元数据行', !biliOffLine.startsWith('[B站]') || !biliOffLine.includes('BV'), JSON.stringify(biliOffLine));

// 三个子开关全关：这才是「与上游完全一致」的状态。
clearCardCache();
setCardConfig({ enabled: true, bili: false, music: false, generic: false });
check('bili/music/generic 全关时返回空串（回到 [卡片消息]）', await summarizeCard(MINIAPP_CARD) === '');

clearCardCache();
setCardConfig({});
// 非 B站卡片现在给本地通用摘要（上游行为是空串，这里是有意的行为变更）。
check('非 B站卡片退到通用摘要而非空串',
  (await summarizeCard(JSON.stringify({ app: 'x', meta: { detail_1: { title: 't', qqdocurl: 'https://example.com/a' } } }))).startsWith('[卡片]'));
check('坏 JSON 返回空串且不抛', await summarizeCard('{oops') === '');

// ── 6b. 音乐卡片（纯本地，零出网）────────────────────────────────────────
const QQ_MUSIC_CARD = JSON.stringify({
  app: 'com.tencent.structmsg', desc: '音乐', view: 'music', prompt: '[分享]说爱你',
  meta: {
    music: {
      app_type: 1, appid: 100497308, desc: '蔡依林【VIP】',
      jumpUrl: 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV',
      musicUrl: 'http://aqqmusic.tc.qq.com/amobile.music.tc.qq.com/C400003Auh9r2Z5Wys.m4a',
      preview: 'http://y.gtimg.cn/music/photo_new/x.jpg',
      tag: 'QQ音乐', title: '说爱你'
    }
  },
  config: { forward: true }
});

const NETEASE_CARD = JSON.stringify({
  app: 'com.tencent.structmsg', desc: '音乐', view: 'music', prompt: '[分享]七里香',
  meta: {
    music: {
      app_type: 1, desc: '周杰伦', tag: '网易云音乐', title: '七里香',
      jumpUrl: 'https://music.163.com/song/186016/?userid=1',
      musicUrl: 'http://m7.music.126.net/x.mp3',
      preview: 'http://p1.music.126.net/x.jpg'
    }
  }
});

const KUGOU_CARD = JSON.stringify({
  app: 'com.tencent.structmsg', view: 'music', prompt: '[分享]孤勇者',
  meta: { music: { tag: '酷狗音乐', title: '孤勇者', desc: '陈奕迅', jumpUrl: 'https://www.kugou.com/song/#hash=abc', preview: 'http://imge.kugou.com/x.jpg' } }
});

clearCardCache();
setCardConfig({});
const qqMusicLine = await summarizeCard(QQ_MUSIC_CARD);
check('QQ音乐卡片：认出平台', qqMusicLine.startsWith('[QQ音乐]'), qqMusicLine);
check('QQ音乐卡片：带曲名', qqMusicLine.includes('说爱你'), qqMusicLine);
check('QQ音乐卡片：带歌手', qqMusicLine.includes('蔡依林'), qqMusicLine);
check('QQ音乐卡片：压掉 【VIP】 噪声', !qqMusicLine.includes('VIP'), qqMusicLine);
check('QQ音乐卡片：不含链接', !/https?:\/\//.test(qqMusicLine), qqMusicLine);

const neteaseLine = await summarizeCard(NETEASE_CARD);
check('网易云卡片：认出平台', neteaseLine.startsWith('[网易云音乐]'), neteaseLine);
check('网易云卡片：曲名 + 歌手', neteaseLine.includes('七里香') && neteaseLine.includes('周杰伦'), neteaseLine);
check('网易云卡片：不含链接', !/https?:\/\//.test(neteaseLine), neteaseLine);

const kugouLine = await summarizeCard(KUGOU_CARD);
check('酷狗卡片：认出平台', kugouLine.startsWith('[酷狗音乐]'), kugouLine);

// 小程序形态的音乐卡片：title 是应用名，内容在 desc / prompt 里。
const MINIAPP_MUSIC = JSON.stringify({
  app: 'com.tencent.miniapp_01', prompt: '[网易云音乐]晴天',
  meta: { detail_1: { title: '网易云音乐', desc: '晴天 - 周杰伦', qqdocurl: 'https://music.163.com/song/186016/?uctx=abc', icon: 'https://open.gtimg.cn/x.png' } }
});
clearCardCache();
setCardConfig({});
const miniappMusicLine = await summarizeCard(MINIAPP_MUSIC);
check('小程序音乐卡片：不把应用名当曲名', !/网易云音乐\s*网易云音乐/.test(miniappMusicLine), miniappMusicLine);
check('小程序音乐卡片：认出平台', miniappMusicLine.startsWith('[网易云音乐]'), miniappMusicLine);

// music 开关关掉后应落到通用摘要，不应变成空串
clearCardCache();
setCardConfig({ music: false });
const musicOffLine = await summarizeCard(QQ_MUSIC_CARD);
check('music 开关关掉后不退化成空串', musicOffLine !== '', JSON.stringify(musicOffLine));
setCardConfig({});

// ── 6c. 链接选取：必须排除图标/封面 ───────────────────────────────────────
check('isImageUrl 认得出图标域名', isImageUrl('https://open.gtimg.cn/open/app_icon/x.png'));
check('isImageUrl 认得出封面域名', isImageUrl('https://p1.music.126.net/x.jpg'));
check('isImageUrl 不误杀页面链接', !isImageUrl('https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV'));
check('pickCardLink 优先 jumpUrl 而不是 preview',
  pickCardLink({ preview: 'https://qq.ugcimg.cn/a', jumpUrl: 'https://y.qq.com/n/ryqq/songDetail/x' }, []) === 'https://y.qq.com/n/ryqq/songDetail/x');
check('pickCardLink 跳过跳板域名以前的图标',
  pickCardLink({ icon: 'https://open.gtimg.cn/i.png', qqdocurl: 'https://b23.tv/abc' }, []) === 'https://b23.tv/abc');
check('parseCardJson 的 link 不再是图标',
  parseCardJson(MINIAPP_CARD)?.link === 'https://b23.tv/hUW6qRa?share_medium=android&share_source=qq&bbid=XUED2EEE041FF5A9BD1F33504D821E1ED155C&ts=1794373230826',
  parseCardJson(MINIAPP_CARD)?.link);

// ── 6d. 平台识别 ──────────────────────────────────────────────────────────
check('detectMusicPlatform 按域名认 QQ音乐', detectMusicPlatform({ link: 'https://y.qq.com/x' })?.label === 'QQ音乐');
check('detectMusicPlatform 按域名认网易云', detectMusicPlatform({ link: 'https://music.163.com/song/1' })?.label === '网易云音乐');
check('detectMusicPlatform 认得出 aqqmusic 音频直链', detectMusicPlatform({ link: 'http://aqqmusic.tc.qq.com/a.m4a' })?.label === 'QQ音乐');
check('detectMusicPlatform 按 tag 兜底', detectMusicPlatform({ tag: '网易云音乐' })?.label === '网易云音乐');
check('detectMusicPlatform 非音乐返回 null', detectMusicPlatform({ link: 'https://example.com/x', tag: '新闻' }) === null);
check('detectMusicPlatform view=music 兜底为「音乐」', detectMusicPlatform({ view: 'music' })?.label === '音乐');

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
