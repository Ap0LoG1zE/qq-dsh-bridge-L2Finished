// 短句质量对比：「好可怕」这种 3 字短句在不同参数下是否清晰。
//
// 为什么单独测：短句是 GPT-SoVITS 最容易"糊"的场景 ——
//   上下文太短，音素时长估计不稳，容易连读成一团。
// 变量：speed（语速）、pause_second（句间停顿）、temperature（随机性）、top_k。
import fs from 'node:fs';
import path from 'node:path';
import { synthesize, TTS_DEFAULTS } from '../src/tts.js';

const text = process.argv[2] || '好可怕';
const outDir = path.join(process.cwd(), 'state', 'short-test');
fs.mkdirSync(outDir, { recursive: true });

const cases = [
  { tag: 'a-当前配置', speed: 0.85, pauseSecond: 0.4, temperature: 1, topK: 15 },
  { tag: 'b-降随机性', speed: 0.85, pauseSecond: 0.4, temperature: 0.6, topK: 10 },
  { tag: 'c-更稳', speed: 0.9, pauseSecond: 0.3, temperature: 0.5, topK: 8 },
  { tag: 'd-原速稳', speed: 1.0, pauseSecond: 0.3, temperature: 0.5, topK: 8 },
  { tag: 'e-慢且稳', speed: 0.8, pauseSecond: 0.3, temperature: 0.5, topK: 8 },
];

console.log(`文本: ${text}\n`);
for (const c of cases) {
  const cfg = { ...TTS_DEFAULTS, ...c, leadSilenceSec: 0, tailSilenceSec: 0 };
  const r = await synthesize(text, cfg, { cacheDir: path.join(outDir, c.tag), log: () => {} });
  const dst = path.join(outDir, `${c.tag}.wav`);
  fs.copyFileSync(r.path, dst);
  console.log(`${c.tag.padEnd(14)} speed=${c.speed} temp=${c.temperature} topK=${c.topK}  ${(fs.statSync(dst).size / 1024).toFixed(0)}KB`);
  console.log(`  → ${dst}`);
}
