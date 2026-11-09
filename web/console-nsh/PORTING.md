# The Mister Morph console in nsh

One TSX app (nsh 0.4.0, Native Shell) that builds as the web console (`scripts/build-web.sh`, served by
`console serve --console-static-dir`), as the desktop app (`desktop/nsh`, a GPUI shell that embeds
it and runs the backend) and as the Android app (`scripts/build-android.sh`, a client of a console
server elsewhere). It reimplements `web/console` (Vue) screen for screen; `web/console/src`
stays the reference for behaviour, states and copy until the cutover.

## Layout

| Path | What |
| --- | --- |
| `App.tsx` | Boot (host data, session, language), router start, the frame |
| `host.js` | The web page's host: answers `morph.*` in the browser (address bar, storage, files, notifications) |
| `lib/platform.ts` | The `morph.*` host contract. The only file that knows a host exists |
| `lib/mobileHost.ts` | The contract answered inside the app on Android (no embedding app): saved values, the server address, the photo picker |
| `pages/login/ServerDialog.tsx` | The Android app's console server: entered on the login page, checked before it is saved |
| `lib/core/*.js` | Logic from `web/console/src/core`, nearly verbatim. Change as little as possible |
| `lib/stores/*.js` | The Pinia stores on nsh signals, same API (`authState.token`, `endpointState.items`) |
| `lib/i18n/index.js` | The Vue console's strings, unchanged: `translate(key, vars)` |
| `lib/router.ts` | Routes, the guard, `navigate()`, `currentRoute()`, `setLeaveGuard()` |
| `lib/shell.ts` | The frame's state: endpoints, nav items, mobile breakpoint |
| `lib/systemBack.ts` | Android's Back (button and edge swipe): `onSystemBack` for a screen's own back, then the history |
| `lib/systemInsets.ts` | The room Android's status and navigation bars take: the frame's, the bottom nav's, the dialogs' |
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

## Traps found while matching the Vue console

- `leading-[1.4]` (a unitless line height) does not render as size × 1.4: write points, `leading-[19.6px]`.
- Opacity modifiers on the app's own colour tokens (`bg-paper/70`) do nothing: add a token to
  `theme.json` (`paper-soft`, `card-soft`) instead.
- `style={{ display: "flex" }}` turns a View into a row.
- On an inverted `List`, `scrollToEnd()` goes to the oldest item (nsh 0.4.0): use
  `scrollToIndex({ index: 0 })` to show the newest.
- `lifecycle()` from `nsh` breaks the whole page on the web runtime (0.4.0).
- A page loaded in a hidden browser tab gets no frames, so animated values stall part-way until
  the tab is shown; take screenshots from a visible tab.
- Headless Chrome reports no hover and no fine pointer, so nsh lays the app out in its tablet
  idiom. Launch it with
  `--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2`
  for desktop screenshots.
- Masks (`maskImage`): the web draws them; upstream GPUI ignores them, and the desktop shell's
  patched copy (`desktop/nsh/patches/nsh-gpui-masks.patch`) fades text glyphs under a linear mask
  (not fills or images). For a cut-out of anything but text, draw on a `Canvas`
  (`components/shared/CutoutAvatar.tsx`).
- Repeating gradients work, though the docs don't say so: `backgroundImage:
  "repeating-linear-gradient(135deg, <c> 0 2px, transparent 2px 5px)"` (hatching, the paper grid in
  `Shell`). Put them in `style` (Tailwind arbitrary values can't hold the spaces).
- nsh/base's indeterminate `Progress` neither sizes nor moves its indicator: left alone it fills the
  track and stands still (a dash). `Spinner` and `LoadingLine` (ui.tsx) animate their own segment.
  A loading `Button` draws the ui-kit's moving stripe over itself, not a spinner beside its label.
- nsh/base's `Button` drops the `tooltip` prop: a button with a tooltip is `TipButton` (ui.tsx),
  which puts the tooltip on a view around it and gives that view the button's placement classes
  and `onLayout`.
- nsh/base's `Select` opens its list over the field on the web (`placement` is ignored there):
  `SelectField` is a `Menu` below the field, as Vue's dropdown; only the searchable one is a Select.
- A `TextView` table can't be narrower than column floors nsh estimates from character counts
  (about 0.55em a letter plus 2rem), not measured: on phones a table Vue fits may scroll sideways.
- Canvases draw with animated values natively (`createAnimatedValue` in coordinates, alphas,
  dashes): the route map's draw-in and traffic run without JS per frame.
- `position: "sticky"` works in a `Scroll`; the base `Editor` colours ranges through decorations.
- Headless screenshots catch compositor fades part-way (a tooltip looks half transparent): run a
  `frames` step before the shot.
- Shared motion helpers (sliding selection, fade truncation, scroll edges, entrances, dialog
  origin) are in `components/motion/` (see its README).

### Android (nsh 0.4.0)

- A pressable view that clips (`overflow-hidden`) and casts an outer shadow never gets its presses:
  the runtime moves its children into an inner box that takes them. `Button` drops its shadow on
  Android; do not combine the two on anything pressable.
- Android gives a touch that no view takes to the views behind it: the dialog's scrim heard presses on
  the panel's padding. The scrim ignores presses inside the panel's frame.
- Neither the surface nor a dialog shrinks when the software keyboard opens. The app's root and the
  dialog layer add `keyboardFrame().height` as bottom padding. Not `env(keyboard-inset-height)`:
  it moves views natively but not in the layout presses are matched against.
- On touch screens nsh/base's `Menu` and `Select` are sheets at the bottom of the screen (their
  `placement` is the desktops'), and opening one does not take the focus from a text field: a
  sheet opened from beside a focused field lies under its keyboard. The composer's add menu and
  model picker call `Keyboard.dismiss()` as they open and focus the field again as they close
  (`components/chat/ChatComposer.tsx`); a sheet with a field of its own rises by
  `keyboardFrame().height` (`components/chat/composerSheets.ts`).
- Dialogs are an `Overlay` on Android (`DialogLayer`): with it Back hides the keyboard first, then
  closes the dialog.
- Back (the button, and the edge swipe of gesture navigation, which the system turns into the same
  event) reaches the app only while it listens (`BackHandler`); otherwise the system leaves the app.
  `lib/systemBack.ts` listens only while there is something to go back to: a view registered with
  `onSystemBack` (a page whose phone layout has its own back arrow registers what the arrow does;
  `MobileBar` does it for its users), else the run's history, which `lib/mobileHost.ts` keeps and
  the router hears as a browser's back. A new phone detail view with a back arrow registers too.
- The surface runs under the status bar and the navigation bar (nsh draws Android edge to edge;
  `safeArea()` has their sizes). The app's frame takes them once (`lib/systemInsets.ts`): pages and
  their 57pt bars need no inset of their own, and `env(safe-area-inset-*)` must not be added inside
  the frame on Android. Overlays cover the whole surface and take the insets themselves.
- The packaged app gets no `usesCleartextTraffic`, and its `fetch` goes through HttpURLConnection,
  which then refuses `http://`: `scripts/build-android.sh` runs `nsh package` with an SDK whose
  `aapt2` adds it, for console servers on the local network.
- 0.4.0 has the photo picker but no `Picker.pickFiles` and no `Notifications`: the Android app
  attaches images only and shows no system notifications. Avatars (crop and re-encode) and saving
  files are not available there yet; they say so.
