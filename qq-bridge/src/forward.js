// 合并转发消息（合并聊天记录）相关纯函数：
// - 从 OneBot 消息段中提取并清洗 forward id
// - 把 SnowLuma `get_forward_msg` 返回结果格式化为适合 AI 阅读的紧凑结构
// - 暴露每条消息里的图片/表情元数据与嵌套 forward id，供桥接/MCP 进一步读取
//
// 安全原则：
// - forward id 只允许安全字符，长度受限，避免把任意内容当参数传给 OneBot/日志
// - 只格式化，不访问网络；调用方负责“id 必须来自当前会话已见消息”的校验

import { truncateText } from './md-to-plain.js';

export function sanitizeForwardId(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 256) return '';
  // 仅用于 OneBot JSON 参数：允许常见 QQ 资源 id 字符，拒绝空白/控制字符。
  if (!/^[\w:.\-/=+@]+$/.test(s)) return '';
  return s;
}

// 从单个 forward 消息段 data 中取 id，供 segmentsToText 与 extractForwardIds 共用。
export function forwardIdFromData(data) {
  const d = data && typeof data === 'object' ? data : {};
  return sanitizeForwardId(d?.id ?? d?.res_id ?? d?.file_id ?? d?.forward_id ?? '');
}

export function extractForwardIds(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'forward') continue;
    const id = forwardIdFromData(seg.data);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function segmentText(seg) {
  if (typeof seg === 'string') return seg;
  if (!seg || typeof seg !== 'object') return '';
  const d = seg.data ?? {};
  switch (seg.type) {
    case 'text': return String(d.text ?? '');
    case 'at': return d.qq === 'all' ? '@全体成员' : `@${d.qq ?? ''}`;
    case 'face': return `[表情${d.id ?? ''}]`;
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': return `[文件${d.name ?? ''}]`;
    case 'reply': return '[引用]';
    case 'forward': return '[转发]';
    case 'json': return '[卡片消息]';
    default: return `[${seg.type ?? '未知'}]`;
  }
}

function sanitizeCqString(s) {
  // 如果 get_forward_msg 返回的是 CQ 字符串，转为占位符，避免把 CQ 码原样塞给 AI。
  return String(s ?? '').replace(/\[CQ:[^\]]*\]/gi, '[媒体]');
}

function contentToText(content) {
  if (typeof content === 'string') return sanitizeCqString(content);
  if (Array.isArray(content)) return sanitizeCqString(content.map(segmentText).join('').trim());
  if (content && typeof content === 'object') {
    // 兼容单条 segment 对象（例如 { type:'text', data:{...} }）
    if (content.type) return sanitizeCqString(segmentText(content).trim());
    if (typeof content.text === 'string') return sanitizeCqString(content.text);
    if (Array.isArray(content.content)) return sanitizeCqString(content.content.map(segmentText).join('').trim());
  }
  return '';
}

export function nodeText(node) {
  if (!node || typeof node !== 'object') return '';
  // 标准 OneBot 转发节点：{ type:'node', data:{ name, uin, time, content } }
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const topContent = node.message ?? node.content ?? node.text;
  const dataContent = data.message ?? data.content ?? data.text;
  const text = contentToText(topContent) || contentToText(dataContent);
  return text;
}

function senderName(node) {
  if (!node || typeof node !== 'object') return '';
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const sender = node.sender;
  // 用 truncateText：群名片里带 emoji 时按码元 slice 会留下孤立高代理。
  if (sender && typeof sender === 'object') {
    const name = sender.nickname || sender.card || sender.user_id || '';
    if (name) return truncateText(String(name), 100);
  }
  if (typeof sender === 'string' && sender) return truncateText(String(sender), 100);
  const name = data.name || data.nickname || data.card || data.uin || data.user_id || node.name || node.nickname || '';
  return truncateText(String(name ?? ''), 100);
}

function senderUserId(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const sender = node.sender;
  const uid = sender && typeof sender === 'object' ? sender.user_id : data.uin ?? data.user_id ?? node.uin ?? node.user_id;
  return uid != null ? String(uid) : null;
}

function nodeTime(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const t = node.time ?? data.time;
  return t != null ? Number(t) : null;
}

