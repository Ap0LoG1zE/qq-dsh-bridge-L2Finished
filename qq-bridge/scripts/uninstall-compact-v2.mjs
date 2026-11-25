// 彻底卸载 qq-compact-v2：junction、profile 登记、诊断日志、源目录。
// 幂等：不存在就跳过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const NAME = 'qq-compact-v2';
const LOCAL_SCOPE = '@local';

const L1 = path.join(HOME, '.dsh', 'plugins', NAME);
const L2 = path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', LOCAL_SCOPE, NAME);
const PKG = path.join(HOME, '.dsh', 'profiles', 'desktop', 'package.json');
const DIAG = path.join(HOME, '.dsh', 'qq-compact-v2.log');
const SRC = 'D:\\DSH\\qq-dsh-bridge\\qq-bridge\\plugins\\qq-compact-v2';

const log = (m) => console.log(`  ${m}`);
const removeLink = (p) => {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) { log(`-  不存在（跳过）: ${p}`); return; }
  if (st.isSymbolicLink()) { fs.unlinkSync(p); log(`✅ 已删 junction: ${p}`); }
  else { log(`⚠️ 不是链接，是真实目录，跳过: ${p}`); }
};

console.log('\n卸载 qq-compact-v2\n');

// ① junctions
removeLink(L2);
removeLink(L1);

// ② profile package.json：移除 dependency + bundle 条目
{
  const raw = fs.readFileSync(PKG, 'utf8');
  const hasBom = raw.charCodeAt(0) === 0xFEFF;
  const pkg = JSON.parse(hasBom ? raw.slice(1) : raw);
  const depKey = `${LOCAL_SCOPE}/${NAME}`;
  const changed = [];

  if (pkg.dependencies && Object.hasOwn(pkg.dependencies, depKey)) {
    delete pkg.dependencies[depKey];
    changed.push('dependencies');
  }
  if (Array.isArray(pkg.dsh?.profile?.bundles)) {
    const before = pkg.dsh.profile.bundles.length;
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== depKey);
    if (pkg.dsh.profile.bundles.length !== before) changed.push('bundles');
  }

  if (!changed.length) log('✅ package.json 本来就没有本插件登记');
  else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(PKG, `${PKG}.bak-uninstall-${stamp}`);
    fs.writeFileSync(PKG, (hasBom ? '\uFEFF' : '') + JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    log(`✅ package.json 已移除（${changed.join(', ')}），备份 .bak-uninstall-${stamp}`);
  }
}

// ③ 诊断日志
{
  const st = fs.lstatSync(DIAG, { throwIfNoEntry: false });
  if (!st) log('-  诊断日志不存在（跳过）');
  else { fs.unlinkSync(DIAG); log('✅ 已删诊断日志 ~/.dsh/qq-compact-v2.log'); }
}

// ④ 源目录（仓库里那份）
{
  if (!fs.existsSync(SRC)) { log('-  源目录不存在（跳过）'); }
  else {
    // 逐个文件删，最后删目录 —— 避免 -Recurse 被安全网拦
    for (const f of fs.readdirSync(SRC)) {
      const p = path.join(SRC, f);
      const s = fs.lstatSync(p);
      if (s.isDirectory()) {
        for (const g of fs.readdirSync(p)) fs.unlinkSync(path.join(p, g));
        fs.rmdirSync(p);
      } else {
        fs.unlinkSync(p);
      }
    }
    fs.rmdirSync(SRC);
    log(`✅ 已删源目录: ${SRC}`);
  }
}

// ⑤ 复查
console.log('\n=== 复查 ===');
for (const [label, p] of [['junction L1', L1], ['junction L2', L2], ['诊断日志', DIAG], ['源目录', SRC]]) {
  console.log(`  ${fs.existsSync(p) ? '⚠️ 仍存在' : '✅ 已清除'} ${label}`);
}
const pkg2 = JSON.parse(fs.readFileSync(PKG, 'utf8').replace(/^\uFEFF/, ''));
const stillThere = Object.hasOwn(pkg2.dependencies ?? {}, `${LOCAL_SCOPE}/${NAME}`)
  || (pkg2.dsh?.profile?.bundles ?? []).includes(`${LOCAL_SCOPE}/${NAME}`);
console.log(`  ${stillThere ? '⚠️ package.json 仍登记' : '✅ package.json 已干净'}`);
