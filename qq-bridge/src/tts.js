// 文字转语音（TTS）：把她要说的话合成成睦的声音。
//
// 为什么单独一层，而不是塞进 bridge.js：
//   bridge.js 已经 1.4 万行，"怎么跟 GPT-SoVITS 说话"是一块可独立测试的能力，
//   和"发不发得出去"没有关系。这里只做三件事：**合成**、**守护进程**、**缓存**。
//
// 本机实测出来的契约（别再猜，猜错了就是 500 且看不到原因）：
//   · 推理服务在 127.0.0.1:9872（主 WebUI 在 9874，那个不能直接合成）
//   · 接口 POST /api/get_tts_wav，参数顺序必须**按服务声明的名字**构造
//   · 参考音频必须先上传（**`/upload`**，注意 `/gradio_api/upload` 在这个版本是 404）
//   · 这个版本回的是**纯 JSON**，不是 SSE（老版本才是 SSE，两种都兼容）
//   · gradio 配了 show_error=false，出错只回 {"error":null}，要靠超时/状态自己判
//
// 首尾静音用 ffmpeg 处理（adelay / apad），只在合成成功之后做，失败就发原始音频。
//
// 启动方式（开关打开时如果没在跑就自动拉起）：
//   <GPT-SoVITS 根目录>/runtime/python.exe -s GPT_SoVITS/inference_webui.py zh_CN
//   必须 cwd 到根目录，否则相对路径的权重找不到。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** 默认配置：都允许被 config.json 的 socialV2.tts 覆盖。 */
export const TTS_DEFAULTS = Object.freeze({
  enabled: false,                       // 「纯语音」总开关（控制台开关写这里）
  baseUrl: 'http://127.0.0.1:9872',     // 推理服务地址
  root: 'D:\\Program Files\\GPT-SoVITS-v5-20261006nvidia50x0',
  pythonArgs: ['-s', 'GPT_SoVITS/inference_webui.py', 'zh_CN'],
  // 参考音频：当前用 6.4 秒那条。
  //
  // ⚠️ 已知问题（2026-11-11 实测，暂未修）：「乖，过来」这类极短句会被压扁成「喂」。
  //  实测数据（同一句跑 4~6 次，量有声时长）：
  //    · 6.4s 长句（当前）    1.28 1.40 0.96 1.28   → 3/4 次吞字
  //    · 3.3s 短句            1.18 1.44 1.42 1.34   → 1/4 次吞字  ← 明显更好
  //    · 6.4s + 中文参考文本  0.34 0.40 0.38 0.42   → 4/4 次，彻底糊
  //  推断：参考音频的**句子形态**比"是否够长"更重要。这段是日语哭腔长句，
  //  模型学到"一整句慢慢念"，喂它 4 个字就往那个模板里塞，塞不下就压扁。
  //  另外参考文本必须和参考音频**同语言**，换了语言锚点会彻底失效（第三行）。
  //
  //  想修的话：把 refAudio/refText 换成下面这条 3.3 秒的（实测吞字率最低）。
  //  那次没改，是因为操作者当时不方便核对文件路径，先留着记录。
  //  refAudio: 'D:\\Desktop\\角色A AI\\(A)そよたちのライブの日なら会えると思う(2).wav',
  //  refText: 'そよたちのライブの日なら会えると思う',
  refAudio: 'D:\\Desktop\\角色A AI\\ごめんなさい。バンド壊して、ギター下手で、ずっと謝りたかった(2).wav',
  refText: 'ごめんなさい。バンド壊して、ギター下手で、ずっと謝りたかった',
  refLang: '日文',
  // 合成语种。**必须是「中英混合」，不能写「中文」**（2026-11-10 踩过）。
  //   她说过一句「zzz好帅」，纯中文模式下 zzz 被当作拼音声母拆开念，
  //   听起来是「喝喝喝/滋滋滋」一串怪声 —— 听感上完全不是人话。
  //   纯中文只对"整句都是汉字"成立；群聊里混几个英文字母/单词太常见了。
  // 为什么不用「多语种混合」：服务端注释写着"限制范围越小判别效果越好"，
  //   范围给太大反而容易把中文误判成日语/韩语。
  textLang: '中英混合',
  // 她的权重。合成前会调 /change_sovits_weights 切过去（见 switchWeights）。
  sovitsPath: 'SoVITS_weights_v5dev/Mujica_若葉睦_v2pp.pth',
  gptPath: 'GPT_weights_v5dev/Mujica_若葉睦_v2pp.ckpt',
  // 合成前是否切换到 sovitsPath。**必须开** —— 否则用的是 WebUI 当前选中的底模，
  // 音色不是她。
  //
  // 排查记录（2026-11-09，留作教训）：一度以为这个模型"结构 vs 声明不一致"，
  // 切过去会报 `AttributeError: 'SynthesizerTrnV3' object has no attribute 'decode'`。
  // 实际原因完全在**测试脚本**：参考音频上传打到了 `/gradio_api/upload`
  // （这个版本返回 404，正确的是 `/upload`），拿到的路径是 undefined，
  // 服务端在"没有有效参考音频"时走进了错误分支，才抛出那个看似模型问题的异常。
  // 模型本身用 WebUI 选、用 API 切都能正常合成。
  // 教训：报错指向模型时，先确认**请求参数是否真的有效**，别急着怀疑数据文件。
  switchWeights: true,
  outDir: '',                            // 空 = state/tts；合成产物按文本哈希缓存
  // ── 采样与节奏 ──
  // speed 是**倍速**：1.0=原速，<1 变慢。<1 会拖长音频时长（听感更从容），
  //   服务端 slider 允许 0.6~1.65，超出会被它自己夹住。
  // 2026-11-11：0.85 → 0.95 → 0.9。0.85 听着偏拖，0.95 又有点赶，取中间。
  speed: 0.9,
  // pause_second 是**句间停顿秒数**（0.1~0.5）。整句连读会显得急，
  //   调大一点能听出"喘了口气"，这比单纯降倍速更自然。
  pauseSecond: 0.4,
  topK: 15,
  topP: 1,
  temperature: 1,
  sampleSteps: 8,
  cfgRate: 0.0,
  // 怎么切。WebUI 默认「凑四句一切」；写死成「不切」会让长句整段过模型、发音发糊。
  howToCut: '凑四句一切',
  // ref_free：开启后**不用参考文本**，只用参考音频的音色。
  //   服务端逻辑：prompt_text 为空 → 自动 ref_free=True；v3/v4/v5 会强制关掉它。
  //   我们的模型是 v2ProPlus（不在 v3v4set 里），所以这个值真的生效。
  //
  // ⚠️ 2026-11-11 实测后改为 **false**（之前一度设 true，因为"音色更像"）。
  //   代价是**极短句会吞字**：「乖，过来」在 ref_free=true 下只剩 0.90 秒的语音，
  //   听起来像「喂」；ref_free=false（传参考文本）是 3.32 秒，四个字都在。
  //   长句同样受影响：「乖，过来。累了就别说话」1.18s vs 2.12s。
  //   原因：ref_free 时模型拿不到参考文本的语义/韵律锚点，短句的时长估计完全靠猜，
  //   于是把整句压成一个音。参考文本是"这句话该怎么念"的锚，不是可选项。
  refFree: false,
  ifSr: false,
  // ── 首尾静音（秒）──
  // 为什么需要：合成出来的音频几乎贴着 0 秒开始，QQ 语音条一点开就蹦出人声，
  // 像被人突然拍了一下。前面垫一点，是"她开口之前先停顿一下"的那种感觉；
  // 后面留一点，是说完之后那口没散的空气。
  // 用 ffmpeg 的 adelay（前导）+ apad（尾部）做，不重新编码语音内容本身。
  leadSilenceSec: 0.5,
  tailSilenceSec: 0.8,
  ffmpegPath: 'D:\\Program Files\\ffmpeg-2026-11-05-git-0893feba65-full_build\\bin\\ffmpeg.exe',
  timeoutMs: 60000,
  maxChars: 200,                         // 超长文本截断（语音条太长很怪）
  startWaitMs: 90000,                    // 自动拉起后最多等多久就绪
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normCfg(raw = {}) {
  const out = { ...TTS_DEFAULTS };
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'pythonArgs' && Array.isArray(v)) { out.pythonArgs = v.map(String); continue; }
    out[k] = v;
  }
  return out;
}

