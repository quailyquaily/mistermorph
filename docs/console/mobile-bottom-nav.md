# Phone bottom navigation: expanded and compact

On a phone, the navigation's root pages (Topics, Contacts, TODO, and More's pages: Memories,
Skills, Usage, Audit, Settings) show the floating capsule at the foot of the window
(`web/console-nsh/components/frame/MobileBottomNav.tsx`, drawn by the shared `CapsuleNav` of
`web/console-nsh/components/shared/CapsuleBar.tsx` with its `expansion`). It has two sizes (FT172):

- **Expanded**: each page's icon with its localized label under it (the `nav_*` titles; More's
  label names the More page that is open, or "More"). This is the starting state.
- **Compact**: the icons alone, in a shorter, narrower capsule (the bar as it was before FT172).

Reading down into a page's content compacts the capsule; going back up expands it again. It never
hides: both sizes keep every destination, the active pill, presses, keyboard access and accessible
names. This does not apply to the desktop sidebar, or to pages below the navigation (a topic, a
contact, a job), which have no bottom bar.

## Rules

The state lives in `web/console-nsh/lib/navScroll.ts` (`stepNavScroll` is the pure reducer the
tests drive).

- **Thresholds.** Expanded, the capsule compacts once the content went **32pt** further down than
  the highest point since it expanded (`NAV_COMPACT_AFTER`). Compact, it expands once the content
  came **24pt** back up from the lowest point since it compacted (`NAV_EXPAND_AFTER`). These are
  net distances, so many small reports add up, and a small reversal only moves inside the band:
  a finger's jitter never flips it. Expanding takes less than compacting so the labels come back
  quickly when the reader turns round, while a short nudge down does not take them away. 32pt is
  about half a list row.
- **The top always expands.** An offset within 1pt of the top is the top, whatever the direction.
  Content too short to go 32pt down (or shorter than its scroller) therefore never compacts.
- **Overscroll is no movement.** Offsets are clamped to what the content reaches
  (`0 … content − viewport`), so an elastic bounce past either end (iOS, a pull at the top for a
  refresh or the hidden search) counts as resting at that end.
- **Which scroller.** Every navigation page's content scroller goes through `useScrollMemory`
  (`web/console-nsh/lib/scrollMemory.ts`), which passes each scroll report on with its area key as
  the source. This covers the list column and the column beside it, so a nested scroller is
  followed when it is the one the reader moves. Only the source that last moved under the reader
  counts; another one taking over starts afresh, expanded, from its own offset.
- **The app's own scrolling is never a direction.** Restoring a remembered place (scroll memory),
  and a scroller pulled back because its content got shorter, are reported as programmatic: they
  only move the turning point of the source already followed, and are ignored from any other.
  Returning to a page that restores a place far down leaves the capsule expanded.
- **Resets.** Any route change (another destination, a Settings section, the navigation shown
  again after a page below it) resets to expanded and forgets the followed scroller and its
  turning point (`resetNavScroll`).

## Layout and motion

- Compact: 58pt tall (50pt slots inset 4pt), slots up to 60pt wide. Expanded: 64pt tall (56pt
  slots: a 24pt icon, a 2pt gap and a 14pt line of 11pt text), slots up to 76pt wide. Narrow
  windows share the room equally in both states (`mobileNavSlots`); a slot is never narrower
  than a press target.
- The room pages keep for the bar (`mobileBarRoom`: list spacers, the FAB, the phone sheets'
  position) is always the expanded height, whichever state is shown. The capsule resizing
  therefore never moves page content or a control. The bottom safe-area inset is taken as before.
- The change takes 160ms on the shared ease (`NAV_RESIZE_MS`), drawn frame by frame by the strip
  itself: slot widths, the row's height and the active pill follow it; a label folds in height and
  is faded out by half-way (and back in over the second half when expanding). With reduced motion
  it is immediate. Turned round mid-way, it goes back from where it is.
- The agent's slot keeps its portrait and its sheet, and takes no label in either state: it is not
  a destination, and the portrait is its name (its accessible name stays "Agent: …").
- The labels are hidden from assistive technology; each slot's accessible name is its button's
  own, as before, so nothing is read twice.

## Tests

- `web/console-nsh/tests/mobile-nav-scroll.test.tsx`: thresholds and hysteresis, reversals,
  overscroll clamping, short content, scroller/route resets and restores (reducer), and the real
  console on a phone browser and Android: expanded start, compact on the way down, expanded on the
  way up and at the top, another destination and a restored place, a short list, a topic page, and
  the unchanged desktop.
- `web/console-nsh/tests/mobile-bottom-nav.test.tsx`: slot geometry in both states on narrow,
  large-text and landscape phones, the pill on its slot, More and the agent from either state, and
  the resize timing with and without reduced motion.
