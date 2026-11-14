// The web implementation of the `morph.*` host contract (see lib/platform.ts). It runs in the
// page itself, around the frame the app draws in, so the browser-only parts live here: the
// address bar, localStorage, file inputs, downloads, system notifications and the tab's icon.
const KV_PREFIXES = ["mistermorph", "quail-language"];

function keep(key) {
  return KV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function readStore(storage) {
  const values = {};
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && keep(key)) values[key] = storage.getItem(key);
    }
  } catch {
    // Storage can be disabled; the app then starts empty.
  }
  return values;
}

// The console's mount point on this origin, which the Go server writes into the page.
function basePath() {
  const meta = document.querySelector('meta[name="mistermorph-base-path"]');
  let value = (meta && meta.getAttribute("content")) || "";
  if (!value || value.includes("__MISTERMORPH_BASE_PATH__")) return "/";
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/+/g, "/").replace(/\/+$/, "");
  return value || "/";
}

// Where the app opened, below the base path.
function appLocation() {
  const base = basePath();
  let path = location.pathname;
  if (base !== "/" && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length) || "/";
  return `${path}${location.search}${location.hash}`;
}

function pageURL(url) {
  const base = basePath();
  return base === "/" ? url : `${base}${url.startsWith("/") ? url : `/${url}`}`;
}

// Files stay here: a File cannot cross the host's JSON channel.
const files = new Map();
let nextFileID = 1;

function pickFiles({ accept = "", multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    document.body.append(input);
    const finish = (list) => {
      input.remove();
      resolve(
        list.map((file) => {
          const id = String(nextFileID++);
          const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : "";
          files.set(id, { file, preview });
          return { id, name: file.name, size: file.size, type: file.type, preview };
        }),
      );
    };
    input.addEventListener("change", () => finish([...(input.files || [])]), { once: true });
    input.addEventListener("cancel", () => finish([]), { once: true });
    input.click();
  });
}

// Crops, scales and re-encodes a picked image (an avatar must be image/webp).
async function encodeImage(file, image) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  const { sx, sy, sw, sh } = image.crop;
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, image.width, image.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, image.type, image.quality));
  if (!blob) throw new Error(`this browser cannot encode ${image.type}`);
  return new File([blob], file.name.replace(/\.[^.]*$/, "") + extensionOf(image.type), { type: image.type });
}

function extensionOf(type) {
  const sub = String(type || "").split("/")[1] || "bin";
  return `.${sub === "jpeg" ? "jpg" : sub}`;
}

// XMLHttpRequest, as fetch reports no upload progress.
async function uploadFile(player, { id, url, method = "POST", headers = {}, field = "", fields = {}, image = null }) {
  const entry = files.get(id);
  if (!entry) throw new Error("the file is gone");
  const body = image ? await encodeImage(entry.file, image) : entry.file;
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.addEventListener("progress", (event) => {
      player.hostEvent("morph.file.progress", { id, loaded: event.loaded, total: event.total });
    });
    request.addEventListener("load", () =>
      resolve({
        ok: request.status >= 200 && request.status < 300,
        status: request.status,
        statusText: request.statusText,
        body: request.responseText,
      }),
    );
    request.addEventListener("error", () => reject(new Error("upload failed")));
    request.addEventListener("abort", () => reject(new Error("upload aborted")));
    if (field) {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.append(name, value);
      form.append(field, body, body.name);
      request.send(form);
    } else {
      request.send(body);
    }
  });
}

