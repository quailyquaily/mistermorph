---
date: 2026-10-23
title: Console, quieter and finished in detail
status: implemented-v1
---

# Console, quieter and finished in detail

## Goal

Console looked busy: every page repeated the same loud elements. The aim is a quieter UI that is
easier to read and use, keeping the design idea but not its implementation, and finished in the
small details that make an interface feel made: things that look simple and are hard to get right.

## The design idea, kept

Engineering paper: pale paper with a blueprint grid, ink navy and blue, small mono caps for
metadata, hairlines, 2px corners, square status marks.

## Principles

1. **Each ingredient once, where it means something.** Mono caps for metadata only (times,
   counts, IDs, field keys). Navy for emphasis, not for blocks of chrome.
2. **One cue per state.** A selected item is a soft fill; it does not also get a frame and a dot.
3. **One surface level.** Panels sit on the page, divided by space and one hairline, not boxes in
   boxes.
4. **Details are drawn the way the browser draws borders.** Lines meet on device pixels at any
   density; motion settles; nothing jitters, flickers or is clipped.

## Pass 1: the shared shell

Every page uses these, so one pass quiets the whole UI.

| Element | Before | After |
| --- | --- | --- |
| Sidebar | navy block, light text, rounded inset | paper (`--q-bg-light`), ink text, a hairline edge; the current page is a soft fill |
| List selection (`.workspace-sidebar-item.is-active`) | border, fill and a blue dot | a soft fill (accent 10%); the dot that only repeated "selected" is hidden, dots with meaning (a skill on or off) stay |
| Section head (`AppSection`) | `■ [ LABEL ]` meta | `LABEL` meta: the mono caps label in `--text-1`, no square, no brackets |
| Paper grid | 100px major and 20px minor lines | 100px lines at 2.8%, no minor lines (`--morph-bg-grid-*`) |

Files: `styles/base.css`, `components/AppSidebar.css`, `AppNavList.css`, `AppSidebarControls.css`,
`AgentSwitcher.css`, `AppSection.css`, `AppSection.js`, `views/common.css`.

## The details

### The user bubble's tail

The tail and the bubble's edge are one outline: where the tail's slope meets the bubble's right edge
it flows in through a concave fillet (4px), and its tip is rounded (1.6px), so the tail grows out of
the bubble instead of sitting on its corner.

Two masks of the same outline paint it (`::before` the fill, `::after` the stroke). The hard part is
the line itself: a 1px CSS border is drawn in whole device pixels (one at 1.25x and 1.5x), but a 1px
SVG stroke is 1.25 or 1.5 device pixels, smoothed across two, so the tail looked wider and paler
than the border it continues. `core/chat-bubble-tail.js` builds the masks for the screen's density:
the line has the border's width in device pixels (`borderWidth(dpr)`), the box starts where the
border does, so the straight parts land on the border's own pixels, and the masks are rebuilt when
the density changes (another screen, zoom). Measured at 1x, 1.25x, 1.5x, 2x and 3x: the tail's
top edge has the border's pixels and colour; only the slope and curves are smoothed.

### 1. Selection that slides

`v-sliding-selection` (`core/sliding-selection.js`) puts one highlight at the back of a list and
glides it to the selected item (260ms), taking the item's position, size and corners, so it stretches
between rows of different heights. It follows class changes, items added or removed, and resizes.
The first placement, and a selection after none, sets it in place without motion; reduced motion
zeroes the motion tokens.

The glide is a FLIP: the highlight takes the new item's box at once, then a Web Animation of its
transform alone (translate and scale) carries it from where it was. The compositor runs a
transform-only animation, so the glide stays smooth while the main thread renders the page the click
opened; a first version that transitioned `width` and `height` stuttered exactly then. A second
selection mid-glide starts from the highlight's animated box, so it turns without a snap, and a list
change that leaves the selected box where it was does not restart a glide in flight.

The list becomes a stacking context with the highlight at `z-index: -1`; the items' own selected fill
gives way to it, and hovering the selected item deepens it.

Used on: the sidebar (`AppNavList`), Topics, the Settings index, Skills, Contacts, TODO.

### 2. Scroll edges

`v-scroll-edges` (`core/scroll-edges.js`) marks a scroller `is-scrolled` while content is above and
`has-more-end` while more is below. CSS fades the content itself at those edges with a mask, so
whatever lies behind (paper, grid, a tint) shows through; an edge with nothing past it stays sharp.
The fade comes and goes at once: animating the mask repaints the content on every frame, and text
renders a touch heavier while it does, a flicker each time scrolling starts.

- A list under a pinned head (`.workspace-sidebar-head`): the head's hairline and blur appear only
  once something has scrolled under it; there is no top fade.
