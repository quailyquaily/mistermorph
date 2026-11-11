// The composer's text on one row shares the centre line of the add button and Send beside it:
// empty (its placeholder, one line whatever its length), with text and focus (typing focuses it),
// and read-only, on a desktop and a phone. Text that wraps beside the controls moves the field above
// them, across the whole row in the same frame, and clearing it brings the one row back with the
// same geometry. At the wrapping boundary the composer is either the one row with one line or the
// full-width two-row layout, never a narrow field above the controls, and it gets there the same way
// back: typing, deleting, pasting, a line break, a draft put in at once, resizing. The boxes come
// from components/chat/composerField.ts and composerRows.ts; the frames from
// tests/fixtures/composer-field-app.tsx, which lays the row out as ChatComposer does.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { COMPOSER_CONTROL_SIZE, COMPOSER_LINE_HEIGHT, composerFieldBox, composerFrameBorder, composerFrameClass, composerRowClass } from "../components/chat/composerField";
import { COMPOSER_INPUT_CLASS, COMPOSER_PLACEHOLDER_STYLE, composerPlaceholderShown, composerSlotClass } from "../components/chat/ComposerFieldSlot";
import { PLACEHOLDERS } from "./fixtures/composerPlaceholders";

type Frame = { x: number; y: number; w: number; h: number };
type State = {
  value: string;
  rows: "one" | "two";
  multi: boolean;
  /** The text's height at the field's width, from the hidden copies. */
  height: number;
  /** The hidden copies' heights, the draft they measured, whether both have laid it out and the one-row copy's width. */
  measures: { oneRow: number; twoRows: number; text: string | null; settled: boolean; oneRowWidth: number };
  /** How late the fixture delivers the measures, in milliseconds. */
  late: number;
  /** What the field itself reports for its text at the width it has. */
  shown: number;
  box: { height: number; paddingTop: number; paddingBottom: number };
  /** How many frames changed what the user sees (rows, the field's height or laid-out width), and the last four. */
  changes: number;
  history: string;
};

const near = (actual: number, expected: number, within = 0.5) => expect(Math.abs(actual - expected)).toBeLessThan(within);

async function openRow(options: { width: number; platform?: "linux" | "android" }) {
  const app = await open("./fixtures/composer-field-app.tsx", { height: 700, locale: "en-US", ...options });
  const report = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, any>;
  await app.waitUntil(() => ["live", "readonly", "tools"].every((name) => report()[`${name}-field`] && report()[`${name}-actions`] && report()[`${name}-state`]));
  return { app, report };
}

/** The field's first line and the controls on one centre line, and nothing smaller than before. */
function expectAligned(report: Record<string, any>, name: string) {
  const state = report[`${name}-state`] as State;
  const field = report[`${name}-field`] as Frame;
  const row = report[`${name}-row`] as Frame;
  expect(state.multi).toBe(false);
  // The line box: from the content box's top, LINE_HEIGHT tall.
  const lineCentre = field.y + state.box.paddingTop + COMPOSER_LINE_HEIGHT / 2;
  // The actions (Send alone on this row) sit in the row as the add button does.
  for (const part of ["add", "actions"]) {
    const control = report[`${name}-${part}`] as Frame;
    near(control.h, COMPOSER_CONTROL_SIZE);
    near(lineCentre, control.y + control.h / 2);
    near(field.y + field.h / 2, control.y + control.h / 2);
  }
  // As tall as the controls (the old field was 35pt), with room for the whole measured line.
  near(field.h, COMPOSER_CONTROL_SIZE);
  expect(field.h - state.box.paddingTop - state.box.paddingBottom).toBeGreaterThanOrEqual(state.height - 0.01);
  expect(state.box.paddingBottom).toBeGreaterThanOrEqual(0);
  // The row keeps its 54pt (8 + 38 + 8).
  near(row.h, 54);
  // The frame is the row and its 1pt border all round, on a phone as on a desktop.
  const shell = report[`${name}-shell`] as Frame;
  near(shell.h - row.h, 2);
  near(shell.w - row.w, 2);
}

/** A few frames for the layout to settle. */
async function frames(app: App) {
  await app.wait(50);
}