function base64Bytes(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function saveFile({ name, url, headers = {}, text, base64, type = "application/octet-stream" }) {
  let blob;
  if (typeof text === "string") blob = new Blob([text], { type });
  else if (typeof base64 === "string") blob = new Blob([base64Bytes(base64)], { type });
  else if (url) {
    const response = await fetch(url, { headers, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await response.blob();
  } else {
    throw new Error("nothing to save");
  }
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name || "download";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  return "saved";
}

function notificationState() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

// Voice input. nsh records no audio on the web, so the page does it: the microphone through
// MediaRecorder, kept as a file the app uploads to the agent's /voice/transcribe (the Vue
// console's useVoiceInput), and, where the browser has speech recognition, a live preview of the
// words sent as morph.voice.preview events. Calls answer with results rather than throwing, so the
// app gets the browser's error name (NotAllowedError, NotFoundError, ...) to explain.

// Formats the transcription APIs read, in order of preference.
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
// Speech recognition errors that will not go away by restarting it.
const PREVIEW_FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "network"]);
// Speech recognition stops by itself after a pause; it restarts this many times in a row without
// hearing anything before the preview gives up.
const PREVIEW_MAX_IDLE_RESTARTS = 3;

// Why this page cannot record: "" when it can, "insecure" (browsers only open the microphone on
// HTTPS or localhost) or "unsupported".
function voiceSupport() {
  if (window.isSecureContext === false) return "insecure";
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return "unsupported";
  return "";
}

function recordingType() {
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

function recordingExtension(type) {
  const base = String(type || "").split(";")[0];
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/ogg") return "ogg";
  return "webm";
}

function createVoiceRecorder(player) {
  // The recording under way: { stream, recorder, chunks, type, recognition }.
  let current = null;
  // Set while the browser asks for the microphone, so a second start does not open another stream.
  let starting = false;

  function startPreview(rec, lang) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;
    const separator = /^(ja|zh|ko|th)\b/i.test(lang) ? "" : " ";
    let done = "";
    let session = "";
    let idleRestarts = 0;
    let failed = false;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    if (lang) recognition.lang = lang;
    recognition.onresult = (event) => {
      idleRestarts = 0;
      let text = "";
      for (let i = 0; i < event.results.length; i += 1) text += event.results[i]?.[0]?.transcript || "";
      session = text.trim();
      if (current === rec) player.hostEvent("morph.voice.preview", { text: [done, session].filter(Boolean).join(separator) });
    };
    recognition.onerror = (event) => {
      if (PREVIEW_FATAL_ERRORS.has(event?.error)) failed = true;
    };
    recognition.onend = () => {
      done = [done, session].filter(Boolean).join(separator);
      session = "";
      if (current !== rec || failed || idleRestarts >= PREVIEW_MAX_IDLE_RESTARTS) return;
      idleRestarts += 1;
      try {
        recognition.start();
      } catch {
        // The preview is a convenience; the recording goes on without it.
      }
    };
    rec.recognition = recognition;
    try {
      recognition.start();
    } catch {
      rec.recognition = null;
    }
  }

  function release(rec) {
    try {
      rec.recognition?.abort();
    } catch {
      // Already stopped.
    }
    rec.recognition = null;
    for (const track of rec.stream.getTracks()) track.stop();
  }

  return {
    support: () => voiceSupport(),
    async start({ preview = true, lang = "" } = {}) {
      const reason = voiceSupport();
      if (reason) return { ok: false, error: reason };
      if (current || starting) return { ok: false, error: "busy" };
      starting = true;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        return { ok: false, error: error?.name || "failed", message: String(error?.message || "") };
      } finally {
        starting = false;
      }
      const type = recordingType();
      let recorder;
      try {
        recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      } catch (error) {
        for (const track of stream.getTracks()) track.stop();
        return { ok: false, error: error?.name || "NotSupportedError", message: String(error?.message || "") };
      }
      const rec = { stream, recorder, chunks: [], type: recorder.mimeType || type, recognition: null };
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) rec.chunks.push(event.data);
      });
      current = rec;
      recorder.start();
      if (preview) startPreview(rec, lang || navigator.language || "");
      return { ok: true };
    },
    // Stops and keeps the recording as a file for morph.file.upload; null when nothing was recorded.
    stop() {
      const rec = current;
      if (!rec) return null;
      current = null;
      return new Promise((resolve) => {
        rec.recorder.addEventListener(
          "stop",
          () => {
            release(rec);
            const blob = new Blob(rec.chunks, { type: rec.type || "audio/webm" });
            if (!blob.size) {
              resolve(null);
              return;
            }
            const file = new File([blob], `voice.${recordingExtension(rec.type)}`, { type: blob.type });
            const id = String(nextFileID++);
            files.set(id, { file, preview: "" });
            resolve({ id, name: file.name, size: file.size, type: file.type, preview: "" });
          },
          { once: true },
        );
        try {
          rec.recorder.stop();
        } catch {
          release(rec);
          resolve(null);
        }
      });
    },
    cancel() {
      const rec = current;
      if (!rec) return;
      current = null;
      try {
        rec.recorder.stop();
      } catch {
        // Already stopped.
      }
      release(rec);
    },
  };
}

// The tab's icon (morph.favicon): the selected agent's avatar, drawn round on a small square, or
// the app icon the build wrote into index.html. The app runs in a same-origin frame, so the page
// loads the `blob:` URLs it makes (and the server's `data:` URLs) as they are; the drawn icon is a
// `data:` URL, so the page makes no object URLs of its own to release.
const FAVICON_SIZE = 32;

