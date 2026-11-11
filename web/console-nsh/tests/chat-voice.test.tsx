// Voice input. Where nsh's Speech module recognizes speech, the mic listens, the live words show
// while it does, and the final text goes into the draft; discarding throws it away. Where the host
// records instead (a browser, the desktop app), the mic shows only while the agent's transcription
// route is ready, and the agent transcribes the recording into the draft.
import { expect, test } from "nsh/test";
import { openConsole, type ApiHandler } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Voice", created_at: NOW, updated_at: NOW }] } };
const CHAT = { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": { body: { items: [] } } };
const READY = { body: { available: true, profile: "ears", model: "gpt-4o-mini-transcribe" } };
const UNSET = { body: { available: false } };
const RECORDING = { id: "rec-1", name: "voice.webm", size: 1200, type: "audio/webm", preview: "" };

// A host that records, as host.js does in a browser (or the desktop app, with `runtime: "desktop"`).
function recordingHost(overrides: Record<string, unknown> = {}) {
  return {
    "morph.voice.support": "",
    "morph.voice.start": { ok: true },
    "morph.voice.stop": RECORDING,
    "morph.voice.cancel": null,
    "morph.file.upload": (data: any) => {
      expect(data.field).toBe("audio");
      expect(String(data.url)).toContain("voice%2Ftranscribe");
      return { ok: true, status: 200, statusText: "OK", body: JSON.stringify({ text: "book a table" }) };
    },
    "morph.file.release": null,
    ...overrides,
  };
}

async function openRecording(route: ApiHandler, options: { runtime?: "web" | "desktop"; features?: string[]; host?: Record<string, unknown> } = {}) {
  const opened = await openConsole({
    location: "/e/default/chat/topic-1",
    runtime: options.runtime,
    features: options.features ?? ["pickFile", "saveFile", "voiceRecord", "voicePreview"],
    host: recordingHost(options.host),
    api: { ...CHAT, "GET /proxy:/voice/transcribe": route },
  });
  await opened.app.waitFor("id:chat-composer-input");
  return opened;
}

const transcribeChecks = (calls: { uri?: string }[]) => calls.filter((call) => call.uri === "/voice/transcribe").length;

// Needs `"speech": true` in nsh.json's capabilities (the integrator adds it); until then the
// platform refuses the session, which the next test covers.
test("speaking fills the draft, and discarding keeps it as it was", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: CHAT,
  });
  await app.waitFor("id:chat-composer-voice");
  await app.press("id:chat-composer-voice");
  await app.waitFor("id:chat-composer-voice-strip");
  await app.hear("book a table");
  await app.waitFor("book a table");
  // Stopping ends the session with the words heard as its final text.
  await app.press("id:chat-composer-voice");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "book a table");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  // A discarded recording leaves the draft alone.
  await app.press("id:chat-composer-voice");
  await app.hear("never mind");
  await app.press("label:Discard recording");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  expect(app.value("id:chat-composer-input")).toBe("book a table");
});

test("a voice input error says why: no secure connection, no recorder, blocked, refused on the phone, no microphone, busy", async () => {
  const { voiceErrorKey } = await import("../components/chat/voice");
  expect(voiceErrorKey({ code: "insecure" })).toBe("chat_composer_voice_insecure");
  expect(voiceErrorKey({ code: "unsupported" })).toBe("chat_composer_voice_unsupported");
  expect(voiceErrorKey({ code: "recorder" })).toBe("chat_composer_voice_recorder");
  expect(voiceErrorKey({ code: "NotAllowedError" })).toBe("chat_composer_voice_denied");
  expect(voiceErrorKey({ code: "not-allowed" })).toBe("chat_composer_voice_denied");
  expect(voiceErrorKey({ code: "permission-denied" })).toBe("chat_composer_voice_permission_denied");
  expect(voiceErrorKey({ code: "permission-blocked" })).toBe("chat_composer_voice_permission_blocked");
  expect(voiceErrorKey({ code: "no_mic" })).toBe("chat_composer_voice_no_mic");
  expect(voiceErrorKey({ code: "busy", message: "start failed" })).toBe("chat_composer_voice_mic_busy");
  expect(voiceErrorKey({ code: "NotFoundError" })).toBe("chat_composer_voice_no_mic");
  expect(voiceErrorKey({ code: "audio-capture" })).toBe("chat_composer_voice_no_mic");
  expect(voiceErrorKey({ code: "NotReadableError" })).toBe("chat_composer_voice_mic_busy");
  expect(voiceErrorKey({ code: "failed", message: "HTTP 502" })).toBe("chat_composer_voice_failed_detail");
  expect(voiceErrorKey({ code: "failed" })).toBe("chat_composer_voice_failed");
});

