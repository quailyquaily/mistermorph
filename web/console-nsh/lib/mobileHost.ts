// The `morph.*` host contract (lib/platform.ts) answered inside the app, for the phone apps.
//
// On the web, host.js answers it around the page; in the desktop app the GPUI shell does. A packaged
// Android (or iOS) app has no embedding app to answer host calls, so the app answers them itself with
// nsh's own APIs. The phone app is a client: it talks to a `morph console serve` somewhere else,
// whose address the user enters on the login page (`setServer` in lib/platform.ts) and which is kept
// here with the other saved values.
//
// What nsh 0.5.0 offers on Android shapes what works: saved values (`Storage`), the app's state
// (`lifecycle`), the system's pickers (`Picker.pickImages`, the photo picker, for a gallery pick;
// `Picker.pickFiles`, the document picker (`ACTION_OPEN_DOCUMENT`), for files of any type) and
// `fetch` with `FormData` for uploads. nsh has no save dialog on Android (its save dialog is the
// desktops' alone, and `fs/promises` reaches only the app's own files), so saving comes from the
// app's native part too (below).
//
// nsh records no audio, so voice input comes from the app's own native part (android/src, built
// into the APK by scripts/build-android.sh): it answers `morph.voice.*` over nsh's host channel,
// records with the system's microphone (asking for it at the first recording) and sends the
// recording to the agent's /voice/transcribe itself. An APK without it has no voice input.
//
// nsh has no system notifications either, and the app's page (with the console's notification
// socket) is suspended in the background, so the native part also tells of finished tasks
// (`morph.notify.*`, android/src/.../TaskNotifier.java): it holds the notification permission, and
// while the app is away a system job reads the server's recent completions and shows them. The
// app configures it (`morph.notify.configure`: the server, the session, the texts) and takes the
// topic of a pressed notification (`morph.notify.take`). An APK without it has no notifications.
//
// Saving a file (`morph.file.save`: a received attachment, a workspace file, a log) is the native
// part's as well (android/src/.../FileSaver.java): it shows the system's picker for a new document
// (ACTION_CREATE_DOCUMENT, no storage permission) with the file's name, downloads the file from the
// console server with the session's headers into the chosen document, and answers "saved" once the
// bytes are written, "cancelled" when the user backed out. The app offers it (`saveFile`) only when
// the native part says the device has that picker; an APK without it, or another phone (iOS), says
// saving is not available. Only the console server's own URLs are given the session's headers.
//
// Whether a hardware keyboard is connected is the native part's to tell as well
// (`morph.keyboard.state`, android/src/.../HardwareKeyboard.java): nsh has no such state, and the
// console's keyboard shortcuts are on in the phone app only while one is known to be connected
// (lib/shortcutPolicy.ts). It is asked at boot and again whenever the app comes back to the front,
// and the native part tells of a keyboard connected or taken away (`morph.keyboard.changed`). An
// APK without the native part, the iOS app, an answer that is not understood or a call that fails
// all leave it "unknown", which is never "connected". Nothing else is taken for a keyboard: not a
// key that arrives, not the software keyboard staying hidden.
//
// A pasted image the runtime could not read is the native part's to tell too (`morph.paste.refused`,
// android/src/com/longbridge/nsh/InputBox.java, nsh 0.6.0's field patched): an image larger than an
// upload takes (128 MiB) is not read past that, nor a paste's images past 256 MiB together, and one
// whose content URI cannot be read (an expired grant, a failing provider) no longer goes by with a
// log line. Only the reason and how many are told.
import { effect, host, lifecycle, locale, Picker, signal, Storage, untracked } from "nsh";

/** The saved address of the console server, `https://host[:port][/base]`. */
export const SERVER_KEY = "mistermorph_console_server_v1";
/** Where the app was, reopened on the next launch (as the desktop app does). */
const LOCATION_KEY = "mistermorph_console_mobile_location_v1";