/** The link elements that give the page's icon (`rel="icon"`, not `apple-touch-icon`). */
function iconLinks(head) {
  return [...head.querySelectorAll("link")].filter((link) =>
    String(link.getAttribute("rel") || "").toLowerCase().split(/\s+/).includes("icon"),
  );
}

/** "anonymous" for an image on another origin (a canvas can only read it with CORS), else null. */
function crossOriginFor(url, pageOrigin) {
  try {
    const parsed = new URL(url, pageOrigin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin === pageOrigin ? null : "anonymous";
  } catch {
    return null;
  }
}

function loadFaviconImage(url, crossOrigin) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (crossOrigin) image.crossOrigin = crossOrigin;
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`could not load ${url.slice(0, 64)}`));
    image.src = url;
  });
}

/** The image cropped to its centre square, scaled to `size` and cut round: a PNG `data:` URL. */
export function drawFavicon(image, size = FAVICON_SIZE, makeCanvas = () => document.createElement("canvas")) {
  const canvas = makeCanvas();
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d canvas");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  context.closePath();
  context.clip();
  const width = Number(image.naturalWidth || image.width) || 0;
  const height = Number(image.naturalHeight || image.height) || 0;
  if (width > 0 && height > 0) {
    const side = Math.min(width, height);
    context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
  } else {
    // An SVG without a size of its own: it scales to fit.
    context.drawImage(image, 0, 0, size, size);
  }
  // Throws on a canvas the image tainted (another origin without CORS).
  return canvas.toDataURL("image/png");
}

/**
 * Keeps the page's icon. `show(url)` loads the avatar at `url` and puts it in place of the app
 * icon; "" puts the app icon back, as do a load in progress and an image that fails. Only the
 * latest call counts: an older load that ends later changes nothing. The app icon's own link
 * elements are kept and put back as they were.
 */
export function createFavicon({
  document: doc = globalThis.document,
  pageOrigin = globalThis.location?.origin || "",
  loadImage = loadFaviconImage,
  draw = (image) => drawFavicon(image),
} = {}) {
  let originals = null;
  let placeholder = null;
  let avatarLink = null;
  let seq = 0;

  function capture() {
    if (originals) return;
    originals = iconLinks(doc.head);
    // Marks where the app icon's links were, to put them back in the same place.
    placeholder = doc.createComment("morph.favicon");
    if (originals[0]) originals[0].before(placeholder);
    else doc.head.append(placeholder);
  }

  function restore() {
    if (!avatarLink) return;
    for (const link of originals) placeholder.before(link);
    avatarLink.remove();
    avatarLink = null;
  }

  function put(href) {
    if (!avatarLink) {
      avatarLink = doc.createElement("link");
      avatarLink.setAttribute("rel", "icon");
      avatarLink.setAttribute("data-morph-favicon", "");
      placeholder.before(avatarLink);
      for (const link of originals) link.remove();
    }
    // A link of its own every time: browsers notice a new element more reliably than a new href.
    const next = avatarLink.cloneNode(false);
    const drawn = href.startsWith("data:image/png");
    if (drawn) {
      next.setAttribute("type", "image/png");
      next.setAttribute("sizes", `${FAVICON_SIZE}x${FAVICON_SIZE}`);
    } else {
      next.removeAttribute("type");
      next.removeAttribute("sizes");
    }
    next.setAttribute("href", href);
    avatarLink.replaceWith(next);
    avatarLink = next;
  }

  async function iconFor(url) {
    const crossOrigin = crossOriginFor(url, pageOrigin);
    let image;
    try {
      image = await loadImage(url, crossOrigin);
    } catch (error) {
      if (!crossOrigin) throw error;
      // Another origin without CORS: the browser can still show it, unround.
      await loadImage(url, null);
      return url;
    }
    try {
      return draw(image);
    } catch {
      // The image loads but cannot be drawn here: the browser shows it as it is.
      return url;
    }
  }

  return {
    /** What the tab shows now: "app" or the avatar link's href. */
    current: () => (avatarLink ? String(avatarLink.getAttribute("href") || "") : "app"),
    async show(url) {
      capture();
      const id = (seq += 1);
      const source = String(url || "").trim();
      // The app icon while the avatar loads, never the previous agent's.
      restore();
      if (!source) return "app";
      try {
        const href = await iconFor(source);
        if (id !== seq) return "stale";
        put(href);
        return "avatar";
      } catch (error) {
        if (id !== seq) return "stale";
        restore();
        console.warn("favicon:", error?.message || error);
        return "app";
      }
    },
  };
}

