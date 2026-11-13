// ffmpeg 定位：**唯一实现**，从 voice-core.js 里搬出来的（2026-11-12）。
//
// 为什么搬出来：
//   voice-core.js 原本承担两件事 —— 定位 ffmpeg、以及"语音库/固定语音发送"那一整套。
//   操作者要求彻底删掉语音库那套（原作者做的、现在不用了），但
//   media-normalize.js（图片/音频格式处理）仍然需要 resolveFfmpeg。
//   所以把它单独拎出来，让"删语音库"不影响 media-normalize。
//
// 语义保持原样，别改：
//   只返回**确实存在**的文件路径；两个候选都没 stat 成功时返回裸命令名 'ffmpeg'，
//   交给 spawn 按 PATH 解析 —— 不要回退到不存在的候选路径（那会让调用方拿到
//   一句无信息量的"启动失败"，而不是能指明 FFMPEG_PATH 该改哪里的 ENOENT 分支）。
import fs from 'node:fs';

/**
 * 定位 ffmpeg 可执行文件。
 *
 * @param {object} opts
 *   ffmpegPath  显式路径（来自 config.json，例如 D:\Program Files\ffmpeg...\bin\ffmpeg.exe）
 *   envVar      环境变量名，默认 FFMPEG_PATH
 * @returns {string} 可执行文件路径；都没命中时返回 'ffmpeg'（交给 PATH）
 */
export function resolveFfmpeg({ ffmpegPath = null, envVar = 'FFMPEG_PATH' } = {}) {
  const candidates = [ffmpegPath, process.env[envVar]].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  // PATH 里找（不真正执行，交给 spawn 时再报错）；绝不再回退到不存在的候选路径。
  return 'ffmpeg';
}

export default { resolveFfmpeg };
