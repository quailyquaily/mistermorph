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
| `lib/mobileHost.ts` | The contract answered inside the app on Android (no embedding app): saved values, the server address, the photo picker, voice input and task notifications through the native part |
| `android/src` | The Android app's own Java, built into the APK's classes.dex (`scripts/android-host.sh`): the microphone behind `morph.voice.*` (`MorphApplication`, `VoiceController`) and the background task notifications behind `morph.notify.*` (`TaskNotifier`, `TaskNotifierJob`) |
| `pages/login/ServerDialog.tsx` | The Android app's console server: entered on the login page, checked before it is saved |
| `lib/core/*.js` | Logic from `web/console/src/core`, nearly verbatim. Change as little as possible |
| `lib/stores/*.js` | The Pinia stores on nsh signals, same API (`authState.token`, `endpointState.items`) |
| `lib/i18n/index.js` | The Vue console's strings, unchanged: `translate(key, vars)` |
| `lib/router.ts` | Routes, the guard, `navigate()`, `currentRoute()`, `setLeaveGuard()` |
| `lib/shell.ts` | The frame's state: endpoints, nav items, mobile breakpoint |
| `lib/systemBack.ts` | Android's Back (button and edge swipe): `onSystemBack` for a screen's own back, then the history |
| `lib/softKeyboard.ts` | Whether the software keyboard is up; a phone back arrow lowers it before it leaves |
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
node --test scripts/android-manifest.test.mjs # what the APK's manifest adds
scripts/android-host.sh test                  # the Android native part on the JDK
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
- `List` tells the items of `each` apart by identity (`===`), not by `keyExtractor`: an item
  replaced by a new object (`{ ...item, text }`) is one removed and one inserted, its measured
  height goes back to `estimatedItemSize`, and the place the list keeps on screen goes with it. A
  list whose items are updated by copy gets their ids and looks each one up in its row
  (`ChatHistoryList`; docs/console/chat-scroll-anchoring.md).
- An inverted `List` keeps its distance from the end, and moves nothing for a row across the
  viewport's bottom edge: a reply growing there pushes what is on screen up. The chat's list is
  not inverted: `maintainVisibleContentPosition` follows the end, and is off while scrolled up,
  since nsh 0.4's compares its old end with an offset already moved for rows that changed above
  the viewport (an older page taller than the way back to the bottom sent the reader there).
- Headless (`nsh test`), a list's own scroll corrections are not reported back: `measure()` and
  `onScroll` lag until the next scroll. Scroll by a point and back before reading positions
  (`tests/chat-scroll-anchor.test.tsx`).
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
- Android draws no masks at all: its prebuilt runtime parses `maskImage` but never passes it to the
  Java views that draw, and no blend mode erases. `FadeText` fades there by drawing the letters
  under the fade as texts of their own at the mask's alpha (`components/motion/glyphFade.ts`); a
  new masked fade on Android needs the same, or nothing fades.
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
- The base `Editor`'s rows take presses only over the text: its `content` padding and, with
  `scrollBeyondLastLine={false}`, the room below the last line take none (no focus, no caret). And
  the app-wide hover-mode scroll bars (`Scrollbar.setTheme(SCROLLBAR)`) give its hidden one-point
  caret field (a multiline input) a bar of its own: invisible, 8pt wide, over the 7pt left of the
  caret, taking presses on the desktops, so the second click of a double click and a drag begun at
  the caret go to it. `MarkdownEditor` puts a pressable view around the Editor that places the caret
  for those presses (`components/shared/editorPresses.ts`); a new Editor elsewhere needs the same.
  A drag that view begins must also end on `onMouseLeave`, not only on `onPress` and button-less
  moves: a button released outside is never seen, and a later drag pressed outside and moved in
  would resume the old one. `onPressUp` is no release signal: on the web a press that moves 10pt
  ends there (`onPressUp` without `onPress`), at the start of every drag.
- `role="none"` on a pressable view is still a `button` on the web (0.4.0): give a pressable that is
  not a control `role="group"`.
- Headless screenshots catch compositor fades part-way (a tooltip looks half transparent): run a
  `frames` step before the shot.
- A multiline `Input` draws its first line at the top of its content box, and the height
  `onContentSizeChange` reports is the platform's measure (headless runs ignore `lineHeight`: 17pt
  for a 22.12pt line). A field that must centre one line beside other controls gets a fixed box
  with the line placed from `lineHeight`, not padding around the measured height
  (`components/chat/composerField.ts`).
- A layout decided from an `Input`'s measured height must not change the width it was measured at,
  or it feeds back on itself. Measure at the widths the layout can take with hidden copies of the
  input instead (`components/chat/ComposerMeasure.tsx`). Hide them with `invisible`: on the web,
  `focusable={false}`, `readonly` and `disabled` leave the `textarea` in the browser's Tab order
  (Shift+Tab reached them), while `visibility: hidden` keeps the layout and drops the focus. Two
  inputs laid out together report `onContentSizeChange` one after the other (a microtask between
  them does not merge them), before the next frame is drawn. Headless runs measure a line break
  as no break. `onContentSizeChange` fires only when the size changes, so a report alone cannot
  say which value it measured: tag each with the value, take the heights as current a couple of
  frames after a value that reported nothing, and keep the layout while they are older than the
  value (`composerRows.ts`). Two inputs measuring one value report it one after the other: the
  first report is not the value's last, so treat the value as settled only after those frames.
