// Scroll edges (the Vue console's core/scroll-edges.js): an edge of a scroller that hides content
// fades it out, so the list reads as going on rather than cut off; an edge with nothing past it
// stays sharp. The content itself fades (a mask on the scroller), so whatever lies behind it,
// paper or a tint, shows through. The fade switches at once, never animates: animating a mask
// repaints the content every frame, and text renders a touch heavier while it does.
//
//   <EdgeScroll class="flex-1" contentClass="gap-2 p-4">…</EdgeScroll>
//
// or, on a scroller of your own (a `List` too):
//
//   const edges = createScrollEdges();
//   <Scroll {...edges.handlers} style={edges.style()}>
//     <View onLayout={edges.onContentLayout}>…</View>      // the content's size (Scroll reports
//   </Scroll>                                              // it only once scrolled)
//
// The state changes only when an edge appears or goes, so scrolling re-renders nothing; the
// scroll events it listens to are throttled. Masks are drawn by the web backend only (the
// desktop GPUI build ignores `maskImage`): there the edges stay sharp.
import type { JSX, ScrollRef } from "nsh";
import { platform, Scroll, signal, View } from "nsh";
import type { ScrollbarTheme } from "nsh/base";

const CAN_MASK = platform.os === "web";

/**
 * The console's scroll bars (styles/base.css): thin hairline thumbs that show while the pointer is
 * over the area (or it scrolls) and rest invisible otherwise, over the content so nothing shifts.
 * `scrollbar={SCROLLBAR}` on any `Scroll` or `List`; `EdgeScroll` uses it.
 */
export const SCROLLBAR: ScrollbarTheme = {
  mode: "hover",
  motion: { idle: 900, enter: 120, exit: 180 },
  minThumbLength: 32,
  vertical: { class: "absolute inset-y-0 right-0 w-2 p-0.5", thumbClass: "rounded-full bg-line" },
  horizontal: { class: "absolute inset-x-0 bottom-0 h-2 p-0.5", thumbClass: "rounded-full bg-line" },
};

export interface ScrollEdges {
  /** Spread on the scroller: `onScroll`, `onLayout`, `scrollEventThrottle`. */
  handlers: {
    onScroll: (event: { offset: { x: number; y: number }; size: { width: number; height: number }; contentSize: { width: number; height: number } }) => void;
    onLayout: (event: { bounds: { size: { width: number; height: number } } }) => void;
    scrollEventThrottle: number;
  };
  /** `onLayout` of the content (one view holding it all), for the end edge before any scroll. */
  onContentLayout: (event: { bounds: { size: { width: number; height: number } } }) => void;
  /** Content hidden past the start edge (scrolled). */
  scrolled: () => boolean;
  /** Content hidden past the end edge. */
  more: () => boolean;
  /** `{ maskImage }` for the scroller's style (empty while both edges are sharp). */
  style: () => { maskImage?: string };
}

/** Edge state for a scroller. `fade`: the fade's length (22 points); `start` / `end`: false to keep that edge sharp (a pinned head above it draws its own hairline). */
export function createScrollEdges(options: { fade?: number; start?: boolean; end?: boolean; horizontal?: boolean } = {}): ScrollEdges {
  const scrolled = signal(false);
  const more = signal(false);
  const viewport = signal(0);
  let offset = 0;
  let contentLength = 0;
  let viewportLength = 0;
  const axis = (point: { x: number; y: number } | { width: number; height: number }) =>
    "x" in point ? (options.horizontal ? point.x : point.y) : options.horizontal ? point.width : point.height;
  const refresh = () => {
    const nextScrolled = offset > 1;
    const nextMore = offset + viewportLength < contentLength - 1;
    if (nextScrolled !== scrolled()) scrolled.set(nextScrolled);
    if (nextMore !== more()) more.set(nextMore);
  };
  const fade = options.fade ?? 22;
  return {
    handlers: {
      onScroll(event) {
        offset = axis(event.offset);
        viewportLength = axis(event.size);
        contentLength = axis(event.contentSize);
        refresh();
      },
      onLayout(event) {
        viewportLength = axis(event.bounds.size);
        if (Math.abs(viewport() - viewportLength) > 0.5) viewport.set(viewportLength);
        refresh();
      },
      scrollEventThrottle: 50,
    },
    onContentLayout(event) {
      contentLength = axis(event.bounds.size);
      refresh();
    },
    scrolled: () => scrolled(),
    more: () => more(),
    style: () => {
      const start = options.start !== false && scrolled();
      const end = options.end !== false && more();
      const length = viewport();
      if (!CAN_MASK || (!start && !end) || length <= 0) return {};
      // Stops in points along the scroller (gradients take no calc()); a sharp edge has none.
      const head = start ? `transparent 0px, #000 ${fade}px` : "#000 0px";
      const tail = end ? `#000 ${Math.max(start ? fade : 0, length - fade)}px, transparent ${length}px` : `#000 ${length}px`;
      return { maskImage: `linear-gradient(${options.horizontal ? "to right" : "to bottom"}, ${head}, ${tail})` };
    },
  };
}

/** A `Scroll` whose hidden edges fade. Takes Scroll's common props; `fade`, `start`, `end` as `createScrollEdges`. */
export function EdgeScroll(props: {
  class?: string;
  contentClass?: string;
  style?: Record<string, unknown>;
  horizontal?: boolean;
  fade?: number;
  start?: boolean;
  end?: boolean;
  testID?: string;
  ref?: (ref: ScrollRef) => void;
  onScroll?: (event: { offset: { x: number; y: number }; size: { width: number; height: number }; contentSize: { width: number; height: number } }) => void;
  children?: JSX.Element;
}) {
  const edges = createScrollEdges({ fade: props.fade, start: props.start, end: props.end, horizontal: props.horizontal });
  return (
    <Scroll
      ref={(node: ScrollRef) => props.ref?.(node)}
      testID={props.testID}
      horizontal={props.horizontal}
      scrollbar={SCROLLBAR}
      class={props.class}
      contentClass="grow"
      onScroll={(event) => {
        edges.handlers.onScroll(event);
        props.onScroll?.(event);
      }}
      onLayout={edges.handlers.onLayout}
      scrollEventThrottle={edges.handlers.scrollEventThrottle}
      style={{ ...(props.style ?? {}), ...edges.style() }}
    >
      <View class={`grow ${props.contentClass ?? ""}`} onLayout={edges.onContentLayout}>
        {props.children}
      </View>
    </Scroll>
  );
}
