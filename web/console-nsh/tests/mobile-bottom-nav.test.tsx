// The phone's bottom navigation: its five slots (Chat, Contacts, TODO, More, the agent) sit side by
// side, none reaching under another, each wide enough to press, on the narrowest phones, in
// landscape and with larger text; the active pill covers its own slot and no other; and More and
// the agent still open their sheets.
import { expect, open, test } from "nsh/test";
import { mobileNavSlots, NAV_SLOT_MAX } from "../components/frame/mobileBar";

type Frame = { x: number; y: number; w: number; h: number };

const SLOTS = ["mobile-nav-chat", "mobile-nav-contacts", "mobile-nav-todo", "mobile-nav-more", "mobile-nav-agent"];
/** The smallest press target the platforms ask for. */
const MIN_TARGET = 44;

async function openNav(width: number, height: number, extra: Record<string, unknown> = {}) {
  const app = await open("./fixtures/mobile-bottom-nav-app.tsx", { width, height, platform: "android", locale: "en-US", ...extra });
  const frames = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as Record<string, Frame>;
  await app.waitFor("id:mobile-bottom-nav");
  await app.waitUntil(() => SLOTS.every((slot) => frames()[slot]));
  return { app, frames };
}

/** The slots' frames side by side: each its own stretch of the row, as wide as a press needs. */
function expectSeparateSlots(frames: Record<string, Frame>, width: number) {
  const row = SLOTS.map((slot) => frames[slot]);
  for (const frame of row) {
    expect(frame).toBeDefined();
    expect(frame.w).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(frame.w).toBeLessThanOrEqual(NAV_SLOT_MAX);
    expect(frame.h).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  for (let i = 1; i < row.length; i++) {
    // No overlap and no gap: each slot starts where the one before it ends.
    expect(Math.abs(row[i].x - (row[i - 1].x + row[i - 1].w))).toBeLessThan(0.5);
    expect(Math.abs(row[i].w - row[0].w)).toBeLessThan(0.5);
  }
  expect(row[0].x).toBeGreaterThanOrEqual(0);
  // The whole row fits the window, inside the capsule's margins.
  expect(row[0].w * row.length).toBeLessThanOrEqual(width - 2 * 12);
}

/** The active pill lies exactly on slot `name`. */
function expectHighlightOn(frames: Record<string, Frame>, name: string) {
  const pill = frames.highlight;
  const slot = frames[name];
  expect(pill).toBeDefined();
  expect(Math.abs(pill.x - slot.x)).toBeLessThan(0.5);
  expect(Math.abs(pill.w - slot.w)).toBeLessThan(0.5);
}

test("the slots' geometry fits the strip without overlapping", () => {
  // 320 and 360pt phones, a 360pt phone at 125% page zoom or display size (288pt), landscape.
  for (const width of [288, 320, 360, 390, 740, 980]) {
    const { slot, rowWidth, left } = mobileNavSlots(width, 5);
    expect(slot).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(slot).toBeLessThanOrEqual(NAV_SLOT_MAX);
    expect(Number.isInteger(slot)).toBe(true);
    expect(rowWidth).toBe(slot * 5);
    // The row and the capsule's padding (4pt), hairline and side margins (12pt) fit the window.
    expect(rowWidth + 2 * (12 + 4 + 0.5)).toBeLessThanOrEqual(width);
    for (let i = 1; i < 5; i++) expect(left(i) - left(i - 1)).toBe(slot);
  }
  expect(mobileNavSlots(320, 5).slot).toBe(57);
  expect(mobileNavSlots(360, 5).slot).toBe(NAV_SLOT_MAX);
  expect(mobileNavSlots(844, 5).slot).toBe(NAV_SLOT_MAX);
});

for (const [label, width, height] of [
  ["a 320pt phone", 320, 640],
  ["a 360pt phone", 360, 780],
  ["a 360pt phone with larger display size", 288, 624],
  ["a phone in landscape", 780, 360],
] as const) {
  test(`on ${label} the slots sit side by side, and the pill covers only the active one`, async () => {
    const { app, frames } = await openNav(width, height);
    expectSeparateSlots(frames(), width);
    if (width >= 360) expect(frames()["mobile-nav-chat"].w).toBe(NAV_SLOT_MAX);

    // Every destination takes its press: More and the agent open their sheets, and the pill moves
    // onto the slot that is now active.
    await app.press("id:mobile-nav-more");
    await app.waitFor("id:mobile-more");
    await app.waitUntil(() => Boolean(frames().highlight));
    expectHighlightOn(frames(), "mobile-nav-more");

    await app.press("id:mobile-nav-agent");
    await app.waitFor("id:mobile-agents");
    await app.waitFor("id:mobile-more", { state: "gone" });
    await app.waitUntil(() => Math.abs(frames().highlight.x - frames()["mobile-nav-agent"].x) < 0.5);
    expectHighlightOn(frames(), "mobile-nav-agent");
    await app.keyboard.press("escape");
    await app.waitFor("id:mobile-agents", { state: "gone" });
    // (The primary pages' slots navigate: tests/shell.test.tsx presses them in the console at 320pt.)
  });
}

test("rotating the phone refits the slots", async () => {
  const { app, frames } = await openNav(320, 640);
  expect(frames()["mobile-nav-chat"].w).toBe(57);
  await app.setViewport(640, 320);
  await app.waitUntil(() => frames()["mobile-nav-chat"].w === NAV_SLOT_MAX);
  expectSeparateSlots(frames(), 640);
  await app.setViewport(320, 640);
  await app.waitUntil(() => frames()["mobile-nav-chat"].w === 57);
  expectSeparateSlots(frames(), 320);
});
