// Voice input in the chat composer (composables/useVoiceInput.js): whether this page can record,
// and which message explains an error. Kept free of Vue and the network so tests can load it.

// Why this page cannot record: "" when it can, "insecure" or "unsupported". Browsers only open
// the microphone in a secure context (HTTPS or localhost), so a phone reaching the Console over
// plain HTTP has no navigator.mediaDevices at all.
export function voiceRecordingUnsupportedReason(win = typeof window === "undefined" ? undefined : window) {
  if (!win) {
    return "unsupported";
  }
  if (win.isSecureContext === false) {
    return "insecure";
  }
  if (typeof win.MediaRecorder === "undefined" || !win.navigator?.mediaDevices?.getUserMedia) {
    return "unsupported";
  }
  return "";
}

// The error onError gets when recording cannot start here; code is the unsupported reason.
export class VoiceInputUnsupportedError extends Error {
  constructor(code) {
    super(code === "insecure" ? "Voice input needs a secure connection." : "This browser cannot record audio.");
    this.name = "VoiceInputUnsupportedError";
    this.code = code;
  }
}

// The i18n key for an error onError got: why recording could not start, or why it failed.
export function voiceInputErrorKey(err) {
  if (err?.name === "VoiceInputUnsupportedError") {
    return err.code === "insecure" ? "chat_composer_voice_insecure" : "chat_composer_voice_unsupported";
  }
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "chat_composer_voice_denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "chat_composer_voice_no_mic";
    case "NotReadableError":
    case "AbortError":
      return "chat_composer_voice_mic_busy";
    case "NotSupportedError":
      return "chat_composer_voice_unsupported";
    default:
      return String(err?.message || "").trim() ? "chat_composer_voice_failed_detail" : "chat_composer_voice_failed";
  }
}
