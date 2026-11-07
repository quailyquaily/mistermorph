// Voice input for the chat composer, on nsh's Speech module: the platform's own speech recognition
// listens while the mic is on, shows the words as they come (the live preview, which can be turned
// off), and puts the final text into the draft to read and edit before sending.
//
// The Vue console recorded audio (MediaRecorder) and had the agent's llm.routes.transcription
// model transcribe it (POST /voice/transcribe). nsh has no audio recording, so the text comes
// from the platform's recognizer instead; the agent's transcription route is not used.
import type { SpeechSession } from "nsh";
import { cleanup, locale, signal, Speech, untracked } from "nsh";
import { localStore } from "../../lib/platform";

// Longest recording; it stops by itself after this.
const MAX_RECORDING_MS = 5 * 60 * 1000;
const PREVIEW_STORAGE_KEY = "mistermorph_console_voice_live_preview";

export type VoiceState = "idle" | "recording" | "transcribing";

export function createVoiceInput(options: { onText: (text: string) => void; onError: (error: { code: string; message?: string }) => void }) {
  const available = signal(false);
  const state = signal<VoiceState>("idle");
  const elapsed = signal(0);
  const preview = signal("");
  const previewEnabled = signal(localStore.getItem(PREVIEW_STORAGE_KEY) !== "off");
  let session: SpeechSession | null = null;
  let discard = false;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  void Speech.available()
    .then((ok) => {
      if (!disposed) available.set(ok === true);
    })
    .catch((error: Error) => {
      console.warn("voice input unavailable:", error?.message || error);
    });

  function clearTimers() {
    if (elapsedTimer) clearInterval(elapsedTimer);
    if (stopTimer) clearTimeout(stopTimer);
    elapsedTimer = undefined;
    stopTimer = undefined;
  }

  function finish() {
    clearTimers();
    session = null;
    state.set("idle");
    preview.set("");
  }

  function start() {
    if (untracked(state) !== "idle" || !untracked(available)) return;
    discard = false;
    let current: SpeechSession;
    try {
      current = Speech.start({ lang: locale() || null, interim: true });
    } catch (error) {
      options.onError({ code: String((error as { code?: string })?.code || "failed"), message: (error as Error)?.message });
      return;
    }
    session = current;
    state.set("recording");
    elapsed.set(0);
    preview.set("");
    const startedAt = Date.now();
    elapsedTimer = setInterval(() => elapsed.set(Math.floor((Date.now() - startedAt) / 1000)), 250);
    stopTimer = setTimeout(stop, MAX_RECORDING_MS);
    current.on("result", (result) => {
      if (session === current && untracked(previewEnabled)) preview.set(String(result?.text || "").trim());
    });
    current.on("end", (end) => {
      if (session !== current) return;
      const text = String(end?.text || "").trim();
      const dropped = discard;
      finish();
      if (dropped) return;
      if (text) {
        options.onText(text);
        return;
      }
      if (end?.error && end.error !== "no-speech") options.onError({ code: end.error });
    });
  }

  function stop() {
    if (!session || untracked(state) !== "recording") return;
    state.set("transcribing");
    clearTimers();
    session.stop();
  }

  /** Stops listening and throws the words away. */
  function cancel() {
    if (!session) return;
    discard = true;
    const current = session;
    finish();
    current.abort();
  }

  function toggle() {
    if (untracked(state) === "recording") stop();
    else start();
  }

  function togglePreview() {
    const next = !untracked(previewEnabled);
    previewEnabled.set(next);
    localStore.setItem(PREVIEW_STORAGE_KEY, next ? "on" : "off");
    if (!next) preview.set("");
  }

  cleanup(() => {
    disposed = true;
    cancel();
    finish();
  });

  return { available, state, elapsed, preview, previewEnabled, toggle, cancel, togglePreview };
}

export type VoiceInput = ReturnType<typeof createVoiceInput>;
