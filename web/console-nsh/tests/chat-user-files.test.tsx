// A sent message's bubble with files is one frame (userBubble.ts) around its text and its file rows,
// as a text-only bubble is, so its edge and its corners (14pt round, 2pt at the top right) stay
// whole: it used to be a rounded top box with a second box hung beneath it for the files, and the
// rows' square hover/pressed fill reached the edge, covering the round bottom corners. Now the rows
// sit inset in the frame, a message of files alone has no blank text block, long names stay inside,
// and the rows still preview their file and copy still copies, on a desktop and on a phone.
// FT110: each file is a pill (filePill.ts), round at both ends as the one-row composer, 4pt apart,
// and its name alone says its type (no type label at its right). Its ends (half its height) are
// rounder than the 10pt concentric with the bubble's corners, so it stays inside the curve.
// The fixture: tests/fixtures/chat-user-files-app.tsx.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { BUBBLE_CLASS, FILES_CLASS } from "../components/chat/userBubble";
import { draftFilePillClass, FILE_PILL_SHAPE, SENT_FILE_PILL_CLASS } from "../components/chat/filePill";
import { COMPOSER_RADIUS } from "../components/chat/composerField";

type Frame = { x: number; y: number; w: number; h: number };

const WIDTHS = [
  { name: "a desktop", width: 1280, platform: "linux" as const },
  { name: "a phone", width: 390, platform: "android" as const },
];

const prefixed = (app: App, prefix: string) => (app.texts().find((text) => text.startsWith(prefix)) ?? prefix).slice(prefix.length);
const frames = (app: App) => JSON.parse(prefixed(app, "frames:") || "{}") as Record<string, Frame>;
const log = (app: App) => prefixed(app, "log:");

async function openBubbles(width: number, platform: "linux" | "android") {
  const app = await open("./fixtures/chat-user-files-app.tsx", { width, height: 1600, platform, locale: "en-US" });
  await waitParts(app, ["text:bubble", "text:text", "text-file:files", "text-file:file-0", "file-only:file-0", "multi:file-3"]);
  return app;
}

async function waitParts(app: App, names: string[]) {
  await app.waitUntil(() => names.every((name) => Boolean(frames(app)[name])));
  // Let a second layout pass (fonts) report too.
  await app.wait(100);
}

const right = (frame: Frame) => frame.x + frame.w;
const bottom = (frame: Frame) => frame.y + frame.h;

/** `inner` lies inside `outer`, at least `sides` in from its left and right and `ends` from its top and bottom. */
function expectInside(inner: Frame, outer: Frame, what: string, sides: number, ends: number) {
  const where = `${what}: ${JSON.stringify(inner)} in ${JSON.stringify(outer)}`;
  const ok =
    inner.x >= outer.x + sides - 0.5 &&
    right(inner) <= right(outer) - sides + 0.5 &&
    inner.y >= outer.y + ends - 0.5 &&
    bottom(inner) <= bottom(outer) - ends + 0.5;
  expect({ where, ok }).toEqual({ where, ok: true });
}

const near = (a: number, b: number, within = 0.5) => Math.abs(a - b) <= within;

/** The file rows of a region, in order. */
const rows = (all: Record<string, Frame>, region: string) =>
  Object.keys(all)
    .filter((key) => key.startsWith(`${region}:file-`))
    .sort((a, b) => Number(a.split("-").pop()) - Number(b.split("-").pop()))
    .map((key) => all[key]);

test("the bubble is one frame with the text-only shape; its file pills are round at both ends", () => {
  // One frame: 14pt corners with the 2pt top right, a whole border, never a cut bottom edge.
  expect(BUBBLE_CLASS).toContain("rounded-[14px] rounded-tr-[2px] border ");
  expect(/rounded-b-none|border-b-0|border-t-0/.test(BUBBLE_CLASS)).toBe(false);
  // The pills' block is inset 4pt at the sides, 3pt at the ends (+ the 1pt border: 14 - 4 = 10), 4pt between pills.
  expect(FILES_CLASS).toBe("gap-1 px-1 py-[3px]");
  // Sent and draft pills share the composer's full curvature (half their height, as COMPOSER_RADIUS
  // is half the one-row composer's), never the 2pt ui-kit corners.
  expect(COMPOSER_RADIUS).toBe(27);
  expect(FILE_PILL_SHAPE).toBe("rounded-full");
  for (const pill of [SENT_FILE_PILL_CLASS, draftFilePillClass(false), draftFilePillClass(true)]) {
    expect(pill).toContain(` ${FILE_PILL_SHAPE} `);
    expect(/rounded-\(--radius\)|rounded-\[2px\]|rounded-(t|b|l|r|tl|tr|bl|br)-/.test(pill)).toBe(false);
  }
});

