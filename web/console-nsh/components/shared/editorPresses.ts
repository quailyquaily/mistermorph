// Presses on an nsh/base Editor that its rows do not take, handled by a view around it.
//
// The Editor's rows take presses only over the text. Its padding (`classes.content`) and the room
// below the last line (`scrollBeyondLastLine={false}`: the rows are as tall as the text) take none,
// so a click there neither focuses it nor places the caret. On the desktops the console's hover-mode
// scroll bars (`Scrollbar.setTheme(SCROLLBAR)` in App.tsx) also give the Editor's hidden one-point
// caret field a bar of its own, 8pt wide and invisible, that takes the presses on the 7pt left of the
// caret: the second click of a double click lands there, so it never selected the word, and a drag
// begun there never selected. Presses there reach the view around the Editor, which places the caret
// as the rows would: a double click selects the word, a triple click the line, Shift extends, a drag
// selects.
//
// nsh 0.4.0's EditorRef has no position for a point, only the boxes of carets (`rangeBounds` of an
// empty range), so the point is found among those: its line, its row (a wrapped line has several),
// then the caret place nearest to it.
import type { MouseEvent, PressEvent } from "nsh";
import type { EditorPosition, EditorRange, EditorRef } from "nsh/base";

/** A caret's place in the editor's box (its top, and the row's height). */
export interface CaretBox {
  x: number;
  y: number;
  height: number;
}

/** The box of the caret at `position`, `null` while the editor is not laid out. */
export type CaretAt = (position: EditorPosition) => Promise<CaretBox | null>;

/** Probes per round: each round's carets are asked for together (one round trip). */
const FANOUT = 8;

/** The width of the console's vertical scroll bar (`SCROLLBAR`'s `w-2`): presses there are the bar's. */
export const SCROLLBAR_WIDTH = 8;

/**
 * The last index in `[lo, hi]` for which `holds` is true, where it is true up to some index and
 * false after; `lo - 1` when it holds nowhere. Searched FANOUT points at a time.
 */
export async function lastWhere(lo: number, hi: number, holds: (index: number) => Promise<boolean>): Promise<number> {
  let found = lo - 1;
  let from = lo;
  let to = hi;
  while (from <= to) {
    const step = Math.max(1, Math.ceil((to - from + 1) / FANOUT));
    const probes: number[] = [];
    for (let index = from; index <= to; index += step) probes.push(index);
    const results = await Promise.all(probes.map((index) => holds(index)));
    let last = -1;
    for (let i = 0; i < probes.length && results[i]; i += 1) last = i;
    if (last < 0) return found;
    found = probes[last];
    if (step === 1) return found;
    from = probes[last] + 1;
    to = last + 1 < probes.length ? probes[last + 1] - 1 : to;
  }
  return found;
}

/** `column` moved off the middle of a surrogate pair (to the character's start). */
function boundary(text: string, column: number) {
  const code = text.charCodeAt(column - 1);
  return column > 0 && column < text.length && code >= 0xd800 && code <= 0xdbff ? column - 1 : column;
}

/**
 * The caret place nearest to `point` (in the editor's box) in `text`: below the last row, the
 * text's end; above the first, on the first row; left or right of a row, its start or end.
 * `visible`, the range the viewport shows, narrows the search for the line.
 */
export async function positionAt(
  text: string,
  point: { x: number; y: number },
  caretAt: CaretAt,
  visible?: EditorRange | null,
): Promise<EditorPosition> {
  const lines = text.split("\n");
  const last = lines.length - 1;
  const end = { line: last, column: lines[last].length };
  const endBox = await caretAt(end);
  if (!endBox || point.y >= endBox.y + endBox.height) return end;
  const top = async (position: EditorPosition) => (await caretAt(position))?.y ?? Number.POSITIVE_INFINITY;
  const left = async (position: EditorPosition) => (await caretAt(position))?.x ?? Number.POSITIVE_INFINITY;
  // Above the first row (the top padding): on the first row.
  const y = Math.max(point.y, await top({ line: 0, column: 0 }));
  const above = (position: EditorPosition) => top(position).then((rowY) => rowY <= y);
  // The line: the last one starting at or above the point.
  const first = Math.max(0, Math.min(last, visible?.start.line ?? 0));
  const final = Math.max(first, Math.min(last, visible?.end.line ?? last));
  const from = (await above({ line: first, column: 0 })) ? first : 0;
  const line = Math.max(0, await lastWhere(from, final, (index) => above({ line: index, column: 0 })));
  const source = lines[line];
  // Its row: the last whose top is at or above the point, from the first caret place on it.
  const rowEnd = Math.max(0, await lastWhere(0, source.length, (column) => above({ line, column })));
  const rowTop = await top({ line, column: rowEnd });
  const rowStart = (await lastWhere(0, rowEnd, (column) => top({ line, column }).then((rowY) => rowY < rowTop))) + 1;
  // The place on it nearest to the point.
  const before = await lastWhere(rowStart, rowEnd, (column) => left({ line, column }).then((x) => x <= point.x));
  let column = rowStart;
  if (before >= rowEnd) column = rowEnd;
  else if (before >= rowStart) {
    const [a, b] = await Promise.all([left({ line, column: before }), left({ line, column: before + 1 })]);
    column = point.x - a <= b - point.x ? before : before + 1;
  }
  return { line, column: boundary(source, column) };
}

