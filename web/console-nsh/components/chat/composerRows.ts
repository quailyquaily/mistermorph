// Whether the composer lays out in one row (add, field, actions) or two (the field above a row of
// the controls). The answer changes the field's width, and the width changes how many lines the
// text takes: a line that wraps beside the controls can fit on the wider field above them. Deciding
// from the measured height alone flips the layout on every layout pass for such a line, rebuilding
// the controls each time; on a phone that runs until the page runs out of memory. So the switch is
// one way per edit: text that wraps moves the field up, and it comes back down only once the text
// fits one line, has no line break, and is shorter than when it moved up (or is empty). Coming
// back down then always takes an edit, never just a layout.

export interface ComposerRows {
  multi: boolean;
  /** The draft's length when the field moved above the controls. */
  enteredAt: number;
}

export const SINGLE_ROW: ComposerRows = { multi: false, enteredAt: 0 };

/** The rows for `text`, given whether its laid-out height is one line at the current width. */
export function nextComposerRows(rows: ComposerRows, text: string, oneLine: boolean): ComposerRows {
  if (!rows.multi) return oneLine ? rows : { multi: true, enteredAt: text.length };
  if (text === "") return SINGLE_ROW;
  if (oneLine && !text.includes("\n") && text.length < rows.enteredAt) return SINGLE_ROW;
  return rows;
}
