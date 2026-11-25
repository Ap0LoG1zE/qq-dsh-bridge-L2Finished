/* qq-dsh-panel client — a floating dock.
 *
 * One draggable ball lives in a page corner; clicking it opens a small panel
 * with one row per feature. The ball is mounted on <body> and positioned with
 * `position: fixed`, so it never depends on the composer's internal DOM (which
 * carries build-hashed CSS-module class names and changes between releases).
 *
 * This file is a DSH client plugin (package.json `dsh.client` +
 * `exports["./client"]`), registered through the page's module loader. That is
 * the only client path the Electron window honours: its main window loads
 * `dsh://app/`, not the HTTP origin, so `webServer.tapIndex` injection never
 * reaches it.
 *
 * Adding a feature: append a descriptor to FEATURES below and a matching
 * lib/features/<id>.js on the host side. The panel renders whatever it finds.
 */
window.__ModuleLoader__.load({
  id: 'qq-dsh-panel',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

  var BALL = 46
  var MARGIN = 14
  var POS_KEY = 'dsh-floatdock:pos:v1'

  // 球面图标：QQ 大肥鱼（和 FEATURES 里的 ICON_FISH 同一形象，按 20px 视口重绘）。
  // 直接把 16px 的 ICON_FISH 塞进 20px 球里会显得偏小且线条偏细，所以单独画一版：
  // 主体放大到 3.2~16.8，描边 1.4，眼睛跟着上移一点点。
  var ICON_BALL =
    '<svg width="21" height="21" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M3.2 10c1.9-3.5 4.8-5.3 7.6-5.3 2.9 0 5 1.9 5.9 5.3-.9 3.4-3 5.3-5.9 5.3-2.8 0-5.7-1.8-7.6-5.3Z" '
    + 'stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M16.7 10c1-.9 1.8-1.5 2.4-1.8M16.7 10c1 .9 1.8 1.5 2.4 1.8" '
    + 'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".85"/>' +
    '<circle cx="7.6" cy="8.7" r="1" fill="currentColor"/>' +
    '</svg>'


  var ICON_FISH =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M2.7 8c1.5-2.8 3.8-4.2 6-4.2 2.3 0 4 1.5 4.7 4.2-.7 2.7-2.4 4.2-4.7 4.2-2.2 0-4.5-1.4-6-4.2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<path d="M13.4 8c.8-.8 1.5-1.3 2-1.5M13.4 8c.8.8 1.5 1.3 2 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>' +
    '<circle cx="6.2" cy="6.9" r=".8" fill="currentColor"/>' +
    '</svg>'

  var ICON_GEAR =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.25"/>' +
    '<path d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
    '</svg>'

  // 思考链中文：气泡里三个点，和「思考」的语义对得上。
  var ICON_THINK =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="2.4" y="3.3" width="11.2" height="6.9" rx="1.7" stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M5.5 10.2v2.4l2.6-2.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<circle cx="5.9" cy="6.75" r=".78" fill="currentColor"/>' +
    '<circle cx="8" cy="6.75" r=".78" fill="currentColor"/>' +
    '<circle cx="10.1" cy="6.75" r=".78" fill="currentColor"/>' +
    '</svg>'

  /* ---------------- feature registry ---------------- */

  var FEATURES = [
    {
      id: 'qq-bigfish',
      title: 'QQ 大肥鱼',
      hint: '把 DeepSeek 部署到 QQ 群',
      icon: ICON_FISH,
      api: '/qq-dsh-panel/qq-bigfish',
      // 开关走独立端点：桥接用 socialV2.paused 表示「下线」，语义与 enabled 不同。
      toggle: { path: '/qq-dsh-panel/qq-bigfish/toggle', key: 'online', statusKey: 'online' },
      offText: '已下线',
      settings: true,
      state: { enabled: true },
    },
  ]

  var ball = null
  var panel = null
  var toastEl = null
  var toastTimer = 0
  var open = false
  var drag = null
  var pos = { left: 0, top: 0 }
  // 当前这个实例的拆卸句柄。HMR 换代码时靠它先清场，再挂新的。
  var instance = null

  /* ---------------- geometry ---------------- */

  function clampPos(left, top) {
    var maxL = Math.max(MARGIN, window.innerWidth - BALL - MARGIN)
    var maxT = Math.max(MARGIN, window.innerHeight - BALL - MARGIN)
    return {
      left: Math.min(Math.max(MARGIN, left), maxL),
      top: Math.min(Math.max(MARGIN, top), maxT),
    }
  }

  function defaultPos() {
    return clampPos(window.innerWidth - BALL - 18, window.innerHeight - BALL - 132)
  }

  function loadPos() {
    try {
      var raw = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null')
      if (raw && typeof raw.left === 'number' && typeof raw.top === 'number') return raw
    } catch (e) {}
    return null
  }

  function savePos() {
    try {
      window.localStorage.setItem(POS_KEY, JSON.stringify({ left: pos.left, top: pos.top }))
    } catch (e) {}
  }

  function applyPos() {
    if (!ball) return
    ball.style.left = Math.round(pos.left) + 'px'
    ball.style.top = Math.round(pos.top) + 'px'
  }

  /* ---------------- styles ---------------- */

  function injectStyle() {
    if (document.getElementById('dsh-fb-style')) return
    var style = document.createElement('style')
    style.id = 'dsh-fb-style'
    style.textContent = [
      '@keyframes dsh-fb-pop{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}',
      '@keyframes dsh-fb-fade{from{opacity:0}to{opacity:1}}',

      '.dsh-fb-ball{position:fixed;width:' + BALL + 'px;height:' + BALL + 'px;border-radius:50%;',
      'display:grid;place-items:center;z-index:2147482000;cursor:grab;touch-action:none;user-select:none;',
      'background:var(--dsw-alias-bg-layer-2,#202024);',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#202024) 80%,transparent);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));',
      'color:var(--dsw-alias-brand-primary,#4d6bfe);',
      'box-shadow:0 8px 26px rgba(0,0,0,.3),0 1px 0 rgba(255,255,255,.06) inset;',
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);',
      'transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;',
      'animation:dsh-fb-fade .2s ease}',
      '.dsh-fb-ball:hover{transform:scale(1.07);border-color:var(--dsw-alias-brand-primary,rgba(77,107,254,.5))}',
      '.dsh-fb-ball[data-drag="1"]{cursor:grabbing;transform:scale(1.03);transition:none}',
      '.dsh-fb-ball[data-open="1"]{border-color:var(--dsw-alias-brand-primary,rgba(77,107,254,.55))}',
      '.dsh-fb-ball svg{pointer-events:none;display:block}',

      '.dsh-fb-panel{position:fixed;z-index:2147482001;width:304px;max-width:calc(100vw - 16px);',
      'border-radius:14px;box-sizing:border-box;overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-2,#202024);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));',
      'box-shadow:0 20px 52px rgba(0,0,0,.38);',
      'color:var(--dsw-alias-label-primary,#ececec);',
      'font-family:var(--dsw-font-family,inherit);font-size:13px;',
      'animation:dsh-fb-pop .16s ease}',

      '.dsh-fb-head{display:flex;align-items:center;justify-content:space-between;',
      'padding:11px 12px 9px 14px;font-size:11.5px;font-weight:600;letter-spacing:.04em;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      '.dsh-fb-x{width:22px;height:22px;border:none;border-radius:6px;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94);display:grid;place-items:center;padding:0;font-size:15px;line-height:1}',
      '.dsh-fb-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));',
      'color:var(--dsw-alias-label-primary,#ececec)}',

      '.dsh-fb-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',

      '.dsh-fb-item{padding:2px 0 4px}',
      '.dsh-fb-row{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer}',
      '.dsh-fb-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.09))}',
      '.dsh-fb-ico{flex:none;width:28px;height:28px;border-radius:8px;display:grid;place-items:center;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 14%,transparent);',
      'color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-ico svg{display:block}',
      '.dsh-fb-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dsh-fb-text b{font-weight:600;font-size:13px;line-height:1.35}',
      '.dsh-fb-text span{font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8d8d94);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      '.dsh-fb-switch{flex:none;width:38px;height:21px;border-radius:999px;border:none;padding:0;cursor:pointer;',
      'background:var(--dsw-alias-border-l3,#3d3d44);position:relative;transition:background .15s ease}',
      // 开关打开态用同一个「压暗后的品牌色」：变量若解析成白色，白轨道 + 白滑块 = 看不见。
      '.dsh-fb-switch[data-on="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 88%,#0b1020)}',
      '.dsh-fb-switch::after{content:"";position:absolute;top:2.5px;left:2.5px;width:16px;height:16px;',
      'border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .15s ease}',
      '.dsh-fb-switch[data-on="1"]::after{transform:translateX(17px)}',

      '.dsh-fb-wslist{display:flex;flex-direction:column;gap:2px;padding:0 14px 4px}',
      '.dsh-fb-wsrow{display:flex;align-items:flex-start;gap:9px;padding:7px 8px;border-radius:8px;cursor:pointer}',
      '.dsh-fb-wsrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.09))}',
      '.dsh-fb-wsrow input{margin:2px 0 0;flex:none;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-wstext{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsh-fb-wstext b{font-size:12.5px;font-weight:600;line-height:1.35}',
      '.dsh-fb-wstext small{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8d8d94);word-break:break-all}',
      '.dsh-fb-modes{display:flex;gap:5px;padding:0 14px 8px 52px;flex-wrap:wrap}',
      '.dsh-fb-mode{border:none;cursor:pointer;padding:4px 10px;border-radius:7px;font-size:11.5px;line-height:1.4;',
      'font-family:inherit;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.13));',
      'color:var(--dsw-alias-label-secondary,#a5a5ad);transition:background .13s ease,color .13s ease}',
      '.dsh-fb-mode:hover{color:var(--dsw-alias-label-primary,#ececec)}',
      '.dsh-fb-mode[data-active="1"]{background:rgba(77,107,254,.16);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 20%,transparent);',
      'color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}',

      '.dsh-fb-foot{padding:8px 14px 10px;font-size:11px;line-height:1.5;',
      'color:var(--dsw-alias-label-tertiary,#7f7f87);border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}',

      '.dsh-fb-toast{position:fixed;z-index:2147482002;transform:translateX(-50%);padding:7px 13px;',
      'border-radius:8px;background:var(--dsw-alias-tooltip-bg,rgba(0,0,0,.86));color:#fff;',
      'font-size:12.5px;line-height:1.4;font-family:var(--dsw-font-family,inherit);white-space:nowrap;',
      'pointer-events:none;transition:opacity .16s ease;max-width:74vw}',

      /* ── 设置按钮（在开关左边） ── */
      '.dsh-fb-gear{flex:none;width:26px;height:26px;border:none;border-radius:7px;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94);display:grid;place-items:center;padding:0;transition:background .13s ease,color .13s ease}',
      '.dsh-fb-gear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-gear svg{display:block}',

      /* ── 大设置窗口 ── */
      '.dsh-fb-modal{position:fixed;inset:0;z-index:2147482100;display:grid;place-items:center;',
      'background:rgba(0,0,0,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);animation:dsh-fb-fade .14s ease}',
      '.dsh-fb-dialog{width:min(940px,94vw);height:min(700px,88vh);display:flex;flex-direction:column;overflow:hidden;',
      'border-radius:16px;background:var(--dsw-alias-bg-layer-1,#17171a);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));',
      'box-shadow:0 28px 80px rgba(0,0,0,.5);',
      'color:var(--dsw-alias-label-primary,#ececec);font-family:var(--dsw-font-family,inherit);font-size:13px;',
      'animation:dsh-fb-pop .18s ease}',
      '.dsh-fb-dlg-head{display:flex;align-items:center;justify-content:space-between;padding:13px 14px 11px 16px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}',
      '.dsh-fb-dlg-title{display:flex;align-items:center;gap:9px}',
      '.dsh-fb-dlg-ico{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 15%,transparent);',
      'color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-dlg-ico svg{display:block}',
      '.dsh-fb-dlg-title b{font-size:14px;font-weight:600}',
      '.dsh-fb-dlg-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      '.dsh-fb-tabs{display:flex;gap:4px;padding:8px 12px 0;flex-wrap:wrap;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}',
      '.dsh-fb-tab{border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:12.5px;',
      'padding:7px 12px;border-radius:8px 8px 0 0;color:var(--dsw-alias-label-secondary,#a5a5ad)}',
      '.dsh-fb-tab:hover{color:var(--dsw-alias-label-primary,#ececec)}',
      '.dsh-fb-tab[data-active="1"]{color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600;',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 11%,transparent)}',
      '.dsh-fb-dlg-body{flex:1;overflow:auto;padding:16px}',
      '.dsh-fb-sec{margin-bottom:18px}',
      '.dsh-fb-sec h4{margin:0 0 9px;font-size:11.5px;font-weight:600;letter-spacing:.04em;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      '.dsh-fb-kv{display:flex;justify-content:space-between;gap:14px;padding:6px 0;font-size:12.5px;',
      'border-bottom:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.14))}',
      '.dsh-fb-kv:last-child{border-bottom:none}',
      '.dsh-fb-kv span:first-child{color:var(--dsw-alias-label-tertiary,#8d8d94);flex:none}',
      '.dsh-fb-kv span:last-child{text-align:right;word-break:break-all}',
      '.dsh-fb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:11px}',
      '.dsh-fb-field{display:flex;flex-direction:column;gap:5px}',
      '.dsh-fb-field label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#a5a5ad)}',
      '.dsh-fb-field small{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#7f7f87)}',
      '.dsh-fb-input,.dsh-fb-area{font-family:inherit;font-size:12.5px;box-sizing:border-box;width:100%;',
      'padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'background:var(--dsw-alias-bg-layer-2,#202024);color:var(--dsw-alias-label-primary,#ececec)}',
      '.dsh-fb-input:focus,.dsh-fb-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-area{min-height:260px;resize:vertical;line-height:1.55;margin-top:8px;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      // 主按钮：不能直接用 --dsw-alias-brand-primary 当背景 —— 某些暗色主题下这个变量
      // 解析成浅色（实测渲出白底），而文字是固定 #fff，于是白底白字不可见。
      // 用 color-mix 把它压暗一点并保证最低饱和度：即便变量是白色，混出来的也是可读的蓝灰。
      '.dsh-fb-btn{border:none;cursor:pointer;font-family:inherit;font-size:12.5px;padding:8px 15px;border-radius:9px;',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 88%,#0b1020);',
      'color:#fff;font-weight:600;transition:filter .13s ease,background .13s ease}',
      '.dsh-fb-btn:hover{filter:brightness(1.12)}',
      '.dsh-fb-btn[disabled]{opacity:.5;cursor:default;filter:none}',
      '.dsh-fb-btn.ghost{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-label-primary,#ececec);font-weight:500}',
      '.dsh-fb-btn.danger{background:rgba(206,62,62,.92)}',
      '.dsh-fb-actions{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}',
      '.dsh-fb-check{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px;line-height:1.45}',
      // 状态行的成功/警告配色：早先只有 -ok 这个 class 被用过、却从没定义过样式，
      // 于是"✓ 运行中"一直是裸文本。这里把两个都补上，语音的服务状态也要用。
      '.dsh-fb-check-ok{color:#3fbf6f}',
      '.dsh-fb-check-warn{color:#d99a2b}',
      '.dsh-fb-dot{flex:none;width:8px;height:8px;border-radius:50%}',
      '.dsh-fb-dot.ok{background:#3fbf6f}',
      '.dsh-fb-dot.bad{background:#d64040}',
      '.dsh-fb-empty{color:var(--dsw-alias-label-tertiary,#7f7f87);font-size:12.5px;padding:8px 0;line-height:1.5}',
      '.dsh-fb-warn{color:#e0a33a;font-size:11.5px;line-height:1.55;margin-top:8px}',
      '.dsh-fb-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(162px,1fr));gap:10px}',
      '.dsh-fb-card{padding:11px 13px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,#202024);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}',
      '.dsh-fb-card b{display:block;font-size:18px;font-weight:600;margin-bottom:3px;word-break:break-all}',
      '.dsh-fb-card span{font-size:11px;color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      '.dsh-fb-thumb{width:100%;height:84px;object-fit:contain;border-radius:8px;margin-bottom:8px;display:block;',
      'background:var(--dsw-alias-bg-layer-1,#17171a)}',
      '.dsh-fb-mini{border:none;cursor:pointer;font-family:inherit;font-size:11px;padding:3px 8px;border-radius:6px;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-label-secondary,#a5a5ad);margin-right:5px;margin-top:6px;transition:color .13s ease}',
      '.dsh-fb-mini:hover{color:var(--dsw-alias-label-primary,#ececec)}',
      '.dsh-fb-mini.danger:hover{color:#ff8a8a}',

      // ── 长期记忆（L2）卡片 ─────────────────────────────────────────
      // 单列流式布局，不用 .dsh-fb-cards 的网格：事实是长短不一的句子，
      // 网格会把它切成等宽小方块，读起来像标签墙。
      '.dsh-fb-facts{display:flex;flex-direction:column;gap:8px}',
      '.dsh-fb-fact{position:relative;display:flex;gap:11px;align-items:flex-start;',
      'padding:12px 13px 12px 11px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2,#202024);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));',
      'transition:border-color .14s ease,background .14s ease}',
      '.dsh-fb-fact:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.3))}',
      // 左侧色条：一眼分辨类别，不占正文宽度
      '.dsh-fb-fact-bar{flex:none;width:3px;align-self:stretch;border-radius:2px;opacity:.85}',
      '.dsh-fb-fact-main{flex:1;min-width:0}',
      '.dsh-fb-fact-text{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#ececec);',
      'word-break:break-word;margin-bottom:7px}',
      '.dsh-fb-fact-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      // 权重徽标：数值本身是这张卡最重要的信息
      '.dsh-fb-w{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:5px;',
      'font-variant-numeric:tabular-nums;font-weight:600;font-size:11px;letter-spacing:.2px}',
      '.dsh-fb-w.hi{background:rgba(63,191,111,.16);color:#4fd486}',
      '.dsh-fb-w.mid{background:rgba(224,163,58,.16);color:#e0a33a}',
      '.dsh-fb-w.lo{background:rgba(127,127,127,.16);color:#9a9aa2}',
      '.dsh-fb-tag{display:inline-block;padding:2px 7px;border-radius:5px;font-size:11px;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-label-secondary,#a5a5ad)}',
      '.dsh-fb-fact-del{flex:none;border:none;cursor:pointer;font-family:inherit;font-size:11px;',
      'padding:4px 9px;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94);opacity:0;',
      'transition:opacity .14s ease,color .14s ease,background .14s ease}',
      // 删除按钮平时隐起来，悬停才出现 —— 避免一屏全是红按钮
      '.dsh-fb-fact:hover .dsh-fb-fact-del{opacity:1}',
      '.dsh-fb-fact-del:hover{background:rgba(206,62,62,.16);color:#ff8a8a}',
      '@media (hover:none){.dsh-fb-fact-del{opacity:1}}',
      // 已武装（第一次点过，等待确认）：常显 + 红底，跟普通态明确区分
      '.dsh-fb-fact-del.armed{opacity:1;background:rgba(206,62,62,.9);color:#fff;font-weight:600}',
      '.dsh-fb-fact-del.armed:hover{background:rgba(206,62,62,1);color:#fff}',
      // 空状态
      '.dsh-fb-facts-empty{text-align:center;padding:34px 16px;border-radius:10px;',
      'border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.28));',
      'background:var(--dsw-alias-bg-layer-1,#17171a)}',
      '.dsh-fb-facts-empty .t{font-size:13px;color:var(--dsw-alias-label-secondary,#a5a5ad);margin-bottom:6px}',
      '.dsh-fb-facts-empty .s{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#7f7f87);line-height:1.6}',

      // ── 群友印象卡片 ───────────────────────────────────────────────
      // 两列网格：名字短、条目短，单列会浪费横向空间。
      '.dsh-fb-imp{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:9px}',
      '.dsh-fb-impcard{position:relative;padding:11px 12px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2,#202024);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));',
      'transition:border-color .14s ease}',
      '.dsh-fb-impcard:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.3))}',
      '.dsh-fb-imphead{margin-bottom:7px;padding-right:96px}',
      // 名字用品牌色，和「长期记忆」的正文白区分开 —— 一眼看出这是人不是事
      '.dsh-fb-impname{font-size:13px;font-weight:600;color:var(--dsw-alias-brand-primary,#6ea8fe);',
      'line-height:1.35;word-break:break-all}',
      '.dsh-fb-impmeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8d8d94);margin-top:3px}',
      '.dsh-fb-imptraits{display:flex;flex-direction:column;gap:5px}',
      // 每条印象左侧一条竖线，多条时读起来像列表而不是一段话
      '.dsh-fb-imptrait{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#c9c9d0);',
      'padding-left:8px;border-left:2px solid rgba(127,127,127,.22);word-break:break-word}',

      // ── 卡片操作区（编辑 / 删除） ────────────────────────────────────
      // 绝对定位到右上角：不挤压正文，且两条卡片的按钮永远在同一水平线。
      '.dsh-fb-fact-ops{position:absolute;top:8px;right:8px;display:flex;gap:4px;align-items:center}',
      '.dsh-fb-fact-edit,.dsh-fb-fact-save,.dsh-fb-fact-cancel{border:none;cursor:pointer;',
      'font-family:inherit;font-size:11px;padding:4px 9px;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94);opacity:0;',
      'transition:opacity .14s ease,color .14s ease,background .14s ease}',
      // 悬停显示：三种卡片都要列全。
      // 之前只写了 .dsh-fb-fact / .dsh-fb-impcard，漏了 .dsh-fb-selfnote，
      // 导致「自我」页签的按钮永远停在 opacity:0——点得到但看不见。
      '.dsh-fb-fact:hover .dsh-fb-fact-edit,.dsh-fb-impcard:hover .dsh-fb-fact-edit,',
      '.dsh-fb-selfnote:hover .dsh-fb-fact-edit,',
      '.dsh-fb-fact:hover .dsh-fb-fact-del,.dsh-fb-impcard:hover .dsh-fb-fact-del,',
      '.dsh-fb-selfnote:hover .dsh-fb-fact-del{opacity:1}',
      '.dsh-fb-fact-edit:hover{background:rgba(110,168,254,.14);color:#8fbdff}',
      // 编辑态下按钮常显
      '.dsh-fb-fact.editing .dsh-fb-fact-save,.dsh-fb-fact.editing .dsh-fb-fact-cancel,',
      '.dsh-fb-impcard.editing .dsh-fb-fact-save,.dsh-fb-impcard.editing .dsh-fb-fact-cancel,',
      '.dsh-fb-selfnote.editing .dsh-fb-fact-save,.dsh-fb-selfnote.editing .dsh-fb-fact-cancel{opacity:1}',
      '.dsh-fb-fact-save{background:rgba(63,191,111,.9);color:#fff;font-weight:600}',
      '.dsh-fb-fact-save:hover{background:rgba(63,191,111,1);color:#fff}',
      '.dsh-fb-fact-cancel:hover{background:rgba(127,127,127,.16);color:var(--dsw-alias-label-primary,#ececec)}',
      '@media (hover:none){.dsh-fb-fact-edit,.dsh-fb-fact-del{opacity:1}}',

      // ── 编辑态输入控件 ──────────────────────────────────────────────
      '.dsh-fb-fact.editing,.dsh-fb-impcard.editing{border-color:var(--dsw-alias-brand-primary,rgba(110,168,254,.55))}',
      '.dsh-fb-edit-text{width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;',
      'font-size:12.5px;line-height:1.5;padding:7px 9px;border-radius:7px;',
      'background:var(--dsw-alias-bg-layer-1,#17171a);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'color:var(--dsw-alias-label-primary,#ececec);outline:none}',
      '.dsh-fb-edit-text:focus{border-color:var(--dsw-alias-brand-primary,rgba(110,168,254,.6))}',
      '.dsh-fb-edit-text.small{font-size:12px;margin-bottom:2px}',
      '.dsh-fb-edit-name{width:100%;box-sizing:border-box;font-family:inherit;font-size:13px;font-weight:600;',
      'padding:5px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,#17171a);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'color:var(--dsw-alias-brand-primary,#6ea8fe);outline:none}',
      '.dsh-fb-edit-name:focus{border-color:var(--dsw-alias-brand-primary,rgba(110,168,254,.6))}',
      '.dsh-fb-edit-row{display:flex;align-items:center;gap:8px;margin-top:8px}',
      '.dsh-fb-edit-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      '.dsh-fb-edit-tag{font-family:inherit;font-size:11.5px;padding:4px 8px;border-radius:6px;',
      'background:var(--dsw-alias-bg-layer-1,#17171a);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'color:var(--dsw-alias-label-primary,#ececec);outline:none;cursor:pointer}',

      // ── 自我（时间轴） ──────────────────────────────────────────────
      // 用垂直时间轴：selfNote 是「她怎么一步步变成现在这样」，
      // 顺序本身是信息，卡片流会把这个信息压平。
      '.dsh-fb-self{display:flex;flex-direction:column;gap:0}',
      '.dsh-fb-selfnote{position:relative;display:flex;gap:12px;padding:9px 0 9px 0}',
    // ── 主动机会页（2026-11-18）───────────────────────────────────────────
    // 页头做成一块浅色卡片：全局状态 + 说明 + 汇总数字。
    // 全局关着时整块降低对比度（.is-off），让"开了也没用"这件事一眼可见。
    '.dsh-fb-proact-head{position:relative;padding:13px 15px;border-radius:12px;margin-bottom:10px;',
    'background:var(--dsw-alias-bg-l2,rgba(127,127,127,.06));',
    'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18))}',
    '.dsh-fb-proact-head.is-off{opacity:.72}',
    '.dsh-fb-proact-headtop{display:flex;align-items:center;gap:8px;font-size:13.5px;',
    'color:var(--dsw-alias-text-primary,inherit)}',
    // 状态灯：开启时是品牌色 + 呼吸光，关闭时灰点
    '.dsh-fb-proact-dot{flex:none;width:8px;height:8px;border-radius:999px;',
    'background:var(--dsw-alias-text-quaternary,rgba(127,127,127,.5))}',
    '.dsh-fb-proact-dot.is-on{background:var(--dsw-alias-brand-primary,#4d6bfe);',
    'box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 22%,transparent)}',
    '.dsh-fb-proact-sub{display:block;margin-top:7px;font-size:11.5px;line-height:1.6;',
    'color:var(--dsw-alias-text-tertiary,rgba(127,127,127,.95))}',
    '.dsh-fb-proact-stats{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
    '.dsh-fb-proact-stat{font-size:11px;padding:3px 9px;border-radius:999px;',
    'background:var(--dsw-alias-bg-l3,rgba(127,127,127,.10));',
    'color:var(--dsw-alias-text-secondary,rgba(127,127,127,1))}',
    // 会话列表：每行之间的分隔线收得更轻，避免和开关本身抢视觉
    '.dsh-fb-proact-list .dsh-fb-item + .dsh-fb-item{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.10))}',
    // ── 私聊额度详情卡（2026-11-24）────────────────────────────────────
    // 挂在会话开关下面，视觉上是"这个会话的详情"，不是新的一节。
    '.dsh-fb-tierwrap{margin:8px 0 2px 34px}',
    '.dsh-fb-tiercard{padding:10px 12px;border-radius:10px;',
    'background:var(--dsw-alias-bg-l3,rgba(127,127,127,.07));',
    'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));',
    'display:flex;flex-direction:column;gap:7px}',
    '.dsh-fb-tierhead{display:flex;align-items:baseline;gap:8px}',
    '.dsh-fb-tierhead b{font-size:12.5px;color:var(--dsw-alias-text-primary,inherit)}',
    '.dsh-fb-tiersub{font-size:11px;color:var(--dsw-alias-text-tertiary,rgba(127,127,127,.95))}',
    // 今日额度进度条
    '.dsh-fb-tierbar{height:5px;border-radius:999px;overflow:hidden;',
    'background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14))}',
    '.dsh-fb-tierfill{height:100%;border-radius:999px;',
    'background:var(--dsw-alias-brand-primary,#4d6bfe);transition:width .2s ease}',
    // 用满时换色：不是报错，只是"今天说够了"
    '.dsh-fb-tierfill.is-full{background:var(--dsw-alias-text-quaternary,rgba(127,127,127,.55))}',
    '.dsh-fb-tierfacts{display:flex;gap:8px;flex-wrap:wrap}',
    '.dsh-fb-tierfact{font-size:11px;padding:2px 8px;border-radius:999px;',
    'background:var(--dsw-alias-bg-l2,rgba(127,127,127,.10));',
    'color:var(--dsw-alias-text-secondary,rgba(127,127,127,1))}',
    // 未回应导致放缓：用暖色，和普通信息区分开
    '.dsh-fb-tierfact.is-warn{background:color-mix(in srgb,var(--dsw-alias-warning-primary,#d97706) 16%,transparent);',
    'color:var(--dsw-alias-warning-primary,#d97706)}',
    // 时段分布小柱
    '.dsh-fb-tierdays{display:flex;gap:10px;align-items:flex-end;padding-top:2px}',
    '.dsh-fb-tierday{display:flex;flex-direction:column;align-items:center;gap:3px}',
    '.dsh-fb-tierdaybar{width:12px;border-radius:3px 3px 0 0;',
    'background:var(--dsw-alias-brand-primary,#4d6bfe);opacity:.8}',
    '.dsh-fb-tierdaybar.is-empty{background:var(--dsw-alias-bg-l1,rgba(127,127,127,.18));opacity:1}',
    '.dsh-fb-tierday span{font-size:10px;color:var(--dsw-alias-text-quaternary,rgba(127,127,127,.8))}',
    '.dsh-fb-tierwarn{font-size:11px;line-height:1.5;',
    'color:var(--dsw-alias-warning-primary,#d97706)}',
      // 竖线：除最后一条外都画，且从圆点中心往下延伸
      '.dsh-fb-selfspine{flex:none;width:11px;position:relative;display:flex;justify-content:center}',
      '.dsh-fb-selfspine::before{content:"";position:absolute;top:15px;bottom:-9px;width:1px;',
      'background:var(--dsw-alias-border-l2,rgba(127,127,127,.22))}',
      '.dsh-fb-selfnote:last-child .dsh-fb-selfspine::before{display:none}',
      '.dsh-fb-selfdot{width:7px;height:7px;border-radius:50%;margin-top:11px;flex:none;',
      'background:var(--dsw-alias-brand-primary,#6ea8fe);',
      // 外圈留白，让圆点从竖线上"浮"起来
      'box-shadow:0 0 0 3px var(--dsw-alias-bg-layer-2,#202024)}',
      '.dsh-fb-selfmain{flex:1;min-width:0;padding:2px 10px 4px 0}',
      '.dsh-fb-selfmeta{display:flex;gap:7px;align-items:center;margin-bottom:5px}',
      '.dsh-fb-selftime{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8d8d94);',
      'font-variant-numeric:tabular-nums}',
      '.dsh-fb-selfedited{font-size:9.5px;padding:1px 5px;border-radius:4px;',
      'background:rgba(224,163,58,.16);color:#e0a33a}',
      // 正文：比长期记忆的行距松一点，这是"她的心里话"，值得慢读
      '.dsh-fb-selftext{font-size:12.5px;line-height:1.72;',
      'color:var(--dsw-alias-label-primary,#ececec);word-break:break-word}',
      '.dsh-fb-selfnote:hover .dsh-fb-selftext{color:#fff}',
      '.dsh-fb-selfnote.editing .dsh-fb-selfmain{max-width:100%}',
      // 编辑态：把正文换成 textarea 后，左右留白收一点，看起来不挤
      '.dsh-fb-selfnote .dsh-fb-fact-ops{top:6px;right:0}',

      // ── 会话分组头 ──────────────────────────────────────────────────
      // 群聊和私聊是两段不同的关系，必须分块；胶囊 + 等宽 key 表明身份。
      '.dsh-fb-selfgroup{margin-bottom:18px}',
      '.dsh-fb-selfgroup:last-child{margin-bottom:0}',
      '.dsh-fb-selfhead{display:flex;align-items:center;gap:8px;margin-bottom:8px;',
      'padding-bottom:7px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}',
      '.dsh-fb-selfpill{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;',
      'background:rgba(127,127,127,.16);color:#a5a5ad}',
      // 群聊用品牌蓝，私聊用紫，一眼分清
      '.dsh-fb-selfpill.group{background:rgba(110,168,254,.16);color:#8fbdff}',
      '.dsh-fb-selfpill.private{background:rgba(155,140,242,.16);color:#b3a6f7}',
      '.dsh-fb-selfkey{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8d8d94);',
      'font-family:ui-monospace,Consolas,monospace}',
      '.dsh-fb-selfcount{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#7f7f87);margin-left:auto}',
    ].join('')
    document.head.appendChild(style)
  }

  /* ---------------- state ---------------- */

  function normalizeFeatureState(feature, value) {
    var raw = value && typeof value === 'object' ? value : {}
    // statusKey 允许 feature 用别的字段名表达开关（QQ 大肥鱼用 online）
    var key = (feature.toggle && feature.toggle.statusKey) || 'enabled'
    feature.state.enabled = typeof raw[key] === 'boolean' ? raw[key] : true
    if (feature.modes) {
      var ids = feature.modes.map(function (m) { return m.id })
      feature.state.mode = ids.indexOf(raw.mode) !== -1 ? raw.mode : ids[0]
    }
  }

  function patchFeature(feature, patch, okText) {
    var prev = { enabled: feature.state.enabled, mode: feature.state.mode }
    if (typeof patch.enabled === 'boolean') feature.state.enabled = patch.enabled
    if (patch.mode) feature.state.mode = patch.mode
    renderPanel()

    // feature 可用 toggle 指定独立端点与字段名：QQ 大肥鱼的开关语义是「上线/下线」，
// 走 /qq-bigfish/toggle 且 body 为 { online: bool }，与 thinking-zh 的 { enabled } 不同。
    var target = (feature.toggle && feature.toggle.path) || feature.api
    var body = patch
    if (feature.toggle && typeof patch.enabled === 'boolean') {
      body = {}
      body[feature.toggle.key || 'online'] = patch.enabled
    }

    fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(function (data) {
        if (data && data.state) normalizeFeatureState(feature, data.state)
        renderPanel()
        if (okText) toast(okText)
      })
      .catch(function () {
        feature.state.enabled = prev.enabled
        feature.state.mode = prev.mode
        renderPanel()
        toast('保存失败，请重试')
      })
  }

  function syncFeature(feature) {
    return fetch(feature.api, { cache: 'no-store' })
      .then(function (res) {
        return res.ok ? res.json() : null
      })
      .then(function (data) {
        if (!data || !data.state) return
        normalizeFeatureState(feature, data.state)
        if (open) renderPanel()
      })
      .catch(function () {})
  }

  /* ---------------- panel ---------------- */

  function togglePanel() {
    if (open) closePanel()
    else openPanel()
  }

  function openPanel() {
    if (open) return
    open = true
    ball.dataset.open = '1'

    panel = document.createElement('div')
    panel.className = 'dsh-fb-panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', '小工具箱')

    var head = document.createElement('div')
    head.className = 'dsh-fb-head'
    var title = document.createElement('span')
    title.textContent = '小工具箱'
    var close = document.createElement('button')
    close.type = 'button'
    close.className = 'dsh-fb-x'
    close.setAttribute('aria-label', '关闭')
    close.textContent = '✕'
    close.addEventListener('click', function (e) {
      e.stopPropagation()
      closePanel()
    })
    head.appendChild(title)
    head.appendChild(close)

    var body = document.createElement('div')
    body.className = 'dsh-fb-body'

    var foot = document.createElement('div')
    foot.className = 'dsh-fb-foot'
    foot.textContent = '拖动小球可移动位置'

    var sep = document.createElement('div')
    sep.className = 'dsh-fb-sep'

    panel.appendChild(head)
    panel.appendChild(body)
    panel.appendChild(sep)
    panel.appendChild(foot)
    document.body.appendChild(panel)

    renderPanel()
    positionPanel()

    setTimeout(function () {
      document.addEventListener('pointerdown', onDocDown, true)
    }, 0)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', positionPanel)
  }

  function closePanel() {
    if (!open) return
    open = false
    if (ball) ball.dataset.open = '0'
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
    panel = null
    document.removeEventListener('pointerdown', onDocDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('resize', positionPanel)
  }

  function onDocDown(e) {
    if (!open) return
    if (panel && panel.contains(e.target)) return
    if (ball && (e.target === ball || ball.contains(e.target))) return
    closePanel()
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') closePanel()
  }

  function positionPanel() {
    if (!panel || !ball) return
    panel.style.visibility = 'hidden'
    panel.style.display = 'block'
    var pr = panel.getBoundingClientRect()
    var gap = 10
    var rightHalf = pos.left + BALL / 2 > window.innerWidth / 2
    var left = rightHalf ? pos.left + BALL - pr.width : pos.left
    left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, left))
    var top = pos.top - pr.height - gap
    if (top < 8) top = Math.min(window.innerHeight - pr.height - 8, pos.top + BALL + gap)
    panel.style.left = Math.round(left) + 'px'
    panel.style.top = Math.round(Math.max(8, top)) + 'px'
    panel.style.visibility = 'visible'
  }

  function renderPanel() {
    if (!panel) return
    var body = panel.querySelector('.dsh-fb-body')
    if (!body) return
    body.textContent = ''
    for (var i = 0; i < FEATURES.length; i++) body.appendChild(featureItem(FEATURES[i]))
    if (open) positionPanel()
  }

  function featureItem(feature) {
    var item = document.createElement('div')
    item.className = 'dsh-fb-item'

    var row = document.createElement('div')
    row.className = 'dsh-fb-row'

    var ico = document.createElement('span')
    ico.className = 'dsh-fb-ico'
    ico.innerHTML = feature.icon

    var text = document.createElement('div')
    text.className = 'dsh-fb-text'
    var title = document.createElement('b')
    title.textContent = feature.title
    var hint = document.createElement('span')
    hint.textContent = feature.state.enabled ? feature.hint : (feature.offText || '已关闭')
    text.appendChild(title)
    text.appendChild(hint)

    var sw = document.createElement('button')
    sw.type = 'button'
    sw.className = 'dsh-fb-switch'
    sw.dataset.on = feature.state.enabled ? '1' : '0'
    sw.setAttribute('aria-pressed', feature.state.enabled ? 'true' : 'false')
    sw.setAttribute('aria-label', feature.title)

    function flip(e) {
      if (e) e.stopPropagation()
      var next = !feature.state.enabled
      patchFeature(
        feature,
        { enabled: next },
        next ? '已开启「' + feature.title + '」· 下一轮生效' : '已关闭「' + feature.title + '」'
      )
    }

    sw.addEventListener('click', flip)
    row.addEventListener('click', flip)

    row.appendChild(ico)
    row.appendChild(text)

    if (feature.settings) {
      // 齿轮必须自己 stopPropagation：整行点击是「切换开关」，
      // 不拦住的话点设置会顺手把机器人下线。
      var gear = document.createElement('button')
      gear.type = 'button'
      gear.className = 'dsh-fb-gear'
      gear.title = '打开设置'
      gear.setAttribute('aria-label', feature.title + ' · 设置')
      gear.innerHTML = ICON_GEAR
      gear.addEventListener('click', function (e) {
        e.stopPropagation()
        openSettings(feature)
      })
      row.appendChild(gear)
    }

    row.appendChild(sw)
    item.appendChild(row)

    if (feature.modes && feature.state.enabled) {
      var modes = document.createElement('div')
      modes.className = 'dsh-fb-modes'
      for (var i = 0; i < feature.modes.length; i++) {
        ;(function (mode) {
          var b = document.createElement('button')
          b.type = 'button'
          b.className = 'dsh-fb-mode'
          b.dataset.active = feature.state.mode === mode.id ? '1' : '0'
          b.textContent = mode.label
          b.addEventListener('click', function (e) {
            e.stopPropagation()
            patchFeature(feature, { enabled: true, mode: mode.id }, '已切换为「' + mode.label + '」· 下一轮生效')
          })
          modes.appendChild(b)
        })(feature.modes[i])
      }
      item.appendChild(modes)
    }

    return item
  }

  /* ---------------- settings modal ---------------- */

  var TABS = [
    { id: 'status', label: '状态' },
    // 「思考链中文」原本混在「状态」页里，但它跟 QQ 机器人无关（管的是模型怎么推理，
    // 不是怎么回消息），放在状态页会让人以为那是机器人配置的一部分。单独成栏。
    { id: 'thinking', label: '思考链' },
    { id: 'facts', label: '长期记忆' },
    { id: 'impressions', label: '群友印象' },
    { id: 'todos', label: '待办' },
    // 2026-11-18：按会话开关「她能不能主动开口」。
    // 放在待办旁边：都属于"她自己会做的事"，和状态/节奏分开看更清楚。
    { id: 'proactive', label: '主动机会' },
    { id: 'self', label: '自我' },
    { id: 'rhythm', label: '回复节奏' },
    { id: 'persona', label: '人格' },
    { id: 'tokens', label: 'Token 花费' },
    { id: 'stickers', label: '表情' },
    { id: 'access', label: '访问控制' },
    { id: 'backend', label: '后端' },
    // 2026-11-24：原「诊断」页替换成「状态」页。
    // 诊断那套（自检 / 端点对齐 / 模型）仍有 `id: 'diagnose'` 保留在 URL 路由里，
    // 需要时可以改回来；页签上先让位给生活状态。
    { id: 'life', label: '状态' },
  ]

  // [字段路径, 显示名, 说明, 附加]
  //   附加 'bool'      → 渲染成勾选框
  //   附加 'sec'       → 单位是**秒**（后端存毫秒，读写时自动 ×1000 / ÷1000）
  //
  // 2026-11-19 操作者要求：时间类字段一律显示秒。填 "30" 就是 30 秒，
  // 比填 30000 直观得多。字段名里带 Ms 的那些都要加 'sec'。
  var RHYTHM_FIELDS = [
    ['autoReplyCheckMs', '唤醒检查间隔', '秒。「秒回」取决于它：越小越快，但检查更频繁', 'sec'],
    ['send.burstMaxMessages', '单次最多几条', '一轮回复最多拆成几条消息'],
    ['send.burstIntervalMinMs', '条间最短间隔', '秒。几句之间随机停顿的下限', 'sec'],
    ['send.burstIntervalMaxMs', '条间最长间隔', '秒。几句之间随机停顿的上限', 'sec'],
    // 2026-11-19 新增：操作者要在面板上调「发完空转多久」。
    // 语义（操作者最终口径，实测确认）：**句间时间 + 这个值**。
    // 句间那几秒照常流逝，之后再额外等满这个秒数。
    // 实测（句间 1 秒×2、这里填 20）：发 3 条总耗时 22.05 秒。
    // 期间对方发消息就重新倒计时下面的「她主动等你回消息多久没动静算说完」。
    ['send.observeAfterSendMs', '发完后额外再等多久', '秒。句与句之间的停顿**之后**再等这么久（两者相加）。听到对方说话只会重新计下面的「她主动等你回消息多久没动静算说完」，不再叠加这一段', 'sec'],
    ['send.maxSendPerMinute', '每分钟峰值', '超过会被桥接限流（防 QQ 风控）'],
    ['send.maxSendPerHour', '每小时峰值', '同上'],
    ['send.maxMessageChars', '单条最大字数', '超出自动按句读切分'],
    ['wait.defaultMs', '等待消息默认时长', '秒。她主动等对方时最长挂多久（qq_wait_for_messages 默认）', 'sec'],
    ['wait.defaultQuietMs', '她主动等你回消息多久没动静算说完', '秒。她调 qq_wait_for_messages 主动等你时，你发一句后要安静这么久，她才认为你说完了；期间又来一句就重新计时（所以连发几句会被合成一次回）', 'sec'],
    ['wake.batchWindowMs', '唤醒合并窗口', '秒。多条消息合并成一次唤醒', 'sec'],
    ['wake.maxWakePerHour', '每小时最多唤醒', '防止反复自我唤醒'],
    ['context.recentLimit', '历史消息保留条数', '每个会话最多存多少条历史（只是缓存上限）。真正每轮注入几条由下面的唤醒包参数决定，不受这个影响'],
    // QQ 空间：它只是一个工具，不是日程任务。这里控制「能不能发 / 一天最多几条」，
    // 不控制"什么时候发"——那由它自己或你临场决定，不存在"到点自动发"。
    ['qzone.enabled', '允许发 QQ 空间（说说）', '关掉后它调不动发说说的工具；开着也只代表"有能力发"，不会自己每天发', 'bool'],
    ['qzone.maxPerDay', '说说每天上限', '防刷屏的上限，不是任务量。默认 2 条'],
  ]

  var modal = null
  var mState = { feature: null, tab: 'status', data: {}, note: '', restoreScroll: 0, thinking: null, workspaces: null }

  function fetchJson(url, options) {
    return fetch(url, options || { cache: 'no-store' })
      .then(function (res) { return res.json().catch(function () { return null }) })
      .catch(function () { return null })
  }

  function postJson(url, body) {
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body || {}),
    })
  }

  function h(tag, cls, text) {
    var el = document.createElement(tag)
    if (cls) el.className = cls
    if (text !== undefined && text !== null) el.textContent = text
    return el
  }

  function section(titleText, nodes) {
    var s = h('div', 'dsh-fb-sec')
    s.appendChild(h('h4', null, titleText))
    for (var i = 0; i < nodes.length; i++) s.appendChild(nodes[i])
    return s
  }

  function kv(k, v) {
    var row = h('div', 'dsh-fb-kv')
    row.appendChild(h('span', null, k))
    row.appendChild(h('span', null, (v === undefined || v === null || v === '') ? '—' : String(v)))
    return row
  }

  function statusLine(text, ok) {
    var row = h('div', 'dsh-fb-check')
    row.appendChild(h('span', 'dsh-fb-dot ' + (ok ? 'ok' : 'bad')))
    row.appendChild(h('span', null, text))
    return row
  }

  function actionsRow(buttons) {
    var row = h('div', 'dsh-fb-actions')
    for (var i = 0; i < buttons.length; i++) {
      (function (spec) {
        var b = h('button', 'dsh-fb-btn' + (spec.ghost ? ' ghost' : '') + (spec.danger ? ' danger' : ''), spec.label)
        b.type = 'button'
        b.addEventListener('click', spec.onClick)
        row.appendChild(b)
      })(buttons[i])
    }
    return row
  }

  /* ---------------- 思考链中文（「状态」页签里的开关） ---------------- */

  // 这个开关不归桥接管：状态由 qq-dsh-panel 插件自己写进 ~/.dsh/.dsh-thinking-zh.json，
  // 所以读写都走插件自己的路由，而不是走 QQ 大肥鱼代理的 f.api。
  // 浮游球小面板里原本那一行已撤掉，入口统一收在「状态」页签里。
  var THINK_STATE_API = '/qq-dsh-panel/state'
  // 工作区清单由宿主侧从 ~/.dsh/storages/workspace.json 读出，页面不直接碰文件。
  var THINK_WORKSPACES_API = '/qq-dsh-panel/workspaces'
  // 顺序即展示顺序：zh 是最"彻底"的一档，放最前面。
  var THINK_MODE_LIST = [
    { id: 'zh', label: '中文', hint: '思考链主干全中文，术语/代码保留英文' },
    { id: 'mixed', label: '中英混用', hint: '计划与结论用中文，复杂推理可用英文' },
    { id: 'auto', label: '跟随', hint: '你说中文它就用中文想，你说英文它就用英文想' },
  ]
  var THINK_MODES = {}
  for (var mi = 0; mi < THINK_MODE_LIST.length; mi++) THINK_MODES[THINK_MODE_LIST[mi].id] = THINK_MODE_LIST[mi].label

  function thinkHint(state) {
    if (!state) return '读不到插件状态（插件可能没加载）'
    if (state.enabled !== true) return '已关闭 · 思考走模型默认语言'
    var mode = THINK_MODES[state.mode] || '中文'
    if (state.scope === 'workspaces') {
      var n = Array.isArray(state.workspaces) ? state.workspaces.length : 0
      return '已开启 · ' + mode + (n === 0 ? ' · 但未选工作区（当前不生效）' : ' · 仅 ' + n + ' 个工作区')
    }
    return '已开启 · ' + mode + ' · 所有工作区'
  }

  // 一行「图标 + 标题 + 说明 + 开关」。样式复用浮游球小面板那一套，
  // 所以设置窗口里的开关和球面板里的看起来完全一致。
  function switchRow(spec) {
    var item = h('div', 'dsh-fb-item')
    var row = h('div', 'dsh-fb-row')
    var ico = h('span', 'dsh-fb-ico')
    ico.innerHTML = spec.icon || ICON_THINK
    var text = h('div', 'dsh-fb-text')
    text.appendChild(h('b', null, spec.title))
    var hint = h('span', null, spec.hint || '')
    text.appendChild(hint)

    var sw = h('button', 'dsh-fb-switch')
    sw.type = 'button'
    sw.setAttribute('aria-label', spec.title)
    function paint(on) {
      sw.dataset.on = on ? '1' : '0'
      sw.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    paint(spec.on === true)
    if (spec.disabled) {
      sw.disabled = true
      sw.style.opacity = '.45'
      sw.style.cursor = 'default'
    }

    function flip(e) {
      if (e) e.stopPropagation()
      if (spec.disabled) return
      var next = spec.on !== true
      spec.on = next
      paint(next)
      if (spec.hintFor) hint.textContent = spec.hintFor(next)
      // revert：请求失败时把界面拨回去，别让开关显示成"成功"。
      spec.onFlip(next, function (ok) {
        if (ok) return
        spec.on = !next
        paint(spec.on)
        if (spec.hintFor) hint.textContent = spec.hintFor(spec.on)
      })
    }

    sw.addEventListener('click', flip)
    if (!spec.disabled) row.addEventListener('click', flip)

    row.appendChild(ico)
    row.appendChild(text)
    row.appendChild(sw)
    item.appendChild(row)
    return item
  }

  // 「思考链」页：只渲染思考语言开关 + 作用范围，不依赖桥接。
  // 桥接挂掉时这一页照样可用（它读的是插件自己的状态文件）。
  function renderThinkingTab(d) {
    var nodes = thinkingSection(
      (d && d.thinking) || mState.thinking,
      (d && d.workspaces) || mState.workspaces || []
    )
    if (!mState.thinking) {
      nodes = [
        h('div', 'dsh-fb-warn', '读不到思考链状态（插件状态文件缺失或插件未加载）。'),
        actionsRow([{ label: '重试', onClick: function () { loadTab('thinking') } }]),
      ]
    }
    setBody(nodes)
  }

  function thinkingSection(thinkState, workspaces) {
    return [
      section('思考语言', [
        switchRow({
          icon: ICON_THINK,
          title: '思考链中文',
          hint: thinkHint(thinkState),
          on: !!(thinkState && thinkState.enabled === true),
          disabled: !thinkState,
          hintFor: function (next) {
            return thinkHint({ enabled: next, mode: thinkState && thinkState.mode })
          },
          onFlip: function (next, revert) {
            postJson(THINK_STATE_API, { enabled: next }).then(function (res) {
              if (res && res.ok && res.state) {
                mState.thinking = res.state
                if (mState.data) mState.data.thinking = res.state
                toast(next ? '已开启「思考链中文」· 下一轮生效' : '已关闭「思考链中文」')
                return
              }
              revert(false)
              toast('保存失败：' + ((res && res.error) || '插件没有响应'))
            })
          },
        }),
        modeChips(thinkState),
      ]),
      section('作用范围', scopeControls(thinkState, workspaces || mState.workspaces || [])),
    ]
  }

  /**
   * 「作用范围」：全部工作区 / 只在这些工作区。
   *
   * 判断依据是会话的 cwd（Host 侧用 session.header.cwd 比对），所以选的是
   * 工作区目录，不是"聊天窗口"。QQ 聊天工作区选中后，只有那边的会话会让
   * 模型用中文思考，这边这条会话不受影响。
   */
  function scopeControls(thinkState, workspaces) {
    var nodes = []
    var state = thinkState || {}
    var limited = state.scope === 'workspaces'
    var picked = Array.isArray(state.workspaces) ? state.workspaces.slice() : []

    var chips = h('div', 'dsh-fb-modes')
    ;[
      { id: 'all', label: '全部工作区', hint: '任何会话都按上面的模式思考' },
      { id: 'workspaces', label: '只选中的工作区', hint: '只有列出来的工作区里的会话才切换思考语言' },
    ].forEach(function (option) {
      var b = h('button', 'dsh-fb-mode', option.label)
      b.type = 'button'
      b.title = option.hint
      b.dataset.active = (limited ? 'workspaces' : 'all') === option.id ? '1' : '0'
      b.addEventListener('click', function (e) {
        e.stopPropagation()
        saveThink({ scope: option.id }, '已切换作用范围 · 下一轮生效')
      })
      chips.appendChild(b)
    })
    nodes.push(chips)

    if (!limited) return nodes

    // 允许列表可能包含已不存在的工作区（目录被删/改名），这里仍然列出来并标记，
    // 而不是悄悄丢掉——静默丢条目会让"我明明选过却没了"很难排查。
    var known = {}
    for (var i = 0; i < workspaces.length; i++) known[workspaces[i].path] = workspaces[i]

    var list = h('div', 'dsh-fb-wslist')
    if (!workspaces.length) {
      list.appendChild(h('div', 'dsh-fb-empty', '读不到工作区清单（~/.dsh/storages/workspace.json 不存在或格式变了）。'))
    }
    for (var j = 0; j < workspaces.length; j++) {
      list.appendChild(workspaceRow(workspaces[j].title, workspaces[j].path, picked, workspaces[j].sessions))
    }
    for (var k = 0; k < picked.length; k++) {
      if (known[picked[k]]) continue
      list.appendChild(workspaceRow('（已不存在）' + picked[k], picked[k], picked, null, true))
    }
    nodes.push(list)

    if (picked.length === 0) {
      nodes.push(h('div', 'dsh-fb-warn', '还没有选任何工作区 —— 现在等于全部不生效。至少勾一个才会起作用。'))
    }
    return nodes
  }

  // 一行可勾选的工作区。用 checkbox 而不是胶囊：工作区可能有十几个。
  function workspaceRow(title, path, picked, count, missing) {
    var row = h('label', 'dsh-fb-wsrow')
    var box = h('input')
    box.type = 'checkbox'
    box.checked = picked.indexOf(path) !== -1
    row.appendChild(box)

    var text = h('span', 'dsh-fb-wstext')
    text.appendChild(h('b', null, title))
    var sub = path + (count === null || count === undefined ? '' : ' · ' + count + ' 个会话')
    text.appendChild(h('small', null, sub))
    if (missing) text.appendChild(h('small', 'dsh-fb-warn', '这个目录已不在工作区列表里；勾掉它就能清掉。'))
    row.appendChild(text)

    box.addEventListener('click', function (e) {
      e.stopPropagation()
      var next = picked.slice()
      var at = next.indexOf(path)
      if (at === -1) next.push(path)
      else next.splice(at, 1)
      saveThink({ workspaces: next }, null)
    })
    // label 的默认行为会给 checkbox 再补一次点击，这里拦住重复触发。
    row.addEventListener('click', function (e) { e.stopPropagation() })
    return row
  }

  // 统一的「写状态 + 失败回退」。scope/workspaces 这类改动没有乐观更新可言
  // （要等宿主确认），所以成功后直接重载「状态」页，让 hint 和列表都刷新。
  function saveThink(patch, okText) {
    postJson(THINK_STATE_API, patch).then(function (res) {
      if (res && res.ok && res.state) {
        mState.thinking = res.state
        if (mState.data) {
          mState.data.thinking = res.state
          if (Array.isArray(mState.workspaces)) mState.data.workspaces = mState.workspaces
        }
        if (okText) toast(okText)
        renderTab()
        return
      }
      toast('保存失败：' + ((res && res.error) || '插件没有响应'))
      renderTab()
    })
  }

  // 模式胶囊：跟浮游球小面板里那套 .dsh-fb-modes 样式一致。
  // 只在开启时出现——关着的时候选模式没有意义，还会让人以为已经生效。
  // 只改 data-active，不重建按钮：重建会让指针下的元素消失，点击手感会顿一下。
  function paintActive(wrap, modeId) {
    for (var i = 0; i < wrap.children.length; i++) {
      var child = wrap.children[i]
      child.dataset.active = child.dataset.mode === modeId ? '1' : '0'
    }
  }

  function modeChips(thinkState) {
    var wrap = h('div', 'dsh-fb-modes')
    if (!thinkState || thinkState.enabled !== true) return wrap
    for (var i = 0; i < THINK_MODE_LIST.length; i++) {
      (function (mode) {
        var b = h('button', 'dsh-fb-mode', mode.label)
        b.type = 'button'
        b.title = mode.hint
        b.dataset.mode = mode.id
        b.dataset.active = thinkState.mode === mode.id ? '1' : '0'
        b.addEventListener('click', function (e) {
          e.stopPropagation()
          // 先记下旧的选中项：请求失败要能原样拨回去。
          var prev = thinkState.mode
          thinkState.mode = mode.id
          paintActive(wrap, mode.id)
          postJson(THINK_STATE_API, { mode: mode.id }).then(function (res) {
            if (res && res.ok && res.state) {
              mState.thinking = res.state
              if (mState.data) mState.data.thinking = res.state
              // 就地更新，不重开页签：loadTab 会重建整个「状态」页并跳回顶部，
              // 而这个操作本身只改一个字段，用户还停在原位看着它。
              thinkState.mode = res.state.mode
              paintActive(wrap, res.state.mode)
              toast('已切换为「' + mode.label + '」· 下一轮生效')
              return
            }
            thinkState.mode = prev
            paintActive(wrap, prev)
            toast('切换失败：' + ((res && res.error) || '插件没有响应'))
          })
        })
        wrap.appendChild(b)
      })(THINK_MODE_LIST[i])
    }
    return wrap
  }

  function openSettings(feature) {
    closeSettings()
    closePanel()
    mState.feature = feature
    mState.tab = 'status'
    mState.data = {}
    mState.note = ''
    mState.restoreScroll = 0
    mState.thinking = null

    var wrap = h('div', 'dsh-fb-modal')
    wrap.setAttribute('role', 'dialog')
    wrap.setAttribute('aria-modal', 'true')
    wrap.setAttribute('aria-label', feature.title + ' 设置')
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeSettings() })

    var dlg = h('div', 'dsh-fb-dialog')
    var head = h('div', 'dsh-fb-dlg-head')
    var title = h('div', 'dsh-fb-dlg-title')
    var ico = h('span', 'dsh-fb-dlg-ico')
    ico.innerHTML = feature.icon
    title.appendChild(ico)
    title.appendChild(h('b', null, feature.title))
    title.appendChild(h('span', 'dsh-fb-dlg-sub', '设置'))
    var x = h('button', 'dsh-fb-x', '✕')
    x.type = 'button'
    x.setAttribute('aria-label', '关闭')
    x.addEventListener('click', closeSettings)
    head.appendChild(title)
    head.appendChild(x)

    var tabs = h('div', 'dsh-fb-tabs')
    var body = h('div', 'dsh-fb-dlg-body')
    dlg.appendChild(head)
    dlg.appendChild(tabs)
    dlg.appendChild(body)
    wrap.appendChild(dlg)
    document.body.appendChild(wrap)
    modal = { wrap: wrap, tabs: tabs, body: body }

    document.addEventListener('keydown', onModalKey, true)
    renderTabs()
    loadTab('status')
  }

  function closeSettings() {
    if (!modal) return
    document.removeEventListener('keydown', onModalKey, true)
    if (modal.wrap.parentNode) modal.wrap.parentNode.removeChild(modal.wrap)
    modal = null
  }

  function onModalKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeSettings()
    }
  }

  function renderTabs() {
    if (!modal) return
    modal.tabs.textContent = ''
    for (var i = 0; i < TABS.length; i++) {
      (function (tab) {
        var b = h('button', 'dsh-fb-tab', tab.label)
        b.type = 'button'
        b.dataset.active = mState.tab === tab.id ? '1' : '0'
        b.addEventListener('click', function () { loadTab(tab.id) })
        modal.tabs.appendChild(b)
      })(TABS[i])
    }
  }

  // 渲染页签内容。
  //
  // 滚动位置的处理分两种情况：
  //   · 「加载中…」占位（loadTab 调用）：不碰滚动，但把当时的偏移记在
  //     mState.restoreScroll 上，等真实内容渲染完再恢复 —— 因为占位内容很矮，
  //     这时候算 maxTop 必然是 0，直接写回会把位置吃掉。
  //   · 真实内容（renderTab 调用）：渲染完按记下的偏移恢复，并按新的
  //     scrollHeight 夹紧，列表变短时不会停在超出内容的位置。
  function setBody(nodes, opts) {
    if (!modal) return
    // opts.placeholder：这是「加载中…」占位，不要在这里恢复滚动
    // （占位内容很矮，maxTop 必然是 0，会把手里的偏移吃掉）。
    var isPlaceholder = !!(opts && opts.placeholder)
    if (!isPlaceholder && mState.restoreScroll) {
      var target = mState.restoreScroll
      mState.restoreScroll = 0
      modal.body.textContent = ''
      for (var i = 0; i < nodes.length; i++) modal.body.appendChild(nodes[i])
      var maxTop = Math.max(0, modal.body.scrollHeight - modal.body.clientHeight)
      modal.body.scrollTop = Math.min(target, maxTop)
      return
    }
    modal.body.textContent = ''
    for (var j = 0; j < nodes.length; j++) modal.body.appendChild(nodes[j])
  }

  function loadTab(tabId) {
    // 刷新**同一个**页签时保留滚动位置（增删改之后走的就是这条路）；
    // 切换到别的页签则从顶部开始，那是新内容，不该继承上一个页签的位置。
    var keepScroll = (mState.tab === tabId) ? (modal && modal.body ? modal.body.scrollTop || 0 : 0) : 0
    mState.tab = tabId
    mState.note = ''
    renderTabs()
    mState.restoreScroll = keepScroll
    setBody([h('div', 'dsh-fb-empty', '加载中…')], { placeholder: true })
    var f = mState.feature
    var url = f.api
    if (tabId === 'rhythm') url = f.api + '/settings'
    else if (tabId === 'facts') url = f.api + '/facts'
    else if (tabId === 'impressions') url = f.api + '/impressions'
    else if (tabId === 'todos') url = f.api + '/todos'
    else if (tabId === 'proactive') url = f.api + '/proactive'
    else if (tabId === 'self') url = f.api + '/self-notes'
    else if (tabId === 'persona') url = f.api + '/persona'
    else if (tabId === 'tokens') url = f.api + '/tokens'
    else if (tabId === 'stickers') url = f.api + '/stickers'
    else if (tabId === 'access') url = f.api + '/access'
    else if (tabId === 'backend') url = f.api + '/backend'
    else if (tabId === 'diagnose') url = f.api + '/diagnose'
    // 2026-11-24：「状态」页走桥接的 /api/life（生活状态全貌）。
    else if (tabId === 'life') url = f.api + '/life'
    // 「思考链」页只读插件自己的状态（不经过桥接）。
    // 「状态」页不再显示思考链开关了 —— 它跟 QQ 机器人无关，单独成栏。
    // 但「状态」页仍然并发取一份 think 状态：桥接没跑时 renderTab 会走
    // 「读不到数据」分支，那条路径还要靠 mState.thinking 把开关显示出来。
    var pending
    if (tabId === 'thinking') {
      pending = Promise.all([
        fetchJson(THINK_STATE_API),
        fetchJson(THINK_WORKSPACES_API),
      ]).then(function (results) {
        var thinkRes = results[0]
        var wsRes = results[1]
        mState.thinking = (thinkRes && thinkRes.state) ? thinkRes.state : null
        mState.workspaces = (wsRes && Array.isArray(wsRes.workspaces)) ? wsRes.workspaces : []
        return { ok: true, thinking: mState.thinking, workspaces: mState.workspaces }
      })
    } else {
      pending = fetchJson(url)
      if (tabId === 'status') {
        pending = Promise.all([
          fetchJson(url),
          fetchJson(THINK_STATE_API),
          fetchJson(THINK_WORKSPACES_API),
        ]).then(function (results) {
          var base = results[0]
          var thinkRes = results[1]
          var wsRes = results[2]
          mState.thinking = (thinkRes && thinkRes.state) ? thinkRes.state : null
          mState.workspaces = (wsRes && Array.isArray(wsRes.workspaces)) ? wsRes.workspaces : []
          if (!base) return base
          base.thinking = mState.thinking
          base.workspaces = mState.workspaces
          return base
        })
      }
    }

    pending.then(function (data) {
      if (!modal) return
      // 竞态守卫：慢页签（「后端」要 spawn PowerShell，可能 1~3 秒）的响应
      // 常常在用户已经切走之后才回来；若无条件写入 mState.data，
      // 就会拿旧页签的数据去渲染新页签（表现为"诊断"页签只剩标题）。
      if (mState.tab !== tabId) return
      mState.data = data || {}
      renderTab()
    })
  }

  function renderTab() {
    if (!modal) return
    var d = mState.data
    // ── 诊断页的 `ok` 是「自检全部通过」，不是「请求成功」 ────────────────────
    //
    // ⚠️ 这里踩过一次真实的坑：诊断接口在**任何一项检查不通过**时也会返回
    //    `ok:false`（那是它的正常语义 —— 「有项目没通过」），而下面这个大分支
    //    本意是处理「请求失败 / 桥接没响应」。
    //
    //    两者一混，后果是：只要有一项自检红（比如 preset 没装），诊断页就整个
    //    被这张「读不到数据」的兜底卡接管，真正拿到的 6 项检查结果被直接丢掉。
    //    用户看到的是「诊断还是有问题」—— 明明数据是全的，只是被拦在渲染这一层。
    //
    //    判据改成「有没有 checks 数组」：有就是一份可渲染的诊断结论，交给
    //    renderDiagnoseTab 去决定怎么显示红项。
    var diagWithChecks = mState.tab === 'diagnose' && d && Array.isArray(d.checks)
    if ((!d || d.ok === false) && !diagWithChecks) {
      var errNodes = [
        h('div', 'dsh-fb-empty', '读不到数据'),
        h('div', 'dsh-fb-warn', (d && d.error) || '未知错误（桥接可能没有运行）'),
        actionsRow([{ label: '重试（会自动启动桥接）', onClick: function () { loadTab(mState.tab) } }]),
      ]
      // 把 host 侧「有没有尝试拉起桥接」的结果如实显示出来。
      // 以前这里只有一句「读不到数据」，使用者不知道下一步该干什么；
      // 现在明确告诉他：点重试会执行 start.bat，以及为什么没成功。
      var as = d && d.autostart
      if (as) {
        if (as.started) {
          errNodes.push(h('div', 'dsh-fb-warn',
            `已执行 start.bat 尝试拉起桥接（耗时 ${Math.round((as.elapsedMs || 0) / 1000)} 秒），但控制台仍然连不上。`
            + '看 qq-bridge/state/bridge.log 的前几行。'))
        } else if (as.already) {
          errNodes.push(h('div', 'dsh-fb-warn', '桥接进程在跑，但控制台端口连不上——可能启动卡住或端口被占用。'))
        } else {
          errNodes.push(h('div', 'dsh-fb-warn', `没能自动启动：${as.error || '未知原因'}`))
        }
      } else {
        errNodes.push(h('div', 'dsh-fb-warn',
          '点上面的「重试」会检查 qq-bridge/start.bat 是否在运行，没在运行就自动启动它并等端口就绪。'))
      }
      // 思考链中文不归桥接管：桥接挂了它也照样能切，所以独立成栏后不再挂在
      // 「状态」页的错误分支里 —— 用户直接切到「思考链」页即可。
      setBody(errNodes)
      return
    }
    if (mState.tab === 'thinking') return renderThinkingTab(d)
    if (mState.tab === 'status') return renderStatusTab(d)
    if (mState.tab === 'facts') return renderFactsTab(d)
    if (mState.tab === 'impressions') return renderImpressionsTab(d)
    if (mState.tab === 'todos') return renderTodosTab(d)
    if (mState.tab === 'proactive') return renderProactiveTab(d)
    if (mState.tab === 'self') return renderSelfTab(d)
    if (mState.tab === 'rhythm') return renderRhythmTab(d)
    if (mState.tab === 'persona') return renderPersonaTab(d)
    if (mState.tab === 'tokens') return renderTokensTab(d)
    if (mState.tab === 'stickers') return renderStickersTab(d)
    if (mState.tab === 'access') return renderAccessTab(d)
    if (mState.tab === 'backend') return renderBackendTab(d)
    if (mState.tab === 'diagnose') return renderDiagnoseTab(d)
    if (mState.tab === 'life') return renderLifeTab(d)
  }

  function renderStatusTab(d) {
    var online = d.online === true
    var sl = d.snowluma || {}
    var nodes = []

    var btn = h('button', 'dsh-fb-btn' + (online ? ' ghost' : ''), online ? '下线（暂停机器人）' : '上线（恢复机器人）')
    btn.type = 'button'
    btn.addEventListener('click', function () {
      btn.disabled = true
      btn.textContent = '处理中…'
      postJson(mState.feature.toggle.path, { online: !online }).then(function (r) {
        toast(r && r.ok ? (online ? '机器人已下线' : '机器人已上线') : '操作失败')
        loadTab('status')
        syncFeature(mState.feature)
      })
    })
    // 语音开关：和上线/下线放同一行。它是"允不允许她发语音"的许可 ——
    // 打开后她照常打字，桥接把文字合成为睦的声音再发；她自己不知道，人设不受影响。
    var tts = d.tts || {}
    var ttsOn = tts.enabled === true
    var ttsReady = tts.ready === true
    var ttsBtn = h('button', 'dsh-fb-btn' + (ttsOn ? '' : ' ghost'),
      ttsOn ? '语音：开' : '语音：关')
    ttsBtn.type = 'button'
    ttsBtn.title = ttsOn
      ? (ttsReady ? '她的话会合成为睦的声音发出' : '已开启，但 TTS 服务未就绪，会先退回文字')
      : '打开后：她照常打字，桥接把文字转成睦的声音再发（会自动拉起 TTS 推理窗口）'
    ttsBtn.addEventListener('click', function () {
      var wasOn = ttsOn
      ttsBtn.disabled = true
      // 打开时可能要等模型加载（可达数十秒），必须给用户明确的进行中提示。
      ttsBtn.textContent = wasOn ? '关闭中…' : '启动中…（首次要等模型加载）'
      postJson(mState.feature.api + '/tts', { enabled: !wasOn }).then(function (r) {
        if (!r || !r.ok) {
          toast((r && r.error) || '切换失败')
        } else if (!r.enabled) {
          toast('语音已关闭（她只能打字）')
        } else if (r.ready) {
          toast(r.started ? '语音已开启（TTS 服务已自动拉起）' : '语音已开启')
        } else {
          toast('已开启，但 TTS 服务没起来：' + (r.detail || '未知原因') + '（暂用文字发送）')
        }
        loadTab('status')
        syncFeature(mState.feature)
      })
    })
    // 重启桥接：放在语音开关旁边，因为它和"改了配置要生效"是同一类操作。
    // ⚠️ 文案必须诚实：桥接的 /api/restart 只是 process.exit，靠 start.bat 守护循环拉回来。
    //    手动 node 起的桥接退出后不会自动回来，所以按钮要说清"约 5 秒后回来"。
    // ⚠️ 二次确认不能用 window.confirm —— Electron 下不可靠（同本文件 2304 行的说明），
    //    改用"点两下确认"：第一下变红，5 秒内再点才真重启。
    var restartBtn = h('button', 'dsh-fb-btn ghost', '重启桥接')
    restartBtn.type = 'button'
    restartBtn.title = '重启后：改了代码/配置才会生效。约 5 秒自动恢复（需由 start.bat 守护启动）'
    var restartArmed = false
    var restartDisarmTimer = null
    var restartDisarm = function () {
      restartArmed = false
      if (restartDisarmTimer) { clearTimeout(restartDisarmTimer); restartDisarmTimer = null }
      restartBtn.textContent = '重启桥接'
      restartBtn.className = 'dsh-fb-btn ghost'
    }
    restartBtn.addEventListener('click', function () {
      if (!restartArmed) {
        // 第一下：只是置为待确认，不重启。
        restartArmed = true
        restartBtn.textContent = '确认重启？'
        restartBtn.className = 'dsh-fb-btn'
        restartDisarmTimer = setTimeout(restartDisarm, 5000)
        return
      }
      restartDisarm()
      restartBtn.disabled = true
      restartBtn.textContent = '重启中…'
      postJson(mState.feature.api + '/restart-bridge', {}).then(function (r) {
        if (!r || !r.ok) {
          toast((r && r.error) || '重启失败')
          restartBtn.disabled = false
          restartBtn.textContent = '重启桥接'
          return
        }
        toast('桥接正在重启…约 5 秒后自动恢复')
        // 桥接退出后宿主会短暂连不上：轮询几次，等它回来再刷新面板。
        var tries = 0
        var timer = setInterval(function () {
          tries += 1
          loadTab('status')
          syncFeature(mState.feature)
          if (tries >= 8) {
            clearInterval(timer)
            restartBtn.disabled = false
            restartBtn.textContent = '重启桥接'
            toast('如果面板还没恢复，稍点一下「刷新」')
          }
        }, 1500)
      }).catch(function () {
        restartBtn.disabled = false
        restartBtn.textContent = '重启桥接'
        toast('重启请求失败（桥接可能已经退出，等几秒再刷新）')
      })
    })
    nodes.push(section('开关', [btn, ttsBtn, restartBtn]))

    // 语音服务状态：不显眼但必须可见 —— 否则"开关是开的、其实一直在发文字"没人知道。
    if (ttsOn) {
      nodes.push(h('div', 'dsh-fb-check' + (ttsReady ? '-ok' : '-warn'),
        ttsReady ? '✓ TTS 推理服务就绪' : '⚠ TTS 推理服务未就绪（当前退回文字）'))
    }

    // 思考链中文已独立成单独的「思考链」页签：它管的是模型怎么推理，
    // 与 QQ 机器人（怎么收发消息）无关，混在状态页会让人误以为是机器人配置。

    // SnowLuma 区块**常驻显示**（不只是未运行时）。
    // 早先写成「仅在 sl.connected !== true 时显示」，结果用户点开找不到启动选项 ——
    // 那时它恰好在运行；更糟的是桥接若没跑，整页都读不到数据，连区块都渲染不出来。
    // 现在标题与按钮随状态变化，入口永远在。
    var slRunning = sl.connected === true
    var slRow = h('div', 'dsh-fb-actions')
    if (!slRunning) {
      var launchBtn = h('button', 'dsh-fb-btn', '启动 SnowLuma')
      launchBtn.type = 'button'
      launchBtn.addEventListener('click', function () {
        launchBtn.disabled = true
        launchBtn.textContent = '启动中…（等到桥接连上，最多 90 秒）'
        postJson(mState.feature.api + '/launch-snowluma', {}).then(function (res) {
          toast(res && res.ok ? (res.message || '已启动') : ((res && res.error) || '启动失败'))
          loadTab('status')
        })
      })
      slRow.appendChild(launchBtn)
    } else {
      slRow.appendChild(h('span', 'dsh-fb-check-ok', '✓ 运行中'))
    }
    var webuiBtn = h('button', 'dsh-fb-btn ghost', '打开 WebUI')
    webuiBtn.type = 'button'
    webuiBtn.addEventListener('click', function () {
      fetchJson(mState.feature.api + '/open-snowluma?target=webui').then(function (res) {
        toast(res && res.ok ? '已打开 WebUI' : ((res && res.error) || '打开失败'))
      })
    })
    var dirBtn = h('button', 'dsh-fb-btn ghost', '打开目录')
    dirBtn.type = 'button'
    dirBtn.addEventListener('click', function () {
      fetchJson(mState.feature.api + '/open-snowluma?target=dir').then(function (res) {
        toast(res && res.ok ? '已打开目录' : ((res && res.error) || '打开失败'))
      })
    })
    slRow.appendChild(webuiBtn)
    slRow.appendChild(dirBtn)
    nodes.push(section(slRunning ? 'SnowLuma（运行中）' : 'SnowLuma（未运行）', [
      slRow,
      h('div', 'dsh-fb-warn', slRunning
        ? '进程在跑，但是否能收 QQ 消息要看账号是否在线 —— 见上面的自检。'
        : '启动的是你本机已安装的 SnowLuma（路径取自 config.json 的 snowluma.launcherPath），本工具不包含也不分发它。若启动后仍收不到 QQ 消息，通常是要去 WebUI 扫码登录。'),
    ]))

    nodes.push(section('自检', [
      // 不再显示「（模式 reserved2）」：四个预设合并后只剩一种运行形态，
      // 模式名对使用者已经没有区分意义，挂在自检里只是噪音。
      statusLine('DSH 已就绪', d.dshReady === true),
      statusLine('SnowLuma 已连接' + (sl.accountOnline ? '（账号在线）' : ''), sl.connected === true),
      statusLine('SnowLuma 上游健康' + (sl.goodSource ? '（来源 ' + sl.goodSource + '）' : ''), sl.good === true),
      statusLine('机器人上线中', online),
    ]))

    nodes.push(section('连接信息', [
      kv('桥接目录', d.bridge && d.bridge.dir),
      kv('控制台', d.bridge && d.bridge.consoleUrl),
      kv('DSH 地址', d.bridge && d.bridge.baseUrl),
      kv('管理员 QQ', d.ownerQQ),
      kv('私聊白名单', (d.allowPrivate || []).join('、')),
      kv('群白名单', (d.allowGroups || []).length ? d.allowGroups.join('、') : '（未接入任何群）'),
      kv('当前角色', d.role || '（未启用角色扮演）'),
      kv('角色模式', d.roleMode),
    ]))

    if (sl.hint) nodes.push(h('div', 'dsh-fb-warn', 'SnowLuma 提示：' + sl.hint))
    setBody(nodes)
  }

  function getPath(obj, pathStr) {
    var parts = pathStr.split('.')
    var cur = obj
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
      cur = cur[parts[i]]
    }
    return cur
  }

  // 长期记忆（L2）：后端按权重降序返回，这里原样从上往下排。
  // 删除走 archiveFact（写一条 archived:true 的修订，不物理删），
  // 所以删掉的记录仍可在 jsonl 里追溯，只是不再注入。
  var FACT_TAG = {
    identity: { label: '身份', color: '#6ea8fe' },
    agreement: { label: '约定', color: '#9b8cf2' },
    emotion: { label: '情绪', color: '#e0709b' },
    preference: { label: '偏好', color: '#4fd486' },
    meme: { label: '梗', color: '#e0a33a' },
    misc: { label: '其他', color: '#8d8d94' },
  }

  // 编辑态：同一时刻只允许一条处于编辑中（editing 只存一个标识）。
  // kind: 'fact' | 'impression'；id: fact 的 id 或 impression 的 "key\0name"
  var editing = null;
  var editDraft = { text: '', tag: '', name: '', traits: [] };

  function beginEdit(kind, id, draft) {
    editing = { kind: kind, id: id };
    editDraft = draft;
    renderTab();
  }

  function cancelEdit() {
    editing = null;
    editDraft = { text: '', tag: '', name: '', traits: [] };
    renderTab();
  }

  // 两段式删除按钮（删除 → 确认删除），长期记忆和群友印象共用
  function deleteButton(title, onConfirm) {
    var btn = h('button', 'dsh-fb-fact-del', '删除');
    btn.type = 'button';
    btn.title = title || '删除';
    var armed = false;
    var timer = null;
    var disarm = function () {
      armed = false;
      if (timer) { clearTimeout(timer); timer = null }
      btn.textContent = '删除';
      btn.className = 'dsh-fb-fact-del';
    };
    btn.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        btn.textContent = '确认删除';
        btn.className = 'dsh-fb-fact-del armed';
        timer = setTimeout(disarm, 5000);
        return;
      }
      disarm();
      onConfirm();
    });
    btn.addEventListener('blur', function () { if (armed) disarm() });
    return btn;
  }

  function editButton(onClick) {
    var b = h('button', 'dsh-fb-fact-edit', '编辑');
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function saveButton(onClick) {
    var b = h('button', 'dsh-fb-fact-save', '保存');
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function cancelButton() {
    var b = h('button', 'dsh-fb-fact-cancel', '取消');
    b.type = 'button';
    b.addEventListener('click', cancelEdit);
    return b;
  }

  // 权重分档：上色只为了一眼看出谁快掉出去了，不做精确刻度
  function factWeightClass(w) {
    if (w >= 2.8) return 'hi'
    if (w >= 1.5) return 'mid'
    return 'lo'
  }

  // 群友印象：每人一张卡，名字当标题、traits 逐条列出。
  // 和「长期记忆」的区别：那是关于事/关系的结论，这是关于「谁是什么样的人」。
  // ── 自我（selfNote）──────────────────────────────────────────────
  //
  // selfNote 是她写的「我对这段关系的认识」，按时间顺序排列。
  // 和「长期记忆」不同：那是关于世界的事实，这是她对自己的判断。
  // 所以排版上做成时间轴，让「她怎么一步步变成现在这样」一眼可见。
  function renderSelfTab(d) {
    var list = Array.isArray(d.notes) ? d.notes : []

    if (!list.length) {
      setBody([
        section('自我', [
          (function () {
            var box = h('div', 'dsh-fb-facts-empty')
            box.appendChild(h('div', 't', '还没有自我认知'))
            box.appendChild(h('div', 's', '她会在聊天里自己写：对这人的看法、关系的变化、她改过的主意。'))
            return box
          })(),
        ]),
        actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('self') } }]),
      ])
      return
    }

    // 按会话分组：群聊和私聊是完全不同的关系，混在一条时间轴上会读错。
    // 分组顺序按「该会话最新一条」的时间倒序（最近活跃的排前面）；
    // 组内按时间正序，保留「她怎么一步步变成现在这样」的演变感。
    var groups = []
    var groupIndex = {}
    for (var gi = 0; gi < list.length; gi++) {
      var n = list[gi]
      var k = String(n.key || '')
      if (!groupIndex.hasOwnProperty(k)) {
        groupIndex[k] = groups.length
        groups.push({ key: k, notes: [] })
      }
      groups[groupIndex[k]].notes.push(n)
    }
    // 组内正序 + 算组的最新时间
    for (var g2 = 0; g2 < groups.length; g2++) {
      groups[g2].notes.sort(function (x, y) { return (x.createdAt || 0) - (y.createdAt || 0) })
      var last = groups[g2].notes[groups[g2].notes.length - 1]
      groups[g2].latest = (last && last.createdAt) || 0
    }
    groups.sort(function (x, y) { return y.latest - x.latest })

    var sections = []
    for (var g3 = 0; g3 < groups.length; g3++) {
      (function (group) {
        var isGroup = /^group:/.test(group.key)
        var label = isGroup ? '群聊' : (/^private:/.test(group.key) ? '私聊' : '未归属')
        var wrap = h('div', 'dsh-fb-self')

        for (var i = 0; i < group.notes.length; i++) {
          (function (note, idx) {
            var myId = note.key + '\u0000' + note.createdAt + '\u0000' + idx
            var isEditing = editing && editing.kind === 'self' && editing.id === myId
            var row = h('div', 'dsh-fb-selfnote' + (isEditing ? ' editing' : ''))

            var spine = h('div', 'dsh-fb-selfspine')
            spine.appendChild(h('div', 'dsh-fb-selfdot'))
            row.appendChild(spine)

            var main = h('div', 'dsh-fb-selfmain')

            var metaRow = h('div', 'dsh-fb-selfmeta')
            var ts = Number(note.createdAt) || 0
            if (ts) {
              var d2 = new Date(ts)
              var pad = function (x) { return x < 10 ? '0' + x : String(x) }
              metaRow.appendChild(h('span', 'dsh-fb-selftime',
                (d2.getMonth() + 1) + '月' + d2.getDate() + '日 ' + pad(d2.getHours()) + ':' + pad(d2.getMinutes())))
            }
            if (note.lastTouchedAt && note.lastTouchedAt > note.createdAt + 1000) {
              metaRow.appendChild(h('span', 'dsh-fb-selfedited', '改过'))
            }
            main.appendChild(metaRow)

            if (isEditing) {
              var ta = h('textarea', 'dsh-fb-edit-text')
              ta.value = editDraft.text
              ta.rows = 5
              ta.addEventListener('input', function () { editDraft.text = ta.value })
              main.appendChild(ta)
            } else {
              main.appendChild(h('div', 'dsh-fb-selftext', note.text))
            }
            row.appendChild(main)

            var ops = h('div', 'dsh-fb-fact-ops')
            if (isEditing) {
              ops.appendChild(cancelButton())
              ops.appendChild(saveButton(function () {
                updateSelfNote(note.key, note.text, editDraft.text)
              }))
            } else {
              ops.appendChild(editButton(function () {
                beginEdit('self', myId, { text: note.text, tag: '', name: '', traits: [] })
              }))
              ops.appendChild(deleteButton('删掉这条自我认知', function () {
                removeSelfNote(note.key, note.text)
              }))
            }
            row.appendChild(ops)
            wrap.appendChild(row)
          })(group.notes[i], i)
        }

        // 会话标题：左边一个圆点胶囊，标明是群还是私聊
        var head = h('div', 'dsh-fb-selfhead')
        var pill = h('span', 'dsh-fb-selfpill' + (isGroup ? ' group' : ' private'),
          isGroup ? '群聊' : (/^private:/.test(group.key) ? '私聊' : '未归属'))
        head.appendChild(pill)
        head.appendChild(h('span', 'dsh-fb-selfkey', group.key || ''))
        head.appendChild(h('span', 'dsh-fb-selfcount', group.notes.length + ' 条'))
        // h() 的第三个参数是 textContent，不能传数组（会变成 [object HTMLDivElement]）。
        // 先建容器再逐个 append。
        var groupBox = h('div', 'dsh-fb-selfgroup')
        groupBox.appendChild(head)
        groupBox.appendChild(wrap)
        sections.push(groupBox)
      })(groups[g3])
    }

    var nodes = [section('自我（' + groups.length + ' 个会话 · 共 ' + list.length + ' 条）', sections)]
    nodes.push(actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('self') } }]))
    nodes.push(h('div', 'dsh-fb-warn',
      '这是她自己写的「我怎么看这段关系」，不是设定、不是规则。删了就会少一层记忆。'
      + '群聊和私聊分开列，因为那是两段不同的关系。'))
    if (mState.note) nodes.push(h('div', 'dsh-fb-warn', mState.note))
    setBody(nodes)
  }

  /**
   * 待办页（2026-11-12 新增）。
   *
   * 和她其余记忆的区别：todo 是**会过期的**——一两天内要兑现的事，
   * 到期自动消失。所以这里按「还剩多久」排序，把快过期的排前面，
   * 让她和操作者都能一眼看到"马上要到点的那几件"。
   */
  function renderTodosTab(d) {
    var list = Array.isArray(d.todos) ? d.todos : []

    if (!list.length) {
      setBody([
        section('待办', [
          (function () {
            var box = h('div', 'dsh-fb-facts-empty')
            box.appendChild(h('div', 't', '没有待办'))
            box.appendChild(h('div', 's',
              '一两天内要兑现的事（"明天讲那张卡片""六点提醒他拿快递"）会出现在这里；'
              + '到期自动消失，不用手动清。'))
            return box
          })(),
        ]),
        actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('todos') } }]),
      ])
      return
    }

    var wrap = h('div', 'dsh-fb-self')
    for (var i = 0; i < list.length; i++) {
      (function (item) {
        var row = h('div', 'dsh-fb-selfnote')

        var spine = h('div', 'dsh-fb-selfspine')
        spine.appendChild(h('div', 'dsh-fb-selfdot'))
        row.appendChild(spine)

        var main = h('div', 'dsh-fb-selfmain')
        var metaRow = h('div', 'dsh-fb-selfmeta')

        // 剩余时间：正数显示"还剩"，负数/0 显示"已过期"（端点已经过滤掉过期的，
        // 这里只是防御：时钟漂移或刚好处在边界上）。
        var leftMs = Number(item.expiresAt) ? Number(item.expiresAt) - Date.now() : 0
        var leftText = ''
        if (leftMs > 0) {
          leftText = leftMs >= 86400000
            ? '还剩 ' + Math.round(leftMs / 86400000) + ' 天'
            : (leftMs >= 3600000 ? '还剩 ' + Math.round(leftMs / 3600000) + ' 小时'
              : '还剩 ' + Math.max(1, Math.round(leftMs / 60000)) + ' 分钟')
        } else {
          leftText = '已到期'
        }
        metaRow.appendChild(h('span', 'dsh-fb-selftime', (item.done ? '✅ ' : '') + leftText))
        main.appendChild(metaRow)

        var text = h('div', 'dsh-fb-selftext', String(item.text || ''))
        main.appendChild(text)

        var ops = h('div', 'dsh-fb-fact-ops')
        ops.appendChild(deleteButton('删掉这条待办', function () {
          deleteTodo(item.key, item.text)
        }))
        main.appendChild(ops)

        row.appendChild(main)
        wrap.appendChild(row)
      })(list[i])
    }

    var nodes = [section('待办（' + list.length + ' 条，快到期的在前）', [wrap])]
    nodes.push(actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('todos') } }]))
    nodes.push(h('div', 'dsh-fb-warn',
      '这些是**一两天内要兑现**的事，到期自动消失——所以这里看不到往期条目是正常的。'
      + '需要长期保留的内容应该记在「长期记忆」里。'))
    if (mState.note) nodes.push(h('div', 'dsh-fb-warn', mState.note))
    setBody(nodes)
  }

  // ── 主动机会（2026-11-18）──────────────────────────────────────────────
  //
  // 她"主动开口"要同时满足两件事：
  //   ① 全局开关开着（socialV2.proactive.enabled，在「回复节奏」里调参数）
  //   ② **这个聊天**没被关掉（st.proactiveDisabled，这一页管的）
  //
  // 桥接侧的调度逻辑（scheduleProactiveCheckV2）还会额外判断：
  // 群安静够久、概率命中、不在夜间、最近没说过太多话。
  // 这一页只负责"许不许"，不负责"会不会"——所以页头要写清楚。

  var PROACTIVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
    + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'
    + '<circle cx="12" cy="12" r="4.2"/><path d="M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>'

  // 「多久以前」：只到分钟/小时/天，不显示秒——这一页看的是粗粒度。
  function proactiveAgo(ms) {
    var n = Number(ms)
    if (!isFinite(n) || n <= 0) return '从没说过话'
    if (n < 60000) return '刚刚'
    if (n < 3600000) return Math.round(n / 60000) + ' 分钟前'
    if (n < 86400000) return Math.round(n / 3600000) + ' 小时前'
    return Math.round(n / 86400000) + ' 天前'
  }

  // 「还有多久」用于下一次检查倒计时。未排程返回空串。
  function proactiveLeft(ms) {
    var n = Number(ms)
    if (!isFinite(n) || n < 0) return ''
    if (n < 60000) return '不到 1 分钟'
    if (n < 3600000) return Math.round(n / 60000) + ' 分钟'
    return Math.round(n / 3600000) + ' 小时'
  }

  // 时长（毫秒）→ 「1.5 小时」。用于显示实际间隔。
  function proactiveDur(ms) {
    var n = Number(ms)
    if (!isFinite(n) || n <= 0) return '—'
    var hh = n / 3600000
    if (hh < 1) return Math.round(n / 60000) + ' 分钟'
    return (Math.round(hh * 10) / 10) + ' 小时'
  }

  // 一天的时段顺序（和后端 daypartOfMinute 的 key 对齐）
  var PROACTIVE_DAYPARTS = [
    { key: 'morning', label: '早' },
    { key: 'noon', label: '午' },
    { key: 'afternoon', label: '下午' },
    { key: 'evening', label: '晚' },
    { key: 'late_night', label: '深夜' },
  ]

  /**
   * 私聊的额度制详情卡。
   *
   * ── 2026-11-24 新增 ──────────────────────────────────────────────────
   *
   * 为什么必须单独做一块：主动机会在私聊早就**不是概率制**了，而是
   * 「好感度档位 → tier → 每日额度 → 档内按百分比切分」，间隔还受
   * 时段权重、剩余额度、未回应次数三层影响。
   *
   * 面板原来只显示"30% 概率 / 30–90 分钟检查"——那对私聊是**假的**。
   *
   * ⚠️ 2026-11-24 二次修订：**全部改用内联样式**。
   *   第一版用 CSS 类（.dsh-fb-tiercard 等），但面板的 style 元素是
   *   `if (document.getElementById('dsh-fb-style')) return` 只注入一次，
   *   热更新场景下新加的类可能拿不到样式 —— 实测就出现了"卡片渲染出来了
   *   但完全没有排版"（文字挤在一起、没有背景/间距）。
   *   内联样式不依赖 style 元素的生命周期，在哪都能显示对。
   *   代价是没法做 :hover/:focus 这类伪类，但这张卡本来就是纯展示。
   */
  function renderPrivateTierCard(item) {
    var t = item.tier
    var box = h('div', 'dsh-fb-tiercard')
    // 卡片容器：浅色底 + 圆角 + 内边距，视觉上是"这个会话的详情"
    box.style.cssText = [
      'margin:8px 0 2px 34px',
      'padding:11px 13px',
      'border-radius:10px',
      'background:rgba(127,127,127,.07)',
      'border:1px solid rgba(127,127,127,.13)',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
    ].join(';')

    // ① 档位 + 分数（左粗右淡，同一行）
    var top = h('div')
    top.style.cssText = 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap'
    var tierName = h('b', null, (t.label || '—') + '档')
    tierName.style.cssText = 'font-size:13px;font-weight:600'
    top.appendChild(tierName)
    var stageText = h('span', null,
      (t.stageLabel || '未知') + ' · ' + Math.round(Number(t.score) || 0) + ' 分')
    stageText.style.cssText = 'font-size:11.5px;opacity:.62'
    top.appendChild(stageText)
    box.appendChild(top)

    // ② 今日额度进度条
    var quota = Number(t.quota) || 0
    var used = Number(t.usedToday) || 0
    var pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0
    var barOuter = h('div')
    barOuter.style.cssText = [
      'height:5px', 'border-radius:999px', 'overflow:hidden',
      'background:rgba(127,127,127,.16)',
    ].join(';')
    var barFill = h('div')
    barFill.style.cssText = [
      'height:100%', 'width:' + pct + '%', 'border-radius:999px',
      // 用满时换成中性灰：不是报错，只是"今天说够了"
      'background:' + (used >= quota && quota > 0
        ? 'rgba(127,127,127,.55)'
        : 'var(--dsw-alias-brand-primary,#4d6bfe)'),
      'transition:width .2s ease',
    ].join(';')
    barOuter.appendChild(barFill)
    box.appendChild(barOuter)

    var quotaText = h('span', null,
      '今天 ' + used + ' / ' + quota + ' 条'
      + (quota > 0 ? '（还剩 ' + Math.max(0, quota - used) + ' 条）' : ''))
    quotaText.style.cssText = 'font-size:11.5px;opacity:.7;margin-top:-3px'
    box.appendChild(quotaText)

    // ③ 实际间隔 + 被什么放大了（小药丸）
    var facts = h('div')
    facts.style.cssText = 'display:flex;gap:7px;flex-wrap:wrap'
    var pill = function (text, warm) {
      var el = h('span', null, text)
      el.style.cssText = [
        'font-size:11px', 'padding:2px 9px', 'border-radius:999px',
        warm
          ? 'background:rgba(217,119,6,.16);color:#d97706'
          : 'background:rgba(127,127,127,.12);opacity:.85',
      ].join(';')
      return el
    }
    facts.appendChild(pill('当前间隔 ' + proactiveDur(t.gapMs), false))
    if (Number(t.unanswered) > 0) {
      facts.appendChild(pill('没回 ' + t.unanswered + ' 次 · 已放缓', true))
    }
    if (Number(t.gapLayers && t.gapLayers.hourFactor) > 1) {
      facts.appendChild(pill('这个点偏安静', false))
    }
    box.appendChild(facts)

    // ④ 今天各时段发了几条（小柱状）
    var dp = t.dayparts || {}
    var hasAny = false
    for (var di = 0; di < PROACTIVE_DAYPARTS.length; di++) {
      if (Number(dp[PROACTIVE_DAYPARTS[di].key]) > 0) { hasAny = true; break }
    }
    if (hasAny) {
      var bars = h('div')
      bars.style.cssText = 'display:flex;gap:10px;align-items:flex-end;padding-top:3px'
      var maxN = 1
      for (var mi2 = 0; mi2 < PROACTIVE_DAYPARTS.length; mi2++) {
        maxN = Math.max(maxN, Number(dp[PROACTIVE_DAYPARTS[mi2].key]) || 0)
      }
      for (var pi = 0; pi < PROACTIVE_DAYPARTS.length; pi++) {
        (function (part) {
          var n = Number(dp[part.key]) || 0
          var cell = h('div')
          cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px'
          var col = h('div')
          col.style.cssText = [
            'width:12px',
            'height:' + Math.max(3, Math.round((n / maxN) * 26)) + 'px',
            'border-radius:3px 3px 0 0',
            // 没发过的时段用浅灰，发过的用品牌色 —— 一眼看出"哪个时段没动静"
            'background:' + (n === 0
              ? 'rgba(127,127,127,.20)'
              : 'var(--dsw-alias-brand-primary,#4d6bfe)'),
            'opacity:' + (n === 0 ? '1' : '.8'),
          ].join(';')
          cell.appendChild(col)
          var lab = h('span', null, part.label + (n > 0 ? String(n) : ''))
          lab.style.cssText = 'font-size:10px;opacity:.6'
          cell.appendChild(lab)
          bars.appendChild(cell)
        })(PROACTIVE_DAYPARTS[pi])
      }
      box.appendChild(bars)
    }

    // ⑤ 额度为 0 时说明原因（不然开关开了却从不冒泡，像 bug）
    if (quota <= 0) {
      var warn = h('span', null,
        '这个档位（' + (t.stageLabel || '当前') + '）的主动额度是 0：关系还没走到能主动的位置。')
      warn.style.cssText = 'font-size:11.5px;line-height:1.55;color:#d97706'
      box.appendChild(warn)
    }
    return box
  }

  function renderProactiveTab(d) {
    var g = d.global || {}
    var list = Array.isArray(d.sessions) ? d.sessions : []

    if (!list.length) {
      setBody([
        section('主动机会', [
          (function () {
            var box = h('div', 'dsh-fb-facts-empty')
            box.appendChild(h('div', 't', '还没有会话'))
            box.appendChild(h('div', 's', '她收到过消息才会建立会话。等群里有人说话，这里就会出现那一栏。'))
            return box
          })(),
        ]),
        actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('proactive') } }]),
      ])
      return
    }

    var onCount = 0
    for (var c = 0; c < list.length; c++) if (list[c].enabled) onCount += 1

    // 页头：全局状态 + 汇总。全局关着时整页标灰，避免"我明明开了怎么不冒泡"的困惑。
    var globalOff = g.enabled === false
    var head = h('div', 'dsh-fb-proact-head' + (globalOff ? ' is-off' : ''))
    var headTop = h('div', 'dsh-fb-proact-headtop')
    headTop.appendChild(h('span', 'dsh-fb-proact-dot' + (globalOff ? '' : ' is-on')))
    headTop.appendChild(h('b', null, globalOff ? '主动机会：全局已关闭' : '主动机会：全局开启'))
    head.appendChild(headTop)

    // ── 2026-11-24：说明文案分两种 ──────────────────────────────────────
    // 原来只有一段"群安静够久 + 概率命中"，但私聊现在是**额度制**，
    // 那段话对私聊完全是错的。这里按"有没有私聊会话"分别说明。
    var hasPrivate = false
    for (var hp = 0; hp < list.length; hp++) {
      if (String(list[hp].key || '').indexOf('private:') === 0) { hasPrivate = true; break }
    }
    var idleMin = Math.round((Number(g.idleThresholdMs) || 900000) / 60000)
    var probPct = Math.round((Number(g.probability) || 0) * 100)
    var subText
    if (globalOff) {
      subText = '在「回复节奏」里把主动机会打开，下面这些开关才会真正起作用。'
    } else if (hasPrivate) {
      subText = '私聊按额度走：好感度档位决定每天最多几条，档内按分数切分；'
        + '间隔还会被时段、剩余额度、未回应次数调整。群聊仍是概率制（安静满 '
        + idleMin + ' 分钟 + ' + probPct + '% 命中，每 '
        + Math.round((Number(g.checkIntervalMinMs) || 1800000) / 60000) + '~'
        + Math.round((Number(g.checkIntervalMaxMs) || 5400000) / 60000) + ' 分钟检查一次）。'
    } else {
      subText = '聊天要安静满 ' + idleMin + ' 分钟、且按 ' + probPct + '% 概率命中，她才可能主动开口。'
        + '每轮检查间隔 ' + Math.round((Number(g.checkIntervalMinMs) || 1800000) / 60000)
        + '~' + Math.round((Number(g.checkIntervalMaxMs) || 5400000) / 60000) + ' 分钟。'
    }
    head.appendChild(h('span', 'dsh-fb-proact-sub', subText))

    var stat = h('div', 'dsh-fb-proact-stats')
    stat.appendChild(h('span', 'dsh-fb-proact-stat', onCount + ' 个会话允许'))
    stat.appendChild(h('span', 'dsh-fb-proact-stat', (list.length - onCount) + ' 个已关闭'))
    head.appendChild(stat)

    var nodes = [head]

    // 逐个会话一个开关行。复用 switchRow 的视觉（它已经是这个面板统一的开关样式）。
    var wrap = h('div', 'dsh-fb-proact-list')
    for (var i = 0; i < list.length; i++) {
      (function (item) {
        var isGroup = String(item.key || '').indexOf('group:') === 0
        var num = String(item.key || '').split(':')[1] || ''
        var label = isGroup ? ('群 ' + num) : ('私聊 ' + num)

        // 第二行提示：给她一点上下文，知道这个聊天"多久没动静了"。
        var bits = []
        bits.push(proactiveAgo(Number(item.idleMs)))
        if (item.unreadCount > 0) bits.push(item.unreadCount + ' 条未读')
        // ⚠️ 2026-11-24 修：原来显示 `nextCheckInMs`（**倒计时**），
        //    面板每刷新一次数字就变（时间在流逝），看着像"点刷新间隔就变"。
        //    现在优先显示**绝对时刻**（一次调度内恒定），没有才退回倒计时。
        if (item.enabled && item.nextCheckAt) {
          var at = new Date(Number(item.nextCheckAt))
          if (!isNaN(at.getTime())) {
            var hh = String(at.getHours()).padStart(2, '0')
            var mm = String(at.getMinutes()).padStart(2, '0')
            var left2 = proactiveLeft(Number(item.nextCheckInMs))
            bits.push('下次检查 ' + hh + ':' + mm + (left2 ? '（还有 ' + left2 + '）' : ''))
          }
        } else if (item.enabled && item.nextCheckInMs != null) {
          var left = proactiveLeft(Number(item.nextCheckInMs))
          if (left) bits.push('下次检查还有 ' + left)
        } else if (item.enabled) {
          bits.push('已排程')
        }
        var hintText = bits.join(' · ')

        var row = switchRow({
          icon: PROACTIVE_ICON,
          title: label,
          hint: hintText,
          on: item.enabled === true,
          hintFor: function (on) {
            return on ? hintText : '已关闭，她不会主动在这个聊天里开口'
          },
          onFlip: function (next, revert) {
            postJson(mState.feature.api + '/proactive', { key: item.key, enabled: next })
              .then(function (r) {
                if (r && r.ok) {
                  toast(next ? '已允许主动开口' : '已关闭主动开口')
                  loadTab('proactive')
                } else {
                  revert(false)
                  mState.note = (r && r.error) || '保存失败'
                  renderProactiveTab(mState.data)
                }
              })
          },
        })
        // 全局关着时开关仍可点（改的是会话级意愿），但视觉上弱化，避免误解。
        if (globalOff) row.style.opacity = '.62'

        // ★ 2026-11-24：私聊在开关下面挂一张额度详情卡。
        //   放在同一个 .dsh-fb-item 里，这样边框/间距沿用列表样式，
        //   视觉上"这张卡属于这个会话"，而不是又开了一节。
        if (!isGroup && item.tier) {
          var cardItem = h('div', 'dsh-fb-tierwrap')
          cardItem.appendChild(renderPrivateTierCard(item))
          row.appendChild(cardItem)
        }
        wrap.appendChild(row)
      })(list[i])
    }
    nodes.push(section('按会话控制', [wrap]))
    nodes.push(actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('proactive') } }]))
    if (mState.note) nodes.push(h('div', 'dsh-fb-warn', mState.note))
    setBody(nodes)
  }

  function deleteTodo(key, text) {    if (!modal) return
    fetchJson(mState.feature.api + '/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove', key: key, text: text }),
    }).then(function (r) {
      mState.note = (r && r.ok) ? '已删除这条待办。' : ('删除失败：' + ((r && r.error) || '未知错误'))
      renderTab()
    }).catch(function (e) {
      mState.note = '删除失败：' + String((e && e.message) || e)
      renderTab()
    })
  }

  function updateSelfNote(key, oldText, newText) {
    if (!modal) return
    var t = String(newText || '').trim()
    if (!t) { mState.note = '内容不能为空'; renderTab(); return }
    mState.note = ''
    postJson(mState.feature.api + '/self-notes', {
      action: 'update', key: key, oldText: oldText, text: t,
    })
      .then(function (r) {
        if (!modal) return
        if (r && r.ok) { editing = null; mState.note = '已保存。' }
        else mState.note = '保存失败：' + ((r && r.error) || '未知错误')
        loadTab('self')
      })
      .catch(function (e) {
        if (!modal) return
        mState.note = '保存失败：' + (e && e.message ? e.message : e)
        loadTab('self')
      })
  }

  function removeSelfNote(key, text) {
    if (!modal) return
    mState.note = ''
    postJson(mState.feature.api + '/self-notes', {
      action: 'remove', key: key, text: text,
    })
      .then(function (r) {
        if (!modal) return
        mState.note = (r && r.ok) ? '已删除。' : ('删除失败：' + ((r && r.error) || '未知错误'))
        loadTab('self')
      })
      .catch(function (e) {
        if (!modal) return
        mState.note = '删除失败：' + (e && e.message ? e.message : e)
        loadTab('self')
      })
  }

  function renderImpressionsTab(d) {
    var list = Array.isArray(d.impressions) ? d.impressions : []

    if (!list.length) {
      setBody([
        section('群友印象', [
          (function () {
            var box = h('div', 'dsh-fb-facts-empty')
            box.appendChild(h('div', 't', '还没有群友印象'))
            box.appendChild(h('div', 's', '她会自己在聊天里用 qq_memory_append 记；这里没内容说明还没发生过值得记的事。'))
            return box
          })(),
        ]),
        actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('impressions') } }]),
      ])
      return
    }

    var wrap = h('div', 'dsh-fb-imp')
    for (var i = 0; i < list.length; i++) {
      (function (im) {
        var myId = im.key + '\u0000' + im.name
        var isEditing = editing && editing.kind === 'impression' && editing.id === myId
        var card = h('div', 'dsh-fb-impcard' + (isEditing ? ' editing' : ''))

        var head = h('div', 'dsh-fb-imphead')
        if (isEditing) {
          var nameInput = h('input', 'dsh-fb-edit-name')
          nameInput.type = 'text'
          nameInput.value = editDraft.name
          nameInput.addEventListener('input', function () { editDraft.name = nameInput.value })
          head.appendChild(nameInput)
        } else {
          head.appendChild(h('div', 'dsh-fb-impname', im.name || '（无名）'))
          var metaBits = []
          if (im.interactionCount) metaBits.push('互动 ' + im.interactionCount + ' 次')
          if (im.key) metaBits.push(im.key)
          if (metaBits.length) head.appendChild(h('div', 'dsh-fb-impmeta', metaBits.join(' · ')))
        }
        card.appendChild(head)

        var traits = Array.isArray(im.traits) ? im.traits : []
        var tl = h('div', 'dsh-fb-imptraits')
        for (var k = 0; k < traits.length; k++) {
          (function (ti) {
            var line = h('div', 'dsh-fb-imptrait')
            if (isEditing) {
              var ta = h('textarea', 'dsh-fb-edit-text small')
              ta.value = editDraft.traits[ti] != null ? editDraft.traits[ti] : traits[ti]
              ta.rows = 2
              ta.addEventListener('input', function () { editDraft.traits[ti] = ta.value })
              line.appendChild(ta)
            } else {
              line.appendChild(document.createTextNode(traits[ti]))
            }
            tl.appendChild(line)
          })(k)
        }
        card.appendChild(tl)

        var ops = h('div', 'dsh-fb-fact-ops')
        if (isEditing) {
          ops.appendChild(cancelButton())
          ops.appendChild(saveButton(function () {
            updateImpression(im.key, im.name, editDraft.name, editDraft.traits)
          }))
        } else {
          ops.appendChild(editButton(function () {
            beginEdit('impression', myId, {
              text: '', tag: '', name: im.name, traits: (im.traits || []).slice(),
            })
          }))
          ops.appendChild(deleteButton('删掉对这个人的印象', function () {
            removeImpression(im.key, im.name)
          }))
        }
        card.appendChild(ops)

        wrap.appendChild(card)
      })(list[i])
    }

    var nodes = [
      section('群友印象（' + list.length + ' 人）', [wrap]),
      actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('impressions') } }]),
      h('div', 'dsh-fb-warn', '每条印象最多 50 字（桥接侧硬上限）。改名会把这条印象迁到新名字下。'),
    ]
    if (mState.note) nodes.push(h('div', 'dsh-fb-warn', mState.note))
    setBody(nodes)
  }

  function updateImpression(key, name, newName, traits) {
    if (!modal) return
    var clean = (traits || []).map(function (x) { return String(x || '').trim() }).filter(Boolean)
    if (!clean.length) { mState.note = '至少保留一条印象'; renderTab(); return }
    mState.note = ''
    var payload = { action: 'update', key: key, name: name, traits: clean }
    if (newName && newName !== name) payload.newName = String(newName).trim()
    postJson(mState.feature.api + '/impressions', payload)
      .then(function (r) {
        if (!modal) return
        if (r && r.ok) { editing = null; mState.note = '已保存。' }
        else mState.note = '保存失败：' + ((r && r.error) || '未知错误')
        loadTab('impressions')
      })
      .catch(function (e) {
        if (!modal) return
        mState.note = '保存失败：' + (e && e.message ? e.message : e)
        loadTab('impressions')
      })
  }

  function removeImpression(key, name) {
    if (!modal) return
    mState.note = ''
    postJson(mState.feature.api + '/impressions', { action: 'remove', key: key, name: name })
      .then(function (r) {
        if (!modal) return
        mState.note = (r && r.ok) ? ('已删除「' + name + '」的印象。') : ('删除失败：' + ((r && r.error) || '未知错误'))
        loadTab('impressions')
      })
      .catch(function (e) {
        if (!modal) return
        mState.note = '删除失败：' + (e && e.message ? e.message : e)
        loadTab('impressions')
      })
  }

  function renderFactsTab(d) {
    var list = Array.isArray(d.facts) ? d.facts : []
    var live = []
    for (var i = 0; i < list.length; i++) {
      if (!list[i].archived) live.push(list[i])
    }

    if (!live.length) {
      setBody([
        section('长期记忆', [
          (function () {
            var box = h('div', 'dsh-fb-facts-empty')
            box.appendChild(h('div', 't', '还没有长期事实'))
            box.appendChild(h('div', 's', '她在聊天里自己记（几个月后仍成立的事）；之后每次被提到都会自动加权。'))
            return box
          })(),
        ]),
        actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('facts') } }]),
      ])
      return
    }

    var wrap = h('div', 'dsh-fb-facts')
    for (var j = 0; j < live.length; j++) {
      (function (fact) {
        var meta = FACT_TAG[fact.tag] || FACT_TAG.misc
        var isEditing = editing && editing.kind === 'fact' && editing.id === fact.id
        var row = h('div', 'dsh-fb-fact' + (isEditing ? ' editing' : ''))

        var bar = h('div', 'dsh-fb-fact-bar')
        bar.style.background = meta.color
        row.appendChild(bar)

        var main = h('div', 'dsh-fb-fact-main')

        if (isEditing) {
          var ta = h('textarea', 'dsh-fb-edit-text')
          ta.value = editDraft.text
          ta.rows = 3
          ta.addEventListener('input', function () { editDraft.text = ta.value })
          main.appendChild(ta)

          var sel = h('select', 'dsh-fb-edit-tag')
          for (var tk in FACT_TAG) {
            if (!Object.prototype.hasOwnProperty.call(FACT_TAG, tk)) continue
            var opt = document.createElement('option')
            opt.value = tk
            opt.textContent = FACT_TAG[tk].label
            if (tk === editDraft.tag) opt.selected = true
            sel.appendChild(opt)
          }
          sel.addEventListener('change', function () { editDraft.tag = sel.value })
          var tagRow = h('div', 'dsh-fb-edit-row')
          tagRow.appendChild(h('span', 'dsh-fb-edit-label', '类别'))
          tagRow.appendChild(sel)
          main.appendChild(tagRow)
        } else {
          main.appendChild(h('div', 'dsh-fb-fact-text', fact.text))

          var metaRow = h('div', 'dsh-fb-fact-meta')
          metaRow.appendChild(h('span', 'dsh-fb-tag', meta.label))
          var w = fact.weight != null ? Number(fact.weight) : 0
          metaRow.appendChild(h('span', 'dsh-fb-w ' + factWeightClass(w), w.toFixed(2)))
          metaRow.appendChild(h('span', null, '提到 ' + (fact.hits || 0) + ' 次'))
          if (fact.key) {
            metaRow.appendChild(h('span', null, '·'))
            metaRow.appendChild(h('span', null, fact.key))
          }
          main.appendChild(metaRow)
        }

        row.appendChild(main)

        var ops = h('div', 'dsh-fb-fact-ops')
        if (isEditing) {
          ops.appendChild(cancelButton())
          ops.appendChild(saveButton(function () {
            updateFact(fact.key, fact.id, editDraft.text, editDraft.tag)
          }))
        } else {
          ops.appendChild(editButton(function () {
            beginEdit('fact', fact.id, { text: fact.text, tag: fact.tag || 'misc', name: '', traits: [] })
          }))
          ops.appendChild(deleteButton('归档这条长期事实', function () {
            removeFact(fact.key, fact.id)
          }))
        }
        row.appendChild(ops)

        wrap.appendChild(row)
      })(live[j])
    }

    var nodes = [
      section('长期记忆（' + live.length + ' 条，按权重从高到低）', [wrap]),
      actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('facts') } }]),
      h('div', 'dsh-fb-warn',
        '权重 = 类别基础分（身份/约定/情绪 3.0，偏好 2.5，梗 1.6，其他 1.3）'
        + ' + 命中加成（每次 +0.5，最多 +1.5）− 衰减（每 3 天 −0.1）。低于 1.0 停止注入。'),
    ]
    if (mState.note) nodes.push(h('div', 'dsh-fb-warn', mState.note))
    setBody(nodes)
  }

  function updateFact(key, id, text, tag) {
    if (!modal) return
    var t = String(text || '').trim()
    if (!t) { mState.note = '正文不能为空'; renderTab(); return }
    mState.note = ''
    postJson(mState.feature.api + '/facts', { action: 'update', key: key, id: id, text: t, tag: tag })
      .then(function (r) {
        if (!modal) return
        if (r && r.ok) { editing = null; mState.note = '已保存。' }
        else mState.note = '保存失败：' + ((r && r.error) || '未知错误')
        loadTab('facts')
      })
      .catch(function (e) {
        if (!modal) return
        mState.note = '保存失败：' + (e && e.message ? e.message : e)
        loadTab('facts')
      })
  }

  function removeFact(key, id) {
    if (!modal) return
    mState.note = ''
    postJson(mState.feature.api + '/facts', { action: 'remove', key: key, id: id })
      .then(function (r) {
        if (!modal) return
        mState.note = (r && r.ok) ? '已删除。' : ('删除失败：' + ((r && r.error) || '未知错误'))
        loadTab('facts')
      })
      .catch(function (e) {
        if (!modal) return
        mState.note = '删除失败：' + (e && e.message ? e.message : e)
        loadTab('facts')
      })
  }


  function renderRhythmTab(d) {
    var r = d.rhythm || {}
    var grid = h('div', 'dsh-fb-grid')
    for (var i = 0; i < RHYTHM_FIELDS.length; i++) {
      (function (spec) {
        var field = h('div', 'dsh-fb-field')
        field.appendChild(h('label', null, spec[1]))
        var v = getPath(r, spec[0])
        var input
        if (spec[3] === 'bool') {
          // 布尔项渲染成勾选框：用数字框让用户填 1/0 太反人类。
          input = h('input')
          input.type = 'checkbox'
          input.checked = v === true
        } else {
          input = h('input', 'dsh-fb-input')
          input.type = 'number'
          // 2026-11-19：单位是秒的字段，把后端存的毫秒换算成秒再显示。
          // 注意 undefined/null 要留空，不能变成 0 —— 0 秒是有意义的配置值，
          // 和"没配过"不是一回事（没必要但容易混淆，留空更清楚）。
          if (spec[3] === 'sec' && v !== undefined && v !== null && v !== '') {
            var sec = Number(v) / 1000
            // 去掉浮点尾巴：30000/1000=30 而不是 30.000000000000004
            input.value = String(Math.round(sec * 1000) / 1000)
          } else {
            input.value = (v === undefined || v === null) ? '' : String(v)
          }
          input.step = spec[3] === 'sec' ? 'any' : '1'
          input.min = '0'
        }
        input.dataset.key = spec[0]
        if (spec[3] === 'sec') input.dataset.unit = 'sec'
        field.appendChild(input)
        field.appendChild(h('small', null, spec[2]))
        grid.appendChild(field)
      })(RHYTHM_FIELDS[i])
    }

    var nodes = [section('回复节奏（保存后即时生效）', [grid])]
    nodes.push(actionsRow([
      { label: '保存', onClick: function () { saveRhythm(r) } },
      { label: '放弃改动', ghost: true, onClick: function () { loadTab('rhythm') } },
    ]))
    nodes.push(h('div', 'dsh-fb-warn', '提醒：发送频率调得越高，触发 QQ 风控的风险越大。默认值（每分钟 8 条 / 每小时 60 条）是保守的。'))
    if (mState.note) nodes.push(h('div', 'dsh-fb-warn', mState.note))

    // ── 打开完整控制台（不用手输令牌）──────────────────────────────────
    // 令牌不经过页面：点一下只是让 host 半去拼 URL 并交给系统浏览器打开。
    // 这里绝不能自己拼 `?token=...` —— 前端拿不到令牌，也不该拿到。
    //
    // ⚠️ 必须用 actionsRow：h() 的第三个参数是 **text**（内部 el.textContent = text），
    // 传一个 Element 进去会被转成字符串，页面上显示成 `[object HTMLButtonElement]`。
    // actionsRow 才是「放按钮」的正确入口（它自己建 button 并绑 onClick）。
    nodes.push(section('完整控制台', [
      actionsRow([{
        label: '打开完整控制台（免令牌）',
        onClick: function () {
          fetchJson(mState.feature.api + '/open-console').then(function (res) {
            toast(res && res.ok ? '已用默认浏览器打开控制台' : ((res && res.error) || '打开失败'))
          })
        },
      }]),
      h('div', 'dsh-fb-warn', '桥接自带的网页控制台（127.0.0.1:3100）：运行总览、会话与审批、人格、聊天行为、令牌与花费、访问与安全、调试与运维、工具参考都在那边。点上面按钮会用令牌自动打开，不需要手输。'),
    ]))

    setBody(nodes)
  }

  function saveRhythm(original) {
    if (!modal) return
    // 深拷贝后逐字段覆盖：必须整体回写，因为桥接的 config 接口是浅合并，
    // 子对象（send/wait/wake）传局部会把其余字段清掉。
    var rhythm = JSON.parse(JSON.stringify(original || {}))
    var inputs = modal.body.querySelectorAll('input[data-key]')
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i]
      var parts = input.dataset.key.split('.')
      var cur = rhythm
      for (var k = 0; k < parts.length - 1; k++) {
        if (!cur[parts[k]] || typeof cur[parts[k]] !== 'object') cur[parts[k]] = {}
        cur = cur[parts[k]]
      }
      if (input.type === 'checkbox') {
        cur[parts[parts.length - 1]] = input.checked === true
        continue
      }
      var num = Number(input.value)
      if (input.value === '' || !isFinite(num)) continue
      // 2026-11-19：单位是秒的字段，存回配置时要换算成毫秒。
      // 不换算的话「30 秒」会被当成 30 毫秒存下去 —— 安静窗直接归零。
      if (input.dataset.unit === 'sec') num = Math.round(num * 1000)
      cur[parts[parts.length - 1]] = num
    }
    setBody([h('div', 'dsh-fb-empty', '保存中…')])
    postJson(mState.feature.api + '/settings', { rhythm: rhythm }).then(function (res) {
      if (res && res.ok) {
        toast('节奏已保存')
        loadTab('rhythm')
      } else {
        mState.note = (res && res.error) || '保存失败'
        renderRhythmTab(mState.data)
      }
    })
  }

  function renderPersonaTab(d) {
    var list = Array.isArray(d.roles) ? d.roles : []
    var summaries = Array.isArray(d.summaries) ? d.summaries : []
    var limits = d.limits || {}
    var nodes = []

    var pick = h('select', 'dsh-fb-input')
    var opt0 = h('option', null, '（未启用角色扮演）')
    opt0.value = ''
    pick.appendChild(opt0)
    for (var i = 0; i < list.length; i++) {
      var o = h('option', null, list[i])
      o.value = list[i]
      if (d.current === list[i]) o.selected = true
      pick.appendChild(o)
    }

    // 当前角色常驻回显。toast 一闪就过，而下拉框在"切换其实没生效"时会回到空白，
// 用户根本看不出到底切没切。这一行跟着 loadTab 重新渲染，是权威状态。
    var currentLine = h('div', 'dsh-fb-empty')
    currentLine.textContent = d.current
      ? ('当前角色：' + d.current + '（已生效，下一轮唤醒起按这张卡说话）')
      : '当前角色：未启用（选一张卡 → 点「设为当前角色」）'

    var meta = h('div', 'dsh-fb-empty')
    var warn = h('div', 'dsh-fb-warn')
    var area = h('textarea', 'dsh-fb-area')
    area.placeholder = '选择上方角色卡后在这里编辑…'

    function loadOne(name) {
      if (!name) { area.value = ''; meta.textContent = ''; warn.textContent = ''; return }
      fetchJson(mState.feature.api + '/persona?name=' + encodeURIComponent(name)).then(function (one) {
        area.value = (one && (one.content || one.text)) || ''
        var s = null
        for (var j = 0; j < summaries.length; j++) if (summaries[j].name === name) s = summaries[j]
        if (s) {
          meta.textContent = s.chars + ' 字 · 实际注入 ' + s.injectedV2 + ' 字 · ' + s.lines + ' 行'
          warn.textContent = s.truncated
            ? ('⚠ 角色卡 ' + s.chars + ' 字，超过注入上限 ' + (limits.injectMaxChars || '?') + ' 字，超出部分不会生效（可调高上限，但过大也会拖慢每轮）')
            : ''
        } else { meta.textContent = ''; warn.textContent = '' }
      })
    }
    pick.addEventListener('change', function () { loadOne(pick.value) })

    nodes.push(section('角色卡（人格层）', [currentLine, pick, meta, area]))

    var limitInput = h('input', 'dsh-fb-input')
    limitInput.type = 'number'
    limitInput.value = String(limits.injectMaxChars || '')
    var limitField = h('div', 'dsh-fb-field')
    limitField.appendChild(h('label', null, '注入字数上限（当前 ' + (limits.injectMaxChars || '?') + '）'))
    limitField.appendChild(limitInput)
    nodes.push(section('上限与统计', [
      limitField,
      kv('角色数', list.length),
      kv('名称长度上限', limits.nameMax),
      kv('单卡字节上限', limits.contentMaxBytes),
    ]))

    nodes.push(actionsRow([
      { label: '保存角色卡', onClick: function () {
        if (!pick.value) { toast('请先选择一个角色卡'); return }
        postJson(mState.feature.api + '/persona', { action: 'save', name: pick.value, content: area.value }).then(function (res) {
          toast(res && res.ok ? '角色卡已保存' : ((res && res.error) || '保存失败'))
          loadTab('persona')
        })
      } },
      { label: '设为当前角色', ghost: true, onClick: function () {
        postJson(mState.feature.api + '/persona', { action: 'activate', name: pick.value || null }).then(function (res) {
          // 提示里带上"这次到底切成了谁"：以前只说"已切换当前角色"，而桥接那边
          // 因为字段名不一致其实清空了角色，用户看到成功的提示、下拉框却是空的。
          var ok = res && res.ok
          toast(ok
            ? (res.role ? ('已切换到「' + res.role + '」，下一轮唤醒生效') : '已取消角色扮演')
            : ((res && res.error) || '切换失败'))
          loadTab('persona')
        })
      } },
      { label: '应用上限', ghost: true, onClick: function () {
        postJson(mState.feature.api + '/persona', { action: 'limit', injectMaxChars: Number(limitInput.value) }).then(function (res) {
          toast(res && res.ok ? '上限已更新' : ((res && res.error) || '更新失败'))
          loadTab('persona')
        })
      } },
      { label: '删除', danger: true, onClick: function () {
        if (!pick.value) return
        postJson(mState.feature.api + '/persona', { action: 'delete', name: pick.value }).then(function (res) {
          toast(res && res.ok ? '已删除' : ((res && res.error) || '删除失败'))
          loadTab('persona')
        })
      } },
    ]))
    if (warn.textContent) nodes.push(warn)
    setBody(nodes)
    loadOne(pick.value)
  }

  function renderTokensTab(d) {
    var t = d.totals || {}
    var b = t.buckets || {}
    var tier = d.nowTier || {}
    var symbol = d.symbol || '¥'
    var total = b.cacheMiss || 0
    var hit = b.cacheHit || 0
    var out = b.output || 0
    var money = (t.cost !== undefined) ? t.cost : (t.money !== undefined ? t.money : (t.cny !== undefined ? t.cny : null))

    var cards = h('div', 'dsh-fb-cards')
    function card(value, label) {
      var c = h('div', 'dsh-fb-card')
      c.appendChild(h('b', null, value))
      c.appendChild(h('span', null, label))
      return c
    }
    cards.appendChild(card(money === null ? '—' : (symbol + Number(money).toFixed(4)), '累计花费（' + (d.currency || 'CNY') + '）'))
    cards.appendChild(card(String(total + hit + out), '总 token'))
    cards.appendChild(card(String(total), '未命中输入'))
    cards.appendChild(card(String(hit), '缓存命中输入'))
    cards.appendChild(card(String(out), '输出'))

    var nodes = [section('用量与花费', [cards])]
    if (tier.model) {
      nodes.push(section('当前计价（' + (tier.tierLabel || '') + '）', [
        kv('模型', tier.label || tier.model),
        kv('未命中输入', tier.cacheMiss + ' 元/百万'),
        kv('缓存命中', tier.cacheHit + ' 元/百万'),
        kv('输出', tier.output + ' 元/百万'),
        kv('峰谷倍率', d.priceTable ? (d.priceTable.peakMultiplier + '×（高峰时段）') : '—'),
      ]))
    }
    nodes.push(h('div', 'dsh-fb-warn', '价目表版本 ' + (d.priceVersion || '?') + '，按 DeepSeek 官方价折算。你若在用 qwen 等第三方模型，需要在桥接 config.json 的 pricing.models 里登记该模型价格，否则这里会按默认价估算。'))
    nodes.push(actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('tokens') } }]))
    setBody(nodes)
  }

  function renderStickersTab(d) {
    var list = Array.isArray(d.stickers) ? d.stickers : []
    var total = (d.total === undefined || d.total === null) ? list.length : d.total
    var api = mState.feature.api + '/stickers'
    var nodes = []

    // ── 上传 ──
    // 不走 window.prompt：Electron 里它不可靠；这里用隐藏 file input + 常驻备注框。
    var fileInput = h('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp'
    fileInput.style.display = 'none'
    document.body.appendChild(fileInput)

    var noteInput = h('input', 'dsh-fb-input')
    noteInput.placeholder = '备注（可选，≤20 字）'
    noteInput.maxLength = 20
    noteInput.style.maxWidth = '240px'

    var pickBtn = h('button', 'dsh-fb-btn', '选择图片上传')
    pickBtn.type = 'button'
    pickBtn.addEventListener('click', function () { fileInput.click() })

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0]
      if (!file) return
      if (file.size > 2 * 1024 * 1024) {
        toast('图片 ' + (file.size / 1048576).toFixed(2) + 'MB，超过 2MB 上限')
        return
      }
      pickBtn.disabled = true
      pickBtn.textContent = '上传中…'
      var reader = new FileReader()
      reader.onload = function () {
        postJson(api, { action: 'upload', data: String(reader.result || ''), note: noteInput.value || '' })
          .then(function (res) {
            toast(res && res.ok ? '已加入 QQ 收藏表情' : ((res && res.error) || '上传失败'))
            loadTab('stickers')
          })
      }
      reader.onerror = function () { toast('读取文件失败') }
      reader.readAsDataURL(file)
    })

    var upRow = h('div', 'dsh-fb-actions')
    upRow.appendChild(pickBtn)
    upRow.appendChild(noteInput)
    nodes.push(section('上传新表情', [
      upRow,
      h('div', 'dsh-fb-warn', '支持 png / jpg / gif / webp，单张上限 2MB。上传会直接加入你 QQ 账号的收藏表情，之后 AI 通过 qq_list_stickers 就能看到并使用它。'),
    ]))

    // ── 列表 ──
    var grid = h('div', 'dsh-fb-cards')
    if (!list.length) {
      grid.appendChild(h('div', 'dsh-fb-empty', '还没有收藏表情。上传一张试试；也可以让机器人在群里「偷图」（它会自己判断哪张有意思）。'))
    }
    for (var i = 0; i < list.length; i++) {
      (function (s) {
        var card = h('div', 'dsh-fb-card')
        if (s.url) {
          var img = h('img', 'dsh-fb-thumb')
          img.src = s.url
          img.alt = s.desc || '表情'
          img.loading = 'lazy'
          card.appendChild(img)
        }
        card.appendChild(h('span', null, s.desc || s.localNote || '(无备注)'))
        card.appendChild(h('span', null, String(s.id || '').slice(-14)))

        var editBtn = h('button', 'dsh-fb-mini', '改备注')
        editBtn.type = 'button'
        editBtn.addEventListener('click', function () {
          if (card.querySelector('.dsh-fb-inline-edit')) return
          var row = h('div', 'dsh-fb-actions dsh-fb-inline-edit')
          var input = h('input', 'dsh-fb-input')
          input.value = s.desc || ''
          input.maxLength = 20
          input.style.maxWidth = '130px'
          var save = h('button', 'dsh-fb-mini', '保存')
          save.type = 'button'
          save.addEventListener('click', function () {
            postJson(api, { action: 'remark', stickerId: s.id, remark: input.value.slice(0, 20) })
              .then(function (res) {
                toast(res && res.ok ? '备注已更新' : ((res && res.error) || '更新失败'))
                loadTab('stickers')
              })
          })
          var cancel = h('button', 'dsh-fb-mini', '取消')
          cancel.type = 'button'
          cancel.addEventListener('click', function () { if (row.parentNode) row.parentNode.removeChild(row) })
          row.appendChild(input)
          row.appendChild(save)
          row.appendChild(cancel)
          card.appendChild(row)
        })
        card.appendChild(editBtn)

        // 二次确认不用 window.confirm（Electron 下不可靠）：按钮点两下才真删。
        var delBtn = h('button', 'dsh-fb-mini danger', '删除')
        delBtn.type = 'button'
        delBtn.addEventListener('click', function () {
          if (delBtn.dataset.armed === '1') {
            // 用 resId（完整 emoji_id）而不是 id：列表里的 id 是 md5（省 token 用的），
            // 而删除协议要整串 emoji_id。桥接现在两种都能解析，这里发准确的更好。
            postJson(api, { action: 'delete', stickerId: s.resId || s.id }).then(function (res) {
              // 桥接会重新拉取列表核实是否真的删掉，删除未生效时返回 ok:false，
              // 所以这里如实显示它的报错，不要一律提示「已删除」。
              toast(res && res.ok ? '已删除' : ((res && res.error) || '删除失败'))
              loadTab('stickers')
            })
            return
          }
          delBtn.dataset.armed = '1'
          delBtn.textContent = '确认删除？'
          setTimeout(function () {
            if (delBtn.parentNode) { delBtn.dataset.armed = '0'; delBtn.textContent = '删除' }
          }, 4000)
        })
        card.appendChild(delBtn)
        grid.appendChild(card)
      })(list[i])
    }
    nodes.push(section('收藏表情（' + total + ' 个）', [grid]))

    nodes.push(actionsRow([
      { label: '刷新', ghost: true, onClick: function () { loadTab('stickers') } },
      { label: '同步 QQ 收藏', ghost: true, onClick: function () {
        postJson(api, { action: 'sync' }).then(function (res) {
          toast(res && res.ok ? ('已同步 ' + (res.total || 0) + ' 个') : ((res && res.error) || '同步失败'))
          loadTab('stickers')
        })
      } },
    ]))
    setBody(nodes)
  }

  function renderAccessTab(d) {
    var allow = d.allow || { private: [], groups: [] }
    var deny = d.deny || { private: [], groups: [] }
    var api = mState.feature.api + '/access'
    var nodes = []

    nodes.push(section('管理员（Owner：全部工具权限）', [
      statusLine('管理员 QQ：' + (d.ownerQQ || '（未设置）'), !!d.ownerQQ),
      h('div', 'dsh-fb-warn', '只有管理员能用工具。改管理员请去桥接控制台 http://127.0.0.1:3100 的「访问与安全」页（这里故意不提供，避免误改把自己锁在外面）。'),
    ]))

    function bucket(title, kind, list, isDeny, emptyHint) {
      var rows = []
      if (!list.length) {
        rows.push(h('div', 'dsh-fb-empty', emptyHint))
      } else {
        for (var i = 0; i < list.length; i++) {
          (function (id) {
            var row = h('div', 'dsh-fb-actions')
            var lab = h('span', null, String(id))
            lab.style.minWidth = '150px'
            lab.style.fontSize = '12px'
            row.appendChild(lab)
            // 管理员账号受保护：踢出它是当前最反直觉的坑 ——
            // reserved2 模式的准入只看 allow/deny，不看 ownerQQ，
            // 所以把自己踢出 = 自己彻底收不到服务（虽然还能用工具箱救回来）。
            var isOwnerRow = !isDeny && String(id) === String(d.ownerQQ || '')
            var btn = h('button', 'dsh-fb-mini' + (isDeny ? '' : ' danger'), isDeny ? '解除拉黑' : '踢出（拉黑）')
            btn.type = 'button'
            if (isOwnerRow) {
              btn.disabled = true
              btn.textContent = '管理员（不可踢出）'
              btn.style.opacity = '0.5'
              btn.style.cursor = 'not-allowed'
            } else {
              btn.addEventListener('click', function () {
                postJson(api, { action: isDeny ? 'unblock' : 'block', kind: kind, id: id }).then(function (res) {
                  toast(res && res.ok ? (isDeny ? '已解除' : '已踢出并拉黑') : ((res && res.error) || '操作失败'))
                  loadTab('access')
                })
              })
            }
            row.appendChild(btn)
            rows.push(row)
          })(list[i])
        }
      }
      nodes.push(section(title + '（' + list.length + '）', rows))
    }

    bucket('私聊白名单（可用只读工具）', 'private', allow.private, false, '还没有授权的私聊。')
    bucket('群白名单', 'group', allow.groups, false, '还没有授权的群。')
    bucket('私聊黑名单（不读、不存、不回）', 'private', deny.private, true, '黑名单为空。')
    bucket('群黑名单（不读、不存、不回）', 'group', deny.groups, true, '黑名单为空。')

    // 添加区
    var idInput = h('input', 'dsh-fb-input')
    idInput.placeholder = 'QQ 号 或 群号'
    idInput.style.maxWidth = '150px'
    var kindSel = h('select', 'dsh-fb-input')
    var o1 = h('option', null, '私聊'); o1.value = 'private'
    var o2 = h('option', null, '群'); o2.value = 'group'
    kindSel.appendChild(o1); kindSel.appendChild(o2)
    var addAllow = h('button', 'dsh-fb-btn', '加入白名单')
    addAllow.type = 'button'
    addAllow.addEventListener('click', function () { send('allow') })
    var addBlock = h('button', 'dsh-fb-btn ghost', '拉黑')
    addBlock.type = 'button'
    addBlock.addEventListener('click', function () { send('block') })
    function send(act) {
      var v = String(idInput.value || '').trim()
      if (!/^\d+$/.test(v)) { toast('请输入纯数字的 QQ 号或群号'); return }
      postJson(api, { action: act, kind: kindSel.value, id: v }).then(function (res) {
        toast(res && res.ok ? (act === 'allow' ? '已加入白名单' : '已拉黑') : ((res && res.error) || '操作失败'))
        loadTab('access')
      })
    }
    var addRow = h('div', 'dsh-fb-actions')
    addRow.appendChild(idInput); addRow.appendChild(kindSel)
    addRow.appendChild(addAllow); addRow.appendChild(addBlock)
    nodes.push(section('手动添加', [
      addRow,
      h('div', 'dsh-fb-warn', '白名单 = 允许它跟机器人对话；黑名单 = 完全无视（消息不进上下文、不消耗 token）。两个名单互斥，加入一边会自动从另一边移除。'),
      h('div', 'dsh-fb-warn', '⚠️ 当前是 reserved2 模式：准入只看白名单，不看管理员身份 —— 所以管理员账号也必须在白名单里才会被响应（本页已禁止踢出管理员，避免误操作把自己锁在外面）。'),
    ]))

    nodes.push(actionsRow([
      { label: '刷新', ghost: true, onClick: function () { loadTab('access') } },
    ]))
    setBody(nodes)
  }

  function renderBackendTab(d) {
    var list = Array.isArray(d.backends) ? d.backends : []
    var nodes = [section('桥接当前指向', [kv('DSH 地址', d.current)])]

    var rows = []
    if (!list.length) {
      rows.push(h('div', 'dsh-fb-empty', d.supported === false ? '当前平台不支持自动发现（仅 Windows）' : '没有发现运行中的 DSH 实例'))
    }
    for (var i = 0; i < list.length; i++) {
      (function (bk) {
        var row = h('div', 'dsh-fb-kv')
        row.appendChild(h('span', null, bk.label + ' · PID ' + bk.pid))
        row.appendChild(h('span', null, bk.url + (bk.current ? ' ← 当前' : '')))
        rows.push(row)
        if (!bk.current) {
          rows.push(actionsRow([{ label: '对齐DSH端口', ghost: true, onClick: function () {
            postJson(mState.feature.api + '/backend', { url: bk.url }).then(function (res) {
              toast(res && res.ok ? (res.restartNote || '已切换') : ((res && res.error) || '切换失败'))
              loadTab('backend')
            })
          } }]))
        }
      })(list[i])
    }
    nodes.push(section('可用的 DSH 实例', rows))
    nodes.push(h('div', 'dsh-fb-warn', '切换会让桥接改连另一个 DSH 并自动重启。注意取舍：桌面端被关闭时机器人会一并下线；CLI 版可以独立常驻。'))
    setBody(nodes)
  }

  function renderDiagnoseTab(d) {
    var checks = Array.isArray(d.checks) ? d.checks : []
    var rows = []
    var failed = 0
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i]
      if (c.ok !== true) failed += 1
      rows.push(statusLine(c.name + (c.detail ? '：' + c.detail : ''), c.ok === true))
    }
    // 标题说清楚「几项没过」，而不是笼统的「发现问题」—— 这样一眼就知道
    // 是完全连不上（全红）还是只有一项没配好（一红五绿）。
    var title = failed === 0
      ? '自检全部通过'
      : (failed === checks.length ? '自检全部未通过' : `自检有 ${failed} 项未通过（共 ${checks.length} 项）`)
    var nodes = [section(title, rows)]
    // 端点对齐的结论：端口漂移是这类故障最常见的原因，明说「这轮做了什么」
    // 比让人去翻 bridge.log 快得多。只在真的发生过动作时显示，正常时保持安静。
    var es = d.endpointSync
    if (es && (es.changed === true || es.reason === 'hint' || es.reason === 'scan')) {
      var syncRows = []
      if (es.baseUrl) syncRows.push(kv('桥接的 DSH 地址', es.baseUrl))
      if (es.changed === true) syncRows.push(kv('本轮动作', '已从旧地址自动跟随到上面这个（' + (es.reason || 'scan') + '）'))
      else syncRows.push(kv('本轮动作', '地址本来就是对的，无需改动'))
      nodes.push(section('端点对齐', syncRows))
    }
    if (d.model) nodes.push(section('DSH 模型', [kv('当前模型', (d.model.provider ? d.model.provider + ' / ' : '') + (d.model.model || '—')), kv('思考强度', d.model.reasoningEffort)]))
    // 桥接没跑时把「已试过自动启动」如实显示出来，否则一屏错误信息没人知道下一步做什么。
    var as = d.autostart
    if (as && !(d.ok === true)) {
      var note = as.started
        ? '已执行 start.bat 拉起桥接，但控制台仍然连不上 —— 看 qq-bridge/state/bridge.log 的前几行。'
        : (as.error || '桥接没在运行，且自动启动没有成功。')
      nodes.push(h('div', 'dsh-fb-warn', note))
    }
    if (d.elapsedMs) nodes.push(kv('本次检测耗时', d.elapsedMs + 'ms'))
    nodes.push(actionsRow([{ label: '重新检测', onClick: function () { loadTab('diagnose') } }]))
    setBody(nodes)
  }

  /* ---------------- 状态页（生活状态） ---------------- */

  /**
   * 渲染「状态」页：她此刻的身体、周期、天气、心情、以及所有活着的 condition。
   *
   * ⚠️ 全部用**内联样式**，不往 style 表里加类。
   *    原因见 renderTierCard 上面的注释：面板的 style 元素是
   *    `if (document.getElementById('dsh-fb-style')) return` 只注入一次，
   *    插件热重载时新加的 CSS 类不会生效。
   */
  function renderLifeTab(d) {
    if (!d) return setBody([h('div', 'dsh-fb-warn', '没有拿到数据')])
    if (d.ok !== true) {
      return setBody([
        section('状态', [h('div', 'dsh-fb-warn', d.error || '读取失败')]),
        actionsRow([{ label: '重新读取', onClick: function () { loadTab('life') } }])
      ])
    }

    var nodes = []

    // ── 顶部：现在几点 + 天气 ──
    var headBits = []
    if (d.clock) headBits.push(d.clock)
    if (d.weather) {
      var w = d.weather.text + ' ' + d.weather.tempC + '°'
      if (d.weather.feelsC != null && d.weather.feelsC !== d.weather.tempC) w += '（体感 ' + d.weather.feelsC + '°）'
      if (d.weather.stale) w += ' · 可能过期'
      headBits.push(w)
    }
    var head = h('div', null, headBits.join('　'))
    head.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:2px'
    var headSub = h('div', null, '时区 ' + (d.timezone || '—') + '　当天 ' + (d.dayKey || '—'))
    headSub.style.cssText = 'font-size:11px;opacity:.55;margin-bottom:12px'
    nodes.push(head, headSub)

    // ── 身体三维：三条横条 ──
    var c = d.circle || {}
    nodes.push(section('身体', [
      lifeBar('饱腹', c.satiety, {
        // 饥饿侧：越低越该吃。颜色按"需要关注"来配，不按数值高低。
        tone: c.satiety < 20 ? '#dc2626' : c.satiety < 50 ? '#d97706' : '#16a34a',
        note: c.satiety < 20 ? '饿了' : c.satiety < 50 ? '有点饿' : '不饿'
      }),
      lifeBar('精力', c.energy, {
        tone: c.energy < 20 ? '#dc2626' : c.energy < 45 ? '#d97706' : '#16a34a',
        note: (c.energyBase != null && c.energyBase !== c.energy)
          ? ('叠加后 ' + c.energy + '，原始 ' + c.energyBase)
          : ''
      }),
      lifeBar('性欲', c.desire, {
        tone: '#8b5cf6',
        note: c.desire >= 80
          ? (d.cycle && d.cycle.inPeriod ? '（经期中，不显示）' : '（会显示）')
          : '（低于 80 不显示）'
      }),
      (function () {
        var row = h('div', null, c.asleep === true ? '💤 正在睡' : '☀️ 醒着')
        row.style.cssText = 'font-size:11.5px;opacity:.7;padding-top:4px'
        return row
      })()
    ]))

    // ── 心情 ──
    if (d.mood) {
      var moodRow = h('div', null, d.mood)
      moodRow.style.cssText = 'font-size:15px;font-weight:600;color:#8b5cf6;padding:2px 0 6px'
      nodes.push(section('心情', [moodRow]))
    }

    // ── 生理周期 ──
    if (d.cycle) {
      var cy = d.cycle
      var cycleRows = []
      // 六期进度条：小圆点串起来，当前那期高亮
      var PHASES = [
        ['menstrual', '月经'], ['follicular', '卵泡'], ['pre_ovulation', '排卵前'],
        ['ovulation', '排卵'], ['luteal', '黄体'], ['pms', 'PMS']
      ]
      var strip = h('div')
      strip.style.cssText = 'display:flex;gap:4px;margin:6px 0 10px'
      for (var pi = 0; pi < PHASES.length; pi++) {
        var pid = PHASES[pi][0]
        var pname = PHASES[pi][1]
        var on = pid === cy.phase
        var cellEl = h('div', null, pname)
        cellEl.style.cssText = [
          'flex:1', 'text-align:center', 'font-size:10.5px', 'padding:5px 2px',
          'border-radius:5px',
          on
            ? 'background:#dc2626;color:#fff;font-weight:600'
            : 'background:rgba(127,127,127,.12);opacity:.62'
        ].join(';')
        strip.appendChild(cellEl)
      }
      cycleRows.push(strip)
      cycleRows.push(kv('当前', cy.phaseName + ' · 第 ' + cy.dayInCycle + ' / ' + cy.cycleDays + ' 天'))
      cycleRows.push(kv('距下次', cy.daysToNextPeriod + ' 天'))
      cycleRows.push(kv('该期精力偏移', (cy.energyMedian >= 0 ? '+' : '') + cy.energyMedian))
      if (cy.mark) {
        var markRow = h('div', null, cy.mark)
        markRow.style.cssText = 'font-size:12px;line-height:1.6;color:#dc2626;padding-top:4px'
        cycleRows.push(markRow)
      }
      nodes.push(section('生理周期', cycleRows))
    }

    // ── 活跃 condition ──
    var conds = Array.isArray(d.conditions) ? d.conditions : []
    if (conds.length) {
      var condNodes = []
      for (var i = 0; i < conds.length; i++) {
        var cc = conds[i]
        var card = h('div')
        card.style.cssText = [
          'padding:8px 10px', 'margin:5px 0', 'border-radius:7px',
          'background:rgba(127,127,127,.08)',
          'border-left:3px solid ' + lifeKindColor(cc.kind)
        ].join(';')
        var line1 = h('div', null, cc.label || cc.kind)
        line1.style.cssText = 'font-size:12.5px;line-height:1.5'
        var line2 = h('div')
        var bits = []
        bits.push(cc.kind)
        if (cc.energyDelta) bits.push((cc.energyDelta > 0 ? '+' : '') + cc.energyDelta + ' 精力')
        if (cc.mood) bits.push('心情 ' + cc.mood)
        if (cc.intensity != null) bits.push('权重 ' + cc.intensity)
        bits.push('剩 ' + (cc.remainMinutes >= 60
          ? Math.floor(cc.remainMinutes / 60) + ' 小时 ' + (cc.remainMinutes % 60) + ' 分'
          : cc.remainMinutes + ' 分'))
        line2.textContent = bits.join('　')
        line2.style.cssText = 'font-size:10.5px;opacity:.6;margin-top:3px'
        card.appendChild(line1)
        card.appendChild(line2)
        condNodes.push(card)
      }
      nodes.push(section('叠加状态（' + conds.length + ' 条）', condNodes))
    } else {
      var empty = h('div', null, '没有叠加状态 —— 此刻只有身体三维在起作用')
      empty.style.cssText = 'font-size:11.5px;opacity:.55;padding:4px 0'
      nodes.push(section('叠加状态', [empty]))
    }

    // ── 开关与今日记录 ──
    var f = d.flags || {}
    var flagText = []
    flagText.push(f.circle ? '身体✓' : '身体✗')
    flagText.push(f.cycle ? '周期✓' : '周期✗')
    flagText.push(f.health ? '健康✓' : '健康✗')
    flagText.push(f.sleep ? '睡眠✓' : '睡眠✗')
    flagText.push(f.discomfort ? '不适✓' : '不适✗')
    flagText.push(f.meals ? '饭点✓' : '饭点✗')
    flagText.push(f.weather ? '天气✓' : '天气✗')
    var flagRow = h('div', null, flagText.join('　'))
    flagRow.style.cssText = 'font-size:11px;opacity:.65;line-height:1.7'

    var m = d.meta || {}
    var metaRows = [flagRow]
    metaRows.push(kv('今天已掷', '不适 ' + (m.lastDiscomfortRoll || '—')
      + '　健康 ' + (m.lastHealthRoll || '—')
      + '　睡眠 ' + (m.lastSleepDay || '—')))
    if (m.lastSleepHours) metaRows.push(kv('上次睡眠时长', m.lastSleepHours + ' 小时'))
    nodes.push(section('设置与记录', metaRows))

    nodes.push(actionsRow([{ label: '刷新', onClick: function () { loadTab('life') } }]))
    setBody(nodes)
  }

  /** 一条带横条的状态维度。 */
  function lifeBar(name, value, opts) {
    opts = opts || {}
    var v = Math.max(0, Math.min(100, Number(value) || 0))
    var wrap = h('div')
    wrap.style.cssText = 'margin:7px 0'
    var top = h('div')
    top.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:4px'
    var left = h('span', null, name)
    left.style.cssText = 'font-weight:600'
    var right = h('span', null, String(v) + (opts.note ? '　' + opts.note : ''))
    right.style.cssText = 'font-size:11px;opacity:.68'
    top.appendChild(left)
    top.appendChild(right)
    var outer = h('div')
    outer.style.cssText = 'height:6px;border-radius:3px;background:rgba(127,127,127,.16);overflow:hidden'
    var fill = h('div')
    fill.style.cssText = 'height:100%;width:' + v + '%;border-radius:3px;background:'
      + (opts.tone || '#16a34a') + ';transition:width .25s'
    outer.appendChild(fill)
    wrap.appendChild(top)
    wrap.appendChild(outer)
    return wrap
  }

  /** condition 类型 → 左边色条颜色。 */
  function lifeKindColor(kind) {
    var map = {
      cycle_discomfort: '#dc2626',
      health: '#ea580c',
      sleep: '#2563eb',
      sleep_afterglow: '#0ea5e9',
      meal: '#ca8a04',
      care_warmth: '#db2777',
      cycle_recovery: '#7c3aed',
      afterglow: '#64748b'
    }
    return map[kind] || '#6b7280'
  }

  /* ---------------- toast ---------------- */

  function toast(text) {
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl)
    var cx = Math.max(80, Math.min(window.innerWidth - 80, pos.left + BALL / 2))
    var cy = Math.max(8, pos.top - 44)
    var el = document.createElement('div')
    el.className = 'dsh-fb-toast'
    el.textContent = text
    el.style.left = Math.round(cx) + 'px'
    el.style.top = Math.round(cy) + 'px'
    document.body.appendChild(el)
    toastEl = el
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      el.style.opacity = '0'
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el)
        if (toastEl === el) toastEl = null
      }, 180)
    }, 1900)
  }

  /* ---------------- ball ---------------- */

  function createBall() {
    var el = document.createElement('div')
    el.className = 'dsh-fb-ball'
    el.id = 'dsh-floatdock-ball'
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.setAttribute('aria-label', '打开 QQ 大肥鱼控制面板')
    el.title = 'QQ 大肥鱼 · 点击打开控制面板 / 拖动移动'
    el.innerHTML = ICON_BALL

    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return
      e.preventDefault()
      try { el.setPointerCapture(e.pointerId) } catch (err) {}
      drag = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top, moved: false }
    })

    el.addEventListener('pointermove', function (e) {
      if (!drag) return
      var dx = e.clientX - drag.x
      var dy = e.clientY - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
      drag.moved = true
      el.dataset.drag = '1'
      pos = clampPos(drag.left + dx, drag.top + dy)
      applyPos()
      if (open) positionPanel()
    })

    function finish() {
      if (!drag) return
      var moved = drag.moved
      drag = null
      el.dataset.drag = '0'
      if (moved) {
        savePos()
        return
      }
      // 单击直接进「QQ 大肥鱼」的控制面板，不再先弹小面板再点齿轮。
      // openSettings 内部会 closePanel()，所以不需要额外收面板。
      openQQSettings()
    }

    // 球体只服务 QQ 大肥鱼这一档；FEATURES 里按 id 找，找不到就退化成开小面板。
    function openQQSettings() {
      var target = null
      for (var i = 0; i < FEATURES.length; i++) {
        if (FEATURES[i].id === 'qq-bigfish') { target = FEATURES[i]; break }
      }
      if (!target) { togglePanel(); return }
      openSettings(target)
    }

    el.addEventListener('pointerup', finish)
    el.addEventListener('pointercancel', function () {
      if (!drag) return
      drag = null
      el.dataset.drag = '0'
      savePos()
    })

    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openQQSettings()
      }
    })

    return el
  }

  /* ---------------- boot ---------------- */

  function boot() {
    injectStyle()

    ball = createBall()
    var saved = loadPos() || defaultPos()
    pos = clampPos(saved.left, saved.top)
    applyPos()
    document.body.appendChild(ball)
    savePos()

    for (var i = 0; i < FEATURES.length; i++) syncFeature(FEATURES[i])

    // 监听器要能拆：HMR 重新导入本模块时会先卸载旧实例，
    // 不拆的话每改一次就多一份 resize/focus 回调，球也会叠一层。
    function onResize() {
      var next = clampPos(pos.left, pos.top)
      if (next.left !== pos.left || next.top !== pos.top) {
        pos = next
        applyPos()
        savePos()
      }
      if (open) positionPanel()
    }
    function syncAll() {
      for (var j = 0; j < FEATURES.length; j++) syncFeature(FEATURES[j])
    }
    function onVisibility() {
      if (document.hidden) return
      syncAll()
    }

    window.addEventListener('resize', onResize)
    window.addEventListener('focus', syncAll)
    document.addEventListener('visibilitychange', onVisibility)

    instance = {
      dispose: function () {
        try { window.removeEventListener('resize', onResize) } catch (err) {}
        try { window.removeEventListener('focus', syncAll) } catch (err) {}
        try { document.removeEventListener('visibilitychange', onVisibility) } catch (err) {}
        try { closeSettings() } catch (err) {}
        try { closePanel() } catch (err) {}
        if (ball && ball.parentNode) ball.parentNode.removeChild(ball)
        ball = null
        panel = null
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = 0 }
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl)
        toastEl = null
      },
    }
  }

  // 等 DSH 把界面真正渲染出来再挂球体。
  // 只等 DOMContentLoaded 不够 —— 那时页面还停在「HARNESS / Loading plugins...」，
  // 球体会孤零零浮在空白页上闪一下，而且那一刻 CSS 变量（--dsw-alias-*）可能还没注入，
  // 球体会先渲染成兜底色。
  //
  // ── 为什么不能靠「文案里有没有 loading plugin」判断 ─────────────────────
  // 旧实现是 `body.innerText.indexOf('loading plugin') !== -1`。这条判据有两个坑，
  // 而且**两头都会错**（实测 2026-11-18）：
  //
  //   ① 坑一：DSH 的启动提示是**本地化**的。英文环境是 "Loading plugins…"，
  //      中文界面则是别的话术，于是 `stillLoading()` 恒为 false。
  //      这时 shellReady() 只剩「元素数 > 60」一条 —— 而启动页本身也能凑够
  //      60 个元素，于是球会在**界面真正就绪之前**就挂上去。
  //
  //   ② 坑二（用户实际遇到的那个）：整个过程最慢的一步是**插件模块加载**，
  //      而这段判定要等模块执行完才跑得起来。等它跑起来时页面早已就绪，
  //      所以这条判据对「缩短等待」毫无贡献 —— 真正决定用户等多久的，
  //      是模块图和主界面渲染，不是这里的轮询。
  //
  //      更要命的是旧轮询靠 `setInterval(..., 150)` + 15 秒硬兜底，
  //      一旦判据因为文案不匹配而永不成立，就**固定等满 15 秒**才显示球。
  //      用户看到的「等了大概 10 秒」正是这一档。
  //
  // 现在的判据改成**结构化、与语言无关**：
  //   ① 启动卡片消失（DSH 启动页的 root 带 data-dsh-boot 标记，或 body 里还有
  //      `[data-dsh-boot-spinner]`）—— 这是宿主自己打的标记，不随文案变；
  //   ② 主界面骨架出现：有 `#root` 且其下元素数超过阈值；
  //   ③ 上面两条任一成立即可；并且**轮询间隔从 150ms 改 60ms**，
  //      同时一旦命中就立刻挂球，不再等多一轮。
  // 仍然保留硬兜底，但压到 5 秒 —— 超过这个时间还没就绪，宁可先显示球
  // （它只是一个浮球，浮在启动页上也不影响任何操作），也不要让人干等。
  function waitForShell(cb) {
    var MAX_WAIT_MS = 5000;      // 硬兜底：再怎么慢也 5 秒内显示
    var started = Date.now();
    var done = false;

    // 启动页是否还在：优先用宿主自己的标记，其次才退回文案（仅英文环境有效）。
    function stillLoading() {
      var body = document.body;
      if (!body) return true;
      // 宿主在启动卡片上打的标记（见 asar: dataset.dshBootSpinner）
      if (body.querySelector('[data-dsh-boot-spinner]')) return true;
      if (body.querySelector('[data-dsh-boot]')) return true;
      // 兜底：英文环境下的文案。**不作为唯一依据** —— 中文界面匹配不到，
      // 靠它判断会出现「永远 loading」或「过早就绪」两种错。
      var txt = (body.innerText || '')
      return txt.indexOf('Loading plugins') !== -1
    }

    // 界面接管判定：主界面骨架已经出现。
    function shellReady() {
      var body = document.body;
      if (!body) return false;
      var root = document.getElementById('root')
      // 启动卡片还在 = 还没就绪（无论文案是什么语言）
      if (body.querySelector('[data-dsh-boot-spinner]') || body.querySelector('[data-dsh-boot]')) return false;
      // 主界面挂载后 #root 里会有较多元素；只用数量做个宽松下限
      var host = root || body
      return host.getElementsByTagName('*').length > 60
    }

    function finish() {
      if (done) return;
      done = true;
      cb();
    }

    var timer = setInterval(function () {
      var elapsed = Date.now() - started;
      if (shellReady()) { clearInterval(timer); finish(); return; }
      if (elapsed > MAX_WAIT_MS) { clearInterval(timer); finish(); }
    }, 60);
  }

  function apply() {
    // 正常刷新页面时这里是干净的环境；但插件被热更新（HMR）时，
    // 同一个页面会再执行一次本模块 —— 旧版本要是直接 return，
    // 球和面板就一直是旧代码画的，改了也看不见，只能自己 Ctrl+F5。
    // 所以这里改成「先卸旧的，再挂新的」。
    var previous = window.__dshFloatDock
    if (previous && previous.dispose) {
      try { previous.dispose() } catch (err) {}
    }
    window.__dshFloatDock = {
      get dispose() { return instance && instance.dispose },
      version: 'status-thinking-4',
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { waitForShell(boot) })
    } else {
      waitForShell(boot)
    }
  }

  exports.name = 'qq-dsh-panel'
  exports.inject = []
  exports.apply = apply

  // 版本戳：刷新页面后在控制台看到这行，说明浏览器加载的是**这一版** client.js。
  // 看不到就是拿到了缓存/旧模块，需要 Ctrl+F5 或重启 DSH。
  try {
    console.info('[qq-dsh-panel] client build status-thinking-5 · tabs=' + TABS.length
      + ' · hasSelf=' + (typeof renderSelfTab === 'function'))
  } catch (err) {}

  return module.exports
  },
})