for (const [device, options] of [
  ["a desktop", { width: 760, platform: "linux" as const }],
  ["a phone", { width: 390 }],
] as const) {
  test(`on ${device} the one-row text is on the controls' centre line, empty, typed, focused and read-only`, async () => {
    const { app, report } = await openRow(options);
    expectAligned(report(), "live");
    expectAligned(report(), "readonly");
    const before = report()["live-field"] as Frame;
    // Typing focuses the field first.
    await app.type("id:live-input", "Hello");
    await app.waitUntil(() => app.value("id:live-input") === "Hello");
    await frames(app);
    expectAligned(report(), "live");
    // Focus and text leave the geometry as it was.
    const after = report()["live-field"] as Frame;
    near(after.y, before.y);
    near(after.h, before.h);
  });

  test(`on ${device} wrapping text moves the field above the controls, and clearing it comes back to one row`, async () => {
    const { app, report } = await openRow(options);
    const long = "A line long enough to wrap beside the controls on any window this test opens, ".repeat(3);
    await app.type("id:live-input", long);
    await app.waitUntil(() => (report()["live-state"] as State).multi);
    await app.waitUntil(() => (report()["live-field"] as Frame).h > COMPOSER_LINE_HEIGHT * 1.5);
    const state = report()["live-state"] as State;
    const field = report()["live-field"] as Frame;
    // Above the controls the field is as tall as its text, unpadded.
    near(state.box.paddingTop, 0);
    near(field.h, state.height);
    near(field.h, state.shown);
    // The controls' row (its frames are its own) goes below it.
    expect((report()["live-row"] as Frame).h).toBeGreaterThanOrEqual(field.y + field.h + COMPOSER_CONTROL_SIZE);
    await app.clear("id:live-input");
    await app.waitUntil(() => !(report()["live-state"] as State).multi);
    await app.waitUntil(() => Math.abs((report()["live-field"] as Frame).h - COMPOSER_CONTROL_SIZE) < 0.5);
    await frames(app);
    expectAligned(report(), "live");
  });
}

// The placeholder (components/chat/ComposerFieldSlot.tsx) is one line laid over the field's first
// line box, cut with an ellipsis when it does not fit: long English, Japanese and Chinese ones at
// phone widths take no more room than none at all, and leave the rows, the field's box and the
// draft's measures as they are. (Headless runs lay a text out on one line whatever its width, so
// the ellipsis itself is checked in a browser; here, its place, its box and its single line.)
const WITH_PLACEHOLDER = ["live", "readonly", "tools"] as const;

function expectPlaceholderLine(report: Record<string, any>, name: string) {
  const state = report[`${name}-state`] as State;
  const field = report[`${name}-field`] as Frame;
  const placeholder = report[`${name}-placeholder`] as Frame;
  expect(state.rows).toBe("one");
  // Across the field, on the line the draft's first line takes, one line tall.
  near(placeholder.x, 0);
  near(placeholder.w, field.w);
  near(placeholder.y, state.box.paddingTop);
  near(placeholder.h, COMPOSER_LINE_HEIGHT);
  const lines = report[`${name}-placeholder-lines`] as { text: string; w: number }[];
  expect(lines.length).toBe(1);
  expect(lines[0].w).toBeLessThanOrEqual(field.w + 0.5);
  // The input fills its slot: the slot's frame is the field's.
  const input = report[`${name}-input-box`] as Frame;
  near(input.x, 0);
  near(input.y, 0);
  near(input.w, field.w);
  near(input.h, field.h);
}

