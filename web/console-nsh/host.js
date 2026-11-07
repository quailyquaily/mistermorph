// The web implementation of the `morph.*` host contract (see lib/platform.ts). It runs in the
// page itself, around the frame the app draws in, so the browser-only parts live here: the
// address bar, localStorage, file inputs, downloads and system notifications.
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

export function createHost(player) {
  const notifications = new Map();
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
        features: ["pickFile", "saveFile", ...(typeof Notification === "undefined" ? [] : ["notifications"])],
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
