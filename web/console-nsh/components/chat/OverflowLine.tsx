// A run of progress or coder output laid out without wrapping (a tool's name, a parameter, a
// nested call, a worker's process): as wide as the run, never wider than the room it is given. A
// run longer than its room scrolls sideways instead of being cut at the panel's edge or widening
// the panel; its scroll bar is the platform's (the app's theme on the desktops and the web, the
// system's on phones), never hidden, with room kept under the run so the bar covers no letters.
//
// A run that fits is a plain row, not a scroller: on the web every nsh 0.4 scroller (even one that
// cannot scroll) contains its overscroll, so a vertical swipe that starts on it would not scroll
// the panel around it. Only a run that overflows pays for that. The run is measured at its own
// width either way (it never shrinks), so the choice cannot feed back on itself.
//
// Only for runs that do not wrap: text that wraps (notes, output, errors) goes beside it, not in
// it, since a sideways scroller gives its content all the width it asks for.
//
// Under `OverflowWraps` (the workbench, which keeps one scroll area: its own) a run wraps instead,
// and no line is ever a scroller.
import type { JSX } from "nsh";
import { context, Scroll, signal, untracked, View } from "nsh";

/** Runs wrap at the room's edge instead of scrolling sideways (a panel with one scroll area). */
export const OverflowWraps = context<boolean>(false);

export interface OverflowLineFrame {
  /** One per line, for as long as it is mounted. */
  line: number;
  testID: string;
  /** The line's width: the room it takes. */
  viewport: number;
  /** The run's own width. */
  content: number;
  /** How far it is scrolled sideways. */
  offset: number;
  /** Whether it is a scroller now (the run is longer than its room). */
  scrolls: boolean;
}

let probe: ((frame: OverflowLineFrame) => void) | null = null;
let lines = 0;

/** Test fixtures hear every line's widths and offset here (null to stop). */
export function probeOverflowLines(listener: ((frame: OverflowLineFrame) => void) | null) {
  probe = listener;
}

export function OverflowLine(props: { class?: string; contentClass?: string; testID?: string; children?: JSX.Element }) {
  if (OverflowWraps()) {
    return (
      <View class={`max-w-full shrink ${props.class ?? ""}`} testID={props.testID}>
        <View class={`shrink flex-wrap ${props.contentClass ?? ""}`}>{props.children}</View>
      </View>
    );
  }
  const line = ++lines;
  const frame = { viewport: 0, content: 0, offset: 0 };
  const scrolls = signal(false);
  const report = () => {
    if (frame.viewport > 0 && frame.content > 0) scrolls.set(frame.content > frame.viewport + 0.5);
    if (!untracked(scrolls)) frame.offset = 0;
    probe?.({ line, testID: props.testID ?? "", ...frame, scrolls: untracked(scrolls) });
  };
  const viewport = (width: number) => {
    frame.viewport = width;
    report();
  };
  const content = (width: number) => {
    frame.content = width;
    report();
  };
  const outer = () => `max-w-full shrink ${props.class ?? ""}`;
  return (
    <If
      when={scrolls()}
      else={
        <View class={`${outer()} flex-row overflow-hidden`} testID={props.testID} onLayout={(e) => viewport(e.bounds.size.width)}>
          <View class={`shrink-0 ${props.contentClass ?? ""}`} onLayout={(e) => content(e.bounds.size.width)}>
            {props.children}
          </View>
        </View>
      }
    >
      <Scroll
        horizontal
        class={outer()}
        testID={props.testID}
        scrollEventThrottle={50}
        onLayout={(e) => viewport(e.bounds.size.width)}
        onScroll={(e) => {
          frame.offset = e.offset.x;
          report();
        }}
      >
        <View class={`pb-1.5 ${props.contentClass ?? ""}`} onLayout={(e) => content(e.bounds.size.width)}>
          {props.children}
        </View>
      </Scroll>
    </If>
  );
}
