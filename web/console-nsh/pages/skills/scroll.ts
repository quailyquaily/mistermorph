import type { ScrollRef, ViewRef } from "nsh";

/**
 * Scrolls `scroll` the least that brings `target` into view (the DOM's
 * scrollIntoView({ block: "nearest" })). `offset` is the scroll view's content offset now and
 * `viewport` its height, both from its onScroll / onLayout. `inset` is the room at the scroll
 * view's top that a bar covers (components/frame/glassBar.tsx `barRoom()`): the target is brought
 * clear of it.
 */
export async function scrollIntoViewNearest(scroll: ScrollRef | undefined, target: ViewRef | undefined, offset: number, viewport: number, inset = 0) {
  if (!scroll || !target || viewport <= 0) return;
  const [outer, inner] = await Promise.all([scroll.measure(), target.measure()]);
  if (!outer || !inner) return;
  const top = inner.pagePosition.y - outer.pagePosition.y;
  const bottom = top + inner.bounds.size.height;
  if (top < inset) {
    scroll.scrollTo({ y: Math.max(0, offset + top - inset), animated: true });
  } else if (bottom > viewport) {
    scroll.scrollTo({ y: offset + Math.min(top - inset, bottom - viewport), animated: true });
  }
}
