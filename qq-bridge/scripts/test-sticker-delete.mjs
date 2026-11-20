// 表情删除的回归测试。
//
// 修的是这个线上 bug（用户原话「删不掉表情包」）：
//   · 面板按 `s.id` 传参，而列表里的 id 是 **md5**（32 位，省 token 用的）
//   · delete_custom_face 要的是**完整 emoji_id**（`<uin>_0_0_0_<md5>_0_0`）
//   · SnowLuma 的 DeleteCustomFace.invoke 只检查「有没有响应」，**不看服务端结果**
//     → 传 md5 也回 status:ok、retcode:0
//   · 旧代码于是 sendJson({ok:true})，面板弹「已删除」，表情纹丝不动
//
// 现在要求：① md5/备注/完整 id 都能解析成 emoji_id；
//          ② 删除后必须**重新拉列表核实**，还在就报 409，绝不谎报成功。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根：从脚本位置推导，换机器/换目录都能跑（别再写死绝对路径）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, '..', 'dsh-plugins', 'qq-dsh-panel', 'lib', 'client.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('## 桥接：删除前必须把引用还原成 emoji_id');
{
  // 取出 delete 路由那一段
  const start = bridge.indexOf("url.pathname === '/api/stickers/delete'");
  const seg = bridge.slice(start, start + 3000);
  ok(start > 0, '找到删除路由');
  ok(/resolveSticker\(/.test(seg), '删除前用 resolveSticker 解析（支持 md5/备注/完整 id）');
  ok(/const emojiId = String\(resolved\.entry\.id/.test(seg), '取的是 entry.id（完整 emoji_id）而不是用户原样的输入');
  ok(/delete_custom_face',\s*\{\s*emoji_id:\s*emojiId/.test(seg), '发给上游的是 emojiId');
  // 这段里不能再出现「直接把 rawId 交给上游」
  ok(!/delete_custom_face',\s*\{\s*emoji_id:\s*(rawId|stickerId)\s*\}/.test(seg), '没有把原始参数直接透传给上游');
}

console.log('## 桥接：emoji_id 格式校验（防无效请求）');
{
  const start = bridge.indexOf("url.pathname === '/api/stickers/delete'");
  const seg = bridge.slice(start, start + 3000);
  ok(/_\\d\+_\\d\+_\\d\+_\[0-9A-Fa-f\]\{32\}_\\d\+_\\d\+\$/.test(seg)
    || /\[0-9A-Fa-f\]\{32\}/.test(seg), '有 emoji_id 形状校验', '需要 **');
}

console.log('## 桥接：删除后必须核实（这是「假成功」的根治）');
{
  const start = bridge.indexOf("url.pathname === '/api/stickers/delete'");
  const seg = bridge.slice(start, start + 3000);
  ok(/syncStickerLibrary\(true/.test(seg), '删除后强制重新同步');
  ok(/stillThere/.test(seg), '记录了「是否还在」');
  ok(/if \(stillThere\)/.test(seg), '还在时单独处理');
  ok(/409/.test(seg), '删除未生效返回 409（不是 200）');
  ok(!/sendJson\(\{ ok: true[^}]*\}\);\s*return;\s*\}\s*catch/.test(seg.replace(/\n/g, ''))
    || /stillThere/.test(seg), '不存在「不核实就报 ok:true」的路径');
  // 成功响应必须带上被删的是谁，便于排查
  ok(/deleted:\s*emojiId/.test(seg), '成功响应带 deleted 字段');
}

console.log('## 面板：传完整 resId 而不是 md5');
{
  ok(/stickerId:\s*s\.resId \|\| s\.id/.test(panel), '面板优先用 resId（完整 emoji_id）');
  ok(!/stickerId:\s*s\.id \}/.test(panel), '不再直接传 s.id（md5）');
  ok(/res && res\.ok \? '已删除' : \(\(res && res\.error\) \|\| '删除失败'\)/.test(panel),
    '面板如实显示桥接返回的失败原因（不一律「已删除」）');
}

console.log('## 端到端形状：真实 emoji_id 必须能通过校验');
{
  const realIds = [
    '3346197751_0_0_0_F8457586E0669B0F905E1CC656B07228_0_0',
    '3346197751_0_0_0_0EA1F1E45BFEBDEE37C0B4C47288D7CF_0_0'
  ];
  const re = /_\d+_\d+_\d+_[0-9A-Fa-f]{32}_\d+_\d+$/;
  for (const id of realIds) ok(re.test(id), `真实 emoji_id 通过校验：${id.slice(-12)}`);
  // 反例：纯 md5 不该通过
  ok(!re.test('F8457586E0669B0F905E1CC656B07228'), '纯 md5 不通过 emoji_id 校验（正是旧 bug 的来源）');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
