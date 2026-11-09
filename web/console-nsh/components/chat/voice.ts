// Voice input for the chat composer. Two ways to get the words:
//
// - Where nsh's Speech module recognizes speech (the platform's own recognizer), it listens while
//   the mic is on, shows the words as they come (the live preview, which can be turned off), and
//   puts the final text into the draft to read and edit before sending.
// - Where the host records instead (feature "voiceRecord": the web page's host.js, and the desktop
//   app, whose GPUI window recognizes no speech), the host records (lib/platform voiceRecording)
//   and the agent's llm.routes.transcription model transcribes the recording
//   (POST /voice/transcribe), as the Vue console's useVoiceInput did. The mic then shows whenever
//   the agent can transcribe, even where the host cannot record: `unsupported` is "insecure"
//   (browsers only open the microphone on HTTPS or localhost), "unsupported" (no recorder in the
//   browser) or "recorder" (no recorder program on the desktop), and a tap explains it instead of
//   recording. Typing is never affected.
import type { Signal, SpeechSession } from "nsh";
import { cleanup, effect, locale, signal, Speech, untracked } from "nsh";
import { hasFocus, isVisible, localStore, onVisibilityChange, voiceRecording, type PickedFile } from "../../lib/platform";

// Longest recording; it stops by itself after this.
const MAX_RECORDING_MS = 5 * 60 * 1000;
const PREVIEW_STORAGE_KEY = "mistermorph_console_voice_live_preview";

export type VoiceState = "idle" | "recording" | "transcribing";

export interface VoiceInputOptions {
  onText: (text: string) => void;
  /** `code` is the platform's or browser's error name, "insecure", "unsupported" or "recorder". */
  onError: (error: { code: string; message?: string }) => void;
  /** The agent that transcribes a browser's recording, and whether it can (GET /voice/transcribe). */
  endpointRef?: () => string;
  canTranscribe?: (endpointRef: string) => Promise<boolean>;
  transcribe?: (endpointRef: string, file: PickedFile) => Promise<string>;
  release?: (file: PickedFile) => void;
}

export function createVoiceInput(options: VoiceInputOptions) {
  const records = voiceRecording.available() && Boolean(options.transcribe && options.canTranscribe && options.endpointRef);
  // Whether there is a live preview to turn on and off: the platform's recognizer has one, and a
  // recording host only where it says so (the browser's speech recognition; the desktop has none).
  const previewable = !records || voiceRecording.previews();
  // Whether a new recording may start: the platform recognizes speech, or the agent transcribes.
  const ready = signal(false);
  const state = signal<VoiceState>("idle");
  // The mic shows while a recording may start, and stays while one is under way even when a later
  // check finds the route gone (or fails), so it can still be stopped and transcribed.
  const available = () => ready() || state() !== "idle";
  // Why the host cannot record here: "", "insecure", "unsupported" or "recorder".
  const unsupported = signal("");
  const elapsed = signal(0);
  const preview = signal("");
  const previewEnabled = signal(localStore.getItem(PREVIEW_STORAGE_KEY) !== "off");
  let session: SpeechSession | null = null;
  let recording = false;
  let discard = false;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  if (records) {
    void voiceRecording
      .support()
      .then((reason) => {
        if (!disposed) unsupported.set(reason);
      })
      .catch((error: Error) => {
        console.warn("voice input: the host cannot say whether it records:", error?.message || error);
        if (!disposed) unsupported.set("unsupported");
      });
    cleanup(
      voiceRecording.onPreview((text) => {
        if (recording && untracked(state) === "recording" && untracked(previewEnabled)) preview.set(text.trim());
      }),
    );
    // The mic shows while the agent the composer sends to can transcribe (GET /voice/transcribe).
    // Whether the app is in front comes from the host (nsh's `lifecycle` breaks the web page).
    const inFront = () => isVisible() && hasFocus();
    const front = signal(inFront());
    cleanup(onVisibilityChange(() => front.set(inFront())));
    trackTranscription({
      endpointRef: () => options.endpointRef!(),
      active: () => front(),
      check: (ref) => options.canTranscribe!(ref),
      ready,
      disposed: () => disposed,
    });
  } else {
    void Speech.available()
      .then((ok) => {
        if (!disposed) ready.set(ok === true);
      })
      .catch((error: Error) => {
        console.warn("voice input unavailable:", error?.message || error);
      });
  }

  function clearTimers() {
    if (elapsedTimer) clearInterval(elapsedTimer);
    if (stopTimer) clearTimeout(stopTimer);
    elapsedTimer = undefined;
    stopTimer = undefined;
  }

  function finish() {
    clearTimers();
    session = null;
    recording = false;
    state.set("idle");
    preview.set("");
  }

  function begin() {
    state.set("recording");
    elapsed.set(0);
    preview.set("");
    const startedAt = Date.now();
    elapsedTimer = setInterval(() => elapsed.set(Math.floor((Date.now() - startedAt) / 1000)), 250);
    stopTimer = setTimeout(stop, MAX_RECORDING_MS);
  }

  function startSpeech() {
    let current: SpeechSession;
    try {
      current = Speech.start({ lang: locale() || null, interim: true });
    } catch (error) {
      options.onError({ code: String((error as { code?: string })?.code || "failed"), message: (error as Error)?.message });
      return;
    }
    session = current;
    begin();
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

  async function startRecording() {
    const reason = untracked(unsupported);
    if (reason) {
      options.onError({ code: reason });
      return;
    }
    // Recording until the browser has asked for the microphone, so a second tap does nothing.
    state.set("recording");
    recording = true;
    const started = await voiceRecording.start({ preview: previewable && untracked(previewEnabled), lang: locale() || "" }).catch((error: Error) => ({
      ok: false,
      error: "failed",
      message: String(error?.message || ""),
    }));
    if (disposed || !recording) {
      if (started.ok) voiceRecording.cancel();
      return;
    }
    if (!started.ok) {
      finish();
      options.onError({ code: String(started.error || "failed"), message: started.message });
      return;
    }
    begin();
  }

  function start() {
    if (untracked(state) !== "idle" || !untracked(ready)) return;
    discard = false;
    if (records) void startRecording();
    else startSpeech();
  }

  async function stopRecording() {
    const ref = String(options.endpointRef!() || "").trim();
    let file: PickedFile | null = null;
    try {
      file = await voiceRecording.stop();
      if (!file || !ref || discard || disposed) return;
      const text = await options.transcribe!(ref, file);
      if (text && !discard && !disposed) options.onText(text);
    } catch (error) {
      if (!disposed) options.onError({ code: "failed", message: (error as Error)?.message });
    } finally {
      if (file) options.release?.(file);
      if (!disposed) finish();
    }
  }

  function stop() {
    if (untracked(state) !== "recording") return;
    if (records) {
      if (!recording) return;
      state.set("transcribing");
      clearTimers();
      void stopRecording();
      return;
    }
    if (!session) return;
    state.set("transcribing");
    clearTimers();
    session.stop();
  }

  /** Stops listening and throws the words away. */
  function cancel() {
    if (records) {
      if (!recording) return;
      discard = true;
      finish();
      voiceRecording.cancel();
      return;
    }
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
    cancel();
    disposed = true;
    finish();
  });

  return { available, unsupported, state, elapsed, preview, previewable, previewEnabled, toggle, cancel, togglePreview };
}