/** 服务是否活着（不抛错，返回布尔）。 */
export async function ttsAlive(baseUrl, { timeoutMs = 2500 } = {}) {
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const html = await res.text();
    // 9874 的主 WebUI 也有 gradio_api_info，但它没有 /get_tts_wav。
    return html.includes('gradio_api_info');
  } catch {
    return false;
  }
}

/** 服务是否**能合成**（有 get_tts_wav）。比 ttsAlive 更严格。 */
export async function ttsReady(baseUrl) {
  try {
    const html = await (await fetch(String(baseUrl).replace(/\/+$/, '') + '/', {
      signal: AbortSignal.timeout(2500),
    })).text();
    return html.includes('/get_tts_wav');
  } catch {
    return false;
  }
}

/**
 * 确保推理服务在跑；没在跑就自动拉起，并等到 ready。
 * 返回 { started, ready, detail }。**不抛错** —— 调用方（开关/发送）要能优雅降级。
 *
 * 窗口是**隐藏**的（用户要求后台跑），所以把它的 stdout/stderr 落到日志文件。
 * ⚠️ 日志必须**有上限**：这个进程一跑就是几小时，全量 append 会一直涨。
 *   这里用最简单也最稳的办法 —— **每次拉起前截断**（启动日志本来就只需要最近一次）。
 *   为什么不按大小轮转：我们拿的是文件描述符交给子进程，父进程不参与写入，
 *   没法在写的过程中轮转；而"每次启动重置"已经足够覆盖排查场景。
 */
