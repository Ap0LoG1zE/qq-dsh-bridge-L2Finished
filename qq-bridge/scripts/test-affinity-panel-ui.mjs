// 用 CDP 在离线 fixture 上验证好感度滑条真的能用：拖动、保存、快捷跳档、点卡片。
// 会读取 DOM 与 fixture 记录的写请求，确认「拖一下就落盘一次」而不是狂写。
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
const profile = join(tmpdir(), 'dsh-edge-aff-' + Date.now());
const port = 9700 + Math.floor(Math.random() * 200);
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
await send('Page.navigate', { url: url + '#affinity' });
await sleep(2200);
await evalJs(`(() => {
  document.querySelector('[data-view="affinity"]')?.click();
  const inp = document.getElementById('affKey');
  if (inp && !inp.value.trim()) inp.value = 'group:123456789';
  document.getElementById('affRefresh')?.click();
  return true;
})()`);
await sleep(1500);

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. 基础渲染
check('卡片渲染 4 人', (await evalJs(`document.querySelectorAll('#affPeople .aff-card').length`)) === 4);
check('滑条范围 -20~600', (await evalJs(`(() => { const r=document.getElementById('affRange'); return r.min+','+r.max; })()`)) === '-20,600');

// 2. 拖动（input 事件）只改界面，不发请求
const writesBefore = await (await fetch(url + '__fixture/requests')).json();
const dragResult = await evalJs(`(() => {
  const r = document.getElementById('affRange');
  r.value = '120';
  r.dispatchEvent(new Event('input', { bubbles: true }));
  return { score: document.getElementById('affScoreVal').textContent, badge: document.getElementById('affStageBadge').textContent,
           mark: document.getElementById('affScaleMark').style.left };
})()`);
check('拖动后分数立刻变 120', dragResult.score === '120', JSON.stringify(dragResult));
check('拖动后徽章变「依赖」', dragResult.badge === '依赖', dragResult.badge);
// 刻度针的位置必须按**当前跨度**算，不能写死一个百分比。
// 历史上这条断言写的是「> 60%」—— 那是 200 分上限时代的值（(120+20)/220≈63.6%）。
// 上限放开到 600 之后同一个 120 分只对应 22.58%，断言就假红了。
// 正确的口径：(score - min) / (max - min)。
const expectMarkPct = ((120 - (-20)) / (600 - (-20))) * 100;
check(
  '刻度针跟着走（按当前跨度换算）',
  Math.abs(parseFloat(dragResult.mark) - expectMarkPct) < 0.5,
  `${dragResult.mark}（期望约 ${expectMarkPct.toFixed(2)}%）`,
);
await sleep(400);
const writesAfterDrag = await (await fetch(url + '__fixture/requests')).json();
const dragWrites = writesAfterDrag.requests.length - writesBefore.requests.length;
check('拖动本身不写盘（松手才写）', dragWrites === 0, `input 期间新增 ${dragWrites} 次写请求`);

// 3. 松手（change）→ 落盘一次
const beforeChange = writesAfterDrag.requests.length;
await evalJs(`(() => { const r=document.getElementById('affRange'); r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await sleep(900);
const afterChange = await (await fetch(url + '__fixture/requests')).json();
const changeWrites = afterChange.requests.slice(beforeChange).filter((x) => x.method === 'POST' && x.path === '/api/socialV2/affinity');
check('松手后写入 1 次', changeWrites.length === 1, `实际 ${changeWrites.length} 次：${JSON.stringify(changeWrites.map((w) => w.body))}`);
check('写入内容 score=120', changeWrites[0]?.body?.score === 120, JSON.stringify(changeWrites[0]?.body));
check('写入内容带 key 和 userId', !!changeWrites[0]?.body?.key && !!changeWrites[0]?.body?.userId, JSON.stringify(changeWrites[0]?.body));

// 4. 快捷跳档
const beforeQuick = (await (await fetch(url + '__fixture/requests')).json()).requests.length;
await evalJs(`(() => { document.querySelector('[data-aff-stage="reliant"]')?.click(); return true; })()`);
await sleep(900);
const afterQuick = (await (await fetch(url + '__fixture/requests')).json()).requests;
const quickWrites = afterQuick.slice(beforeQuick).filter((x) => x.method === 'POST' && x.path === '/api/socialV2/affinity');
check('快捷跳「依赖」写入 score=90', quickWrites[0]?.body?.score === 90, JSON.stringify(quickWrites.map((w) => w.body)));

// 4b. 五档都要能通过"跳到"按钮写进去：这是面板上把档位改成任意一级的唯一入口，
// 少一档就等于那一档在界面上不可达（喜欢档 400 分尤其容易漏，之前上限被夹在 200 时
// 就有过"拖到 500 一保存弹回 200"的事故）。
const jumpResults = [];
for (const [stage, expectScore] of [['distant', -20], ['neutral', 0], ['caring', 30], ['reliant', 90], ['lover', 400]]) {
  const before = (await (await fetch(url + '__fixture/requests')).json()).requests.length;
  await evalJs(`(() => { document.querySelector('[data-aff-stage="${stage}"]')?.click(); return true; })()`);
  await sleep(600);
  const reqs = (await (await fetch(url + '__fixture/requests')).json()).requests.slice(before);
  const w = reqs.filter((x) => x.method === 'POST' && x.path === '/api/socialV2/affinity');
  jumpResults.push({ stage, ok: w[0]?.body?.score === expectScore, got: w[0]?.body?.score });
}
check('五档「跳到」按钮都能写入且分值正确', jumpResults.every((r) => r.ok), JSON.stringify(jumpResults));

// 5. 点卡片切换人
const picked = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('#affPeople .aff-card')];
  const target = cards.find(c => c.dataset.affUser === '10002');
  target.click();
  return { sel: document.getElementById('affUser').value, score: document.getElementById('affScoreVal').textContent,
           badge: document.getElementById('affStageBadge').textContent };
})()`);
check('点卡片切到 10002', picked.sel === '10002', JSON.stringify(picked));
check('切换后滑条显示该人的 96 分', picked.score === '96', picked.score);
check('切换后高亮跟随', (await evalJs(`document.querySelector('#affPeople .aff-card.is-active')?.dataset.affUser`)) === '10002');

// 6. 只读接口没被误伤：GET 仍可用
const getR = await (await fetch(url + 'api/socialV2/affinity?key=group:123456789&userId=10002')).json();
check('GET 单人形态正常', getR.ok && getR.score === 96, `${getR.stageLabel} ${getR.score}`);

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} 项失败` : `\n全部通过（${results.length} 项）`);
ws.close(); child.kill();
process.exit(bad.length ? 1 : 0);
