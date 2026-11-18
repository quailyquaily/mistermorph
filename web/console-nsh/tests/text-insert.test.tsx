// A toolbar's insertion into a plain textarea (components/shared/textInsert.ts), driven with a
// stand-in field and turn: headless inputs ignore `setSelection` and type at the end, so whether a
// reference replaces the selected text, goes in at a caret mid-text, keeps the text around it and
// puts the focus and caret back after itself can't be seen on the page. The stand-in records what
// the field is told; the selection comes in as the field reports it (`onSelectionChange`).
import { expect, test } from "nsh/test";
import { createTextareaInsert, insertIntoText, type InsertField } from "../components/shared/textInsert";

test("insertIntoText: at the caret, in place of a selection, at the end without one", () => {
  expect(insertIntoText("Hello world", { start: 5, end: 5 }, "[Bob](tg:7)")).toEqual({
    value: "Hello[Bob](tg:7) world",
    caret: 16,
  });
  expect(insertIntoText("Hello world", { start: 6, end: 11 }, "[Bob](tg:7)")).toEqual({
    value: "Hello [Bob](tg:7)",
    caret: 17,
  });
  expect(insertIntoText("Hello", null, "[Bob](tg:7)")).toEqual({ value: "Hello[Bob](tg:7)", caret: 16 });
  // A first use: no text, no caret.
  expect(insertIntoText("", null, "[Bob](tg:7)", { spacing: true })).toEqual({ value: "[Bob](tg:7)", caret: 11 });
});

test("insertIntoText: spacing adds a space only where the reference would touch text", () => {
  const ref = "[Bob](tg:7)";
  expect(insertIntoText("Ask now", { start: 3, end: 3 }, ref, { spacing: true }).value).toBe("Ask [Bob](tg:7) now");
  expect(insertIntoText("Ask now", { start: 4, end: 4 }, ref, { spacing: true }).value).toBe("Ask [Bob](tg:7) now");
  expect(insertIntoText("Ask now", { start: 0, end: 0 }, ref, { spacing: true }).value).toBe("[Bob](tg:7) Ask now");
  expect(insertIntoText("Ask\nnow", { start: 3, end: 3 }, ref, { spacing: true }).value).toBe("Ask [Bob](tg:7)\nnow");
  // The caret goes after the reference, before the space that was there; after an added space.
  expect(insertIntoText("Ask now", { start: 3, end: 3 }, ref, { spacing: true }).caret).toBe(15);
  expect(insertIntoText("Asknow", { start: 3, end: 3 }, ref, { spacing: true })).toEqual({ value: "Ask [Bob](tg:7) now", caret: 16 });
  expect(insertIntoText("Ask now", { start: 3, end: 3 }, ref).value).toBe("Ask[Bob](tg:7) now");
});

test("insertIntoText: a reversed, multiline or out-of-range selection", () => {
  const text = "line one\nline two\nline three";
  // Selected from the end of "two" back to the start of "one" (a selection made upwards).
  expect(insertIntoText(text, { start: 17, end: 5 }, "X").value).toBe("line X\nline three");
  // A selection the text no longer reaches counts as its end.
  expect(insertIntoText("short", { start: 40, end: 99 }, "X", { spacing: true })).toEqual({ value: "short X", caret: 7 });
  expect(insertIntoText("short", { start: -3, end: 2 }, "X").value).toBe("Xort");
  // UTF-16 offsets, as Input reports them: after the emoji (2 units), before the word.
  expect(insertIntoText("👋 hi", { start: 2, end: 2 }, "X").value).toBe("👋X hi");
});

function setup(initial: string) {
  const log: string[] = [];
  const turns: (() => void)[] = [];
  let value = initial;
  let document: unknown = undefined;
  let locked = false;
  let mounted = true;
  const field: InsertField = {
    focus: () => log.push("focus"),
    setSelection: (start: number, end?: number) => log.push(`select ${start}-${end}`),
  };
  const insert = createTextareaInsert({
    value: () => value,
    onChange: (next) => {
      value = next;
      log.push(`change ${JSON.stringify(next)}`);
      // The page shows the new value, as the editor's effect on its props does.
      insert.follow(next, document);
    },
    locked: () => locked,
    field: () => (mounted ? field : undefined),
    defer: (run) => void turns.push(run),
  });
  insert.follow(value, document);
  return {
    insert,
    log,
    value: () => value,
    lock: (on: boolean) => (locked = on),
    unmount: () => (mounted = false),
    /** The user types: the field reports its text, then its caret. */
    type: (next: string, caret = next.length) => {
      value = next;
      insert.edited(next);
      insert.follow(next, document);
      insert.selected({ start: caret, end: caret });
    },
    /** Another document (or a reload) shows its text. */
    show: (next: string, key?: unknown) => {
      value = next;
      document = key;
      insert.follow(next, key);
    },
    turn: () => {
      for (const run of turns.splice(0)) run();
    },
  };
}

test("textarea: a reference replaces the selected text, keeps what is around it, and puts the caret after it", () => {
  const box = setup("Remind Alice to water the plants");
  box.insert.selected({ start: 7, end: 12 });
  expect(box.insert.insert("[Bob](tg:7)", { spacing: true })).toBe(true);
  expect(box.value()).toBe("Remind [Bob](tg:7) to water the plants");
  // The focus and the caret come a turn later, once the field shows the new text.
  expect(box.log).toEqual([`change ${JSON.stringify("Remind [Bob](tg:7) to water the plants")}`]);
  box.turn();
  expect(box.log.slice(1)).toEqual(["focus", "select 18-18"]);
});

