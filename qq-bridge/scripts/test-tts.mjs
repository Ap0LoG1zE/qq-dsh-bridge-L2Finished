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

console.log(`\nTTS 测试通过：${pass} 项`);
