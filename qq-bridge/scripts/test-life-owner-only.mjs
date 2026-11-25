// 「第三项 / 生理期只对管理员开放」回归（2026-11-26）。
//
// 操作者口径：第三项和周期（生理期）都是**管理员私聊专属**。
// 群里不给、次要用户私聊也不给。
//
// 查出过两个洞：
//   ① 唤醒词 condLines 漏了 isOwner —— 痛经那句能原样贴进群聊（已修）
//   ② life-circle 端点只有「群聊不给」这一道闸 ——
//      次要用户私聊（allow.private 里非 ownerQQ 的）能读到、也能加第三项（本次修）
//
// 为什么必须真起服务器（照 test-memory-endpoint.mjs 的理由）：
//   node --check 查不出去引用、复刻逻辑的测试也查不出 —— 只有真把请求打进去，
//   才会走到那段代码。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const OWNER = 'private:10001';
const OTHER = 'private:20002';
const CONSOLE_TOKEN = 'fixture-console-token';

async function withServer(fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      consolePort: 0,
      consoleToken: CONSOLE_TOKEN,
      allow: { private: ['10001', '20002'], groups: [] },
      socialV2: { sticker: { enabled: false } },
      life: { enabled: true, circle: true, timezone: 'Asia/Shanghai' }
    }
  });
  h.setMode('reserved2');
  h.lifeCircleCacheReset();
  const srv = await h.startConsoleServer();
  await new Promise((resolve, reject) => {
    if (srv.listening) return resolve();
    srv.once('listening', resolve);
    srv.once('error', reject);
    setTimeout(() => reject(new Error('server 未能 listen（10s）')), 10000);
  });
  const { port } = srv.address();
  const headers = (token) => ({ 'x-agent-token': token, 'x-console-token': CONSOLE_TOKEN });
  try {
    return await fn(h, port, headers);
  } finally {
    await h.close();
    try { srv.close(); } catch {}
  }
}

/** 造一个「第三项拉满」的身体状态。 */
function seedHighDesire(h, now = Date.now()) {
  h.writeLifeCircle({
    v: 2, energy: 70, desire: 95,
    asleep: false, asleepSince: 0, lastTickedAt: now
  });
  h.lifeCircleCacheReset();
}

// ── 端点：读 ────────────────────────────────────────────────────────────────

test('管理员私聊：端点返回第三项', async () => {
  await withServer(async (h, port, headers) => {
    seedHighDesire(h);
    const token = h.getSocialV2State(OWNER).agentToken;
    const url = `http://127.0.0.1:${port}/api/socialV2/life-circle?key=${encodeURIComponent(OWNER)}`;
    const res = await fetch(url, { headers: headers(token) });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok('desire' in data.values, `管理员应当能看到第三项：${JSON.stringify(data.values)}`);
    assert.match(String(data.text || ''), /欲望/, `管理员应当看到第三项文案：${data.text}`);
  });
});

test('次要用户私聊：端点**不**返回第三项（数值和文案都不给）', async () => {
  await withServer(async (h, port, headers) => {
    seedHighDesire(h);
    const token = h.getSocialV2State(OTHER).agentToken;
    const url = `http://127.0.0.1:${port}/api/socialV2/life-circle?key=${encodeURIComponent(OTHER)}`;
    const res = await fetch(url, { headers: headers(token) });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal('desire' in data.values, false,
      `次要用户不该拿到第三项数值：${JSON.stringify(data.values)}`);
    assert.doesNotMatch(String(data.text || ''), /欲望/,
      `次要用户不该看到第三项文案：${data.text}`);
    // 但精力照常给 —— 不能因为挡第三项把整个功能关掉
    assert.ok('energy' in data.values, '精力照常返回');
  });
});

// ── 端点：写 ────────────────────────────────────────────────────────────────

test('次要用户私聊：加第三项被静默忽略（数值不动）', async () => {
  await withServer(async (h, port, headers) => {
    seedHighDesire(h);
    const before = h.readLifeCircle().desire;
    const token = h.getSocialV2State(OTHER).agentToken;
    const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/life-circle`, {
      method: 'POST',
      headers: { ...headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({ key: OTHER, add: { desire: 60 } })
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    h.lifeCircleCacheReset();
    const after = h.readLifeCircle().desire;
    assert.equal(Math.round(after), Math.round(before),
      `次要用户不该改得动第三项（${before} → ${after}）`);
  });
});

test('管理员私聊：加第三项正常生效（方向是**减**）', async () => {
  await withServer(async (h, port, headers) => {
    seedHighDesire(h);
    const before = h.readLifeCircle().desire;
    const token = h.getSocialV2State(OWNER).agentToken;
    await fetch(`http://127.0.0.1:${port}/api/socialV2/life-circle`, {
      method: 'POST',
      headers: { ...headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({ key: OWNER, add: { desire: 40 } })
    });
    h.lifeCircleCacheReset();
    const after = h.readLifeCircle().desire;
    assert.ok(after < before, `释放量应当让第三项下降（${before} → ${after}）`);
  });
});

// ── 唤醒词 ──────────────────────────────────────────────────────────────────

test('唤醒词：次要用户私聊不出现第三项和生理期', async () => {
  await withServer(async (h) => {
    seedHighDesire(h);
    // 造一条痛经 condition，验证 condLines 也被挡（这是 2026-11-26 修的第一个洞）
    h.writeLifeCond({
      list: [{
        id: 'discomfort-test', kind: 'cycle_discomfort',
        label: '今天有点痛经，小腹闷闷的不舒服', mood: '烦躁',
        energyDelta: -8, intensity: 70,
        startTs: Date.now() - 1000, endTs: Date.now() + 3600000,
        phase: 'menstrual', onEndTransition: '', transitionDone: false
      }],
      meta: {}
    });
    const prompt = h.buildWakePromptV2(OTHER, 'proactiveCheck:test');
    assert.doesNotMatch(prompt, /欲望/, `次要用户的唤醒词不该有第三项：${prompt.slice(0, 300)}`);
    assert.doesNotMatch(prompt, /痛经/, `次要用户的唤醒词不该有痛经：${prompt.slice(0, 300)}`);
  });
});

test('唤醒词：管理员私聊照常显示第三项', async () => {
  await withServer(async (h) => {
    seedHighDesire(h);
    const prompt = h.buildWakePromptV2(OWNER, 'proactiveCheck:test');
    assert.match(prompt, /欲望/, `管理员应当看到第三项：${prompt.slice(0, 400)}`);
  });
});

test('唤醒词：管理员私聊显示生理期，但**有具体不适时只说具体那条**', async () => {
  await withServer(async (h) => {
    h.writeLifeCond({
      list: [{
        id: 'discomfort-test', kind: 'cycle_discomfort',
        label: '今天有点痛经，小腹闷闷的不舒服', mood: '烦躁',
        energyDelta: -8, intensity: 70,
        startTs: Date.now() - 1000, endTs: Date.now() + 3600000,
        phase: 'menstrual', onEndTransition: '', transitionDone: false
      }],
      meta: {}
    });
    const prompt = h.buildWakePromptV2(OWNER, 'proactiveCheck:test');
    assert.match(prompt, /痛经/, '管理员应当看到具体不适');
    // 笼统那段（cycleMark）应当被具体不适压掉，不能两句话并存
    assert.doesNotMatch(prompt, /生理期到了，累、容易烦躁/,
      `有具体不适时不该再贴笼统的周期说明：${prompt.slice(0, 500)}`);
  });
});
