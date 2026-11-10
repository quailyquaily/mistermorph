// The presses an nsh/base Editor's rows do not take (components/shared/editorPresses.ts): where a
// point falls in the text, and what a press, a double or triple click, Shift and a drag there do. The
// editor is a stand-in laying its text out monospaced, wrapping rows at `wrap` characters, so a
// position's caret box is known. Real pointers can't be scripted here (no browser in these tests):
// MarkdownEditor beside a plain Editor was compared in Chrome by hand.
import type { MouseEvent, PressEvent } from "nsh";
import type { EditorPosition, EditorRange, EditorSelection } from "nsh/base";
import { expect, test } from "nsh/test";
import { createBesidePresses, lastWhere, positionAt, SCROLLBAR_WIDTH, type CaretAt } from "../components/shared/editorPresses";

const LEFT = 16;
const TOP = 12;
const CHAR = 8;
const ROW = 24;

/** Carets of `text` laid out monospaced from (LEFT, TOP), rows of `wrap` characters. */
function layout(text: string, wrap = 40) {
  const lines = text.split("\n");
  const rowsBefore: number[] = [];
  let rows = 0;
  for (const line of lines) {
    rowsBefore.push(rows);
    rows += Math.max(1, Math.ceil(line.length / wrap));
  }
  let probes = 0;
  const caret = ({ line, column }: EditorPosition) => {
    const length = lines[line].length;
    // A wrap's offset starts the next row; a line's end stays on its last row.
    let row = Math.floor(column / wrap);
    if (column === length && length > 0 && length % wrap === 0) row -= 1;
    return { x: LEFT + (column - row * wrap) * CHAR, y: TOP + (rowsBefore[line] + row) * ROW, height: ROW };
  };
  const caretAt: CaretAt = async (position) => {
    probes += 1;
    return caret(position);
  };
  /** The middle of row `row` (from the top of the text), `column` characters in. */
  const point = (row: number, column: number) => ({ x: LEFT + column * CHAR, y: TOP + row * ROW + ROW / 2 });
  return { caretAt, point, rows, probes: () => probes };
}

const at = (line: number, column: number) => ({ line, column });

test("lastWhere finds the last index a monotonic test holds at", async () => {
  for (let size = 0; size <= 40; size += 1) {
    for (let threshold = -1; threshold < size; threshold += 1) {
      const found = await lastWhere(0, size - 1, async (index) => index <= threshold);
      expect(found).toBe(threshold);
    }
  }
  expect(await lastWhere(5, 9, async () => false)).toBe(4);
  expect(await lastWhere(5, 9, async () => true)).toBe(9);
});

test("below the last row is the text's end; an empty text is its start", async () => {
  const text = "# Title\n\nHello";
  const l = layout(text);
  expect(await positionAt(text, l.point(3, 2), l.caretAt)).toEqual(at(2, 5));
  expect(await positionAt(text, { x: 300, y: 400 }, l.caretAt)).toEqual(at(2, 5));
  const empty = layout("");
  expect(await positionAt("", { x: 200, y: 150 }, empty.caretAt)).toEqual(at(0, 0));
  expect(await positionAt("", { x: 2, y: 2 }, empty.caretAt)).toEqual(at(0, 0));
});

test("a row's padding is its start or end; the top padding is the first row", async () => {
  const text = "Alpha beta gamma\n\nDelta epsilon";
  const l = layout(text);
  expect(await positionAt(text, { x: 4, y: l.point(2, 0).y }, l.caretAt)).toEqual(at(2, 0));
  expect(await positionAt(text, { x: 900, y: l.point(2, 0).y }, l.caretAt)).toEqual(at(2, 13));
  expect(await positionAt(text, { x: 900, y: l.point(0, 0).y }, l.caretAt)).toEqual(at(0, 16));
  expect(await positionAt(text, { x: LEFT + 3 * CHAR, y: 2 }, l.caretAt)).toEqual(at(0, 3));
  // The empty line between them.
  expect(await positionAt(text, l.point(1, 9), l.caretAt)).toEqual(at(1, 0));
});

