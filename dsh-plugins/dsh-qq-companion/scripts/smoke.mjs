// dsh-qq-companion 冒烟测试：不启动 DSH，只验证结构完整性。
//
// 检查：
//   ① 所有必需文件存在，JSON/YAML 可解析
//   ② host 主入口可 import，导出 name/inject/apply
//   ③ 子模块可 import，各自的 inject 声明合理
//   ④ client.js 的模块 id 与 package name 一致（改包名后最容易漏的一处）
//   ⑤ 预设 patch 里的守卫引用指向本包（不是旧的 qq-agent-presets）
//   ⑥ YAML 里没有残留的旧包名
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('=== ① 文件与格式 ===');
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/agent-context.js',
  'lib/compact-chat.js',
  'lib/features/qq-bigfish.js',
  'lib/features/thinking-zh.js',
  'presets/qq-chat-agent.patch.yml',
  'tool-restrict.mjs',
  'locale/zh.json',
  'locale/en.json',
];
for (const rel of REQUIRED) {
  check(rel, fs.existsSync(path.join(ROOT, rel)));
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json 可解析', true);
} catch (e) {
  check('package.json 可解析', false, e.message);
}

console.log('\n=== ② package.json 声明 ===');
check('name 是 dsh-qq-companion', pkg?.name === 'dsh-qq-companion', pkg?.name);
check('exports["."] 指向 lib/index.js', pkg?.exports?.['.'] === './lib/index.js', pkg?.exports?.['.']);
check('exports["./client"] 指向 lib/client.js', pkg?.exports?.['./client'] === './lib/client.js');
check('exports["./tool-restrict.mjs"] 存在（预设守卫要按裸说明符解析）',
  pkg?.exports?.['./tool-restrict.mjs'] === './tool-restrict.mjs');
check('dsh.bundle.patch 是数组且含两份 patch',
  Array.isArray(pkg?.dsh?.bundle?.patch) && pkg.dsh.bundle.patch.length === 2,
  JSON.stringify(pkg?.dsh?.bundle?.patch));
check('dsh.client.platform = web', pkg?.dsh?.client?.platform === 'web');
check('files 里包含 presets 与 tool-restrict.mjs',
  pkg?.files?.includes('presets') && pkg?.files?.includes('tool-restrict.mjs'));

console.log('\n=== ③ host 主入口 ===');
const main = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href);
check('导出 name', main.name === 'dsh-qq-companion', main.name);
check('导出 apply 函数', typeof main.apply === 'function');
check('inject 是空数组（依赖交给子模块各自 declare）',
  Array.isArray(main.inject) && main.inject.length === 0, JSON.stringify(main.inject));

console.log('\n=== ④ 子模块 ===');
for (const [rel, wantName] of [
  ['lib/agent-context.js', 'qq-agent-context'],
  ['lib/compact-chat.js', 'command-compact-chat'],
]) {
  const mod = await import(pathToFileURL(path.join(ROOT, rel)).href);
  check(`${rel} 导出 apply`, typeof mod.apply === 'function');
  check(`${rel} name = ${wantName}`, mod.name === wantName, mod.name);
  check(`${rel} inject 是数组`, Array.isArray(mod.inject), JSON.stringify(mod.inject));
}
for (const rel of ['lib/features/qq-bigfish.js', 'lib/features/thinking-zh.js']) {
  const mod = await import(pathToFileURL(path.join(ROOT, rel)).href);
  check(`${rel} 导出 mount`, typeof mod.mount === 'function');
  check(`${rel} 导出 id/title`, typeof mod.id === 'string' && typeof mod.title === 'string');
  check(`${rel} 的 routePath 用新前缀`,
    typeof mod.routePath === 'string' && mod.routePath.startsWith('/dsh-qq-companion/'), mod.routePath);
}

console.log('\n=== ⑤ client.js 的模块 id 与包名一致 ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
  check(`client.js 的模块 id = dsh-qq-companion`, src.includes("id: 'dsh-qq-companion'"));
  check(`client.js 的 exports.name 同步改了`, src.includes("exports.name = 'dsh-qq-companion'"));
  check('client.js 不再用旧的 /qq-dsh-panel/ 路由前缀',
    !src.includes("'/qq-dsh-panel/") && !src.includes('"/qq-dsh-panel/'));
}

console.log('\n=== ⑥ 预设 patch 的守卫引用 ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'presets/qq-chat-agent.patch.yml'), 'utf8');
  check('守卫行用 dsh-qq-companion/tool-restrict.mjs',
    src.includes('name: dsh-qq-companion/tool-restrict.mjs'));
  check('不再引用旧的 qq-agent-presets/', !src.includes('qq-agent-presets/'));
}

console.log('\n=== ⑦ 无残留旧包名（源码，不含注释）===');
{
  const files = [
    'lib/index.js', 'lib/client.js', 'lib/agent-context.js', 'lib/compact-chat.js',
    'lib/features/qq-bigfish.js', 'lib/features/thinking-zh.js',
    'cordis.patch.yml', 'presets/qq-chat-agent.patch.yml',
  ];
  // 白名单：findBridgeDir() 的候选列表刻意保留旧包名，用于兼容未升级的安装。
  // 那是「向后兼容的探测」，不是「还依赖旧插件」。
  const ALLOW = /for \(const name of \[[^\]]*qq-agent-presets[^\]]*\]\)/;
  let bad = 0;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (!/qq-agent-presets|qq-mode-console|qq-dsh-panel|dsh-command-compact-chat/.test(line)) continue;
      if (ALLOW.test(line)) continue;
      console.error(`    ⚠️ ${rel}: ${t.slice(0, 110)}`);
      bad += 1;
    }
  }
  check('源码里没有旧包名引用（兼容白名单除外）', bad === 0, `${bad} 处`);
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