test("with a ready transcription route the mic is an icon button that records into the draft", async () => {
  const { app } = await openRecording(READY);
  await app.waitFor("id:chat-composer-voice");
  // Named for screen readers: the icon says nothing by itself.
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  // The browser shows the words as it hears them, and the preview can be turned off.
  await app.waitFor("label:Hide live text");
  expect(app.host.calls().find((call) => call.name === "morph.voice.start")?.data).toMatchObject({ preview: true });
  await app.press("label:Stop and transcribe");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "book a table");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  // The recording goes once it was sent.
  expect(app.host.calls().some((call) => call.name === "morph.file.release" && (call.data as any)?.id === "rec-1")).toBe(true);
  // A discarded recording is never sent.
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  await app.press("label:Discard recording");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  expect(app.host.calls().some((call) => call.name === "morph.voice.cancel")).toBe(true);
  expect(app.host.calls().filter((call) => call.name === "morph.file.upload").length).toBe(1);
  expect(app.value("id:chat-composer-input")).toBe("book a table");
});

test("without a ready transcription route there is no mic: unset or failed", async () => {
  for (const route of [UNSET, { status: 500, body: { error: "boom" } }]) {
    const { app, calls } = await openRecording(route);
    await app.waitUntil(() => transcribeChecks(calls) > 0);
    await app.wait(50);
    expect(app.count("id:chat-composer-voice")).toBe(0);
  }
});

test("the mic follows the route when the app comes back to the front", async () => {
  let ready = false;
  const { app, calls } = await openRecording(() => (ready ? READY : UNSET));
  await app.waitUntil(() => transcribeChecks(calls) === 1);
  await app.wait(50);
  expect(app.count("id:chat-composer-voice")).toBe(0);
  // The route was set in another window.
  ready = true;
  await app.host.send("morph.visibility", { visible: true, focused: false });
  await app.host.send("morph.visibility", { visible: true, focused: true });
  await app.waitFor("id:chat-composer-voice");
  expect(transcribeChecks(calls)).toBe(2);
  // And cleared again, while the window was hidden.
  ready = false;
  await app.host.send("morph.visibility", { visible: false, focused: false });
  await app.host.send("morph.visibility", { visible: true, focused: true });
  await app.waitFor("id:chat-composer-voice", { state: "gone" });
});

test("transcription readiness: nothing until answered, per agent, the newest answer wins", async () => {
  const { trackTranscription } = await import("../components/chat/voice");
  const { signal } = await import("nsh");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const asked: { ref: string; resolve: (ok: boolean) => void; reject: (error: Error) => void }[] = [];
  const ref = signal("");
  const active = signal(true);
  const ready = signal(true);
  trackTranscription({
    endpointRef: () => ref(),
    active: () => active(),
    check: (endpointRef) => new Promise<boolean>((resolve, reject) => asked.push({ ref: endpointRef, resolve, reject })),
    ready,
  });
  // No agent: nothing to ask, no mic.
  expect(ready()).toBe(false);
  expect(asked.length).toBe(0);
  // Asked, not answered yet: still no mic.
  ref.set("ep-a");
  expect(asked.map((a) => a.ref)).toEqual(["ep-a"]);
  expect(ready()).toBe(false);
  asked[0].resolve(true);
  await settle();
  expect(ready()).toBe(true);
  // Another agent: no mic until it answers, and the first agent's late answer is dropped.
  active.set(false);
  active.set(true);
  ref.set("ep-b");
  expect(ready()).toBe(false);
  expect(asked.map((a) => a.ref)).toEqual(["ep-a", "ep-a", "ep-b"]);
  asked[1].resolve(true);
  await settle();
  expect(ready()).toBe(false);
  asked[2].resolve(true);
  await settle();
  expect(ready()).toBe(true);
  // Coming back to the front asks again and keeps the mic until the answer; a failure removes it.
  active.set(false);
  active.set(true);
  expect(asked.length).toBe(4);
  expect(ready()).toBe(true);
  asked[3].reject(new Error("HTTP 502"));
  await settle();
  expect(ready()).toBe(false);
  // An older check answering after a newer one does not win.
  active.set(false);
  active.set(true);
  active.set(false);
  active.set(true);
  expect(asked.length).toBe(6);
  asked[5].resolve(false);
  asked[4].resolve(true);
  await settle();
  expect(ready()).toBe(false);
});

test("the desktop app records with the system's recorder, and says so when it has none", async () => {
  const desktop = await openRecording(READY, { runtime: "desktop", features: ["pickFile", "saveFile", "voiceRecord"] });
  await desktop.app.press("label:Voice input");
  await desktop.app.waitFor("id:chat-composer-voice-strip");
  // No live words to show or hide.
  expect(desktop.app.count("label:Hide live text") + desktop.app.count("label:Show live text")).toBe(0);
  expect(desktop.app.host.calls().find((call) => call.name === "morph.voice.start")?.data).toMatchObject({ preview: false });
  await desktop.app.press("label:Stop and transcribe");
  await desktop.app.waitUntil(() => desktop.app.value("id:chat-composer-input") === "book a table");

  const bare = await openRecording(READY, {
    runtime: "desktop",
    features: ["pickFile", "saveFile", "voiceRecord"],
    host: { "morph.voice.support": "recorder" },
  });
  // The route is ready, so the mic shows; a tap explains instead of recording.
  await bare.app.press("label:Voice input (no audio recorder)");
  await bare.app.waitUntil(() => bare.app.texts().some((text) => text.startsWith("Voice input needs an audio recorder")));
  expect(bare.app.host.calls().some((call) => call.name === "morph.voice.start")).toBe(false);
  expect(bare.app.count("id:chat-composer-voice-strip")).toBe(0);

  // A recorder that cannot open the microphone says why.
  const deaf = await openRecording(READY, {
    runtime: "desktop",
    features: ["pickFile", "saveFile", "voiceRecord"],
    host: { "morph.voice.start": { ok: false, error: "audio-capture", message: "pw-record: no target" } },
  });
  await deaf.app.press("label:Voice input");
  await deaf.app.waitUntil(() => deaf.app.texts().some((text) => text.startsWith("No microphone was found")));
  expect(deaf.app.count("id:chat-composer-voice-strip")).toBe(0);
});

