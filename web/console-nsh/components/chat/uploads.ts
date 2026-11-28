// The composer's uploads (FT197): how large a file may be, how many go at once, and what a failed
// upload tells the user.
//
// The agent takes files of up to 128 MiB each, in requests of up to 129 MiB (internal/daemonruntime
// upload_limits.go; the Console's proxy checks the same). The composer sends one file a request and
// checks a file's size before sending it (a picked, dropped or pasted one alike), so a file over the
// limit is refused on the device, with no upload. A paste takes up to 256 MiB of images in all. At
// most two uploads of a composer run at once; the rest wait their turn in the order they were added.
//
// What the model is shown is another budget (imagePaste.ts MODEL_IMAGE_*): it decides what can be
// sent, never what can be attached.

/** The agent's budget for one uploaded file (daemonruntime.FileUploadMaxFileBytes). */
export const UPLOAD_MAX_FILE_BYTES = 128 * 1024 * 1024;
/** The agent's budget for one upload request (daemonruntime.FileUploadMaxRequestBytes). */
export const UPLOAD_MAX_REQUEST_BYTES = 129 * 1024 * 1024;
/** The most bytes of images one paste attaches. */
export const PASTE_BATCH_MAX_BYTES = 256 * 1024 * 1024;
/** How many of a composer's uploads run at once. */
export const COMPOSER_UPLOAD_CONCURRENCY = 2;

/** `bytes` as "128 MiB (134,217,728 bytes)". */
export function formatLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  const shown = Number.isInteger(mib) ? String(mib) : mib.toFixed(1);
  const digits = String(Math.round(bytes)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${shown} MiB (${digits} bytes)`;
}

/**
 * Runs tasks at most `limit` at a time, in the order they were given. A task that should no longer
 * run (its file was removed meanwhile) says so when its turn comes and is skipped.
 */
export function createUploadGate(limit = COMPOSER_UPLOAD_CONCURRENCY) {
  let running = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    if (running >= limit) return;
    const start = waiting.shift();
    if (start) start();
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          running += 1;
          task()
            .then(resolve, reject)
            .finally(() => {
              running -= 1;
              next();
            });
        });
        next();
      });
    },
    /** How many run now and how many wait (tests). */
    state: () => ({ running, waiting: waiting.length }),
  };
}

export interface UploadFailure {
  message: string;
  /** Whether sending the same bytes again may work (a network failure, a busy or slow server). */
  retryable: boolean;
}

const looksLikeMarkup = (text: string) => /^\s*</.test(text);

/**
 * What a failed upload says, and whether a retry may help. A refusal over a size never retries
 * (the same bytes are refused again): the agent's own refusal names its limit; a refusal without
 * one (an HTML page of a proxy in front of the server, an older agent's text) says who refused.
 */
export function uploadFailure(
  error: unknown,
  text: (key: string, values?: Record<string, string>) => string,
  fallback: string,
): UploadFailure {
  const err = (error ?? {}) as { status?: number; code?: string; message?: string };
  const status = Number(err.status) || 0;
  const raw = String(err.message || "").trim();
  const message = looksLikeMarkup(raw) ? "" : raw;
  if (err.code === "upload_file_too_large") {
    return { message: text("chat_composer_upload_file_refused", { limit: formatLimit(UPLOAD_MAX_FILE_BYTES) }), retryable: false };
  }
  if (err.code === "upload_request_too_large") {
    return { message: text("chat_composer_upload_request_refused", { limit: formatLimit(UPLOAD_MAX_REQUEST_BYTES) }), retryable: false };
  }
  if (status === 413) {
    return {
      message: message && !/^HTTP 413$/i.test(message) ? text("chat_composer_upload_refused_size", { message }) : text("chat_composer_upload_refused_size_unknown"),
      retryable: false,
    };
  }
  if (status === 415) return { message: message || fallback, retryable: false };
  if (err.code === "upload_busy" || status === 503) {
    return { message: err.code === "upload_busy" ? text("chat_composer_upload_busy") : message || fallback, retryable: true };
  }
  if (status === 504 || status === 408) return { message: text("chat_composer_upload_timeout"), retryable: true };
  return { message: message || fallback, retryable: true };
}

/** The indexes of `file_references` a refused send names as gone (`file_references[2]: file does not exist`). */
export function missingReferenceIndexes(error: unknown): number[] {
  const err = (error ?? {}) as { status?: number; message?: string };
  if (Number(err.status) !== 400) return [];
  const found: number[] = [];
  for (const match of String(err.message || "").matchAll(/file_references\[(\d+)\]: file does not exist/g)) found.push(Number(match[1]));
  return found;
}
