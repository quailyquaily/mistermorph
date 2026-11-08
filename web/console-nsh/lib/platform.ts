// Everything that differs between the browser, the desktop app and the phone app: the `morph.*`
// host contract. On the web, host.js (beside App.tsx) answers it inside the page; in the desktop
// app the GPUI shell in desktop/nsh answers it natively; in the phone app, which has no embedding
// app, lib/mobileHost.ts answers it inside the app. Pages never touch any of them directly: they use
// the functions below, and only this file knows a host exists.
import { Clipboard, host, locale, openUrl, platform } from "nsh";
import * as mobileHost from "./mobileHost";

/** The phone app: a client of a console server elsewhere, whose address the user enters. */
const MOBILE = platform.os === "android" || platform.os === "ios";
const hostChannel: { call: (name: string, data?: unknown, options?: { timeout?: number }) => Promise<unknown>; on: (name: string, listener: (data: unknown) => void) => () => void } =
  MOBILE ? { call: (name, data) => mobileHost.call(name, data), on: mobileHost.on } : host;

/** What the host tells the app before it mounts. */
export interface Boot {
  /** `"web"` in a browser, `"desktop"` inside the desktop app, `"mobile"` in the phone app. */
  runtime: "web" | "desktop" | "mobile";
  /** The console server's origin, without a trailing slash (`http://127.0.0.1:9080`). */
  origin: string;
  /** Where the console is mounted on that origin: `"/"` or `"/console"`. */
  basePath: string;
  /** Where the app opened, below the base path: path, query and hash (`/chat?x=1`). */
  location: string;
  /** Saved values (`localStorage` on the web, a file in the desktop app). */
  kv: Record<string, string>;
  /** Values that last for this tab or window. */
  session: Record<string, string>;
  /** The user's languages, best first. */
  languages: string[];
  /** The desktop app's version, `""` on the web. */
  desktopVersion: string;
  /** What the host can do beyond the basics (see `hasFeature`). */
  features: string[];
  /** Whether the browser treats the page as a secure context; absent from older hosts. */
  secureContext?: boolean;
}

let config: Boot = {
  runtime: "web",
  origin: "",
  basePath: "/",
  location: "/",
  kv: {},
  session: {},
  languages: ["en"],
  desktopVersion: "",
  features: [],
};

let hosted = false;

/** Reads the host's boot data; App.tsx mounts after it. Without a host (tests), defaults stay. */
export async function boot(overrides: Partial<Boot> = {}) {
  try {
    const answer = (await hostChannel.call("morph.boot")) as Partial<Boot>;
    config = { ...config, ...answer };
    hosted = true;
  } catch (error) {
    // `nsh test` without a host, or a host that does not speak morph.*: start empty.
    console.warn("no morph host; starting with defaults:", (error as Error)?.message || error);
    config = { ...config, languages: [locale()] };
  }
  config = { ...config, ...overrides };
  if (hosted) {
    hostChannel.on("morph.kv", (change: unknown) => {
      const { key, value } = (change || {}) as { key?: string; value?: string | null };
      if (!key) return;
      if (value === null || value === undefined) delete config.kv[key];
      else config.kv[key] = value;
      for (const listener of kvListeners) listener(key);
    });
  }
}

export const runtime = () => config.runtime;
export const isDesktop = () => config.runtime === "desktop";
/** The phone app, which reaches a console server at the address the user entered. */
export const isMobile = () => config.runtime === "mobile";
export const desktopVersion = () => config.desktopVersion;
export const languages = () => config.languages;
export const initialLocation = () => config.location || "/";
export const basePath = () => config.basePath || "/";
export const origin = () => config.origin;
/** The browser's `isSecureContext`, or null when the host did not report it. */
export const secureContext = (): boolean | null =>
  typeof config.secureContext === "boolean" ? config.secureContext : null;
/** Whether the host offers an optional feature: `notifications`, `pickDirectory`, `checkUpdate`, `restart`, `quit`, `openLog`, `saveFile`, `pickFile`. */
export const hasFeature = (name: string) => config.features.includes(name);

/* ---------- the server (phone app) ---------- */

/** The console server's address the phone app talks to, `""` before the user entered one. */
export const serverAddress = () => (isMobile() ? (mobileHost.parseServer(config.kv[mobileHost.SERVER_KEY] || "")?.address ?? "") : "");

