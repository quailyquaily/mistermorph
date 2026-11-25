// A skill_install approval card keeps its long values inside it (FT178). Its rows put several texts
// side by side in a wrapping row, and a text wider than the row kept its whole width, so a GitHub
// source (its link carries the whole commit), a finding's title or file:line, a note's evidence and
// a coverage gap's path ran past the card's right border on a phone. Now every such text may shrink
// to the row and wraps inside, breaking inside a long unbroken run; short values still sit on one
// line, the source is still one link to the whole URL, and folds still open and close.
// The fixture: tests/fixtures/skill-install-preview-app.tsx.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { ARCHIVE_URL, EVIDENCE, GAP_NOTE, GAP_PATH, GITHUB_URL, LONG_FILE, UNBROKEN_TITLE, URL_TITLE } from "./fixtures/skillPreviewValues";

type Frame = { x: number; y: number; w: number; h: number };
type Report = { width: number; case: string; frames: Record<string, Frame> };

const WIDTHS = [
  { name: "a 360pt phone", width: 360, phone: true, platform: "android" as const },
  { name: "a 390pt phone", width: 390, phone: true, platform: undefined },
  { name: "a desktop", width: 1280, phone: false, platform: undefined },
];

const report = (app: App): Report => {
  const text = app.texts().find((line) => line.startsWith("frames:"));
  return JSON.parse(text ? text.slice("frames:".length) : '{"width":0,"case":"","frames":{}}');
};

// The parts each case must report: every long value, and a short finding for comparison.
const LONG_PARTS: Record<string, string[]> = {
  complete: [
    "source",
    "finding:0",
    "finding-title:0",
    "finding-place:0",
    "finding-evidence:0",
    "finding:1",
    "finding-title:1",
    "finding-place:1",
    "finding:3",
    "finding-title:3",
    "finding-place:3",
    "note:4",
    "note-title:4",
    "note-place:4",
    "note-evidence:4",
    "note:5",
    "note-title:5",
    "caret:r-complete:skill:finding:0",
    "caret:r-complete:skill:finding:2",
  ],
  incomplete: [
    "source",
    "commit",
    "error:PhXCircle",
    `gap:${GAP_PATH}`,
    `gap-path:${GAP_PATH}`,
    `gap-status:${GAP_PATH}`,
    `gap-note:${GAP_PATH}`,
    "finding-title:0",
    "finding-place:0",
    "note-evidence:4",
  ],
};

async function openCase(width: number, platform: "android" | undefined, name: string, parts: string[]) {
  const app = await open("./fixtures/skill-install-preview-app.tsx", { width, height: 4000, locale: "en-US", platform });
  await app.press(`id:case-${name}`);
  await settle(app, name, ["preview", ...parts]);
  return app;
}

async function settle(app: App, name: string, parts: string[]) {
  await app.waitUntil(() => {
    const now = report(app);
    return now.case === name && parts.every((part) => Boolean(now.frames[part]));
  });
  // Let a second layout pass report too.
  await app.wait(100);
}

const right = (frame: Frame) => frame.x + frame.w;

/** Every reported part lies within the card's content box, which lies within the window. */
function expectInsideCard(now: Report) {
  const card = now.frames.preview;
  expect(right(card) <= now.width + 0.5).toBe(true);
  for (const [name, frame] of Object.entries(now.frames)) {
    const where = `${now.case} ${name}: ${JSON.stringify(frame)} in ${JSON.stringify(card)}`;
    const ok = frame.x >= card.x - 0.5 && right(frame) <= right(card) + 0.5;
    expect({ where, ok }).toEqual({ where, ok: true });
  }
}

/** The parts lie on one line: same top, same height (one line of text). */
function expectOneLine(now: Report, names: string[], line: number) {
  const tops = names.map((name) => Math.round(now.frames[name].y));
  const heights = names.map((name) => now.frames[name].h);
  const where = `${now.case} ${names.join(",")}: ${JSON.stringify(names.map((name) => now.frames[name]))}`;
  expect({ where, ok: tops.every((top) => top === tops[0]) && heights.every((h) => h <= line + 0.5) }).toEqual({ where, ok: true });
}

