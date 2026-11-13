// 检查预设里对 MCP 工具的称呼是否一致。
// DSH 暴露给模型的工具名是 `mcp__snowluma__qq_xxx`，但预设里写短名 `qq_xxx` 也能用
// （qs 前缀足够唯一）。这里只是把两者都数一遍，确保没有写成不存在的名字。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preset = fs.readFileSync(
  path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-agent', 'agent.cordis.yml'), 'utf8');

const count = (needle) => preset.split(needle).length - 1;

const shortNames = ['qq_affinity', 'qq_send_message', 'qq_mark_read', 'qq_get_prompt', 'qq_memory_append'];
const fullNames = shortNames.map((n) => `mcp__snowluma__${n}`);

console.log('=== 短名出现次数 ===');
for (const n of shortNames) console.log(`  ${n.padEnd(22)} ${count(n)}`);
console.log('=== 全名出现次数 ===');
for (const n of fullNames) console.log(`  ${n.padEnd(34)} ${count(n)}`);

// qq_affinity 的调用形态检查
const calls = [...preset.matchAll(/qq_affinity\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
console.log('\n=== qq_affinity 调用示例 ===');
for (const c of new Set(calls)) console.log(`  qq_affinity(${c})`);

// 关键：预设里提到的工具名，必须真的存在于 MCP server 里。
// 工具用 `server.tool('qq_xxx', ...)` 注册，名字是**单引号的第一参数**。
const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const declared = new Set(
  [...mcpSrc.matchAll(/server\.tool\(\s*\n?\s*'(qq_[a-z_]+)'/g)].map((m) => m[1]),
);
console.log(`\n=== MCP 实际声明的 qq_ 工具（${declared.size} 个）===`);
console.log('  ' + [...declared].sort().join(', '));

const mentioned = new Set([...preset.matchAll(/\b(qq_[a-z_]+)\b/g)].map((m) => m[1]));
// 这两个是预设里**明确说"不存在、别去找"**的，不算缺声明。
const INTENTIONALLY_ABSENT = new Set(['qq_find_tool', 'qq_call_tool']);
const unknown = [...mentioned].filter((n) => !declared.has(n) && !INTENTIONALLY_ABSENT.has(n));
console.log('\n=== 预设提到但 MCP 没声明的工具 ===');
if (unknown.length) {
  console.log('  ⚠️ ' + unknown.join(', '));
  process.exitCode = 1;
} else {
  console.log('  无（都真实存在；qq_find_tool / qq_call_tool 是预设里明确否定的名字，跳过）');
}

// 现在最要紧的一条：回复前必查好感度，这个工具必须真的存在且已启用。
if (!declared.has('qq_affinity')) {
  console.log('\n❌ 致命：预设要求"回复前必查好感度"，但 MCP 里没有 qq_affinity 这个工具');
  process.exitCode = 1;
} else {
  console.log('\n✅ qq_affinity 存在，预设的"回复前必查"规则可以落地');
}