export type VoiceInput = ReturnType<typeof createVoiceInput>;

/**
 * Keeps `ready` to whether the agent `endpointRef` names can transcribe, as `check` answers. It is
 * asked when that agent changes, and again each time the app comes back to the front (`active`),
 * since the route may have been set or cleared in another window meanwhile. Until the first answer
 * for an agent, and after a failed check, `ready` is false; a check of the same agent keeps the
 * last answer until its own comes, so the mic does not blink. An answer that comes after a newer
 * check was started is dropped.
 */
export function trackTranscription(options: {
  endpointRef: () => string;
  active: () => boolean;
  check: (endpointRef: string) => Promise<boolean>;
  ready: Signal<boolean>;
  disposed?: () => boolean;
}) {
  const gone = () => options.disposed?.() === true;
  let seq = 0;
  let checkedRef: string | null = null;
  let wasActive = untracked(options.active);
  effect(() => {
    const ref = String(options.endpointRef() || "").trim();
    const active = options.active();
    const returned = active && !wasActive;
    wasActive = active;
    if (ref !== checkedRef) {
      checkedRef = ref;
      seq += 1;
      untracked(() => options.ready.set(false));
    } else if (!returned) {
      return;
    }
    if (!ref) return;
    const current = ++seq;
    void untracked(() => options.check(ref))
      .then((ok) => {
        if (!gone() && current === seq) options.ready.set(ok === true);
      })
      .catch((error: Error) => {
        if (gone() || current !== seq) return;
        console.warn("voice input: cannot ask the agent whether it transcribes:", error?.message || error);
        options.ready.set(false);
      });
  });
}

/** The message key for a voice input error: why recording could not start, or why it failed. */
export function voiceErrorKey(error: { code?: string; message?: string }): string {
  switch (String(error?.code || "")) {
    case "insecure":
      return "chat_composer_voice_insecure";
    case "unsupported":
    case "NotSupportedError":
      return "chat_composer_voice_unsupported";
    case "recorder":
      return "chat_composer_voice_recorder";
    case "NotAllowedError":
    case "SecurityError":
    case "not-allowed":
    case "service-not-allowed":
    case "ERR_ACCESS_DENIED":
      return "chat_composer_voice_denied";
    case "NotFoundError":
    case "OverconstrainedError":
    case "audio-capture":
      return "chat_composer_voice_no_mic";
    case "NotReadableError":
    case "AbortError":
    case "busy":
      return "chat_composer_voice_mic_busy";
    default:
      return String(error?.message || "").trim() ? "chat_composer_voice_failed_detail" : "chat_composer_voice_failed";
  }
}
