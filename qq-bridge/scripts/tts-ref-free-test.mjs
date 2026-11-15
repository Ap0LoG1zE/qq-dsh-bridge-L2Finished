// 复刻 WebUI 里的两种模式，对比「好可怕」的合成效果：
//   A. ref_free=False（我原来的做法）：传参考文本，模型用它当语义提示
//   B. ref_free=True （你截图里的做法）：参考文本留空，只用参考音频的音色
//
// 关键代码依据（inference_webui.py）：
//   if prompt_text is None or len(prompt_text)==0: ref_free = True   # 自动进 ref_free
//   if model_version in v3v4set: ref_free = False                   # v3/v4/v5 强制关
//   prompts = None if ref_free else prompt                          # ref_free 时不传语义
// 你的模型是 v2ProPlus，不在 v3v4set 里，所以 ref_free 真的会生效。
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:9872';
// 参考音频路径由环境变量提供（2026-11-15 开源清理）：
// 原来硬编码了作者本机路径，别人跑不了。
// 用法：set "TTS_REF_WAV=D:\audio\ref.wav"
const REF = process.env.TTS_REF_WAV || '';
if (!REF || !fs.existsSync(REF)) {
  console.error('请先设置环境变量 TTS_REF_WAV 指向一个参考音频文件（.wav）。');
  process.exit(1);
}
const REF_TEXT = process.env.TTS_REF_TEXT || 'ごめんなさい。バンド壊して、ギター下手で、ずっと謝りたかった';
const OUT = path.join('state', 'ref-free-test');
fs.mkdirSync(OUT, { recursive: true });

function parseSse(raw) {
  return String(raw).split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
}
function extract(raw) {
  const t = String(raw).trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch {} }
  const ev = parseSse(t);
  for (let i = ev.length - 1; i >= 0; i -= 1) { try { return JSON.parse(ev[i]); } catch {} }
  return null;
}

// 上传参考音频（/gradio_api/upload 是 404，必须用 /upload）
async function upload(file) {
  const buf = readFileSync(file);
  for (const ep of ['/gradio_api/upload', '/upload']) {
    const fd = new FormData();
    fd.append('files', new Blob([buf]), path.basename(file));
    const r = await fetch(BASE + ep, { method: 'POST', body: fd });
    if (!r.ok) continue;
    const j = await r.json();
    const p = Array.isArray(j) ? j[0] : (j?.files?.[0] ?? j?.[0]);
    if (typeof p === 'string' && p) return p;
  }
  throw new Error('上传失败');
}

async function tts({ text, refText, refFree, tag }) {
  const info = await (async () => {
    const html = await (await fetch(BASE + '/')).text();
    const at = html.indexOf('window.gradio_api_info = ');
    const start = html.indexOf('{', at);
    let d = 0, s = false, e = false, end = -1;
    for (let i = start; i < html.length; i += 1) {
      const c = html[i];
      if (s) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') s = false; continue; }
      if (c === '"') { s = true; continue; }
      if (c === '{') d += 1; else if (c === '}') { d -= 1; if (d === 0) { end = i + 1; break; } }
    }
    return JSON.parse(html.slice(start, end));
  })();
  const params = info.named_endpoints['/get_tts_wav'].parameters;
  const serverPath = await upload(REF);

  const values = {
    ref_wav_path: { path: serverPath, meta: { _type: 'gradio.FileData' } },
    prompt_text: refText,
    prompt_language: '日文',
    text,
    text_language: '中文',
    how_to_cut: '凑四句一切',
    top_k: 15, top_p: 1, temperature: 1, ref_free: refFree,
    speed: 0.85, if_freeze: false, inp_refs: null, sample_steps: 8,
    if_sr: false, pause_second: 0.4, use_cuda_graph: true, use_flash_attention: true, cfg_rate: 0.0,
  };
  const data = params.map((p) => (p.parameter_name in values ? values[p.parameter_name]
    : (p.parameter_has_default ? p.parameter_default : null)));

  const res = await fetch(BASE + '/api/get_tts_wav', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }), signal: AbortSignal.timeout(180000),
  });
  const raw = await res.text();
  const last = extract(raw);
  const list = Array.isArray(last?.data) ? last.data : [last?.data];
  const audio = list.find((f) => f && (f.path || f.url));
  if (!audio) { console.log(`  ✗ ${tag} 失败：${raw.slice(0, 150)}`); return; }
  const url = audio.url || `${BASE}/file=${encodeURIComponent(audio.path)}`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const dst = path.join(OUT, `${tag}.wav`);
  fs.writeFileSync(dst, buf);
  console.log(`  ✓ ${tag}  ${(buf.length / 1024).toFixed(0)}KB  → ${dst}`);
}

const text = process.argv[2] || '好可怕';
console.log(`文本: ${text}\n`);
console.log('=== A. ref_free=False（传参考文本，我原来的做法）===');
await tts({ text, refText: REF_TEXT, refFree: false, tag: 'A-ref_free_false' });
console.log('\n=== B. ref_free=True（参考文本留空，你截图的做法）===');
await tts({ text, refText: '', refFree: true, tag: 'B-ref_free_true' });
