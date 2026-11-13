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
// `fetch` with `FormData` for uploads. There is no way to save a file, so that reports
// "unsupported" and the console explains it.
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
// replaces (morph.history), and Back (lib/systemBack.ts) goes to the one before, which reaches the
// router as the browser's back button does (morph.pop). Nothing to go back to at the first one:
// there the system takes Back and leaves the app. Not saved: the next launch starts with the last
// location alone.
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

/** Whether Back has a place in this run's history to go back to. */
export const canGoBack = () => depth() > 0;

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

/** The place Back goes to, or "" at the first one. */
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

function notifyCall(name: string, data: unknown = {}, fallback: unknown = null) {
  if (!nativeNotify) return Promise.resolve(fallback);
  return host.call(name, data, { timeout: 0 });
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
  if (nativeNotify) {
    // A pressed notification brought the app back: the console takes its topic.
    host.on("morph.notify.opened", (data: unknown) => emit("morph.notify.opened", data));
  }
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
    features: [
      "pickFile",
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
    picked = (await Picker.pickFiles({ multiple, filters: extensions.length ? [{ name: "Files", extensions }] : null })).map(({ file }) => file);
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
      throw new Error("Saving files is not available in the phone app yet.");
    default:
      throw new Error(`${name} is not available in the phone app`);
  }
}
