// Whether the composer lays out in one row (add, field, actions) or two (the field above a row of
// the controls), and how wide its text is. Moving the field above the controls widens it, so a line
// that wraps beside the controls can fit one line above them. Decided from the field's own height,
// the answer changed the width it was measured at: the rows flipped on every layout pass, or, held
// one way per edit, the taller two-row layout showed a single line of text until the line was long
// enough to wrap the wider field too.
//
// So the rows come from the draft's height at both widths, measured by hidden copies of the field
// whose widths do not depend on the rows (ComposerMeasure.tsx):
//
// - one line beside the controls: one row;
// - more than that, but one line above them: two rows, with the text still as wide as beside the
//   controls, so it shows on the lines it took there (the two-row layout never holds one line);
// - more than one line above the controls too (a long line), or a line break: two rows at the full
//   width, where the text also takes two lines or more.
//
// The same draft in the same window always gets the same layout, however it got there: typing,
// deleting, pasting, clearing, sending or resizing. Nothing holds a layout for an edit to come.
import { COMPOSER_LINE_HEIGHT } from "./composerField";

/** `one`: one row. `narrow`: two rows, the text as wide as on one row. `wide`: two rows, full width. */
export type ComposerRows = "one" | "narrow" | "wide";

/** The draft's laid-out height beside the controls (`oneRow`) and above them (`twoRows`). */
export interface ComposerMeasures {
  oneRow: number;
  twoRows: number;
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

/** The layout for `text`, given its heights at the two widths. An empty draft is one row at once; a
 *  line break is two lines or more at any width, so it takes the full width at once too. */
export function composerLayout(text: string, measures: ComposerMeasures): ComposerLayout {
  if (text === "") return ONE_ROW;
  const lineBreak = text.includes("\n");
  if (!lineBreak && composerOneLine(measures.oneRow)) return { rows: "one", height: measures.oneRow };
  if (!lineBreak && composerOneLine(measures.twoRows)) return { rows: "narrow", height: measures.oneRow };
  return { rows: "wide", height: lineBreak ? Math.max(measures.twoRows, 2 * COMPOSER_LINE_HEIGHT) : measures.twoRows };
}

export function sameComposerLayout(a: ComposerLayout, b: ComposerLayout): boolean {
  return a.rows === b.rows && Math.abs(a.height - b.height) < 0.5;
}
