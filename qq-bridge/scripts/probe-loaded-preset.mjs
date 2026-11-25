// 只读探针：不发唤醒、不打扰她，直接问运行中的 DSH「你加载的 preset 正文是什么」。
//
// 为什么能做：preset 是 loader 行，正文（persona.prefix）在 DSH 进程里是活的字符串。
// agentPresets/read 会把它渲染回 YAML —— 那就是**真正在用的那份**，
// 比读磁盘上的 patch 文件更权威（磁盘可能已经改了但 DSH 没重启）。
import { discoverDshSessionCookie } from '../src/dsh-client.js';

const BASE = process.argv[2] || process.env.DSH_BASE_URL || 'http://127.0.0.1:7520';
let failed = 0;
const ok = (l, v, d = '') => { console.log(`${v ? '✅' : '❌'} ${l}${d ? `  — ${d}` : ''}`); if (!v) failed += 1; };

async function rpc(cookie, method, args = {}) {
  const rpcId = `probe-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  });
  const t = await res.text();
  let b; try { b = JSON.parse(t); } catch { b = null; }
  if (res.status !== 200 || (b && b.error)) throw new Error(`${method}: HTTP ${res.status} ${b?.error?.message ?? t.slice(0, 200)}`);
  return b?.result?.value;
}

const cookie = discoverDshSessionCookie(BASE);
if (!cookie) { console.error('❌ 拿不到 DSH 会话 cookie'); process.exitCode = 1; }
else {
  console.log(`DSH: ${BASE}\n`);
  const list = await rpc(cookie, 'agentPresets/list');
  const presets = list?.presets ?? [];
  console.log(`已注册预设: ${presets.map((p) => p.id).join(', ') || '(无)'}`);
  for (const p of presets) if (p.broken) console.log(`   ⚠️ ${p.id} broken: ${p.broken}`);

  const doc = await rpc(cookie, 'agentPresets/read', { agentPreset: 'qq-chat-agent' });
  const text = String(doc?.content ?? '');

  console.log('\n── DSH 内存里实际加载的 preset 正文 ──');
  for (const [k, v] of [
    ['含 satiety（旧，应为 false）', text.includes('satiety')],
    ['含 ate=true（新，应为 true）', text.includes('ate=true')],
    ['含「第三项」（中性，应为 true）', text.includes('第三项')],
    ['含「性欲」（旧，应为 false）', text.includes('性欲')],
    ['含「饿不在这一项里」', text.includes('饿不在这一项里')],
  ]) ok(k, k.includes('应为') ? (v === k.includes('应为 true')) : v, String(v));
}
process.exitCode = failed === 0 ? 0 : 1;
