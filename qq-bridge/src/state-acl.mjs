// state/ 目录 ACL 收紧的**唯一实现**。
//
// 为什么单独成模块：这套逻辑原本在桥接进程（`src/bridge.js` 的 hardenStateDirAcl）和
// 安装脚本（`scripts/harden-state-acl.mjs`）里各写了一份，两份带着**同一个** bug：
//
//   icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /grant:r ... /T /C
//
// `(OI)(CI)` 是**目录专用**的继承标志。icacls 把它套到 `/T` 展开出来的**文件**上会失败，
// 而同一句里的 `/inheritance:r` 已经把文件原有的继承 ACE 摘掉了 —— 净结果是**子文件
// DACL 被清空，连属主自己都读不了**。实测后果：state/ 下 50 个子文件变成空 DACL，
// 桥接读不到自己的控制台令牌（"Access to the path ... is denied"），而启动日志只报
// 「未能收紧权限」，完全看不出已经造成了破坏。
//
// 第二个 bug 让第一个 bug 反复发生：回读自检用 `/\(I\)/.test(整段输出)` 判断「继承链是否
// 断干净」。但 DSH 的 ACL 沙箱会把工作区（含 state/）标记为 Low 完整性，而
// `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)` 这一行**永远**带 (I) ——
// 于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
//
// 合并成一份实现，从结构上杜绝两份逻辑再次漂移。
//
// 正确顺序是四步，缺一不可：
//   1. 目录上停止继承；
//   2. 按 **SID** 删除宽松主体（不受系统显示语言影响）；
//   3. 对**每一个**条目显式授权 —— 不带 (OI)(CI)，所以对文件同样有效；
//   4. 给目录补一份可继承 ACE，让以后新建的文件自动拿到权限。
// 最后自检由调用方按需做（{@link isHardened}）。

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Authenticated Users=S-1-5-11, BUILTIN\Users=S-1-5-32-545, Everyone=S-1-1-0
const PERMISSIVE_SIDS = ['*S-1-5-11', '*S-1-5-32-545', '*S-1-1-0'];

// 当前用户 / SYSTEM / Administrators —— 一律用 **SID** 授予。
// 绝不能再用 `process.env.USERNAME`：那只是账户名（`Ap0`），不带计算机名/域前缀。
// icacls 拿到裸名字时会把它当成**域/机器账户**解析，落出来的是 `AP0\:(F)` 这种
// **不存在的受托人** —— 于是文件被 `/inheritance:r` 摘掉继承 ACE 之后，
// 当前用户自己**没有任何一条有效授权**，连属主都读不了自己的文件。
// 实测后果：config.json 变成 DACL 只有 `Administrators / SYSTEM / AP0\` 三行，
// 桥接启动时报 `EPERM: operation not permitted, open ...\config.json` 直接退出，
// QQ 大肥鱼面板开始「读不到数据」。
// SID 形式（`*S-1-5-...`）与显示语言、账户改名、域/本地账户无关，是唯一稳的写法。
const SYSTEM_SID = '*S-1-5-18';
const ADMINS_SID = '*S-1-5-32-544';

/** icacls 的可执行封装（统一超时与隐藏窗口）。 */
export function icacls(args, timeout = 30000) {
  return spawnSync('icacls', args, { encoding: 'utf8', timeout, windowsHide: true });
}

/**
 * 取当前登录用户的受托人字符串（形如 `*S-1-5-21-...-1001`）。
 *
 * 优先 `whoami /user`：拿到的 SID 与显示语言、账户改名、本地/域账户都无关，
 * icacls 认 `*SID` 前缀时**不会再去做名字解析**，这是唯一不会解析错的写法。
 * 兜底才退回 `USERDOMAIN\USERNAME`（带域名前缀，至少不会被当成机器账户），
 * 最后才是裸 `USERNAME`——那一档本身就有上面写明的解析风险，仅作最后手段。
 */
export function currentUserTrustee() {
  if (process.platform !== 'win32') return null;
  try {
    const res = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const out = String(res.stdout ?? '').trim();
    // 输出形如：  "ap0\ap0","S-1-5-21-782781356-2425191667-1690788376-1001"
    const m = out.match(/"([^"]+)","(S-1-5-[\d-]+)"/);
    if (m && m[2]) return `*${m[2]}`;
  } catch { /* 落到下面的兜底 */ }
  const domain = process.env.USERDOMAIN;
  const name = process.env.USERNAME;
  if (domain && name) return `${domain}\\${name}`;
  if (name) return name;
  return null;
}

/**
 * icacls 输出里是否还有**继承来的权限** ACE。
 *
 * 必须排除 Mandatory Label 行：那不是权限，而且 DSH 沙箱打过 Low 标签后它永远带 (I)。
 * 用全文 `/\(I\)/` 扫描会把「已收紧」判成「未收紧」，进而让调用方反复重跑破坏性命令。
 */