/**
 * What the browser says about the machine, for the Updates card's download (lib/downloadTarget.ts
 * reads it): the user agent, `navigator.platform`, and where the browser has client hints, its
 * platform and processor. Nothing is guessed here.
 */
export async function clientPlatform(nav = globalThis.navigator) {
  const hints = nav?.userAgentData;
  const info = {
    userAgent: String(nav?.userAgent || ""),
    platform: String(nav?.platform || ""),
    uaPlatform: String(hints?.platform || ""),
    maxTouchPoints: Number(nav?.maxTouchPoints || 0),
    architecture: "",
    bitness: "",
  };
  if (typeof hints?.getHighEntropyValues === "function") {
    try {
      const values = await hints.getHighEntropyValues(["architecture", "bitness"]);
      info.architecture = String(values?.architecture || "");
      info.bitness = String(values?.bitness || "");
    } catch {
      // The browser keeps them to itself: the architecture stays unknown.
    }
  }
  return info;
}

export function createHost(player) {
  const notifications = new Map();
  const voice = createVoiceRecorder(player);
  const favicon = createFavicon();
  const sendVisibility = () =>
    player.hostEvent("morph.visibility", { visible: document.visibilityState === "visible", focused: document.hasFocus() });

  addEventListener("popstate", () => player.hostEvent("morph.pop", { location: appLocation() }));
  addEventListener("storage", (event) => {
    if (event.storageArea === localStorage && event.key && keep(event.key)) {
      player.hostEvent("morph.kv", { key: event.key, value: event.newValue });
    }
  });
  document.addEventListener("visibilitychange", sendVisibility);
  addEventListener("focus", sendVisibility);
  addEventListener("blur", sendVisibility);

  const functions = new Map([
    [
      "morph.boot",
      () => ({
        runtime: "web",
        origin: location.origin,
        basePath: basePath(),
        location: appLocation(),
        kv: readStore(localStorage),
        session: readStore(sessionStorage),
        languages: [...(navigator.languages || [navigator.language || "en"])],
        desktopVersion: "",
        secureContext: window.isSecureContext,
        features: ["pickFile", "saveFile", "voiceRecord", "voicePreview", ...(typeof Notification === "undefined" ? [] : ["notifications"])],
      }),
    ],
    [
      "morph.kv.set",
      ({ area, key, value }) => {
        const storage = area === "session" ? sessionStorage : localStorage;
        try {
          if (value === null || value === undefined) storage.removeItem(key);
          else storage.setItem(key, value);
        } catch {
          // The value stays in the app's memory for this load.
        }
      },
    ],
    [
      "morph.history",
      ({ op, url }) => {
        const target = pageURL(url);
        if (target === `${location.pathname}${location.search}${location.hash}`) return;
        history[op === "replace" ? "replaceState" : "pushState"]({}, "", target);
      },
    ],
    ["morph.title", ({ title }) => void (document.title = title)],
    ["morph.favicon", ({ url }) => favicon.show(url)],
    ["morph.language", ({ language }) => void (document.documentElement.lang = language)],
    ["morph.notify.state", () => notificationState()],
    [
      "morph.notify.request",
      async () => {
        if (typeof Notification === "undefined") return "unsupported";
        return await Notification.requestPermission();
      },
    ],
    [
      "morph.notify.show",
      ({ id, title, body, tag }) => {
        if (notificationState() !== "granted") return false;
        const notification = new Notification(title, { body, tag: tag || id });
        notifications.set(id, notification);
        notification.addEventListener("click", () => {
          focus();
          player.hostEvent("morph.notify.press", { id });
          notification.close();
        });
        notification.addEventListener("close", () => notifications.delete(id));
        return true;
      },
    ],
    ["morph.client.platform", () => clientPlatform()],
    ["morph.file.pick", pickFiles],
    ["morph.file.upload", (args) => uploadFile(player, args)],
    [
      "morph.file.release",
      ({ id }) => {
        const entry = files.get(id);
        if (entry && entry.preview) URL.revokeObjectURL(entry.preview);
        files.delete(id);
      },
    ],
    ["morph.file.save", saveFile],
    ["morph.voice.support", () => voice.support()],
    ["morph.voice.start", (args) => voice.start(args)],
    ["morph.voice.stop", () => voice.stop()],
    ["morph.voice.cancel", () => voice.cancel()],
  ]);

  queueMicrotask(sendVisibility);

  return {
    call(name, args) {
      const handler = functions.get(name);
      if (!handler) throw new Error(`no host function ${name}`);
      return handler(args || {});
    },
  };
}
