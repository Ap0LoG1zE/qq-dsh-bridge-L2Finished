// 仿真提示词改写（src/preset-prompt.js）的离线单测。
// 这些检查保证「控制台改仿真提示词」不会破坏 YAML、不会丢别的条目、不会改变提示词语义。
// 不连 DSH、不连 QQ、不写任何生产文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';
import {
  PRESET_BLOCKING_SUBSTRINGS,
  PRESET_REQUIRED_MARKERS,
  extractPresetPrefix,
  locatePresetPromptBlock,
  presetBlockingSubstrings,
  presetPromptBlockers,
  presetPromptWarnings,
  presetTierKey,
  renderPresetPromptYaml,
} from '../src/preset-prompt.js';
import { PRESETS } from './build-agent-preset-patches.mjs';

const PRESET_PATH = new URL('../dsh/agent-presets/qq-chat-agent/agent.cordis.yml', import.meta.url);
const source = fs.readFileSync(PRESET_PATH, 'utf8');
const originalPrefix = extractPresetPrefix(source);
// 合并后的预设是只读档：调 renderPresetPromptYaml 必须带上档位，
// 否则它按默认的 'v2' 清单校验，会拿「你没有本地工具」去要求一个**有只读工具**的预设。
const TIER = presetTierKey('qq-chat-agent');

// 回归：每个内置预设必须满足**它自己那一档**的硬性不变量。
//
// 背景：保存/还原的校验曾经对两代预设用同一份清单（那份清单是照二代写的），
// 结果一代预设（qq-chat）在控制台里 100% 存不进去、也还原不了 ——
// 报错还说它「缺少安全不变量」，而它从来就没打算有那些工具面表述。
// 三档分级（2026-10-26）把同类陷阱又开了一遍：owner / readonly 有本地能力，
// 正文里**不可能**有「你没有本地工具」，拿二代的清单去校验它们同样会把人格锁死。
// 所以这里不再硬编码两个名字，而是遍历**全部** PRESETS（新增 preset 自动纳入）。
test('每个内置预设都满足自己那一档的安全不变量', () => {
  // 2026-11-07 合并后 PRESETS 只剩 qq-chat-agent 一个（旧四个已从 DSH 移除）。
  // 这里不再要求「>= 4 个」，而是要求「至少有一个，且每个都过自己那一档」——
  // 合并/拆分都不影响这条断言的意图：**装进 DSH 的预设必须全部合规**。
  assert.ok(PRESETS.length >= 1, `PRESETS 不应为空，实际 ${PRESETS.join(', ')}`);
  for (const name of PRESETS) {
    const gen = presetTierKey(name);
    const text = fs.readFileSync(new URL(`../dsh/agent-presets/${name}/agent.cordis.yml`, import.meta.url), 'utf8');
    const prefix = extractPresetPrefix(text);
    assert.equal(typeof prefix, 'string', `${name} 应能抽出 persona.prefix`);
    const blockers = presetPromptBlockers(prefix, gen);
    assert.deepEqual(blockers, [], `${name}（档位 ${gen}）不应有阻断项，实际：${blockers.join('；')}`);
    // 反过来钉一次：给 owner / readonly 套二代清单**必须**失败，否则说明这条防线是空的。
    if (gen === 'owner' || gen === 'readonly') {
      const withV2 = presetPromptBlockers(prefix, 'v2');
      assert.ok(withV2.some((b) => b.includes('你没有本地工具')),
        `${name} 走二代清单应当报「你没有本地工具」——不报说明这个回归不再有效`);
    }
  }
});

test('各档的硬性不变量清单确实不同（防止又合并成一份）', () => {
  assert.notDeepEqual(presetBlockingSubstrings('v1'), presetBlockingSubstrings('v2'));
  // 二代的工具面不变量不应该出现在一代清单里
  assert.ok(!presetBlockingSubstrings('v1').includes('你没有本地工具'));
  for (const key of ['owner', 'readonly']) {
    assert.ok(!presetBlockingSubstrings(key).includes('你没有本地工具'),
      `${key} 档有本地能力，不得要求「你没有本地工具」`);
    for (const needle of ['群友没有管理权限', 'API 令牌', '角色由桥接注入', '不会自动发送到 QQ']) {
      assert.ok(presetBlockingSubstrings(key).includes(needle), `${key} 档必须保留不变量「${needle}」`);
    }
  }
});

test('preset 名 → 不变量档位：未知名字按更严的二代处理', () => {
  assert.equal(presetTierKey('qq-chat'), 'v1');
  assert.equal(presetTierKey('qq-chat-agent'), 'readonly');
  assert.equal(presetTierKey('qq-chat-v2'), 'v2');
  assert.equal(presetTierKey('qq-chat-owner'), 'owner');
  assert.equal(presetTierKey('qq-chat-readonly'), 'readonly');
  for (const unknown of ['', '  ', null, undefined, 'brand-new-preset', 'standard']) {
    assert.equal(presetTierKey(unknown), 'v2', `${JSON.stringify(unknown)} 必须按 v2（更严）处理`);
  }
});