- Chat history, on wide panes where the composer floats over it: history fades out as it reaches the
  composer's top edge and is gone beneath it, instead of showing through the composer's 92% white.
  At the bottom of the conversation the last message stays clear of that edge.

Used on: the sidebar, Topics, chat history, the Settings index and panel, Skills, Contacts, TODO, the
audit ledger.

### 3. Avatars cut out for their marks

- Overview: the status square sits in a real notch, a 13px rounded square subtracted from the avatar
  at the mark's position (`mask-composite: exclude`), so the grid shows through the 2px gap. It was a
  page-coloured plate painted over the avatar.
- Contacts: the kind badge sits in a round cut-out (radial-gradient mask). Its old ring used an
  undefined variable (`--surface-1`) and drew in the text colour.
- Both get a faint inner hairline (dark 9%) so a pale avatar does not melt into the paper; the notch
  cuts it too.

### 4. Lines that meet cleanly

- Overview readouts: the leader dots belong to the row, drawn from its left edge on one 3px pitch, so
  they stand in exact columns down the card like a datasheet; the label and value sit on the card's
  paper and clear the dots. They were dotted borders starting after labels of different lengths.
- Topic date rules fade out toward the list edge instead of stopping dead.

### 5. Long names fade instead of "…"

`v-fade-truncate` (`core/fade-truncate.js`) marks a one-line text `is-truncated` only while it
overflows (one shared ResizeObserver), and then gives it its full text as a tooltip unless it has
its own. CSS fades the last 2.4em with a mask, so a row's hover or selection tint shows through.
Text that fits is never faded.

Used on: topic titles, contact details, agent names in the switcher.

### 6. Digits that line up

Interface text uses `tabular-nums` (body), so columns line up and live numbers do not twitch;
replies and documents (`.mmr-document`, `.chat-markdown-content`) keep proportional digits.

### 7. Line breaks

- Paragraphs, list items, `dd`, quotes: `text-wrap: pretty` (no one-word last line).
- Titles, dialog titles, empty-state titles and copy: `text-wrap: balance`.
- `line-break: strict` everywhere: no line starts with closing CJK punctuation or a small kana.
- Japanese titles: `word-break: auto-phrase`, breaking between phrases.

### 8. Send and copy

- The composer's send button is one shape through three states: nothing to send, a hairline
  outline with a muted plane set slightly back; ready, filled ink with the plane settled; running, the
  same fill with the plane crossfading into the stop square. Both icons stay in the button.
- Copying a message turns the copy mark into a check drawn in one stroke (`stroke-dashoffset`).

### 9. Calm hover

List rows (`.workspace-sidebar-item`, `.nav-link`, agent switcher options, file rows, question
choices) light up after 60ms and go out at once, so sweeping the pointer over a list does not flash
every row. With `(hover: none)` rows show no hover fill.

### 10. Focus rings

One ring everywhere: 1.5px, accent 55%, 2px off the element and following its corners. Rows in
scrolling lists draw it inside their edge, where a list cannot clip it. Text fields keep their own
focused border. It replaces a ring that was set only in the desktop app.

## Round two

### 11. Page changes settle in

Moving to another page (Chat to Settings; not another topic or settings section) lets the new page
fade in as it rises 6px into place, while the sidebar and the phone's nav keep still.

