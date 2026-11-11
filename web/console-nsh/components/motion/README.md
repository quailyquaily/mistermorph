# Motion and craft helpers

Shared ports of the Vue console's quiet details (`web/console/src/core/*.js`, `styles/base.css`).
Import from `components/motion` (`import { FadeText } from "../../components/motion"`). Each module
starts with a comment on why it is built the way it is; keep that when changing it.

| Helper | What it does | Usage |
| --- | --- | --- |
| `createSlidingSelection(selected)` | One highlight behind a list that glides (FLIP: transform only) from the selected item to the next; items report their frames with `onLayout`. Vue: `v-sliding-selection` (nav, Topics, Settings index, Skills, Contacts, TODO). | `const sel = createSlidingSelection(() => activeId());` then in the items' parent: `<sel.Highlight class="bg-selection" />` first, and `onLayout={sel.track(item.id)}` on each item (items drop their own selected fill; keep a hover fill). Rows of a virtualized `List`: report boxes with `sel.place(id, { x, y, w, h })`. |
| `FadeText` | A one-line text that fades over its last letters when cut (and only then), with the full text as its tooltip. Vue: `v-fade-truncate`. | `<FadeText text={title()} class="flex-1 text-sm text-foreground" />` (in place of `line-clamp-1` / `truncate` on names). On the desktop, the shell's patched GPUI backend fades the glyphs under the mask; on Android (no masks) the letters under the fade are drawn one by one at the mask's alpha, from their measured widths (`glyphFade.ts`). |
| `EdgeScroll` / `createScrollEdges()` | A scroller whose hidden edges fade (a mask that switches at once, never animates). Vue: `v-scroll-edges`. | `<EdgeScroll class="flex-1" contentClass="gap-2 p-4">…</EdgeScroll>`; on your own `Scroll`: `const edges = createScrollEdges();` `<Scroll {...edges.handlers} style={edges.style()}><View onLayout={edges.onContentLayout}>…</View></Scroll>`. `start={false}` under a pinned head. On the desktop the text fades; row fills stay whole. |
| `SCROLLBAR` | The console's thin hover-only scroll bars (base.css). `EdgeScroll` uses it. | `<Scroll scrollbar={SCROLLBAR}>` / `<List scrollbar={SCROLLBAR}>` |
| `Entrance` | Content that rises 6pt into place and fades in when `watch` changes (not on first render). Vue: `core/page-transitions.js`. The shell already does this for top-level pages. | `<Entrance watch={key()} class="flex-1">…</Entrance>` |
| `createArrivalTint()` | A row that just arrived: selection-blue tint that holds, then fades back (1.6 s). Vue: `.is-arrived`. | `const tint = createArrivalTint();` `style={{ backgroundColor: tint.color }}`, `tint.play()` when it arrives. |
| `AdjustingClock` | The alarm icon whose two hands turn while something runs, as a clock's do while it is being set: the minute hand in eased 1.2 s laps, the hour hand steadily at a twelfth of that, both in blue; they settle back to three o'clock (the plain alarm icon) when it ends. The face never moves. Reduced motion: the hands stand at ten past ten. Used by the topic head's TODO runs toggle in place of a button loading look. | `<AdjustingClock adjusting={running()} size={14} color="subtle" />` (the same box as `<Icon name="PhAlarm" size={14} />`) |
| `notePress` / `recentPress` | Where the last press went down; `Modal` / `MessageDialog` grow out of it (dialog origin). The shell feeds it. | Nothing to do: every `Modal` and `MessageDialog` uses it. |
| Tokens | `MOTION_FAST` 120, `MOTION_NORMAL` 180, `MOTION_SLOW` 260, `MOTION_PAGE` 220 ms, `MOTION_EASE` (`[0.2, 0, 0, 1]`, CSS form `MOTION_EASE_CSS`), `motionMs(ms)` (0 under reduced motion). | `style={{ transitionProperty: "colors", transitionDuration: motionMs(MOTION_FAST), transitionTimingFunction: MOTION_EASE_CSS }}` |

## Controls in `components/ui.tsx` that now carry the motion

- `Tabs`: the segmented control of Vue's `AppTabs` (38pt box, hairline border, 32pt options, ink on
  blue 16 % with a sliding indicator). Same props as before; `equal` gives each option the same
  share, `icon` on an item shows an icon.
- `Modal`, `MessageDialog`: scale in from the pressed control (0.9) or from the centre (0.98) with a
  fade, and back out on close.
- `DropdownMenu`, `SelectField` popups: drop in 4pt from the trigger with a fade (120 ms).
- `Button`: Vue's sizes (`md` 44, `sm` 38, `xs` 32, `xxs` 24pt), 500 weight, press overlay, hover
  colours with the ui-kit's transitions.
- Tooltips: `Tip` (`tooltip={<Tip text="…" />}`) is the console's paper tooltip; `Button title`,
  `NavLink` and `FadeText` use it.

## Theme tokens (theme.json)

- Surfaces: `bg-background` is the page paper (`#f6faff`, Vue `--q-bg-paper`); `bg-sidebar` (index
  columns of a page: Topics, TODO, Audit, Settings index) is the same paper; `bg-nav` is the app
  sidebar's light ground (`#edf3f8`, Vue `--q-bg-light`); `bg-muted` / `bg-light-2` is
  `#e5edf5` (Vue `--q-bg-light-2`); `bg-card` `#fbfdff` (Vue `--q-bg-white`).
- Row states: `bg-hover-soft` (accent 6 %, a row's hover), `bg-selection` (accent 10 %, the selected
  row), `bg-selection-strong` (13 %, the selected row hovered), `bg-hover` (10 %, a plain button's
  hover), `bg-segment` (blue 16 % over paper, an active tab).
- `border-focus` / `outline` colour `focus` (accent 55 %): the one focus ring.
- `bg-press` (`#0000000d`) and `bg-press-light` (`#ffffff26`): the press overlay on light and
  filled buttons.

## Additions (follow-up)

- `Button`: `align` (`start` default, `center`, `end`, `stretch`, `auto`); `selected` is the
  ui-kit's toggle-on (ink on accent 10 %); disabled looks per variant from the morph theme (primary
  `#879db6` with white 72 %, plain not dimmed, outlined/danger on white 50 %).
- `Toggle`: `hideLabel` (the track alone; `label` stays its accessible name).
- `Section`: `variant="head" | "boxed" | "pane"` (Vue AppSection), `lead`, `literal`, `list`,
  `flush`, `padding`, `fill`, `meta` as text or a node. `plain` / `card` are unchanged.
- `Modal`: `width` in points (picker dialogs: 720).
- `Tabs`: `narrow` (12pt labels, tight options); on by itself under 380pt.
- `TextField`: `clearable` (+ `onClear`), Vue's clear glyph `AppIconEditorDelete`.
- `SelectField`: `size` (`md` 44, `sm` 38, `xs` 32).
- `Markdown`: `classes` / `styles` by part (TextView's).
- `FadeText`: one unbroken line, cut mid-word under the fade (not at the last word that fits).
  `onGlyphFade` reports how Android draws the fade (for tests).
- Line heights: give points (`leading-[22.8px]`), not multiples (`leading-[1.14]`); opacity
  modifiers on theme colours (`bg-paper/70`) are not resolved: use a token (`bg-paper-soft`).