test('真实预设能定位到 persona 的 prefix 块', () => {
  const loc = locatePresetPromptBlock(source);
  assert.ok(loc, '应能定位 prefix 块');
  // 断言必须与**写入端实际行为**一致：renderPresetPromptYaml 生成的永远是 `|-`
  // （保留换行的字面块），从来不是 `>-`（折叠块）。
  // 这条断言以前写的是 '>-', 与实现不符，导致这个测试长期失败 —— 属于测试自身的
  // 期望值错误，不是预设文件的问题（旧 v2 / readonly 也都是 `|-`）。
  assert.equal(loc.lines[loc.keyLine].trim(), 'prefix: |-');
  assert.ok(loc.blockEnd > loc.keyLine + 1, 'prefix 块应包含内容行');
  assert.ok(loc.entryEnd > loc.blockEnd, 'persona 条目应在 prefix 块之后还有内容');
});

test('抽出的是 YAML 解析后的真实字符串（折叠标量已展开）', () => {
  assert.equal(typeof originalPrefix, 'string');
  assert.ok(originalPrefix.length > 2000, `提示词应有实质内容，实际 ${originalPrefix.length} 字符`);
  for (const marker of PRESET_REQUIRED_MARKERS) {
    assert.ok(originalPrefix.includes(marker), `内置提示词应包含安全基线段落：${marker}`);
  }
  // 2026-11-20：操作者删掉了 persona 开头那句英文
  //（`You are a QQ group-chat agent ... powered by the {{model}} model.`），
  // 所以这里不再要求 {{model}}。要钉的是「有实质内容 + 安全段落完整」。
  assert.ok(originalPrefix.length > 2000, '提示词应有实质内容');
});

test('原样写回是幂等的，且不改变提示词语义', () => {
  const rewritten = renderPresetPromptYaml(source, originalPrefix, TIER);
  assert.equal(extractPresetPrefix(rewritten), originalPrefix, '读回应与原提示词逐字一致');
  // 再写一次仍稳定
  assert.equal(renderPresetPromptYaml(rewritten, originalPrefix, TIER), rewritten);
});

test('改写只动 prefix，其它条目与文件头注释原样保留', () => {
const next = renderPresetPromptYaml(source, `${originalPrefix}\n\n【新增段落】测试内容。`, TIER);
  const before = yaml.load(source);
  const after = yaml.load(next);
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id), '条目 id 顺序不变');
  for (const id of before.map((row) => row.id)) {
    if (id === 'persona') continue;
    assert.deepEqual(after.find((row) => row.id === id), before.find((row) => row.id === id), `条目 ${id} 不应被改动`);
  }
  assert.deepEqual(
    after.find((row) => row.id === 'persona').config.suffix,
    before.find((row) => row.id === 'persona').config.suffix,
    'persona 的 suffix 不应被改动',
  );
  // 文件头注释（前 6 行）必须原样保留
  assert.deepEqual(next.split('\n').slice(0, 6), source.split('\n').slice(0, 6), '文件头注释应保留');
  assert.ok(next.includes('prefix: |-'), '应使用字面量块写回');
});

test('特殊内容可安全往返（空行、缩进、Markdown、模板变量、CJK 标点）', () => {
  const tricky = [
    '# 标题',
    '',
    '- 列表项：含冒号: 和 # 井号',
    '    - 缩进 4 空格的子项',
    '',
    '```js',
    'const a = 1; // { 括号 } 也不能破坏 YAML',
    '```',
    '',
    '【中文段落】含全角标点：，。！？——以及 {{model}} / {{cwd}} 变量',
    '结尾不留多余空行',
  ].join('\n');
  // 必须在保留安全不变量的前提下追加特殊内容，否则会被阻断校验拦下
const next = renderPresetPromptYaml(source, `${originalPrefix}\n\n${tricky}`, TIER);
  assert.equal(extractPresetPrefix(next), `${originalPrefix}\n\n${tricky}`);
  const rows = yaml.load(next);
  assert.equal(rows.length, yaml.load(source).length, '其它条目数量不变');
});

test('危险输入被拒绝，且不产生半截结果', () => {
  assert.throws(() => renderPresetPromptYaml(source, ''), /不能为空/);
  assert.throws(() => renderPresetPromptYaml(source, '   \n  \n'), /不能为空/);
  assert.throws(() => renderPresetPromptYaml(source, 'x'.repeat(200 * 1024)), /过长/);
  assert.throws(() => renderPresetPromptYaml('foo: bar\n', 'x'), /无法定位/);
  assert.throws(() => renderPresetPromptYaml('- id: other\n  config:\n    prefix: >-\n      x\n', 'x'), /无法定位/);
});

