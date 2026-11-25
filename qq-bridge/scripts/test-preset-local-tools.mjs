// 预设工具面与 QQ 工具守卫（qq-tool-restrict）的回归。
//
// ⚠️ 2026-11-07 合并：四个旧预设（qq-chat / qq-chat-v2 / qq-chat-readonly /
//   qq-chat-owner）合并成唯一的 `qq-chat-agent`，权限档位统一按 **readonly**。
//   因此本文件不再按「三个 preset 目录」分别断言，而是：
//     · 对**现存唯一 preset**（qq-chat-agent）断言它的工具面；
//     · 对**守卫本身**（唯一实现，三个 MODES 都还在）按 mode 逐档断言语义。
//   这样即使以后 preset 再合并/拆分，守卫的安全语义仍然被钉死。
//
// 为什么守卫的三档必须继续被测：MODES 里的 strict / readonly / open 并没有删除——
// 它们仍是 toolGuardReason() 的判定依据，删档才是真删安全边界。只是现在没有哪个
// preset 会挂 open 档了（owner 不再是全工具档）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { collectDshToolNames as collectDshToolNamesShared } from './dsh-tool-names.mjs';
import yaml from 'js-yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRESETS_DIR = path.join(ROOT, 'dsh', 'agent-presets');

/** 现存唯一 preset（合并后）。 */
const MERGED_PRESET = 'qq-chat-agent';

/**
 * 守卫的**唯一实现**。preset 目录下的 qq-tool-restrict.mjs 只是 re-export 壳，
 * 真正装进 DSH 的是 bundle 里这一份（见该壳文件的注释）。测试直接打权威实现，
 * 避免两边漂移。
 */
const GUARD_SOURCE = path.join(ROOT, '..', 'dsh-plugins', 'dsh-qq-companion', 'tool-restrict.mjs');

/** 封闭 agent 的 preset：按设计**允许**完整本地工具面。 */
const CLOSED_AGENT_PRESETS = ['qsh-closed'];

/**
 * 本地执行能力清单。
 *
 * ⚠️ 这里**必须**含每一个能执行本地命令、读写本地文件或派生 agent 的工具名。
 * 名字取自 DSH 0.1.7-rc.2 实际注册的工具（见 qq-tool-restrict.mjs 的注释）。
 *
 * 两类失败模式，本文件都要防：
 *   ① **漏**（本地工具不在守卫名单里 ⇒ 留在 schema）——由 restrict 名单对账防；
 *   ② **拼错假名**（名字根本不存在 ⇒ `tools.restrict` 抛错被吞 ⇒ 静默失效）——
 *      由「假 restrict 会对未知名字抛错」那条防。
 */
const LOCAL_EXECUTION_TOOLS = [
  'pwsh', 'bash',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'load_workspace_dependencies',
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  'cordis_inspect_list', 'cordis_inspect_query',
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  // 0.2.0 新增对账
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 0.2.1 新增对账（2026-10-22）：working_directory 由 dsh-base 默认挂载（全局层继承），
  // terminal 一族 = shell，session_* 能跨会话读事件正文，plugin_market = 装载权。
  'working_directory',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  'plugin_market', 'create_worktree', 'wait_agent',
  // 按需安装的可选组合包才注册的名字：0.2.1 起默认不存在，但一旦装上就要挡。
  'subagent_codex', 'subagent_claude_code',
];

/** 0.2.1 起 Codex / Claude Code 改为按需安装：这组名字默认扫不到，不算拼错假名。 */
const OPTIONAL_BUNDLE_TOOLS = new Set(['subagent_codex', 'subagent_claude_code']);

/**
 * 工具名 → 真实存在与否。抽取实现在 `scripts/dsh-tool-names.mjs`（唯一实现，
 * 与 `scan-dsh-tool-names.mjs` 共用），用来抓"拼错的假名"。
 *
 * 历史坑：本测试过去自带一份**模糊**抽取器，0.2.0 对账时把 10 个**真实存在**的
 * 工具名报成假名。误判方向很危险——它会逼人把真名字从守卫名单里删掉，等于自己
 * 拆掉安全边界。现在只保留一条实现，两边不可能再漂移。
 */
function collectDshToolNames() {
  const { names } = collectDshToolNamesShared();
  return names.size === 0 ? null : new Set(names.keys());
}

/** 允许出现在名单里、但不属于"本地执行"语义的名字（开发/注入器）。 */
const DEV_TOOL_PREFIX = /^dev_/;

