# The Mister Morph console in nsh

One TSX app (nsh 0.4.0, Native Shell) that builds as the web console (`scripts/build-web.sh`, served by
`console serve --console-static-dir`) and as the desktop app (`desktop/nsh`, a GPUI shell that embeds
it and runs the backend). It reimplements `web/console` (Vue) screen for screen; `web/console/src`
stays the reference for behaviour, states and copy until the cutover.

## Layout

| Path | What |
| --- | --- |
| `App.tsx` | Boot (host data, session, language), router start, the frame |
| `host.js` | The web page's host: answers `morph.*` in the browser (address bar, storage, files, notifications) |
| `lib/platform.ts` | The `morph.*` host contract. The only file that knows a host exists |
| `lib/core/*.js` | Logic from `web/console/src/core`, nearly verbatim. Change as little as possible |
| `lib/stores/*.js` | The Pinia stores on nsh signals, same API (`authState.token`, `endpointState.items`) |
| `lib/i18n/index.js` | The Vue console's strings, unchanged: `translate(key, vars)` |
| `lib/router.ts` | Routes, the guard, `navigate()`, `currentRoute()`, `setLeaveGuard()` |
| `lib/shell.ts` | The frame's state: endpoints, nav items, mobile breakpoint |
| `components/ui.tsx` | The design system: Button, TextField, Toggle, SelectField, DropdownMenu, Modal, MessageDialog, confirm, Badge, Section, Page, Markdown, Icon, ... |
| `components/icons.ts` | The Phosphor icons the console uses, by their Vue names (`PhChats`) |
| `components/Shell.tsx` | Sidebar, mobile bottom nav, notice stack |
| `pages/<area>/` | One folder per screen; `pages/routes.tsx` maps routes to pages |
| `tests/harness.ts` | `openConsole({ location, api })`: the app with a fake host and a stubbed console API |

## Rules (nsh is not Vue)

1. **A component body runs once.** Read props and signals inside JSX, `computed` or `effect`; never
   destructure props. To follow the route, read `currentRoute()` in a binding or an effect.
2. **All text is inside `<Text>`.** No DOM, no CSS files, no `<a>`, `<form>`, `window`, `document`,
   `localStorage`. Layout is flexbox; a `View` is a column (`flex-row` for a row).
3. **Signals propagate synchronously.** Several writes that belong together go in `batch(...)`.
   Arrays and objects are replaced, never mutated (`list.update((l) => [...l, x])`).
4. **Never pass a signal's method detached** (`onChange={x.set}` breaks on QuickJS): write a closure.
5. **Lists that grow use `List`** (virtualized); its row keeps no state of its own: per-item state is
   data keyed by id. `Each` with a `key` for small, bounded lists. `If` (with `else`), not `&&`, for
   anything bigger than a leaf.
6. **Use `components/ui.tsx`.** Theme tokens only (`text-muted-foreground`, `bg-card`, `border-line-faint`,
   `text-danger`, `bg-selection`); never hex or palette classes. Missing a control? Build it in your
   area's `components/<area>/` from `nsh/base` and say so in your report; do not edit `ui.tsx`.
7. **Overlays are `nsh/base`'s** (`Dialog` via `Modal`/`MessageDialog`, `Menu` via `DropdownMenu`,
   `Popover`, `Select`, `Tooltip` as the `tooltip` prop). Desktop child windows of the Wails app become
   in-app dialogs.
8. **Browser features go through `lib/platform.ts`**: `copyText`, `pickFiles`/`uploadFile`, `saveFile`,
   `openExternal`, notifications, `localStore`/`sessionStore`, desktop calls. A file is a `PickedFile`
   (its bytes stay in the host).
9. **Requests use the copied helpers** (`apiFetch`, `runtimeApiFetchForEndpoint`, `endpointApiFetch`
   from `lib/core/context.js`) so auth, proxying and 401 handling stay as they were. WebSocket URLs come
   from `buildConsoleStreamURL`; `WebSocket` is a global.
10. **Do not swallow errors** silently: `console.warn` at least, and show what the Vue page showed.
11. **Copy is the Vue page's:** reuse its `t(...)` keys. Add a key to all three locales in
    `lib/i18n/index.js` only when no key fits (tell the integrator).
12. **If something cannot be ported, say so in your report.** Never leave a control that looks done
    and does nothing.

`nsh check` passes on any class string; `nsh build` warns on unknown classes. Read both.

## Checks

```sh
node scripts/generate.mjs                     # after changing assets/config or icon folders
nsh check                                     # types (the only type check)
nsh build                                     # bundler: unknown classes, text in a View
nsh test tests --web-host tests/noHost.js     # headless tests; one file: tests/x.test.tsx
node --test lib/core/*.test.mjs               # the copied pure logic
scripts/build-web.sh /tmp/site                # the web site for console serve
```

Look at the result: `console serve --console-static-dir /tmp/site` and a browser, or the desktop app.
Headless tests prove behaviour, not the look.