- `LayoutAnimation.configureNext` on the web eases each view's `left`/`top`/`width`/`height`, so an
  `Input` whose width eases reflows its text on the way (it shows the widths in between). Let a
  change of width snap and ease only heights. The ease takes every frame change of the next commit,
  including ones the code did not mean to animate: a layout the core has not drawn yet (a snapped
  change made a frame earlier), or a resize's widths when the eased change answers a resize. Ease
  only changes an edit made, once the previous change has been drawn (`followComposerLayout` in
  `components/chat/composerRows.ts`).
- A multiline `Input` wraps its placeholder as it wraps text, and nothing cuts it to one line: a
  long one runs onto lines the box does not show (no ellipsis) and, on the web, the empty field
  scrolls to them. The composer draws its placeholder as a one-line `Text` over the field and
  leaves the field's own one transparent (`components/chat/ComposerFieldSlot.tsx`). Keep the
  field's: on the web an `Input`'s accessibility props (`accessibilityLabel`, `accessibilityHint`)
  go to the view around the `textarea`, so its placeholder is the textarea's only accessible name.
- A pull down from a list's top is the scroll view's own pull-to-refresh (`onRefresh` with
  `refreshIndicator={{ height }}`: no spinner, the platform decides the gesture, short and empty
  lists included). Touch handlers on the list would not do: the scroll view takes the touches over
  from JS (`onTouchCancel`) once it drags. A released pull leaves the refresh on (the indicator's
  room kept above the content) until the app sets `refreshing` true and then false in a later
  turn. Topics' and Contacts' phone searches use it (`components/shared/pullSearch.ts`).
- There is no DOM drag and drop: a drag inside the app is a `PanResponder` (`onMoveShouldSet…`
  past a few points, so a click stays a press; taking the gesture cancels the press under it), and
  where it is comes from `measure()` of the view whose children's `onLayout` frames are compared
  (`pages/chat/topicDrag.ts`). A view added to an ancestor of the responder mid-gesture ends the
  gesture silently (no more moves, no release, no terminate): draw drop marks in views that are
  there from the start and only restyle them.
- On the web every nsh `Scroll` contains its overscroll (`.nsh-scroll`: `overscroll-behavior:
  contain`, no prop to change it), even one that cannot scroll: a vertical touch swipe that starts
  on a sideways scroller inside a vertical one does not scroll the outer one (chat code blocks do
  this). Progress and coder runs that do not wrap are a plain row while they fit and a sideways
  scroller only while they overflow (`components/chat/OverflowLine.tsx`).
- Shared motion helpers (sliding selection, fade truncation, scroll edges, entrances, dialog
  origin) are in `components/motion/` (see its README).
- A dialog stays drawn while it goes out, and its text field keeps the focus that long: keys typed
  then landed in the closed dialog's field, and a phone's keyboard stayed up. A dialog with a field
  blurs it and lowers the keyboard as it closes, and focuses it as it opens
  (`components/shared/dialogFieldFocus.ts`). A one-line `Input` blurs itself on Enter
  (`blurAndSubmit`): a dialog that stays open when its Enter fails passes `submitBehavior="submit"`.
  Headless runs settle the closing motion before the next step, so none of this shows there; test
  it on the helper.

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
  `keyboardFrame().height` (`bottomSheetStyle`'s `keyboard`).
- Those sheets (`Menu`, `Select` and `DatePicker`'s calendar; not `Popover`, which stays at its
  trigger) cover the surface down to its bottom edge, and nsh pads them with nothing: their last
  row lies under the navigation bar or gesture handle (iOS's home indicator too). Give every such
  `popupStyle` `bottomSheetStyle(padding, { style, contentMax })` (`components/ui.tsx`): the bottom
  inset under the popup class's own bottom padding (an inline `paddingBottom` replaces it, so pass
  it), its `max-h-*` grown by the inset, the keyboard's height instead of the inset for a sheet
  that rises, and the desktops' popups unchanged. nsh's `Menu` sheet does not scroll: a long menu
  needs a `Scroll` of its own (`AgentSwitcher`, `SelectField`).
- Dialogs are an `Overlay` on Android (`DialogLayer`): with it Back hides the keyboard first, then
  closes the dialog.
- A phone bar's back arrow does not hide the keyboard by itself: the chat's arrow calls
  `dismissSoftKeyboard` (`lib/softKeyboard.ts`) first and goes back only when nothing was up. On
  Android trust `keyboardFrame()` from the start (the host reads the system's keyboard insets); a
  focused field alone may have a hardware keyboard. On the web trust it once it has reported a
  keyboard; before that the focused field stands for the keyboard. Headless runs report no frame,
  so a headless Android phone with a focused field is one with a hardware keyboard.
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
- nsh/base's `Sheet` is such an overlay: the frame's padding does not reach it, and its panel runs
  under the status bar unless it is padded. The chat's phone panel (`WorkspaceSheet`) pads its
  popup with `rightSheetInsets` (`lib/systemInsets.ts`); a new sheet at a side does the same, never
  adding the frame's inset on top.
- The packaged app gets no `usesCleartextTraffic`, and its `fetch` goes through HttpURLConnection,
  which then refuses `http://`: `scripts/build-android.sh` runs `nsh package` with an SDK whose
  `aapt2` adds it, for console servers on the local network.
- 0.4.0 has the photo picker but no `Picker.pickFiles` and no `Notifications`: the Android app
  attaches images only. Avatars (crop and re-encode) and saving files are not available there yet;
  they say so. Task notifications come from the app's own Java (a JobScheduler job reading
  `/api/notifications/events` while the app is away: the page, and its socket, are suspended then);
  see `docs/feat/feat_20261110_android_task_notifications.md`.