export function hasInheritedPermissionAce(icaclsOutput) {
  return String(icaclsOutput ?? '')
    .split(/\r?\n/)
    .filter((line) => !/Mandatory Label/i.test(line))
    .some((line) => /\(I\)/.test(line));
}

/** 是否还有本机任意用户可读的宽松主体授权。 */
export function hasPermissiveTrustee(icaclsOutput) {
  return /Authenticated Users|BUILTIN\\Users|\bEveryone\b/i.test(String(icaclsOutput ?? ''));
}

/**
 * 目标对象是否**真的能被当前用户读到**。
 *
 * 为什么不用 `fs.accessSync(R_OK)`：实测在 DACL 被清空的文件上它照样返回成功
 * （Windows 上属主至少保有 READ_CONTROL/WRITE_DAC，access 判定会放行），
 * 而真正的 `readFileSync` 会 `EPERM`。必须**真读一次**才作数。
 */
function canActuallyRead(target) {
  let fd = null;
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      fs.readdirSync(target);
      return true;
    }
    fd = fs.openSync(target, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, 0);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关闭失败不影响判定 */ } }
  }
}

/**
 * 当前用户是否**确实**在 ACL 里拿到了一条有效授权。
 *
 * 这是「坏了但自称已收紧」的探测口。历史事故里文件 DACL 只剩
 * `Administrators / SYSTEM / AP0\`（`AP0\` 是不存在的受托人）。
 *
 * ⚠️ 两个踩过的坑：
 *   1. icacls 把**第一条 ACE 打印在路径同一行**（`<path> AP0\Ap0:(F)`），
 *      所以绝不能按行 slice 掉第一行来"去掉路径"，那会把当前用户的 ACE 一起丢掉
 *      —— 实测导致 `isHardened` 对已修好的文件永远返回 false。
 *   2. 受托人必须**以 `:` 结尾**才算数（`域\账户名:(F)`）。这条正是区分好坏 ACE 的关键：
 *      坏 ACE 是 `AP0\:(F)`（域有、账户名为空），它匹配不上 `\Ap0:` 这种形式。
 *
 * 判据同时认两种显示形态：SID（账户解析不了时才这样）与 `域\账户名`。
 */
