// 歌词模块自检：离线用例必过；联网用例失败只告警。
// 运行：node scripts/test-lyrics.mjs
import {
  parseLrc,
  scoreCandidate,
  sanitizeLyricText,
  setLyricsConfig,
  getLyricsConfig,
  guessTitleFromLrc,
} from '../src/lyrics.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed += 1; console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ── 1. parseLrc ────────────────────────────────────────────────────────────
const SAMPLE = `[ti:晴天]
[ar:周杰伦]
[al:叶惠美]
[by:]
[offset:0]
[00:00.00]晴天 - 周杰伦 (Jay Chou)
[00:02.25]词：周杰伦
[00:04.50]曲：周杰伦
[00:06.75]编曲：周杰伦
[00:09.00]制作人：周杰伦
[00:11.25]合声：周杰伦
[00:13.50]合声编写：周杰伦
[00:15.75]吉他：蔡科俊Again
[00:18.00]贝斯：陈任佑
[00:20.25]鼓：陈柏州
[00:22.51]录音助理：刘勇志
[00:24.76]录音工程：杨瑞代（Alfa Studio）
[00:27.01]混音工程：杨大纬
[00:29.26]故事的小黄花
[00:32.71]从出生那年就飘着
[00:32.71]从出生那年就飘着
[00:36.24]童年的荡秋千
[00:39.75]随记忆一直晃到现在
`;

