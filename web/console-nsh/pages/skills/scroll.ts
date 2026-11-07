import type { ScrollRef, ViewRef } from "nsh";

/**
 * Scrolls `scroll` the least that brings `target` into view (the DOM's
 * scrollIntoView({ block: "nearest" })). `offset` is the scroll view's content offset now and
 * `viewport` its height, both from its onScroll / onLayout.
 */
export async function scrollIntoViewNearest(scroll: ScrollRef | undefined, target: ViewRef | undefined, offset: number, viewport: number) {
  if (!scroll || !target || viewport <= 0) return;
  const [outer, inner] = await Promise.all([scroll.measure(), target.measure()]);
  if (!outer || !inner) return;
  const top = inner.pagePosition.y - outer.pagePosition.y;
  const bottom = top + inner.bounds.size.height;
  if (top < 0) {
    scroll.scrollTo({ y: Math.max(0, offset + top), animated: true });
  } else if (bottom > viewport) {
    scroll.scrollTo({ y: offset + Math.min(top, bottom - viewport), animated: true });
  }
}
