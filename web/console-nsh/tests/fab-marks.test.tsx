// The page Fab's registration marks (components/ui.tsx, FAB_MARK): two open corners outside the
// button's top-left and bottom-right corners that turn on a continuous curve, as the button's own
// corners do. Headless tests cannot read a radius or a curve back from a view (tests/corners.test.tsx):
// the shape is checked through the classes the marks are built from, their size and gap through the
// frames they lay out at (tests/fixtures/fab-app.tsx), and the drawing by eye on the web target.
import { expect, open, test } from "nsh/test";
import { CONTINUOUS, cornerReach, fittingRadius, RADIUS } from "../components/corners";
import { FAB_MARK, FAB_MARK_CLASSES } from "../components/ui";

test("each mark turns on a continuous curve that fits it, at the joint of its two arms only", () => {
  expect(FAB_MARK).toEqual({ size: 10, gap: 5, radius: 3 });
  // The controls' radius, cut to one whose curve has room in the mark: the web draws a continuous
  // corner only where its reach fits half the shorter side, else a circular one.
  expect(FAB_MARK.radius).toBe(fittingRadius(RADIUS.control, FAB_MARK.size));
  expect(FAB_MARK.radius).toBeGreaterThan(0);
  expect(cornerReach(FAB_MARK.radius) * 2).toBeLessThanOrEqual(FAB_MARK.size);
  for (const cls of [FAB_MARK_CLASSES.start, FAB_MARK_CLASSES.end]) {
    expect(cls).toContain(CONTINUOUS);
    expect(cls).toContain("size-[10px]");
    // A hairline in the muted ink, as before: no outline round the button, no fill, no clip.
    expect(cls).toContain("border-muted-foreground");
    expect(cls).not.toMatch(/(^| )border( |$)/);
    expect(cls).not.toMatch(/(^| )bg-/);
    expect(cls).not.toContain("overflow-hidden");
    // One rounded corner, the joint: a radius at an open end would bend the hairline into a hook.
    expect(cls).not.toMatch(/(^| )rounded-(\[|\(|full|sm|md|lg|xl)/);
  }
  const start = FAB_MARK_CLASSES.start.split(" ");
  const end = FAB_MARK_CLASSES.end.split(" ");
  for (const c of ["border-l", "border-t", "rounded-tl-[3px]", "-left-[5px]", "-top-[5px]"]) expect(start).toContain(c);
  expect(start.filter((c) => c.startsWith("rounded-"))).toEqual(["rounded-tl-[3px]"]);
  for (const c of ["border-b", "border-r", "rounded-br-[3px]", "-bottom-[5px]", "-right-[5px]"]) expect(end).toContain(c);
  expect(end.filter((c) => c.startsWith("rounded-"))).toEqual(["rounded-br-[3px]"]);
});

type Frame = [number, number, number, number];

function partsOf(app: { texts(): string[] }): Record<string, Frame> {
  const line = app.texts().find((text) => text.startsWith("parts="));
  return JSON.parse(line?.slice("parts=".length) ?? "{}");
}

const FABS = ["plain", "disabled", "icon"];

async function openFabs(options: { platform: "linux" | "android"; width: number; reducedMotion?: boolean }) {
  const app = await open("./fixtures/fab-app.tsx", { width: options.width, height: 640, platform: options.platform, locale: "en-US", reducedMotion: options.reducedMotion });
  await app.waitFor("id:parts");
  await app.waitUntil(() => FABS.every((name) => ["fab", "fab-mark-start", "fab-mark-end"].every((part) => !!partsOf(app)[`${name}/${part}`])));
  // The entry motion moves the whole Fab, marks with it: wait for it to rest.
  await app.wait(600);
  return app;
}

for (const [platform, width, reducedMotion] of [
  ["linux", 1100, false],
  ["android", 390, false],
  ["linux", 1100, true],
] as const) {
  test(`the marks sit 5pt outside two opposite corners of the 52pt button (${platform}, ${width}pt${reducedMotion ? ", reduced motion" : ""})`, async () => {
    const app = await openFabs({ platform, width, reducedMotion });
    await app.waitUntil(() => {
      const p = partsOf(app);
      return FABS.every((name) => p[`${name}/fab-mark-start`][1] === p[`${name}/fab`][1] - FAB_MARK.gap);
    });
    const p = partsOf(app);
    for (const name of FABS) {
      const [x, y, w, h] = p[`${name}/fab`];
      expect([w, h]).toEqual([52, 52]);
      expect(p[`${name}/fab-mark-start`]).toEqual([x - 5, y - 5, 10, 10]);
      expect(p[`${name}/fab-mark-end`]).toEqual([x + w + 5 - 10, y + h + 5 - 10, 10, 10]);
    }
  });
}

test("the button still presses, names itself, and stays shut while disabled", async () => {
  const app = await openFabs({ platform: "linux", width: 1100 });
  expect(app.shows("label:Add")).toBe(true);
  expect(app.shows("label:New note")).toBe(true);
  expect(app.enabled("label:Add disabled")).toBe(false);
  await app.press("label:Add");
  await app.waitFor("text:presses=1");
  expect(app.enabled("label:Add")).toBe(true);
});