export async function ensureTtsServer(rawCfg = {}, { log = () => {}, logFile = '' } = {}) {
  const cfg = normCfg(rawCfg);
  if (await ttsReady(cfg.baseUrl)) return { started: false, ready: true, detail: '已在运行' };

  const py = path.join(cfg.root, 'runtime', 'python.exe');
  if (!fs.existsSync(py)) {
    return { started: false, ready: false, detail: `找不到解释器：${py}` };
  }
  log(`[tts] 推理服务没在跑，自动拉起：${py} ${cfg.pythonArgs.join(' ')}`);
  try {
    // 隐藏窗口后就看不到输出了，所以留一份日志（失败也不阻塞启动）。
    // 用 'w' 而不是 'a'：每次拉起都是新的一次会话，旧日志没有对照价值，
    // 而且这样文件大小天然被"单次启动的输出量"封顶。
    let out = 'ignore';
    try {
      if (logFile) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const fd = fs.openSync(logFile, 'w');
        out = fd;
      }
    } catch {}
    const child = spawn(py, cfg.pythonArgs, {
      cwd: cfg.root,
      // detached + ignore：桥接重启不该顺手杀掉它；输出不接管（stdio 管道在受限沙箱里会 EPERM）。
      detached: true,
      stdio: ['ignore', out, out],
      // 隐藏窗口：用户要求后台运行，不要每次开纯语音都弹一个 CMD 出来。
      // 代价是看不到它的日志 —— 排查时看 logFile，或者手动跑一次
      //   <root>\runtime\python.exe -s GPT_SoVITS\inference_webui.py zh_CN
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    return { started: false, ready: false, detail: `拉起失败：${error?.message ?? error}` };
  }

  const deadline = Date.now() + Number(cfg.startWaitMs || 90000);
  while (Date.now() < deadline) {
    await sleep(1500);
    if (await ttsReady(cfg.baseUrl)) return { started: true, ready: true, detail: '已自动拉起' };
  }
  return { started: true, ready: false, detail: `拉起后 ${Math.round(cfg.startWaitMs / 1000)}s 内没就绪` };
}

/** 从页面里把 gradio_api_info 当 JSON 解析（不用正则猜结构，猜过一次就错了）。 */
async function readApiInfo(baseUrl) {
  const html = await (await fetch(String(baseUrl).replace(/\/+$/, '') + '/', {
    signal: AbortSignal.timeout(6000),
  })).text();
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

/** 上传参考音频，返回服务端路径。 */
async function uploadRef(baseUrl, file) {
  const buf = fs.readFileSync(file);
  const base = String(baseUrl).replace(/\/+$/, '');
  for (const ep of ['/gradio_api/upload', '/upload']) {
    try {
      const fd = new FormData();
      fd.append('files', new Blob([buf]), path.basename(file));
      const res = await fetch(base + ep, { method: 'POST', body: fd });
      if (!res.ok) continue;
      const j = await res.json();
      const p = Array.isArray(j) ? j[0] : (j?.files?.[0] ?? j?.[0]);
      if (typeof p === 'string' && p) return p;
    } catch {}
  }
  throw new Error('上传参考音频失败');
}

function parseSse(raw) {
  return String(raw).split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
}

/**
 * 给音频加首尾静音（秒），返回**新文件**路径；失败返回 null（调用方回退到原音频）。
 *
 * 为什么用 ffmpeg 而不是自己改 WAV 字节：
 *   服务端回的是 32kHz 单声道 16bit WAV，自己拼头也能做，但一旦格式变了
 *   （采样率/位深/声道数变化）就得跟着改，还容易算错 data chunk 大小。
 *   ffmpeg 一条滤镜搞定，且能顺手统一格式：
 *     adelay=ms|ms   —— 前面垫静音（每个声道一个值，单声道写一个也行）
 *     apad=pad_dur=s —— 后面补静音
 *
 * ⚠️ 用 spawnSync 而不是异步 spawn：这段很短（实测 <100ms），
 *    而且调用方紧接着就要用文件；异步化会让"合成完但文件还没写完"成为可能。
 *    stdio: 'ignore' —— 受限沙箱里 pipe 子进程会 EPERM，忽略输出最省事。
 */
function addSilence(file, { leadSec = 0, tailSec = 0, ffmpegPath = 'ffmpeg', log = () => {} } = {}) {
  const lead = Math.max(0, Number(leadSec) || 0);
  const tail = Math.max(0, Number(tailSec) || 0);
  if (lead <= 0 && tail <= 0) return null;

  const out = file.replace(/\.wav$/i, '') + `.silence-${lead}-${tail}.wav`;
  const filters = [];
  if (lead > 0) {
    const ms = Math.round(lead * 1000);
    filters.push(`adelay=${ms}|${ms}`);
  }
  if (tail > 0) filters.push(`apad=pad_dur=${tail}`);

  try {
    const r = spawnSync(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-af', filters.join(','),
      '-ac', '1', '-ar', '32000',
      out,
    ], { timeout: 30000, windowsHide: true, stdio: 'ignore' });
    if (r.error) { log(`[tts] 加静音失败（ffmpeg 启动）：${r.error.message}`); return null; }
    if (r.status !== 0) { log(`[tts] 加静音失败（ffmpeg 退出码 ${r.status}）`); return null; }
    if (!fs.existsSync(out) || fs.statSync(out).size < 1024) {
      log('[tts] 加静音失败（产物异常）');
      return null;
    }
    return out;
  } catch (error) {
    log(`[tts] 加静音异常：${error?.message ?? error}`);
    return null;
  }
}

/** 兼容纯 JSON 与 SSE 两种响应。 */
function extractResult(raw) {
  const text = String(raw).trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const j = JSON.parse(text);
      return Array.isArray(j) ? j[j.length - 1] : j;
    } catch {}
  }
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