/** 允许出现的 MCP 命名空间前缀（QQ 动作面）。 */
const EXPECTED_SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
];

function readPreset(id) {
  const dir = path.join(PRESETS_DIR, id);
  assert.ok(fs.existsSync(dir), `preset 目录存在：${id}`);
  const cordis = path.join(dir, 'agent.cordis.yml');
  assert.ok(fs.existsSync(cordis), `preset 有 agent.cordis.yml：${id}`);
  return { dir, yml: fs.readFileSync(cordis, 'utf8'), cordis };
}

const loadGuard = (tag = '') => import(`${pathToFileURL(GUARD_SOURCE).href}?t=${tag || Date.now()}`);

// ---------------------------------------------------------------------------
// ── 一、现存 preset 的工具面 ─────────────────────────────────────────────────
// ---------------------------------------------------------------------------

test('唯一预设挂载了工具守卫，且声明 readonly 档', () => {
  const { yml } = readPreset(MERGED_PRESET);
  assert.match(
    yml,
    /qq-tool-restrict/,
    `${MERGED_PRESET} 必须挂载 qq-tool-restrict，否则本地工具会随全局层继承进来`,
  );
  // 源文件里仍是 preset 目录内的相对名；DSH 0.1.7 下真正装进 DSH 的是 bundle patch
  // （scripts/build-agent-preset-patches.mjs 生成），那里会把它改写成从 profile 目录
  // 可解析的 `qq-agent-presets/qq-tool-restrict.mjs`——这条断言钉的是"源里必须有守卫行"。
  assert.match(yml, /\.\/qq-tool-restrict\.mjs/, '守卫要指向本目录的 .mjs re-export 壳');
  assert.match(
    yml,
    /mode:\s*'readonly'/,
    `${MERGED_PRESET} 的守卫必须声明 mode=readonly（合并后不再有 owner 全工具档）`,
  );
});

test('唯一预设不得挂 shell / 可控写工具', () => {
  const rows = yaml.load(readPreset(MERGED_PRESET).yml);
  const names = rows.map((r) => r?.name ?? '');
  const byId = (rowId) => rows.find((r) => r?.id === rowId);

  for (const forbidden of ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-bash']) {
    assert.ok(!names.includes(forbidden), `${MERGED_PRESET} 不得挂 ${forbidden}（没有任何执行能力）`);
  }
  // 只读文件工具：write / edit 在**注册期**就关掉（不像"注册了再在执行期拒"那样会把 schema 暴露给模型）。
  const fsRow = byId('tool-fs');
  assert.ok(fsRow, `${MERGED_PRESET} 必须挂 tool-fs，否则连 read 都没有`);
  assert.equal(fsRow.config?.write, false, 'write 必须在注册期关掉');
  assert.equal(fsRow.config?.edit, false, 'edit 必须在注册期关掉');
  assert.ok(byId('tool-fs-search'), `${MERGED_PRESET} 必须挂 tool-fs-search（glob/grep）`);
  // tool-fs-search 的 sampleOverCapGlobResults 是必填 config，漏了会让整行加载失败。
  assert.equal(byId('tool-fs-search').config?.sampleOverCapGlobResults, false,
    'tool-fs-search 的 sampleOverCapGlobResults 是必填 config');
});

test('唯一预设不得挂 tool-web 的 search/fetch（联网统一走安全 MCP）', () => {
  const { yml } = readPreset(MERGED_PRESET);
  const webRow = /id:\s*tool-web[\s\S]{0,200}/.exec(yml);
  assert.ok(webRow, `${MERGED_PRESET} 应有 tool-web 条目`);
  assert.match(webRow[0], /search:\s*false/, 'tool-web.search 必须为 false');
  assert.match(webRow[0], /fetch:\s*false/, 'tool-web.fetch 必须为 false');
});

// ---------------------------------------------------------------------------
// ── 二、守卫本身：注册期 restrict 名单 ──────────────────────────────────────
// ---------------------------------------------------------------------------

test('守卫的 restrict 名单覆盖每一个已知本地执行工具', async () => {
  const mod = await loadGuard('restrict');
  const restricted = new Set();
  const fakeTools = {
    restrict({ deny }) { for (const n of deny ?? []) restricted.add(n); },
    guard(fn) { this._guard = fn; },
  };
  mod.apply({ tools: fakeTools });

  const violations = LOCAL_EXECUTION_TOOLS.filter((t) => !restricted.has(t));
  assert.deepEqual(
    violations, [],
    `以下本地执行工具未出现在 restrict 名单里，会留在模型的工具清单中：`
    + `${violations.join(', ')}。注册期隐藏失败 ⇒ L7 断言不成立。`,
  );
});

