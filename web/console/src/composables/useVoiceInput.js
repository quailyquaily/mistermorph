import { onUnmounted, ref, watch } from "vue";

import { runtimeApiFetchForEndpoint } from "../core/context";

// Voice input for the chat composer: records from the microphone and transcribes the recording
// with the agent's llm.routes.transcription model (POST /voice/transcribe on its runtime).
// state is "idle", "recording" or "transcribing". available is false until the agent reports
// a usable transcription route, and stays false in browsers without MediaRecorder.
//
// While recording, browsers with speech recognition (Chrome, Edge, Safari) also show a live
// preview of the words. The browser's own speech service makes it (Chrome sends the audio to
// Google), so it can be turned off; the text that goes into the draft always comes from the
// agent's model.

// Longest recording; it stops by itself after this.
const MAX_RECORDING_MS = 5 * 60 * 1000;

// Formats the transcription APIs read, in order of preference.
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

const PREVIEW_STORAGE_KEY = "mistermorph_console_voice_live_preview";

// Speech recognition errors that will not go away by restarting it.
const PREVIEW_FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "network"]);

// Speech recognition stops by itself after a pause; it restarts this many times in a row
// without hearing anything before the preview gives up.
const PREVIEW_MAX_IDLE_RESTARTS = 3;

function recordingSupported() {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    Boolean(navigator?.mediaDevices?.getUserMedia)
  );
}

function recordingType() {
  for (const type of RECORDING_TYPES) {
    if (window.MediaRecorder.isTypeSupported?.(type)) {
      return type;
    }
  }
  return "";
}

function speechRecognitionCtor() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function speechLanguage() {
  return String((typeof navigator !== "undefined" && navigator.language) || "").trim();
}

// Languages written without spaces between words.
function joinsWithoutSpaces(lang) {
  return /^(ja|zh|ko|th)\b/i.test(lang);
}

