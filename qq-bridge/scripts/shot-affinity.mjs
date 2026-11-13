// 用 CDP 驱动本机 Edge 给控制台截图（本机没装 Playwright，Node 26 自带 WebSocket 足够）。
// 只用于开发时肉眼校验页面，不是测试套件的一部分。
//
// 用法：
//   node scripts/shot-affinity.mjs --pages=affinity --key=group:123456789
//   node scripts/shot-affinity.mjs --url="http://127.0.0.1:3100/?token=xxx" --key=group:20001
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const url = args.find((x) => x.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:4199/';
const outDir = args.find((x) => x.startsWith('--out='))?.slice(6) || join(here, '..', '.shots');
const pages = (args.find((x) => x.startsWith('--pages='))?.slice(8) || 'affinity').split(',');
const width = Number(args.find((x) => x.startsWith('--width='))?.slice(8) || 1440);
const height = Number(args.find((x) => x.startsWith('--height='))?.slice(9) || 1100);
const chatKey = args.find((x) => x.startsWith('--key='))?.slice(6) || 'group:123456789';

const EDGE = [
  join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
].find((p) => p && existsSync(p));
if (!EDGE) throw new Error('找不到 Edge');

mkdirSync(outDir, { recursive: true });
const profile = join(tmpdir(), 'dsh-edge-shot-' + Date.now());
const port = 9300 + Math.floor(Math.random() * 400);
const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('Edge CDP 没有起来');
}

const ws = new WebSocket(await getWsUrl());
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
  }
});
const send = (method, params = {}) => new Promise((res, reject) => {
  const id = ++seq;
  pending.set(id, { resolve: res, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');

const written = [];
for (const pageName of pages) {
  await send('Page.navigate', { url: url + '#' + pageName });
  await sleep(1800);
  // 触发一次渲染：好感度页靠切页事件拉数据，hash 直达时手动点一下导航。
  await send('Runtime.evaluate', {
    expression: `(() => {
      const nav = document.querySelector('[data-view="${pageName}"]');
      if (nav) nav.click();
      const inp = document.getElementById('affKey');
      if (inp && !inp.value.trim()) { inp.value = ${JSON.stringify(chatKey)}; }
      const sel = document.getElementById('affKeySelect');
      if (sel && sel.options.length > 1 && sel.value === '') {
        sel.value = ${JSON.stringify(chatKey)};
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return document.title;
    })()`,
    returnByValue: true,
  });
  await sleep(1600);
  // 如果还没加载，点一下刷新。
  await send('Runtime.evaluate', {
    expression: `(() => { const b=document.getElementById('affRefresh'); if(b && document.getElementById('affPeople')?.querySelector('.aff-empty')) b.click(); return true; })()`,
    returnByValue: true,
  });
  await sleep(1400);

  const metrics = await send('Page.getLayoutMetrics');
  const fullHeight = Math.min(Math.ceil(metrics.cssContentSize.height), 4200);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: fullHeight, scale: 1 },
  });
  const file = join(outDir, `console-${pageName}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  written.push(file);
  console.log(`saved ${file} (${width}x${fullHeight})`);
}

// 顺带把关键 DOM 状态打出来，确认不是"截图好看但数据没渲染"。
const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    peopleCards: document.querySelectorAll('#affPeople .aff-card').length,
    scaleSegs: document.querySelectorAll('#affScaleTrack .aff-scale-seg').length,
    stageItems: document.querySelectorAll('#affStages .aff-stage-item').length,
    editorHidden: document.getElementById('affEditor')?.hidden,
    scoreVal: document.getElementById('affScoreVal')?.textContent,
    badge: document.getElementById('affStageBadge')?.textContent,
    userOptions: document.getElementById('affUser')?.options.length,
    sliderMin: document.getElementById('affRange')?.min,
    sliderMax: document.getElementById('affRange')?.max,
    msg: document.getElementById('affMsg')?.textContent,
  })`,
  returnByValue: true,
});
console.log('DOM:', probe.result.value);
console.log('consoleErrors:', consoleErrors.length ? consoleErrors : 'none');

ws.close();
child.kill();
process.exit(0);