for (const [device, options] of [
  ["a desktop", { width: 760, platform: "linux" as const }],
  ["a narrow desktop window", { width: 480, platform: "linux" as const }],
  ["a phone", { width: 390 }],
  ["a small phone", { width: 320 }],
] as const) {
  test(`on ${device} long placeholders take one line in the one-row field, as an empty one does`, async () => {
    const { app, report } = await openRow(options);
    await app.waitUntil(() => WITH_PLACEHOLDER.every((name) => report()[`${name}-placeholder-lines`]) && !!report()["bare-state"]);
    await frames(app);
    const all = report();
    for (const name of WITH_PLACEHOLDER) {
      expectAligned(all, name);
      expectPlaceholderLine(all, name);
      expect(app.shows(`id:${name}-placeholder`)).toBe(true);
      // The hidden copies measure the empty draft, not the placeholder.
      near(all[`${name}-state`].measures.oneRow, all["bare-state"].measures.oneRow);
      near(all[`${name}-state`].measures.twoRows, all["bare-state"].measures.twoRows);
      expect(all[`${name}-state`].changes).toBe(0);
    }
    // With the same controls beside it, a long placeholder's field is exactly the field without one.
    for (const key of ["field", "row", "shell"]) expect(all[`live-${key}`].h).toBe(all[`bare-${key}`].h);
    near(all["live-field"].w, all["bare-field"].w);
    // No placeholder: nothing drawn.
    expectAligned(all, "bare");
    expect(app.shows("id:bare-placeholder")).toBe(false);
    for (const text of Object.values(PLACEHOLDERS).filter(Boolean)) expect(app.texts().filter((shown) => shown === text).length).toBe(1);
  });

  test(`on ${device} typing hides the placeholder, and clearing a multiline draft brings it back on one line`, async () => {
    const { app, report } = await openRow(options);
    const state = () => report()["live-state"] as State;
    await app.waitUntil(() => app.shows("id:live-placeholder"));
    await app.type("id:live-input", "H");
    await app.waitUntil(() => state().value === "H");
    expect(app.shows("id:live-placeholder")).toBe(false);
    expectAligned(report(), "live");
    // Real text still wraps and moves the field above the controls.
    await app.type("id:live-input", LATIN);
    await app.waitUntil(() => state().rows === "two");
    expect(app.shows("id:live-placeholder")).toBe(false);
    const backToOneRow = async () => {
      await app.waitUntil(() => state().value === "" && state().rows === "one" && app.shows("id:live-placeholder"));
      await app.waitUntil(() => !!report()["live-placeholder"] && Math.abs((report()["live-field"] as Frame).h - COMPOSER_CONTROL_SIZE) < 0.5);
      await frames(app);
      expectAligned(report(), "live");
      expectPlaceholderLine(report(), "live");
    };
    await app.clear("id:live-input");
    await backToOneRow();
    // A draft of several lines, pasted, then cleared.
    await app.paste("id:live-input", { text: "one\ntwo\nthree" });
    await app.waitUntil(() => state().rows === "two");
    expect(app.shows("id:live-placeholder")).toBe(false);
    await app.clear("id:live-input");
    await backToOneRow();
    // A read-only field keeps its placeholder, as before.
    expect(app.shows("id:readonly-placeholder")).toBe(true);
  }, 60000);
}

test("the placeholder is one line cut with an ellipsis, shown for an empty draft with nothing composed", () => {
  expect(COMPOSER_PLACEHOLDER_STYLE).toEqual({ numberOfLines: 1, textOverflow: "ellipsis", lineHeight: COMPOSER_LINE_HEIGHT });
  expect(composerPlaceholderShown("Tell Morph anything", "", false)).toBe(true);
  expect(composerPlaceholderShown("Tell Morph anything", "h", false)).toBe(false);
  expect(composerPlaceholderShown("Tell Morph anything", "\n", false)).toBe(false);
  // An input method composing in an empty field: its text is not in the draft yet everywhere.
  expect(composerPlaceholderShown("Tell Morph anything", "", true)).toBe(false);
  for (const none of ["", null, undefined]) expect(composerPlaceholderShown(none, "", false)).toBe(false);
  // The field keeps a placeholder of its own for screen readers (on the web, its textarea's only
  // accessible name), but draws it transparent: what wraps there is never seen.
  expect(COMPOSER_INPUT_CLASS.split(" ")).toContain("placeholder:text-transparent");
  // The slot takes the place the field took in each layout: beside the controls, or across the row.
  expect(composerSlotClass("one")).toBe("flex-1");
  expect(composerSlotClass("two")).toBe("w-full");
});

// The boundary between one row and two. The field's own report of its text (`shown`, at the width
// it has) is what the user sees: one line on one row; on two rows, the field across the whole row
// from the first frame, as tall as its text there (which may be a single line: the rows are decided
// beside the controls, so the wider field cannot send them back).
const oneLine = (height: number) => height <= COMPOSER_LINE_HEIGHT * 1.5;
const LATIN = "The quick brown fox jumps over the lazy dog and keeps running across the wide green field until the sun goes down behind the hills";
const CJK = "我们今天讨论一下这个项目的进展情况以及下一步的计划安排和需要注意的事项还有资源分配问题以及时间表".repeat(3);
const TOKEN = `https://example.com/${"a1b2c3d4e5".repeat(14)}`;
/** The two-row layout's side padding (`px-2.5`, composerRowClass). */
const ROW_PADDING = 10;

