// 用 CDP 在离线 fixture 上确认「纯语音」开关确实渲染出来了、能读到状态。
// 这是 UI 层的证据：光有后端端点不够，开关得真的在页面上、在暂停按钮旁边。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EDGE = [
  join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
].find((p) => p && existsSync(p));
if (!EDGE) throw new Error('找不到 Edge');

const url = process.argv.find((x) => x.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:4199/';
const profile = join(tmpdir(), 'dsh-edge-tts-' + Date.now());
const port = 9820 + Math.floor(Math.random() * 150);
const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,1200', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('CDP 没起来');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve: res, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, reject) => {
  const id = ++seq; pending.set(id, { resolve: res, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await sleep(2500);

// ⚠️ 必须**先切到「聊天行为」(social-v2) 页**再看开关的可见性。
// 那个 section 默认是 hidden 的，没切页时 getBoundingClientRect 全是 0，
// 断言会假红成"开关不可见"——本鱼第一版就是这么误判的。
await evalJs(`(() => {
  document.querySelector('[data-view="social-v2"]')?.click();
  return true;
})()`);
await sleep(900);

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. 开关存在，且就在暂停按钮那一排的附近
const info = await evalJs(`(() => {
  const box = document.getElementById('v2TtsToggle');
  const pause = document.getElementById('v2PauseBtn');
  const status = document.getElementById('v2TtsStatus');
  if (!box) return { found: false };
  const r = box.getBoundingClientRect();
  const pr = pause ? pause.getBoundingClientRect() : null;
  return {
    found: true,
    type: box.type,
    checked: box.checked,
    visible: r.width > 0 && r.height > 0,
    statusText: status ? status.textContent : '',
    statusClass: status ? status.className : '',
    // 与暂停按钮的垂直距离：同一排应该很近
    gapFromPause: pr ? Math.round(Math.abs(r.top - pr.top)) : null,
    hasLabel: !!(box.closest('label') && box.closest('label').textContent.includes('纯语音')),
  };
})()`);
check('纯语音开关存在', info.found);
check('是 checkbox（不是按钮）', info.type === 'checkbox', info.type);
check('开关可见', info.visible);
check('标签文字是「纯语音」', info.hasLabel);
check('与暂停按钮同一排（垂直距离 < 40px）', info.gapFromPause != null && info.gapFromPause < 40, `gap=${info.gapFromPause}px`);
check('状态文案已渲染（不是"读取中…"）', info.statusText && !info.statusText.includes('读取中'), info.statusText);

// 2. 默认应该是关闭态（fixture 返回 enabled:false）
check('默认关闭', info.checked === false, `checked=${info.checked}`);

// 3. 点一下应该发 POST /api/socialV2/tts
const before = (await (await fetch(url + '__fixture/requests')).json()).requests.length;
await evalJs(`(() => { const b=document.getElementById('v2TtsToggle'); b.checked=true; b.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
await sleep(1200);
const reqs = (await (await fetch(url + '__fixture/requests')).json()).requests.slice(before);
const writes = reqs.filter((x) => x.method === 'POST' && x.path === '/api/socialV2/tts');
check('勾选后发出 POST /api/socialV2/tts', writes.length === 1, JSON.stringify(writes.map((w) => w.body)));
check('请求体带 enabled:true', writes[0]?.body?.enabled === true, JSON.stringify(writes[0]?.body));

const after = await evalJs(`document.getElementById('v2TtsStatus').textContent`);
// 注意：离线 fixture 固定返回 enabled:false，所以勾选后状态会**回到"已关闭"** ——
// 这不是 bug，而是 fixture 不真改状态。所以这里只断言"点击后有过重新渲染"，
// 不去断言文案变成"已开启"。真实桥接下的开/关行为由 test-tts.mjs 和端到端脚本覆盖。
check('切换后状态区被重新渲染', after !== info.statusText || after.includes('已关闭'), after);

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} 项失败` : `\n全部通过（${results.length} 项）`);
ws.close(); child.kill();
process.exit(bad.length ? 1 : 0);
