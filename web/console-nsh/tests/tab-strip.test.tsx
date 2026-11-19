// The shared Tabs (components/ui.tsx) when their options do not fit: they keep their own widths
// (labels are never squeezed) in a strip no wider than its box, which scrolls sideways; a finger
// swipes it to either end without choosing anything, an up or down swipe on it scrolls the page; a
// tap (or the keyboard) chooses an option and brings it wholly into view, moving the strip as little
// as it must, gliding unless the system reduces motion; the current option is in view from the
// first layout and stays so as the strip or its options change size; a strip that fits again is a
// plain row. `equal` options share a row they fit (equally while each label allows, the rest
// equally otherwise) and scroll at their own widths when they do not. The arithmetic is
// components/shared/tabStrip.ts; frames come from tests/fixtures/tab-strip-app.tsx (probeTabStrips).
// A mouse's press-and-drag (onMouseMove with the button held) has no headless step: it was checked
// in Chrome. The workspace picker's phone tabs: tests/workspace-dir-picker.test.tsx.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { equalTabWidths, TAB_REVEAL_MARGIN, tabInView, tabRevealOffset } from "../components/shared/tabStrip";

type Box = { x: number; w: number };
type Strip = {
  viewport: number;
  content: number;
  offset: number;
  scrolls: boolean;
  value: string;
  boxes: Record<string, Box>;
  natural: Record<string, number>;
  reveals: number;
  glided: boolean | null;
  focused: string | null;
};

async function openStrips(options: { width?: number; platform?: "android" | "linux"; reducedMotion?: boolean } = {}) {
  const app = await open("./fixtures/tab-strip-app.tsx", {
    width: options.width ?? 390,
    height: 700,
    platform: options.platform ?? "android",
    locale: "en-US",
    reducedMotion: options.reducedMotion ?? false,
  });
  await app.waitUntil(() => ["strip", "equal-fit", "equal-uneven", "equal-over", "short"].every((id) => Object.keys(strip(app, id)?.boxes ?? {}).length >= 3));
  await app.wait(100);
  return app;
}

function strip(app: App, id = "strip"): Strip {
  const text = app.texts().find((item) => item.startsWith("{")) ?? "{}";
  return (JSON.parse(text) as Record<string, Strip>)[id];
}

const out = (app: App, name: string) => (app.texts().find((text) => text.startsWith(`${name}=`)) ?? "").slice(name.length + 1);
const shown = (s: Strip, id: string) => ({ id, shown: tabInView(s.boxes[id], s.viewport, s.offset) });
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

test("equal shares: equal while each label fits its share, the rest equal around a longer one, own widths past the room", () => {
  expect(equalTabWidths([40, 50, 60], 300)).toEqual([100, 100, 100]);
  // A label longer than an equal share keeps its width; the others share what is left.
  expect(equalTabWidths([30, 30, 170], 300)).toEqual([65, 65, 170]);
  // Two longer than their shares, widest first: the last one takes what the two leave.
  expect(equalTabWidths([30, 120, 140], 300)).toEqual([40, 120, 140]);
  // Labels that need more than the room keep their own widths (the strip scrolls).
  expect(equalTabWidths([171, 163, 140], 300)).toEqual([171, 163, 140]);
  expect(equalTabWidths([100, 100, 100], 300)).toEqual([100, 100, 100]);
  expect(equalTabWidths([], 300)).toEqual([]);
  expect(equalTabWidths([40, 50], 0)).toEqual([40, 50]);
  for (const [natural, room] of [
    [[10, 200, 20, 30], 400],
    [[80, 80, 120], 300],
    [[36, 36], 343],
  ] as [number[], number][]) {
    const widths = equalTabWidths(natural, room);
    expect(Math.abs(sum(widths) - room)).toBeLessThan(1e-9);
    widths.forEach((width, index) => expect(width).toBeGreaterThanOrEqual(natural[index]));
  }
});

