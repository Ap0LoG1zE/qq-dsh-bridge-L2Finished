// tts.js 的离线/联网自测。不碰 QQ、不改桥接状态。
//   node scripts/test-tts.mjs           # 只测纯函数 + 服务探活（不强依赖服务在跑）
//   node scripts/test-tts.mjs --live    # 额外真合成一句，验证端到端
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TTS_DEFAULTS, normalizeTtsConfig, ttsAlive, ttsReady, synthesize } from '../src/tts.js';

let pass = 0;
const ok = (n) => { pass += 1; console.log(`✅ ${n}`); };

// 1. 默认配置形状
assert.equal(typeof TTS_DEFAULTS.baseUrl, 'string');
assert.equal(TTS_DEFAULTS.enabled, false, '默认必须是关闭的（纯语音是强表达，不能偷偷开）');
ok('默认关闭，且带 baseUrl/参考音频等默认值');

// 2. 覆盖合并：只给部分字段，其余保留默认
const merged = normalizeTtsConfig({ enabled: true, baseUrl: 'http://127.0.0.1:9999' });
assert.equal(merged.enabled, true);
assert.equal(merged.baseUrl, 'http://127.0.0.1:9999');
assert.equal(merged.refText, TTS_DEFAULTS.refText, '没给的字段应保留默认');
ok('配置合并：只覆盖给到的字段');

// 3. undefined 不该把默认值冲掉（历史 bug：{} 覆盖成 undefined）
const merged2 = normalizeTtsConfig({ enabled: undefined, baseUrl: undefined });
assert.equal(merged2.baseUrl, TTS_DEFAULTS.baseUrl);
ok('undefined 不会覆盖默认值');

// 4. pythonArgs 数组要原样保留
const merged3 = normalizeTtsConfig({ pythonArgs: ['-s', 'x.py', 'en'] });
assert.deepEqual(merged3.pythonArgs, ['-s', 'x.py', 'en']);
ok('pythonArgs 数组能透传');

// 5. 探活：服务不在时必须是"返回 false"，而不是抛错
const dead = await ttsAlive('http://127.0.0.1:59999', { timeoutMs: 800 });
assert.equal(dead, false);
ok('地址不通时 ttsAlive 返回 false（不抛错）');

// 6. 真实服务状态（有就报告，没有就跳过，不算失败）
const ready = await ttsReady(TTS_DEFAULTS.baseUrl);
console.log(`   （推理服务 ${TTS_DEFAULTS.baseUrl} 就绪：${ready ? '是' : '否'}）`);

// 7. --live：真合成一句，确认产物是能播的 WAV
if (process.argv.includes('--live')) {
  if (!ready) {
    console.log('   ⏭  跳过真合成：服务没在跑（先打开 GPT-SoVITS 的 TTS 推理 WebUI）');
  } else {
    const r = await synthesize('嗯……知道了。', { ...TTS_DEFAULTS, enabled: true }, {
      cacheDir: path.join('state', 'tts-test'),
      log: (m) => console.log('   ' + m),
    });
    assert.ok(fs.existsSync(r.path), '应产出音频文件');
    const buf = fs.readFileSync(r.path);
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF', '产物应是 WAV');
    ok(`真合成成功：${(buf.length / 1024).toFixed(0)} KB，${r.ms}ms`);
    // 8. 第二次应命中缓存（同一句话不重复合成）
    const r2 = await synthesize('嗯……知道了。', { ...TTS_DEFAULTS, enabled: true }, {
      cacheDir: path.join('state', 'tts-test'),
    });
    assert.equal(r2.cached, true, '同一句话第二次应命中缓存');
    ok('相同文本命中缓存（不重复合成）');
  }
}


// ── 回归（2026-11-21）：换行必须转成句号 ──────────────────────────────────
// 她发的那条 25 秒语音断在"和你分享生活中的各种"，后面 31 字全没了。
// 根因不是模型，是**预处理把换行当成空白压掉了**：
//   换行是她的分句信号，压成空格后变成一整段无标点长句，
//   how_to_cut='凑四句一切' 找不到边界 → 整段一次过模型 → 超长被截。
// 实测：同一段文本，压空格 22.82 秒（截断）；转句号 35.66 秒（完整）。
{
  const ttsSrc = fs.readFileSync(new URL('../src/tts.js', import.meta.url), 'utf8')
  assert.ok(
    ttsSrc.includes("replace(/\\s*\\n\\s*/g, '。')"),
    'tts.js 应把换行转成句号（否则长文本会被切句逻辑当成一整段，导致截断）',
  )
  // 反例：整段无标点的文本，必须能被预处理加上边界
  assert.ok(
    !/const clean = String\(text \?\? ''\)\.replace\(\/\\s\+\/g, ' '\)/.test(ttsSrc),
    '不该再直接把所有空白压成空格 —— 那会吃掉换行这个分句信号',
  )
}
ok('长文本换行转句号（防止超长被截断）')


// ── 回归（2026-11-21）：voice:true 参数链路 ────────────────────────────
// 操作者要求：她可以给 qq_send_message 带 voice:true 发语音；默认打字。
// 语音没开时**自动退回打字**（不报错、不吞消息）。
{
  const ROOT2 = new URL('..', import.meta.url)
  const bridgeSrc = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8')
  const mcpSrc = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')

  // ① 桥接：onebotSend 要有 wantVoice，判定必须是「她要求 + 开关开着」
  assert.ok(bridgeSrc.includes('wantVoice = false'), 'onebotSend 应接受 wantVoice 参数')
  assert.ok(bridgeSrc.includes('const canVoice = wantVoice === true'), '语音判定应以"她显式要求"为前置条件，不能只看全局开关')
  assert.ok(bridgeSrc.includes('opts.voice === true'), 'sendMessagesV2 应把 opts.voice 传给 onebotSend')
  assert.ok(bridgeSrc.includes('const wantVoice = body.voice === true;'), '发送端点应读 body.voice')

  // ② MCP 工具暴露 voice 参数
  assert.ok(mcpSrc.includes('voice: z.boolean().optional()'), 'qq_send_message 应暴露 voice 参数')
  assert.ok(mcpSrc.includes('voice: voice === true'), 'MCP 应把 voice 传给桥接端点')

  // ③ 不再叫「纯语音」
  assert.ok(!bridgeSrc.includes('纯语音'), 'bridge.js 不该再有「纯语音」字样')
  assert.ok(!mcpSrc.includes('纯语音'), 'mcp-snowluma-safe.js 不该再有「纯语音」字样')

  // ④ 降级路径：语音合成不了要退回文字，不能丢消息
  const i = bridgeSrc.indexOf('const recordSegment = canVoice')
  const seg = bridgeSrc.slice(i, i + 400)
  assert.ok(seg.includes("type: 'text'"), '语音不可用时应退回 text 段，不能吞掉消息')
}
ok('voice:true 参数链路（默认打字，语音开关未开自动降级）')

console.log(`\nTTS 测试通过：${pass} 项`);
