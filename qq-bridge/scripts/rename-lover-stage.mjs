// 把「恋爱」这个词统一改成「喜欢」。
//
// 为什么改：用户指出「恋爱」暗示的是"确立关系"，而这一档描述的是**感情本身**
// （会想他、控制不住），不是"我们在一起了"。睦也不会用"恋爱"形容自己。
// 关键词：label、按钮文案、说明卡、注释。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'public/console.html',
  'dsh/agent-presets/qq-chat-agent/agent.cordis.yml',
  'scripts/test-affinity.mjs',
];

const RULES = [
  // 前端按钮 / 说明卡
  ['data-aff-stage="lover">跳到恋爱', 'data-aff-stage="lover">跳到喜欢'],
  ["label: '恋爱',", "label: '喜欢',"],
  ["{ id: 'lover', label: '恋爱', min: 400 }", "{ id: 'lover', label: '喜欢', min: 400 }"],
  // 注释里的说法
  ['最高档门槛（恋爱 400）', '最高档门槛（喜欢 400）'],
  ['「人生到恋爱」', '「人生到喜欢」'],
  // 预设正文
  ['「疏远 / 平淡 / 在意 / 依赖 / 恋爱」', '「疏远 / 平淡 / 在意 / 依赖 / 喜欢」'],
  ['依赖/恋爱档不代表你要变热情', '依赖/喜欢档不代表你要变热情'],
  // 测试文案
  ['五档阈值正确（疏远/平淡/在意/依赖/恋爱）', '五档阈值正确（疏远/平淡/在意/依赖/喜欢）'],
  ['确认能真的走到恋爱', '确认能真的走到喜欢'],
  ['连续互动可以真的走到恋爱', '连续互动可以真的走到喜欢'],
];

let total = 0;
for (const rel of targets) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log(`跳过（不存在）：${rel}`); continue; }
  let src = fs.readFileSync(p, 'utf8');
  const before = (src.match(/恋爱/g) || []).length;
  for (const [from, to] of RULES) src = src.split(from).join(to);
  const after = (src.match(/恋爱/g) || []).length;
  if (before !== after) {
    fs.writeFileSync(p, src, 'utf8');
    console.log(`${rel}: 恋爱 ${before} → ${after}`);
    total += before - after;
  } else {
    console.log(`${rel}: 无需改动（恋爱 ${after} 处）`);
  }
}
console.log(`\n共替换 ${total} 处`);

// 剩下的「恋爱」逐条打印，方便人工判断该不该改
console.log('\n剩余「恋爱」出现位置：');
for (const rel of [...targets, 'src/affinity.js', 'src/bridge.js']) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (line.includes('恋爱')) console.log(`  ${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}
