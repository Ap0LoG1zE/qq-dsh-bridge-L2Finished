// 安装 dsh-qq-companion 到 DSH desktop profile。
//
// 只做两件事（不要往 profile 的 cordis.patch.yml 追加 —— 那会和 bundle 重复注册，
// 2026-11-25 因此让 /compact-v2 一直不出现）：
//   ① 建 junction：~/.dsh/plugins/<name> 和 profile/node_modules/<name>
//   ② 登记进 profile package.json 的 dependencies + dsh.profile.bundles
//
// 用法：
//   node scripts/install-qq-companion.mjs           # 装
//   node scripts/install-qq-companion.mjs --dry     # 只看要做什么
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const PKG_NAME = 'dsh-qq-companion';

const DRY = process.argv.includes('--dry');
const HOME = os.homedir();
const PLUGINS = path.join(HOME, '.dsh', 'plugins', PKG_NAME);
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'desktop');
const NM = path.join(PROFILE, 'node_modules', PKG_NAME);
const PKG = path.join(PROFILE, 'package.json');

const log = (m) => console.log(`  ${m}`);

function link(linkPath, target) {
  const st = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (st) {
    if (st.isSymbolicLink()) {
      const cur = fs.readlinkSync(linkPath);
      if (path.resolve(cur.replace(/\\/g, '/')) === path.resolve(target)) {
        log(`✅ 已存在且指向正确: ${linkPath}`);
        return;
      }
      log(`⚠️ 已存在指向 ${cur}，重建`);
      if (!DRY) fs.unlinkSync(linkPath);
    } else {
      log(`⚠️ 已存在且不是链接（真实目录），跳过: ${linkPath}`);
      return;
    }
  }
  if (DRY) { log(`[dry] 建 junction: ${linkPath} -> ${target}`); return; }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'junction');
  log(`✅ 建 junction: ${linkPath} -> ${target}`);
}

function register() {
  const raw = fs.readFileSync(PKG, 'utf8');
  const hasBom = raw.charCodeAt(0) === 0xFEFF;
  const pkg = JSON.parse(hasBom ? raw.slice(1) : raw);
  const linkValue = `link:${PLUGINS.replace(/\\/g, '/')}`;
  const changed = [];

  pkg.dependencies = pkg.dependencies ?? {};
  if (pkg.dependencies[PKG_NAME] !== linkValue) {
    pkg.dependencies[PKG_NAME] = linkValue;
    changed.push('dependencies');
  }
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? [];
  if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) {
    pkg.dsh.profile.bundles.push(PKG_NAME);
    changed.push('bundles');
  }

  if (!changed.length) { log('✅ package.json 已登记'); return; }
  if (DRY) { log(`[dry] 更新 package.json: ${changed.join(', ')}`); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(PKG, `${PKG}.bak-qqcompanion-${stamp}`);
  fs.writeFileSync(PKG, (hasBom ? '\uFEFF' : '') + JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log(`✅ package.json 已更新（${changed.join(', ')}），备份 .bak-qqcompanion-${stamp}`);
}

console.log(`\n安装 ${PKG_NAME}${DRY ? '（dry-run）' : ''}`);
console.log(`  源:      ${SRC}`);
console.log(`  profile: ${PROFILE}\n`);

if (!fs.existsSync(path.join(SRC, 'lib', 'index.js'))) {
  console.error(`❌ 找不到插件源: ${SRC}\\lib\\index.js`);
  process.exit(1);
}
if (!fs.existsSync(PKG)) {
  console.error(`❌ 找不到 profile package.json: ${PKG}`);
  process.exit(1);
}

link(PLUGINS, SRC);
link(NM, PLUGINS);
register();

console.log('\n完成。');
if (!DRY) {
  console.log('下一步：重启 DSH（host 插件与预设只在启动时加载）。');
  console.log('重启后在面板里应该看到「思考链中文」「QQ 大肥鱼」两个开关；');
  console.log('聊天框里有 /compact_chat。');
}