test('删掉安全不变量或正文过短时阻断保存（保护 AI 效果与自家测试）', () => {
  // 正文过短
assert.throws(() => renderPresetPromptYaml(source, '太短了', TIER), /过短/);
  // 逐条移除安全不变量，必须被拦住。
  // 注意用**当前预设那一档**的清单（TIER），不是写死 v2 的那份：
  // 合并后的预设是 readonly 档，它本来就没有「你没有本地工具」这句，
  // 拿 v2 清单去替换会替换不到、断言空转。
  for (const needle of presetBlockingSubstrings(TIER)) {
    const tampered = originalPrefix.replace(needle, '（已删除）');
    assert.notEqual(tampered, originalPrefix, `测试前提错误：正文里找不到不变量「${needle}」`);
    assert.throws(
() => renderPresetPromptYaml(source, tampered, TIER),
      new RegExp(`缺少安全不变量「${needle}」`),
      `删除「${needle}」后仍被允许保存`,
    );
  }
  // 只做无损追加则应当通过
assert.doesNotThrow(() => renderPresetPromptYaml(source, `${originalPrefix}\n\n【补充】一句新规则。`, TIER));
  const clean = presetPromptBlockers(originalPrefix, TIER);
  assert.deepEqual(clean, [], `内置提示词不应有阻断项，实际：${clean.join('；')}`);
});

test('写回沿用文件主导行尾，且不吞掉块尾空行', () => {
  const next = renderPresetPromptYaml(source, originalPrefix, TIER);
  const crlf = (next.match(/\r\n/g) ?? []).length;
  const lfOnly = (next.match(/\n/g) ?? []).length - crlf;
  assert.ok(crlf > 0, 'CRLF 文件写回后应仍使用 CRLF');
  assert.equal(lfOnly, 0, '写回后不应残留/新增 LF-only 行');
  assert.ok(next.includes('prefix: |-\r\n'), '新增行应使用 CRLF');
  // 块之后的内容（空行、注释、后续条目）必须逐字保留
  const before = locatePresetPromptBlock(source);
  const after = locatePresetPromptBlock(next);
  assert.deepEqual(
    next.split('\n').slice(after.blockEnd),
    source.split('\n').slice(before.blockEnd),
    'prefix 块之后的内容应逐字不变（含块尾空行与注释）',
  );
  assert.ok(source.split('\n').slice(before.blockEnd).some((l) => l.trim() === ''), '样本应确实包含块尾空行，否则该断言无意义');
});

test('只含空格/Tab 的行也能安全往返（不会被当成空行读丢）', () => {
  // 取样范围必须覆盖**全部安全不变量**，否则这条测试会拿「样本没含那段」当成
  // 「不变量被删了」来报错 —— 2026-11-12 实际踩过：作者原版 prefix 用 `>-` 折叠块，
  // 换行全折叠成空格，解析后只有 19 行，0.~15. 整段工具协议挤在第 3 行，所以
  // `slice(0, 3)` 恰好把「不会自动发送到 QQ」包住了。后来为了可读性改用 `|-`
  // 并给每条之间加换行，prefix 变成 70 行，那句被推到第 6 行、跑出了取样范围，
  // 于是这条测试失败——但失败的其实是**取样假设过时**，不是预设丢了不变量。
  //
  // 现在改为「按标记切到第 14 条为止」：不写死行号，格式再调整也不会误报。
  // （14. 是工具协议段的最后一条；其后是【操作即动作】等独立小节，不含安全不变量。）
  const allLines = originalPrefix.split('\n');
  const lastProto = allLines.findIndex((l) => /^\s*14[.\s]/.test(l));
  const sampleEnd = lastProto >= 0 ? lastProto + 1 : allLines.length;
  const sample = allLines.slice(0, sampleEnd);
  // 先自检样本：不含不变量就是取样错了，要报得明白，不能报成「不变量丢失」。
  assert.ok(
    sample.join('\n').includes('不会自动发送到 QQ'),
    `取样范围（前 ${sampleEnd} 行，到第 14 条为止）未覆盖安全不变量，是取样问题，不是预设问题`,
  );
  const spaced = [
    ...sample,
    '   ',
    '\t',
    ' 带前后空格的正文 ',
    '正常一行',
  ].join('\n');
  const next = renderPresetPromptYaml(source, spaced, TIER);
  assert.equal(extractPresetPrefix(next), spaced, '空白行必须原样保留');
});

test('缺少安全基线段落时给出警告（但不阻断保存）', () => {
  assert.deepEqual(presetPromptWarnings(originalPrefix), [], '内置提示词不应有警告');
  const stripped = originalPrefix.replace(/【二代仿真模式 —— 安全规则[^\n]*\n/, '');
  const warnings = presetPromptWarnings(stripped);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /安全规则/);
  assert.ok(presetPromptWarnings('').some((w) => /内容为空/.test(w)));
});
