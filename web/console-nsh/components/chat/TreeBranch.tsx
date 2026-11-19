// A tree's connector, drawn with views beside each row (ChatProcessTree's processes, the nested
// calls of ChatStatusCard's ActivityCallTree), never with box-drawing glyphs: glyphs in a line of
// text break wherever the row's content wraps or adds lines of its own (a long command, a shell
// call's output, a node's descendants, the gap between rows).
//
// A row is `flex-row`: this column, then the row's content (its header, what is shown under it,
// its children's rows, which draw their own column one level in). The column takes the row's
// whole height, so a row that is not its parent's last carries the trunk down past everything it
// shows into the next row; the last stops at its branch. Rows own the room between them (padding
// inside the row, never a gap between siblings), so trunks meet. The strokes are decoration: they
// take no presses and are hidden from assistive tech.
import type { ViewRef } from "nsh";
import { cleanup, View } from "nsh";
import type { PartFrame } from "../shared/partProbe";
import { NEON } from "./TerminalText";

/** How far each level of a tree is indented: the connector's column. */
export const TREE_INDENT = 20;
/** Where the trunk stands in its column (its left edge), and how thick the strokes are. */
export const TREE_TRUNK_X = 3;
export const TREE_STROKE = 1;
/** Where a branch ends: the rest of the column is the gap before the row's header. */
export const TREE_BRANCH_END = 15;

/** The top of a branch drawn on `mid`, the header line's middle (whole points: a crisp stroke). */
export function treeBranchTop(mid: number) {
  return Math.floor(mid - TREE_STROKE / 2);
}

type Probed = { node?: ViewRef; name: () => string };
let probeOn = false;
const probed = new Set<Probed>();

/** Test fixtures turn on reporting where the tree's parts lie (before they mount) and read them
 *  with `measureTreeParts`. */
export function probeTreeParts(on: boolean) {
  probeOn = on;
  if (!on) probed.clear();
}

/** Props for a view of a tree whose frame `measureTreeParts` reports as `name()` (none unless a
 *  fixture probes). Names: `row:<id>`, `mark:<id>` (what the branch points at), `trunk:<id>`,
 *  `branch:<id>`, `content:<id>`. */
export function treePart(name: () => string) {
  if (!probeOn) return {};
  const entry: Probed = { name };
  probed.add(entry);
  cleanup(() => probed.delete(entry));
  return {
    ref: (value: ViewRef) => {
      entry.node = value;
    },
  };
}

/** Where every probed part of the trees on screen lies on the page now. */
export async function measureTreeParts(): Promise<Record<string, PartFrame>> {
  const frames: Record<string, PartFrame> = {};
  await Promise.all(
    [...probed].map(async (entry) => {
      const measured = await entry.node?.measure().catch(() => undefined);
      if (!measured) return;
      frames[entry.name()] = {
        x: measured.pagePosition.x,
        y: measured.pagePosition.y,
        w: measured.bounds.size.width,
        h: measured.bounds.size.height,
      };
    }),
  );
  return frames;
}

/**
 * A row's connector column. `mid`: the middle of the row's header line, from the row's top (its
 * padding included). `last`: the parent's last row, whose trunk ends at its branch. `elided`: a
 * row standing for rows not shown (a dashed trunk on to the next row, no branch). `id` names the
 * parts for `measureTreeParts`.
 */
export function TreeBranch(props: { mid: number; last: boolean; elided?: boolean; id?: string }) {
  const top = () => treeBranchTop(props.mid);
  return (
    <View
      class="shrink-0 self-stretch"
      style={{ width: TREE_INDENT, pointerEvents: "none" }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <If
        when={props.elided}
        else={
          <>
            <View
              class="absolute top-0"
              style={{
                left: TREE_TRUNK_X,
                width: TREE_STROKE,
                ...(props.last ? { height: top() + TREE_STROKE } : { bottom: 0 }),
                backgroundColor: NEON.idle,
              }}
              {...treePart(() => `trunk:${props.id ?? ""}`)}
            />
            <View
              class="absolute"
              style={{ left: TREE_TRUNK_X, top: top(), width: TREE_BRANCH_END - TREE_TRUNK_X, height: TREE_STROKE, backgroundColor: NEON.idle }}
              {...treePart(() => `branch:${props.id ?? ""}`)}
            />
          </>
        }
      >
        <View
          class="absolute bottom-0 top-0 border-l border-dashed"
          style={{ left: TREE_TRUNK_X, width: TREE_STROKE, borderColor: NEON.idle }}
          {...treePart(() => `trunk:${props.id ?? ""}`)}
        />
      </If>
    </View>
  );
}
