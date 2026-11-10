// The composer's text on one row shares the centre line of the add button and Send beside it:
// empty (its placeholder), with text and focus (typing focuses it), and read-only, on a desktop and a phone. Text that
// wraps moves the field above the controls as before, and clearing it brings the one row back with
// the same geometry. The boxes come from components/chat/composerField.ts; the frames from
// tests/fixtures/composer-field-app.tsx, which lays the row out as ChatComposer does.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { COMPOSER_CONTROL_SIZE, COMPOSER_LINE_HEIGHT, composerFieldBox, composerFrameBorder, composerFrameClass, composerRowClass } from "../components/chat/composerField";

type Frame = { x: number; y: number; w: number; h: number };
type State = { multi: boolean; measured: number; box: { height: number; paddingTop: number; paddingBottom: number } };

const near = (actual: number, expected: number, within = 0.5) => expect(Math.abs(actual - expected)).toBeLessThan(within);

async function openRow(options: { width: number; platform?: "linux" | "android" }) {
  const app = await open("./fixtures/composer-field-app.tsx", { height: 700, locale: "en-US", ...options });
  const report = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, any>;
  await app.waitUntil(() => ["live", "readonly"].every((name) => report()[`${name}-field`] && report()[`${name}-send`] && report()[`${name}-state`]));
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
  for (const part of ["add", "send"]) {
    const control = report[`${name}-${part}`] as Frame;
    near(control.h, COMPOSER_CONTROL_SIZE);
    near(lineCentre, control.y + control.h / 2);
    near(field.y + field.h / 2, control.y + control.h / 2);
  }
  // As tall as the controls (the old field was 35pt), with room for the whole measured line.
  near(field.h, COMPOSER_CONTROL_SIZE);
  expect(field.h - state.box.paddingTop - state.box.paddingBottom).toBeGreaterThanOrEqual(state.measured - 0.01);
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
    near(field.h, state.measured);
    // The controls' row (its frames are its own) goes below it.
    expect((report()["live-row"] as Frame).h).toBeGreaterThanOrEqual(field.y + field.h + COMPOSER_CONTROL_SIZE);
    await app.clear("id:live-input");
    await app.waitUntil(() => !(report()["live-state"] as State).multi);
    await app.waitUntil(() => Math.abs((report()["live-field"] as Frame).h - COMPOSER_CONTROL_SIZE) < 0.5);
    await frames(app);
    expectAligned(report(), "live");
  });
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