test("textarea: a reference goes in at a caret mid-text, and a second one after the first", () => {
  const box = setup("Ping\nabout the report");
  box.insert.selected({ start: 4, end: 4 });
  box.insert.insert("[Team](tg:-100)", { spacing: true });
  expect(box.value()).toBe("Ping [Team](tg:-100)\nabout the report");
  box.turn();
  // The toolbar is pressed again before the field reports the caret it was given.
  box.insert.insert("[Bob](tg:7)", { spacing: true });
  expect(box.value()).toBe("Ping [Team](tg:-100) [Bob](tg:7)\nabout the report");
  box.turn();
  expect(box.log.at(-1)).toBe(`select ${"Ping [Team](tg:-100) [Bob](tg:7)".length}-${"Ping [Team](tg:-100) [Bob](tg:7)".length}`);
});

test("textarea: a selection made backwards is replaced as one made forwards", () => {
  const box = setup("one two three");
  box.insert.selected({ start: 7, end: 4 });
  box.insert.insert("2");
  expect(box.value()).toBe("one 2 three");
});

test("textarea: an empty field and a field never focused take the reference at the end", () => {
  const empty = setup("");
  empty.insert.insert("[Bob](tg:7)", { spacing: true });
  expect(empty.value()).toBe("[Bob](tg:7)");
  empty.turn();
  expect(empty.log.slice(1)).toEqual(["focus", "select 11-11"]);

  const untouched = setup("Water the plants");
  untouched.insert.insert("[Bob](tg:7)", { spacing: true });
  expect(untouched.value()).toBe("Water the plants [Bob](tg:7)");
});

test("textarea: typed text keeps its caret for the next insertion", () => {
  const box = setup("");
  box.type("Ask  today", 4);
  box.insert.insert("[Bob](tg:7)", { spacing: true });
  expect(box.value()).toBe("Ask [Bob](tg:7) today");
});

test("textarea: another document never takes the last one's caret", () => {
  const box = setup("First item text");
  box.show("First item text", "task-1");
  box.insert.selected({ start: 5, end: 5 });
  // Another item with other text.
  box.show("Second", "task-2");
  box.insert.insert("X");
  expect(box.value()).toBe("SecondX");
  // Another item with the same text as the one the caret was in.
  box.show("Same text", "task-3");
  box.insert.selected({ start: 4, end: 4 });
  box.show("Same text", "task-4");
  box.insert.insert("X");
  expect(box.value()).toBe("Same textX");
  // A reload of the same item that changed its text drops the caret too.
  box.insert.selected({ start: 0, end: 0 });
  box.show("Reloaded", "task-4");
  box.insert.insert("X");
  expect(box.value()).toBe("ReloadedX");
});

test("textarea: a disabled or read-only field takes nothing, and an empty reference changes nothing", () => {
  const box = setup("Keep me");
  box.insert.selected({ start: 0, end: 4 });
  box.lock(true);
  expect(box.insert.insert("[Bob](tg:7)")).toBe(false);
  box.lock(false);
  expect(box.insert.insert("")).toBe(false);
  box.turn();
  expect(box.value()).toBe("Keep me");
  expect(box.log).toEqual([]);
  // The selection is still there once the field can be changed again.
  box.insert.insert("Leave");
  expect(box.value()).toBe("Leave me");
});

test("textarea: a field locked or gone by the next turn is not focused", () => {
  const locked = setup("Text");
  locked.insert.insert("X");
  locked.lock(true);
  locked.turn();
  expect(locked.log.filter((line) => !line.startsWith("change"))).toEqual([]);

  const gone = setup("Text");
  gone.insert.insert("X");
  gone.unmount();
  gone.turn();
  expect(gone.log.filter((line) => !line.startsWith("change"))).toEqual([]);
});

// A picker's dialog gives the focus back, as it goes, to what had it as it opened: the textarea
// takes it as a picker opens, at the remembered selection, so the focus comes back to the field even
// when it never had it (a just-opened item).
test("textarea: a picker opening focuses the field at its selection, or at the end without one", () => {
  const fresh = setup("Water the plants");
  fresh.insert.hold();
  expect(fresh.log).toEqual(["focus", "select 16-16"]);
  // The reference then goes where the field was focused.
  fresh.insert.insert("[Bob](tg:7)", { spacing: true });
  expect(fresh.value()).toBe("Water the plants [Bob](tg:7)");

  const selected = setup("one two three");
  selected.insert.selected({ start: 7, end: 4 });
  selected.insert.hold();
  expect(selected.log).toEqual(["focus", "select 4-7"]);
  selected.insert.insert("2");
  expect(selected.value()).toBe("one 2 three");

  // A selection the text no longer reaches is held at its end.
  const stale = setup("short");
  stale.insert.selected({ start: 3, end: 40 });
  stale.insert.hold();
  expect(stale.log).toEqual(["focus", "select 3-5"]);
});

test("textarea: a locked or missing field is not focused as a picker opens", () => {
  const locked = setup("Text");
  locked.lock(true);
  locked.insert.hold();
  const gone = setup("Text");
  gone.unmount();
  gone.insert.hold();
  expect([...locked.log, ...gone.log]).toEqual([]);
});
