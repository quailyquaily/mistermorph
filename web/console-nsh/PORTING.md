# The Mister Morph console in nsh

One TSX app (nsh 0.6.0, Native Shell) that builds as the web console (`scripts/build-web.sh`, served by
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
| `lib/mobileHost.ts` | The contract answered inside the app on Android (no embedding app): saved values, the server address, the pickers (Gallery: the photo picker; File: the document picker), voice input and task notifications through the native part |
| `android/src` | The Android app's own Java, built into the APK's classes.dex (`scripts/android-host.sh`): the microphone behind `morph.voice.*` (`MorphApplication`, `VoiceController`), the background task notifications behind `morph.notify.*` (`TaskNotifier`, `TaskNotifierJob`) saving files behind `morph.file.save` (`FileSaver`, `SaveDocumentActivity`) and whether a hardware keyboard is connected behind `morph.keyboard.state` (`HardwareKeyboard`, `AndroidHardwareKeyboard`), which the keyboard shortcuts need on a phone (`lib/shortcutPolicy.ts`) |
| `pages/login/ServerDialog.tsx` | The Android app's console server: typed on the login page or read from a QR code, checked before it is saved |
| `pages/login/QrScanner.tsx`, `lib/qrScan.ts`, `lib/qrScannerPage.js` | The QR scanner: a web view whose page has the camera and the decoder, the app's side of a scan, and the page |
| `lib/core/*.js` | Logic from `web/console/src/core`, nearly verbatim. Change as little as possible |
| `lib/stores/*.js` | The Pinia stores on nsh signals, same API (`authState.token`, `endpointState.items`) |
| `lib/i18n/index.js` | The Vue console's strings, unchanged: `translate(key, vars)` |
| `lib/router.ts` | Routes, the guard, `navigate()`, `currentRoute()`, `setLeaveGuard()`, the last committed `navigation()` |
| `lib/navMotion.ts` | Which way a navigation moves (further in, back, the navigation's order); `lib/navOrder.ts` is that order |
| `lib/core/resource-cache.js`, `lib/cache.ts`, `lib/cacheFiles.ts` | The pages' last answers, shown while a page asks again: in memory everywhere, on disk in the phone apps. Pages use `peekResource` / `readResource` / `writeResource` from `lib/core/resources.js` (docs/feat/feat_20261120_console_local_cache.md) |
| `lib/scrollMemory.ts` | Where a page's columns were scrolled, in memory only: `useScrollMemory({ column, area, selection, ready })` on a page's `Scroll` or `List` (docs/console/scroll-memory.md) |
| `lib/shell.ts` | The frame's state: endpoints, nav items, mobile breakpoint |
| `lib/systemBack.ts` | Android's Back (button and edge swipe): `onSystemBack` for a screen's own back; a screen without one takes none |
| `lib/softKeyboard.ts` | Whether the software keyboard is up; a phone back arrow lowers it before it leaves |
| `lib/systemInsets.ts` | The room Android's status and navigation bars take: the frame's, the bottom nav's, the dialogs' |
| `components/ui.tsx` | The design system: Button, TextField, Toggle, SelectField, DropdownMenu, Modal, MessageDialog, confirm, Badge, Section, Page, Markdown, Icon, ... |
| `components/icons.ts` | The Phosphor icons the console uses, by their Vue names (`PhChats`) |
| `components/Shell.tsx` | Sidebar, mobile bottom nav, notice stack |
| `components/frame/PageStack.tsx` | The page host: a layer per page instance and the slide between two (docs/console/page-transitions.md) |
| `pages/<area>/` | One folder per screen; `pages/routes.tsx` maps routes to pages |
| `pages/ui-components/` | The UI component gallery, a testing page at `/ui-components` with no navigation entry: every component from synthetic data (docs/console/ui-components.md). A new component goes in its `inventory.js` |
| `tests/harness.ts` | `openConsole({ location, api })`: the app with a fake host and a stubbed console API |

## Rules (nsh is not Vue)

1. **A component body runs once.** Read props and signals inside JSX, `computed` or `effect`; never
   destructure props. To follow the route, read `currentRoute()` in a binding or an effect: inside a
   page it is that page's own route, which stops following once the page slides out (shell code
   reads `route()`).
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
scripts/test.sh                               # headless tests, the files several at a time (about 3 minutes)
nsh test tests/x.test.tsx --web-host tests/noHost.js  # one file
node --test lib/core/*.test.mjs               # the copied pure logic
node --test components/todo/*.test.mjs        # the job calendar's grouping and folding rules
node --test scripts/ui-components-inventory.test.mjs  # every component is in the gallery's inventory
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
- (Up to nsh 0.5.0; 0.5.1 disposes it, `tests/list-empty-slot.test.tsx`.) A `List`'s `empty` slot
  given as a function rendered in a scope nsh never disposed: the
  signals its view reads keep it alive after the list has gone, rendering into the dead list each
  time they change. Leaked like that by every Contacts page left, an `If` on the store's loading flag
  hung the Android app after about ten Contacts / TODO round trips. Give `empty` an element made in
  the component that renders the list (`pages/contacts/ContactsPage.tsx` `IndexList`): it goes with
  the list and still comes and goes as the list empties (`tests/list-empty-slot.test.tsx`). `header`,
  `footer` and the rows are disposed as they should be. Do not switch views with an `If` inside
  that element: once the list has hidden it (rows came) and shown it again, the `If` no longer
  switches, so a reload that ended empty kept the loading blocks instead of the note. Keep the views
  in it and hide the ones not wanted with a wrapping `View`'s `hidden`; their props still update
  (`tests/contacts-empty-reload.test.tsx`).
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
- A scroller whose content no longer reaches its offset is pulled back with a scroll report (rows
  going as a page leaves, a list emptied by a reload): to the content's end headless, to the top in
  a browser. And a browser puts a scroller back at its top, with no report at all, when its page's
  view is moved (nsh orders siblings by `zIndex` by moving them: the page host as a slide ends).
  `lib/scrollMemory.ts` takes neither for the reader's scroll (docs/console/scroll-memory.md).
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
- A button shows text or a glyph, never both: `Button` given an `icon` is a square icon button and
  its `label` is its accessible name and tooltip, not drawn (docs/console/ui-components.md). In a
  test, a bare selector (`app.press("Save")`) still finds it by that name, so it does not show
  whether the label is drawn: read `app.texts()` for that; a tooltip's text is in `app.texts()`
  about half a second after `app.hover`.
- nsh/base's `Button` drops the `tooltip` prop: a button with a tooltip is `TipButton` (ui.tsx),
  which puts the tooltip on a view around it and gives that view the button's placement classes
  and `onLayout`.
- nsh/base's `Menu` (and so `DropdownMenu`) opens on a press of its trigger's outer view. A
  `Button`/`TipButton` trigger keeps every press for its inner button, and the menu never opens
  (seen headless on desktop and Android, and in Chrome): give menus a plain `role="button"` view
  (`MenuIconTrigger`, ui.tsx) and pass `disabled` to the `DropdownMenu`. On the web Enter/Space on
  a focused trigger open it and Escape closes it with the focus back on the trigger, but its items
  take no arrow keys.
- On the desktop app (GPUI, nsh 0.5.0), `MenuItem`s inside a `Scroll` in a `Menu` take no clicks
  under the console's scroll bar theme (`Scrollbar.setTheme(SCROLLBAR)`, App.tsx): that scroll
  view's built-in hover bar leaves them dead, while items outside it work. Chrome and headless tests
  never show it (headless presses do no hit test). `scrollbar={false}` on that `Scroll` brings the
  clicks back; the agent switcher left the menu for `PopoverPicker`, whose rows took every click
  in a GPUI window with the theme on.
- `Tabs` (ui.tsx) gives each option `role="tab"`, but every option is a Tab stop of its own and
  arrow keys do nothing. Its options are pressable views, not nsh/base `Button`s: a base Button
  reports no `onFocus`, and a browser leaves a Tab-focused option that is partly scrolled out as it
  is, so the strip brings the focused option in itself (headless runs scroll it in either way, so
  only Chrome tells). Options that do not fit scroll sideways at their own widths: a plain row while
  they fit, a scroller only while they overflow (the scroller trap below), the current option kept
  in view by `scrollTo` from the options' measured frames (`components/shared/tabStrip.ts`). A
  mouse never drags a scroll view, so the strip follows `onMouseMove` with the button held after a
  press on an option (`tests/tab-strip.test.tsx`; mouse drags have no headless step). nsh/base's `Tabs` and `Tab` (0.5.0) are WAI-ARIA's tab list: one Tab stop
  at the selected tab, Left/Right/Up/Down/Home/End move the focus and select (each `Tab` reports
  `onPress`), `aria-selected` on the current one (seen in Chrome). A `Tab` takes no `hitSlop`: size
  it for touch. The Contacts tabs put their tooltips on a view around each tab, as `TipButton` does
  for `Button`, and style the tab's children under `group`: `group-selected:`, `group-hover:`,
  `group-active:` and `group-focus-visible:` all work (seen in Chrome). They draw the Topics head's
  round toggles (`circleButtonClass`, the blue tint while selected) on a circle inside each tab, so
  a phone's 44pt tab keeps a 38pt circle, and the column head's bottom hairline sags under the
  current one (IndexColumn's `sag`) (`pages/contacts/ContactKindTabs.tsx`).
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
- A `Text` in a flex row is at least as wide as its longest word (its min-content), so one long
  word (a path, a token) widens the row and everything around it. With `min-w-0` (and `flex-1`)
  it takes the room left instead, and nsh breaks a word longer than a line between characters.
  On the web a line may also break where one span's style ends and the next one's begins, so a
  mark that must stay beside a text's first line (a command's `$`) goes in a column of its own,
  not in the text (`ParamRow` in `components/chat/ChatStatusCard.tsx`).
- `flex-1` is a share of the row on a wide window but, in a column (the same views stacked on a
  phone), a share of the column's height: nsh lays out as React Native does, with no
  `min-height: auto`, so stacked `flex-1` cards each get an equal part of their total height,
  however tall their content is. A short card gets blank room and a tall one draws past its own
  bottom edge, over the next card. Give `flex-1` only where the views sit side by side (Settings ›
  Runtime's model and channels cards).
- On a touch screen such a drag must not take a swipe from the list's scroll view, so it waits for
  a finger to rest (`pages/chat/topicDrag.ts`: 450ms within 8pt). nsh/base's `Button` takes no
  `onLongPress`, so the hold is timed in JS from the touch events of the view around the button
  (`onTouchStart`/`Move`/`End`/`Cancel`, which every listening view hears, before the responder's
  events of the same touch). Nothing can claim the responder between touch events: the claim is
  the next move's `onMoveShouldSetPanResponder` after the hold, and the grant's block is what
  stops the scroll view. On Android that block sets the `ScrollBox`'s `jsBlocked` (it neither
  intercepts nor scrolls), a scroll view that starts to scroll first cancels the JS touches
  (`onTouchCancel`, terminate), and its touch tracker sends a move only when a position changed.
  The release after a hold still presses the button under it: the row's `onPress` asks the drag
  whether the hold took that press. Headless runs cannot rest a finger and then move it in one
  gesture (`dragAndHold` moves at once), so the steps are driven on the module
  (`tests/chat-topic-touch-drag.test.tsx`).
- On the web, nsh's context `Provider` hands its children on unresolved: a function among them (an
  expression child in a fragment, an `If`) runs later, outside the provided value, and a context
  read there gets the default. Native runtimes, and so headless tests, resolve them under the
  value. A provider whose children read it at creation resolves them itself (`UnderContext` in
  `components/ui.tsx`, under `DialogActions`); prove such a context in Chrome.
- Shared motion helpers (sliding selection, fade truncation, scroll edges, entrances, dialog
  origin, page slides) are in `components/motion/` (see its README).
- Page transitions (docs/console/page-transitions.md): a page going out stays mounted through its
  slide (about 280 ms), inert, hidden from assistive tech and with its `onSystemBack`
  registrations off (`SystemBackScope`). A page reading its route with
  `currentRoute()` gets its own; code run outside the page's components (a handler's `await`
  continuation, a module) gets the current one. A page that shows a list or one of its items on
  phones moves between them with `createPaneStack` (`components/motion/PaneStack.tsx`): `shown`
  in place of the `If`, `style` and `hidden` on the pane's root view, the item's phone bar inside
  its pane, and `held` for what clears as the page goes back (an item named by the route). A new
  phone detail view does the same. Headless steps do not wait for a slide on the system clock: a
  test that checks a page or pane has gone waits for it (`{ state: "gone" }`), and a press on
  the list during the slide's last frame can be lost headless (not in a browser).
- A view has no fill unless it is given one: a pane that slides over another is see-through
  between its parts (the topic list showed through a new topic's empty page as it slid in). The
  item's pane takes the page's paper from the stack (`panes.paper(1)` in its root's class:
  `bg-background` on phones, nothing where the panes stand side by side). A glass bar's tint is
  not a page fill. Headless has no style query: the chat's pane says it in its test id
  (`chat-conversation-pane.paper`).
- nsh orders sibling views by `zIndex` by moving their native views (a DOM `insertBefore` on the
  web, a remove and add on Android): changing the `zIndex` of a view holding a focused field takes
  the focus off it (Android keeps the keyboard up, with nothing to type in). PaneStack restacks
  only the pane going out. Headless runs keep the focus in the core and show none of it; `nsh test
  --trace` lists the moves (`Insert` of a view already placed).
- A view rendered by a state change may not exist yet when the change returns (on the web it
  renders after a press handler): a focus asked for in the same handler goes to the composer that
  was there before, or to none. Ask a microtask later, for the one there then
  (`focusComposerOnEntry`). Headless runs render at once and pass either way; check in Chrome.
- Headless on the system clock, a step returns once its native animations ended and no batch came
  for 100 ms, without waiting for what the animation's promise does next: whether the render that
  follows (a view that shows only while the animation runs) came before the next `count` was a race
  (the composer drum tests failed about one run in three, and were removed). Test such a view by
  holding the animation's promise in the fixture, not by counting after the step; on a manual
  clock, steps finish the animation and its follow-up both, so the view is never seen.
- A dialog stays drawn while it goes out, and its text field keeps the focus that long: keys typed
  then landed in the closed dialog's field, and a phone's keyboard stayed up. A dialog with a field
  blurs it and lowers the keyboard as it closes, and focuses it as it opens, selecting its text
  when asked to (`selectOnOpen`; `components/shared/dialogFieldFocus.ts`). A one-line `Input`
  blurs itself on Enter (`blurAndSubmit`): a dialog that stays open when its Enter fails passes
  `submitBehavior="submit"`.
  Headless runs settle the closing motion before the next step, so none of this shows there; test
  it on the helper. Headless inputs also ignore `setSelection` (typing lands at the end), and
  `app.type` presses the field first, collapsing a selection on every target: see one under
  `nsh test --target web` with `app.paste` into the focused field, which replaces it.
- The phone's bottom navigation floats over the foot of every page that shows it
  (`mobileBottomNavVisible`), so nothing there is laid out above it by itself: a page's list ends
  with `MobileBarSpacer`, and so does a column with a fixed control at its foot (the chat's composer
  on a first topic). Headless `app.press` reaches a view the bar covers (no hit test) and reports no
  frames: test that the room is there (`MobileBarSpacer`'s `testID`) and look at the geometry in a
  browser.
- The bar shows on the navigation's own pages only (`isMobileNavRoot`: the paths of
  `lib/navOrder.ts`, route meta `mobileBottomNav` where the path does not say). A page whose phone
  layout swaps its list for one of its items in place (a PaneStack level 1: a contact, a task, a
  settings section, a new topic over the topics) calls `markMobileDetail(...)` with the condition
  its back arrow shows on, so the bar, its room and Android's bottom inset follow. A new page with
  a list and items needs that call too. In `nsh test` the app's modules are another realm (a test's
  import of `lib/shell` is not the app's state): the frame's bottom padding is readable as the
  `app-frame.bottom-<pt>` testID.
- On the web, an `Image` inside a `Scroll` adds its own pixels to the scroll's content size, not
  its styled size: a 512px avatar drawn at 24pt made the agent picker's list (177pt of rows)
  scroll to 656pt, and 532pt across (the runtime's `nsh-spacer` is sized from the core's content
  size). Put such an image in a View of its size with `overflow-hidden` (`AgentAvatar`). It is the
  layout's doing, not the browser's: an `Image` whose natural size is known counts that size as
  its overflow whatever its styled size, and overflow passes up through every view that does not
  clip. So an `Icon` does it too (the SVGs are 256pt: a 16pt icon reaches 240pt right and down),
  and the composer's add menu, two rows of 74pt, scrolled over 304pt. `PickerList` clips the view
  that holds its rows, so nothing in a row can add to its scroll; other scroll views with icons
  near their end still get the extra room. Headless tests show it for bundled images (their size
  is known at build time), not for loaded ones: read `contentSize` from the scroll's `onScroll`
  (tests/picker-popups.test.tsx), or the `nsh-spacer` in a browser.
- On the web, what a `ShaderEffect` draws through its shader (`sample_content`) loses the masks
  inside it: an `Icon` (a tinted mask) comes out as a solid square of its colour. The Contacts
  panel's avatar resolves through one (`PixelResolve`) with its kind badge kept outside it, over
  it. Headless tests draw no shaders (`shadersAvailable()` is false there): look in a browser.
- A slot prop (`props.search`, `props.top`: JSX passed as a prop) is drawn again each time it is
  read. A second read in the same component makes a second, unmounted copy whose `ref` and key
  bindings replace the first one's (Settings' search lost its focus after Clear). Read a slot
  once (`untracked(() => props.search)`) and use that.
- Blurred glass (`lib/glass.ts`, `components/frame/glassBar.tsx`): `backdropFilter` blurs only
  what is drawn behind the view, so a bar in a column above its scroller has nothing to blur. The
  scroller is pulled up under the bar (`underBar()`, a negative top margin) and its content starts
  with the bar's room (`BarRoom`); the bar goes above it with `relative z-10` (a static z-index:
  one that changes moves the native view and drops the focus). GPUI draws no `backdropFilter`,
  Android only from API 31, and nsh reports no "reduce transparency" setting: `glassEnabled()`
  answers for all of them, and without glass nothing is pulled or padded. Headless Chrome at a
  device scale of 2 leaves sharp ghost text under a 20px backdrop blur (plain HTML too): take
  screenshots of glass at scale 1, or start Chrome with a GPU rasterizer (`--use-gl=angle
  --use-angle=swiftshader --enable-unsafe-swiftshader`), which blurs at 2x and 3x as a device does.
- A glass bar shows only what has contrast under it. A conversation's dense text reads as frosted
  glass; single-line rows and pale cards on the paper (Topics, Contacts, Settings, Usage) blur to
  almost the paper's own colour under the 78% tint, and the bar looks opaque although the list
  does run on under it. To see whether a bar works, do not judge by eye: in a browser compare a
  shot of the bar with one taken with its `backdrop-filter` off, and one with the bar hidden
  (what lies under it); headless, `barRooms(app)` (tests/harness.ts) tells where each real page's
  scroller starts under its bar (tests/glass-page-heads.test.tsx).
- Android (nsh 0.5.0) leaves a glass view without its blur when another glass view over the page
  was attached before it (a page's head under the phone's bottom navigation): the older view
  records its backdrop first and draws the page for it, the new head in it, before the head's own
  backdrop exists, and nothing draws the head again. Contacts' and Settings' heads stayed sharp,
  Topics' depended on which was attached first, and Todo's blurred once its border changed on
  scroll. `glassMounted()` (lib/glass.ts, called by `BarRoom`) moves the blur radius by 0.01pt
  after the first frames, which repaints every glass view. Drop it once nsh repaints the view
  itself after the first recording.
- `nsh/base/plot` has no stack that goes both ways from its base: the bars of one `stack` pile
  their signed values on one running end (a negative value after positive ones starts at their
  top and comes back down over them), and two stacks stand side by side in the band. The daily
  usage chart draws the agent's half above the base line and the coder's below it in one stack:
  the agent's bars, then an unpainted bar (`fill-transparent`) of minus their sum, which takes
  the running end back to the base, then the coder's bars with negative values, on a y scale
  from `-max` to `max` (`DailyUsagePanel`). The bars join a stack in the order they are attached,
  and a `<Bar>` written beside a list of bars is attached before the list whatever the source
  order: put every bar of the stack in one list.
- A `WebView`'s `src` (and an `Image`'s, outside the bundle) must be an absolute `http(s)` URL with
  a host. The core checks it against the `webview` capability and refuses a path such as
  `/api/artifacts/preview/<ticket>/index.html` ("names no host a grant could add",
  `ERR_ACCESS_DENIED` on `onError`) on every platform, the browser included: nothing loads and the
  box stays blank. The console server answers with paths (it does not know the address the client
  used), so make them absolute with `consoleURL` (`lib/core/context.js`) first. Artifact previews
  did not, and showed an empty frame in the phone app and the web console alike (FT144). Listen to
  a web view's `onError`: without a listener a refusal leaves no trace but a log line.
- What a web view reports differs: on the web the `<iframe>` gives `onLoadStart` and `onLoad` but
  never an HTTP or network error (a 401 or 404 page simply shows), and a same-origin URL is
  sandboxed without its origin (the artifact cannot reach the console page). Android's WebView
  reports `onError` for the main frame only (the 0.4.0 runtime checks `isForMainFrame`) and may
  still send `onLoad` for its own error page after it, so the artifact card keeps a failure once
  reported. Headless `nsh test` loads no pages and sends no load events: page states are driven
  through the store (`tests/fixtures/artifact-preview-app.tsx`), and only a refused URL's `onError`
  is real there.

### Android (nsh 0.4.0)

- A pressable view that clips (`overflow-hidden`) and casts an outer shadow never gets its presses:
  the runtime moves its children into an inner box that takes them. `Button` drops its shadow on
  Android; do not combine the two on anything pressable.
- Android gives a touch that no view takes to the views behind it: the dialog's scrim heard presses on
  the panel's padding. The scrim ignores presses inside the panel's frame.
- Neither the surface nor a dialog shrinks when the software keyboard opens. The app's root adds
  `keyboardFrame().height` as bottom padding, and so does the layer of a phone's popups
  (`DialogLayer`, lib/mobilePopup.ts), so their paper stands on the keyboard. Not
  `env(keyboard-inset-height)`: it moves views natively but not in the layout presses are matched
  against.
- On touch screens nsh/base's `Menu`, `Select` and `DatePicker` are sheets flush with the bottom of
  the screen (their `placement` is the desktops'), padded with nothing (their last row lies under
  the navigation bar or gesture handle), sliding up from the bottom edge, and nothing in their
  props changes that motion. The console does not show them there: on phones and on every touch
  screen (`popupSheets()`, components/ui.tsx) a dropdown is the shared floating paper
  (`PopupSheet`, `PopupList`; design/mobile-popups.md). The base component stays mounted for its
  trigger (its press, keys and accessibility), held shut with `open={false}`: its `onOpenChange`
  still says when the trigger asks to open, and the paper opens instead (`SelectField`,
  `DropdownMenu`, `SettingMenu`, `TodoSelect`, `DateField`). A new dropdown does the same, or uses
  one of those; never give a base popup a `popupStyle` for the touch sheet. `Popover` stays at its
  trigger on touch screens; `PopoverPicker` moves its rows to the paper on phones (`sheet`).
- A popup declared beside other controls must take no room there: `PopupSheet` wraps its layer in
  an absolute, zero-size view (a `Dialog` in a `gap-*` column would add a gap).
- Opening a popup does not take the focus from a text field: one opened from beside a focused
  field would lie under its keyboard. The composer's add menu and model picker call
  `Keyboard.dismiss()` as they open and focus the field again as they close
  (`components/chat/ChatComposer.tsx`); a paper with a field of its own (a filter) stands on the
  keyboard that field raises.
- Headless tests draw no software keyboard: `standInKeyboard(height)` (components/ui.tsx) stands
  one in for the phone's popups, and `watchDialogs` gives a fixture every paper's frame and motion
  (tests/fixtures/mobile-popup-app.tsx). A step of a test ends only once the app is quiet, so an
  entrance is sampled from the paper's first layout, not from a button pressed before it.
- Dialogs are nsh `Dialog`s on Android too (`DialogLayer`, `statusBarTranslucent`: over the whole
  screen, as the sheets' layers are). nsh 0.4.0's Dialog started below the status bar and took
  presses one status bar higher than it drew them, so they were Overlays until nsh 0.6 (see there).
- A phone bar's back arrow does not hide the keyboard by itself: the chat's arrow calls
  `dismissSoftKeyboard` (`lib/softKeyboard.ts`) first and goes back only when nothing was up. On
  Android trust `keyboardFrame()` from the start (the host reads the system's keyboard insets); a
  focused field alone may have a hardware keyboard. On the web trust it once it has reported a
  keyboard; before that the focused field stands for the keyboard. Headless runs report no frame,
  so a headless Android phone with a focused field is one with a hardware keyboard.
- Back (the button, and the edge swipe of gesture navigation, which the system turns into the same
  event) reaches the app only while it listens (`BackHandler`); otherwise the system leaves the app.
  `lib/systemBack.ts` listens only while a view registered with `onSystemBack` applies (a page
  whose phone layout has its own back arrow registers what the arrow does, with the arrow's own
  condition; `MobileBar` does it for its users). The run's history (`lib/mobileHost.ts`) never
  makes it listen: a navigation page's own list has no arrow and takes no Back, however it was
  reached. A new phone detail view with a back arrow registers too, and a page below another
  (the skill store, Logs) opens its parent with `openParentPage`, so it works when the app
  opened on it.
- The surface runs under the status bar and the navigation bar (nsh draws Android edge to edge;
  `safeArea()` has their sizes). The app's frame takes them once (`lib/systemInsets.ts`): pages and
  their 57pt bars need no inset of their own, and `env(safe-area-inset-*)` must not be added inside
  the frame on Android. Overlays cover the whole surface and take the insets themselves.
- A dialog on a phone is the floating paper too (`DialogLayer`, `mobilePopups()`: windows under
  720pt, and touch screens up to the phone layout's 980pt, a phone on its side): its layer takes
  every inset, the keyboard's height in place of the bottom one, and a 12pt gap at the left, the
  right and the bottom (lib/mobilePopup.ts; iOS and the web too), so the panel pads nothing for
  the system and its own bottom edge shows above the inset. It slides up from below the window's
  bottom edge, and back down out there. Its footer's buttons go in `DialogActions` (Modal's footer and SettingDialog's are):
  exactly two share the row's width there; put them in the row itself, not each in a column of
  its own (`flex-1` would grow it down).
- nsh/base's `Sheet` is such a layer: the frame's padding does not reach it, and its panel runs
  under the status bar unless it is padded. Every right sheet (`WorkspaceSheet`, a `SidePane` with
  `sheet`, the skill store's `SkillStoreSheet`) pads its popup with `rightSheetPopupStyle`
  (`lib/shell.ts`, `rightSheetInsets` in `lib/systemInsets.ts`; Android and iOS, none on the web
  and the desktops); a new sheet at a side does the same, never adding the frame's inset on top,
  and nothing inside a drawer pads for the system again. The bottom is the navigation bar's inset
  only: Android's sheet window already ends above the keyboard (below), and nsh lifts a side
  panel above it on iOS, so the keyboard's height is never added (tests/right-drawer-insets.test.tsx).
- The packaged app gets no `usesCleartextTraffic`, and its `fetch` goes through HttpURLConnection,
  which then refuses `http://`: `scripts/build-android.sh` runs `nsh package` with an SDK whose
  `aapt2` adds it, for console servers on the local network.
- 0.4.0 had the photo picker but no `Picker.pickFiles`; 0.5.0 has both (`pickFiles` is Android's
  `ACTION_OPEN_DOCUMENT`), so the phone's Upload files asks Gallery or File (`AttachSourceSheet`)
  and `lib/mobileHost.ts` takes the matching picker. Headless tests answer either with
  `app.onPick` (`pick.kind` says which). There are still no `Notifications`. Avatars (crop and re-encode) are not available there yet;
  they say so.
- nsh 0.5.1 has no save dialog for apps on Android: its `SaveDialog` is Rust-only and desktop-only
  (iOS, Android and the web answer every file request with an error), and `fs/promises` reaches only
  the app's own files. The phone's `morph.file.save` is the app's Java (`FileSaver`: a transparent
  `SaveDocumentActivity` shows `ACTION_CREATE_DOCUMENT`, then the file is streamed from the console
  into the chosen document). `lib/mobileHost.ts` asks `morph.file.saveSupport` at boot and only then
  lists `saveFile`; headless tests play the native part with those two handlers. Task notifications come from the app's own Java (a JobScheduler job reading
  `/api/notifications/events` while the app is away: the page, and its socket, are suspended then);
  see `docs/feat/feat_20261110_android_task_notifications.md`.

### nsh 0.6.0

- An nsh `Sheet` is a modal root now (nsh #2028): it is drawn, and Back and Escape reach it, above
  the app's root and every `Overlay` in it (an overlay goes in the root around its node, so one
  declared on a page is under every open sheet). The console's dialogs were overlays on Android,
  so the rename dialog opened from the chat's right sheet was drawn under the sheet. Every dialog
  and phone popup is an nsh `Dialog` on every platform now (`DialogLayer`): the newest modal is on
  top, scrim and paper, and owns the presses, Escape and Back until it is gone; the sheet under
  it stays open as it was (tests/dialogs-over-sidebar.test.tsx). Never draw a dialog in an
  `Overlay`, nor raise one with a z-index. A panel's own Escape binding beside the content (a
  `SidePane` column) steps aside while a popup is open (`bindPaneEscape`, components/ui.tsx).
- On Android an nsh `Dialog` (and `Sheet`) is a window of its own, which nsh lays out above the
  software keyboard: its root is the window's height less the keyboard's. `keyboardFrame()` still
  reports the keyboard there, so a layer that also pads by it stands a keyboard's height too high
  (`popupFrame`'s `layerAboveKeyboard`, lib/mobilePopup.ts). And as the keyboard comes up,
  nsh pads the scroll view around the focused field by what the keyboard covers before the window
  shrinks, and keeps it until the keyboard goes down: an empty band under the field, the body
  scrolled into it. The app's native part takes that room back in dialog windows
  (android/src/com/longbridge/nsh/ModalKeyboardRoom.java, in nsh's package for its
  package-private parts); headless tests draw no keyboard and cannot show either.
- `Picker.pickFiles` leaves a file over 512 MiB unread (`file: null`, `status: "tooLarge"`);
  `lib/mobileHost.ts` leaves it out.
- A tooltip goes out over a few frames as the next one comes in, so for a moment both show.
- Headless, a list's own scroll correction is reported at once: at the newest message, a point up
  can be taken back before the test scrolls down again (tests/chat-scroll-anchor.test.tsx `snap`).

## The QR scanner (the phone app's server address)

nsh has no camera and no QR decoder, and the phone app has no browser page of its own (no
`host.js`). A web view's page has both where the system's web view does, so the scanner is a
`WebView` given its page as text (`html`, with an `https://…invalid/` `baseUrl`: a secure context,
which `getUserMedia` needs) that asks for the camera and reads it with `BarcodeDetector`.

- `nsh.json` grants it: `capabilities.webview.media: ["camera"]`. From that `nsh package` declares
  Android's `CAMERA` permission and iOS's `NSCameraUsageDescription` (ours is in `ios.infoPlist`);
  `scripts/android-manifest.mjs` adds the permission when nsh did not and marks the camera as not
  required to install the app. The system asks the user at the first scan, never before.
- The page talks to the app through `window.nsh.postMessage` (`ready`, `result`, `error`) and
  hears `"stop"` from `WebViewRef.postMessage`. `lib/qrScan.ts` checks every message, hears at most
  one result or failure per scan and nothing after the scan closed.
- A scan only fills the dialog's field, with what `parseServer` makes of the code's text: the
  page reads no address and opens nothing, and the app asks the address nothing until Save.
- Where the web view has no `BarcodeDetector` (iOS's WKWebView; an Android System WebView without
  it) or no camera, the page says `unsupported` and the dialog says to type the address. No decoder
  is bundled.
- A headless web view runs no page: `tests/loginProbeConsole.tsx` speaks as the page would
  (`loginProbe(app).say(…)`), and `lib/qrScannerPage.test.mjs` runs the page's script against a
  browser made of fakes (`scripts/test.sh` runs it with the whole suite). The page's script is
  kept as text, since the app's own functions are compiled and have no source to take.
- Not checked by any test: a real camera, the system's permission question and a real code. Check
  them on a device after changing the page or the web view's props.
