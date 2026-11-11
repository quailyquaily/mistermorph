// A workspace path on one line of the panel (components/chat/workspacePath.ts writes it): whole
// when it fits, else cut in the middle with "...", its beginning and its end kept. It never wraps
// and never runs past the panel: the text is laid out at its own width (it never shrinks, so it
// cannot wrap) in a row that clips it.
//
// The cut is worked out from widths nsh lays out, on every platform the same way: the row's (the
// room), and the whole path's at its own width, written once more out of sight (`measure`). The
// font is monospace, so the path's width over its cells gives a cell's width, and the room a
// number of cells. A line still too wide once laid out (wide characters in a fallback font) takes
// off cells until it fits. A new path or a new room (the panel resized) starts over.
import { computed, signal, Text, untracked, View, type JSX } from "nsh";
import { fitPath, textUnits, unitsThatFit, type FittedPath } from "./workspacePath";

export interface PathLineFrame {
  testID: string;
  /** The row's width: the room the line has. */
  room: number;
  /** The whole path's width, at its own width. */
  fullWidth: number;
  /** The width of what the line shows, at its own width. */
  shownWidth: number;
  /** Its height: one line's. */
  shownHeight: number;
  /** The whole path's height at its own width: one line's. */
  fullHeight: number;
  /** What the line shows. */
  text: string;
  truncated: boolean;
}

let probe: ((frame: PathLineFrame) => void) | null = null;

/** Test fixtures hear every line's widths and text here (null to stop). */
export function probePathLines(listener: ((frame: PathLineFrame) => void) | null) {
  probe = listener;
}

/** A width laid out within half a point of the room fits it (frames are fractional on some platforms). */
const SLACK = 0.5;

export function WorkspacePathLine(props: {
  /** The path as the line writes it (`abbreviateHomePath`). */
  path: string;
  /** Where its last part starts (code points), drawn stronger than the folders before it. */
  leafStart: number;
  /** The text's classes: its font (monospace), size and line height. */
  textClass: string;
  /** What screen readers read: the raw path. */
  accessibilityLabel?: string;
  tooltip?: JSX.Element;
  testID?: string;
}) {
  const room = signal(0);
  // Every width is kept with the text it was laid out for: a report can arrive after the text
  // changed (a new path, a new cut), and must not count for the new one.
  const full = signal({ path: "", width: 0, height: 0 });
  let shown = { text: "", width: 0, height: 0 };
  // Cells taken off a laid-out line still too wide, for the path, room and width they were for.
  const extra = signal({ key: "", units: 0 });
  const fullWidth = () => (full().path === props.path ? full().width : 0);
  const key = () => `${room()}\u0000${fullWidth()}\u0000${props.path}`;
  const maxUnits = (): number | null => {
    const width = fullWidth();
    if (!(room() > 0) || !(width > room() + SLACK)) return null;
    const units = unitsThatFit(room(), props.path, width);
    if (units === null) return null;
    const taken = extra();
    return units - (taken.key === key() ? taken.units : 0);
  };
  const fitted = computed<FittedPath>(() => fitPath(props.path, props.leafStart, maxUnits()));

  const report = () => {
    probe?.({
      testID: props.testID ?? "",
      room: untracked(room),
      fullWidth: untracked(fullWidth),
      shownWidth: shown.width,
      shownHeight: shown.height,
      fullHeight: untracked(full).height,
      text: untracked(fitted).text,
      truncated: untracked(fitted).truncated,
    });
  };
  // A cut line laid out wider than the room: take off at least the cells it runs over, more until
  // the text changes (so it is laid out again), down to a cell on each side of the ellipsis.
  const settle = () => {
    const now = untracked(fitted);
    const space = untracked(room);
    const max = untracked(maxUnits);
    if (!now.truncated || shown.text !== now.text || max === null || !(shown.width > space + SLACK)) return;
    const cell = untracked(fullWidth) / Math.max(1, textUnits(props.path));
    let units = Math.max(1, Math.ceil((shown.width - space) / cell));
    while (max - units > 5 && fitPath(props.path, props.leafStart, max - units).text === now.text) units += 1;
    const taken = untracked(extra);
    const sameKey = taken.key === untracked(key);
    extra.set({ key: untracked(key), units: (sameKey ? taken.units : 0) + units });
  };

  return (
    <View class="relative overflow-hidden">
      <View
        selectable
        tooltip={props.tooltip}
        class="flex-row overflow-hidden"
        onLayout={(e) => {
          room.set(e.bounds.size.width);
          settle();
          report();
        }}
      >
        {/* A view per text, so its layout reports name the text they measured. */}
        <Each of={[fitted()]} key={(line) => line.text}>
          {(line) => {
            const text = line().text;
            return (
              <View
                class="shrink-0"
                onLayout={(e) => {
                  shown = { text, width: e.bounds.size.width, height: e.bounds.size.height };
                  settle();
                  report();
                }}
              >
                <Text class={props.textClass} accessibilityLabel={props.accessibilityLabel} testID={props.testID}>
                  <Each of={line().runs} key={(run) => (run.strong ? "strong" : "muted")}>
                    {(run) => <Text class={run().strong ? "text-foreground" : "text-muted-foreground"}>{run().text}</Text>}
                  </Each>
                </Text>
              </View>
            );
          }}
        </Each>
      </View>
      <View
        class="absolute left-0 top-0 flex-row opacity-0"
        style={{ width: 100000, pointerEvents: "none" }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Each of={[props.path]} key={(path) => path}>
          {(path) => {
            const text = path();
            return (
              <View
                class="shrink-0"
                onLayout={(e) => {
                  full.set({ path: text, width: e.bounds.size.width, height: e.bounds.size.height });
                  report();
                }}
              >
                <Text class={props.textClass}>{text}</Text>
              </View>
            );
          }}
        </Each>
      </View>
    </View>
  );
}