function loadPreviewEnabled() {
  try {
    return localStorage.getItem(PREVIEW_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function savePreviewEnabled(enabled) {
  try {
    localStorage.setItem(PREVIEW_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // The preference is a convenience; keep it for this page only.
  }
}

function extensionFor(type) {
  const base = String(type || "").split(";")[0];
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/ogg") return "ogg";
  return "webm";
}

// endpointRef is a ref (or getter) of the agent to transcribe with. onText gets the text;
// onError gets an Error. elapsed is the recording length in seconds, and preview is the live
// text while recording and transcribing.
export function useVoiceInput({ endpointRef, onText, onError }) {
  const available = ref(false);
  const state = ref("idle");
  const elapsed = ref(0);
  const preview = ref("");
  const previewSupported = Boolean(speechRecognitionCtor());
  const previewEnabled = ref(loadPreviewEnabled());
  let recorder = null;
  let stream = null;
  let chunks = [];
  let stopTimer = 0;
  let elapsedTimer = 0;
  let statusSeq = 0;
  let discard = false;
  let recognition = null;
  let previewDone = "";

  function startPreview() {
    const Recognition = speechRecognitionCtor();
    if (!Recognition || !previewEnabled.value || recognition) {
      return;
    }
    const lang = speechLanguage();
    const separator = joinsWithoutSpaces(lang) ? "" : " ";
    let idleRestarts = 0;
    let failed = false;
    let sessionText = "";
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    if (lang) {
      rec.lang = lang;
    }
    rec.onresult = (event) => {
      idleRestarts = 0;
      let text = "";
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i]?.[0]?.transcript || "";
      }
      sessionText = text.trim();
      if (recognition === rec) {
        preview.value = [previewDone, sessionText].filter(Boolean).join(separator);
      }
    };
    rec.onerror = (event) => {
      if (PREVIEW_FATAL_ERRORS.has(event?.error)) {
        failed = true;
      }
    };
    rec.onend = () => {
      if (recognition !== rec) {
        return;
      }
      previewDone = [previewDone, sessionText].filter(Boolean).join(separator);
      sessionText = "";
      if (failed || state.value !== "recording" || idleRestarts >= PREVIEW_MAX_IDLE_RESTARTS) {
        recognition = null;
        return;
      }
      idleRestarts += 1;
      try {
        rec.start();
      } catch {
        recognition = null;
      }
    };
    recognition = rec;
    previewDone = "";
    try {
      rec.start();
    } catch {
      recognition = null;
    }
  }

  // finish lets the last words arrive; otherwise the preview is dropped at once.
  function stopPreview({ finish = false } = {}) {
    const rec = recognition;
    if (!rec) {
      return;
    }
    if (finish) {
      // onend still folds the last session into previewDone, then clears recognition.
      try {
        rec.stop();
      } catch {
        recognition = null;
      }
      return;
    }
    recognition = null;
    try {
      rec.abort();
    } catch {
      // Already stopped.
    }
  }

  function clearPreview() {
    stopPreview();
    previewDone = "";
    preview.value = "";
  }

  function togglePreview() {
    previewEnabled.value = !previewEnabled.value;
    savePreviewEnabled(previewEnabled.value);
    if (!previewEnabled.value) {
      clearPreview();
    } else if (state.value === "recording") {
      startPreview();
    }
  }

  async function refreshAvailability() {
    const seq = ++statusSeq;
    available.value = false;
    const ref = String((typeof endpointRef === "function" ? endpointRef() : endpointRef?.value) || "").trim();
    if (!ref || !recordingSupported()) {
      return;
    }
    try {
      const data = await runtimeApiFetchForEndpoint(ref, "/voice/transcribe");
      if (seq === statusSeq) {
        available.value = data?.available === true;
      }
    } catch {
      // An agent that predates voice input has no such route; leave the mic hidden.
    }
  }

  function releaseStream() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = 0;
    }
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = 0;
    }
    for (const track of stream?.getTracks?.() || []) {
      track.stop();
    }
    stream = null;
    recorder = null;
  }

  async function transcribe(blob, type) {
    const ref = String((typeof endpointRef === "function" ? endpointRef() : endpointRef?.value) || "").trim();
    if (!ref || blob.size === 0) {
      state.value = "idle";
      clearPreview();
      return;
    }
    state.value = "transcribing";
    try {
      const form = new FormData();
      form.append("audio", blob, `voice.${extensionFor(type)}`);
      const data = await runtimeApiFetchForEndpoint(ref, "/voice/transcribe", { method: "POST", body: form });
      const text = String(data?.text || "").trim();
      if (text) {
        onText?.(text);
      }
    } catch (err) {
      onError?.(err);
    } finally {
      state.value = "idle";
      clearPreview();
    }
  }

  async function start() {
    if (state.value !== "idle" || !available.value) {
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      releaseStream();
      onError?.(err);
      return;
    }
    const type = recordingType();
    chunks = [];
    discard = false;
    recorder = new window.MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      const recordedType = recorder?.mimeType || type || "audio/webm";
      const blob = new Blob(chunks, { type: recordedType });
      chunks = [];
      releaseStream();
      if (discard) {
        state.value = "idle";
        clearPreview();
        return;
      }
      void transcribe(blob, recordedType);
    };
    recorder.start();
    state.value = "recording";
    elapsed.value = 0;
    const startedAt = Date.now();
    elapsedTimer = setInterval(() => {
      elapsed.value = Math.floor((Date.now() - startedAt) / 1000);
    }, 250);
    stopTimer = setTimeout(stop, MAX_RECORDING_MS);
    preview.value = "";
    startPreview();
  }

  function stop() {
    if (recorder && recorder.state !== "inactive") {
      stopPreview({ finish: !discard });
      recorder.stop();
    }
  }

  // Stops recording and throws the audio away.
  function cancel() {
    discard = true;
    stop();
  }

  function toggle() {
    if (state.value === "recording") {
      stop();
    } else {
      void start();
    }
  }

  watch(
    () => (typeof endpointRef === "function" ? endpointRef() : endpointRef?.value),
    () => {
      cancel();
      void refreshAvailability();
    },
    { immediate: true }
  );

  onUnmounted(cancel);

  return {
    available,
    state,
    elapsed,
    preview,
    previewSupported,
    previewEnabled,
    toggle,
    cancel,
    togglePreview,
    refreshAvailability,
  };
}
