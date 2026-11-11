// The workspace panel's path line (components/chat/WorkspacePathLine.tsx) at many widths: one line
// that never runs past its box, whole while it fits, else cut in the middle with "..." keeping the
// beginning and the end, and laid out again as the box is resized.
import { expect, open, test, type App } from "nsh/test";
import { PATH_ELLIPSIS, textUnits, workspacePathDisplay } from "../components/chat/workspacePath";

type Line = {
  testID: string;
  room: number;
  fullWidth: number;
  shownWidth: number;
  shownHeight: number;
  fullHeight: number;
  text: string;
  truncated: boolean;
};
type Report = { box: number; path: string; line: Line | null };

const HOME = "/home/me";
const PATHS = ["home", "short", "long", "outside", "wide"] as const;
const WIDTHS = [80, 160, 240, 320, 480, 960];

function report(app: App): Report {
  return JSON.parse(app.texts().find((text) => text.startsWith('{"box"')) ?? '{"box":0,"path":"","line":null}') as Report;
}

/** Waits for the line to be laid out for the box, and for its cut to settle. */
async function settled(app: App) {
  await app.waitUntil(() => {
    const now = report(app);
    const line = now.line;
    return !!line && now.box > 0 && line.room > 0 && line.fullWidth > 0 && line.shownWidth > 0 && line.room <= now.box;
  });
  await app.wait(50);
  return report(app);
}

async function show(app: App, path: string, width: number) {
  await app.press(`id:path-${path}`);
  await app.press(`id:width-${width}`);
  return settled(app);
}

/** The line as it should be for what the report says: inside its room, one line, cut only when it must be. */
function expectFitted(now: Report) {
  const line = now.line!;
  const display = workspacePathDisplay(now.path, HOME).text;
  expect(line.room).toBeLessThanOrEqual(now.box);
  // One line: as tall as the whole path laid out at its own width (headless runs ignore
  // `leading-5`, so the height is the font's).
  expect(line.shownHeight).toBeGreaterThan(0);
  expect(line.shownHeight).toBe(line.fullHeight);
  const fits = line.fullWidth <= line.room + 0.5;
  expect(line.truncated).toBe(!fits);
  if (fits) {
    expect(line.text).toBe(display);
    expect(line.shownWidth).toBe(line.fullWidth);
    return;
  }
  expect(line.shownWidth).toBeLessThanOrEqual(line.room + 0.5);
  const parts = line.text.split(PATH_ELLIPSIS);
  expect(parts).toHaveLength(2);
  expect(parts[0].length).toBeGreaterThan(0);
  expect(parts[1].length).toBeGreaterThan(0);
  expect(display.startsWith(parts[0])).toBe(true);
  expect(display.endsWith(parts[1])).toBe(true);
  // A cut line uses its room: less than three cells of it are left over (whole wide characters).
  const cell = line.fullWidth / textUnits(display);
  expect(line.room - line.shownWidth).toBeLessThan(cell * 3 + 0.5);
}

test("at every width every path stays on one line inside its box, cut in the middle only when it must be", async () => {
  const app = await open("./fixtures/workspace-path-app.tsx", { width: 1100, height: 600, platform: "linux", locale: "en-US" });
  for (const path of PATHS) {
    for (const width of WIDTHS) {
      const now = await show(app, path, width);
      try {
        expectFitted(now);
      } catch (error) {
        throw new Error(`${path} at ${width}pt: ${JSON.stringify(now)}: ${String(error)}`);
      }
    }
  }
}, 60000);

test("the home is ~, a folder in it ~/…, and a path elsewhere is written in full", async () => {
  const app = await open("./fixtures/workspace-path-app.tsx", { width: 1100, height: 600, platform: "linux", locale: "en-US" });
  expect((await show(app, "home", 480)).line!.text).toBe("~");
  expect((await show(app, "short", 480)).line!.text).toBe("~/notes");
  expect((await show(app, "long", 960)).line!.text).toBe(
    "~/code/clients/acme/monorepo/services/billing-gateway/internal/reconciliation-worker",
  );
  expect((await show(app, "outside", 960)).line!.text).toBe("/srv/data/projects/archive/2026/quarterly-reports/finance-department-final");
  // Short paths fit even the narrowest box.
  expect((await show(app, "home", 80)).line!.truncated).toBe(false);
  expect((await show(app, "short", 80)).line!.truncated).toBe(false);
  // A path outside the home keeps its own beginning when cut.
  const outside = await show(app, "outside", 240);
  expect(outside.line!.truncated).toBe(true);
  expect(outside.line!.text.startsWith("/srv/")).toBe(true);
  expect(outside.line!.text.endsWith("final")).toBe(true);
});

test("resizing the box cuts the path, widens it again and restores it whole", async () => {
  const app = await open("./fixtures/workspace-path-app.tsx", { width: 1100, height: 600, platform: "linux", locale: "en-US" });
  const whole = await show(app, "long", 960);
  expect(whole.line!.truncated).toBe(false);
  const steps: Report[] = [];
  for (const width of [480, 320, 240, 160, 240, 480, 960]) {
    await app.press(`id:width-${width}`);
    const now = await settled(app);
    expectFitted(now);
    steps.push(now);
  }
  const shown = steps.map((step) => step.line!.text.length);
  // Narrower boxes show less, wider ones more, and the full width shows it all again.
  expect(shown[1]).toBeLessThan(shown[0]);
  expect(shown[2]).toBeLessThan(shown[1]);
  expect(shown[3]).toBeLessThan(shown[2]);
  expect(shown[4]).toBe(shown[2]);
  expect(shown[5]).toBe(shown[0]);
  expect(steps[6].line!.text).toBe(whole.line!.text);
  expect(steps[6].line!.truncated).toBe(false);
  // A cut line uses its room: less than two cells of it are left over.
  for (const step of steps.filter((item) => item.line!.truncated)) {
    const cell = step.line!.fullWidth / step.line!.text.length;
    expect(step.line!.room - step.line!.shownWidth).toBeLessThan(cell * 2 + 0.5);
  }
}, 30000);

test("wide characters are measured as laid out, and the cut line still fits", async () => {
  const app = await open("./fixtures/workspace-path-app.tsx", { width: 1100, height: 600, platform: "linux", locale: "en-US" });
  for (const width of [160, 240, 320]) {
    const now = await show(app, "wide", width);
    expectFitted(now);
    expect(now.line!.text.startsWith("~/")).toBe(true);
  }
});

test("switching paths at one width cuts each anew from its own width", async () => {
  const app = await open("./fixtures/workspace-path-app.tsx", { width: 1100, height: 600, platform: "linux", locale: "en-US" });
  for (const width of [160, 240]) {
    await app.press(`id:width-${width}`);
    for (const path of ["short", "long", "outside", "wide", "home", "outside", "long"]) {
      await app.press(`id:path-${path}`);
      const now = await settled(app);
      try {
        expectFitted(now);
      } catch (error) {
        throw new Error(`${path} at ${width}pt: ${JSON.stringify(now)}: ${String(error)}`);
      }
    }
  }
}, 30000);

test("on the Android platform the line is cut and fits the same way (headless)", async () => {
  const app = await open("./fixtures/workspace-path-app.tsx", { width: 390, height: 844, platform: "android", locale: "en-US" });
  for (const path of ["long", "outside", "short", "home"]) {
    for (const width of [160, 320]) {
      const now = await show(app, path, width);
      try {
        expectFitted(now);
      } catch (error) {
        throw new Error(`${path} at ${width}pt: ${JSON.stringify(now)}: ${String(error)}`);
      }
    }
  }
}, 30000);
