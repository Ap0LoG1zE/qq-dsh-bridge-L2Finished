// 验证面板「主动机会」页：后端路由 + 桥接端点的数据流。
//
// 只测后端契约（前端渲染已在 smoke 里加载过模块，能保证语法与工厂可执行）。
import fs from 'node:fs';

let fails = 0;
const ok = (l, c) => { if (!c) fails += 1; console.log(`${c ? '✅' : '❌'} ${l}`); };

// ① 后端有路由、有 handler、注册进表
const backend = fs.readFileSync('lib/features/qq-bigfish.js', 'utf8');
console.log('=== 后端 ===');
ok('ROUTES.proactive 已定义', /proactive:\s*`\$\{routePath\}\/proactive`/.test(backend));
ok('handleProactive 已实现', /async function handleProactive/.test(backend));
ok('已注册到路由表', /\[ROUTES\.proactive, handleProactive\]/.test(backend));
ok('GET 走 /proactive-sessions', backend.includes("'/api/socialV2/proactive-sessions'"));
ok('POST 传 enabled', /enabled:\s*body\.enabled !== false/.test(backend));

// ② 前端有标签页、渲染函数、分发、数据加载
const client = fs.readFileSync('lib/client.js', 'utf8');
console.log('\n=== 前端 ===');
ok('TABS 里有 proactive', /\{\s*id:\s*'proactive',\s*label:\s*'主动机会'\s*\}/.test(client));
ok('renderProactiveTab 已实现', /function renderProactiveTab\(d\)/.test(client));
ok('分发已接上', /mState\.tab === 'proactive'\) return renderProactiveTab\(d\)/.test(client));
ok('loadTab 会拉 /proactive', /tabId === 'proactive'\) url = f\.api \+ '\/proactive'/.test(client));
ok('有页头样式', client.includes('.dsh-fb-proact-head'));
ok('有状态灯样式', client.includes('.dsh-fb-proact-dot'));
ok('开关用统一 switchRow', /switchRow\(\{[\s\S]{0,400}?onFlip/.test(client));

// ③ 桥接侧：会话级开关 + 端点
const bridge = fs.readFileSync('../../qq-bridge/src/bridge.js', 'utf8').replace(/\r\n/g, '\n');
console.log('\n=== 桥接 ===');
ok('调度尊重 st.proactiveDisabled', /st\.proactiveDisabled === true/.test(bridge));
ok('关闭时会清定时器', /clearTimeout\(st\.proactiveTimer\)/.test(bridge));
ok('GET proactive-sessions 端点', bridge.includes("'/api/socialV2/proactive-sessions'"));
ok('POST 关掉时写 proactiveDisabled = true', /st\.proactiveDisabled = true/.test(bridge));
ok('打开时 delete 标记', /delete st\.proactiveDisabled/.test(bridge));
ok('记录 nextCheckAt 供面板倒计时', /st\.proactiveNextCheckAt = Date\.now\(\) \+ delay/.test(bridge));

// ④ 端点不接受 agent token（她不该能改自己的主动权限）
const gp = bridge.indexOf("url.pathname === '/api/socialV2/proactive-sessions'");
const seg = bridge.slice(gp, gp + 1200);
console.log('\n=== 权限边界 ===');
ok('GET 分支不校验 agent token（只给面板）', !/x-agent-token/.test(seg.split('POST')[0] || ''));

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