test("a recording under way keeps its stop when the route check fails; a new one needs a ready route", async () => {
  let route: unknown = READY;
  const { app, calls } = await openRecording(() => route as any);
  const starts = () => app.host.calls().filter((call) => call.name === "morph.voice.start").length;
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  // Away and back while recording, and the agent cannot say whether it transcribes.
  route = { status: 500, body: { error: "boom" } };
  await app.host.send("morph.visibility", { visible: false, focused: false });
  await app.host.send("morph.visibility", { visible: true, focused: true });
  await app.waitUntil(() => transcribeChecks(calls) === 2);
  await app.wait(50);
  // Still recording, and it can still be stopped and transcribed, not only discarded.
  expect(app.count("id:chat-composer-voice-strip")).toBe(1);
  expect(app.count("label:Discard recording")).toBe(1);
  await app.press("label:Stop and transcribe");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "book a table");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  // Done: with the route unavailable there is no mic to start another.
  await app.waitFor("id:chat-composer-voice", { state: "gone" });
  expect(starts()).toBe(1);
  // The same while the route is unset rather than failing.
  route = READY;
  await app.host.send("morph.visibility", { visible: false, focused: false });
  await app.host.send("morph.visibility", { visible: true, focused: true });
  await app.waitFor("id:chat-composer-voice");
  await app.press("label:Voice input");
  await app.waitFor("id:chat-composer-voice-strip");
  route = UNSET;
  await app.host.send("morph.visibility", { visible: false, focused: false });
  await app.host.send("morph.visibility", { visible: true, focused: true });
  await app.waitUntil(() => transcribeChecks(calls) === 4);
  await app.wait(50);
  await app.press("label:Stop and transcribe");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  await app.waitFor("id:chat-composer-voice", { state: "gone" });
  expect(starts()).toBe(2);
});

// The mic's glyph carries a testID naming its icon and tint (tests/chat-voice-icon.test.tsx).
const MIC = "id:chat-composer-voice-icon.PhMicrophone.subtle";
const RED_MIC = "id:chat-composer-voice-icon.PhMicrophone.danger";

test("the mic turns red while it records and back once the recording ends, is discarded or fails", async () => {
  let upload: unknown = { ok: true, status: 200, statusText: "OK", body: JSON.stringify({ text: "book a table" }) };
  const { app } = await openRecording(READY, { host: { "morph.file.upload": () => upload } });
  await app.waitFor(MIC);
  expect(app.count(RED_MIC)).toBe(0);
  // Recording: the red microphone on the button that stops it.
  await app.press("label:Voice input");
  await app.waitFor(RED_MIC);
  expect(app.count(MIC)).toBe(0);
  expect(app.count("id:chat-composer-voice-icon.PhStop.ink")).toBe(0);
  expect(app.enabled("label:Stop and transcribe")).toBe(true);
  // Stopped and transcribed.
  await app.press("label:Stop and transcribe");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "book a table");
  await app.waitFor(MIC);
  expect(app.count(RED_MIC)).toBe(0);
  // Discarded.
  await app.press("label:Voice input");
  await app.waitFor(RED_MIC);
  await app.press("label:Discard recording");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  await app.waitFor(MIC);
  expect(app.count(RED_MIC)).toBe(0);
  // A transcription that fails.
  upload = { ok: false, status: 502, statusText: "Bad Gateway", body: JSON.stringify({ error: "upstream down" }) };
  await app.press("label:Voice input");
  await app.waitFor(RED_MIC);
  await app.press("label:Stop and transcribe");
  await app.waitFor("id:chat-composer-voice-strip", { state: "gone" });
  await app.waitFor(MIC);
  expect(app.count(RED_MIC)).toBe(0);
  expect(app.count("label:Voice input")).toBe(1);
  expect(app.value("id:chat-composer-input")).toBe("book a table");
});

test("a recorder that cannot start never shows the red mic", async () => {
  const { app } = await openRecording(READY, {
    runtime: "desktop",
    features: ["pickFile", "saveFile", "voiceRecord"],
    host: { "morph.voice.start": { ok: false, error: "audio-capture", message: "pw-record: no target" } },
  });
  await app.press("label:Voice input");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("No microphone was found")));
  expect(app.count(RED_MIC)).toBe(0);
  expect(app.count(MIC)).toBe(1);
  expect(app.count("label:Voice input")).toBe(1);
});