function nodeMessageId(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const id = node.message_id ?? node.messageId ?? data.message_id ?? data.id ?? null;
  return id != null ? String(id) : null;
}

function nodeMessageSeq(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const seq = node.message_seq ?? node.messageSeq ?? data.message_seq ?? data.seq ?? null;
  return seq != null ? String(seq) : null;
}

function nodeContent(node) {
  if (!node || typeof node !== 'object') return [];
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const topContent = node.message ?? node.content ?? node.text;
  const dataContent = data.message ?? data.content ?? data.text;
  const content = Array.isArray(topContent) ? topContent : Array.isArray(dataContent) ? dataContent : null;
  if (content) return content;
  // 与 contentToText 保持一致：单个消息段也可能承载图片或嵌套转发。
  for (const candidate of [topContent, dataContent]) {
    if (candidate && typeof candidate === 'object') {
      if (candidate.type) return [candidate];
      if (Array.isArray(candidate.content)) return candidate.content;
    }
  }
  // 字符串内容没有可提取的媒体/嵌套转发
  return [];
}

function segmentMedia(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const d = seg.data ?? {};
  if (seg.type === 'image') {
    // 2026-11-11：**不再返回 file / url**。QQ 图片的 url 是几百字符的带签名长链
    // （实测单条约 400~600 字符），而模型从来看不懂也用不上它 —— 它需要的是
    // 「这里有一张图」。真要取图，用 qq_get_forward_msg 回来的 forward-media
    // 端点（那条路径按需下载，不经过模型上下文）。
    const file = String(d.file ?? d.file_id ?? d.filename ?? '');
    const url = String(d.url ?? d.src ?? '');
    if (file || url) {
      const summary = String(d.summary ?? d.emoji ?? '').trim();
      return { kind: 'image', ...(summary ? { summary: truncateText(summary, 40) } : {}) };
    }
  }
  if (seg.type === 'face') {
    const faceId = String(d.id ?? d.face_id ?? '');
    if (faceId) return { kind: 'face', faceId };
  }
  return null;
}

function segmentNestedForwardId(seg) {
  if (!seg || typeof seg !== 'object' || seg.type !== 'forward') return null;
  return forwardIdFromData(seg.data);
}

// 从一段消息内容（数组）中提取图片/表情与嵌套转发 id。
function collectSegmentMeta(content) {
  const media = [];
  const nestedForwardIds = [];
  if (!Array.isArray(content)) return { media, nestedForwardIds };
  for (const seg of content) {
    const m = segmentMedia(seg);
    if (m) media.push(m);
    const nested = segmentNestedForwardId(seg);
    if (nested && !nestedForwardIds.includes(nested)) nestedForwardIds.push(nested);
  }
  return { media, nestedForwardIds };
}

export function formatForwardResponse(data, options = {}) {
  // 2026-11-13：默认上限 50 → 100。
  // 转发记录本身就是聊天记录，是她在读的**内容**而不是工具噪音；
  // 截断太狠会让她看不到后半段（实测 76 条的转发只给了前 50 条，
  // 后面的关键对话直接消失）。
  // 上限锁在 100：**QQ 的合并转发本来就最多 100 条**，再大有意义也不存在。
  // 正文截断（maxCharsPerMessage）保持 500，那是单条防爆的兜底。
  const maxMessages = Math.max(1, Math.min(100, Number(options.maxMessages) || 100));
  const maxCharsPerMessage = Math.max(1, Math.min(2000, Number(options.maxCharsPerMessage) || 500));
  const raw = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
  const total = raw.length;
  const truncatedByCount = total > maxMessages;
  let textTruncated = false;
  const messages = raw.slice(0, maxMessages).map((node, index) => {
    const fullText = nodeText(node);
    // 切点落在代理对中间时必须前移一个码元（判据与 md-to-plain.js 的 splitForQQ 一致）：
    // `slice(0, max)` 是按 UTF-16 码元切的，emoji/生僻字会被切成孤立高代理，
    // 那半个字符既不是合法文本，写进提示词或日志后还会渲染成乱码或替换符。
    let cut = maxCharsPerMessage;
    const cutCode = fullText.charCodeAt(cut - 1);
    if (cutCode >= 0xd800 && cutCode <= 0xdbff) cut -= 1;
    // 与 splitForQQ 相同：切点被逼到 0 时至少保留一个完整码点，
    // 否则 maxCharsPerMessage=1 且开头是 emoji 会让整条预览变成空串。
    if (cut === 0) {
      const first = fullText.charCodeAt(0);
      const second = fullText.charCodeAt(1);
      cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
    }
    const text = fullText.slice(0, cut);
    if (fullText.length > maxCharsPerMessage) textTruncated = true;
    const content = nodeContent(node);
    const meta = collectSegmentMeta(content);
    return {
      index: index + 1,
      sender: senderName(node),
      userId: senderUserId(node),
      time: nodeTime(node),
      messageId: nodeMessageId(node),
      messageSeq: nodeMessageSeq(node),
      text,
      media: meta.media,
      nestedForwardIds: meta.nestedForwardIds
    };
  });
  return {
    total,
    truncated: truncatedByCount || textTruncated,
    textTruncated,
    messages
  };
}

