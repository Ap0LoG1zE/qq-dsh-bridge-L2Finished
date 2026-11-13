#!/usr/bin/env node
// 把「推荐提问唤醒」设为关闭，并同步到所有 confirmedBy=default 的会话。
//
// 为什么需要它：操作者在控制台取消了「推荐提问唤醒」的勾选，但 config.json 里
// recommendedQuestion 仍是 true —— 说明那次保存没生效（页面没刷新/没点保存/请求失败）。
// 这里直接从配置文件层面改，等价于"操作者在控制台改并保存成功"。
//
// 同步规则与 bridge 的 refreshDefaultWakeConfigV2 一致：
//   只刷新 confirmedBy === 'default' 的会话；显式 set_wake_config 过的不动。
import fs from 'node:fs';

const CONFIG = 'config.json';
const STATE = 'state/social-v2.json';
const APPLY = process.argv.includes('--apply');

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));

cfg.socialV2 = cfg.socialV2 || {};
cfg.socialV2.wake = cfg.socialV2.wake || {};
console.log('改前 recommendedQuestion:', cfg.socialV2.wake.recommendedQuestion);
cfg.socialV2.wake.recommendedQuestion = false;
console.log('改后 recommendedQuestion:', cfg.socialV2.wake.recommendedQuestion);

const w = cfg.socialV2.wake;
let synced = 0;
const skipped = [];
for (const [k, v] of Object.entries(st.conversations || {})) {
  const wc = v?.wakeConfig;
  if (!wc) continue;
  if (wc.confirmedBy !== 'default') {
    skipped.push(`${k}(${wc.confirmedBy})`);
    continue;
  }
  wc.triggers = wc.triggers || {};
  wc.triggers.question = false;
  synced += 1;
  console.log(`  ${k} → triggers.question = false`);
}

if (!APPLY) {
  console.log(`\n（预演）将同步 ${synced} 个会话，跳过 ${skipped.length} 个：${skipped.join(', ') || '无'}`);
  console.log('加 --apply 执行');
  process.exit(0);
}

fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
fs.writeFileSync(STATE, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
console.log(`\n已写回：同步 ${synced} 个会话，跳过 ${skipped.length} 个`);
