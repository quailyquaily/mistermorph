// The composer's text on one row shares the centre line of the add button and Send beside it:
// empty (its placeholder), with text and focus (typing focuses it), and read-only, on a desktop and a phone. Text that
// wraps moves the field above the controls as before, and clearing it brings the one row back with
// the same geometry. At the wrapping boundary the composer is either the one row with one line or
// the whole two-row layout with two lines or more, never the taller layout holding one line, and
// it gets there the same way back. The boxes come from components/chat/composerField.ts and
// composerRows.ts; the frames from tests/fixtures/composer-field-app.tsx, which lays the row out as
// ChatComposer does.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { COMPOSER_CONTROL_SIZE, COMPOSER_LINE_HEIGHT, composerFieldBox, composerFrameBorder, composerFrameClass, composerRowClass } from "../components/chat/composerField";

type Frame = { x: number; y: number; w: number; h: number };
type State = {
  value: string;
  rows: "one" | "narrow" | "wide";
  multi: boolean;
  /** The text's height at the field's width, from the hidden copies. */
  height: number;
  measures: { oneRow: number; twoRows: number; oneRowWidth: number };
  /** What the field itself reports for its text at the width it has. */
  shown: number;
  box: { height: number; paddingTop: number; paddingBottom: number };
  /** How many times what the user sees changed (rows, the field's height or width), and the last. */
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

// The boundary between one row and two. The field's own report of its text (`shown`, at the width
// it has) is what the user sees: one line on one row, two lines or more on two rows.
const oneLine = (height: number) => height <= COMPOSER_LINE_HEIGHT * 1.5;
const LATIN = "The quick brown fox jumps over the lazy dog and keeps running across the wide green field until the sun goes down behind the hills";
const CJK = "我们今天讨论一下这个项目的进展情况以及下一步的计划安排和需要注意的事项还有资源分配问题以及时间表".repeat(3);
const TOKEN = `https://example.com/${"a1b2c3d4e5".repeat(14)}`;

function expectComplete(report: Record<string, any>, name: string, step: string) {
  const state = report[`${name}-state`] as State;
  const field = report[`${name}-field`] as Frame;
  const where = `${name} ${step} (${state.value.length} chars, ${state.rows})`;
  if (state.rows === "one") {
    if (!oneLine(state.shown)) throw new Error(`${where}: one row but the field shows ${state.shown}pt of text`);
    near(field.h, COMPOSER_CONTROL_SIZE);
    // The hidden one-row copy is exactly as wide as the field it stands for.
    near(state.measures.oneRowWidth, field.w);
    return;
  }
  // The field is as tall as what it shows, and the controls are below it. Headless engines measure a
  // line break as no break at all: such a draft is held at two lines at least.
  const shown = state.value.includes("\n") ? Math.max(state.shown, 2 * COMPOSER_LINE_HEIGHT) : state.shown;
  if (oneLine(shown)) throw new Error(`${where}: two rows but the field shows one line (${state.shown}pt)`);
  near(field.h, Math.min(shown, 24 * COMPOSER_LINE_HEIGHT));
  near(state.height, shown);
  const controls = report[`${name}-controls`] as Frame;
  expect(controls.y).toBeGreaterThanOrEqual(field.y + field.h - 0.5);
  // Narrow: the text keeps the one-row width; wide: it takes the row.
  if (state.rows === "narrow") near(field.w, state.measures.oneRowWidth);
  else expect(field.w).toBeGreaterThan(state.measures.oneRowWidth + 1);
}

/** Types `text` key by key until a few keys past the full width, and deletes it again, checking
 *  every step; the rows after each length. */
async function typeAndDelete(app: App, report: () => Record<string, any>, name: string, text: string) {
  const input = `id:${name}-input`;
  const state = () => report()[`${name}-state`] as State;
  await app.clear(input);
  await app.waitUntil(() => state().value === "" && state().rows === "one");
  const forward: string[] = [];
  let typed = "";
  for (const char of [...text]) {
    if (forward.length >= 3 && forward.slice(-3).every((rows) => rows === "wide")) break;
    const before = state().changes;
    typed += char;
    await app.type(input, char);
    await app.waitUntil(() => state().value === typed);
    expectComplete(report(), name, `typing`);
    // One move at most per key: no flicker.
    expect(state().changes - before).toBeLessThanOrEqual(1);
    forward.push(state().rows);
  }
  const backward: string[] = [];
  for (let left = forward.length - 1; left >= 0; left -= 1) {
    const before = state().changes;
    await app.keyboard.press("backspace");
    await app.waitUntil(() => [...state().value].length === left);
    expectComplete(report(), name, "deleting");
    expect(state().changes - before).toBeLessThanOrEqual(1);
    backward[left] = state().rows;
  }
  // Deleting goes back through the same layouts, at the same lengths, to one row.
  expect(backward.slice(1)).toEqual(forward.slice(0, -1));
  expect(state().rows).toBe("one");
  return forward;
}

function steps(rows: string[]) {
  return rows.filter((value, index) => index === 0 || value !== rows[index - 1]);
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
    test(`on ${device}, typing ${script} across the wrap shows one row or the whole two-row layout, and deleting retraces it`, async () => {
      const { app, report } = await openRow(options);
      const rows = await typeAndDelete(app, report, "live", text);
      // One row, then above the controls at the one-row width, then the full width.
      expect(steps(rows)).toEqual(["one", "narrow", "wide"]);
    }, 120000);
  }

  test(`on ${device}, pastes, line breaks, clearing and wider actions land on the same layouts as typing`, async () => {
    const { app, report } = await openRow(options);
    const state = (name = "live") => report()[`${name}-state`] as State;
    // The shortest Latin draft that wraps beside the controls.
    let length = 0;
    await app.clear("id:live-input");
    while (state().rows === "one") {
      await app.type("id:live-input", LATIN[length]);
      length += 1;
      await frames(app);
    }
    expect(state().rows).toBe("narrow");
    await app.clear("id:live-input");
    await app.waitUntil(() => state().rows === "one");
    await frames(app);
    expectAligned(report(), "live");
    // Pasted at once: the same layout, in one move.
    for (const [draft, rows] of [
      [LATIN.slice(0, length - 1), "one"],
      [LATIN.slice(0, length), "narrow"],
      [LATIN, "wide"],
      ["one\ntwo", "wide"],
    ] as const) {
      await app.clear("id:live-input");
      await app.waitUntil(() => state().value === "");
      await frames(app);
      const before = state().changes;
      await app.paste("id:live-input", { text: draft });
      await app.waitUntil(() => state().value === draft);
      await frames(app);
      expect(state().rows).toBe(rows);
      expectComplete(report(), "live", `pasted`);
      if (state().changes - before > 1) throw new Error(`pasting ${JSON.stringify(draft)} moved the layout more than once: ${state().history}`);
    }
    // A line break moves a short draft to the full width at once; deleting it brings one row back.
    await app.clear("id:live-input");
    await app.type("id:live-input", "hi");
    await app.type("id:live-input", "\n");
    await app.waitUntil(() => state().value === "hi\n");
    await frames(app);
    expect(state().rows).toBe("wide");
    expectComplete(report(), "live", "line break");
    await app.keyboard.press("backspace");
    await app.waitUntil(() => state().value === "hi");
    await frames(app);
    expectAligned(report(), "live");
    // Wider actions narrow the one row, and the hidden copy with it: a draft that fits beside a
    // lone Send wraps beside the picker and Send, and the narrow field is that row's width.
    await app.type("id:tools-input", LATIN.slice(0, length - 1));
    await app.waitUntil(() => state("tools").value === LATIN.slice(0, length - 1));
    await frames(app);
    expect(state("tools").rows).toBe("narrow");
    expectComplete(report(), "tools", "beside wider actions");
    expect(state("tools").measures.oneRowWidth).toBeLessThan(state().measures.oneRowWidth - 80);
  }, 120000);

  test(`on ${device}, resizing the window moves a draft between the layouts and back the same way`, async () => {
    const { app, report } = await openRow(options);
    const state = () => report()["live-state"] as State;
    let length = 0;
    while (state().rows === "one") {
      await app.type("id:live-input", LATIN[length]);
      length += 1;
      await frames(app);
    }
    const first = state().rows;
    const seen: string[] = [];
    for (const width of [options.width + 160, options.width, options.width - 160, options.width]) {
      await app.setViewport(width, 700);
      await app.wait(100);
      expectComplete(report(), "live", `at ${width}pt`);
      seen.push(state().rows);
    }
    // Wider, the draft fits one row; narrower, it takes the full width; back, it is as it was.
    expect(seen).toEqual(["one", first, "wide", first]);
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
  // The desktop's frame is the one it had.
  expect(desktop).toBe("relative rounded-(--radius) border border-input bg-field transition duration-[260ms] focus-within:border-blue/45 focus-within:shadow-md");
  expect(phone.replace("border-line", "border-input")).toBe(desktop);
  for (const frame of [phone, desktop]) {
    const classes = frame.split(" ");
    // One 1pt border, the same radius, and the focus look over the resting colour.
    expect(classes).toContain("border");
    expect(classes.filter((name) => /^border-\d/.test(name))).toEqual([]);
    expect(classes).toContain("rounded-(--radius)");
    expect(classes).toContain("focus-within:border-blue/45");
    expect(classes).toContain("focus-within:shadow-md");
    expect(classes).toContain("bg-field");
  }
});