/**
 * 把 formatForwardResponse 的结果渲染成**纯文本行**（与【本轮消息】同风格）。
 *
 * 2026-11-11：原来直接把 `{total,truncated,textTruncated,messages:[{index,sender,
 * userId,time,messageId,messageSeq,text,media:[{kind,file,url}],nestedForwardIds}]}`
 * 整个 JSON 塞给模型。单条图片消息的 `url` 能到 600 字符，40 条的转发记录光 URL
 * 就有 2 万字符 —— 而模型既读不懂也用不上签名链接，它只需要知道「这里有一张图」。
 *
 * 现在：每条一行，形如
 *   `#1 阿三 userId:123·11-11 20:15：文字内容 [图片]`
 * 媒体只留 `[图片]` / `[表情]` 标记，嵌套转发只留 `转发id=`（长度封顶 5 个）。
 *
 * 不再输出：index（行首序号已代替）、messageId / messageSeq（本工具用不到，
 *   要引用走主会话的 seq）、media.file / media.url。
 */
export function renderForwardText(formatted, options = {}) {
  if (!formatted || typeof formatted !== 'object') return '';
  const messages = Array.isArray(formatted.messages) ? formatted.messages : [];
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
  const stamp = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const head = [
    `转发记录 ${formatted.total ?? messages.length} 条`
  ];
  if (formatted.truncated) head.push(`（只显示前 ${messages.length} 条）`);
  if (formatted.textTruncated) head.push('（部分正文被截断，需要全文可传 full:true）');

  const lines = messages.map((m, i) => {
    const idx = `#${m.index ?? i + 1} `;
    // sender 是群友可控字段，清洗控制字符（与 bridge.js 的 renderOneMessageLine 同口径）。
    const who = String(m.sender || '某人').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim() || '某人';
    // 2026-11-13：**不再输出 userId**。
    // 全局约定：QQ 号只出现在 qq_get_userid 的返回里（那里是 `昵称：userId:号码`），
    // 其他所有消息类输出一律只给人名。转发记录一次几十条，每条带 18 字符的号
    // 纯属白烧；她真要 @ 里面某个人，用 qq_get_userid(query=那个名字) 查一次即可。
    const when = stamp(m.time);
    const timePart = when ? `·${when}` : '';
    // 正文同样清洗。
    const text = String(m.text ?? '')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // 媒体压成标记。
    const marks = [];
    for (const it of (Array.isArray(m.media) ? m.media : [])) {
      if (it?.kind === 'image') marks.push(it.summary ? `[图片:${it.summary}]` : '[图片]');
      else if (it?.kind === 'face') marks.push('[表情]');
    }
    const fids = Array.isArray(m.nestedForwardIds) ? m.nestedForwardIds : [];
    // 嵌套转发 id 极长（每条 84 字符），只给前 5 个并注明还剩多少。
    if (fids.length) {
      const shown = fids.slice(0, 5).join(',');
      marks.push(`转发id=${shown}${fids.length > 5 ? `…等${fids.length}个` : ''}`);
    }
    const tail = marks.length ? ` ${marks.join(' ')}` : '';
    return `${idx}${who}${timePart}：${text}${tail}`;
  });

  return [head.join(''), ...lines].join('\n');
}