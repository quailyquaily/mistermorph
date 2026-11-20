// Scanning a QR code for the console server's address (pages/login/ServerDialog.tsx). The camera
// and the decoder are a web view's page (lib/qrScannerPage.js, shown by pages/login/QrScanner.tsx);
// this is the app's side: what the page says, one scan from its opening to its end, and what of a
// code's text is a server address. A scan only ever yields text for the dialog's field: nothing
// here saves it, asks the address anything or sends it a password.
import { parseServer } from "./mobileHost";

/** Why a scan gave no code (see lib/qrScannerPage.js). */
export type ScanFailure = "unsupported" | "denied" | "no_camera" | "busy" | "interrupted" | "failed";

export type ScanEvent = { type: "ready" } | { type: "result"; text: string } | { type: "error"; code: ScanFailure };

const FAILURES: ScanFailure[] = ["unsupported", "denied", "no_camera", "busy", "interrupted", "failed"];

/** The longest text taken from a code: an address is far shorter. */
export const SCAN_TEXT_MAX = 2048;

/** What the page said, or null for anything else: the page's messages are checked, not trusted. */
export function readScanMessage(data: unknown): ScanEvent | null {
  if (typeof data !== "string" || data.length > SCAN_TEXT_MAX * 4) return null;
  let message: { type?: unknown; text?: unknown; code?: unknown } | null;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.type === "ready") return { type: "ready" };
  if (message.type === "result") return typeof message.text === "string" ? { type: "result", text: message.text } : null;
  if (message.type === "error") {
    return { type: "error", code: FAILURES.includes(message.code as ScanFailure) ? (message.code as ScanFailure) : "failed" };
  }
  return null;
}

/**
 * The server address a code's text holds, as it would be saved, or null. The rules are the typed
 * address's (`parseServer`: http or https, with a host); a code is held to them more closely, since
 * nobody typed it: one line without spaces, no name or password in it, and no other kind of link
 * (`WIFI:…`, `mailto:…`) read as a host.
 */
export function scannedServer(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value || value.length > SCAN_TEXT_MAX) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  // Without a scheme, "name:" is a host only before a port.
  if (!schemed && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value)) return null;
  const authority = (schemed ? value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") : value).split(/[/?#]/)[0];
  if (authority.includes("@")) return null;
  return parseServer(value)?.address ?? null;
}

/** One scan: from the scanner's opening until a code, a failure or its closing. */
export interface Scan {
  /** A message of the page's. Nothing is heard once the scan ended or was closed. */
  receive(data: unknown): void;
  /** How the page is told to stop (the web view's `postMessage`), once the web view exists. */
  attach(post: (message: string) => void): void;
  /** A failure seen outside the page (the web view could not load it, the app left the screen). */
  fail(code: ScanFailure): void;
  /** Ends the scan: the page is told to release the camera and nothing it says is heard any more. */
  close(): void;
  /** "open" until the scan ended by itself ("done") or was closed ("closed"). */
  state(): "open" | "done" | "closed";
}

let scanWatcher: ((scan: Scan) => void) | null = null;

/** For tests: told of every scan as it opens (to speak as its page would). null stops it. */
export function watchScans(watcher: ((scan: Scan) => void) | null) {
  scanWatcher = watcher;
}

/**
 * Opens a scan. `on` hears "ready" at most once and then at most one "result" or "error", and
 * nothing after `close()`: a permission answered late, or a code read as the scanner closed, is
 * dropped. The page is told to stop when the scan ends either way.
 */
export function openScan(on: (event: ScanEvent) => void): Scan {
  let state: "open" | "done" | "closed" = "open";
  let ready = false;
  let post: ((message: string) => void) | null = null;
  const stopPage = () => {
    try {
      post?.("stop");
    } catch (error) {
      console.warn("QR scan: the page could not be told to stop:", (error as Error)?.message || error);
    }
  };
  const end = (event: ScanEvent) => {
    state = "done";
    // The page released the camera before it spoke; said again in case it did not.
    stopPage();
    on(event);
  };
  const scan: Scan = {
    receive(data) {
      if (state !== "open") return;
      const event = readScanMessage(data);
      if (!event) return;
      if (event.type === "ready") {
        if (ready) return;
        ready = true;
        on(event);
        return;
      }
      end(event);
    },
    attach(next) {
      post = next;
      // Closed before the web view existed: its page is told as soon as it can be.
      if (state !== "open") stopPage();
    },
    fail(code) {
      if (state !== "open") return;
      end({ type: "error", code });
    },
    close() {
      if (state === "closed") return;
      state = "closed";
      stopPage();
    },
    state: () => state,
  };
  scanWatcher?.(scan);
  return scan;
}