/**
 * 缓存文件名：文本 + **所有会影响声音的参数** → 稳定哈希，同一句话不重复合成。
 *
 * ⚠️ 踩过的坑：最初只把"文本+参考音频+权重"放进键里，没放 speed / pause_second。
 * 于是调了语速之后，同一句话仍然命中旧文件 —— 听起来像"改了没生效"，
 * 实际是拿了缓存。凡是会改变音频内容的参数都必须进来。
 */
function cacheKeyOf(cfg, text) {
  const seed = [
    text,
    cfg.refAudio, cfg.refText, cfg.refLang, cfg.textLang,
    cfg.sovitsPath, cfg.gptPath,
    // 以下任何一个变了，音频就该重新合成
    String(cfg.speed ?? 1.0),
    String(cfg.pauseSecond ?? 0.3),
    String(cfg.topK ?? 15),
    String(cfg.topP ?? 1),
    String(cfg.temperature ?? 1),
    String(cfg.sampleSteps ?? 8),
    String(cfg.cfgRate ?? 0.0),
    cfg.refFree === true ? 'rf1' : 'rf0',
    // 首尾静音也改变最终音频的长度，必须进键，否则改了静音时长还是拿到旧文件。
    String(cfg.leadSilenceSec ?? 0),
    String(cfg.tailSilenceSec ?? 0),
  ].join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i += 1) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 让服务端当前加载的权重变成"她的"。
 *
 * 为什么必须做（这是一处真实的错误，2026-11-09 发现）：
 *   `/get_tts_wav` 的参数表里**没有 sovits_path**（实测只有 19 个参数，全是文本/采样/节奏），
 *   所以把模型路径塞进合成请求是**无效**的 —— 服务端只认自己当前选中的权重。
 *   结果就是：GPT 是她的（`GPT_weights_v5dev/Mujica_若葉睦_v2pp.ckpt`），
 *   SoVITS 却是 v2ProPlus **底模**，音色/音调会偏，听起来"像但不是她"。
 *
 * 做法：调 `/change_sovits_weights`（参数：sovits_path, prompt_language, text_language）。
 *   这个接口是"切换并加载"，比较慢，所以只在确实需要时调一次，不每次合成前都调。
 *   调用失败**不抛错**：合成仍继续（顶多音色不对），不能因为切模型失败就整条消息发不出去。
 */