/**
 * Points the phone app at another console server: saves the address and changes `origin()` and
 * `basePath()`. The caller re-reads them (`configureApiBase`) and drops the old server's session.
 * Returns the address as saved, or null when `raw` is no http(s) address.
 */
export function setServer(raw: string): string | null {
  const server = mobileHost.parseServer(raw);
  if (!server) return null;
  config = { ...config, origin: server.origin, basePath: server.basePath, secureContext: server.origin.startsWith("https:") };
  localStore.setItem(mobileHost.SERVER_KEY, server.address);
  return server.address;
}

/* ---------- saved values ---------- */

const kvListeners = new Set<(key: string) => void>();
/** Hears values another tab or window changed. */
export function onKvChange(listener: (key: string) => void) {
  kvListeners.add(listener);
  return () => {
    kvListeners.delete(listener);
  };
}

function persist(area: "local" | "session", key: string, value: string | null) {
  if (!hosted) return;
  void hostChannel.call("morph.kv.set", { area, key, value }).catch((error: Error) => {
    console.warn("could not save", key, error?.message);
  });
}

/** A synchronous store, written through to the host: the same shape as `localStorage`. */
function store(area: "local" | "session", values: () => Record<string, string>) {
  return {
    getItem: (key: string): string | null => values()[key] ?? null,
    setItem(key: string, value: string) {
      values()[key] = String(value);
      persist(area, key, String(value));
    },
    removeItem(key: string) {
      delete values()[key];
      persist(area, key, null);
    },
    keys: () => Object.keys(values()),
  };
}
/** What `localStorage` was to the Vue console. */
export const localStore = store("local", () => config.kv);
/** What `sessionStorage` was to the Vue console. */
export const sessionStore = store("session", () => config.session);

/* ---------- the address bar and the window ---------- */

/** Changes the address bar on the web; the desktop app keeps the location for its next launch. */
export function writeHistory(op: "push" | "replace", url: string) {
  if (hosted) void hostChannel.call("morph.history", { op, url }).catch(() => {});
}
/** Hears the browser's back and forward buttons. */
export function onHistoryPop(listener: (location: string) => void) {
  if (!hosted) return () => {};
  return hostChannel.on("morph.pop", (data: unknown) => listener(String((data as { location?: string })?.location || "/")));
}

/**
 * Whether the phone app has a place to go back to in this run (its own history: no browser keeps
 * one there). Always false on the web and the desktop, whose back buttons are the browser's.
 */
export const canGoBack = () => MOBILE && mobileHost.canGoBack();
/** Goes back a place in the phone app's history; the router hears it as `onHistoryPop`. False when it cannot. */
export function goBack(): boolean {
  return MOBILE ? mobileHost.goBack() : false;
}
/** Where `goBack` would go (path, query and hash), or "" when it cannot. */
export const previousLocation = () => (MOBILE ? mobileHost.previousEntry() : "");

export function setDocumentTitle(title: string) {
  if (hosted) void hostChannel.call("morph.title", { title }).catch(() => {});
}
export function setDocumentLanguage(language: string) {
  if (hosted) void hostChannel.call("morph.language", { language }).catch(() => {});
}

let visible = true;
let focused = true;
const visibilityListeners = new Set<() => void>();
/** Whether the page or window is shown and has focus (for notifications and polling). */
export const isVisible = () => visible;
export const hasFocus = () => focused;
export function onVisibilityChange(listener: () => void) {
  visibilityListeners.add(listener);
  return () => {
    visibilityListeners.delete(listener);
  };
}
export function startVisibilityTracking() {
  if (!hosted) return;
  hostChannel.on("morph.visibility", (data: unknown) => {
    const next = (data || {}) as { visible?: boolean; focused?: boolean };
    visible = next.visible !== false;
    focused = next.focused !== false;
    for (const listener of visibilityListeners) listener();
  });
}

/* ---------- links, clipboard, notifications ---------- */

/** Opens `url` outside the app: a new tab on the web, the system's browser on the desktop. */
export function openExternal(url: string) {
  void openUrl(url).catch((error: Error) => console.warn("could not open", url, error?.message));
}

export async function copyText(text: string) {
  await Clipboard.writeText(text);
}

export type NotificationPermission = "granted" | "denied" | "default" | "unsupported";