for (const item of WIDTHS) {
  test(`on ${item.name} text and files share one bubble, the rows inset inside its edge`, async () => {
    const app = await openBubbles(item.width, item.platform);
    for (const region of ["text", "text-file", "file-only", "multi"]) {
      expect({ region, bubbles: app.count(`id:v-${region} >> id:chat-user-bubble`) }).toEqual({ region, bubbles: 1 });
    }
    const all = frames(app);
    const bubble = all["text-file:bubble"];
    const text = all["text-file:text"];
    const files = all["text-file:files"];
    // The text block and the files block are both inside the one frame, the files right under the text.
    expectInside(text, bubble, "text", 1, 0);
    expectInside(files, bubble, "files", 1, 1);
    expect(near(text.y, bubble.y + 1)).toBe(true);
    expect(near(files.y, bottom(text))).toBe(true);
    expect(near(bottom(files), bottom(bubble) - 1)).toBe(true);
    // The row stays 4pt in from the bubble's sides and its bottom (1pt border + the block's padding),
    // and its round ends (half its height) are rounder than the 10pt concentric with the bubble's
    // corners there: its border and fill stay inside the curve.
    const [row] = rows(all, "text-file");
    expectInside(row, bubble, "row", 5, 4);
    expect(row.h / 2).toBeGreaterThanOrEqual(10);
    // A text-only bubble is just its text block in the same frame.
    expect(near(all["text:bubble"].h, all["text:text"].h + 2)).toBe(true);
    expect(app.count("id:v-text >> id:chat-user-files")).toBe(0);
  });

  test(`on ${item.name} a message of files alone has no blank text block`, async () => {
    const app = await openBubbles(item.width, item.platform);
    expect(app.count("id:v-file-only >> id:chat-message-text")).toBe(0);
    expect(app.count("id:v-file-only >> id:chat-user-file")).toBe(1);
    const all = frames(app);
    const bubble = all["file-only:bubble"];
    const [row] = rows(all, "file-only");
    expect(all["file-only:text"]).toBe(undefined);
    expectInside(row, bubble, "row", 5, 4);
    // Just the row, its padding and the border: 1 + 3 + row + 3 + 1.
    expect(near(bubble.h, row.h + 8)).toBe(true);
  });

  test(`on ${item.name} several files with long names stay inside the bubble and the window`, async () => {
    const app = await openBubbles(item.width, item.platform);
    const all = frames(app);
    const bubble = all["multi:bubble"];
    const list = rows(all, "multi");
    expect(list.length).toBe(4);
    expect(bubble.w).toBeLessThanOrEqual(557.5);
    expect(right(bubble)).toBeLessThanOrEqual(item.width);
    for (const [index, row] of list.entries()) {
      expectInside(row, bubble, `row ${index}`, 5, 1);
      expect(near(row.w, list[0].w)).toBe(true);
      if (index > 0) expect(near(row.y, bottom(list[index - 1]) + 4)).toBe(true);
    }
    expect(bottom(list[3])).toBeLessThanOrEqual(bottom(bubble) - 4 + 0.5);
    // Names still show (the long ones ellipsized on one line), with their extensions; the type
    // labels that repeated them at the pills' right are gone.
    const texts = app.texts();
    for (const name of ["notes.md", "README"]) expect(texts.includes(name)).toBe(true);
    for (const kind of ["MD", "PNG", "PDF"]) expect({ kind, shown: texts.includes(kind) }).toEqual({ kind, shown: false });
  });

  test(`on ${item.name} each file row previews its file and copy still copies`, async () => {
    const app = await openBubbles(item.width, item.platform);
    await app.press("id:v-text-file >> id:chat-user-file");
    await app.press("id:v-file-only >> id:chat-user-file");
    await app.press("id:v-multi >> id:chat-user-file >> nth=2");
    await app.press("id:v-multi >> id:chat-user-file >> nth=3");
    await app.press("id:v-text-file >> id:chat-copy");
    expect(log(app)).toBe(
      [
        "preview:f1:screenshot.png:f1",
        "preview:f2:diagram.png:f2",
        `preview:f5:${"Screenshot_20261113_104217_0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop.pdf"}:f3,f4,f5,f6`,
        "preview:f6:README:f3,f4,f5,f6",
        "copy:m1",
      ].join("|"),
    );
    // Files alone: nothing to copy, as before.
    expect(app.count("id:v-file-only >> id:chat-copy")).toBe(0);
    expect(app.count("id:v-text-file >> id:chat-copy")).toBe(1);
  });
}

test("a recycled row follows the message it shows: text block and file rows come and go", async () => {
  const app = await openBubbles(390, "android");
  await waitParts(app, ["recycled:text"]);
  expect(app.count("id:v-recycled >> id:chat-message-text")).toBe(1);
  expect(app.count("id:v-recycled >> id:chat-user-file")).toBe(0);
  await app.press("id:recycle");
  await waitParts(app, ["recycled:bubble", "recycled:file-0"]);
  expect(app.count("id:v-recycled >> id:chat-message-text")).toBe(0);
  expect(app.count("id:v-recycled >> id:chat-user-file")).toBe(1);
  expect(app.count("id:v-recycled >> id:chat-user-bubble")).toBe(1);
  await app.press("id:recycle");
  await waitParts(app, ["recycled:text", "recycled:file-3"]);
  expect(app.count("id:v-recycled >> id:chat-message-text")).toBe(1);
  expect(app.count("id:v-recycled >> id:chat-user-file")).toBe(4);
  await app.press("id:recycle");
  await waitParts(app, ["recycled:text"]);
  expect(app.count("id:v-recycled >> id:chat-user-file")).toBe(0);
  expect(app.count("id:v-recycled >> id:chat-message-text")).toBe(1);
});

test("a system message keeps its dashed box with no sent bubble", async () => {
  const app = await openBubbles(1280, "linux");
  expect(app.count("id:v-system >> id:chat-user-bubble")).toBe(0);
  expect(app.count("id:v-system >> id:chat-message-text")).toBe(1);
  expect(app.texts().includes("A system message stays a dashed box.")).toBe(true);
});