for (const { name, width, phone, platform } of WIDTHS) {
  test(`on ${name}, the source, findings and notes stay inside the card`, async () => {
    const app = await openCase(width, platform, "complete", LONG_PARTS.complete);
    const now = report(app);
    expectInsideCard(now);
    // A line of text is as tall as the severity mark.
    const line = now.frames["finding-severity:2"].h;
    // A short finding keeps its severity, title and file:line on one line.
    expectOneLine(now, ["finding-severity:2", "finding-title:2", "finding-place:2"], line);
    // A fold's caret stays by its summary's first line: centred on a one-line summary, at the top
    // of a wrapped one.
    const middle = (frame: Frame) => frame.y + frame.h / 2;
    const shortCaret = now.frames["caret:r-complete:skill:finding:2"];
    expect(Math.abs(middle(shortCaret) - middle(now.frames["finding:2"])) <= 1).toBe(true);
    const longCaret = now.frames["caret:r-complete:skill:finding:0"];
    expect(Math.abs(longCaret.y - now.frames["finding:0"].y) <= 1).toBe(true);
    if (phone) {
      // Too long for the row: wrapped onto more lines, not cut.
      for (const part of ["source", "finding-title:0", "finding-place:0", "finding-title:1", "finding-place:3", "note-evidence:4", "note-title:5"]) {
        expect({ part, wraps: now.frames[part].h > line * 1.5 }).toEqual({ part, wraps: true });
      }
    }
    // The whole values are drawn, nothing cut or inserted.
    for (const value of [GITHUB_URL, URL_TITLE, `${LONG_FILE}:1234`, UNBROKEN_TITLE, `${LONG_FILE}:42`, EVIDENCE]) {
      expect(app.texts().includes(value)).toBe(true);
    }
    // The source is one link, to the whole URL.
    expect(app.count(`role:link`)).toBe(1);
    await app.press(`role:link`);
    expect(app.openedUrls()).toEqual([GITHUB_URL]);
  });

  test(`on ${name}, coverage gaps, the commit and a failed review stay inside the card`, async () => {
    const app = await openCase(width, platform, "incomplete", LONG_PARTS.incomplete);
    const now = report(app);
    expectInsideCard(now);
    const line = now.frames["gap-path:big.bin"].h;
    // A short gap keeps its path and status on one line.
    expectOneLine(now, ["gap-path:big.bin", "gap-status:big.bin"], line);
    if (phone) {
      for (const part of [`gap-path:${GAP_PATH}`, `gap-note:${GAP_PATH}`, "source"]) {
        expect({ part, wraps: now.frames[part].h > line * 1.5 }).toEqual({ part, wraps: true });
      }
    }
    for (const value of [ARCHIVE_URL, "@fedcba987654", GAP_PATH, GAP_NOTE]) {
      expect(app.texts().includes(value)).toBe(true);
    }
    await app.press(`role:link`);
    expect(app.openedUrls()).toEqual([ARCHIVE_URL]);
  });
}

test("on a phone, short values keep one line each, and the source link fits on one line", async () => {
  const app = await openCase(360, undefined, "short", ["source", "finding:0", "finding-title:0", "finding-place:0", "note:1", "note-title:1", "note-place:1", "note-evidence:1"]);
  const now = report(app);
  expectInsideCard(now);
  const line = now.frames["finding-severity:0"].h;
  expectOneLine(now, ["finding-severity:0", "finding-title:0", "finding-place:0"], line);
  expectOneLine(now, ["note-title:1", "note-place:1", "note-evidence:1"], line);
  expect(now.frames.source.h <= line + 0.5).toBe(true);
});

test("on a phone, folds still open and close, and an empty review and an expired preview stay inside", async () => {
  const app = await openCase(360, undefined, "complete", LONG_PARTS.complete);
  await app.press("role:button[Notes (2)]");
  expect(app.texts().includes(EVIDENCE)).toBe(true); // still in the critical finding's evidence box
  expect(app.shows("text:Long evidence note")).toBe(false);
  await app.press("role:button[Notes (2)]");
  await app.waitFor("text:Long evidence note");

  await app.press("id:case-empty");
  await settle(app, "empty", []);
  await app.waitFor("text:No issues detected within the reviewed scope.");
  expectInsideCard(report(app));

  await app.press("id:case-expired");
  await app.waitFor("text:/preview has expired/");
  await settle(app, "expired", ["error:PhInfo"]);
  expectInsideCard(report(app));
});
