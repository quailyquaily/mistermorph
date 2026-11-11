// Voice input in the Android app. nsh records no audio on Android, so the APK's native part
// (android/src, scripts/build-android.sh) answers `morph.voice.*` over nsh's host channel: here the
// test plays it. The console's own host (lib/mobileHost.ts) asks it at boot, records with it,
// sends the recording through it to the agent's /voice/transcribe, and ends everything when the
// app leaves the foreground. The words go into the draft, which keeps what was typed and is never
// sent by itself.
import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = {
  body: {
    items: [
      { id: "topic-1", title: "Voice", created_at: NOW, updated_at: NOW },
      { id: "topic-2", title: "Other", created_at: NOW, updated_at: NOW },
    ],
  },
};
const CHAT = { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": { body: { items: [] } }, "GET /proxy:/todo/tasks": { body: { items: [] } } };
const READY = { body: { available: true, profile: "ears", model: "gpt-4o-mini-transcribe" } };
const RECORDING = { id: "voice-1", name: "voice.m4a", size: 2048, type: "audio/mp4", preview: "" };
const SAID = (text: string) => ({ ok: true, status: 200, statusText: "OK", body: JSON.stringify({ text }) });

/** The native part, as the APK's MorphApplication answers it. */
function nativeHost(overrides: Record<string, unknown> = {}) {
  return {
    "morph.voice.support": "",
    "morph.voice.start": { ok: true },
    "morph.voice.stop": RECORDING,
    "morph.voice.cancel": null,
    "morph.voice.upload": (data: any) => {
      expect(data.id).toBe("voice-1");
      expect(data.field).toBe("audio");
      expect(String(data.url)).toContain("voice%2Ftranscribe");
      expect(data.headers?.Authorization || data.headers?.authorization).toBe("Bearer token-1");
      return SAID("book a table");
    },
    "morph.voice.release": null,
    ...overrides,
  };
}

async function openPhone(host: Record<string, unknown> | undefined, route: unknown = READY) {
  const opened = await openConsole({
    platform: "android",
    location: "/e/default/chat/topic-1",
    host,
    api: { ...CHAT, "GET /proxy:/voice/transcribe": route as any },
  });
  await opened.app.waitFor("id:chat-composer-input");
  return opened;
}

const named = (app: { host: { calls(): { name: string; data: unknown }[] } }, name: string) =>
  app.host.calls().filter((call) => call.name === name);
const shows = (app: { texts(): string[] }, start: string) => app.texts().some((text) => text.startsWith(start));

test("the native part records, the agent transcribes, and the words join the draft without sending it", async () => {
  const { app, calls } = await openPhone(nativeHost());
  await app.type("id:chat-composer-input", "Note: ");
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  expect(named(app, "morph.voice.start").length).toBe(1);
  // No live words on the phone: nothing to show or hide.
  expect(app.count("label:Hide live text") + app.count("label:Show live text")).toBe(0);
  await app.press("label:Stop and transcribe");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Note: book a table");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  // Sent by the native part, not by the app's fetch; the draft is not sent.
  expect(named(app, "morph.voice.upload").length).toBe(1);
  expect(calls.some((call) => call.method === "POST" && call.uri === "/voice/transcribe")).toBe(false);
  expect(calls.some((call) => call.method === "POST" && String(call.uri || "").startsWith("/tasks"))).toBe(false);
  // The mic is ready for the next one.
  await app.waitFor("label:Voice input");
});

test("nothing heard leaves the draft as it was", async () => {
  const { app } = await openPhone(nativeHost({ "morph.voice.upload": SAID("") }));
  await app.type("id:chat-composer-input", "keep me");
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  await app.press("label:Stop and transcribe");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  await app.waitFor("label:Voice input");
  expect(app.value("id:chat-composer-input")).toBe("keep me");
  // A recording without audio is no file: nothing to send.
  const silent = await openPhone(nativeHost({ "morph.voice.stop": null }));
  await silent.app.press("label:Voice input");
  await silent.app.press("label:Stop and transcribe");
  await silent.app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  expect(named(silent.app, "morph.voice.upload").length).toBe(0);
});

test("refused microphone: asks again on the next tap, then points to Settings once blocked", async () => {
  const answers = [{ ok: false, error: "permission-denied" }, { ok: false, error: "permission-blocked" }, { ok: true }];
  const { app } = await openPhone(nativeHost({ "morph.voice.start": () => answers.shift() }));
  await app.type("id:chat-composer-input", "draft");
  await app.press("label:Voice input");
  await app.waitUntil(() => shows(app, "Voice input needs the microphone. Tap the mic again"));
  expect(app.count("id:chat-composer-voice-strip")).toBe(0);
  // Retry: the native part asks again.
  await app.press("label:Voice input");
  await app.waitUntil(() => shows(app, "Microphone access is turned off for this app. Turn it on in Android Settings"));
  expect(app.count("id:chat-composer-voice-strip")).toBe(0);
  // Allowed in Settings: the next tap records.
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  expect(named(app, "morph.voice.start").length).toBe(3);
  expect(app.value("id:chat-composer-input")).toBe("draft");
});

test("a phone without a microphone says so instead of recording; a busy one says why", async () => {
  const { app } = await openPhone(nativeHost({ "morph.voice.support": "no_mic" }));
  await app.press("label:Voice input (no microphone)");
  await app.waitUntil(() => shows(app, "No microphone was found"));
  expect(named(app, "morph.voice.start").length).toBe(0);

  const busy = await openPhone(nativeHost({ "morph.voice.start": { ok: false, error: "busy", message: "start failed" } }));
  await busy.app.press("label:Voice input");
  await busy.app.waitUntil(() => shows(busy.app, "The microphone could not be opened"));
  expect(busy.app.count("id:chat-composer-voice-strip")).toBe(0);
});

test("without the native part, or without a ready route, there is no recording mic", async () => {
  // An APK built without android/src: the host call fails, so the app does not record. Only nsh's
  // speech recognizer is left, which the headless engine has and a real Android does not (no mic).
  const bare = await openPhone(undefined);
  await bare.app.press("label:Voice input");
  await bare.app.hear("hello");
  await bare.app.press("label:Discard recording");
  await bare.app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  // The route unset: nothing to transcribe with.
  const unset = await openPhone(nativeHost(), { body: { available: false } });
  await unset.app.wait(100);
  expect(unset.app.count("label:Voice input")).toBe(0);
  expect(named(unset.app, "morph.voice.start").length).toBe(0);
});

test("leaving the app ends the recording: microphone released, nothing sent, draft kept", async () => {
  const { app } = await openPhone(nativeHost());
  await app.type("id:chat-composer-input", "draft");
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  await app.setLifecycle("background");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  expect(named(app, "morph.voice.cancel").length).toBeGreaterThan(0);
  await app.setLifecycle("active");
  await app.waitFor("label:Voice input");
  expect(named(app, "morph.voice.stop").length).toBe(0);
  expect(named(app, "morph.voice.upload").length).toBe(0);
  expect(app.value("id:chat-composer-input")).toBe("draft");
  // A permission question only makes the app inactive: that ends nothing.
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  await app.setLifecycle("inactive");
  await app.setLifecycle("active");
  expect(app.count("id:chat-composer-voice-strip")).toBe(1);
});

test("the native part ending a recording by itself: an error says so, leaving says nothing", async () => {
  const { app } = await openPhone(nativeHost());
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  await app.host.send("morph.voice.ended", { reason: "error", message: "The recorder stopped (1, -1)." });
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  await app.waitUntil(() => shows(app, "The recorder stopped (1, -1)."));
  // A start the system cancelled (the app left while asking) is no error.
  const asked = await openPhone(nativeHost({ "morph.voice.start": { ok: false, error: "cancelled" } }));
  await asked.app.press("label:Voice input");
  await asked.app.waitFor("label:Voice input");
  await asked.app.wait(50);
  expect(shows(asked.app, "Could not transcribe")).toBe(false);
  expect(asked.app.count("id:chat-composer-voice-strip")).toBe(0);
});

test("another conversation ends the recording; the words go into the draft they were spoken for", async () => {
  const { app } = await openPhone(nativeHost());
  await app.type("id:chat-composer-input", "first draft");
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  // Back to the topics, into another one: the recording is thrown away, nothing is sent. (The
  // conversation slides out first; headless, a press during that slide's last frame is lost.)
  await app.back();
  await app.waitFor("id:chat-conversation-pane", { state: "gone" });
  await app.press("Other");
  await app.waitFor("id:chat-composer-input");
  await app.waitFor("label:Voice input");
  expect(app.count("id:chat-composer-voice-strip")).toBe(0);
  expect(named(app, "morph.voice.cancel").length).toBeGreaterThan(0);
  expect(named(app, "morph.voice.upload").length).toBe(0);
  expect(app.value("id:chat-composer-input")).toBe("");
  // Recorded here, the words go into this topic's draft; the first topic keeps its own.
  await app.press("label:Voice input");
  await app.press("label:Stop and transcribe");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "book a table");
  await app.back();
  await app.waitFor("id:chat-conversation-pane", { state: "gone" });
  await app.press("Voice");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "first draft");
});
