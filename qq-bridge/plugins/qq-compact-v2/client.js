// qq-compact-v2 —— client 端：让 /compact-v2 出现在输入框的斜杠菜单里。
//
// ── 为什么必须有这个文件 ───────────────────────────────────────────────────
//
// 只注册 host 端 `ctx.commands` 是不够的：命令能被执行，但**输入框敲 "/"
// 的菜单里看不到它**。要让命令出现在菜单里，必须有客户端插件。
//
// 这是照抄 dsh-inject 的做法（它在同一台 DSH 上是能用的）：
//
//     // dsh-inject/lib/client.js 末尾
//     var inject = ["slots", "configForms", "commandUi"];
//     function apply(ctx) {
//       ...
//       ctx.effect(() => ctx.commandUi.decorate({
//         name: COMMAND,                     // ← host 端注册的命令名
//         available: () => true,
//         ui: { kind: "action", run: (session) => dialogs.open(...) }
//       }));
//     }
//
// 关键点：
//   · 这个文件是 **client bundle**，由 package.json 的 `dsh.client` 声明
//   · 它包在 `window.__ModuleLoader__.load({ id, factory })` 里
//   · `inject` 里要 `commandUi`
//   · `commandUi.decorate({ name, available, ui })` 把菜单项挂到已有命令上
//
// `ui.kind` 的选择：
//   · `"action"` —— 点击后调用 `run(session)`，不把文本塞进输入框
//   · 我们不需要弹窗，只需要"点了之后执行命令"，所以用 action 直接把
//     命令行写进输入框并提交
//
// 保守做法：不弹任何 UI，只把 `/compact-v2` 填进输入框，让用户自己回车确认
// —— 因为压缩是不可逆操作，不适合"点一下就执行"。

window.__ModuleLoader__.load({
  id: 'qq-compact-v2',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    /** host 端注册的命令名（必须与 index.js 里 ctx.commands.register 的 name 一致）。 */
    const COMMAND = 'compact-v2';

    const inject = ['commandUi'];

    function apply(ctx) {
      // 把菜单项挂到 /compact-v2 上。
      // 注意：host 端已经注册了同名命令，这里只是给它补一个菜单入口。
      ctx.effect(() => ctx.commandUi.decorate({
        name: COMMAND,
        // 所有会话都可用（压缩对任何会话都成立）。
        available: () => true,
        ui: {
          kind: 'action',
          // 不直接执行 —— 压缩不可逆，只把命令填进输入框让用户自己确认。
          run: (session, host) => {
            try {
              host?.input?.fill?.(`/${COMMAND}`);
              host?.input?.focus?.();
            } catch {
              /* 填不进去就算了，用户手打也行 */
            }
          },
        },
      }), 'qq-compact-v2: slash menu entry');
    }

    Object.assign(exports, { name: 'qq-compact-v2/client', inject, apply });
    return module.exports;
  },
});