test("bringing an option into view moves the strip as little as it must, the same wherever it was", () => {
  const viewport = 300;
  const content = 1600;
  // Already in view: no move.
  expect(tabRevealOffset({ x: 400, w: 100 }, viewport, content, 300)).toBe(300);
  expect(tabRevealOffset({ x: 300, w: 300 }, viewport, content, 300)).toBe(300);
  // Cut at the end: its end comes in, a margin clear of the edge.
  expect(tabRevealOffset({ x: 550, w: 100 }, viewport, content, 300)).toBe(650 + TAB_REVEAL_MARGIN - viewport);
  // Cut at the start: its start comes in, a margin clear of the edge.
  expect(tabRevealOffset({ x: 280, w: 100 }, viewport, content, 300)).toBe(280 - TAB_REVEAL_MARGIN);
  // Wider than the view with its margins: centred; wider than the view: its start.
  expect(tabRevealOffset({ x: 500, w: 290 }, viewport, content, 0)).toBe(495);
  expect(tabRevealOffset({ x: 500, w: 400 }, viewport, content, 0)).toBe(500);
  expect(tabRevealOffset({ x: 500, w: 400 }, viewport, content, 900)).toBe(500);
  // The content's ends bound it.
  expect(tabRevealOffset({ x: 0, w: 100 }, viewport, content, 700)).toBe(0);
  expect(tabRevealOffset({ x: 1500, w: 100 }, viewport, content, 0)).toBe(1300);
  // Fitting content never scrolls.
  expect(tabRevealOffset({ x: 200, w: 100 }, 300, 300, 50)).toBe(0);
  // Settled: a second pass leaves it where the first put it (no back and forth).
  for (const box of [{ x: 550, w: 100 }, { x: 280, w: 100 }, { x: 500, w: 290 }, { x: 500, w: 400 }]) {
    for (const from of [0, 300, 900, 1300]) {
      const once = tabRevealOffset(box, viewport, content, from);
      expect(tabRevealOffset(box, viewport, content, once)).toBe(once);
      expect(tabInView(box, viewport, once)).toBe(true);
    }
  }
});

test("options that do not fit keep their own widths in a strip as wide as its box, the current (last) one in view from the first layout", async () => {
  const app = await openStrips();
  const s = strip(app);
  expect(s.viewport).toBe(300);
  expect(s.scrolls).toBe(true);
  expect(app.count("id:strip-scroll")).toBe(1);
  // Each option as wide as its label, end to end: nothing squeezed.
  ids(10).forEach((id, index) => {
    expect({ id, w: s.boxes[id].w }).toEqual({ id, w: s.natural[id] });
    if (index > 0) expect({ id, x: s.boxes[id].x }).toEqual({ id, x: s.boxes[`t${index - 1}`].x + s.boxes[`t${index - 1}`].w });
  });
  expect(s.content).toBe(sum(ids(10).map((id) => s.natural[id])));
  // The current option, the last, is in view: the strip opened at its end, at once.
  expect(s.value).toBe("t9");
  expect(shown(s, "t9")).toEqual({ id: "t9", shown: true });
  expect(s.offset).toBe(s.content - s.viewport);
  expect(s.glided).toBe(false);
  // A strip that fits is a plain row as wide as its options, not a scroller.
  const short = strip(app, "short");
  expect(short.scrolls).toBe(false);
  expect(app.count("id:short-scroll")).toBe(0);
  expect(short.viewport).toBe(short.content);
  expect(short.content).toBe(sum(Object.values(short.natural)));
  expect(short.offset).toBe(0);
  expect(app.count("role:tab[Home directory]")).toBe(1);
  expect(app.shows("label:Places")).toBe(true);
});

