// The page Fab's registration marks (components/fabMark.ts, drawn by `Fab` in components/ui.tsx):
// two open corners outside the button's top-left and bottom-right corners, each ONE stroked path
// (arm, continuous curve concentric with the button's corner, arm) on a decorative canvas, so no two
// separately painted border sides can part at the curve (FT157). Headless tests draw no canvas: the
// path is checked as data and through the calls it makes on a recording context, the canvases'
// size and placement through the frames they lay out at (tests/fixtures/fab-app.tsx), and the
// drawing by eye on the web target.
import { expect, open, test } from "nsh/test";
import { RADIUS } from "../components/corners";
import {
  CONTINUOUS_CORNER_CURVES,
  CONTINUOUS_CORNER_REACH,
  drawFabMark,
  FAB_MARK,
  FAB_MARK_ARM,
  FAB_MARK_OFFSET,
  FAB_MARK_RADIUS,
  FAB_MARK_SIZE,
  fabMarkPath,
  type MarkContext,
  type MarkSegment,
  type Point,
} from "../components/fabMark";

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const angle = (v: Point) => Math.atan2(v[1], v[0]);
const degrees = (rad: number) => {
  let d = (rad * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
};

/** The path's pieces as [from, to, direction at from, direction at to]. */
function pieces(start: Point, segments: MarkSegment[]) {
  const out: { kind: string; from: Point; to: Point; out: number; in: number }[] = [];
  let at = start;
  for (const s of segments) {
    if (s.kind === "line") out.push({ kind: "line", from: at, to: s.to, out: angle(sub(s.to, at)), in: angle(sub(s.to, at)) });
    else out.push({ kind: "curve", from: at, to: s.to, out: angle(sub(s.c1, at)), in: angle(sub(s.to, s.c2)) });
    at = s.to;
  }
  return out;
}

/** Points along the path, `steps` per piece. */
function samples(start: Point, segments: MarkSegment[], steps = 64): Point[] {
  const pts: Point[] = [start];
  let at = start;
  for (const s of segments) {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (s.kind === "line") pts.push([at[0] + (s.to[0] - at[0]) * t, at[1] + (s.to[1] - at[1]) * t]);
      else {
        const u = 1 - t;
        const f = (k: 0 | 1) => u * u * u * at[k] + 3 * u * u * t * s.c1[k] + 3 * u * t * t * s.c2[k] + t * t * t * s.to[k];
        pts.push([f(0), f(1)]);
      }
    }
    at = s.to;
  }
  return pts;
}

test("the marks keep the approved measures: 22pt arms, a 1pt stroke 5pt out, a 12.5pt concentric curve", () => {
  expect(FAB_MARK).toEqual({ button: 52, radius: RADIUS.control, gap: 5, stroke: 1, arm: 22 });
  expect(FAB_MARK.radius).toBe(8);
  expect(FAB_MARK_OFFSET).toBe(4.5);
  expect(FAB_MARK_RADIUS).toBe(12.5);
  expect(close(CONTINUOUS_CORNER_REACH, 1.52866483)).toBe(true);
  // The curve reaches about 19.1pt: the 22pt arms leave about 3pt of straight run past it.
  expect(FAB_MARK_ARM).toBe(22);
  expect(FAB_MARK_ARM - CONTINUOUS_CORNER_REACH * FAB_MARK_RADIUS).toBeGreaterThan(2.8);
  expect(FAB_MARK_SIZE).toBe(23);
});

test("each mark is one open path: an arm, three curves joined by their short runs, the other arm", () => {
  for (const corner of ["start", "end"] as const) {
    const { start, segments } = fabMarkPath(corner);
    expect(segments.map((s) => s.kind)).toEqual(["line", "curve", "line", "curve", "line", "curve", "line"]);
    // Open: its ends are apart, at the two arms' tips.
    const end = segments[segments.length - 1].to;
    expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeGreaterThan(20);
    // Every point lies inside its canvas, at least half a stroke from its edges.
    for (const p of samples(start, segments)) {
      for (const v of p) {
        expect(v).toBeGreaterThanOrEqual(FAB_MARK.stroke / 2 - 1e-9);
        expect(v).toBeLessThanOrEqual(FAB_MARK_SIZE - FAB_MARK.stroke / 2 + 1e-9);
      }
    }
  }
});

test("the top-left mark's arms run 22pt straight from its corner point and meet the curve on its tangents", () => {
  const { start, segments } = fabMarkPath("start");
  const corner: Point = [0.5, 0.5];
  const end = segments[segments.length - 1].to;
  expect(start).toEqual([22.5, 0.5]);
  expect(end).toEqual([0.5, 22.5]);
  // The straight arms: along the top edge, then down the left edge, to the curve's tangent points.
  const reach = CONTINUOUS_CORNER_REACH * FAB_MARK_RADIUS;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const before = segments[segments.length - 2];
  expect(first.kind === "line" && close(first.to[1], corner[1]) && close(first.to[0], corner[0] + reach)).toBe(true);
  expect(before.to[0]).toBe(corner[0]);
  expect(close(before.to[1], corner[1] + reach)).toBe(true);
  expect(last.kind).toBe("line");
  const parts = pieces(start, segments);
  // The arm and the curve share their direction where they meet: no corner at either tangent point.
  expect(close(degrees(parts[1].out - parts[0].in), 0)).toBe(true);
  expect(close(degrees(parts[6].out - parts[5].in), 0)).toBe(true);
  // Inside the turn, Core Animation's curve runs straight for under half a point between its three
  // curves, a few degrees off them (joined round): no step a 1pt stroke shows.
  for (const k of [2, 4]) {
    const run = parts[k];
    expect(Math.hypot(run.to[0] - run.from[0], run.to[1] - run.from[1])).toBeLessThan(0.5);
    expect(Math.abs(degrees(run.out - parts[k - 1].in))).toBeLessThan(6.5);
    expect(Math.abs(degrees(parts[k + 1].out - run.in))).toBeLessThan(6.5);
  }
  // Every piece starts where the last ended (the path is one chain) and the whole turn is a quarter.
  expect(close(degrees(parts[6].in - parts[0].out), -90)).toBe(true);
});

