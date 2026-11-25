// 把 qq-compact-v2 插件挂进 DSH profile（desktop）。
//
// 做三件事（缺一不可，2026-11-15 踩过：少第三步插件根本不加载）：
//   ① 建两层 junction：~/.dsh/plugins/<name> 和 profile/node_modules/@local/<name>
//   ② 往 profile 的 cordis.patch.yml 追加 insert 条目
//   ③ 把 @local/qq-compact-v2 登记进 profile 的 package.json（dependencies + bundles）
//
// 用法：
//   node scripts/install-compact-v2.mjs            # 装
//   node scripts/install-compact-v2.mjs --dry      # 只看要做什么
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..', 'plugins', 'qq-compact-v2');
const NAME = 'qq-compact-v2';
const LOCAL_SCOPE = '@local';
const DRY = process.argv.includes('--dry');

const HOME = os.homedir();
const PLUGINS_ROOT = path.join(HOME, '.dsh', 'plugins');
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'desktop');
const L1 = path.join(PLUGINS_ROOT, NAME);
const L2 = path.join(PROFILE, 'node_modules', LOCAL_SCOPE, NAME);
const PATCH = path.join(PROFILE, 'cordis.patch.yml');
const PKG = path.join(PROFILE, 'package.json');

const log = (msg) => console.log(`  ${msg}`);

function ensureJunction(linkPath, target) {
  const st = fs.lstatSync(linkPath, { throwIfNoEntry: false });
  if (st) {
    if (st.isSymbolicLink()) {
      const cur = fs.readlinkSync(linkPath);
      if (path.resolve(cur.replace(/\\/g, '/')) === path.resolve(target)) {
        log(`✅ 已存在且指向正确: ${linkPath}`);
        return;
      }
      log(`⚠️ 已存在但指向 ${cur}，重建`);
      if (!DRY) fs.unlinkSync(linkPath);
    } else {
      log(`⚠️ 已存在且不是链接（是真实目录），跳过以免覆盖用户数据: ${linkPath}`);
      return;
    }
  }
  if (DRY) { log(`[dry] 会创建 junction: ${linkPath} -> ${target}`); return; }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'junction');
  log(`✅ 创建 junction: ${linkPath} -> ${target}`);
}

/**
 * 往 cordis.patch.yml 追加一条 insert。
 * 幂等：已有 id: qq-compact-v2 就不重复加。
 */
function ensurePatchEntry() {
  const raw = fs.readFileSync(PATCH, 'utf8');
  if (raw.includes('id: qq-compact-v2')) {
    log('✅ cordis.patch.yml 已含 qq-compact-v2 条目');
    return;
  }
  const block = [
    '',
    '# /compactV2：按「保留尾部 N 万 token」压缩（绕开 /compact 硬编码 retainTokens=0）',
    '- insert:',
    '    - id: qq-compact-v2',
    "      name: '@local/qq-compact-v2'",
    '      config:',
    '        retainTokens: 200000',
    '',
  ].join('\n');
  if (DRY) { log('[dry] 会往 cordis.patch.yml 追加 qq-compact-v2 条目'); return; }
  fs.writeFileSync(PATCH, raw.replace(/\s*$/, '\n') + block, 'utf8');
  log('✅ cordis.patch.yml 已追加 qq-compact-v2 条目');
}

/** 登记进 profile package.json（dependencies + bundles）。 */
function ensureProfileRegistration() {
  const raw = fs.readFileSync(PKG, 'utf8');
  const hasBom = raw.charCodeAt(0) === 0xFEFF;
  const pkg = JSON.parse(hasBom ? raw.slice(1) : raw);

  const depKey = `${LOCAL_SCOPE}/${NAME}`;
  const linkValue = `link:${L1.replace(/\\/g, '/')}`;
  let changed = [];

  pkg.dependencies = pkg.dependencies ?? {};
  if (pkg.dependencies[depKey] !== linkValue) {
    pkg.dependencies[depKey] = linkValue;
    changed.push('dependencies');
  }

  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? [];
  if (!pkg.dsh.profile.bundles.includes(depKey)) {
    pkg.dsh.profile.bundles.push(depKey);
    changed.push('bundles');
  }

  if (!changed.length) { log('✅ package.json 已登记'); return; }
  if (DRY) { log(`[dry] 会更新 package.json: ${changed.join(', ')}`); return; }

  // 备份
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(PKG, `${PKG}.bak-compactv2-${stamp}`);
  fs.writeFileSync(PKG, (hasBom ? '\uFEFF' : '') + JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log(`✅ package.json 已更新（${changed.join(', ')}），备份 .bak-compactv2-${stamp}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────
console.log(`\n安装 ${NAME} 到 DSH desktop profile${DRY ? '（dry-run）' : ''}`);
console.log(`  插件源: ${PLUGIN_DIR}`);
console.log(`  profile: ${PROFILE}\n`);

if (!fs.existsSync(path.join(PLUGIN_DIR, 'index.js'))) {
  console.error(`❌ 找不到插件源: ${PLUGIN_DIR}\\index.js`);
  process.exit(1);
}
if (!fs.existsSync(PATCH) || !fs.existsSync(PKG)) {
  console.error(`❌ profile 配置缺失：${PATCH} / ${PKG}`);
  process.exit(1);
}

ensureJunction(L1, PLUGIN_DIR);
ensureJunction(L2, L1);
ensurePatchEntry();
ensureProfileRegistration();

console.log('\n完成。');
if (!DRY) {
  console.log('\n下一步：');
  console.log('  1. 重启 DSH（预设和插件只在启动时加载）');
  console.log('  2. 在 DSH 里敲 /compactV2 dry 先看范围，确认无误再 /compactV2');
}
