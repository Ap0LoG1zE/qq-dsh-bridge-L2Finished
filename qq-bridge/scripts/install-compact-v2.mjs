// 把 qq-compact-v2 插件挂进 DSH profile（desktop）。
//
// ── 只需两步（2026-11-25 更正）──────────────────────────────────────────────
//
//   ① 建两层 junction：~/.dsh/plugins/<name> 和 profile/node_modules/@local/<name>
//   ② 把 @local/qq-compact-v2 登记进 profile 的 package.json
//      （dependencies + dsh.profile.bundles）
//
// ⚠️ **不要**再往 profile 的 cordis.patch.yml 追加 insert —— 本脚本上一版
//    这么做过，结果 /compact-v2 根本没出现。原因是该插件自带
//    `cordis.patch.yml`（package.json 的 dsh.bundle.patch 指向它），
//    bundle 机制会自己注入；再手写一份等于**重复注册同一个 id**，
//    DSH 那边直接不加载（对比：能正常工作的 qq-agent-context 在 profile 的
//    patch 里**一条都没有**，只靠 bundles 注册）。
//
// 用法：
//   node scripts/install-compact-v2.mjs            # 装（幂等）
//   node scripts/install-compact-v2.mjs --dry      # 只看要做什么
//   node scripts/install-compact-v2.mjs --cleanup  # 清掉旧版误加的 patch 条目
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..', 'plugins', 'qq-compact-v2');
const NAME = 'qq-compact-v2';
const LOCAL_SCOPE = '@local';
const DRY = process.argv.includes('--dry');
const CLEANUP = process.argv.includes('--cleanup');

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

/** 登记进 profile package.json（dependencies + bundles）—— 这是唯一的注册途径。 */
function ensureProfileRegistration() {
  const raw = fs.readFileSync(PKG, 'utf8');
  const hasBom = raw.charCodeAt(0) === 0xFEFF;
  const pkg = JSON.parse(hasBom ? raw.slice(1) : raw);

  const depKey = `${LOCAL_SCOPE}/${NAME}`;
  const linkValue = `link:${L1.replace(/\\/g, '/')}`;
  const changed = [];

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

  if (!changed.length) { log('✅ package.json 已登记（bundles 是唯一注册途径）'); return; }
  if (DRY) { log(`[dry] 会更新 package.json: ${changed.join(', ')}`); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(PKG, `${PKG}.bak-compactv2-${stamp}`);
  fs.writeFileSync(PKG, (hasBom ? '\uFEFF' : '') + JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log(`✅ package.json 已更新（${changed.join(', ')}），备份 .bak-compactv2-${stamp}`);
}

/** 清掉旧版脚本误加进 profile patch 的条目（重复注册会让插件不加载）。 */
function cleanupPatchEntry() {
  const raw = fs.readFileSync(PATCH, 'utf8');
  if (!raw.includes(NAME)) { log('✅ profile patch 里没有本插件的条目（正确状态）'); return; }

  const block = /\n?# \/compact-v2：[^\n]*\n- insert:\n {4}- id: qq-compact-v2\n {6}name: '@local\/qq-compact-v2'\n {6}config:\n {8}retainTokens: \d+\n/;
  if (!block.test(raw)) {
    log('⚠️ patch 里有 qq-compact-v2 但格式不匹配，请手工检查');
    return;
  }
  if (DRY) { log('[dry] 会从 profile patch 移除 qq-compact-v2 条目'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(PATCH, `${PATCH}.bak-remove-dup-${stamp}`);
  fs.writeFileSync(PATCH, raw.replace(block, '\n'), 'utf8');
  log(`✅ 已从 profile patch 移除 qq-compact-v2（避免与 bundle 重复注册），备份 .bak-remove-dup-${stamp}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────
console.log(`\n安装 ${NAME} 到 DSH desktop profile${DRY ? '（dry-run）' : ''}`);
console.log(`  插件源: ${PLUGIN_DIR}`);
console.log(`  profile: ${PROFILE}\n`);

if (!fs.existsSync(path.join(PLUGIN_DIR, 'index.js'))) {
  console.error(`❌ 找不到插件源: ${PLUGIN_DIR}\\index.js`);
  process.exit(1);
}
if (!fs.existsSync(PKG)) {
  console.error(`❌ profile 配置缺失：${PKG}`);
  process.exit(1);
}

cleanupPatchEntry();
ensureJunction(L1, PLUGIN_DIR);
ensureJunction(L2, L1);
ensureProfileRegistration();

console.log('\n完成。');
if (!DRY) {
  console.log('\n下一步：');
  console.log('  1. 重启 DSH（插件只在启动时加载 —— 这一步不能省）');
  console.log('  2. 在 DSH 里敲 /compact-v2 dry 先看范围');
  console.log('\n注意：如果 /compact-v2 还是不出现，先确认 DSH 的启动时间晚于本次安装。');
}