test("the curve stays concentric with the button's corner: an even clear gap of about 4pt round the turn", () => {
  // The button's corner in the start mark's canvas: 5pt in from its top left, radius 8, the same curve.
  const at = FAB_MARK.gap;
  const outline: Point[] = [];
  for (const [p0, c1, c2, p1] of CONTINUOUS_CORNER_CURVES) {
    const seg: MarkSegment = { kind: "curve", c1: [at + c1[0] * 8, at + c1[1] * 8], c2: [at + c2[0] * 8, at + c2[1] * 8], to: [at + p1[0] * 8, at + p1[1] * 8] };
    outline.push(...samples([at + p0[0] * 8, at + p0[1] * 8], [seg], 400));
  }
  for (let x = at + 8 * CONTINUOUS_CORNER_REACH; x <= FAB_MARK_SIZE; x += 0.05) outline.push([x, at]);
  for (let y = at + 8 * CONTINUOUS_CORNER_REACH; y <= FAB_MARK_SIZE; y += 0.05) outline.push([at, y]);
  const { start, segments } = fabMarkPath("start");
  let lo = Infinity;
  let hi = 0;
  for (const p of samples(start, segments, 48)) {
    let d = Infinity;
    for (const q of outline) d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1]));
    // From the button's edge to the stroke's inner edge.
    const gap = d - FAB_MARK.stroke / 2;
    lo = Math.min(lo, gap);
    hi = Math.max(hi, gap);
  }
  expect(lo).toBeGreaterThan(3.9);
  expect(hi).toBeLessThan(4.05);
});

test("the bottom-right mark is the top-left one turned half round its canvas", () => {
  const a = fabMarkPath("start");
  const b = fabMarkPath("end");
  const turn = (p: Point): Point => [FAB_MARK_SIZE - p[0], FAB_MARK_SIZE - p[1]];
  expect(b.start).toEqual(turn(a.start));
  expect(b.segments.length).toBe(a.segments.length);
  a.segments.forEach((s, i) => {
    const t = b.segments[i];
    expect(t.kind).toBe(s.kind);
    expect(t.to).toEqual(turn(s.to));
    if (s.kind === "curve" && t.kind === "curve") {
      expect(t.c1).toEqual(turn(s.c1));
      expect(t.c2).toEqual(turn(s.c2));
    }
  });
  expect(b.start).toEqual([0.5, 22.5]);
  expect(b.segments[b.segments.length - 1].to).toEqual([22.5, 0.5]);
});

/** A context that records the calls a mark makes on it. */
function recordingContext() {
  const calls: string[] = [];
  const cx: MarkContext & Record<string, unknown> = {
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    strokeStyle: "",
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    bezierCurveTo: () => calls.push("bezierCurveTo"),
    stroke: () => calls.push("stroke"),
  };
  for (const name of ["fill", "fillRect", "strokeRect", "rect", "roundRect", "closePath", "arc", "arcTo", "clip", "setLineDash"]) {
    cx[name] = () => calls.push(name);
  }
  return { cx, calls };
}

test("a mark draws one single stroke in the given ink and fills nothing", () => {
  for (const corner of ["start", "end"] as const) {
    const { cx, calls } = recordingContext();
    drawFabMark(cx, corner, "#5f7894");
    expect(calls).toEqual(["beginPath", "moveTo", "lineTo", "bezierCurveTo", "lineTo", "bezierCurveTo", "lineTo", "bezierCurveTo", "lineTo", "stroke"]);
    expect([cx.lineWidth, cx.lineCap, cx.lineJoin, cx.strokeStyle]).toEqual([1, "butt", "round", "#5f7894"]);
  }
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
  test(`the two mark canvases sit 5pt outside opposite corners of the 52pt button (${platform}, ${width}pt${reducedMotion ? ", reduced motion" : ""})`, async () => {
    const app = await openFabs({ platform, width, reducedMotion });
    await app.waitUntil(() => {
      const p = partsOf(app);
      return FABS.every((name) => p[`${name}/fab-mark-start`][1] === p[`${name}/fab`][1] - FAB_MARK.gap);
    });
    const p = partsOf(app);
    for (const name of FABS) {
      const [x, y, w, h] = p[`${name}/fab`];
      expect([w, h]).toEqual([52, 52]);
      // Their outer corners 5pt out from the button's, mirrored: the stroke's corner point 4.5pt out.
      expect(p[`${name}/fab-mark-start`]).toEqual([x - 5, y - 5, 23, 23]);
      expect(p[`${name}/fab-mark-end`]).toEqual([x + w + 5 - 23, y + h + 5 - 23, 23, 23]);
    }
    // The decorations add no names or texts: one label per button, as before.
    expect(app.count("label:Add")).toBe(1);
    expect(app.count("label:Add disabled")).toBe(1);
    expect(app.count("label:New note")).toBe(1);
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
  await app.press("label:New note");
  expect(app.texts()).toContain("presses=1");
});
