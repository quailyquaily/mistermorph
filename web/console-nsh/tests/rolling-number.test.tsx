// A RollingNumber's wheels: at rest each is just its digit (a page shows dozens of these numbers,
// and a strip of every digit under each wheel made thousands of views); a wheel that changes
// holds a strip of the digits it passes only while it turns, the short way round, and is its new
// digit again once it stops.
import { expect, open, test } from "nsh/test";

const digits = (texts: string[]) => texts.filter((text) => /^\d$/.test(text));

test("a wheel holds a strip only while it turns", async () => {
  const app = await open("./fixtures/rolling-number-app.tsx", { width: 400, height: 300, platform: "linux", locale: "en-US", clock: {} });
  await app.waitFor("Next");
  await app.clock!.runFor(100);
  // At rest: the four digits, one view each.
  expect(digits(app.texts())).toEqual(["1", "2", "3", "9"]);
  expect(await app.shows("id:number")).toBe(true);

  await app.press("id:next");
  await app.clock!.runFor(100);
  // Turning: 2 -> 3 one step on, 3 -> 0 three back, 9 -> 2 three on (through 0 and 1); the 1 stays.
  const turning = digits(app.texts());
  expect(turning.length).toBeGreaterThan(4);
  expect(turning.length).toBeLessThanOrEqual(4 + 2 + 4 + 4);

  await app.clock!.runFor(600);
  expect(digits(app.texts())).toEqual(["1", "3", "0", "2"]);
  expect(app.texts()).toContain("1,302");
});
