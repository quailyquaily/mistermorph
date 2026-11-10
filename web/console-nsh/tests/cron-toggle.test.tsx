// The topic head's TODO runs toggle while TODO runs are running (pages/chat/TopicSidebar.tsx): the
// border beam rides the toggle's own 38pt square in place of a ring off its icon, in all four
// running and selected states, without moving or resizing it, and the toggle stays a working toggle
// (one press, one switch) while it runs, and is plain again once the runs end.
import { expect, open, test } from "nsh/test";

async function openToggle(options: { platform?: "linux" | "android"; reducedMotion?: boolean } = {}) {
  return open("./fixtures/cron-toggle-app.tsx", { width: 390, height: 400, platform: options.platform ?? "linux", locale: "en-US", reducedMotion: options.reducedMotion });
}

const read = (app: { texts(): string[] }, name: string) => app.texts().find((text) => text.startsWith(`${name}=`));

for (const platform of ["linux", "android"] as const) {
  test(`${platform}: the beam shows only while running, and the toggle keeps its 38pt square and place`, async () => {
    const app = await openToggle({ platform });
    expect(app.count("id:chat-cron-running")).toBe(0);
    const idle = read(app, "frame");
    const center = read(app, "center");
    expect(idle).toMatch(/,38x38$/);

    // running; running + selected; selected; idle again.
    for (const flip of ["flip-running", "flip-active", "flip-running", "flip-active"]) {
      await app.press(`id:${flip}`);
      expect(read(app, "frame")).toBe(idle);
      expect(read(app, "center")).toBe(center);
      expect(app.enabled("id:toggle")).toBe(true);
    }
    // Back to idle and unselected after the four flips: no beam left behind.
    expect(app.count("id:chat-cron-running")).toBe(0);
  });
}

test("each running and selected combination: the beam follows running alone", async () => {
  const app = await openToggle();
  // idle, unselected
  expect(app.count("id:chat-cron-running")).toBe(0);
  // running, unselected
  await app.press("id:flip-running");
  expect(app.shows("id:chat-cron-running")).toBe(true);
  expect(app.shows("label:TODO runs — 2 running")).toBe(true);
  // running, selected
  await app.press("id:flip-active");
  expect(app.shows("id:chat-cron-running")).toBe(true);
  // idle, selected
  await app.press("id:flip-running");
  expect(app.count("id:chat-cron-running")).toBe(0);
  expect(app.shows("label:TODO runs")).toBe(true);
});

test("while running, the toggle is not busy: every press switches once and none is blocked", async () => {
  const app = await openToggle();
  await app.press("id:flip-running");
  expect(app.enabled("id:toggle")).toBe(true);
  await app.press("id:toggle");
  expect(read(app, "presses")).toBe("presses=1");
  await app.press("id:toggle");
  expect(read(app, "presses")).toBe("presses=2");
  expect(app.shows("id:chat-cron-running")).toBe(true);
  // The runs end: the beam goes and the toggle is as it was.
  await app.press("id:flip-running");
  expect(app.count("id:chat-cron-running")).toBe(0);
  await app.press("id:toggle");
  expect(read(app, "presses")).toBe("presses=3");
});

test("with reduced motion the beam still marks the run", async () => {
  const app = await openToggle({ reducedMotion: true });
  await app.press("id:flip-running");
  expect(app.shows("id:chat-cron-running")).toBe(true);
  await app.press("id:flip-running");
  expect(app.count("id:chat-cron-running")).toBe(0);
});
