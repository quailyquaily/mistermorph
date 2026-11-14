// The mic and Send take turns at the composer's end like a revolver's cylinder (VoiceOrSend in
// components/chat/ChatComposer.tsx): typing turns Send in from the left as the mic leaves to the
// right, clearing the field turns them back; the drum shows only while it turns, then each button
// draws its own glyph again. To and from Stop, and with reduced motion, nothing turns. The fixture
// (tests/fixtures/voice-control-app.tsx) mounts the real ChatComposer.
import { expect, open, test } from "nsh/test";
import { DRUM_RADIUS, DRUM_STEP, drumOffsets } from "../components/chat/ChatComposer";

const DRUM = "id:chat-composer-drum";
// DRUM_INPUT's samples: turn 0 and turn 1 are the third and the seventh.
const AT_0 = 2;
const AT_1 = 6;

test("the chambers sit on an arc round an axis below the button, the top one centred", () => {
  const mic = { x: drumOffsets(0, "x"), y: drumOffsets(0, "y") };
  const send = { x: drumOffsets(-1, "x"), y: drumOffsets(-1, "y") };
  // At rest the chamber on top is in the button's middle: the mic before a draft, Send after.
  expect([mic.x[AT_0], mic.y[AT_0]]).toEqual([0, 0]);
  expect([send.x[AT_1], send.y[AT_1]]).toEqual([0, 0]);
  // One step away a chamber is out to the side and lower: the mic leaves right, Send waits left.
  const side = DRUM_RADIUS * Math.sin((DRUM_STEP * Math.PI) / 180);
  const drop = DRUM_RADIUS * (1 - Math.cos((DRUM_STEP * Math.PI) / 180));
  expect(Math.abs(mic.x[AT_1] - (side))).toBeLessThan(0.01);
  expect(Math.abs(send.x[AT_0] - (-side))).toBeLessThan(0.01);
  expect(Math.abs(mic.y[AT_1] - (drop))).toBeLessThan(0.01);
  expect(Math.abs(send.y[AT_0] - (drop))).toBeLessThan(0.01);
  // Out of the 38pt circle (its radius 19, a 14pt glyph): clipped away when not on top.
  expect(side - 7).toBeGreaterThan(9);
  // The samples past the ends follow the arc, so the overshoot swings on it too.
  expect(mic.x[AT_1 + 1]).toBeGreaterThan(mic.x[AT_1]);
  expect(send.x[AT_0 - 1]).toBeLessThan(send.x[AT_0]);
});

// Headless, a native animation ends almost at once, and the step that started a turn returns once
// it ended: whether the drum's end (its turn's promise) came before the step returned was a race.
// The fixture holds each turn's end until release-turns (hold-turns), so the drum is counted while
// it turns, and the turn's target read, before it is let go and waited out. (The drum, hidden from
// screen readers, is not "shown" to waitFor.)
const turns = (app: { texts(): string[] }) =>
  JSON.parse((app.texts().find((text) => text.startsWith("turns:")) ?? "turns:null").slice("turns:".length)) as number[];

for (const platform of ["linux", "android"] as const) {
  test(`${platform}: typing turns the drum to Send, clearing turns it back, and it rests as the buttons`, async () => {
    const app = await open("./fixtures/voice-control-app.tsx", { width: 760, height: 600, locale: "en-US", platform });
    await app.waitFor("id:chat-composer-voice");
    await app.press("id:hold-turns");
    expect(app.count(DRUM)).toBe(0);

    await app.type("id:chat-composer-input", "h");
    // Turning to Send's chamber (1), the drum carries both glyphs.
    expect(turns(app)).toEqual([1]);
    expect(app.count(DRUM)).toBe(1);
    await app.press("id:release-turns");
    // Settled: the drum is gone and Send draws its own plane.
    await app.waitUntil(() => app.count(DRUM) === 0);
    expect(app.enabled("id:chat-composer-send")).toBe(true);

    // More typing turns nothing: Send is already on top.
    await app.type("id:chat-composer-input", "i");
    expect(turns(app)).toEqual([1]);
    expect(app.count(DRUM)).toBe(0);

    await app.clear("id:chat-composer-input");
    // Back to the mic's chamber (0).
    expect(turns(app)).toEqual([1, 0]);
    expect(app.count(DRUM)).toBe(1);
    await app.press("id:release-turns");
    await app.waitUntil(() => app.count(DRUM) === 0);
    expect(app.count("id:chat-composer-voice-icon.PhMicrophone.primary.primary-foreground")).toBe(1);
  });
}

test("a turn reversed before it settles ends on the mic, and the drum goes", async () => {
  const app = await open("./fixtures/voice-control-app.tsx", { width: 760, height: 600, locale: "en-US", platform: "linux" });
  await app.waitFor("id:chat-composer-voice");
  await app.type("id:chat-composer-input", "h");
  await app.clear("id:chat-composer-input");
  await app.waitUntil(() => app.count(DRUM) === 0);
  await app.wait(300);
  expect(app.count(DRUM)).toBe(0);
  expect(app.count("id:chat-composer-voice-icon.PhMicrophone.primary.primary-foreground")).toBe(1);
});

test("to and from Stop nothing turns", async () => {
  const app = await open("./fixtures/voice-control-app.tsx", { width: 760, height: 600, locale: "en-US", platform: "linux" });
  await app.waitFor("id:chat-composer-voice");
  await app.press("id:toggle-stop");
  expect(app.count(DRUM)).toBe(0);
  await app.waitFor("id:chat-composer-send");
  await app.press("id:toggle-stop");
  expect(app.count(DRUM)).toBe(0);
});

test("with reduced motion nothing turns", async () => {
  const app = await open("./fixtures/voice-control-app.tsx", { width: 760, height: 600, locale: "en-US", platform: "linux", reducedMotion: true });
  await app.waitFor("id:chat-composer-voice");
  await app.type("id:chat-composer-input", "h");
  await app.waitFor("id:chat-composer-send");
  expect(app.count(DRUM)).toBe(0);
  await app.clear("id:chat-composer-input");
  expect(app.count(DRUM)).toBe(0);
});