/** What a step shows: one row, two rows holding one line, or two rows holding more. */
type Shown = "one" | "two:1" | "two:n";

function expectComplete(report: Record<string, any>, name: string, step: string): Shown {
  const state = report[`${name}-state`] as State;
  const field = report[`${name}-field`] as Frame;
  const row = report[`${name}-row`] as Frame;
  const where = `${name} ${step} (${state.value.length} chars, ${state.rows})`;
  const lineBreak = state.value.includes("\n");
  // The copies have measured this very draft.
  if (state.value !== "" && state.measures.text !== state.value) throw new Error(`${where}: measured ${JSON.stringify(state.measures.text)}`);
  if (state.rows === "one") {
    if (lineBreak) throw new Error(`${where}: one row with a line break`);
    if (!oneLine(state.shown)) throw new Error(`${where}: one row but the field shows ${state.shown}pt of text`);
    near(field.h, COMPOSER_CONTROL_SIZE);
    // The hidden one-row copy is exactly as wide as the field it stands for.
    near(state.measures.oneRowWidth, field.w);
    return "one";
  }
  // Two rows only for text that wraps beside the controls, or has a line break.
  if (!lineBreak && oneLine(state.measures.oneRow)) throw new Error(`${where}: two rows for a draft that is one line beside the controls`);
  // The whole row's width, never the one-row width.
  near(field.x, ROW_PADDING);
  near(field.w, row.w - 2 * ROW_PADDING);
  expect(field.w).toBeGreaterThan(state.measures.oneRowWidth + 1);
  // As tall as what it shows at that width (one line at least), and the controls below it.
  // Headless engines measure a line break as no break at all: such a draft is held at two lines.
  const shown = Math.max(state.shown, (lineBreak ? 2 : 1) * COMPOSER_LINE_HEIGHT);
  near(field.h, Math.min(shown, 24 * COMPOSER_LINE_HEIGHT));
  near(state.height, shown);
  const controls = report[`${name}-controls`] as Frame;
  expect(controls.y).toBeGreaterThanOrEqual(field.y + field.h - 0.5);
  return oneLine(shown) ? "two:1" : "two:n";
}

/** At most one drawn change since `before`: the rows, the field's height and its laid-out width
 *  all change in the same frame (a narrow frame on the way to the full width would be a second). */
function expectOneMove(state: State, before: number, where: string) {
  if (state.changes - before > 1) throw new Error(`${where} moved more than once: ${state.history}`);
}

/** Types `text` key by key until a few keys past wrapping the full width, and deletes it again,
 *  checking every step; what each length shows. */
async function typeAndDelete(app: App, report: () => Record<string, any>, name: string, text: string) {
  const input = `id:${name}-input`;
  const state = () => report()[`${name}-state`] as State;
  await app.clear(input);
  await app.waitUntil(() => state().value === "" && state().rows === "one");
  await frames(app);
  const forward: Shown[] = [];
  let typed = "";
  for (const char of [...text]) {
    if (forward.length >= 3 && forward.slice(-3).every((shown) => shown === "two:n")) break;
    const before = state().changes;
    typed += char;
    await app.type(input, char);
    await app.waitUntil(() => state().value === typed && state().measures.text === typed);
    await frames(app);
    forward.push(expectComplete(report(), name, `typing`));
    // One move at most per key: no flicker, no narrow frame on the way to two rows.
    expectOneMove(state(), before, `typing ${typed.length}`);
  }
  const backward: Shown[] = [];
  for (let left = forward.length - 1; left >= 0; left -= 1) {
    const before = state().changes;
    await app.keyboard.press("backspace");
    await app.waitUntil(() => [...state().value].length === left && (left === 0 || state().measures.text === state().value));
    await frames(app);
    backward[left] = left === 0 ? "one" : expectComplete(report(), name, "deleting");
    expectOneMove(state(), before, `deleting to ${left}`);
  }
  // Deleting goes back through the same layouts, at the same lengths, to one row.
  expect(backward.slice(1)).toEqual(forward.slice(0, -1));
  expect(state().rows).toBe("one");
  return forward;
}

