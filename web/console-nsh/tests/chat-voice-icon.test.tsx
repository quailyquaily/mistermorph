// The voice button's microphone: muted while idle, red while it records (the same button still
// stops the recording, under its Stop label), the busy look while the recording is transcribed, and
// muted again once it ends. Headless nsh has no image query, so the glyph carries a testID that
// names what it draws: `chat-composer-voice-icon.<icon>.<tint token>`. The fixture
// (tests/fixtures/voice-control-app.tsx) mounts the real ChatComposer; chat-voice.test.tsx and
// android-voice.test.tsx walk the same states through the real recording flows.
import { expect, open, test } from "nsh/test";

const IDLE = "id:chat-composer-voice-icon.PhMicrophone.subtle";
const RED = "id:chat-composer-voice-icon.PhMicrophone.danger";
const BUSY = "id:chat-composer-voice-icon.PhMicrophone.plain-disabled-text";
const LOOKS = [IDLE, RED, BUSY];

/** The one glyph the voice button draws now, and no other (and no Stop square). */
function expectLook(app: { count(selector: string): number }, look: string) {
  for (const other of LOOKS) expect(app.count(other)).toBe(other === look ? 1 : 0);
  expect(app.count("id:chat-composer-voice-icon.PhStop.ink")).toBe(0);
}

for (const platform of ["linux", "android"] as const) {
  test(`${platform}: red microphone while recording, the stop action and label kept, muted again after`, async () => {
    const app = await open("./fixtures/voice-control-app.tsx", { width: 760, height: 600, locale: "en-US", platform });
    const presses = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}").presses as number;
    await app.waitFor("id:chat-composer-voice");
    expectLook(app, IDLE);
    expect(app.count("label:Voice input")).toBe(1);
    expect(app.enabled("id:chat-composer-voice")).toBe(true);

    await app.press("id:set-recording");
    expectLook(app, RED);
    // Still the button that ends the recording, named for it.
    expect(app.count("label:Stop and transcribe")).toBe(1);
    expect(app.enabled("label:Stop and transcribe")).toBe(true);
    await app.press("label:Stop and transcribe");
    expect(presses()).toBe(1);

    // Transcribing: the busy plain button, not red, not pressable.
    await app.press("id:set-transcribing");
    expectLook(app, BUSY);
    expect(app.enabled("id:chat-composer-voice")).toBe(false);
    expect(app.count("id:chat-composer-voice-beam")).toBe(1);

    await app.press("id:set-idle");
    expectLook(app, IDLE);
    expect(app.count("label:Voice input")).toBe(1);

    // A disabled composer disables the button in either look and keeps its glyph.
    await app.press("id:toggle-disabled");
    expectLook(app, IDLE);
    expect(app.enabled("id:chat-composer-voice")).toBe(false);
    await app.press("id:set-recording");
    expectLook(app, RED);
    expect(app.enabled("id:chat-composer-voice")).toBe(false);
    await app.press("id:toggle-disabled");
    expect(app.enabled("id:chat-composer-voice")).toBe(true);
    await app.press("id:set-idle");
    expectLook(app, IDLE);
    expect(presses()).toBe(1);
  });
}