test("over the text, the nearest caret place", async () => {
  const text = "Alpha beta gamma";
  const l = layout(text);
  expect(await positionAt(text, l.point(0, 7.4), l.caretAt)).toEqual(at(0, 7));
  expect(await positionAt(text, l.point(0, 7.6), l.caretAt)).toEqual(at(0, 8));
  expect(await positionAt(text, l.point(0, -1), l.caretAt)).toEqual(at(0, 0));
});

test("a wrapped line: the row under the point, its start and end", async () => {
  // 25 characters in rows of 10: "0123456789" "abcdefghij" "ABCDE".
  const text = "first\n0123456789abcdefghijABCDE\nlast";
  const l = layout(text, 10);
  // Row 2 of the text is the wrapped line's second row.
  expect(await positionAt(text, { x: 4, y: l.point(2, 0).y }, l.caretAt)).toEqual(at(1, 10));
  // Right of a wrapped row: before its last character (the next row starts at the wrap), as the
  // Editor's rows place it.
  expect(await positionAt(text, { x: 900, y: l.point(2, 0).y }, l.caretAt)).toEqual(at(1, 19));
  expect(await positionAt(text, { x: 900, y: l.point(3, 0).y }, l.caretAt)).toEqual(at(1, 25));
  expect(await positionAt(text, l.point(3, 2.2), l.caretAt)).toEqual(at(1, 22));
  expect(await positionAt(text, l.point(4, 1), l.caretAt)).toEqual(at(2, 1));
});

test("a surrogate pair is never split", async () => {
  const text = "a\u{1F600}b";
  const l = layout(text);
  expect(await positionAt(text, l.point(0, 2), l.caretAt)).toEqual(at(0, 1));
  expect(await positionAt(text, l.point(0, 3), l.caretAt)).toEqual(at(0, 3));
});

test("the visible range narrows the search; an unmeasured editor gives the end", async () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const visible: EditorRange = { start: at(200, 0), end: at(215, 8) };
  const wide = layout(text);
  const narrow = layout(text);
  expect(await positionAt(text, wide.point(207, 2), wide.caretAt)).toEqual(at(207, 2));
  expect(await positionAt(text, narrow.point(207, 2), narrow.caretAt, visible)).toEqual(at(207, 2));
  expect(narrow.probes() < wide.probes()).toBe(true);
  // The point above the range (the viewport's top edge over a line partly shown).
  expect(await positionAt(text, narrow.point(199, 0), narrow.caretAt, visible)).toEqual(at(199, 0));
  expect(await positionAt("ab\ncd", { x: 20, y: 20 }, async () => null)).toEqual(at(1, 2));
});

/** A stand-in Editor ref over `layout`, logging what is done to it. */
function editor(text: string, selections: EditorSelection[] = [{ anchor: at(0, 0), head: at(0, 0) }]) {
  const l = layout(text);
  const log: string[] = [];
  const fmt = (p: EditorPosition) => `${p.line}:${p.column}`;
  const ref = {
    focus: () => log.push("focus"),
    setSelections: (next: EditorSelection[]) => {
      selections = next;
      log.push(`select ${next.map((s) => `${fmt(s.anchor)}-${fmt(s.head)}`).join(",")}`);
    },
    run: (command: string) => log.push(`run ${command}`),
    selections: async () => selections,
    value: async () => text,
    visibleRange: async () => ({ start: at(0, 0), end: at(text.split("\n").length - 1, 0) }),
    rangeBounds: async (range: EditorRange) => {
      const box = await l.caretAt(range.start);
      const bounds = { origin: { x: box!.x, y: box!.y }, size: { width: 0, height: box!.height } };
      return [{ bounds, pageBounds: bounds }];
    },
  };
  return { ref, log, point: l.point };
}

const NO_KEYS = { control: false, alt: false, shift: false, platform: false };
const press = (position: { x: number; y: number }, clickCount = 1, shift = false) =>
  ({ position, pagePosition: position, modifiers: { ...NO_KEYS, shift }, clickCount }) as unknown as PressEvent;