export async function notificationPermission(): Promise<NotificationPermission> {
  if (!hosted) return "unsupported";
  try {
    return (await hostChannel.call("morph.notify.state")) as NotificationPermission;
  } catch {
    return "unsupported";
  }
}
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!hosted) return "unsupported";
  return (await hostChannel.call("morph.notify.request", {}, { timeout: 0 })) as NotificationPermission;
}
export async function showNotification(options: { id: string; title: string; body: string; tag?: string }) {
  if (!hosted) return;
  await hostChannel.call("morph.notify.show", options);
}
/** Hears a press on a notification this app showed: its `id`. */
export function onNotificationPress(listener: (id: string) => void) {
  if (!hosted) return () => {};
  return hostChannel.on("morph.notify.press", (data: unknown) => listener(String((data as { id?: string })?.id || "")));
}

/* ---------- files ---------- */

/**
 * A file the user picked. Its bytes stay in the host (a browser cannot pass a `File` over the
 * host's JSON channel); upload it with `uploadFile`. `preview` is a URL an `Image` can show, or "".
 */
export interface PickedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  preview: string;
}

export interface UploadTarget {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Send as multipart form data under this field name; without it the body is the file. */
  field?: string;
  /** Extra form fields, with `field`. */
  fields?: Record<string, string>;
  /**
   * Send the picked image cropped, scaled and re-encoded instead of the file itself (an avatar
   * must be image/webp): the crop in the image's pixels, the size to draw it at, the type and
   * quality to encode. The host does it, since the app cannot read the file's pixels.
   */
  image?: {
    crop: { sx: number; sy: number; sw: number; sh: number };
    width: number;
    height: number;
    type: string;
    quality: number;
  };
}
export interface UploadResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

export async function pickFiles(options: { accept?: string; multiple?: boolean } = {}): Promise<PickedFile[]> {
  return (await hostChannel.call("morph.file.pick", options, { timeout: 0 })) as PickedFile[];
}

const progressListeners = new Map<string, (loaded: number, total: number) => void>();
let progressListening = false;

export async function uploadFile(
  file: PickedFile,
  target: UploadTarget,
  onProgress?: (loaded: number, total: number) => void,
): Promise<UploadResult> {
  if (onProgress) {
    if (!progressListening) {
      progressListening = true;
      hostChannel.on("morph.file.progress", (data: unknown) => {
        const { id, loaded, total } = (data || {}) as { id: string; loaded: number; total: number };
        progressListeners.get(id)?.(loaded, total);
      });
    }
    progressListeners.set(file.id, onProgress);
  }
  try {
    return (await hostChannel.call("morph.file.upload", { id: file.id, ...target }, { timeout: 0 })) as UploadResult;
  } finally {
    progressListeners.delete(file.id);
  }
}

export function releaseFile(file: PickedFile) {
  void hostChannel.call("morph.file.release", { id: file.id }).catch(() => {});
}

/** What to save: a URL the host downloads (with headers), or text or base64 bytes the app has. */
export interface SaveRequest {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  text?: string;
  base64?: string;
  type?: string;
}
/** Saves a file: a download on the web, a save dialog on the desktop. */
export async function saveFile(request: SaveRequest): Promise<"saved" | "cancelled"> {
  return (await hostChannel.call("morph.file.save", request, { timeout: 0 })) as "saved" | "cancelled";
}

/* ---------- desktop only ---------- */

/** The native folder picker: the chosen folder, or "" when the user cancels. */
export async function pickDirectory(options: { title?: string; current?: string } = {}): Promise<string> {
  const picked = await hostChannel.call("morph.desktop.pickDirectory", options, { timeout: 0 });
  return typeof picked === "string" ? picked : "";
}
/** Checks for a desktop update; `channel` null uses the saved setting. */
export async function checkDesktopUpdate(channel: string | null = null): Promise<unknown> {
  return await hostChannel.call("morph.desktop.checkUpdate", { channel }, { timeout: 0 });
}
/** Restarts the bundled backend (after setup or a settings change that needs it). */
export async function restartDesktopApp() {
  await hostChannel.call("morph.desktop.restart", {}, { timeout: 0 });
}
export async function quitDesktopApp() {
  await hostChannel.call("morph.desktop.quit");
}
export async function openDesktopLog() {
  await hostChannel.call("morph.desktop.openLog");
}
/** Tells the desktop shell the first screen is ready (it hides its splash). */
export function reportFrontendReady() {
  if (hosted) void hostChannel.call("morph.desktop.ready").catch(() => {});
}