test('守卫导出的名单与本测试的清单一致（防两份名单各自漂移）', async () => {
  const mod = await loadGuard('drift');
  assert.ok(
    Array.isArray(mod.RESTRICTED_TOOL_NAMES) && mod.RESTRICTED_TOOL_NAMES.length > 0,
    '守卫必须导出 RESTRICTED_TOOL_NAMES，供测试对账',
  );
  const missing = LOCAL_EXECUTION_TOOLS.filter((t) => !mod.RESTRICTED_TOOL_NAMES.includes(t));
  assert.deepEqual(missing, [], `守卫导出的名单缺少本地执行工具：${missing.join(', ')}`);
  // 反向：名单里不该混入"允许的无害工具"（否则与 SAFE_EXACT 自相矛盾）。
  for (const allowed of ['ask_user_question', 'todo_write']) {
    assert.ok(!mod.RESTRICTED_TOOL_NAMES.includes(allowed),
      `${allowed} 是无害模型侧工具，不应出现在 restrict 名单里`);
  }
});

test('守卫名单里的每个名字都是 DSH 真实注册的工具（防拼错假名静默失效）', async () => {
  // 为什么必须测：`tools.restrict()` 对未知名字会**抛错**，而守卫逐个 try/catch
  // 只打日志 ⇒ 拼错的名字 = **静默 no-op**。这正是本名单初版的真实缺陷：
  // pwsh_persistent / bash_persistent / cordis / goal_write / goal_read 五个假名
  // 让整批限制悄悄少生效，而套件当时全绿。
  const dshNames = collectDshToolNames();
  if (dshNames === null) {
    console.log('  ⏭  跳过：未找到 DSH 工具包（设 DSH_TOOL_PACKAGES 指向 @deepseek-ai 目录即可启用）');
    return;
  }
  const mod = await loadGuard('fabricated');
  const optional = new Set([...OPTIONAL_BUNDLE_TOOLS, ...(mod.OPTIONAL_BUNDLE_TOOL_NAMES ?? [])]);
  const fabricated = mod.RESTRICTED_TOOL_NAMES
    .filter((n) => !DEV_TOOL_PREFIX.test(n) && !optional.has(n) && !dshNames.has(n));
  assert.deepEqual(fabricated, [],
    `以下名字在 DSH 已安装的工具包里找不到 ⇒ restrict 会抛错并被吞掉，`
    + `限制静默失效：${fabricated.join(', ')}`);
});

// ---------------------------------------------------------------------------
// ── 三、执行期白名单：按 mode 逐档断言 ─────────────────────────────────────
// ---------------------------------------------------------------------------

test('执行期白名单：readonly 档放行只读工具、拒绝写入与执行', async () => {
  const { MODES, toolGuardReason } = await loadGuard('ro');
  for (const tool of ['read', 'read_image', 'glob', 'grep']) {
    assert.equal(toolGuardReason(MODES.READONLY, { name: tool }), undefined,
      `readonly 档必须放行只读工具 "${tool}"`);
  }
  for (const tool of ['write', 'edit', 'pwsh', 'bash']) {
    assert.ok(typeof toolGuardReason(MODES.READONLY, { name: tool }) === 'string',
      `readonly 档不得放行 "${tool}"`);
  }
});

test('执行期白名单：strict 档连只读工具都不放行（仅聊天）', async () => {
  const { MODES, toolGuardReason } = await loadGuard('strict');
  for (const tool of ['read', 'read_image', 'glob', 'grep', 'write', 'pwsh']) {
    assert.ok(typeof toolGuardReason(MODES.STRICT, { name: tool }) === 'string',
      `strict 档（仅聊天）不得放行 "${tool}"`);
  }
});