- The navigation selects the page being opened as soon as it is chosen
  (`composables/useAppShell.js` follows the router's pending route), so the selection's glide starts
  on the click, not once the page's code has loaded.
- The entrance (`core/page-transitions.js`) is a compositor animation started once the new page is
  mounted. Nothing waits for it.

A first version ran page changes as a view transition (the old page fading out under the new).
The browser holds every frame of a view transition until the new page is built, the glide's
included: on Settings the selection waited 204ms to move and then froze for another 100ms, on a
fast desktop. Now it starts within one frame of the click on every page. The old page no longer
fades out; it is replaced.

### 12. A sent message is glided to

The history already let a new message rise in. Sending one now glides the history down to it
(`scrollHistoryToBottom({ smooth: true })`) when it is less than one and a half screens away; a
streaming reply, a load and a long way down still jump, so the view never lags the text.

### 13. The composer grows smoothly

The field eases to its new height as lines are added. Its measurement sets it to no height to read
the content's, which would have made every change animate from nothing, so it measures with motion
off and puts the old height back first.

### 14. Dialogs grow out of their control

`core/dialog-origin.js` remembers the control last pressed or activated from the keyboard; a dialog
appearing within 900ms of it is anchored on it (`transform-origin`, set from the observer's
microtask before the first frame) and grows out of it from 90%, shrinking back into it on close.

### 15. Rolling digits

`components/RollingNumber.js` shows the Overview readouts and the Usage totals with a wheel per
digit. A wheel is a window holding an invisible copy of its digit, so it keeps the font's width,
line height and baseline; the strip rides over it, clipped with `clip-path`, which leaves the
baseline alone (`overflow: hidden` dropped it to the window's bottom). The strip runs the digits three
times and a wheel turns the short way round (`core/rolling-wheel.js`): 9 to 0 is one step on, so
999 to 1,000 turns each wheel once; it re-centres on the middle run without motion once settled.
Wheels keep their place from the right; screen readers and selections get the plain value.

### 16. Selection, caret, scrollbars

Selected text is a soft ink blue and the caret the accent. Scrollbars are thin hairline thumbs that
show while the pointer is over the area or it holds focus; the gutter keeps its width, so nothing
shifts.

### 17. Code blocks stay dark

Tried as paper (a faint tint, a hairline, the github-dark colours mapped to inks), then reverted on
review: a dark block reads at once as code among prose. They keep the github-dark slab the renderer
(vendored) highlights with, with no border. The copy button is the Phosphor copy glyph, drawn as a
CSS mask so it takes the text colour, and turns to a check once copied.

### 18. Tooltips are paper cards

`core/tooltips.js` shows every `title` as a small paper card after a 420ms pause (at once when moving
between tooltips), centred above its element, below when there is no room, kept in the window, and
on keyboard focus too. A shortcut at the end, like "(Ctrl+K)", is set as key caps. While the pointer
is over an element its title is lifted off so the browser's own box does not show as well, standing
in as `aria-label` if it was the only name, and put back after.

### 19. Pending marks crawl

On Overview a connection being made has its square's dashes crawl slowly round it, each edge a
dashed gradient (a dashed border cannot move). Off with reduced motion.

A running topic's pulse in the topic list is not done: topics carry no running state (the topic
list has none, and the page follows tasks of the open topic only), so it needs one from the server.

### 20. Optical alignment

Measured, icon centre against the capitals: the sidebar is within half a pixel; the topic list's
icons sat 0.6px low, and are lifted half a pixel at 2x and above (at 1x the shift would blur them,
which reads worse); the settings index varies by icon (-0.75 to +0.75px, the shapes themselves)
and is left alone.

### 21. Switches

Quail's default switch was a 52×32 bevelled block. Now a 34×20 hairline track, empty when off and
ink when on, with a square knob on a hairline that slides across with a slight give.

## Type

### Families

Measured on nine pages, text used four families: IBM Plex Sans (titles, replies), the system UI
font (everything else: Ubuntu, SF or Segoe depending on the machine), and two monos (a system stack
and IBM Plex Mono), so most screens mixed two sans and two monos. Now there are two:

- `--font-ui` (and `--font-title`, the same face): IBM Plex Sans.
- `--font-mono`: IBM Plex Mono.

Plex has no CJK, so Chinese and Japanese fall back to the system's faces through `--font-cjk`,
Japanese ones first on a Japanese page (`:lang(ja)`), Chinese ones first otherwise, since the same
characters are drawn differently in each. The component kit's font tokens (`--q-font-*`) and the
Markdown renderer's (set inline) take these.

The fonts are bundled (`@fontsource/ibm-plex-sans` 400, 400 italic, 500, 600;
`@fontsource/ibm-plex-mono` 400, 500), imported in `main.js`, instead of loaded from Google Fonts: the
look is the same offline and in the desktop app, and the page makes no request to Google. Each
weight is split by script; a page loads only the subsets its text uses.

### Scale

Seventeen sizes and six weights were in use. Now:

| Token | Size | For |
| --- | --- | --- |
| `--font-size-label` | 11px | mono caps labels |
| `--font-size-meta` | 12px | meta, notes |
| `--font-size-ui` | 14px | controls, lists |
| `--font-size-body` | 16px | reading text |
| `--font-size-heading` | 18px | a heading step |
| `--font-size-title` | 20px | titles |
| `--font-size-display` | 32px | display figures |
| `--font-size-hero` | | the Usage total |

Weights are 400, 500 and 600. Literal sizes were snapped (9 to 11px to label, 13px to UI) and weights
(520 to 570 to 500, 620 to 720 to 600). Replies follow the scale: h1 title, h2 heading, h3 and below
body in 600; inline code 0.875em; bold 600. Avatar initials and the masked-secret dots keep their
own sizes, which are glyph sizes rather than text.

## The component kit

The console's buttons, fields, menus and dialogs came from the `quail-ui` package (0.9.10), which
also brought its own global CSS, theme machinery and components the console never used. They are
now part of the console, in `components/ui/`, and the package is gone.

- Components ported, one file each, as template-string components like the rest of the app:
  QButton, QInput, QTextarea, QSwitch, QBadge, QDivider, QProgress, QMenu, QDropdownMenu, QDialog,
  QMessageDialog, QLanguageSelector, QDatetimePicker, and the two icons they draw. Names, props,
  events, DOM and classes are kept, so templates and styles did not change. `components/quail.js`
  still registers them globally; `components/ui/popup.js` holds `applyTheme` and `closePopupMenu`.
- CSS: `styles/ui-kit.css` is the package's stylesheet cut down to what is used: the morph theme's
  tokens, the used components' rules, the base reset, the utility classes templates use, and the
  two keyframes. 3,075 lines, still loaded before `base.css`.
- Deliberate changes, all small:
  - QButton renders `title`, so buttons get the app's tooltips. Quail dropped it.
  - QInput and QTextarea update the model on every keystroke, not on keyup or change, and their
    attributes reach the native field (`aria-*`, `name`, `autocomplete`); class, style and `data-*`
    stay on the root. QInput's clear button is `type="button"`, so it no longer submits a form.
  - `.q-text-body-text` and the other text classes used Noto Sans through `--q-font-sans`, the one
    font token not mapped to ours. It now maps to `--font-ui`, so the language menu and the
    composer's profile picker are in Plex like the rest.
  - The language menu puts an en space between emblem and name. Two plain spaces collapse to one,
    which is tight after an emoji.
- Kept as they were: QDropdownMenu decides dialog or popover once, from the window width when it
  is set up; QDialog renders where it is used (the trigger wrapper, then the mask); the
  `quail-language` storage key, so a saved language survives.

Each file carries "Derived from quail-ui 0.9.10 (Apache License 2.0)", as does `ui-kit.css`.

## Cost while a reply streams

A streaming reply re-renders the whole chat many times a second, and every directive's `updated`
hook runs with it. So none of them measures on a parent render: they only restore their classes
(a `:class` binding replaces them). Real changes reach them otherwise: scroll events and
ResizeObservers for scrolling and size, MutationObservers for content and class changes (coalesced
to one measurement per frame), and for `v-fade-truncate` a change of the element's text. A first
version re-measured about a hundred topic titles, the scroll edges and the selection on every
render.

## Files

- New: `core/chat-bubble-tail.js` (+ `chat-bubble-tail.test.mjs`), `core/sliding-selection.js`,
  `core/scroll-edges.js`, `core/fade-truncate.js`, `core/tooltips.js`, `core/dialog-origin.js`,
  `core/page-transitions.js` (installed from the router), `core/rolling-wheel.js`,
  `components/RollingNumber.*`, and `core/ui-details.test.mjs`; installed and registered in `main.js`.
- Global rules: `styles/base.css` (digits, line breaks, hover, focus, the directives' styles).
- Component kit: `components/ui/*` and `styles/ui-kit.css`; `components/quail.js` re-exports them;
  `quail-ui` removed from `package.json`.
- Views and components: `ChatView.css` (tail, composer edge, date rules, copy), `ChatComposer.*`,
  `ChatHistoryItem.js`, `OverviewView.css`, `ContactsView.css`, and the templates that take the
  directives.

## Checking it

Headless Chrome over the DevTools protocol, against a running Console: screenshots at 1x to 4x,
frames captured mid-glide after a click, the highlight's position sampled every frame through a
glide and an interruption (continuous, eased, ending on the item's pixel), pixel measurements of
lines, and phone width (390px).

The component kit was checked the same way: 20 screens and opened menus and dialogs, captured
before the swap and after, differ only where the font change applies and in live data. Dialogs were
also checked for Escape, focus returning to their button and the scroll lock, a field for marking
settings unsaved as it is typed in, and the pages that use the components for console warnings.

Not checked: smoothness of the fades and the glide on a real GPU, hover timing with a real mouse
(headless Chrome reports no hover), and the glide to a sent message (sending one would run a real
task).

## Limits

- The scroll-edge fade is a mask on the scroller, so it also fades the scrollbar at that edge.
- Two-line clamped titles (skills, contacts) keep the browser's "…": a line clamp cannot be faded
  without measuring each line.
- The tail's slope and curves are smoothed at fractional densities, as any non-straight line is.

## Next

The kit:

- App CSS still overrides kit rules with `!important` in about 40 places. Now that the kit is ours,
  fold each into `ui-kit.css`, with a screen comparison per batch.

Pass 2, page by page:

- Fewer boxes: remove the outer frame of the Settings and Skills panels, and frames around Audit rows
  and channel tiles.
- Topics: drop the per-topic icons except meaningful ones (pinned, running); quieter date dividers.
- One weight for page titles.
- Audit and Usage: fewer mono caps and bracket badges, so numbers and statuses lead.
- Overview keeps the full grid and blueprint expression.
