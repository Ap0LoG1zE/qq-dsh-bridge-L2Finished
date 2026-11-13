// 复现 "zzz好帅" 的合成问题，并对比不同语种设置。
//
// 怀疑点：文本含拉丁字母 "zzz" + 中文 "好帅"，如果 text_language 是纯"中文"，
// 服务端的中文分词器可能把 "zzz" 处理成一串无意义音素（听起来像"喝喝喝"），
// 甚至因为认不出而整句退化。
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:9872';
const REF = 'D:\\Desktop\\角色A AI\\ごめんなさい。バンド壊して、ギター下手で、ずっと謝りたかった(2).wav';
const OUT = path.join('state', 'lang-test');
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

async function apiInfo() {
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
}

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

const info = await apiInfo();
const params = info.named_endpoints['/get_tts_wav'].parameters;
const serverPath = await upload(REF);

async function tts({ text, textLang, tag, refFree = true, howToCut = '凑四句一切' }) {
  const values = {
    ref_wav_path: { path: serverPath, meta: { _type: 'gradio.FileData' } },
    prompt_text: '',           // ref_free 模式下留空
    prompt_language: '日文',
    text,
    text_language: textLang,
    how_to_cut: howToCut,
    top_k: 15, top_p: 1, temperature: 1, ref_free: refFree,
    speed: 0.85, if_freeze: false, inp_refs: null, sample_steps: 8,
    if_sr: false, pause_second: 0.4, use_cuda_graph: true, use_flash_attention: true, cfg_rate: 0.0,
  };
  const data = params.map((p) => (p.parameter_name in values ? values[p.parameter_name]
    : (p.parameter_has_default ? p.parameter_default : null)));

  const t0 = Date.now();
  const res = await fetch(BASE + '/api/get_tts_wav', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }), signal: AbortSignal.timeout(180000),
  });
  const raw = await res.text();
  const ms = Date.now() - t0;
  const last = extract(raw);
  const list = Array.isArray(last?.data) ? last.data : [last?.data];
  const audio = list.find((f) => f && (f.path || f.url));
  if (!audio) { console.log(`  ✗ ${tag}（${textLang}）失败：${raw.slice(0, 120)}`); return; }
  const url = audio.url || `${BASE}/file=${encodeURIComponent(audio.path)}`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const dst = path.join(OUT, `${tag}.wav`);
  fs.writeFileSync(dst, buf);
  console.log(`  ✓ ${tag.padEnd(26)} ${textLang.padEnd(6)} ${(buf.length / 1024).toFixed(0)}KB ${ms}ms`);
}

const text = 'zzz好帅';
console.log(`文本: "${text}"\n`);
console.log('=== 不同 text_language 对比 ===');
await tts({ text, textLang: '中文', tag: '1-中文' });
await tts({ text, textLang: '中英混合', tag: '2-中英混合' });
await tts({ text, textLang: '多语种混合', tag: '3-多语种混合' });

console.log('\n=== 对照：纯中文短句（应正常）===');
await tts({ text: '好帅', textLang: '中文', tag: '4-纯中文-好帅' });