const move = (position: { x: number; y: number }, button: "left" | null) =>
  ({ position, pagePosition: position, modifiers: NO_KEYS, pressedButton: button }) as unknown as MouseEvent;

test("a click beside the text focuses the editor and places the caret; double and triple clicks select", async () => {
  const text = "# Title\n\nHello world";
  const e = editor(text);
  const presses = createBesidePresses({ editor: () => e.ref as any, desktop: true });
  presses.layout(600);
  await presses.pressDown(press({ x: 300, y: 250 }));
  await presses.press(press({ x: 300, y: 250 }));
  expect(e.log).toEqual(["focus", "select 2:11-2:11"]);
  e.log.length = 0;
  // The second click of a double click, on the caret's bar: the word at the place.
  await presses.pressDown(press(e.point(2, 8.2), 2));
  expect(e.log).toEqual(["focus", "select 2:8-2:8", "run selectWord"]);
  e.log.length = 0;
  await presses.pressDown(press(e.point(2, 8.2), 3));
  expect(e.log).toEqual(["focus", "select 2:8-2:8", "run selectLine"]);
});

test("Shift extends the selection; the scroll bar's strip and the preview take nothing", async () => {
  const text = "Alpha beta\n\nGamma";
  const e = editor(text, [{ anchor: at(0, 6), head: at(0, 6) }]);
  let active = true;
  const presses = createBesidePresses({ editor: () => e.ref as any, desktop: true, active: () => active });
  presses.layout(600);
  await presses.pressDown(press({ x: 300, y: 300 }, 1, true));
  expect(e.log).toEqual(["focus", "select 0:6-2:5"]);
  e.log.length = 0;
  await presses.pressDown(press({ x: 600 - SCROLLBAR_WIDTH + 1, y: 300 }));
  active = false;
  await presses.pressDown(press({ x: 300, y: 300 }));
  expect(e.log).toEqual([]);
});

test("a drag begun beside the text selects, until the button is up", async () => {
  const text = "Alpha beta gamma\n\nDelta epsilon";
  const e = editor(text);
  const presses = createBesidePresses({ editor: () => e.ref as any, desktop: true });
  presses.layout(600);
  await presses.pressDown(press({ x: 4, y: e.point(2, 0).y }));
  await presses.mouseMove(move(e.point(0, 6), "left"));
  expect(e.log).toEqual(["focus", "select 2:0-2:0", "select 2:0-0:6"]);
  await presses.mouseMove(move(e.point(0, 9), null));
  await presses.mouseMove(move(e.point(0, 2), "left"));
  expect(e.log.length).toBe(3);
  // A click released before its place is found leaves no drag behind (a later drag is the rows').
  e.log.length = 0;
  const down = presses.pressDown(press({ x: 4, y: e.point(2, 0).y }));
  const up = presses.press(press({ x: 4, y: e.point(2, 0).y }));
  await Promise.all([down, up]);
  await presses.mouseMove(move(e.point(0, 6), "left"));
  expect(e.log).toEqual(["focus", "select 2:0-2:0"]);
});

test("on touch screens a tap places the caret after the web's compatibility mousedown", async () => {
  const text = "Hello";
  const e = editor(text);
  const later: (() => void)[] = [];
  const presses = createBesidePresses({ editor: () => e.ref as any, desktop: false, defer: (run) => later.push(run) });
  presses.layout(600);
  await presses.pressDown(press({ x: 300, y: 300 }));
  expect(e.log).toEqual([]);
  await presses.press(press({ x: 300, y: 300 }));
  expect(e.log).toEqual([]);
  later.forEach((run) => run());
  expect(e.log).toEqual(["focus", "select 0:5-0:5"]);
  // No mouse: moves select nothing.
  await presses.mouseMove(move({ x: 4, y: 20 }, "left"));
  expect(e.log.length).toBe(2);
});