const loadedSovits = new Set();  // 记住本进程已经切过的模型，避免重复加载

export async function ensureSovitsWeights(rawCfg = {}, { log = () => {} } = {}) {
  const cfg = normCfg(rawCfg);
  if (cfg.switchWeights !== true) return { switched: false, detail: '未启用切换' };
  const want = String(cfg.sovitsPath || '').trim();
  if (!want) return { switched: false, detail: '未配置 sovitsPath' };
  if (loadedSovits.has(want)) return { switched: false, detail: '已加载过' };

  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  try {
    const res = await fetch(base + '/api/change_sovits_weights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 参数顺序照服务声明：sovits_path, prompt_language, text_language
      body: JSON.stringify({ data: [want, cfg.refLang || '日文', cfg.textLang || '中英混合'] }),
      signal: AbortSignal.timeout(180000),   // 加载 170MB 权重可能很慢
    });
    const raw = await res.text();
    if (!res.ok) {
      log(`[tts] 切换 SoVITS 权重失败 HTTP ${res.status}：${raw.slice(0, 160)}`);
      return { switched: false, detail: `HTTP ${res.status}` };
    }
    loadedSovits.add(want);
    log(`[tts] SoVITS 权重已切到 ${want}`);
    return { switched: true, detail: want };
  } catch (error) {
    log(`[tts] 切换 SoVITS 权重异常：${error?.message ?? error}`);
    return { switched: false, detail: String(error?.message ?? error) };
  }
}

/**
 * 合成一句话，返回本地音频路径。
 *
 * @param {string} text 要念的文字
 * @param {object} rawCfg 配置（见 TTS_DEFAULTS）
 * @param {{ log?: Function, cacheDir?: string }} opts
 * @returns {Promise<{ path: string, cached: boolean, ms: number }>}
 */
