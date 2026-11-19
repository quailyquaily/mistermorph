// The arithmetic of a tab strip that scrolls sideways (`Tabs`, components/ui.tsx), apart from the
// views so tests can check it on its own: how wide each option is when the options share the row
// (`equal`), and where to scroll so an option shows.

/** An option's place along the strip's content: its start and its width (points). */
export interface TabBox {
  x: number;
  w: number;
}

/**
 * How far past an option's edge the strip scrolls when it brings that option in from beyond the
 * viewport's edge: a sliver of the neighbour stays in sight, so the strip still reads as going on.
 */
export const TAB_REVEAL_MARGIN = 16;

/** Below this many points a strip counts as fitting (headless and the web lay out to half points). */
export const TAB_OVERFLOW_SLACK = 0.5;

/**
 * The widths that share `room` among options whose labels need `natural` points each (`equal`
 * tabs). Every option gets the same share while that holds its label; an option whose label needs
 * more keeps its own width and the others share what is left, equally (the way a flex row
 * resolves `flex: 1` items with their labels as minimums). Never narrower than an option's label:
 * options that need more than `room` altogether keep their own widths and the strip scrolls.
 */
export function equalTabWidths(natural: readonly number[], room: number): number[] {
  const count = natural.length;
  if (count === 0) return [];
  const total = natural.reduce((sum, width) => sum + width, 0);
  if (!(room > 0) || total >= room) return natural.slice();
  const fixed = new Set<number>();
  let left = room;
  let sharing = count;
  // Take out the options wider than an equal share of what is left, widest first, until the rest
  // all fit their share.
  const order = natural.map((width, index) => ({ width, index })).sort((a, b) => b.width - a.width);
  for (const item of order) {
    if (item.width <= left / sharing) break;
    fixed.add(item.index);
    left -= item.width;
    sharing -= 1;
  }
  const share = sharing > 0 ? left / sharing : 0;
  return natural.map((width, index) => (fixed.has(index) ? width : share));
}

/**
 * The scroll offset that shows `box` in a `viewport` points wide over `content` points of strip
 * scrolled to `offset`, moving as little as it must: an option already in full view leaves the
 * strip where it is; one cut by an edge comes in at that edge, `margin` points clear of it. An
 * option too wide to show with its margins is centred, and one wider than the viewport shows its
 * start, so the answer for a given box never depends on where the strip was (no back and forth).
 * Clamped to the content's ends.
 */
export function tabRevealOffset(box: TabBox, viewport: number, content: number, offset: number, margin = TAB_REVEAL_MARGIN): number {
  const max = Math.max(0, content - viewport);
  const clamp = (value: number) => Math.min(max, Math.max(0, value));
  if (!(viewport > 0) || max <= 0) return 0;
  if (box.w > viewport) return clamp(box.x);
  if (box.w + margin * 2 > viewport) return clamp(box.x - (viewport - box.w) / 2);
  const start = box.x - margin;
  const end = box.x + box.w + margin;
  if (box.x < offset) return clamp(start);
  if (box.x + box.w > offset + viewport) return clamp(end - viewport);
  return clamp(offset);
}

/** Whether `box` is wholly inside the viewport scrolled to `offset` (to `slack` points). */
export function tabInView(box: TabBox, viewport: number, offset: number, slack = TAB_OVERFLOW_SLACK): boolean {
  if (box.w > viewport) return Math.abs(box.x - offset) <= slack;
  return box.x >= offset - slack && box.x + box.w <= offset + viewport + slack;
}