function steps<T>(values: T[]) {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

/** The shortest prefix of LATIN that wraps beside the live row's controls. */
async function wrapLength(app: App, state: () => State) {
  let length = 0;
  await app.clear("id:live-input");
  await app.waitUntil(() => state().value === "");
  while (state().rows === "one") {
    await app.type("id:live-input", LATIN[length]);
    length += 1;
    await app.waitUntil(() => state().measures.text === LATIN.slice(0, length));
    await frames(app);
  }
  return length;
}

for (const [device, options] of [
  ["a desktop", { width: 760, platform: "linux" as const }],
  ["a phone", { width: 390 }],
] as const) {
  for (const [script, text] of [
    ["Latin text", LATIN],
    ["Chinese text", CJK],
    ["a long unbroken string", TOKEN],
  ] as const) {
    test(`on ${device}, typing ${script} across the wrap goes straight to the full-width two rows, and deleting retraces it`, async () => {
      const { app, report } = await openRow(options);
      const shown = await typeAndDelete(app, report, "live", text);
      // One row, then two rows at the full width: first holding the line that wrapped beside the
      // controls on one line, then on more lines as it grows. Nothing in between.
      expect(steps(shown)).toEqual(["one", "two:1", "two:n"]);
    }, 120000);
  }

  test(`on ${device}, pastes, line breaks, clearing and wider actions land on the same layouts as typing`, async () => {
    const { app, report } = await openRow(options);
    const state = (name = "live") => report()[`${name}-state`] as State;
    const length = await wrapLength(app, state);
    expect(expectComplete(report(), "live", "at the wrap")).toBe("two:1");
    await app.clear("id:live-input");
    await app.waitUntil(() => state().rows === "one");
    await frames(app);
    expectAligned(report(), "live");
    // Pasted at once: the same layout, in one move.
    for (const [draft, shown] of [
      [LATIN.slice(0, length - 1), "one"],
      [LATIN.slice(0, length), "two:1"],
      [LATIN, "two:n"],
      ["one\ntwo", "two:n"],
    ] as const) {
      await app.clear("id:live-input");
      await app.waitUntil(() => state().value === "");
      await frames(app);
      const before = state().changes;
      await app.paste("id:live-input", { text: draft });
      await app.waitUntil(() => state().value === draft && state().measures.text === draft);
      await frames(app);
      expect(expectComplete(report(), "live", `pasted`)).toBe(shown);
      expectOneMove(state(), before, `pasting ${JSON.stringify(draft)}`);
    }
    // A line break moves a short draft to the full width at once; deleting it brings one row back.
    await app.clear("id:live-input");
    await app.type("id:live-input", "hi");
    await app.waitUntil(() => state().value === "hi");
    await frames(app);
    let before = state().changes;
    await app.type("id:live-input", "\n");
    await app.waitUntil(() => state().value === "hi\n" && state().measures.text === "hi\n");
    await frames(app);
    expect(expectComplete(report(), "live", "line break")).toBe("two:n");
    expectOneMove(state(), before, "a line break");
    before = state().changes;
    await app.keyboard.press("backspace");
    await app.waitUntil(() => state().value === "hi" && state().measures.text === "hi");
    await frames(app);
    expectAligned(report(), "live");
    expectOneMove(state(), before, "deleting the line break");
    // Wider actions narrow the one row, and the hidden copy with it: a draft that fits beside a
    // lone Send wraps beside the picker and Send, and takes that row's full width.
    await app.type("id:tools-input", LATIN.slice(0, length - 1));
    await app.waitUntil(() => state("tools").value === LATIN.slice(0, length - 1) && state("tools").measures.text === state("tools").value);
    await frames(app);
    expect(expectComplete(report(), "tools", "beside wider actions")).toBe("two:1");
    expect(state("tools").measures.oneRowWidth).toBeLessThan(state().measures.oneRowWidth - 80);
  }, 120000);

  test(`on ${device}, a draft put in at once moves in one step, whatever the copies measured before`, async () => {
    const { app, report } = await openRow(options);
    const state = () => report()["live-state"] as State;
    // Each replaces the whole draft in one edit, as history, a topic switch or a restored draft
    // does; `retype` clears it and puts a short draft in 30ms later. With late measures (60ms, as a
    // platform slower to report), every draft first meets the heights of the one before.
    const sequence = [
      ["put-long", "two:n"],
      ["put-short", "one"],
      ["put-long", "two:n"],
      ["retype", "one"],
      ["put-lines", "two:n"],
      ["put-short", "one"],
      ["put-lines", "two:n"],
      ["retype", "one"],
      ["put-long", "two:n"],
      ["put-lines", "two:n"],
      ["retype", "one"],
    ] as const;
    for (const late of [false, true]) {
      if (late) {
        await app.press("id:live-late");
        await app.waitUntil(() => state().late > 0);
      }
      for (const [key, shown] of sequence) {
        const before = state().changes;
        await app.press(`id:live-${key}`);
        await app.waitUntil(() => state().value !== "" && state().measures.text === state().value && app.value("id:live-input") === state().value);
        await app.wait(150);
        expect(expectComplete(report(), "live", `${key}${late ? ", late" : ""}`)).toBe(shown);
        expectOneMove(state(), before, `${key}${late ? " with late measures" : ""}`);
      }
    }
  }, 60000);

  test(`on ${device}, a paste that makes a multiline draft taller eases the height once, at the full width`, async () => {
    const { app, report } = await openRow(options);
    const state = () => report()["live-state"] as State;
    const eased = () => (report().eased as number | undefined) ?? 0;
    const settle = async () => {
      await app.waitUntil(() => state().measures.text === state().value && app.value("id:live-input") === state().value);
      await app.wait(150);
    };
    // A draft above the controls, several lines across the row (the rows change at once: no easing).
    await app.press("id:live-put-long");
    await settle();
    expect(expectComplete(report(), "live", "the long draft")).toBe("two:n");
    const before = { height: state().height, width: (report()["live-field"] as Frame).w, eased: eased(), changes: state().changes };
    // As much again pasted after it: the copies lay it out one after the other, and the field grows
    // across the row in one eased move, as wide as before.
    await app.press("id:live-put-longer");
    await settle();
    expect(expectComplete(report(), "live", "the pasted draft")).toBe("two:n");
    expect(state().height).toBeGreaterThan(before.height + COMPOSER_LINE_HEIGHT / 2);
    near((report()["live-field"] as Frame).w, before.width);
    expect(eased() - before.eased).toBe(1);
    expectOneMove(state(), before.changes, "the pasted draft");
  }, 60000);

  test(`on ${device}, resizing the window moves a draft between the layouts and back the same way`, async () => {
    const { app, report } = await openRow(options);
    const state = () => report()["live-state"] as State;
    await wrapLength(app, state);
    const seen: Shown[] = [];
    for (const width of [options.width + 160, options.width, options.width - 160, options.width]) {
      await app.setViewport(width, 700);
      await app.wait(100);
      seen.push(expectComplete(report(), "live", `at ${width}pt`));
    }
    // Wider, the draft fits one row; narrower, it wraps the full width too; back, it is as it was.
    expect(seen).toEqual(["one", "two:1", "two:n", "two:1"]);
  }, 60000);
}

test("the one-row box centres a LINE_HEIGHT line in the controls' height whatever the field measures", () => {
  const top = (COMPOSER_CONTROL_SIZE - COMPOSER_LINE_HEIGHT) / 2;
  for (const measured of [0, NaN, COMPOSER_LINE_HEIGHT, 23, 25, 31, 33]) {
    const box = composerFieldBox(false, measured);
    near(box.paddingTop, top, 0.001);
    near(box.paddingTop + COMPOSER_LINE_HEIGHT / 2, COMPOSER_CONTROL_SIZE / 2, 0.001);
    expect(box.height).toBeGreaterThanOrEqual(COMPOSER_CONTROL_SIZE);
    expect(box.paddingBottom).toBeGreaterThanOrEqual(0);
    // The content box holds the measured line: nothing scrolls or clips.
    const content = box.height - box.paddingTop - box.paddingBottom;
    expect(content).toBeGreaterThanOrEqual(Math.max(COMPOSER_LINE_HEIGHT, Number.isFinite(measured) ? measured : 0) - 0.001);
  }
  near(composerFieldBox(false, 23).height, COMPOSER_CONTROL_SIZE, 0.001);
});

test("above the controls the field grows with its text up to 24 lines, unpadded", () => {
  expect(composerFieldBox(true, 3 * COMPOSER_LINE_HEIGHT)).toEqual({ height: 3 * COMPOSER_LINE_HEIGHT, paddingTop: 0, paddingBottom: 0, lineHeight: COMPOSER_LINE_HEIGHT });
  expect(composerFieldBox(true, 100 * COMPOSER_LINE_HEIGHT).height).toBe(24 * COMPOSER_LINE_HEIGHT);
  expect(composerRowClass(false)).toContain("items-center");
  expect(composerRowClass(true)).not.toContain("flex-row");
});

// The frame's border on a phone is the design's composer line (design/ui-refresh.html's
// `.composer`), which can be seen against the field; the desktop keeps the fields' `input`.
type Rgba = [number, number, number, number];

function rgba(hex: string): Rgba {
  const digits = hex.replace("#", "");
  const full = digits.length === 6 ? `${digits}ff` : digits;
  return [0, 2, 4, 6].map((at) => parseInt(full.slice(at, at + 2), 16) / 255) as Rgba;
}

/** `top` laid over the opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  return [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;
}

function luminance(color: Rgba) {
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}

function contrast(a: Rgba, b: Rgba) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("on a phone the composer's frame is the design's line, a light border the field does not hide", async () => {
  expect(composerFrameBorder(true)).toBe("border-line");
  expect(composerFrameBorder(false)).toBe("border-input");
  const { report } = await openRow({ width: 390 });
  const tokens = report().tokens as Record<string, string>;
  const color = (name: string) => rgba(tokens[name.replace("border-", "")]);
  // The page under the composer, the field's fill over it, and each border over that.
  const field = over(color("field"), color("background"));
  const phone = contrast(over(color(composerFrameBorder(true)), field), field);
  const desktop = contrast(over(color(composerFrameBorder(false)), field), field);
  expect(phone).toBeGreaterThan(desktop * 1.1);
  // Light: a hairline, well short of the muted text beside it.
  expect(phone).toBeLessThan(contrast(color("muted-foreground"), field) / 2);
});

test("the composer's frame differs between a phone and a desktop only in its border's colour", () => {
  const phone = composerFrameClass(true);
  const desktop = composerFrameClass(false);
  // The desktop's frame: its resting `input` border in every state, the shadow for focus.
  expect(desktop).toBe("relative rounded-(--radius) border border-input bg-field transition-shadow duration-[260ms] focus-within:shadow-md");
  expect(phone.replace("border-line", "border-input")).toBe(desktop);
  for (const frame of [phone, desktop]) {
    const classes = frame.split(" ");
    // One 1pt border, the same radius, and the focus look over the resting colour.
    expect(classes).toContain("border");
    expect(classes.filter((name) => /^border-\d/.test(name))).toEqual([]);
    expect(classes).toContain("rounded-(--radius)");
    expect(classes).toContain("focus-within:shadow-md");
    expect(classes).toContain("bg-field");
  }
});

// The light border stays while the field has the focus, while typing, sending and running, and after
// a send (the keyboard lowered or not): the frame's class depends on the window's width alone, and
// none of its parts changes the border in a state or eases its colour. Focus was
// `focus-within:border-blue/45`, which took the light border away until the field lost the focus.
test("the composer's frame keeps its light border in every state; focus shows as the shadow alone", () => {
  for (const mobile of [true, false]) {
    const classes = composerFrameClass(mobile).split(" ");
    const border = composerFrameBorder(mobile);
    expect(classes.filter((name) => name.startsWith("border-"))).toEqual([border]);
    // No state variant (focus-within, focus, hover, pressed, disabled...) touches the border.
    expect(classes.filter((name) => name.includes(":") && /:border(-|$)/.test(name))).toEqual([]);
    expect(classes.filter((name) => name.includes(":"))).toEqual(["focus-within:shadow-md"]);
    // Only the shadow eases: a colour transition would animate the border (and the fill).
    expect(classes.filter((name) => name === "transition" || name.startsWith("transition-"))).toEqual(["transition-shadow"]);
  }
});