export async function synthesize(text, rawCfg = {}, { log = () => {}, cacheDir = '' } = {}) {
  const cfg = normCfg(rawCfg);
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, Number(cfg.maxChars) || 200);
  if (!clean) throw new Error('要合成的文本是空的');

  const outDir = cacheDir || cfg.outDir || path.join(process.cwd(), 'state', 'tts');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${cacheKeyOf(cfg, clean)}.wav`);
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024) {
    return { path: outFile, cached: true, ms: 0 };
  }

  if (!fs.existsSync(cfg.refAudio)) throw new Error(`参考音频不存在：${cfg.refAudio}`);
  const base = String(cfg.baseUrl).replace(/\/+$/, '');

  // 合成前先确认服务端加载的是她的 SoVITS 权重。
  // 放在缓存检查之后（命中缓存就不必白切一次），放在读参数之前（切完参数表可能刷新）。
  await ensureSovitsWeights(cfg, { log });

  const info = await readApiInfo(base);
  const ep = info.named_endpoints?.['/get_tts_wav'];
  if (!ep) throw new Error('推理服务没有 /get_tts_wav（是不是连到了 9874 主 WebUI？）');
  const params = ep.parameters;

  const serverPath = await uploadRef(base, cfg.refAudio);
  // ref_free 开启时**把参考文本传空**：服务端本来就会忽略它（prompts=None），
  // 但传空能让"我确实是按无参考文本模式在跑"这件事在参数里就看得见，
  // 排查时不用再去猜 refFree 到底有没有生效。
  const useRefText = cfg.refFree === true ? '' : String(cfg.refText || '');
  const values = {
    ref_wav_path: { path: serverPath, meta: { _type: 'gradio.FileData' } },
    prompt_text: useRefText,
    prompt_language: cfg.refLang,
    text: clean,
    text_language: cfg.textLang,
    // 怎么切：**必须和 WebUI 的默认值一致**（凑四句一切）。
    // 原来这里写死 '不切'，长句会整段一次性过模型，发音容易糊成一团。
    how_to_cut: String(cfg.howToCut || '凑四句一切'),
    // 采样与节奏参数：全部走配置，不再写死。
    // 写死的后果是"想调语速只能改代码"，而且改了以后旧缓存还命中 —— 见 cacheKeyOf。
    // 取值范围（照服务端 slider）：speed 0.6~1.65，pause_second 0.1~0.5。
    top_k: Number(cfg.topK ?? 15),
    top_p: Number(cfg.topP ?? 1),
    temperature: Number(cfg.temperature ?? 1),
    ref_free: cfg.refFree === true,
    // ⚠️ speed 是「倍速」不是「时长倍率」：1.0 = 原速，小于 1 才变慢。
    speed: Number(cfg.speed ?? 1.0),
    if_freeze: false,
    inp_refs: null,
    sample_steps: Number(cfg.sampleSteps ?? 8),
    if_sr: cfg.ifSr === true,
    // 句间停顿（秒）：整句连读会显得急，0.3→0.4 能明显喘一口气。
    pause_second: Number(cfg.pauseSecond ?? 0.3),
    use_cuda_graph: true,
    use_flash_attention: true,
    cfg_rate: Number(cfg.cfgRate ?? 0.0),
    // ⚠️ 这里**不要**加 sovits_path：/get_tts_wav 不接收它（实测参数表里没有），
    //    塞进来会被 params.map() 直接丢掉，看起来"传了"其实完全没生效。
    //    要换权重请用上面 synthesize() 里调的 ensureSovitsWeights()。
  };
  // 顺序完全由服务声明决定；没声明到的用默认值。
  const data = params.map((p) => {
    const n = p.parameter_name;
    if (n in values) return values[n];
    return p.parameter_has_default ? p.parameter_default : null;
  });

  const t0 = Date.now();
  const res = await fetch(base + '/api/get_tts_wav', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 60000),
  });
  const raw = await res.text();
  const ms = Date.now() - t0;
  const last = extractResult(raw);
  if (!last) {
    throw new Error(`合成响应解不出来（HTTP ${res.status}）：${raw.slice(0, 200)}`);
  }
  const list = Array.isArray(last.data) ? last.data : [last.data];
  const audio = list.find((f) => f && (f.path || f.url));
  if (!audio) {
    throw new Error(`合成没有返回音频（HTTP ${res.status}）：${JSON.stringify(last).slice(0, 200)}`);
  }

  const url = audio.url || `${base}/file=${encodeURIComponent(audio.path)}`;
  const buf = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
  if (buf.length < 1024) throw new Error(`合成出来的音频太小（${buf.length} 字节）`);
  // 先落到"原始"文件，再按需加首尾静音，最终产物仍是 outFile。
  const rawFile = outFile.replace(/\.wav$/i, '.raw.wav');
  fs.writeFileSync(rawFile, buf);

  // 首尾静音：失败就用原始音频，绝不因为"美化失败"导致整条消息发不出去。
  const padded = addSilence(rawFile, {
    leadSec: cfg.leadSilenceSec,
    tailSec: cfg.tailSilenceSec,
    ffmpegPath: cfg.ffmpegPath,
    log,
  });
  if (padded) {
    try { fs.copyFileSync(padded, outFile); } catch (error) { log(`[tts] 写回静音版失败：${error?.message ?? error}`); }
    try { fs.unlinkSync(padded); } catch {}
    try { fs.unlinkSync(rawFile); } catch {}
  } else {
    // 没有静音（或 ffmpeg 失败）：原始文件就是最终产物，改名省一次拷贝。
    try { fs.renameSync(rawFile, outFile); } catch { fs.copyFileSync(rawFile, outFile); fs.unlinkSync(rawFile); }
  }

  const finalSize = fs.statSync(outFile).size;
  const padNote = padded ? ` +静音 ${cfg.leadSilenceSec}s/${cfg.tailSilenceSec}s` : '';
  log(`[tts] 合成 ${clean.slice(0, 20)}… ${ms}ms ${(finalSize / 1024).toFixed(0)}KB${padNote}`);
  return { path: outFile, cached: false, ms };
}

export { normCfg as normalizeTtsConfig };
