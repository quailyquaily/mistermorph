// A sent message's bubble with files is one frame (userBubble.ts) around its text and its file rows,
// as a text-only bubble is, so its edge and its corners (14pt round, 2pt at the top right) stay
// whole: it used to be a rounded top box with a second box hung beneath it for the files, and the
// rows' square hover/pressed fill reached the edge, covering the round bottom corners. Now the rows
// sit inset in the frame and round the corners they share with it (concentric), a message of files
// alone has no blank text block, long names stay inside, and the rows still preview their file and
// copy still copies, on a desktop and on a phone. The fixture: tests/fixtures/chat-user-files-app.tsx.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { BUBBLE_CLASS, FILES_CLASS, fileRowCornerClass } from "../components/chat/userBubble";

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

test("the bubble is one frame with the text-only shape; file rows round only the corners they share", () => {
  // One frame: 14pt corners with the 2pt top right, a whole border, never a cut bottom edge.
  expect(BUBBLE_CLASS).toContain("rounded-[14px] rounded-tr-[2px] border ");
  expect(/rounded-b-none|border-b-0|border-t-0/.test(BUBBLE_CLASS)).toBe(false);
  // The rows' block is inset 4pt at the sides, 3pt at the ends (+ the 1pt border: 14 - 4 = 10).
  expect(FILES_CLASS).toBe("px-1 py-[3px]");
  // Under text: only the last row rounds, its bottom corners.
  expect(fileRowCornerClass(0, 1, true)).toBe("rounded-(--radius) rounded-b-[10px]");
  expect(fileRowCornerClass(0, 3, true)).toBe("rounded-(--radius)");
  expect(fileRowCornerClass(1, 3, true)).toBe("rounded-(--radius)");
  expect(fileRowCornerClass(2, 3, true)).toBe("rounded-(--radius) rounded-b-[10px]");
  // Files alone: the first row also takes the top left (the top right is the 2pt tail).
  expect(fileRowCornerClass(0, 1, false)).toBe("rounded-(--radius) rounded-tl-[10px] rounded-b-[10px]");
  expect(fileRowCornerClass(0, 2, false)).toBe("rounded-(--radius) rounded-tl-[10px]");
  expect(fileRowCornerClass(1, 2, false)).toBe("rounded-(--radius) rounded-b-[10px]");
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
    // The row stays 4pt in from the bubble's sides and its bottom (1pt border + the block's padding).
    const [row] = rows(all, "text-file");
    expectInside(row, bubble, "row", 5, 4);
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
      if (index > 0) expect(near(row.y, bottom(list[index - 1]))).toBe(true);
    }
    expect(bottom(list[3])).toBeLessThanOrEqual(bottom(bubble) - 4 + 0.5);
    // Names and kinds still show (the long ones ellipsized on one line).
    const texts = app.texts();
    for (const name of ["notes.md", "README"]) expect(texts.includes(name)).toBe(true);
    for (const kind of ["MD", "PNG", "PDF"]) expect(texts.includes(kind)).toBe(true);
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