export function grantsCurrentUser(icaclsOutput) {
  const trustee = currentUserTrustee();
  if (!trustee) return true;
  const text = String(icaclsOutput ?? '');

  if (trustee.startsWith('*') && text.includes(trustee.slice(1))) return true;

  const username = String(process.env.USERNAME ?? '').trim();
  if (!username) return trustee.startsWith('*') ? false : true;
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 必须紧跟冒号：`域\账户名:(权限)` 才是 ACE，路径里的 `\账户名\` 不会被误判。
  const generic = new RegExp(`[\\\\]${esc(username)}\\s*:`, 'i');
  const domain = String(process.env.USERDOMAIN ?? '').trim();
  if (domain) {
    const qualified = new RegExp(`\\b${esc(domain)}\\\\${esc(username)}\\s*:`, 'i');
    if (qualified.test(text)) return true;
  }
  return generic.test(text);
}

/**
 * 目标路径的权限是否已收紧：没有继承来的权限 ACE，没有宽松主体，
 * **当前用户自己确实还在授权名单里**，并且**真的读得到**。
 * @param {string} target - 目录或文件路径。
 */
export function isHardened(target) {
  if (process.platform !== 'win32') {
    try { return (fs.statSync(target).mode & 0o077) === 0; } catch { return false; }
  }
  const res = icacls([target], 10000);
  if (res.error || res.status !== 0) return false;
  const out = res.stdout ?? '';
  if (hasInheritedPermissionAce(out) || hasPermissiveTrustee(out)) return false;
  if (!grantsCurrentUser(out)) return false;
  // 最后一道也是最硬的一道：真读一次。
  // DACL 被清空时 icacls 依然会打印出文件名、退出码也是 0，只盯着输出会漏掉。
  return canActuallyRead(target);
}

/**
 * 收紧一个**目录**及其整棵子树的权限。
 * @param {string} dir - 目标目录。
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenDir(dir) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); return { ok: true, detail: 'chmod 700' }; }
    catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
  }
  const user = currentUserTrustee();
  if (!user) return { ok: false, detail: '无法确定当前用户（whoami /user 与 %USERDOMAIN%\\%USERNAME% 都拿不到）' };
  // ⚠️ 顺序很重要：**先授予、再摘继承**。
  //
  // 曾经的顺序是先 `/inheritance:r` 再 grant。一旦 grant 那一步失败（历史上就是
  // 裸 `%USERNAME%` 被当机器账户解析），整棵子树的继承 ACE 已经摘掉、新授权又没落上，
  // 结果是**所有文件当场变得谁都读不了** —— 而 icacls 的 `/C` 让退出码依然是 0。
  // 先显式授予（显式 ACE 不会被 `/inheritance:r` 摘掉），再断开继承，
  // 中途失败时当前用户至少还留着一条自己的 ACE，不会把数据锁死。
  const steps = [
    // 1) 先给当前用户 / SYSTEM / Administrators 落**显式**授权（不带 (OI)(CI)，对文件也有效）
    [dir, '/T', '/C', '/Q', '/grant', `${user}:F`, '/grant', `${SYSTEM_SID}:F`, '/grant', `${ADMINS_SID}:F`],
    // 2) 再断开继承（显式 ACE 保留）
    [dir, '/inheritance:r', '/C', '/Q'],
    // 3) 摘掉本机任意用户可读的宽松主体
    [dir, '/remove:g', ...PERMISSIVE_SIDS, '/T', '/C', '/Q'],
    // 4) 给目录补可继承 ACE，以后新建文件自动拿到权限
    [dir, '/Q', '/grant', `${user}:(OI)(CI)F`, '/grant', `${SYSTEM_SID}:(OI)(CI)F`, '/grant', `${ADMINS_SID}:(OI)(CI)F`]
  ];
  for (const args of steps) {
    const res = icacls(args);
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (res.error) return { ok: false, detail: res.error.message };
    // /C 会让 icacls 继续处理剩余文件、即使全失败退出码仍是 0，所以必须看输出。
    if (/access is denied/i.test(out)) {
      return { ok: false, detail: out.split('\n').filter(Boolean).slice(-3).join(' / ') };
    }
  }
  // 自检：属主必须仍能读到目录内容（防止把 DACL 清空这种"成功"的破坏）。
  if (!canActuallyRead(dir)) {
    return { ok: false, detail: '收紧后目录已不可读，请检查 ACL（DACL 可能被摘空了）' };
  }
  return { ok: true, detail: 'icacls' };
}

/**
 * 收紧一个**文件**的权限（凭据文件用；文件不能带 (OI)(CI)）。
 * @param {string} file - 目标文件。
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenFile(file) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); return { ok: true, detail: 'chmod 600' }; }
    catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
  }
  const user = currentUserTrustee();
  if (!user) return { ok: false, detail: '无法确定当前用户（whoami /user 与 %USERDOMAIN%\\%USERNAME% 都拿不到）' };
  const res = icacls([file, '/inheritance:r',
    '/grant:r', `${user}:F`, '/grant:r', `${SYSTEM_SID}:F`, '/grant:r', `${ADMINS_SID}:F`, '/C', '/Q']);
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.error) return { ok: false, detail: res.error.message };
  if (/access is denied/i.test(out)) {
    return { ok: false, detail: out.split('\n').filter(Boolean).slice(-2).join(' / ') };
  }
  // 自检：属主必须仍能读到文件本身。
  // 这是**关键的一步**：上面的 `/inheritance:r` 会先摘掉所有继承 ACE，
  // 如果随后的 grant 落空（历史上就是 `%USERNAME%` 被解析成 `AP0\` 那次），
  // 文件 DACL 会变成"谁都读不了"，而 icacls 退出码依然是 0，
  // 不读回就成了"报告成功、实际毁掉凭据文件"。修好的写法本该让这里必然通过。
  if (!canActuallyRead(file)) {
    return { ok: false, detail: '收紧后文件已不可读，请检查 ACL（DACL 可能被摘空了）' };
  }
  return { ok: true, detail: 'icacls' };
}

/**
 * 给人看的手动收紧命令（失败降级时打印）。
 *
 * 必须是**安全**的那一版：把 (OI)(CI) 授权和 /T 混在同一句里会把子文件 DACL 清空。
 */
export function manualDirCommand(dir) {
  if (process.platform !== 'win32') return `chmod -R go-rwx "${dir}"`;
  const d = `"${dir}"`;
  // 必须用 whoami 取 SID：`%USERNAME%` 是裸账户名，icacls 会把它当机器账户解析成
  // `AP0\`，于是授予落到一个不存在的受托人上，属主自己反而读不了（见文件头注释）。
  const user = currentUserTrustee() || '%USERDOMAIN%\\%USERNAME%';
  return [
    `icacls ${d} /inheritance:r /C /Q`,
    `icacls ${d} /remove:g "*S-1-5-11" "*S-1-5-32-545" "*S-1-1-0" /T /C /Q`,
    `icacls ${d} /T /C /Q /grant "${user}:F" /grant "*S-1-5-18:F" /grant "*S-1-5-32-544:F"`,
    `icacls ${d} /Q /grant "${user}:(OI)(CI)F" /grant "*S-1-5-18:(OI)(CI)F" /grant "*S-1-5-32-544:(OI)(CI)F"`
  ].join('\n             ');
}
