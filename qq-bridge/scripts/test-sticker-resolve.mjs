// 表情引用解析的回归测试：
// 1) 备注（desc/localNote/tags）完全一致时必须能解析 —— 这是模型最常用的引用方式
// 2) 同名标签命中多条时必须报歧义，绝不猜一条发出去
// 3) id / md5 / url 仍然精确匹配
// 4) 找不到时的错误信息要指出「该改用什么」，否则模型会一直传备注
// 5) 面板要 url（缩略图），模型不要 url（省 token）—— 两条路径必须分开
import { findSticker, resolveSticker, normalizeStickerEntry, formatStickerList } from '../src/sticker-lib.js';

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

const raw = [
  { id: '30001_0_0_0_F198556F65E71C3B42B92FE94271891C_0_0', desc: '被示爱很害羞时用', md5: 'F198556F65E71C3B42B92FE94271891C', url: 'https://p.qpic.cn/a/1' },
  { id: '30001_0_0_0_F8457586E0669B0F905E1CC656B07228_0_0', desc: '角色A本人（半睁眼板脸）', localNote: '板脸', tags: ['生气'], url: 'https://p.qpic.cn/a/2' },
  { id: '30001_0_0_0_7309E0C32101C14A57811DD6E5CED935_0_0', desc: '角色A本人（害怕）', url: 'https://p.qpic.cn/a/3' },
  // 同名标签两条（测试歧义）
  { id: 'dup_A', desc: '同一个名字', url: 'https://p.qpic.cn/a/4' },
  { id: 'dup_B', desc: '同一个名字', url: 'https://p.qpic.cn/a/5' }
];
const list = raw.map(normalizeStickerEntry).filter(Boolean);
const ID_SHY = '30001_0_0_0_F198556F65E71C3B42B92FE94271891C_0_0';

console.log('## 按备注解析（这次线上报错的那个）');
{
  const hit = findSticker(list, '被示爱很害羞时用');
  ok(!!hit, '备注「被示爱很害羞时用」能解析到表情');
  ok(hit?.id === ID_SHY, '解析到的是正确那条', hit?.id);
  ok(findSticker(list, '  被示爱很害羞时用  ')?.id === ID_SHY, '首尾空白不影响');
  ok(resolveSticker(list, '被示爱很害羞时用').entry?.id === ID_SHY, 'resolveSticker 同样能命中');
}

console.log('## 按 localNote / tags 解析');
{
  ok(findSticker(list, '板脸')?.desc === '角色A本人（半睁眼板脸）', 'localNote 可解析');
  ok(findSticker(list, '生气')?.desc === '角色A本人（半睁眼板脸）', 'tags 可解析');
}

console.log('## id / md5 / url 仍然精确匹配');
{
  ok(findSticker(list, ID_SHY)?.id === ID_SHY, '完整 id');
  ok(findSticker(list, 'f198556f65e71c3b42b92fe94271891c')?.id === ID_SHY, 'md5 大小写不敏感');
  ok(findSticker(list, 'https://p.qpic.cn/a/1')?.id === ID_SHY, '完整 url');
}

console.log('## 同名校验（绝不许猜）');
{
  const dup = findSticker(list, '同一个名字');
  ok(dup === null, '同名标签命中多条时 findSticker 返回 null（不瞎选）');
  const r = resolveSticker(list, '同一个名字');
  ok(!r.entry, 'resolveSticker 不返回条目');
  ok(/多个/.test(r.error) && /dup_A/.test(r.error), '错误信息列出候选 id', r.error);
}

console.log('## 不做子串/模糊匹配（防发错图）');
{
  // 「角色A本人」是两条的前缀，绝不能被当成某一条
  ok(findSticker(list, '角色A本人') === null, '前缀「角色A本人」不会被误匹配到某一条');
  ok(findSticker(list, '角色A') === null, '短词「角色A」不会瞎匹配');
}

console.log('## 找不到时的错误信息');
{
  const r = resolveSticker(list, '完全不存在的图');
  ok(!r.entry, '确实返回空');
  ok(/stickerId/.test(r.error), '错误里说明 stickerId 该传什么', r.error);
  ok(/qq_list_stickers/.test(r.error), '错误里指向 qq_list_stickers');

  // 半个名字 → 应给出候选，但绝不自动选
  const near = resolveSticker(list, '示爱');
  ok(!near.entry, '部分匹配不自动发送');
  ok(/被示爱很害羞时用/.test(near.error), '部分匹配时列出候选备注', near.error);
}

console.log('## 空库');
{
  const r = resolveSticker([], '随便');
  ok(!r.entry, '空库不崩');
  ok(/空的/.test(r.error), '空库错误说明表情库是空的', r.error);
}

console.log('## 面板要 url、模型不要 url（两条路径必须分开）');
{
  // 背景：2026-11-11 的 token 瘦身把 url 从公共返回值里删掉，
  // 结果 DSH 小面板的表情卡片全变成空白 —— 面板正是靠 url 渲染缩略图的。
  const modelView = formatStickerList(list, '', 10);
  ok(modelView.stickers.every((s) => !('url' in s)), '模型路径不带 url（省 token）');
  ok(modelView.stickers.every((s) => !('resId' in s)), '模型路径不带 resId');
  ok(modelView.stickers.some((s) => s.id === 'F198556F65E71C3B42B92FE94271891C'), '模型路径用 md5 作句柄');

  const panelView = formatStickerList(list, '', 10, { withUrl: true });
  ok(panelView.stickers.every((s) => typeof s.url === 'string' && s.url.length > 0), '面板路径每张都有 url（否则图是空白）');
  ok(panelView.stickers.some((s) => s.url === 'https://p.qpic.cn/a/1'), '面板拿到的是真实图片地址');
  ok(panelView.stickers.every((s) => typeof s.resId === 'string' && s.resId), '面板路径带 resId');
  // 其它字段不能因为补 url 而丢
  const one = panelView.stickers.find((s) => s.desc === '被示爱很害羞时用');
  ok(one && one.desc === '被示爱很害羞时用' && one.useCount !== undefined, '面板路径保留 desc/useCount');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
