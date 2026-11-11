// The conversation keeps the reader's place while a task runs (FT63). nsh's List tells items apart
// by identity, and the chat gives a message a new object on every update: before the fix, a
// streamed word replaced the running reply (and a finished task's reload replaced every message),
// the List dropped their measured heights for its estimate, and a reader scrolled up was thrown
// somewhere else. Each test reads where the rows on screen are (fixtures/chat-scroll-anchor-app.tsx)
// before and after updates staged the way the controller makes them.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

type Frame = { y: number; h: number };
type Report = { seq: number; list: Frame; rows: Record<string, Frame> };

const SCREENS = [
  { name: "desktop", options: { width: 1000, height: 800, platform: "linux" as const } },
  { name: "phone", options: { width: 390, height: 844, platform: "android" as const } },
];

async function openList(options: (typeof SCREENS)[number]["options"]) {
  const app = await open("./fixtures/chat-scroll-anchor-app.tsx", { ...options, locale: "en-US" });
  await app.waitUntil(() => app.shows("id:chat-history"));
  await app.wait(200);
  return app;
}

// Headless, the screen applies the list's own scroll corrections (`ScrollBy`) without reporting
// the new offset back, so positions (and `onScroll`) lag until the next scroll. A nudge of a point
// and back reports it: what the reader would see after the update.
async function snap(app: App): Promise<Report> {
  await app.scroll("id:chat-history", -1);
  await app.scroll("id:chat-history", 1);
  const current = () => app.texts().find((text) => text.startsWith('{"seq"')) ?? "";
  const before = current();
  await app.press("id:do-probe");
  await app.waitUntil(() => current() !== before);
  return JSON.parse(current()) as Report;
}

async function act(app: App, name: string) {
  await app.press(`id:do-${name}`);
  await app.wait(200);
}

/** Every row on screen before is on screen after, where it was (its top within a point). */
function expectInPlace(before: Report, after: Report) {
  const ids = Object.keys(before.rows);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    expect(after.rows[id]).toBeDefined();
    expect(Math.abs(after.rows[id].y - before.rows[id].y)).toBeLessThanOrEqual(1);
  }
}

/** The newest message ends 20pt (HISTORY_END_PADDING) above the list's bottom edge. */
function expectAtBottom(report: Report, newest: string) {
  const row = report.rows[newest];
  expect(row).toBeDefined();
  expect(Math.abs(row.y + row.h - (report.list.y + report.list.h - 20))).toBeLessThanOrEqual(1);
}

for (const screen of SCREENS) {
  test(`${screen.name}: scrolled up inside the running reply, streamed words keep what is on screen in place`, async () => {
    const app = await openList(screen.options);
    await app.scroll("id:chat-history", -400);
    const before = await snap(app);
    // The running reply itself is on screen, its end below the viewport.
    expect(before.rows["a-a8"]).toBeDefined();
    for (let i = 0; i < 3; i += 1) await act(app, "stream");
    const after = await snap(app);
    expectInPlace(before, after);
    // It grew below the viewport.
    expect(after.rows["a-a8"].h).toBeGreaterThan(before.rows["a-a8"].h);
  });

  test(`${screen.name}: scrolled up above the running reply, tool steps, words and the finish keep the place`, async () => {
    const app = await openList(screen.options);
    await app.scroll("id:chat-history", -1800);
    const before = await snap(app);
    expect(before.rows["a-a8"]).toBeUndefined();
    await act(app, "status");
    await act(app, "stream");
    expectInPlace(before, await snap(app));
    // The task finishes: its status, then the reload that gives every message a new object.
    await act(app, "complete");
    expectInPlace(before, await snap(app));
  });

  test(`${screen.name}: at the bottom, the newest words stay in view as they arrive and as the task finishes`, async () => {
    const app = await openList(screen.options);
    expectAtBottom(await snap(app), "a-a8");
    await act(app, "stream");
    await act(app, "status");
    await act(app, "stream");
    expectAtBottom(await snap(app), "a-a8");
    await act(app, "complete");
    expectAtBottom(await snap(app), "a-a8");
  });

  test(`${screen.name}: another topic opens at its newest message`, async () => {
    const app = await openList(screen.options);
    await app.scroll("id:chat-history", -900);
    await app.press("id:do-topic");
    await app.waitUntil(() => app.shows("text:b question 6"));
    await app.wait(300);
    expectAtBottom(await snap(app), "b-a6");
  });
}

test("a reload that gives every message a new object keeps the place", async () => {
  const app = await openList(SCREENS[0].options);
  await app.scroll("id:chat-history", -900);
  const before = await snap(app);
  await act(app, "refresh");
  expectInPlace(before, await snap(app));
});

test("scrolled back down to the newest message, the list follows the reply again", async () => {
  const app = await openList(SCREENS[0].options);
  await app.scroll("id:chat-history", -600);
  await act(app, "stream");
  const away = await snap(app);
  // Still where the reader left it: the reply's end is below the viewport.
  expect(away.rows["a-a8"].y + away.rows["a-a8"].h).toBeGreaterThan(away.list.y + away.list.h);
  // Back to the bottom (what the reply grew by included), then more words.
  await app.scroll("id:chat-history", away.rows["a-a8"].y + away.rows["a-a8"].h - (away.list.y + away.list.h - 20));
  expectAtBottom(await snap(app), "a-a8");
  await act(app, "stream");
  await act(app, "stream");
  expectAtBottom(await snap(app), "a-a8");
});

test("a message sent while scrolled up goes to the newest message", async () => {
  const app = await openList(SCREENS[0].options);
  await app.scroll("id:chat-history", -1200);
  await act(app, "send");
  await app.wait(200);
  expectAtBottom(await snap(app), "a-pending16");
});

test("an earlier message growing above the viewport keeps the place", async () => {
  const app = await openList(SCREENS[0].options);
  await app.scroll("id:chat-history", -900);
  const before = await snap(app);
  expect(before.rows["a-a2"]).toBeUndefined();
  await act(app, "expand");
  expectInPlace(before, await snap(app));
});

test("an older page taller than the way back to the bottom keeps the place", async () => {
  // Scrolled up a little: the page arriving above is taller than the distance to the newest
  // message, which nsh's end following mistook for being at the end.
  const app = await openList(SCREENS[0].options);
  await app.scroll("id:chat-history", -120);
  const before = await snap(app);
  await act(app, "older");
  expectInPlace(before, await snap(app));
});

test("older messages arriving above keep the place", async () => {
  const app = await openList(SCREENS[0].options);
  await app.scroll("id:chat-history", -900);
  const before = await snap(app);
  await act(app, "older");
  expectInPlace(before, await snap(app));
  await act(app, "stream");
  expectInPlace(before, await snap(app));
});