/** What the presses use of the Editor's ref. */
export type PressedEditor = Pick<EditorRef, "focus" | "setSelections" | "run" | "selections" | "value" | "visibleRange" | "rangeBounds">;

export interface BesidePressOptions {
  /** The Editor's ref, once it has one. */
  editor: () => PressedEditor | undefined;
  /** The desktops' idiom (`platform.desktop`): a mouse presses down, else a finger taps. */
  desktop: boolean;
  /** Whether presses are taken now (the source shows). */
  active?: () => boolean;
  /** Runs a tap's work after the web's compatibility mousedown, which would take the focus back. */
  defer?: (run: () => void) => void;
}

/**
 * The handlers of the view around an Editor: `layout` its width, `pressDown` / `press` / `mouseMove` /
 * `mouseLeave` its events.
 */
export interface BesidePresses {
  layout(width: number): void;
  /** The desktops: a mouse press went down beside the rows. */
  pressDown(e: PressEvent): Promise<void>;
  /** A press ended in place: a tap on touch screens, the end of a click on the desktops. */
  press(e: PressEvent): Promise<void>;
  /** The desktops: the mouse moved over the editor (a drag begun beside the rows selects). */
  mouseMove(e: MouseEvent): Promise<void>;
  /** The desktops: the mouse left the editor (a drag begun beside the rows selects to there and ends). */
  mouseLeave(e: MouseEvent): Promise<void>;
}

export function createBesidePresses(options: BesidePressOptions): BesidePresses {
  const defer = options.defer ?? ((run: () => void) => setTimeout(run, 0));
  let width = 0;
  let pressSeq = 0;
  let dragSeq = 0;
  // A mouse press beside the rows is down (until it ends in place, the mouse leaves the editor or
  // moves without the button), and where its drag selects from. A button released outside the
  // editor is never seen, so the drag ends as the mouse leaves: else a later drag pressed outside and
  // moved in would go on from the stale anchor, and typing would replace what that selected. (Not as
  // the press ends: the web ends it, `onPressUp`, once the pointer moves 10pt, at the drag's start.)
  let mouseDown = false;
  let dragAnchor: EditorPosition | null = null;
  const release = () => {
    mouseDown = false;
    dragAnchor = null;
  };

  const pointAt = async (editor: PressedEditor, point: { x: number; y: number }) => {
    const caretAt: CaretAt = async (position) => {
      const [box] = await editor.rangeBounds({ start: position, end: position });
      return box ? { x: box.bounds.origin.x, y: box.bounds.origin.y, height: box.bounds.size.height } : null;
    };
    const [text, visible] = await Promise.all([editor.value(), editor.visibleRange()]);
    return positionAt(text, point, caretAt, visible);
  };

  const place = async (e: PressEvent) => {
    const editor = options.editor();
    if (!editor || options.active?.() === false) return;
    // The scroll bar along the right edge keeps its presses (a drag of its thumb scrolls).
    if (options.desktop && width > 0 && e.position.x >= width - SCROLLBAR_WIDTH) return;
    const seq = ++pressSeq;
    // A move or leave of the drag before still finding its place selects nothing now.
    dragSeq += 1;
    mouseDown = options.desktop;
    dragAnchor = null;
    const [position, selections] = await Promise.all([pointAt(editor, e.position), editor.selections()]);
    if (seq !== pressSeq) return;
    const primary = selections[selections.length - 1];
    const extend = options.desktop && e.modifiers.shift && e.clickCount <= 1 && primary;
    const selection = { anchor: extend ? primary.anchor : position, head: position };
    if (mouseDown && e.clickCount <= 1) dragAnchor = selection.anchor;
    const select = () => {
      editor.focus();
      editor.setSelections([selection]);
      if (e.clickCount === 2) editor.run("selectWord");
      else if (e.clickCount >= 3) editor.run("selectLine");
    };
    if (options.desktop) select();
    else defer(select);
  };

  return {
    layout(next) {
      width = next;
    },
    pressDown: (e) => (options.desktop ? place(e) : Promise.resolve()),
    async press(e) {
      release();
      if (!options.desktop) await place(e);
    },
    async mouseMove(e) {
      if (e.pressedButton !== "left") release();
      const editor = options.editor();
      if (!dragAnchor || !editor) return;
      const seq = ++dragSeq;
      const head = await pointAt(editor, e.position);
      if (seq !== dragSeq || !dragAnchor) return;
      editor.setSelections([{ anchor: dragAnchor, head }]);
    },
    async mouseLeave(e) {
      const anchor = dragAnchor;
      release();
      // Dragged out with the button held: the selection reaches the edge it left by (the start or
      // end of a row, the text's end below it), as the last moves inside may have fallen short.
      const editor = options.editor();
      if (!anchor || e.pressedButton !== "left" || !editor) return;
      const seq = ++dragSeq;
      const head = await pointAt(editor, e.position);
      if (seq !== dragSeq) return;
      editor.setSelections([{ anchor, head }]);
    },
  };
}
