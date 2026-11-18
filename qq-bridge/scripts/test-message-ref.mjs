// 消息引用解析的回归测试。
//
// 修的是这个线上 bug（用户贴的报错）：
//   传入 { messageId: "#4" }  →  「消息 #4 没有可返回的图片/表情」
//   而那条消息**确实带 1 张表情包**（state 里 seq=4, media=1）。
//
// 根因：桥接渲染消息行时把 seq 显示成 `#4`（"`seq` → `#123` 保留（引用、水位）"），
// 模型照着抄，而查找只比对裸数字 `4` —— 永远对不上。
//
// 现在要求：`#4`、`＃4`（全角）、`消息#4`、`4` 都能指向同一条。
import fs from 'node:fs';

const bridge = fs.readFileSync('D:\\DSH\\qq-dsh-bridge\\qq-bridge\\src\\bridge.js', 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// 把 bridge 里的 normalizeMessageRef 抠出来单独跑（它是纯函数）
const src = bridge.slice(bridge.indexOf('function normalizeMessageRef'), bridge.indexOf('function findMessageByRef'));
const fnSrc = src.slice(0, src.lastIndexOf('}') + 1);
// eslint-disable-next-line no-new-func
const normalizeMessageRef = new Function(`${fnSrc}; return normalizeMessageRef;`)();

console.log('## #N 形态归一（这次线上就是栽在这里）');
{
  ok(normalizeMessageRef('#4') === '4', '#4 → 4', normalizeMessageRef('#4'));
  ok(normalizeMessageRef('4') === '4', '4 → 4（裸数字不受影响）');
  ok(normalizeMessageRef('  #4  ') === '4', '带空白也能剥', JSON.stringify(normalizeMessageRef('  #4  ')));
  ok(normalizeMessageRef('＃4') === '4', '全角＃也认', normalizeMessageRef('＃4'));
  ok(normalizeMessageRef('消息#4') === '4', '「消息#4」也认', normalizeMessageRef('消息#4'));
  ok(normalizeMessageRef('#12') === '12', '多位 seq', normalizeMessageRef('#12'));
}

console.log('## 不该被误剥的形态');
{
  // QQ messageId 可能是负数（真实存在），不能被当成 #N 剥掉
  ok(normalizeMessageRef('-202048848') === '-202048848', '负 messageId 原样保留');
  ok(normalizeMessageRef('508450091') === '508450091', '正 messageId 原样保留');
  ok(normalizeMessageRef('') === '', '空字符串');
  ok(normalizeMessageRef(null) === '', 'null 不崩');
  // 旧式 CQ 码 / 带字母的写法不该被硬剥
  ok(normalizeMessageRef('#abc') === '#abc', '非数字的 # 前缀不剥');
}

console.log('## 四个查找点都必须接受 #N');
{
  // findMessageMedia / findMessageByRef / collectStickerV2 / resolveReplyTargetV2 / detail
  const checks = [
    { name: 'findMessageMedia', anchor: 'function findMessageMedia' },
    { name: 'findMessageByRef', anchor: 'function findMessageByRef' }
  ];
  for (const c of checks) {
    const start = bridge.indexOf(c.anchor);
    const seg = bridge.slice(start, start + 2200);
    ok(/normalizeMessageRef\(/.test(seg), `${c.name} 用了 normalizeMessageRef`);
    ok(/refCandidates/.test(seg), `${c.name} 同时尝试两种形态`);
  }

  // 收藏表情
  const collectStart = bridge.indexOf('async function collectStickerV2');
  const collectSeg = bridge.slice(collectStart, collectStart + 1200);
  ok(/normalizeMessageRef\(messageRef\)/.test(collectSeg), 'collectStickerV2 接受 #N');

  // 引用回复
  const replyStart = bridge.indexOf('async function resolveReplyTargetV2');
  const replySeg = bridge.slice(replyStart, replyStart + 1400);
  ok(/normalizeMessageRef\(refStr\)/.test(replySeg), 'resolveReplyTargetV2 接受 #N');

  // 消息详情
  const detailStart = bridge.indexOf("url.pathname === '/api/socialV2/message-detail'");
  const detailSeg = bridge.slice(detailStart, detailStart + 2000);
  ok(/normalizeMessageRef\(messageId\)/.test(detailSeg), 'message-detail 接受 #N');
}

console.log('## 「找不到消息」与「消息没图」必须分开报');
{
  const start = bridge.indexOf("const media = findMessageMedia(key, messageId)");
  const seg = bridge.slice(start, start + 1400);
  ok(/findMessageByRef\(key, messageId\)/.test(seg), '无图时再查一次消息本身');
  ok(/找不到消息/.test(seg), '找不到消息时明确说「找不到消息」');
  ok(/404/.test(seg), '找不到消息返回 404（不是 200 + 空图片）');
  ok(/确实没有图片\/表情（纯文字）/.test(seg), '消息存在但没图时说「确实没有」（不是含糊的"无可读取元数据"）');
  ok(/带不带 # 都行/.test(seg), '错误信息里告诉它 # 可以带');
}

console.log('## 端到端形状：真实那条消息');
{
  // 线上真实数据：group:1128046235，seq=4，messageId=508450091，media=1
  const cases = [
    { ref: '#4', expectSeq: '4' },
    { ref: '4', expectSeq: '4' },
    { ref: '＃4', expectSeq: '4' }
  ];
  for (const c of cases) {
    ok(normalizeMessageRef(c.ref) === c.expectSeq, `${c.ref} 能指向 seq=${c.expectSeq}`);
  }
  // messageId 形态仍然直查
  ok(normalizeMessageRef('508450091') === '508450091', 'messageId 形态不受影响');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
