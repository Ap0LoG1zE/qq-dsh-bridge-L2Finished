// 本机 GPT-SoVITS 推理客户端（真实可用版）。
//
// 踩过的三个坑，全部记在这里，别再重复：
//   坑 1：主 WebUI 在 9874，**不能**直接合成；推理服务在 9872。
//   坑 2：参数个数/顺序不能猜。要从页面里 window.gradio_api_info 的
//         named_endpoints["/get_tts_wav"].parameters **按名字**取，
//         正则扫 HTML 会把后面别的端点参数也扫进来（表现为多出重复的
//         prompt_language/text_language，然后 500）。
//   坑 3：ref_wav_path 不能直接给本机绝对路径 —— 服务端把它当
//         gradio.FileData 处理，必须**先上传**拿到服务端路径，否则
//         函数内部报错，而 gradio 的 show_error=false 只会回 {"error":null}，
//         看起来像"参数全对但就是不行"。
//
// 用法：
//   node scripts/tts-client.mjs "嗯……知道了"
//   node scripts/tts-client.mjs "…" --out=D:\x.wav --lang=中文
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, dflt = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const BASE = arg('base', 'http://127.0.0.1:9872');
const REF_DIR = 'D:\\Desktop\\角色A AI';
// 默认用页面里已经配好的那一对（参考文本与音频对得上）。
const REF = arg('ref', path.join(REF_DIR, '(A)そよたちのライブの日なら会えると思う(2).wav'));
const REF_TEXT = arg('reftext', 'そよたちのライブの日なら会えると思う');
const REF_LANG = arg('reflang', '日文');
const TEXT_LANG = arg('lang', '中文');
const OUT = arg('out', path.join('state', '_say.wav'));
const TEXT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '嗯……知道了。';

/** 从页面里把 gradio_api_info 当作 JSON 解析（不用正则猜结构）。 */
async function readApiInfo() {
  const html = await (await fetch(BASE + '/')).text();
  const key = 'window.gradio_api_info = ';
  const at = html.indexOf(key);
  if (at < 0) throw new Error('页面里没有 gradio_api_info（服务结构变了？）');
  const start = html.indexOf('{', at);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('gradio_api_info 括号不配对');
}

/** 把本地文件上传给 gradio，返回服务端可读的路径。 */
async function upload(file) {
  const buf = fs.readFileSync(file);
  const name = path.basename(file);
  for (const ep of ['/gradio_api/upload', '/upload']) {
    try {
      const fd = new FormData();
      fd.append('files', new Blob([buf]), name);
      const res = await fetch(BASE + ep, { method: 'POST', body: fd });
      if (!res.ok) continue;
      const j = await res.json();
      const p = Array.isArray(j) ? j[0] : j?.files?.[0] ?? j?.[0];
      if (typeof p === 'string' && p) return p;
    } catch {}
  }
  throw new Error('上传参考音频失败（/upload 与 /gradio_api/upload 都没成功）');
}

function parseSse(raw) {
  return String(raw).split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
}

/**
 * 取出「一次合成的结果」。
 *
 * ⚠️ 这个版本的 gradio 回的是**纯 JSON**，不是 SSE（`event: ... / data: ...`）。
 * 早期版本/别的部署可能是 SSE，所以两种都认：先试 JSON，失败再按 SSE 解。
 * 踩过：只按 SSE 解析，明明 HTTP 200、音频也生成了，却报"没有 SSE 数据"。
 */
function extractResult(raw) {
  const text = String(raw).trim();
  // 1) 纯 JSON
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const j = JSON.parse(text);
      return Array.isArray(j) ? j[j.length - 1] : j;
    } catch {}
  }
  // 2) SSE
  const ev = parseSse(text);
  for (let i = ev.length - 1; i >= 0; i -= 1) {
    try {
      const j = JSON.parse(ev[i]);
      if (Array.isArray(j)) return j[j.length - 1];
      if (j && (j.data || j.output)) return j;
    } catch {}
  }
  return null;
}

/** 按参数名构造 data 数组：顺序完全由服务端声明决定。 */
function buildData(params, values) {
  return params.map((p) => {
    const n = p.parameter_name;
    if (n in values) return values[n];
    return p.parameter_has_default ? p.parameter_default : null;
  });
}

async function main() {
  const info = await readApiInfo();
  const ep = info.named_endpoints?.['/get_tts_wav'];
  if (!ep) throw new Error('服务没有 /get_tts_wav');
  const params = ep.parameters;
  console.log(`服务声明参数 ${params.length} 个: ${params.map((p) => p.parameter_name).join(', ')}`);

  if (!fs.existsSync(REF)) throw new Error(`参考音频不存在：${REF}`);
  const serverPath = await upload(REF);
  console.log(`参考音频已上传 → ${serverPath}`);

  const values = {
    ref_wav_path: { path: serverPath, meta: { _type: 'gradio.FileData' } },
    prompt_text: REF_TEXT,
    prompt_language: REF_LANG,
    text: TEXT,
    text_language: TEXT_LANG,
    how_to_cut: '不切',
    top_k: 15,
    top_p: 1,
    temperature: 1,
    ref_free: false,
    speed: 1.0,
    if_freeze: false,
    inp_refs: null,
    sample_steps: 8,
    if_sr: false,
    pause_second: 0.3,
    use_cuda_graph: true,
    use_flash_attention: true,
    cfg_rate: 0.0,
    sovits_path: 'SoVITS_weights_v5dev/Mujica_若葉睦_v2pp.pth',
  };
  const data = buildData(params, values);

  console.log(`\n合成: ${TEXT}（${TEXT_LANG}）`);
  const t0 = Date.now();
  const res = await fetch(BASE + '/api/get_tts_wav', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const raw = await res.text();
  console.log(`HTTP ${res.status} · ${Date.now() - t0}ms`);
  const last = extractResult(raw);
  if (!last) {
    console.error('原始响应:', raw.slice(0, 600));
    throw new Error('响应解不出来（既不是 JSON 也不是 SSE）');
  }
  const list = Array.isArray(last.data) ? last.data : [last.data];
  const audio = list.find((f) => f && (f.path || f.url));
  if (!audio) {
    console.error('返回:', JSON.stringify(last).slice(0, 800));
    throw new Error('响应里没有音频');
  }

  // 下载音频：优先用返回的 url，其次按 gradio 的 file 端点拼。
  const url = audio.url || `${BASE}/file=${encodeURIComponent(audio.path)}`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, buf);
  console.log(`✅ ${(buf.length / 1024).toFixed(1)} KB → ${OUT}（${buf.subarray(0, 4).toString('ascii')}）`);
}

main().catch((e) => { console.error('❌', e?.message ?? e); process.exitCode = 1; });