test('执行期白名单：open 档放行本地工具，但宿主/装载权永不授予', async () => {
  // 即使 open 档（历史上 owner 用），plugin_manager / 派生 agent 这类也一律拒绝。
  // 这条是合并后仍然有效的护栏：open 档不再是任何 preset 的默认，但语义不能松。
  const { MODES, toolGuardReason, NEVER_GRANTED_TOOL_NAMES } = await loadGuard('open');
  for (const tool of ['read', 'write', 'edit', 'glob', 'grep', 'pwsh']) {
    assert.equal(toolGuardReason(MODES.OPEN, { name: tool }), undefined,
      `open 档应放行 "${tool}"`);
  }
  assert.ok(Array.isArray(NEVER_GRANTED_TOOL_NAMES) && NEVER_GRANTED_TOOL_NAMES.length > 0,
    '守卫必须导出 NEVER_GRANTED_TOOL_NAMES');
  for (const tool of NEVER_GRANTED_TOOL_NAMES) {
    assert.ok(typeof toolGuardReason(MODES.OPEN, { name: tool }) === 'string',
      `open 档也必须拒绝宿主/装载权类工具 "${tool}"`);
  }
});

test('守卫仍放行 QQ MCP 命名空间与无害模型侧工具', async () => {
  const { MODES, toolGuardReason } = await loadGuard('safe');
  for (const mode of [MODES.STRICT, MODES.READONLY]) {
    for (const prefix of EXPECTED_SAFE_PREFIXES) {
      assert.equal(toolGuardReason(mode, { name: `${prefix}some_tool` }), undefined,
        `${mode} 档：MCP 前缀 ${prefix} 应放行`);
    }
    for (const name of ['ask_user_question', 'todo_write']) {
      assert.equal(toolGuardReason(mode, { name }), undefined, `${mode} 档：${name} 应放行`);
    }
  }
  // 未知工具名必须 fail-closed（三档都一样）。
  for (const mode of [MODES.STRICT, MODES.READONLY]) {
    for (const name of ['', null, undefined, 'mcp__unknown__x', 'totally_new_tool']) {
      assert.ok(
        typeof toolGuardReason(mode, { name }) === 'string',
        `${mode} 档：未知工具 ${JSON.stringify(name)} 必须被拒绝（fail-closed）`,
      );
    }
  }
});

test('未知 mode 一律按 strict 处理（拼错不能等于放宽）', async () => {
  const { MODES, normalizeRestrictMode } = await loadGuard('mode');
  assert.equal(normalizeRestrictMode(''), MODES.STRICT);
  assert.equal(normalizeRestrictMode('READONLY'), MODES.READONLY, '大小写不敏感');
  assert.equal(normalizeRestrictMode(' open '), MODES.OPEN, '两端空白会被 trim（是合法值，不是未知值）');
  for (const bad of ['reedonly', 'opne', 'admin', null, undefined, 1]) {
    assert.equal(normalizeRestrictMode(bad), MODES.STRICT,
      `未知 mode ${JSON.stringify(bad)} 必须按 strict 处理（宁可少给权限）`);
  }
});

// ---------------------------------------------------------------------------
// ── 四、封闭 agent 的预设（尚未创建） ──────────────────────────────────────
// ---------------------------------------------------------------------------

test('封闭 agent 的预设在创建后必须与仿真 preset 明确区分', () => {
  // qsh-closed 由 ADR 0003 定义为**故意**拥有完整本地工具面：它的守卫只负责
  // "哪些 QQ 动作可见"，不负责"本地工具权限边界"。
  //
  // ⚠️ 这条断言初版是**恒真**的：qsh-closed 还不存在，`if (!exists) continue`
  // 直接跳过整个函数体，永远不会失败——一个永远不会失败的测试不如没有。
  // 现在改为显式记录"尚未创建"，并且一旦创建就执行真实断言。
  const present = CLOSED_AGENT_PRESETS.filter((id) => fs.existsSync(path.join(PRESETS_DIR, id)));
  if (present.length === 0) {
    console.log('  ⏭  qsh-closed 尚未创建（ADR 0003 待落地）；此项覆盖暂为空，不是通过。');
    return;
  }
  for (const id of present) {
    const yml = fs.readFileSync(path.join(PRESETS_DIR, id, 'agent.cordis.yml'), 'utf8');
    assert.match(yml, /qq-tool-restrict/, `${id} 也应挂守卫（用于 QQ 动作可见性）`);
    // 与仿真 preset 的关键区别：封闭 agent 必须能拿到本地工具 ⇒
    // 它的守卫不得把本地执行工具写进 restrict 名单。
    const guard = fs.readFileSync(path.join(PRESETS_DIR, id, 'qq-tool-restrict.mjs'), 'utf8');
    for (const tool of ['pwsh', 'read', 'write']) {
      assert.ok(
        !new RegExp(`['"]${tool}['"]`).test(guard),
        `${id}: 封闭 agent 需要本地工具，守卫不应把 "${tool}" 列入 restrict`,
      );
    }
  }
});
