// An opt-in layout probe for tests: a list hears where its parts lie on the page (`onPartLayout`),
// so a fixture can check their geometry (tests/topic-status-alignment.test.tsx). With no listener
// it adds nothing to the views. Buttons that take no ref (nsh/base `Button`, `TipButton`) are
// placed from their `onLayout` bounds inside a parent that is measured (`report` with `inner`).
import type { ViewRef } from "nsh";

/** A part's frame on the page. */
export type PartFrame = { x: number; y: number; w: number; h: number };

export type PartLayoutListener = (name: string, frame: PartFrame) => void;

export type LayoutBounds = { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } };

/** A frame from `onLayout` bounds (relative to the view's parent). */
export const boundsFrame = (event: LayoutBounds): PartFrame => ({
  x: event.bounds.origin.x,
  y: event.bounds.origin.y,
  w: event.bounds.size.width,
  h: event.bounds.size.height,
});

export function createPartProbe(listener: () => PartLayoutListener | undefined) {
  /** Reports `node`'s frame on the page, or, with `inner`, that frame within `node` placed on the page. */
  const report = (name: string, node: ViewRef | undefined, inner?: () => PartFrame | undefined) => {
    if (!listener() || !node) return;
    node
      .measure()
      .then((m) => {
        if (!m) return;
        const at = { x: m.pagePosition.x, y: m.pagePosition.y };
        if (!inner) {
          listener()?.(name, { ...at, w: m.bounds.size.width, h: m.bounds.size.height });
          return;
        }
        const frame = inner();
        if (frame) listener()?.(name, { x: at.x + frame.x, y: at.y + frame.y, w: frame.w, h: frame.h });
      })
      .catch((error) => console.warn("part probe: measure failed", error));
  };
  /** Props for a view that reports its own frame as `name()` (none when nobody listens, or the name is null). */
  const probe = (name: () => string | null) => {
    if (!listener()) return {};
    let node: ViewRef | undefined;
    return {
      ref: (value: ViewRef) => {
        node = value;
      },
      onLayout: () => {
        const part = name();
        if (part) report(part, node);
      },
    };
  };
  return { report, probe };
}
