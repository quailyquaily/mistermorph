// The composer's text on one row shares the centre line of the add button and Send beside it:
// empty (its placeholder), with text and focus (typing focuses it), and read-only, on a desktop and a phone. Text that
// wraps moves the field above the controls as before, and clearing it brings the one row back with
// the same geometry. The boxes come from components/chat/composerField.ts; the frames from
// tests/fixtures/composer-field-app.tsx, which lays the row out as ChatComposer does.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { COMPOSER_CONTROL_SIZE, COMPOSER_LINE_HEIGHT, composerFieldBox, composerRowClass } from "../components/chat/composerField";

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
