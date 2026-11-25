// 合并后的主入口：dsh-qq-companion
//
// 把原来四个插件的能力收在一个包里：
//
//   ① 身份/令牌注入     ./agent-context.js   （原 qq-agent-context）
//   ② 预设             ./presets/*.patch.yml + ./tool-restrict.mjs
//                       （原 qq-agent-presets；预设由 bundle patch 注入，
//                         守卫由预设行以 dsh-qq-companion/tool-restrict.mjs 引用）
//   ③ 浮游球面板       ./panel.js + ./features/* + ./client.js（原 qq-dsh-panel）
//   ④ /compact_chat    ./compact-chat.js     （原 dsh-command-compact-chat）
//
// ── 关键设计：每个子模块**各自**用 ctx.inject 开作用域 ──────────────────────
//
// 不把四个 inject 并成一个数组当本插件的 inject。原因（2026-11-25 实测）：
// Cordis 的 inject 里只要有一个服务在插件作用域里拿不到，**apply 永远不会
// 被调用，而且不报任何错**。当时 inject 里多写了一个 tokenMeter，日志只有
// 「模块已加载」、没有「apply 被调用」，查了很久才发现。
//
// 用 ctx.inject([...], child => ...) 的话，缺哪个服务就只跳过那个子模块，
// 其余照常装配 —— 一个坏掉不会拖垮全部。
//
// 本插件的 `inject` 保持空数组：它自己不直接依赖任何服务。

import * as thinkingZh from './features/thinking-zh.js'
import * as qqBigfish from './features/qq-bigfish.js'
import * as agentContext from './agent-context.js'
import * as compactChat from './compact-chat.js'

export const name = 'dsh-qq-companion'
export const inject = []

const FEATURES = [thinkingZh, qqBigfish]

/**
 * 装配一个子模块：用它自己的 inject 声明开作用域，再调它的 apply。
 *
 * @param ctx     父上下文
 * @param label   日志用标签
 * @param mod     子模块（需导出 apply，可选 name/inject）
 * @param config  传给子模块 apply 的配置
 */
function mountChild(ctx, label, mod, config = {}) {
  if (mod === undefined || typeof mod.apply !== 'function') {
    console.error(`[dsh-qq-companion] ${label} 模块无效（缺 apply）`)
    return
  }
  const deps = Array.isArray(mod.inject) ? mod.inject : []
  ctx.inject(deps, (child) => {
    try {
      child.effect(() => mod.apply(child, config))
      console.log(`[dsh-qq-companion] ${label} 已装配`)
    } catch (error) {
      console.error(`[dsh-qq-companion] ${label} 装配失败：`, error?.message ?? error)
    }
  })
}

export function apply(ctx, config) {
  console.log('[dsh-qq-companion] 开始装配子模块')

  // ── ① 浮游球面板（host 半）──────────────────────────────────────────
  // 面板 host 自己 mount 各 feature，需要 systemPrompt + webServer。
  ctx.inject(['systemPrompt', 'webServer'], (child) => {
    const disposers = []
    try {
      for (const feature of FEATURES) {
        const dispose = feature.mount(child)
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      child.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose() } catch {}
        }
      })
      console.log(`[dsh-qq-companion] 面板已装配；features=${FEATURES.map((f) => f.id).join(',')}`)
    } catch (error) {
      console.error('[dsh-qq-companion] 面板装配失败：', error?.message ?? error)
    }
  })

  // ── ② 身份/令牌注入 ─────────────────────────────────────────────────
  // 配置从本插件的 patch 里透传（bridgeUrl / tokenFile）。
  mountChild(ctx, '身份注入', agentContext, {
    bridgeUrl: config?.bridgeUrl,
    tokenFile: config?.tokenFile,
  })

  // ── ③ /compact_chat 命令 ────────────────────────────────────────────
  mountChild(ctx, '/compact_chat', compactChat, {
    retainTokens: config?.compactRetainTokens,
    maxTokens: config?.compactMaxTokens,
  })
}
