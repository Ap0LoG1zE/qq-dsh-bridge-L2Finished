// 控制台静态校验：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构契约。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 元素 ID');
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
ok(dups.length === 0, 'ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
// 语音库面板已删除（2026-11-12），下面这段改成反向断言，见后面的「语音库已移除」小节。
for (const id of []) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `语音面板元素 ${id}`, `${n} 处`);
}

console.log('## 视图 / 页面契约');
const views = [...new Set([...html.matchAll(/data-view="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
const pages = [...new Set([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
// 真正的契约只有一半：
//   · 每个导航按钮（data-view）**必须**有对应页面，点过去不能是空白 —— 这条永远成立；
//   · 反过来不成立：`social-v1`（一代仿真）与 `slang` 已从导航里移除，
//     但页面 DOM 与 id 保留了（轮询脚本仍按 id 读写，删掉会 null 引用；
//     见 console.html 里 `.is-retired` 的注释），所以存在无导航入口的孤儿页面是**有意为之**。
// 旧断言要求两个集合完全相等，等于把「遗留隐藏页」判成缺陷，会逼着人去删还敢留的 DOM。
const orphanPages = pages.filter((p) => !views.includes(p));
const missingPages = views.filter((v) => !pages.includes(v));
ok(missingPages.length === 0, '每个导航按钮都有对应页面', missingPages.length ? `缺：${missingPages.join(', ')}` : `${views.length} 个：${views.join(', ')}`);
ok(orphanPages.every((p) => ['social-v1', 'slang'].includes(p)), '无导航入口的遗留页仅限已知白名单', orphanPages.length ? `遗留：${orphanPages.join(', ')}（DOM 保留，不展示）` : '无');


console.log('## 工具开关');
const tools = [...html.matchAll(/data-v2-tool="([A-Za-z]+)"/g)].map((m) => m[1]);
ok(!tools.includes('sendVoice'), 'sendVoice 开关已移除', `共 ${tools.length} 个开关`);
ok(new Set(tools).size === tools.length, '工具开关无重复');

console.log('## 语音库已移除');
// 语音库面板已按操作者要求删除（2026-11-12）。这里改成**反向**断言：
// 这些元素/端点/函数不许再出现，防止谁又加回来。
// 现在用的是纯语音 TTS（桥接把文字合成为语音条），与语音库无关。
for (const id of ['voiceList', 'voiceRefreshBtn', 'voiceSendBtn', 'voiceSendTarget', 'voiceSendDryRun', 'voiceMsg']) {
  ok(!html.includes(`id="${id}"`), `语音面板元素 ${id} 已移除`, html.includes(`id="${id}"`) ? '仍存在' : '已清除');
}
ok(!html.includes('/api/voice/list'), '不再调用 /api/voice/list');
ok(!html.includes('/api/voice/send'), '不再调用 /api/voice/send');
ok(!html.includes('loadVoiceLibrary'), 'loadVoiceLibrary 已清除');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }

console.log('## 语音图形界面的音量控件');
if (!hasVoiceTool()) {
  // 这一整段查的是独立工具自己的页面（voice.html），仓库里没有它。
  skipVoiceTool('voice.html 的音量控件断言（volRange/volLabel/volReset/normBox/loudnessSel/previewBtn、滑块范围、事件绑定、前端 JS 可解析）');
} else {
  const voice = fs.readFileSync(voiceToolPath('public', 'voice.html'), 'utf8');
  const ids = [...voice.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  ok(dups.length === 0, 'voice.html ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
  for (const id of ['volRange', 'volLabel', 'volReset', 'normBox', 'loudnessSel', 'previewBtn']) {
    ok(ids.includes(id), `音量控件 ${id}`);
  }
  ok(/id="volRange"[^>]*min="10"[^>]*max="400"/.test(voice), '滑块范围 10%~400%');
  ok(/volRange'\)\.addEventListener\('input'/.test(voice), '滑块 input 事件已绑定');
  ok(/previewBtn'\)\.addEventListener/.test(voice), '试听按钮已绑定');
  ok(/api\/preview/.test(voice), '试听调 /api/preview（听处理后的效果）');
  ok(/body\.normalize = true/.test(voice) && /body\.volume = volValue\(\)/.test(voice), '发送时带上音量设置');
  const scripts = [...voice.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { new Function(scripts[0]); ok(true, 'voice.html 前端 JS 可解析'); }
  catch (e) { ok(false, 'voice.html 前端 JS 可解析', e.message); }
}

console.log('## fixture mock 覆盖');
const fixture = fs.readFileSync(path.join(ROOT, 'scripts', 'console-ui-fixture.mjs'), 'utf8');

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
