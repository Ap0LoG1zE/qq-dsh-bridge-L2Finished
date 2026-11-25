// qq-agent-context 的离线契约测试：**首轮就能拿到【令牌】**。
//
// 钉住的是 2026-11-17 那次修复的核心时序（不看活进程，纯离线）：
//
//   桥接写 `state.sessions[key] = sessionId` 发生在 `api.sessions.create()` **之后**，
//   而 `agent/created` 在 create 内部就派发完了。于是：
//     ① 建会话那一刻问桥接 → 必然 404；
//     ② 旧实现「拿到数据才 install」→ 段不注册 → 首轮系统提示词永远没有令牌；
//     ③ 新实现「无条件注册段 + 装配时兜底刷新」→ 首次装配（prompt 投递之后）拿到。
//
// 三个场景各一条：
//   · 冷启动 404 之后转成功（就是线上真实时序）→ 第一次装配必须带令牌；
//   · 一直是 404（GUI 会话、子 agent）→ 不得每步都打请求，且装配不能报错；
//   · 桥接直接连不上 → 装配不抛错，恢复后能补上（不许把异常泄漏到回合里）。
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 2026-11-25：合并进 dsh-qq-companion 后，身份注入的实现搬到它的 lib/agent-context.js。
// 这里的契约测试只关心那个模块本身（name / inject / apply），所以直接指向它。
const PLUGIN = path.join(ROOT, '..', 'dsh-plugins', 'dsh-qq-companion', 'lib', 'agent-context.js');

const TOKEN = 'abc123def4567890';
const CONTEXT_TEXT = `【你的身份】QQ 3346197751，昵称 mutsumi。\n\n【令牌】私聊84420221（主人） → key "private:84420221"，token ${TOKEN}`;

const mod = await import(pathToFileURL(PLUGIN).href);

/** 一个只有本测试用到的那几个方法的假 Cordis 上下文。 */
function makeHarness() {
  const agents = new Map();
  const createdListeners = [];
  const disposedListeners = [];
  const teardowns = [];
  const ctx = {
    agents: { list: () => [...agents.values()] },
    on: (name, fn) => {
      if (name === 'agent/created') createdListeners.push(fn);
      else if (name === 'agent/disposed') disposedListeners.push(fn);
      return () => {};
    },
    // Cordis 的 effect：回调返回 teardown，唯一由 fiber 生命周期调用。
    // 插件**不返回**dispose（apply 无返回值），所以测试只能从这里拿卸载能力 ——
    // 早先版本误以为 apply 返回 dispose，导致 4 条用例全红。
    effect: (fn) => {
      const teardown = fn();
      if (typeof teardown === 'function') teardowns.push(teardown);
      return () => {};
    },
  };
  return {
    ctx,
    agents,
    /** 复刻 "插件被卸载/重载"：跑一遍登记过的 teardown。 */
    async unload() {
      for (const td of teardowns.splice(0)) await td();
    },
    async createAgent(id) {
      const sections = [];
      const assembleListeners = [];
      const disposers = [];
      const agent = {
        id,
        ctx: {
          inject: (_deps, cb) => {
            const scope = {
              systemPrompt: {
                section: (s) => {
                  sections.push({ ...s, get text() { return typeof s.text === 'function' ? s.text() : s.text; } });
                  const d = () => { const i = sections.findIndex((x) => x.name === s.name); if (i >= 0) sections.splice(i, 1); };
                  disposers.push(d);
                  return d;
                },
              },
              on: (name, fn) => {
                if (name === 'system-prompt/assemble') assembleListeners.push(fn);
                return () => {};
              },
            };
            const fiber = cb(scope);
            return { dispose: () => { for (const d of disposers.splice(0)) d(); return fiber; } };
          },
        },
      };
      agents.set(id, agent);
      for (const fn of createdListeners) await fn({ agent, source: 'fresh' });
      return {
        agent,
        sections,
        /** 跑一次装配 waterfall，返回最终渲染用的 section 文本（模拟 renderPrompt 的取值）。 */
        async assemble() {
          // 复刻 dsh-system-prompt：先按注册快照算 sections，再进 waterfall。
          const assembly = {
            sections: sections.map((s) => ({ name: s.name, text: s.text, interpolate: s.interpolate })),
            contexts: [],
            variables: {},
          };
          const inner = async () => assembly;
          const run = async (i) => {
            if (i >= assembleListeners.length) return inner();
            return assembleListeners[i](assembly, { agent, scope: agent }, () => run(i + 1));
          };
          const out = await run(0);
          // renderPrompt：interpolate:false 的原样取文本
          return out.sections.map((s) => s.text).filter((t) => t.length > 0).join('\n\n');
        },
        async dispose() { agents.delete(id); for (const fn of disposedListeners) await fn({ agent }); },
      };
    },
  };
}

