import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { VoiceInputUnsupportedError, voiceInputErrorKey, voiceRecordingUnsupportedReason } from "./voice-input.js";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function fakeWindow({ secure = true, recorder = true, media = true } = {}) {
  return {
    isSecureContext: secure,
    MediaRecorder: recorder ? function MediaRecorder() {} : undefined,
    navigator: media ? { mediaDevices: { getUserMedia() {} } } : {},
  };
}

test("voiceRecordingUnsupportedReason tells plain HTTP from a browser that cannot record", () => {
  assert.equal(voiceRecordingUnsupportedReason(fakeWindow()), "");
  // A phone on the LAN over http:// is not a secure context and has no mediaDevices at all.
  assert.equal(voiceRecordingUnsupportedReason(fakeWindow({ secure: false, media: false })), "insecure");
  assert.equal(voiceRecordingUnsupportedReason(fakeWindow({ secure: false })), "insecure");
  assert.equal(voiceRecordingUnsupportedReason(fakeWindow({ recorder: false })), "unsupported");
  assert.equal(voiceRecordingUnsupportedReason(fakeWindow({ media: false })), "unsupported");
  assert.equal(voiceRecordingUnsupportedReason(undefined), "unsupported");
});

test("voiceInputErrorKey explains unsupported pages, denied and missing microphones", () => {
  const named = (name, message = "") => Object.assign(new Error(message), { name });
  assert.equal(voiceInputErrorKey(new VoiceInputUnsupportedError("insecure")), "chat_composer_voice_insecure");
  assert.equal(voiceInputErrorKey(new VoiceInputUnsupportedError("unsupported")), "chat_composer_voice_unsupported");
  assert.equal(voiceInputErrorKey(named("NotAllowedError")), "chat_composer_voice_denied");
  assert.equal(voiceInputErrorKey(named("SecurityError")), "chat_composer_voice_denied");
  assert.equal(voiceInputErrorKey(named("NotFoundError")), "chat_composer_voice_no_mic");
  assert.equal(voiceInputErrorKey(named("OverconstrainedError")), "chat_composer_voice_no_mic");
  assert.equal(voiceInputErrorKey(named("NotReadableError")), "chat_composer_voice_mic_busy");
  assert.equal(voiceInputErrorKey(named("NotSupportedError")), "chat_composer_voice_unsupported");
  assert.equal(voiceInputErrorKey(new Error("transcription failed: 401")), "chat_composer_voice_failed_detail");
  assert.equal(voiceInputErrorKey(new Error("")), "chat_composer_voice_failed");
  assert.equal(voiceInputErrorKey(null), "chat_composer_voice_failed");
});

test("every voice input message exists in each language", async () => {
  const keys = [
    "chat_composer_voice_insecure",
    "chat_composer_voice_insecure_label",
    "chat_composer_voice_unsupported",
    "chat_composer_voice_unsupported_label",
    "chat_composer_voice_no_mic",
    "chat_composer_voice_mic_busy",
    "chat_composer_voice_failed_detail",
    "chat_composer_voice_denied",
    "chat_composer_voice_failed",
  ];
  const i18n = await source("../i18n/index.js");
  for (const key of keys) {
    // One message each in en, zh and ja.
    const found = i18n.match(new RegExp(`^    ${key}: "[^"]+",$`, "gmu")) || [];
    assert.equal(found.length, 3, key);
  }
  assert.equal((i18n.match(/^    chat_composer_voice_failed_detail: "\{message\}",$/gmu) || []).length, 3);
});

test("useVoiceInput shows the mic for a transcribing agent even where the page cannot record", async () => {
  const composable = await source("../composables/useVoiceInput.js");
  const refresh = composable.slice(composable.indexOf("async function refreshAvailability()"), composable.indexOf("function releaseStream()"));
  const start = composable.slice(composable.indexOf("async function start()"), composable.indexOf("function stop()"));

  assert.match(composable, /const unsupported = voiceRecordingUnsupportedReason\(\);/u);
  // Availability follows the agent's transcription route only.
  assert.equal(refresh.includes("recordingSupported"), false);
  assert.match(refresh, /if \(!ref\) \{\s*return;\s*\}/u);
  // A tap where the page cannot record explains why instead of asking for the microphone.
  assert.ok(start.indexOf("new VoiceInputUnsupportedError(unsupported)") < start.indexOf("getUserMedia"));
  // A second tap while the browser asks for the microphone does not open another stream.
  assert.match(start, /if \(starting\) \{\s*return;\s*\}\s*starting = true;/u);
  assert.match(start, /\} finally \{\s*starting = false;\s*\}/u);
  // A recorder the browser refuses to build releases the microphone and reports the error.
  assert.match(start, /try \{\s*recorder = new window\.MediaRecorder\(stream, type \? \{ mimeType: type \} : undefined\);\s*\} catch \(err\) \{\s*releaseStream\(\);\s*onError\?\.\(err\);\s*return;\s*\}/u);
  assert.match(composable, /return \{\s*available,\s*unsupported,/u);
});
