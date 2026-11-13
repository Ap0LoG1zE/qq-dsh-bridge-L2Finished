// 端到端：**真的起一个 HTTP 服务**调 /api/socialV2/memory，而不是复刻逻辑。
//
// 为什么必须真起服务器：2026-11-10 的事故是端点内部引用了已删除的变量
// （sharedSt is not defined），
//   · node --check 查不出（语法合法）
//   · 复刻一套"等价逻辑"的测试也查不出（复刻的那份是对的）
// 只有真正把请求打进去，才会走到那段出错的代码。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const P = 'private:10001';
const G = 'group:20001';
const CONSOLE_TOKEN = 'fixture-console-token';

async function withServer(fn) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      consolePort: 0,
      consoleToken: CONSOLE_TOKEN,
      // 白名单：harness 默认只放 123/456，这里必须把要测的两个会话放进去，
      // 否则端点会以「目标不在当前模式允许范围内」(403) 提前返回，测不到记忆逻辑。
      allow: { private: ['10001', '123'], groups: ['456', '20001'] },
      socialV2: { sticker: { enabled: false } },
    },
  });
  h.setMode('reserved2');
  const srv = await h.startConsoleServer();
  // 等 listen 完成：consolePort:0 由系统分配，必须从 address() 取实际端口
  await new Promise((resolve, reject) => {
    if (srv.listening) return resolve();
    srv.once('listening', resolve);
    srv.once('error', reject);
    setTimeout(() => reject(new Error('server 未能 listen（10s）')), 10000);
  });
  const { port } = srv.address();
  // MCP 侧的真实调用会同时带 x-console-token 与 x-agent-token（见 mcp-snowluma-safe.js 的 agentApi）：
  //   控制台令牌过全局鉴权，agent token 过会话绑定。
  const headers = (token) => ({ 'x-agent-token': token, 'x-console-token': CONSOLE_TOKEN });
  try {
    return await fn(h, port, headers);
  } finally {
    await h.close();
    try { srv.close(); } catch {}
  }
}

test('GET /api/socialV2/memory 返回 200 而不是 500', async () => {
  await withServer(async (h, port, headers) => {
    const token = h.getSocialV2State(P).agentToken;
    const g = h.getSocialV2State('global');
    g.selfNotes = [{ text: '我不喜欢被叫大肥鱼', createdAt: Date.now(), lastTouchedAt: Date.now() }];
    g.memberImpressions = {
      10001: { traits: ['会问我睡没睡'], name: '主人', interactionCount: 3, lastSeenAt: Date.now() },
    };
    h.getSocialV2State(P).activeTopics = [{ text: '在聊奶茶', lastMentionAt: Date.now() }];

    const url = `http://127.0.0.1:${port}/api/socialV2/memory?key=${encodeURIComponent(P)}`;
    const res = await fetch(url, { headers: headers(token) });
    const body = await res.json();

    assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${JSON.stringify(body).slice(0, 300)}`);
    assert.equal(body.ok, true, `端点应成功，错误：${body.error || '(无)'}`);
    const text = String(body.formatted || '');
    assert.ok(text.includes('在聊奶茶'), '应包含进行中的话题');
    assert.ok(text.includes('会问我睡没睡'), '应包含群友印象');
    assert.ok(text.includes('我不喜欢被叫大肥鱼'), '应包含自我认知');
  });
});

test('按 category 查询也返回 200，且不串类别', async () => {
  await withServer(async (h, port, headers) => {
    const token = h.getSocialV2State(P).agentToken;
    const g = h.getSocialV2State('global');
    g.memberImpressions = { 10001: { traits: ['标记A'], name: '主人', interactionCount: 1, lastSeenAt: Date.now() } };
    h.getSocialV2State(P).activeTopics = [{ text: '标记B', lastMentionAt: Date.now() }];

    const get = async (qs) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/memory?key=${encodeURIComponent(P)}${qs}`, {
        headers: headers(token),
      });
      return { status: res.status, body: await res.json() };
    };

    const onlyTopic = await get('&category=activeTopic');
    assert.equal(onlyTopic.status, 200);
    assert.ok(String(onlyTopic.body.formatted).includes('标记B'));
    assert.ok(!String(onlyTopic.body.formatted).includes('标记A'), '查话题时不该带出印象');

    const onlyImp = await get('&category=memberImpression');
    assert.equal(onlyImp.status, 200);
    assert.ok(String(onlyImp.body.formatted).includes('标记A'));
  });
});

test('facts 端点返回 200，且 forgotten 字段存在', async () => {
  await withServer(async (h, port, headers) => {
    const token = h.getSocialV2State(P).agentToken;
    const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/facts?key=${encodeURIComponent(P)}`, {
      headers: headers(token),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `facts 端点期望 200，实际 ${res.status}：${JSON.stringify(body).slice(0, 300)}`);
    assert.ok(Array.isArray(body.facts), '应有 facts 数组');
    assert.ok(Array.isArray(body.forgotten), '应有 forgotten 数组（「已经忘掉的」提示靠它）');
  });
});

test('写记忆端点也不 500（append 全类别）', async () => {
  await withServer(async (h, port, headers) => {
    const token = h.getSocialV2State(P).agentToken;
    const post = async (payload) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/memory-append`, {
        method: 'POST',
        headers: { ...headers(token), 'content-type': 'application/json' },
        body: JSON.stringify({ key: P, ...payload }),
      });
      return { status: res.status, body: await res.json() };
    };

    for (const [label, payload] of [
      ['selfNote', { category: 'selfNote', content: '测试自我认知' }],
      ['activeTopic', { category: 'activeTopic', content: '测试话题' }],
      ['pendingThought', { category: 'pendingThought', content: '测试想法' }],
      ['memberImpression', { category: 'memberImpression', content: '测试印象', extra: { target: '小明' } }],
      ['longTerm', { category: 'longTerm', content: '测试长期事实', extra: { tag: 'misc' } }],
    ]) {
      const r = await post(payload);
      assert.equal(r.status, 200, `${label} 写入应成功，实际 ${r.status}：${JSON.stringify(r.body).slice(0, 200)}`);
      assert.equal(r.body.ok, true, `${label} 返回 ok:false：${r.body.error || ''}`);
    }
  });
});