const p = parseLrc(SAMPLE);
check('解析出 [ti:] 元信息', p.meta.ti === '晴天', p.meta.ti);
check('解析出 [ar:] 元信息', p.meta.ar === '周杰伦');
check('解析出 [al:] 元信息', p.meta.al === '叶惠美');
check('时间轴被剥掉', !/\[\d{2}:\d{2}/.test(p.text), p.text.slice(0, 40));
check('开头署名被剥掉（词/曲/编曲/制作人/吉他/录音…）', !/^(词|曲|编曲|制作人|合声|吉他|贝斯|鼓|录音|混音)/m.test(p.text));
check('正文歌词保留', p.text.includes('故事的小黄花') && p.text.includes('童年的荡秋千'));
check('连续重复行被压掉', (p.text.match(/从出生那年就飘着/g) || []).length === 1);
check('标题行保留（不算署名）', p.text.startsWith('晴天 - 周杰伦'), p.text.split('\n')[0]);
check('lineCount 与正文行数一致', p.lineCount === p.text.split('\n').length);

// 正文中间出现的「词：」不能误删（只在开头 N 行剥署名）
const midCredit = `[00:00.00]第一句歌词
[00:05.00]第二句歌词
[00:10.00]第三句歌词
[00:15.00]第四句歌词
[00:20.00]第五句歌词
[00:25.00]第六句歌词
[00:30.00]第七句歌词
[00:35.00]第八句歌词
[00:40.00]第九句歌词
[00:45.00]第十句歌词
[00:50.00]第十一句歌词
[00:55.00]第十二句歌词
[01:00.00]第十三句歌词
[01:05.00]第十四句歌词
[01:10.00]第十五句歌词
[01:15.00]第十六句歌词
[01:20.00]第十七句歌词
[01:25.00]第十八句歌词
[01:30.00]第十九句歌词
[01:35.00]第二十句歌词
[01:40.00]第二十一句歌词
[01:45.00]词：这其实是歌词
`;
check('正文深处的「词：」不被当成署名删掉', parseLrc(midCredit).text.includes('词：这其实是歌词'));

check('空输入不抛', parseLrc('').text === '' && parseLrc(null).text === '');

// ── 1b. 英文署名（「xxx by：」语序）────────────────────────────────────
const enSample = [
  'Shape of You - Ed Sheeran',
  'Lyrics by：Ed Sheeran/Steve Mac',
  'Composed by：Ed Sheeran/Steve Mac',
  'Produced by：Steve Mac',
  "The club isn't the best place to find a lover",
  'So the bar is where I go',
].join('\n');
const en = parseLrc(enSample);
check('英文「Lyrics by：」被剥掉', !/Lyrics by/i.test(en.text), en.text);
check('英文「Composed by：」被剥掉', !/Composed by/i.test(en.text));
check('英文「Produced by：」被剥掉', !/Produced by/i.test(en.text));
check('英文正文保留', en.text.includes("The club isn't the best place"));
check('英文标题行保留', en.text.startsWith('Shape of You - Ed Sheeran'));

// ── 1b. guessTitleFromLrc（只在首行是「歌名 - 歌手」时才认）────────────────
const g1 = guessTitleFromLrc('晴天 - 周杰伦 (Jay Chou)\n故事的小黄花');
check('首行「歌名 - 歌手」能认出曲名', g1.title === '晴天', g1.title);
check('首行「歌名 - 歌手」能认出歌手', g1.artist === '周杰伦 (Jay Chou)', g1.artist);

const g2 = guessTitleFromLrc('都 是勇敢的\n你额头的伤口');
check('首行是歌词正文时不猜曲名（防「都把勇敢的当歌名」）', g2.title === '', JSON.stringify(g2.title));
check('首行是歌词正文时不猜歌手', g2.artist === '');

check('空歌词不猜', guessTitleFromLrc('').title === '' && guessTitleFromLrc(null).title === '');

// ── 2. scoreCandidate ─────────────────────────────────────────────────────
const s1 = scoreCandidate({ title: '晴天', artist: '周杰伦' }, '晴天', '周杰伦');
check('完全匹配得高分', s1.score >= 180 && s1.exactArtist === true, JSON.stringify(s1));

const s2 = scoreCandidate({ title: '晴天', artist: '舟子' }, '晴天', '周杰伦');
check('歌手不符：扣分并标记非原唱', s2.score < 180 && s2.exactArtist === false, JSON.stringify(s2));

const s3 = scoreCandidate({ title: '晴天 (女声版)', artist: 'GYBeat' }, '晴天', '周杰伦');
check('翻唱版本被重罚', s3.score < 40 && s3.exactArtist === false, JSON.stringify(s3));

const s4 = scoreCandidate({ title: '完全无关', artist: '某人' }, '晴天', '周杰伦');
check('标题完全无关直接 reject', s4.reject === true, JSON.stringify(s4));

const s5 = scoreCandidate({ title: '晴天', artist: '周杰伦' }, '晴天', '');
check('不要求歌手时仍能匹配', s5.score >= 100 && s5.exactArtist === true);

const s6 = scoreCandidate({ title: '晴天 (钢琴版) [原唱: 周杰伦]', artist: '纪钧瀚' }, '晴天', '周杰伦');
check('「原唱: 周杰伦」的翻唱也被识别', s6.exactArtist === false, JSON.stringify(s6));

// ── 3. sanitizeLyricText ──────────────────────────────────────────────────
check('保留换行', sanitizeLyricText('a\nb').includes('\n'));
check('压掉控制字符', sanitizeLyricText('a\u0000b\u0007c') === 'a b c');
check('CRLF 归一为 LF', !sanitizeLyricText('a\r\nb').includes('\r'));
check('折叠连续空行', !/\n{3,}/.test(sanitizeLyricText('a\n\n\n\nb')));

// ── 4. 配置归一化 ─────────────────────────────────────────────────────────
const cfg1 = setLyricsConfig({ maxChars: 999999 });
check('maxChars 上限收敛', cfg1.maxChars === 20000, String(cfg1.maxChars));
const cfg2 = setLyricsConfig({ maxChars: 1 });
check('maxChars 下限收敛', cfg2.maxChars === 200, String(cfg2.maxChars));
const cfg3 = setLyricsConfig({ timeoutMs: 'abc' });
check('非法 timeoutMs 回落默认', cfg3.timeoutMs === 12000, String(cfg3.timeoutMs));
const cfg4 = setLyricsConfig({ enabled: false });
check('enabled=false 生效', cfg4.enabled === false);
setLyricsConfig({});

// ── 5. 真实网络（可选）───────────────────────────────────────────────────
const { lookupLyrics } = await import('../src/lyrics.js');
setLyricsConfig({});
try {
  const real = await lookupLyrics({ platform: 'qq', title: '晴天', artist: '周杰伦' });
  if (real.ok) {
    console.log(`ℹ️ 真实端到端（QQ音乐）：${real.title} — ${real.artist}，${real.lineCount} 行`);
    check('真实歌词非空', real.lyric.length > 50, `${real.lyric.length} 字`);
    check('真实歌词不含时间轴', !/\[\d{2}:\d{2}\.\d{2}\]/.test(real.lyric));
  } else {
    console.log(`⚠️ 真实端到端未通（可能离线/限流）：${real.error}`);
  }
} catch (error) {
  console.log(`⚠️ 真实端到端抛错（应永不抛）：${error?.message ?? error}`);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
