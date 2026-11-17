// QQ 图片 vs 表情包 的语义分类（纯函数，可单测）。
//
// 为什么需要单独一个模块：
//   同一套判定在 bridge.js 里原本散落在三处（合成文本、media 元数据、看图标注），
//   三处的写法略有出入，任何一处改了另外两处就静默漂移。而这三处必须永远一致 ——
//   否则会出现「正文说[图片]、media 说表情包、看图工具又说图片」这种自相矛盾，
//   模型只能瞎猜。
//
// ⚠️ 这个分类是**给模型读消息用的语义标签**，不是「这条是否真的是表情」的绝对真值。
//   QQ 允许用户把任何图片当表情用（存下来再发），协议层无从分辨动机。
//
// 协议事实 —— 本机实采 42 个 image 段的统计（2026-11，两个群样本）：
//
//   sub_type=0   8 个    summary 全是 "[图片]"     全部 >400px（1254x1254 … 2212x1244）
//   sub_type=1  32 个    summary 全是 "[动画表情]" 102x77 … 1920x1920，9 个 <400px
//   sub_type=7   2 个    summary 是**可读文字**    340x340 / 159x129，都 <400px
//                        （"[666]" 是眯眼兔子竖中指，"[流口水]" 是流口水的仓鼠）
//
// 结论：
//   · sub_type=1 **或** 7 **或** 带 emoji_id  ⇒ 表情包
//   · sub_type=0（以及其他）                   ⇒ 图片
//
// 为什么 7 也算：这两条实测都是表情，且 summary 是可读文字而不是 "[图片]" 占位符 ——
// QQ 把「用户自己存下来的表情图」发成 7，语义上就是表情。
//
// 已知局限（必须诚实写在代码里）：
//   有人会把表情图**以图片形式**发出去（实测 sub_type=0 里就有一张
//   1254x1254 的二次元图配文字「一身烟味的我，怎么敢碰一身奶味的你」，
//   那是当表情用的）。协议层的 sub_type 是 0，本函数会判成图片。
//   这类只能靠模型看图+上下文自己判断，桥接不猜 —— 猜错比不猜更糟。

export const IMAGE_LABEL = '[图片]';
export const STICKER_LABEL = '[表情包]';

/**
 * 判断一个 image 段 / media 记录是不是表情包。
 *
 * @param source 可以是 OneBot 段的 `data`（snake_case 字段），
 *               也可以是 bridge 内部归一化后的 media 对象（camelCase 字段）。
 *               两种形状都接受，因为这三处调用点的输入形状确实不同。
 */
export function isStickerLike(source) {
  if (!source || typeof source !== 'object') return false;
  // 已经归一化过并显式标记的（media 对象带 isSticker），直接采信。
  if (source.isSticker === true) return true;
  // mface 段归一化后 kind=sticker（市场表情没有 image 段可用）
  if (source.kind === 'sticker') return true;
  const subType = String(source.sub_type ?? source.subType ?? '').trim();
  if (subType === '1' || subType === '7') return true;
  const emojiId = String(source.emoji_id ?? source.emojiId ?? '').trim();
  if (emojiId) return true;
  return false;
}

/**
 * 把 summary（QQ 给的占位文本，如 "[动画表情]"）转成可读标签。
 * 占位符本身没有信息量，返回空串让调用方只写「[表情包]」。
 */
export function stickerLabelFromSummary(summary) {
  const s = String(summary ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!s) return '';
  // "[动画表情]" / "[表情]" / "[图片]" 这类是占位符，不是内容
  if (/^\[?\s*(动画表情|表情|表情包|图片)\s*\]?$/.test(s)) return '';
  const stripped = s.replace(/^\[/, '').replace(/\]$/, '').trim();
  return stripped;
}

/**
 * 生成给模型看的单行标注：表情包和图片必须能一眼分清。
 * 有可读 summary 时带上（如 "[表情包:666]"），否则只写类型。
 */
export function describeInlineImage(source) {
  if (!isStickerLike(source)) return IMAGE_LABEL;
  const label = stickerLabelFromSummary(source.summary);
  return label ? `[表情包:${label}]` : STICKER_LABEL;
}