test("equal options share a row they fit, equally while each label allows, and scroll at their own widths when they do not", async () => {
  const app = await openStrips();
  const fit = strip(app, "equal-fit");
  expect([fit.boxes.a.w, fit.boxes.b.w, fit.boxes.c.w]).toEqual([100, 100, 100]);
  expect([fit.viewport, fit.scrolls]).toEqual([300, false]);
  const uneven = strip(app, "equal-uneven");
  // The long label keeps its width, the short two share the rest equally (to the half point).
  expect(uneven.boxes.c.w).toBe(uneven.natural.c);
  expect(Math.abs(uneven.boxes.a.w - uneven.boxes.b.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(uneven.boxes.a.w + uneven.boxes.b.w + uneven.boxes.c.w - 300)).toBeLessThanOrEqual(0.5);
  expect(uneven.boxes.a.w).toBeGreaterThan(uneven.natural.a);
  expect(uneven.scrolls).toBe(false);
  const over = strip(app, "equal-over");
  expect(over.scrolls).toBe(true);
  expect(over.viewport).toBe(300);
  for (const id of ["a", "b", "c"]) expect({ id, w: over.boxes[id].w }).toEqual({ id, w: over.natural[id] });
});

test("a swipe along the strip reaches either end and chooses nothing", async () => {
  const app = await openStrips();
  await app.drag("id:strip-scroll", { x: 2000 });
  await app.wait(200);
  let s = strip(app);
  expect(s.offset).toBe(0);
  expect(shown(s, "t0")).toEqual({ id: "t0", shown: true });
  // Started on an option: the press it began is cancelled.
  await app.drag("id:strip-t1", { x: -2500 });
  await app.wait(200);
  s = strip(app);
  expect(s.offset).toBe(s.content - s.viewport);
  expect(shown(s, "t9")).toEqual({ id: "t9", shown: true });
  expect(out(app, "presses")).toBe("");
  expect(out(app, "value")).toBe("t9");
});

test("a tap chooses an option and brings all of it into view with the least move; one in view does not move the strip", async () => {
  const app = await openStrips();
  await app.drag("id:strip-scroll", { x: 2000 });
  await app.wait(200);
  const before = strip(app);
  const cut = ids(10).find((id) => {
    const box = before.boxes[id];
    return box.x < before.viewport && box.x + box.w > before.viewport;
  })!;
  expect(cut).toBeDefined();
  await app.press(`id:strip-${cut}`);
  await app.waitUntil(() => strip(app).value === cut && strip(app).reveals > before.reveals);
  const after = strip(app);
  expect(out(app, "presses")).toBe(cut);
  expect(after.offset).toBe(tabRevealOffset(after.boxes[cut], after.viewport, after.content, 0));
  expect(after.offset).toBe(after.boxes[cut].x + after.boxes[cut].w + TAB_REVEAL_MARGIN - after.viewport);
  expect(shown(after, cut)).toEqual({ id: cut, shown: true });
  expect(after.glided).toBe(true);
  // An option already in view: chosen, the strip stays.
  const inView = ids(10).find((id) => id !== cut && tabInView(after.boxes[id], after.viewport, after.offset))!;
  await app.press(`id:strip-${inView}`);
  await app.waitUntil(() => out(app, "value") === inView);
  await app.wait(100);
  expect([strip(app).offset, strip(app).reveals]).toEqual([after.offset, after.reveals]);
});

test("an up or down swipe on a strip scrolls the page, not the strip, and chooses nothing", async () => {
  const app = await openStrips();
  const before = strip(app);
  await app.drag("id:strip-t8", { y: -200 });
  await app.wait(200);
  expect(Number(out(app, "page"))).toBeGreaterThan(100);
  expect(strip(app).offset).toBe(before.offset);
  expect(out(app, "presses")).toBe("");
  // And on one that fits.
  await app.drag("id:filler", { y: 400 });
  await app.wait(200);
  expect(Number(out(app, "page"))).toBe(0);
  await app.drag("id:short-b", { y: -150 });
  await app.wait(200);
  expect(Number(out(app, "page"))).toBeGreaterThan(50);
  expect(strip(app, "short").value).toBe("a");
});

test("a choice made elsewhere glides into view; a resize keeps the current option in view; a strip that fits again is a plain row", async () => {
  const app = await openStrips();
  await app.press("id:pick-first");
  await app.waitUntil(() => strip(app).value === "t0");
  expect(strip(app).offset).toBe(0);
  expect(strip(app).glided).toBe(true);
  await app.press("id:pick-middle");
  await app.waitUntil(() => strip(app).value === "t5");
  let s = strip(app);
  // From the start, the middle option comes in at the end edge.
  expect(s.offset).toBe(tabRevealOffset(s.boxes.t5, s.viewport, s.content, 0));
  expect(shown(s, "t5")).toEqual({ id: "t5", shown: true });
  // A narrower box: still in view, moved at once (a layout change, nothing to follow).
  await app.press("id:narrower");
  await app.waitUntil(() => strip(app).viewport === 200);
  s = strip(app);
  expect(shown(s, "t5")).toEqual({ id: "t5", shown: true });
  expect(s.glided).toBe(false);
  // A wider window, the box as wide as the page: still in view.
  await app.setViewport(700, 700);
  await app.press("id:wider");
  await app.waitUntil(() => strip(app).viewport === 700 - 32);
  s = strip(app);
  expect(shown(s, "t5")).toEqual({ id: "t5", shown: true });
  // A phone again.
  await app.setViewport(320, 700);
  await app.waitUntil(() => strip(app).viewport === 320 - 32);
  expect(shown(strip(app), "t5")).toEqual({ id: "t5", shown: true });
  // Two options fit: a plain row at its start; ten again: a scroller showing the current one.
  await app.press("id:pick-first");
  await app.press("id:fewer");
  await app.waitUntil(() => !strip(app).scrolls);
  expect(app.count("id:strip-scroll")).toBe(0);
  expect(strip(app).offset).toBe(0);
  await app.press("id:pick-last");
  await app.press("id:more");
  await app.waitUntil(() => strip(app).scrolls && app.count("id:strip-scroll") === 1);
  await app.waitUntil(() => tabInView(strip(app).boxes.t9, strip(app).viewport, strip(app).offset));
});

test("with reduced motion the strip jumps to a chosen option instead of gliding", async () => {
  const app = await openStrips({ reducedMotion: true });
  await app.press("id:pick-first");
  await app.waitUntil(() => strip(app).value === "t0" && strip(app).offset === 0);
  expect(strip(app).glided).toBe(false);
  await app.press("id:strip-t2");
  await app.waitUntil(() => strip(app).value === "t2" && shown(strip(app), "t2").shown);
  expect(strip(app).glided).toBe(false);
});

test("Tab reaches each option, skipping a disabled one, and brings the focused one into view; Enter chooses it", async () => {
  const app = await openStrips({ platform: "linux" });
  await app.press("id:disable");
  expect(app.enabled("id:strip-t3")).toBe(false);
  await app.press("id:pick-first");
  await app.waitUntil(() => strip(app).offset === 0);
  // Tab from the start of the window to the third option, partly cut at the strip's end.
  for (let i = 0; i < 20 && strip(app).focused !== "t2"; i++) await app.keyboard.press("tab");
  expect(strip(app).focused).toBe("t2");
  await app.wait(100);
  let s = strip(app);
  expect(shown(s, "t2")).toEqual({ id: "t2", shown: true });
  // A margin past the edge. (Headless, the core also scrolls a Tab-focused view into view by itself,
  // to the same place, so this checks the outcome; a browser leaves an option that is partly in view
  // cut, and only the strip's own move on `onFocus` brings it in: checked in Chrome.)
  expect(s.offset).toBe(s.boxes.t2.x + s.boxes.t2.w + TAB_REVEAL_MARGIN - s.viewport);
  // The disabled fourth is skipped; the fifth, beyond the edge, comes into view.
  await app.keyboard.press("tab");
  expect(strip(app).focused).toBe("t4");
  await app.wait(100);
  s = strip(app);
  expect(shown(s, "t4")).toEqual({ id: "t4", shown: true });
  expect(s.offset).toBe(s.boxes.t4.x + s.boxes.t4.w + TAB_REVEAL_MARGIN - s.viewport);
  expect(out(app, "value")).toBe("t0");
  await app.keyboard.press("enter");
  await app.waitUntil(() => out(app, "value") === "t4");
  expect(out(app, "presses")).toBe("t4");
  expect(shown(strip(app), "t4")).toEqual({ id: "t4", shown: true });
});