type Listener = (data: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(name: string, data: unknown) {
  for (const listener of listeners.get(name) ?? []) listener(data);
}

/** The same shape as nsh's `host.on`: listens until the returned function is called. */
export function on(name: string, listener: Listener): () => void {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/**
 * Splits a server address the user typed into the console's origin and base path, or null when it
 * is not one. Without a scheme, an IP address, `localhost` or an address with a port is taken as
 * `http://` (a console on the local network), anything else as `https://`.
 */
export function parseServer(raw: string): { origin: string; basePath: string; address: string } | null {
  let text = String(raw || "").trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/?#]/)[0];
    const local = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(host) || /:\d+$/.test(host);
    text = `${local ? "http" : "https"}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  let basePath = url.pathname.replace(/\/+/g, "/").replace(/\/+$/, "");
  if (basePath === "") basePath = "/";
  const origin = `${url.protocol}//${url.host}`;
  return { origin, basePath, address: basePath === "/" ? origin : `${origin}${basePath}` };
}

let kv: Record<string, string> = {};
const session: Record<string, string> = {};
let location = "/";

// The places the app went through in this run, as a browser tab keeps them: the router pushes and
// replaces (morph.history). A page's own back may go to the one before (`goBack`, which reaches
// the router as the browser's back button does, morph.pop) or replace itself with it; Android's
// Back never walks them by itself (lib/systemBack.ts: a page without a back action takes none,
// and the system leaves the app). Not saved: the next launch starts with the last location alone.
let entries: string[] = [];
const depth = signal(0);

function writeEntry(op: string, url: string) {
  const index = untracked(depth);
  if (entries.length === 0) {
    entries = [url];
  } else if (op === "push") {
    // Opening where the app already is adds nothing to go back through.
    if (entries[index] !== url) entries = [...entries.slice(0, index + 1), url];
  } else if (index > 0 && entries[index - 1] === url) {
    // Replacing a place with the one before it (a page's own back arrow) is going back to it.
    entries = entries.slice(0, index);
  } else {
    entries = [...entries.slice(0, index), url];
  }
  depth.set(entries.length - 1);
}

/** Goes back one place: the router hears it as a browser's back. False at the first place. */
export function goBack(): boolean {
  const index = untracked(depth);
  if (index <= 0) return false;
  depth.set(index - 1);
  // The place to reopen at the next launch follows, as the address bar does on the web.
  location = entries[index - 1];
  void kvSet({ area: "local", key: LOCATION_KEY, value: location });
  emit("morph.pop", { location });
  return true;
}

/** The place before this one, or "" at the first one. */
export function previousEntry(): string {
  const index = untracked(depth);
  return index > 0 ? entries[index - 1] : "";
}

// Files the user picked: their bytes stay here, as on the web (a File cannot cross the JSON contract),
// with the preview URL made for an image, which is this host's to revoke when the file is released.
const files = new Map<string, { file: File; preview: string }>();
let nextFileID = 1;

/* ---------- voice input (the native part) ---------- */

// Whether the native part answers: asked once at boot.
let nativeVoice = false;
// The recordings the native part keeps, by id: uploaded and released there.
const voiceFiles = new Set<string>();

async function probeVoice(): Promise<boolean> {
  try {
    await host.call("morph.voice.support", {});
    return true;
  } catch (error) {
    // No handler: an APK `nsh package` built alone, or a test without the native part.
    console.warn("voice input: no native recorder in this app:", (error as Error)?.message || error);
    return false;
  }
}

function voiceCall(name: string, data: unknown = {}) {
  if (!nativeVoice) return Promise.reject(new Error("Voice input is not available in this build of the phone app."));
  return host.call(name, data, { timeout: 0 });
}

/** Ends whatever the native part records or sends, and tells the console (`morph.voice.ended`). */
function endVoice(reason: string) {
  voiceFiles.clear();
  void voiceCall("morph.voice.cancel").catch((error: Error) => console.warn("voice input: cancel failed:", error?.message || error));
  emit("morph.voice.ended", { reason });
}

async function voiceStop() {
  const file = (await voiceCall("morph.voice.stop")) as { id?: string; name?: string; size?: number; type?: string } | null;
  if (!file?.id) return null;
  voiceFiles.add(file.id);
  return { id: file.id, name: String(file.name || "voice.m4a"), size: Number(file.size) || 0, type: String(file.type || "audio/mp4"), preview: "" };
}

async function voiceUpload(data: { id: string; url: string; method?: string; headers?: Record<string, string>; field?: string; fields?: Record<string, string> }) {
  try {
    const result = (await voiceCall("morph.voice.upload", {
      id: data.id,
      url: data.url,
      method: data.method || "POST",
      headers: data.headers ?? {},
      field: data.field || "",
      fields: data.fields ?? {},
    })) as { ok?: boolean; status?: number; statusText?: string; body?: string };
    return { ok: result?.ok === true, status: Number(result?.status) || 0, statusText: String(result?.statusText || ""), body: String(result?.body ?? "") };
  } finally {
    // The native part deletes a recording once its upload ended.
    voiceFiles.delete(data.id);
  }
}

function voiceRelease(id: string) {
  voiceFiles.delete(id);
  return voiceCall("morph.voice.release", { id }).then(() => null);
}

/* ---------- task notifications (the native part) ---------- */

// Whether the native part answers `morph.notify.*`: asked once at boot.
let nativeNotify = false;

async function probeNotify(): Promise<boolean> {
  try {
    await host.call("morph.notify.state", {});
    return true;
  } catch (error) {
    console.warn("notifications: none in this app:", (error as Error)?.message || error);
    return false;
  }
}

/**
 * The installed app's version name and code as Android has them (`morph.shell.info`, answered by
 * the native part: MorphApplication), or null without the native part (an APK `nsh package` built
 * alone, a test, the iOS app): then the app's version is unknown.
 */
async function probeShell(): Promise<{ version: string; build: string } | null> {
  try {
    const info = (await host.call("morph.shell.info", {})) as { version?: unknown; build?: unknown } | null;
    return { version: String(info?.version ?? "").trim(), build: String(info?.build ?? "").trim() };
  } catch (error) {
    console.warn("app version: no native part in this app:", (error as Error)?.message || error);
    return null;
  }
}

function notifyCall(name: string, data: unknown = {}, fallback: unknown = null) {
  if (!nativeNotify) return Promise.resolve(fallback);
  return host.call(name, data, { timeout: 0 });
}

/* ---------- the hardware keyboard (the native part) ---------- */

/** What the native part knows of a hardware keyboard; "unknown" when it does not say (or is not there). */
export type PhysicalKeyboard = "connected" | "disconnected" | "unknown";

/** The native part's answer or event (`{ physical }`) as a state: anything not understood is "unknown". */
export function physicalKeyboardFrom(answer: unknown): PhysicalKeyboard {
  const physical = answer && typeof answer === "object" ? (answer as { physical?: unknown }).physical : undefined;
  return physical === "connected" || physical === "disconnected" ? physical : "unknown";
}

const keyboard = signal<PhysicalKeyboard>("unknown");
// Whether the native part answers `morph.keyboard.state`: asked once at boot.
let nativeKeyboard = false;
// Counts what was learned (answers asked for and the native part's events): an answer that comes
// back after something newer was learned is dropped.
let keyboardNews = 0;

/** Whether a hardware keyboard is connected to the phone or tablet, as the native part last said (a signal). */
export const physicalKeyboard = () => keyboard();

/**
 * Asks the native part and takes its answer, unless something newer was learned meanwhile. A call
 * that fails leaves the state "unknown". Returns whether the native part answered at all: without
 * one (an APK `nsh package` built alone, iOS, a test without the native part) nothing is asked again.
 */
async function askKeyboard(): Promise<boolean> {
  const news = ++keyboardNews;
  let next: PhysicalKeyboard = "unknown";
  let answered = false;
  try {
    next = physicalKeyboardFrom(await host.call("morph.keyboard.state", {}));
    answered = true;
  } catch (error) {
    console.warn("hardware keyboard: unknown, the native part did not answer:", (error as Error)?.message || error);
  }
  if (news === keyboardNews) keyboard.set(next);
  return answered;
}

/* ---------- saving files (the native part) ---------- */

// Whether the native part saves files on this device: asked once at boot.
let nativeSave = false;

/** What a phone without the native part's saving says when asked to save. */
export const SAVE_UNAVAILABLE = "Saving files is not available in this build of the phone app.";

async function probeSave(): Promise<boolean> {
  try {
    const reason = await host.call("morph.file.saveSupport", {});
    if (reason === "") return true;
    console.warn("saving files: not on this device:", reason);
    return false;
  } catch (error) {
    // No handler: an APK `nsh package` built alone, iOS, or a test without the native part.
    console.warn("saving files: no native part in this app:", (error as Error)?.message || error);
    return false;
  }
}

/**
 * The native part's request for `morph.file.save`'s: a name and text or base64 the app has, or a URL
 * on the console server `server` (an origin) with the headers to fetch it with. A URL anywhere
 * else is refused: the session's headers go to the console server alone.
 */
export function nativeSaveRequest(
  data: { name?: unknown; url?: unknown; headers?: unknown; text?: unknown; base64?: unknown; type?: unknown },
  server: string,
): Record<string, unknown> {
  const name = String(data?.name ?? "").trim() || "download";
  const type = typeof data?.type === "string" && data.type ? data.type : "application/octet-stream";
  if (typeof data?.text === "string") return { name, text: data.text, type };
  if (typeof data?.base64 === "string") return { name, base64: data.base64, type };
  const raw = String(data?.url ?? "");
  if (!raw) throw new Error("Nothing to save.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The file's address is not a URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !server || url.origin !== server) {
    throw new Error("The file is not on this console server.");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries((data?.headers ?? {}) as Record<string, unknown>)) {
    if (value !== undefined && value !== null) headers[key] = String(value);
  }
  return { name, url: url.href, headers, type };
}

async function save(data: Record<string, unknown>): Promise<"saved" | "cancelled"> {
  if (!nativeSave) throw new Error(SAVE_UNAVAILABLE);
  const request = nativeSaveRequest(data, parseServer(kv[SERVER_KEY] || "")?.origin ?? "");
  // The picker waits for the user and the download for the server: no timeout.
  const answer = await host.call("morph.file.save", request, { timeout: 0 });
  if (answer === "saved" || answer === "cancelled") return answer;
  throw new Error("The file could not be saved.");
}

async function bootData() {
  const keys = await Storage.keys().catch(() => [] as string[]);
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = await Storage.getItem(key).catch(() => null);
    if (value !== null) values[key] = value;
  }
  kv = values;
  location = kv[LOCATION_KEY] || "/";
  const server = parseServer(kv[SERVER_KEY] || "");
  nativeVoice = await probeVoice();
  nativeNotify = await probeNotify();
  nativeSave = await probeSave();
  const shell = await probeShell();
  nativeKeyboard = await askKeyboard();
  if (nativeKeyboard) {
    // A keyboard was connected or taken away while the app runs.
    host.on("morph.keyboard.changed", (data: unknown) => {
      keyboardNews += 1;
      keyboard.set(physicalKeyboardFrom(data));
    });
  }
  let wasActive = untracked(lifecycle) === "active";
  if (nativeNotify) {
    // A pressed notification brought the app back: the console takes its topic.
    host.on("morph.notify.opened", (data: unknown) => emit("morph.notify.opened", data));
  }
  // Pasted images the native part's runtime could not read (android/src/.../InputBox.java). An
  // APK without the native part, or the iOS app, never sends it.
  host.on("morph.paste.refused", (data: unknown) => emit("morph.paste.refused", data));
  if (nativeVoice) {
    // The native part ended a recording by itself: the app left the foreground, or the recorder failed.
    host.on("morph.voice.ended", (data: unknown) => {
      voiceFiles.clear();
      emit("morph.voice.ended", data);
    });
  }
  // The app's state is the window's visibility: in front and taking input, or not.
  effect(() => {
    const state = lifecycle();
    emit("morph.visibility", { visible: state !== "background", focused: state === "active" });
    // Nothing records in the background: the native part stops when the activity does, and the
    // app ends its side here too. (A permission question only makes the app "inactive".)
    if (state === "background" && nativeVoice) untracked(() => endVoice("background"));
    // Back in front: a keyboard may have come or gone meanwhile. The last state holds until the
    // native part answers (a failed answer is "unknown").
    const active = state === "active";
    if (active && !wasActive && nativeKeyboard) void askKeyboard();
    wasActive = active;
  });
  return {
    runtime: "mobile",
    origin: server?.origin ?? "",
    basePath: server?.basePath ?? "/",
    location,
    kv: { ...kv },
    session: { ...session },
    languages: [locale()],
    desktopVersion: "",
    shell,
    features: [
      "pickFile",
      ...(nativeSave ? ["saveFile"] : []),
      ...(nativeVoice ? ["voiceRecord"] : []),
      ...(nativeNotify ? ["backgroundTaskNotifications"] : []),
    ],
    secureContext: server ? server.origin.startsWith("https:") : null,
  };
}

function kvSet(data: { area?: string; key?: string; value?: string | null }) {
  const key = String(data?.key || "");
  if (!key) return null;
  const value = data.value;
  if (data.area === "session") {
    if (value === null || value === undefined) delete session[key];
    else session[key] = String(value);
    return null;
  }
  if (value === null || value === undefined) {
    delete kv[key];
    return Storage.removeItem(key).then(() => null);
  }
  kv[key] = String(value);
  return Storage.setItem(key, String(value)).then(() => null);
}

/** Whether `accept` (a file input's) asks for images alone: `image/*`, image types or image extensions. */
export function acceptsImagesOnly(accept: string): boolean {
  const parts = String(accept || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => part.startsWith("image/") || /^\.(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/.test(part));
}

/** The extensions of `accept` for the document picker's filter (its MIME types it cannot take). */
function acceptExtensions(accept: string): string[] {
  return String(accept || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => /^\.[a-z0-9]+$/.test(part))
    .map((part) => part.slice(1));
}

/** Which of nsh's pickers answers a pick: the photo picker for a gallery pick or images alone, else the document picker. */
export function pickerFor(options: { accept?: string; source?: string }): "images" | "files" {
  if (options?.source === "gallery") return "images";
  if (options?.source === "files") return "files";
  return acceptsImagesOnly(String(options?.accept || "")) ? "images" : "files";
}

const PREVIEW_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;

async function pick(options: { accept?: string; multiple?: boolean; source?: string }) {
  const multiple = Boolean(options?.multiple);
  let picked: File[];
  if (pickerFor(options) === "images") {
    picked = (await Picker.pickImages({ multiple, format: "compatible" })).map(({ file }) => file);
  } else {
    const extensions = acceptExtensions(String(options?.accept || ""));
    // A file over 512 MiB comes back unread (nsh 0.6: `file` null, `status` "tooLarge"); it is left out.
    picked = (await Picker.pickFiles({ multiple, filters: extensions.length ? [{ name: "Files", extensions }] : null }))
      .map(({ file }) => file)
      .filter((file): file is File => file !== null);
  }
  return picked.map((file) => {
    const id = `m${nextFileID++}`;
    let preview = "";
    // An image the console may show before it is sent (SVG is never shown as an image).
    if (PREVIEW_TYPES.test(String(file.type || ""))) {
      try {
        preview = URL.createObjectURL(file);
      } catch {
        // No preview: the console shows the file's name.
      }
    }
    files.set(id, { file, preview });
    return { id, name: file.name, size: file.size, type: file.type, preview };
  });
}

async function upload(data: {
  id: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  field?: string;
  fields?: Record<string, string>;
  image?: unknown;
}) {
  const file = files.get(String(data?.id || ""))?.file;
  if (!file) throw new Error("The picked file is no longer available.");
  if (data.image) {
    // Avatars are cropped and re-encoded as WebP by the host; the phone app cannot read pixels.
    throw new Error("Changing images is not available in the phone app yet.");
  }
  let body: BodyInit = file;
  if (data.field) {
    const form = new FormData();
    for (const [name, value] of Object.entries(data.fields ?? {})) form.append(name, value);
    form.append(data.field, file, file.name);
    body = form;
  }
  const response = await fetch(data.url, { method: data.method || "POST", headers: data.headers ?? {}, body });
  // fetch reports no upload progress here: the whole file at once, when it is sent.
  emit("morph.file.progress", { id: data.id, loaded: file.size, total: file.size });
  return { ok: response.ok, status: response.status, statusText: response.statusText, body: await response.text() };
}

function release(data: { id?: string }) {
  const id = String(data?.id || "");
  const entry = files.get(id);
  files.delete(id);
  // The preview was this host's: nothing shows it once the console let the file go.
  if (entry?.preview) {
    try {
      URL.revokeObjectURL(entry.preview);
    } catch {
      // Already gone.
    }
  }
  return null;
}

/** The same shape as nsh's `host.call`. */
export async function call(name: string, data?: unknown): Promise<unknown> {
  const args = (data ?? {}) as any;
  switch (name) {
    case "morph.boot":
      return bootData();
    case "morph.kv.set":
      return kvSet(args);
    case "morph.history":
      location = String(args.url || "/");
      writeEntry(String(args.op || "push"), location);
      return kvSet({ area: "local", key: LOCATION_KEY, value: location });
    case "morph.title":
    case "morph.themeColor":
    case "morph.favicon":
    case "morph.language":
    case "morph.desktop.ready":
      return null;
    case "morph.notify.state":
      return notifyCall("morph.notify.state", {}, "unsupported");
    case "morph.notify.request":
      return notifyCall("morph.notify.request", {}, "unsupported");
    case "morph.notify.show":
      // Task completions are the native part's to show (it watches while the app is away);
      // nothing else notifies in the phone app yet.
      return null;
    case "morph.notify.configure":
      return notifyCall("morph.notify.configure", args);
    case "morph.notify.take":
      return notifyCall("morph.notify.take");
    case "morph.file.pick":
      return pick(args);
    case "morph.file.upload":
      return voiceFiles.has(String(args.id || "")) ? voiceUpload(args) : upload(args);
    case "morph.file.release":
      return voiceFiles.has(String(args.id || "")) ? voiceRelease(String(args.id)) : release(args);
    case "morph.voice.support":
      return nativeVoice ? voiceCall("morph.voice.support").then((reason) => String(reason ?? "")) : "unsupported";
    case "morph.voice.start":
      return voiceCall("morph.voice.start", {});
    case "morph.voice.stop":
      return voiceStop();
    case "morph.voice.cancel":
      voiceFiles.clear();
      return voiceCall("morph.voice.cancel").then(() => null);
    case "morph.file.save":
      return save(args);
    default:
      throw new Error(`${name} is not available in the phone app`);
  }
}
