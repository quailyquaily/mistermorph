// Sliding selection (the Vue console's core/sliding-selection.js): one highlight behind a list
// that glides from the selected item to the next, instead of each item lighting up on its own.
//
//   const sel = createSlidingSelection(() => activeId());
//   <View class="relative">                         // the items' own parent
//     <sel.Highlight class="bg-selection" />        // first child, behind the items
//     <Each of={items()} key={(i) => i.id}>
//       {(item) => <Row onLayout={sel.track(item().id)} ... />}   // no selected fill of its own
//     </Each>
//   </View>
//
// Why it is built this way: animating a highlight's top/height re-lays it out on every frame, which
// stutters exactly while the click is also rendering a new page. So it is a FLIP: the highlight
// takes the new item's box at once (its width and height), and only a transform (translate and
// scale from the old box, mid-glide included) animates, natively. Items report their frames with
// `onLayout` (bounds in their parent), so the items must be children of the view that holds the
// highlight. The first placement, a selection after none and reduced motion set it in place
// without motion; a change of the selected item's own frame (a resize, the sidebar folding)
// follows at once unless a glide is in flight.
import type { JSX } from "nsh";
import { batch, cleanup, createAnimatedValue, effect, signal, untracked, View } from "nsh";
import { easeProgress, MOTION_EASE, MOTION_FAST, MOTION_SLOW, motionMs } from "./tokens";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlidingSelection {
  /** `onLayout` of the item `id`: `<Row onLayout={sel.track(id)} />`. */
  track(id: string): (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
  /** Reports the item's box yourself (in the highlight's parent), e.g. a virtualized row by index.
   *  `glide`: the item itself is moving there (a grid making room), so the highlight glides along
   *  with it, over `glide` ms, instead of following at once. */
  place(id: string, box: Box, glide?: number): void;
  /** Forgets an item that is gone. */
  forget(id: string): void;
  /** The highlight: the first child of the items' parent; style its fill and corners with `class`. */
  Highlight: (props: { class?: string; testID?: string }) => JSX.Element;
}

function sameBox(a: Box | null, b: Box | null) {
  return (
    !!a &&
    !!b &&
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}

/**
 * A sliding selection following `selected()` (an item id, or nothing). `duration` defaults to the
 * slow motion token (260 ms).
 */
export function createSlidingSelection(
  selected: () => string | null | undefined,
  options: { duration?: number } = {},
): SlidingSelection {
  const boxes = new Map<string, Box>();
  const x = createAnimatedValue(0);
  const y = createAnimatedValue(0);
  const sx = createAnimatedValue(1);
  const sy = createAnimatedValue(1);
  // The box the highlight takes at rest: its width and height are set at once.
  const rest = signal<Box | null>(null);
  let restBox: Box | null = null;
  let shownId: string | null = null;
  let glide: { from: Box; to: Box; start: number; duration: number } | null = null;
  let disposed = false;

  // Where the highlight is drawn now: mid-glide, between the boxes; at rest, its box.
  const visibleBox = (now: number): Box | null => {
    if (!restBox) return null;
    if (!glide) return restBox;
    const t = (now - glide.start) / glide.duration;
    if (t >= 1) {
      glide = null;
      return restBox;
    }
    const p = easeProgress(Math.max(0, t));
    const { from, to } = glide;
    return {
      x: from.x + (to.x - from.x) * p,
      y: from.y + (to.y - from.y) * p,
      w: from.w + (to.w - from.w) * p,
      h: from.h + (to.h - from.h) * p,
    };
  };

  const setAt = (box: Box) => {
    x.set(box.x);
    y.set(box.y);
    sx.set(1);
    sy.set(1);
  };

  const update = (follow = 0) => {
    if (disposed) return;
    const id = untracked(selected) || null;
    const box = id ? boxes.get(id) || null : null;
    if (!box || box.w <= 0 || box.h <= 0) {
      glide = null;
      restBox = null;
      shownId = null;
      rest.set(null);
      return;
    }
    if (id === shownId && sameBox(restBox, box)) return;
    const now = performance.now();
    const from = visibleBox(now);
    const duration = motionMs(follow || (options.duration ?? MOTION_SLOW));
    const glides = !!from && duration > 0 && (id !== shownId || glide !== null || follow > 0);
    restBox = box;
    shownId = id;
    if (!glides || !from) {
      glide = null;
      batch(() => rest.set(box));
      setAt(box);
      return;
    }
    glide = { from, to: box, start: now, duration };
    batch(() => rest.set(box));
    // From where it is now, in the new box's terms, to the new box.
    x.set(from.x);
    y.set(from.y);
    sx.set(from.w / box.w);
    sy.set(from.h / box.h);
    const timing = { duration, easing: MOTION_EASE };
    void x.timing(box.x, timing);
    void y.timing(box.y, timing);
    void sx.timing(1, timing);
    void sy.timing(1, timing);
  };

  effect(() => {
    void selected();
    untracked(() => update());
  });
  cleanup(() => {
    disposed = true;
  });

  const place = (id: string, box: Box, follow = 0) => {
    const known = boxes.get(id);
    if (sameBox(known || null, box)) return;
    boxes.set(id, box);
    if (id === (untracked(selected) || null)) update(follow);
  };

  return {
    track: (id: string) => (event) => {
      const { origin, size } = event.bounds;
      place(id, { x: origin.x, y: origin.y, w: size.width, h: size.height });
    },
    place,
    forget(id: string) {
      boxes.delete(id);
      if (id === (untracked(selected) || null)) update();
    },
    Highlight(props: { class?: string; testID?: string }) {
      return (
        <View
          accessibilityElementsHidden
          testID={props.testID}
          class={`absolute left-0 top-0 ${props.class ?? ""}`}
          style={{
            pointerEvents: "none",
            width: rest()?.w ?? 0,
            height: rest()?.h ?? 0,
            opacity: rest() ? 1 : 0,
            transitionProperty: "opacity",
            transitionDuration: motionMs(MOTION_FAST),
            transformOrigin: [0, 0],
            transform: [{ translateX: x }, { translateY: y }, { scaleX: sx }, { scaleY: sy }],
          }}
        />
      );
    },
  };
}
