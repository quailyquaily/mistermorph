// The voice button: the primary circle button Send is (ink, a white microphone) while idle, red
// with the microphone still white while it records (the same button still stops the recording,
// under its Stop label), Send's busy primary look while the recording is transcribed, and primary
// again once it ends. Headless nsh has no image or style query, so the glyph carries a testID that
// names what it draws: `chat-composer-voice-icon.<icon>.<look>.<tint token>`; the looks' fills are
// checked on the circle buttons' classes. The fixture (tests/fixtures/voice-control-app.tsx) mounts
// the real ChatComposer; chat-voice.test.tsx and android-voice.test.tsx walk the same states
// through the real recording flows.
import { expect, open, test } from "nsh/test";
import { voiceButtonLook } from "../components/chat/ChatComposer";
import { circleButtonClass } from "../components/ui";

const IDLE = "id:chat-composer-voice-icon.PhMicrophone.primary.primary-foreground";
const RED = "id:chat-composer-voice-icon.PhMicrophone.recording.destructive-foreground";
const BUSY = "id:chat-composer-voice-icon.PhMicrophone.busy.ink";
const LOOKS = [IDLE, RED, BUSY];
// The FT88 looks (a plain button, a muted or red microphone) are gone.
const OLD = ["subtle", "danger", "plain-disabled-text"].map((tint) => `id:chat-composer-voice-icon.PhMicrophone.${tint}`);

/** The one glyph the voice button draws now, and no other (and no Stop square). */
function expectLook(app: { count(selector: string): number }, look: string) {
  for (const other of LOOKS) expect(app.count(other)).toBe(other === look ? 1 : 0);
  for (const old of OLD) expect(app.count(old)).toBe(0);
  expect(app.count("id:chat-composer-voice-icon.PhStop.ink")).toBe(0);
}

test("idle, the voice button is Send's primary circle; recording, a red one; neither hover reads as the other", () => {
  const classes = (value: string) => value.split(/\s+/).filter(Boolean);
  const idle = voiceButtonLook("idle");
  expect(idle).toEqual({ look: "primary", variant: "primary", tint: "primary-foreground", busy: false });
  // No voice state yet is idle.
  expect(voiceButtonLook(undefined)).toEqual(idle);
  // Send's ready look is this primary circle: same box, side and fill.
  const primary = classes(circleButtonClass({ variant: idle.variant }));
  for (const c of ["size-[38px]", "rounded-full", "bg-primary", "border-primary", "hover:bg-ink"]) expect(primary).toContain(c);
  for (const c of primary) expect(/destructive|danger/.test(c)).toBe(false);

  const recording = voiceButtonLook("recording");
  expect(recording).toEqual({ look: "recording", variant: "danger", tint: "destructive-foreground", busy: false });
  const red = classes(circleButtonClass({ variant: recording.variant }));
  // The same circle, red; on hover a lighter red, never the primary ink.
  for (const c of ["size-[38px]", "rounded-full", "bg-destructive", "border-destructive", "hover:bg-danger-light"]) expect(red).toContain(c);
  for (const c of red) expect(/primary|ink|hover:bg-hover/.test(c)).toBe(false);

  const busy = voiceButtonLook("transcribing");
  expect(busy).toEqual({ look: "busy", variant: "plain", tint: "ink", busy: true });
});

for (const platform of ["linux", "android"] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`${platform}, ${colorScheme}: white microphone on red while recording, the stop action and label kept, primary again after`, async () => {
      const app = await open("./fixtures/voice-control-app.tsx", { width: 760, height: 600, locale: "en-US", platform, colorScheme });
      const report = () => JSON.parse(app.texts().find((text) => text.startsWith("{")) ?? "{}") as { presses: number; tint: string };
      const presses = () => report().presses;
      await app.waitFor("id:chat-composer-voice");
      expectLook(app, IDLE);
      // Send's white glyph.
      expect(report().tint).toBe("#ffffffff");
      expect(app.count("label:Voice input")).toBe(1);
      expect(app.enabled("id:chat-composer-voice")).toBe(true);
      expect(app.count("id:chat-composer-voice-beam")).toBe(0);

      await app.press("id:set-recording");
      expectLook(app, RED);
      // White on red, in either theme (token() gives #rrggbbaa).
      expect(report().tint).toBe("#ffffffff");
      // Still the button that ends the recording, named for it.
      expect(app.count("label:Stop and transcribe")).toBe(1);
      expect(app.enabled("label:Stop and transcribe")).toBe(true);
      await app.press("label:Stop and transcribe");
      expect(presses()).toBe(1);

      // Transcribing: the busy primary button (as Send while sending), not red, not pressable.
      await app.press("id:set-transcribing");
      expectLook(app, BUSY);
      expect(app.enabled("id:chat-composer-voice")).toBe(false);
      expect(app.count("id:chat-composer-voice-beam")).toBe(1);

      await app.press("id:set-idle");
      expectLook(app, IDLE);
      expect(app.count("id:chat-composer-voice-beam")).toBe(0);
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
}
