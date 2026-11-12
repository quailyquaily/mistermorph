// A running task's progress or output follows its end as it grows; only the reader scrolling up
// lets go of it, and coming back to the end follows again (components/chat/PinnedScroll.tsx).
import { expect, open, test, type App } from "nsh/test";

type State = { offset: number; view: number; content: number; pinned: boolean };

function state(app: App): State {
  return JSON.parse(app.texts().find((text) => text.startsWith('{"offset"')) ?? "{}") as State;
}

const atEnd = (s: State) => s.content > 0 && s.offset + s.view >= s.content - 2;

let lines = 20;
/** Ten more lines, as a running task's progress grows. */
async function grow(app: App) {
  lines += 10;
  await app.press("id:grow");
  await app.waitUntil(() => app.texts().includes(`line ${lines}`));
  await app.wait(80);
}

test("it follows the end as lines arrive, lets go when the reader scrolls up, and follows again at the end", async () => {
  lines = 20;
  const app = await open("./fixtures/pinned-scroll-app.tsx", { width: 400, height: 500, platform: "linux", locale: "en-US" });
  await grow(app);
  await app.waitUntil(() => atEnd(state(app)));
  for (let i = 0; i < 3; i += 1) {
    await grow(app);
    await app.waitUntil(() => atEnd(state(app)));
    expect(state(app).pinned).toBe(true);
  }

  // The reader scrolls up: it stays where they put it as more arrives.
  await app.scroll("id:pinned", -120);
  await app.waitUntil(() => !atEnd(state(app)));
  expect(state(app).pinned).toBe(false);
  const held = state(app).offset;
  await grow(app);
  await app.wait(120);
  expect(Math.abs(state(app).offset - held)).toBeLessThan(1);
  expect(atEnd(state(app))).toBe(false);

  // Back at the end, it follows again.
  await app.scroll("id:pinned", 10000);
  await app.waitUntil(() => atEnd(state(app)) && state(app).pinned);
  await grow(app);
  await app.waitUntil(() => atEnd(state(app)));
});

test("scrolling up while lines are arriving still lets go of the end", async () => {
  lines = 20;
  const app = await open("./fixtures/pinned-scroll-app.tsx", { width: 400, height: 500, platform: "linux", locale: "en-US" });
  await grow(app);
  await app.waitUntil(() => atEnd(state(app)));
  // Lines arrive in the same moment as the reader's scroll up.
  lines += 10;
  await app.press("id:grow");
  await app.scroll("id:pinned", -150);
  await app.waitUntil(() => app.texts().includes(`line ${lines}`));
  await app.wait(120);
  expect(state(app).pinned).toBe(false);
  const held = state(app).offset;
  await grow(app);
  await app.wait(120);
  expect(Math.abs(state(app).offset - held)).toBeLessThan(1);
});
