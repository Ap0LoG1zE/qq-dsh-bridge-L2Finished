#!/usr/bin/env node
// 把 confirmedBy === 'mark_read' 的会话重新交给全局推荐值管辖。
//
// 背景（2026-11-11）：
//   mark_read 曾经写 confirmedBy='mark_read'，而 refreshDefaultWakeConfigV2()
//   只刷新 confirmedBy === 'default' 的会话 —— 于是「她收尾过一次」就永久冻结了
//   唤醒配置，控制台改「推荐值」再也管不到它。
//
//   实测症状：操作者取消勾选「推荐提问唤醒」，群里一个问号仍然叫醒她。
//
//   代码已修（mark_read 不再写 confirmedBy），但**已经冻住的会话需要一次性解锁**，
//   否则它们要等下次显式 set_wake_config 才恢复。
//
// 用法：
//   node scripts/unfreeze-wake-config.mjs          # 预演
//   node scripts/unfreeze-wake-config.mjs --apply  # 真改
import fs from 'node:fs';

const STATE = 'state/social-v2.json';
const CONFIG = 'config.json';
const APPLY = process.argv.includes('--apply');

const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const w = cfg.socialV2?.wake ?? {};

const convs = st.conversations || {};
const frozen = Object.entries(convs).filter(([, v]) => v?.wakeConfig?.confirmedBy === 'mark_read');

if (!frozen.length) {
  console.log('没有 confirmedBy=mark_read 的会话，无需处理');
  process.exit(0);
}

console.log(`发现 ${frozen.length} 个被 mark_read 冻结的会话：`);
for (const [k, v] of frozen) {
  const t = v.wakeConfig.triggers || {};
  console.log(`  ${k}  question=${t.question} atMention=${t.atMention} poke=${t.poke} probability=${t.probability}`);
}

console.log('\n全局推荐值：');
console.log(`  recommendedQuestion = ${w.recommendedQuestion}  ← 你在控制台把它关了`);
console.log(`  recommendedAtMention = ${w.recommendedAtMention}`);
console.log(`  recommendedPoke = ${w.recommendedPoke}`);
console.log(`  recommendedProbability = ${w.recommendedProbability}`);

if (!APPLY) {
  console.log('\n（预演。--apply 会把 confirmedBy 改回 default 并按当前推荐值刷新）');
  process.exit(0);
}

// 用与 bridge 里的 defaultWakeConfigV2 相同的规则重建 triggers
const defMode = w.defaultMode === 'active' ? 'active' : 'diving';
const defInfinite = w.recommendedDefaultInfinite !== false;
let changed = 0;
for (const [k, v] of frozen) {
  const old = v.wakeConfig;
  v.wakeConfig = {
    mode: defMode,
    infinite: defInfinite,
    sleepUntil: defInfinite ? null : old.sleepUntil ?? null,
    triggers: {
      atMention: w.recommendedAtMention !== false,
      nameMention: w.recommendedNameMention !== false,
      speakerIds: [],
      keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
      question: w.recommendedQuestion !== false,
      poke: w.recommendedPoke !== false,
      anyMessage: defMode === 'active',
      probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
    },
    batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
    lastWakeAt: old.lastWakeAt || 0,
    wakeCount: old.wakeCount || 0,
    noActionCount: old.noActionCount || 0,
    confirmedAt: old.confirmedAt || 0,
    confirmedBy: 'default'
  };
  changed += 1;
  console.log(`  ${k} → question=${v.wakeConfig.triggers.question} confirmedBy=default`);
}

fs.writeFileSync(STATE, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
console.log(`\n完成：${changed} 个会话已回归全局推荐值管辖`);
