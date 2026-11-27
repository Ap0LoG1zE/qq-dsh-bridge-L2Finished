// SnowLuma 账号自动注入（2026-11-27）。
//
// 起因：操作者的流程是「点启动 SnowLuma → 打开 WebUI → 手动选 3346197751 注入」，
// 后两步每次都是同样的操作。改成点一次就做完。
//
// 这里测的是**纯逻辑**（不碰真 WebUI）：用假 fetch 模拟 SnowLuma 的三个接口，
// 断言「按 uin 匹配进程 → 只对没注入的那个 load」这条链。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  snowlumaAutoInject,
  snowlumaWebuiLogin,
  resetSnowlumaWebuiAuth,
} from './snowluma-inject.js';

/** 装一个假 fetch：按 URL 分派，记录调用。 */
function fakeFetch(handlers, calls) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const h = handlers[key];
    if (!h) return { ok: false, status: 404, async json() { return null; } };
    const r = typeof h === 'function' ? h(init) : h;
    return { ok: r.status < 400, status: r.status, async json() { return r.body; } };
  };
}

/** 标准三接口：登录 + 进程列表 + load。 */
function standardHandlers({ list, loginStatus = 200, loadStatus = 200 }) {
  return {
    'POST /api/login': { status: loginStatus, body: loginStatus === 200 ? { success: true, token: 'tok-1' } : { success: false, message: '密码错误' } },
    'GET /api/processes': { status: 200, body: { list } },
    'POST /api/processes/123/load': { status: loadStatus, body: { success: loadStatus === 200 } },
  };
}

test('按 account.uin 匹配进程，只对没注入的那个 load', async () => {
  resetSnowlumaWebuiAuth();
  const calls = [];
  const origFetch = globalThis.fetch;
  fakeFetch(standardHandlers({
    list: [
      { pid: 111, account: { uin: '10001' }, injected: true, connected: true, uin: '10001' },
      { pid: 123, account: { uin: '20002' }, injected: false, connected: false, uin: '0' },
    ],
  }), calls);
  try {
    const r = await snowlumaAutoInject({ port: 5099, password: 'pw', uin: '20002' });
    assert.equal(r.ok, true);
    assert.equal(r.found, true);
    assert.equal(r.pid, 123, '必须挑 20002 那个进程');
    assert.equal(r.injected, true);
    assert.equal(r.already, false, '它不是"already"，是真注入了');
    const loads = calls.filter((c) => c.key.endsWith('/load'));
    assert.equal(loads.length, 1, '只 load 一次');
    assert.ok(loads[0].key.includes('/123/'), 'load 的是 20002 那个 pid');
  } finally { globalThis.fetch = origFetch; }
});

test('已经注入过的直接跳过，不发 load', async () => {
  resetSnowlumaWebuiAuth();
  const calls = [];
  const origFetch = globalThis.fetch;
  fakeFetch(standardHandlers({
    list: [{ pid: 123, account: { uin: '20002' }, injected: true, connected: true, uin: '20002' }],
  }), calls);
  try {
    const r = await snowlumaAutoInject({ port: 5099, password: 'pw', uin: '20002' });
    assert.equal(r.ok, true);
    assert.equal(r.already, true, '应当报 already');
    assert.equal(calls.filter((c) => c.key.endsWith('/load')).length, 0, '不该重复注入');
  } finally { globalThis.fetch = origFetch; }
});

test('进程列表里没这个号 → ok 但 found=false，并给出可选的号', async () => {
  resetSnowlumaWebuiAuth();
  const origFetch = globalThis.fetch;
  fakeFetch(standardHandlers({
    list: [{ pid: 111, account: { uin: '10001' }, injected: true, uin: '10001' }],
  }), []);
  try {
    const r = await snowlumaAutoInject({ port: 5099, password: 'pw', uin: '99999' });
    assert.equal(r.ok, true, '找不到不是错误 —— 只是 QQ 没开');
    assert.equal(r.found, false);
    assert.deepEqual(r.candidates, ['10001'], '要能说出现在有哪几个号');
  } finally { globalThis.fetch = origFetch; }
});

test('密码错 → ok=false 且带原因', async () => {
  resetSnowlumaWebuiAuth();
  const origFetch = globalThis.fetch;
  fakeFetch(standardHandlers({ list: [], loginStatus: 401 }), []);
  try {
    const r = await snowlumaAutoInject({ port: 5099, password: 'bad', uin: '20002' });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /密码错误/);
  } finally { globalThis.fetch = origFetch; }
});

test('没配 uin / 没配密码 → 立刻返回，不发任何请求', async () => {
  resetSnowlumaWebuiAuth();
  const calls = [];
  const origFetch = globalThis.fetch;
  fakeFetch({}, calls);
  try {
    const a = await snowlumaAutoInject({ port: 5099, password: 'pw', uin: '' });
    assert.equal(a.ok, false);
    assert.match(String(a.error), /autoInjectUin/);
    const b = await snowlumaAutoInject({ port: 5099, password: '', uin: '20002' });
    assert.equal(b.ok, false);
    assert.match(String(b.error), /webuiPassword/);
    assert.equal(calls.length, 0, '不该发任何请求');
  } finally { globalThis.fetch = origFetch; }
});

test('登录令牌会缓存：同一密码不重复登录', async () => {
  resetSnowlumaWebuiAuth();
  const calls = [];
  const origFetch = globalThis.fetch;
  fakeFetch(standardHandlers({
    list: [{ pid: 123, account: { uin: '20002' }, injected: false, uin: '0' }],
  }), calls);
  try {
    await snowlumaWebuiLogin(5099, 'pw');
    await snowlumaWebuiLogin(5099, 'pw');
    const logins = calls.filter((c) => c.key === 'POST /api/login');
    assert.equal(logins.length, 1, '第二次应当走缓存，不再登录');
  } finally { globalThis.fetch = origFetch; }
});
