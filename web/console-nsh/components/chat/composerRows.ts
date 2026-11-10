// Whether the composer lays out in one row (add, field, actions) or two (the field above a row of
// the controls). Moving the field above the controls widens it, so a line that wraps beside the
// controls can fit one line above them. Decided from the field's own height, the answer changed the
// width it was measured at: the rows flipped on every layout pass. Keeping the one-row width above
// the controls stopped that, but showed a narrow field in the two-row layout until the text
// wrapped the full width too.
//
// So the rows come from the draft's height beside the controls, measured by a hidden copy of the
// field whose width does not depend on the rows (ComposerMeasure.tsx); a second copy measures it
// across the whole row, which is the height the field takes above the controls:
//
// - one line beside the controls (and no line break): one row;
// - more than that, or a line break: two rows, the field across the whole row at once, as tall as
//   the draft is there. That may be a single line: the decision is made beside the controls, so
//   the wider field cannot send the layout back.
//
// The same draft in the same window always gets the same layout, however it got there: typing,
// deleting, pasting, clearing, sending or resizing. Nothing holds a layout for an edit to come.
//
// The copies report after they have laid a new draft out. Until they have, their heights belong to
// an earlier draft, and a layout decided from them could move one way and straight back (cleared
// and retyped in one go, a draft restored before the first measure). So a draft not measured yet
// keeps the layout it has, except for what its text alone decides: empty is one row, a line break
// is two rows.
import { effect, LayoutAnimation, reduceMotion, type Accessor, type Signal, untracked } from "nsh";
import { COMPOSER_LINE_HEIGHT } from "./composerField";

/** `one`: add, the field, actions. `two`: the field across the row, above the controls. */
export type ComposerRows = "one" | "two";

/** The draft's laid-out height beside the controls (`oneRow`) and across the row (`twoRows`), and
 *  the draft they were measured for (`null`: not measured yet). */
export interface ComposerMeasures {
  oneRow: number;
  twoRows: number;
  text: string | null;
}

/** The rows, and the height of the text at the width the field takes in them. */
export interface ComposerLayout {
  rows: ComposerRows;
  height: number;
}

export const ONE_ROW: ComposerLayout = { rows: "one", height: COMPOSER_LINE_HEIGHT };

/** Whether a measured height is one line (a platform may measure a line a little taller). */
export function composerOneLine(height: number): boolean {
  return !(height > COMPOSER_LINE_HEIGHT * 1.5);
}

/** The layout for `text`, given its heights at the two widths and the layout shown now. An empty
 *  draft is one row at once; a line break is two lines or more at any width, so it is two rows at
 *  once too (headless engines measure a break as no break: it is held at two lines at least). */
export function composerLayout(text: string, measures: ComposerMeasures, current: ComposerLayout = ONE_ROW): ComposerLayout {
  if (text === "") return ONE_ROW;
  const lineBreak = text.includes("\n");
  const minimum = lineBreak ? 2 * COMPOSER_LINE_HEIGHT : COMPOSER_LINE_HEIGHT;
  if (measures.text !== text) {
    // Not measured yet: keep what shows, unless the text alone says otherwise.
    if (!lineBreak) return current;
    return { rows: "two", height: Math.max(current.rows === "two" ? current.height : 0, minimum) };
  }
  if (!lineBreak && composerOneLine(measures.oneRow)) return { rows: "one", height: measures.oneRow };
  return { rows: "two", height: Math.max(measures.twoRows, minimum) };
}

export function sameComposerLayout(a: ComposerLayout, b: ComposerLayout): boolean {
  return a.rows === b.rows && Math.abs(a.height - b.height) < 0.5;
}

/** Keeps `layout` on composerLayout's answer for the draft and its measures. The rows and the
 *  height change together. A change of rows snaps: eased, the field's frame would sweep from the
 *  one-row width to the full width and the text reflow on the way (nsh animates frames), the narrow
 *  in-between layout the two rows must never show. Above the controls the width stays, so a change
 *  of height that an edit made there eases (the Vue composer's height transition). Two more snap,
 *  as an eased commit eases every frame in it and would take other moves along (both seen in
 *  Chrome): a height that comes in before a change of rows has been drawn (a pasted draft's
 *  full-width height just after its rows: the field slid in from the one-row place), and a height
 *  that a new width made (a resize: the controls' row eased to its new width). */
export function followComposerLayout(layout: Signal<ComposerLayout>, text: Accessor<string>, measures: Accessor<ComposerMeasures>): void {
  let rowsMoving = 0;
  // The draft the layout shown was decided for.
  let shownFor = "";
  effect(() => {
    const draft = text();
    const measured = measures();
    untracked(() => {
      const current = layout();
      const next = composerLayout(draft, measured, current);
      if (sameComposerLayout(current, next)) return;
      if (next.rows !== current.rows) {
        if (rowsMoving) cancelAnimationFrame(rowsMoving);
        // Two frames: the one that lays the new rows out, and the one that draws them.
        rowsMoving = requestAnimationFrame(() => {
          rowsMoving = requestAnimationFrame(() => {
            rowsMoving = 0;
          });
        });
      } else if (!rowsMoving && draft !== shownFor && !reduceMotion()) {
        LayoutAnimation.configureNext({ duration: 180, update: { type: "easeInEaseOut" } });
      }
      shownFor = draft;
      layout.set(next);
    });
  });
}