/** 假桥接。/api/socialV2/agent-context 的行为由 state 控制。 */
async function startBridge() {
  const state = { registered: false, hits: 0, expectedToken: '' };
  const server = http.createServer((req, res) => {
    state.hits++;
    if (state.expectedToken && req.headers['x-console-token'] !== state.expectedToken) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    if (!state.registered) {
      // 桥接此刻还没写 sessions.json —— 线上就是这个 404。
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unknown session' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, key: 'private:84420221', text: CONTEXT_TEXT }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 令牌文件：写一个真的进临时目录，保证插件走的是读盘那条路。 */
function writeTokenFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-context-'));
  const file = path.join(dir, 'console-token');
  fs.writeFileSync(file, 'console-token-value\n', 'utf8');
  return file;
}

test('导出契约：name / inject / apply', () => {
  assert.equal(mod.name, 'qq-agent-context');
  assert.deepEqual(mod.inject, ['systemPrompt', 'agents']);
  assert.equal(typeof mod.apply, 'function');
});

test('线上真实时序：agent/created 时 404，首次装配必须已带令牌', async () => {
  const bridge = await startBridge();
  const tokenFile = writeTokenFile();
  const h = makeHarness();
  mod.apply(h.ctx, { bridgeUrl: bridge.url, tokenFile });
  try {
    const a = await h.createAgent('session-A');

    // ① 建会话那一刻桥接还没登记 —— 插件不得因此放弃注册段。
    assert.equal(bridge.state.hits, 0, 'agent/created 阶段不该再去问桥接（问了也是 404，还拖慢建会话）');
    assert.equal(a.sections.length, 1, 'agent/created 必须无条件注册提示词段，否则首轮永远是空的');
    assert.equal(a.sections[0].name, 'qq:session-context');

    // ② 桥接登记（= ensureSession 里 create() 返回之后写 state.sessions）后第一次装配。
    bridge.state.registered = true;
    const first = await a.assemble();
    assert.ok(first.includes('【令牌】'), `第一次装配就必须带令牌，实际：${JSON.stringify(first.slice(0, 120))}`);
    assert.ok(first.includes(TOKEN), '令牌值要完整出现在系统提示词里');
    assert.ok(first.includes('private:84420221'), 'key 必须一起给，光有令牌没法发言');

    // ③ 之后是热缓存：再装配不该重复打请求。
    const hitsAfterFirst = bridge.state.hits;
    await a.assemble();
    assert.equal(bridge.state.hits, hitsAfterFirst, '热缓存下每一步装配不应再发请求（每步都发会拖慢回合）');
  } finally {
    await h.unload();
    await bridge.close();
  }
});

test('非 QQ 会话（一直 404）：装配不报错，且不每步都打请求', async () => {
  const bridge = await startBridge();
  const tokenFile = writeTokenFile();
  const h = makeHarness();
  mod.apply(h.ctx, { bridgeUrl: bridge.url, tokenFile });
  try {
    const a = await h.createAgent('session-gui');
    for (let i = 0; i < 5; i++) {
      const text = await a.assemble();
      assert.equal(text, '', '没有内容时 section 应为空（renderPrompt 会丢掉空段）');
    }
    // 5 次连续装配只该问 1 次：负结果带冷却，否则 GUI 会话每步一个 404。
    assert.equal(bridge.state.hits, 1, `负结果必须带冷却，实际请求 ${bridge.state.hits} 次`);
  } finally {
    await h.unload();
    await bridge.close();
  }
});

test('桥接连不上：装配不抛错，桥接恢复后能补上', async () => {
  const bridge = await startBridge();
  const deadUrl = bridge.url;
  await bridge.close(); // 端口关掉，模拟桥接没启动
  const tokenFile = writeTokenFile();
  const h = makeHarness();
  mod.apply(h.ctx, { bridgeUrl: deadUrl, tokenFile });
  try {
    const a = await h.createAgent('session-B');
    const text = await a.assemble();
    assert.equal(text, '', '连不上桥接时装配应返回空段，绝不能把异常泄漏到回合里');
  } finally {
    await h.unload();
  }
});

test('agent/disposed 之后段与缓存一起撤掉', async () => {
  const bridge = await startBridge();
  bridge.state.registered = true;
  const tokenFile = writeTokenFile();
  const h = makeHarness();
  mod.apply(h.ctx, { bridgeUrl: bridge.url, tokenFile });
  try {
    const a = await h.createAgent('session-C');
    assert.ok((await a.assemble()).includes(TOKEN));
    await a.dispose();
    assert.equal(a.sections.length, 0, 'dispose 后段必须撤回，否则复用同一 id 的新会话会读到旧令牌');
  } finally {
    await h.unload();
    await bridge.close();
  }
});
