// FT110: the composer's attachments before they are sent, and where Upload files picks from.
//
// A picked image previews from the device at once (the host's preview URL), before and after its
// upload, after a failed one, and in a new topic, where an upload into a workspace has no topic to
// fetch it back through; other files preview from the agent once uploaded; a file nothing can show
// says so. Opening and closing the preview submits nothing and keeps the draft. The preview's own
// object URLs are revoked, the host's never are; a picked file goes back to the host once the
// draft lets it go (removed, sent). On touch screens Upload files asks Gallery (the photo picker)
// or File (the document picker, any file); cancelling either keeps the draft, and a file removed
// can be picked again. The desktops' Upload files still opens their picker at once.
import { expect, test } from "nsh/test";
import { createFilePreview, draftFilePreviewable, isPreviewImage, localImageSource } from "../components/chat/filePreview";
import { pickRequest, type PickedFile } from "../lib/platform";
import { acceptsImagesOnly, pickerFor } from "../lib/mobileHost";
import { pickFiles as hostPickFiles, releasePickedFile } from "../host.js";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const UNAVAILABLE = "This file cannot be previewed.";

/* ---------- the preview's state, with stand-ins for the bytes and URLs ---------- */

const picked = (id: string, name: string, type: string, preview = ""): PickedFile => ({ id, name, size: 10, type, preview });
const draft = (id: string, file: unknown, status = "ready", name = (file as { name: string }).name) => ({ id, name, status, sourceFile: file, dirName: "workspace_dir", path: name });

function fakeURLs() {
  let next = 0;
  const made: string[] = [];
  const revoked: string[] = [];
  return {
    made,
    revoked,
    createObjectURL: (_blob: Blob) => {
      const url = `blob:owned/${++next}`;
      made.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => void revoked.push(url),
  };
}

/** A remote fetch the test answers later: `resolve(i, blob)` settles the i-th. */
function heldFetches() {
  const pending: { item: any; resolve: (blob: Blob) => void; reject: (error: Error) => void }[] = [];
  return {
    pending,
    fetchRemote: (item: any) => new Promise<Blob>((resolve, reject) => pending.push({ item, resolve, reject })),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("only raster images preview as images: SVG never does, and a draft previews once it is on the device or uploaded", () => {
  expect(isPreviewImage("photo.PNG", "")).toBe(true);
  expect(isPreviewImage("scan", "image/jpeg")).toBe(true);
  expect(isPreviewImage("logo.svg", "image/svg+xml")).toBe(false);
  expect(isPreviewImage("logo.png", "image/svg+xml")).toBe(false);
  expect(isPreviewImage("notes.txt", "text/plain")).toBe(false);

  const image = picked("p1", "photo.png", "image/png", "blob:host/p1");
  expect(localImageSource(draft("a", image, "uploading"))).toEqual({ url: "blob:host/p1" });
  // Uploading or failed, an image on the device previews; another file only once uploaded.
  expect(draftFilePreviewable(draft("a", image, "uploading"))).toBe(true);
  expect(draftFilePreviewable(draft("a", image, "failed"))).toBe(true);
  expect(draftFilePreviewable(draft("b", picked("p2", "report.pdf", "application/pdf"), "uploading"))).toBe(false);
  expect(draftFilePreviewable(draft("b", picked("p2", "report.pdf", "application/pdf"), "ready"))).toBe(true);
  // An image whose host made no preview URL (or an SVG) waits for its upload.
  expect(draftFilePreviewable(draft("c", picked("p3", "photo.png", "image/png", ""), "uploading"))).toBe(false);
  expect(draftFilePreviewable(draft("d", picked("p4", "logo.svg", "image/svg+xml", "blob:host/p4"), "uploading"))).toBe(false);
  // A pasted image (a browser File) is on the device too.
  const pasted = new File([new Uint8Array([1, 2, 3])], "clipboard-image-1.png", { type: "image/png" });
  expect(localImageSource(draft("e", pasted, "uploading"))).toEqual({ file: pasted });
});

test("a picked image shows from the host's URL, which the preview never revokes; its own object URLs it revokes", async () => {
  const urls = fakeURLs();
  const remote = heldFetches();
  const preview = createFilePreview({ fetchRemote: remote.fetchRemote, unavailable: () => UNAVAILABLE, ...urls });
  const pasted = new File([new Uint8Array([137, 80, 78, 71])], "clipboard-image-1.png", { type: "image/png" });
  const items = [draft("a", picked("p1", "photo.png", "image/png", "blob:host/p1"), "uploading"), draft("b", pasted, "ready")];

  preview.open(items, "a", "draft");
  expect(preview.state()).toMatchObject({ open: true, loading: false, kind: "image", url: "blob:host/p1", name: "photo.png", index: 0, source: "draft" });
  // No fetch: the bytes are on the device (and the upload has not even ended).
  expect(remote.pending.length).toBe(0);

  preview.navigate(1);
  await settle();
  expect(preview.state()).toMatchObject({ kind: "image", url: "blob:owned/1", index: 1 });
  expect(urls.made).toEqual(["blob:owned/1"]);

  preview.navigate(-1);
  expect(preview.state()).toMatchObject({ kind: "image", url: "blob:host/p1", index: 0 });
  // The pasted image's URL went with it; the host's was never touched.
  expect(urls.revoked).toEqual(["blob:owned/1"]);

  preview.navigate(1);
  await settle();
  preview.close();
  expect(preview.state().open).toBe(false);
  expect(urls.revoked).toEqual(["blob:owned/1", "blob:owned/2"]);
  expect(urls.revoked.some((url) => url.startsWith("blob:host/"))).toBe(false);
});

test("a fetch that ends after the preview closed or moved on changes nothing and reopens nothing", async () => {
  const urls = fakeURLs();
  const remote = heldFetches();
  const preview = createFilePreview({ fetchRemote: remote.fetchRemote, unavailable: () => UNAVAILABLE, ...urls });
  const report = draft("r", picked("p9", "report.pdf", "application/pdf"), "ready");
  const image = draft("a", picked("p1", "photo.png", "image/png", "blob:host/p1"), "ready");

  // Closed while the PDF loads: its bytes arrive later and are dropped.
  preview.open([report], "r", "draft");
  expect(preview.state()).toMatchObject({ open: true, loading: true });
  preview.close();
  remote.pending[0].resolve(new Blob([new Uint8Array([37, 80, 68, 70])], { type: "application/pdf" }));
  await settle();
  expect(preview.state().open).toBe(false);
  expect(urls.made).toEqual([]);

  // Moved on to the image while the PDF loads: the image stays.
  preview.open([report, image], "r", "draft");
  preview.navigate(1);
  remote.pending[1].resolve(new Blob([new Uint8Array([37, 80, 68, 70])], { type: "application/pdf" }));
  await settle();
  expect(preview.state()).toMatchObject({ open: true, loading: false, kind: "image", url: "blob:host/p1", error: "" });
  expect(urls.made).toEqual([]);

  // A failure that ends late says nothing either.
  preview.close();
  preview.open([report], "r", "sent");
  preview.close();
  remote.pending[2].reject(new Error("HTTP 500"));
  await settle();
  expect(preview.state()).toMatchObject({ open: false, error: "" });
});

test("a removed attachment leaves the preview: the one shown closes it, another only leaves the list", () => {
  const preview = createFilePreview({ fetchRemote: () => Promise.reject(new Error("none")), unavailable: () => UNAVAILABLE, ...fakeURLs() });
  const a = draft("a", picked("p1", "a.png", "image/png", "blob:host/p1"), "ready");
  const b = draft("b", picked("p2", "b.png", "image/png", "blob:host/p2"), "uploading");
  const c = draft("c", picked("p3", "c.png", "image/png", "blob:host/p3"), "ready");
  preview.open([a, b, c], "c", "draft");
  expect(preview.state()).toMatchObject({ index: 2, url: "blob:host/p3" });

  // b is removed: c stays shown, now second; b's upload state follows (here: it went away).
  preview.followDraft([a, c], draftFilePreviewable);
  expect(preview.state().items.map((item: any) => item.id)).toEqual(["a", "c"]);
  expect(preview.state()).toMatchObject({ open: true, index: 1, url: "blob:host/p3" });
  preview.navigate(-1);
  expect(preview.state()).toMatchObject({ index: 0, url: "blob:host/p1" });

  // The shown one is removed (its preview URL goes with its file): the preview closes.
  preview.followDraft([c], draftFilePreviewable);
  expect(preview.state().open).toBe(false);

  // A sent message's files do not follow the draft.
  preview.open([a, c], "a", "sent");
  preview.followDraft([], draftFilePreviewable);
  expect(preview.state()).toMatchObject({ open: true, source: "sent" });
});

test("bytes nothing can show say so; text and PDFs still preview from the agent", async () => {
  const urls = fakeURLs();
  const blobs: Record<string, Blob> = {
    "notes.txt": new Blob(["hello, file"], { type: "text/plain" }),
    "report.pdf": new Blob([new Uint8Array([37, 80, 68, 70])], { type: "application/pdf" }),
    "archive.bin": new Blob([new Uint8Array([0xff, 0xfe, 0xfd, 0x80])], { type: "application/octet-stream" }),
  };
  const preview = createFilePreview({ fetchRemote: async (item) => blobs[item.name], unavailable: () => UNAVAILABLE, ...urls });
  const items = Object.keys(blobs).map((name, index) => draft(`f${index}`, undefined, "ready", name));
  preview.open(items, "f0", "sent");
  await settle();
  await settle();
  expect(preview.state()).toMatchObject({ kind: "text", text: "hello, file", error: "", loading: false });
  preview.navigate(1);
  await settle();
  expect(preview.state()).toMatchObject({ kind: "pdf", url: "blob:owned/1" });
  preview.navigate(1);
  await settle();
  await settle();
  expect(preview.state()).toMatchObject({ kind: "", error: UNAVAILABLE, loading: false });
  expect(urls.revoked).toEqual(["blob:owned/1"]);
});

/* ---------- where Upload files picks from ---------- */

test("Gallery asks for images, File for any file; the phone app takes the photo picker or the document picker for them", () => {
  expect(pickRequest({ multiple: true, source: "gallery" })).toEqual({ multiple: true, source: "gallery", accept: "image/*" });
  expect(pickRequest({ multiple: true, source: "files" })).toEqual({ multiple: true, source: "files", accept: "" });
  // The desktops' picker is asked as before.
  expect(pickRequest({ multiple: true })).toEqual({ multiple: true });

  expect(pickerFor({ source: "gallery" })).toBe("images");
  expect(pickerFor({ source: "files" })).toBe("files");
  expect(pickerFor({ source: "files", accept: "image/*" })).toBe("files");
  // Without a source, `accept` decides: images alone are the photo picker.
  expect(pickerFor({ accept: "image/*" })).toBe("images");
  expect(pickerFor({ accept: "image/png,.jpg" })).toBe("images");
  expect(pickerFor({ accept: "" })).toBe("files");
  expect(pickerFor({ accept: "image/*,.pdf" })).toBe("files");
  expect(acceptsImagesOnly("")).toBe(false);
});

/** A stand-in for the page's document: the file input the host makes, which the test answers. */
function fakeDocument() {
  const inputs: any[] = [];
  const document = {
    body: { append: (node: any) => void (node.attached = true) },
    createElement(tag: string) {
      const listeners: Record<string, () => void> = {};
      const input: any = {
        tag,
        style: {},
        files: null,
        attached: false,
        addEventListener: (name: string, listener: () => void) => void (listeners[name] = listener),
        remove: () => void (input.attached = false),
        click: () => void inputs.push(input),
        choose(files: File[]) {
          input.files = files;
          listeners.change?.();
        },
        cancel: () => listeners.cancel?.(),
      };
      return input;
    },
  };
  return { document, inputs };
}

test("in a browser Gallery is a file input for images and File one for any file; cancelled, it gives nothing", async () => {
  const urls = fakeURLs();
  const { document, inputs } = fakeDocument();
  const env = { document, URL: urls };
  const photo = new File([new Uint8Array([1])], "photo.png", { type: "image/png" });
  const report = new File([new Uint8Array([2])], "report.pdf", { type: "application/pdf" });
  const logo = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });

  const gallery = hostPickFiles(pickRequest({ multiple: true, source: "gallery" }), env);
  expect(inputs[0]).toMatchObject({ accept: "image/*", multiple: true, type: "file" });
  inputs[0].choose([photo]);
  const fromGallery = await gallery;
  expect(fromGallery.map((file: PickedFile) => [file.name, file.preview])).toEqual([["photo.png", "blob:owned/1"]]);
  expect(inputs[0].attached).toBe(false);

  const any = hostPickFiles(pickRequest({ multiple: true, source: "files" }), env);
  expect(inputs[1]).toMatchObject({ accept: "", multiple: true });
  inputs[1].choose([report, logo]);
  // Only raster images get a preview URL: never a PDF or an SVG.
  expect((await any).map((file: PickedFile) => [file.name, file.type, file.preview])).toEqual([
    ["report.pdf", "application/pdf", ""],
    ["logo.svg", "image/svg+xml", ""],
  ]);

  const cancelled = hostPickFiles(pickRequest({ multiple: true, source: "files" }), env);
  inputs[2].cancel();
  expect(await cancelled).toEqual([]);

  // The same file again after it was released: a new pick, a new id and preview.
  releasePickedFile(fromGallery[0].id, urls);
  expect(urls.revoked).toEqual(["blob:owned/1"]);
  const again = hostPickFiles(pickRequest({ multiple: true, source: "gallery" }), env);
  inputs[3].choose([photo]);
  const [reselected] = await again;
  expect(reselected.name).toBe("photo.png");
  expect(reselected.id).not.toBe(fromGallery[0].id);
  expect(reselected.preview).toBe("blob:owned/2");
});

/* ---------- in the console ---------- */

function uploadAnswer(names: Record<string, string>, fail: Set<string> = new Set()) {
  return (data: any) => {
    const name = names[data.id] ?? "file";
    if (fail.has(data.id)) {
      fail.delete(data.id);
      return { ok: false, status: 500, statusText: "Internal Server Error", body: JSON.stringify({ error: "disk full" }) };
    }
    return { ok: true, status: 200, statusText: "OK", body: JSON.stringify({ files: [{ name, dir_name: "workspace_dir", path: name }] }) };
  };
}

test("on a desktop a picked image previews before sending, closes back to the draft, and goes back to the host when removed", async () => {
  const picks: any[] = [];
  const released: string[] = [];
  const queue = [[picked("p1", "photo.png", "image/png", "blob:host/p1")], [picked("p2", "photo.png", "image/png", "blob:host/p2")]];
  const { app, calls } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": { body: { items: [] } } },
    host: {
      "morph.file.pick": (options: any) => {
        picks.push(options);
        return queue.shift() ?? [];
      },
      "morph.file.upload": uploadAnswer({ p1: "photo.png", p2: "photo.png" }),
      "morph.file.release": (data: any) => {
        released.push(data.id);
        return null;
      },
    },
  });
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "look at this");
  await app.press("id:chat-composer-add");
  await app.press("Upload Files");
  // The desktop's Upload files opens its picker at once, as before: no Gallery or File.
  await app.waitFor("label:Preview file: photo.png");
  expect(picks).toEqual([{ multiple: true }]);
  expect(app.count("id:chat-attach-source-gallery")).toBe(0);
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  // Uploaded, the image stays with the draft for its preview.
  expect(released).toEqual([]);

  await app.press("label:Preview file: photo.png");
  await app.waitFor("id:chat-file-preview-image");
  expect(app.count("id:chat-file-preview-error")).toBe(0);
  expect(calls.some((call) => call.uri?.startsWith("/files/download"))).toBe(false);
  await app.press("id:chat-file-preview-close");
  await app.waitFor("id:chat-file-preview-image", { state: "gone" });
  // Nothing was sent; the draft is as it was.
  expect(calls.some((call) => call.method === "POST" && call.uri === "/tasks")).toBe(false);
  expect(app.value("id:chat-composer-input")).toBe("look at this");
  expect(app.count("label:Preview file: photo.png")).toBe(1);

  // Removal is its own button; the file goes back to the host.
  await app.press("role:button[Remove from task: photo.png]");
  await app.waitFor("label:Preview file: photo.png", { state: "gone" });
  expect(released).toEqual(["p1"]);
  expect(app.value("id:chat-composer-input")).toBe("look at this");

  // The same file again.
  await app.press("id:chat-composer-add");
  await app.press("Upload Files");
  await app.waitFor("label:Preview file: photo.png");
  await app.press("label:Preview file: photo.png");
  await app.waitFor("id:chat-file-preview-image");
  await app.press("id:chat-file-preview-close");
  await app.waitFor("id:chat-file-preview-image", { state: "gone" });
  expect(released).toEqual(["p1"]);
});

test("in a new topic a picked image previews from the device, a failed upload can be previewed and retried, and sending lets it go", async () => {
  let created = false;
  let body: any = null;
  const released: string[] = [];
  const fail = new Set(["p1"]);
  const { app, calls } = await openConsole({
    location: "/e/default/chat",
    api: {
      "GET /proxy:/topics": () => ({ body: { items: created ? TOPICS.body.items : [] } }),
      "GET /proxy:/tasks": { body: { items: [] } },
      "GET /proxy:/tasks/task-1": { body: { id: "task-1", task: "see", status: "running", topic_id: "topic-1", created_at: NOW } },
      "POST /proxy:/tasks": (request: ApiRequest) => {
        created = true;
        body = request.json;
        return { body: { id: "task-1", status: "queued", topic_id: "topic-1" } };
      },
    },
    host: {
      "morph.file.pick": [picked("p1", "photo.png", "image/png", "blob:host/p1"), picked("p2", "notes.txt", "text/plain")],
      "morph.file.upload": uploadAnswer({ p1: "photo.png", p2: "notes.txt" }, fail),
      "morph.file.release": (data: any) => {
        released.push(data.id);
        return null;
      },
    },
  });
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "see");
  await app.press("id:chat-composer-add");
  await app.press("Upload Files");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("disk full")));
  // The text file is uploaded and went back to the host; the failed image is kept for its retry.
  await app.waitUntil(() => released.includes("p2"));
  expect(released).toEqual(["p2"]);

  // The failed image still previews from the device; the text file, uploaded into a workspace of a
  // topic that does not exist yet, cannot be fetched back, and says so. Next and Previous step
  // through what can be previewed.
  await app.press("label:Preview file: photo.png");
  await app.waitFor("id:chat-file-preview-image");
  await app.press("role:button[Next file]");
  await app.waitFor("id:chat-file-preview-error");
  expect(app.texts().includes(UNAVAILABLE)).toBe(true);
  await app.press("role:button[Previous file]");
  await app.waitFor("id:chat-file-preview-image");
  await app.press("id:chat-file-preview-close");
  await app.waitFor("id:chat-file-preview-image", { state: "gone" });
  expect(calls.some((call) => call.method === "POST" && call.uri === "/tasks")).toBe(false);

  await app.press("role:button[Retry upload]");
  await app.waitUntil(() => !app.texts().some((text) => text.startsWith("disk full")));
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.press("label:Preview file: photo.png");
  await app.waitFor("id:chat-file-preview-image");
  await app.press("id:chat-file-preview-close");
  await app.waitFor("id:chat-file-preview-image", { state: "gone" });
  expect(released).toEqual(["p2"]);

  await app.press("id:chat-composer-send");
  await app.waitUntil(() => body !== null);
  expect(body.file_references).toEqual([
    { dir_name: "workspace_dir", path: "photo.png" },
    { dir_name: "workspace_dir", path: "notes.txt" },
  ]);
  // Sent, the draft let the image go.
  await app.waitUntil(() => released.includes("p1"));
  // The sent pills keep the names with their extensions, without the type labels.
  await app.waitUntil(() => app.count("id:chat-user-file") === 2);
  const texts = app.texts();
  expect(texts.includes("photo.png")).toBe(true);
  expect(texts.includes("notes.txt")).toBe(true);
  expect(texts.includes("PNG") || texts.includes("TXT")).toBe(false);
});

async function openPhone(post?: (request: ApiRequest) => { status?: number; body: unknown }) {
  return openConsole({
    platform: "android",
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/todo/tasks": { body: { items: [] } },
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": { body: { items: [] } },
      "POST /proxy:/files/upload": (request: ApiRequest) => {
        const name = /filename="([^"]+)"/.exec(request.body ?? "")?.[1] ?? "file";
        return { body: { files: [{ name, dir_name: "workspace_dir", path: name }] } };
      },
      ...(post ? { "POST /proxy:/tasks": post } : {}),
    },
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

test("on the phone Upload files asks Gallery or File: Gallery opens the photo picker, File the document picker for any file", async () => {
  const { app, calls } = await openPhone();
  app.onPick((pick) =>
    pick.kind === "images"
      ? [{ name: "photo.png", type: "image/png", data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }]
      : [{ name: "report.pdf", type: "application/pdf", data: bytes("%PDF-1.4") }],
  );
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "two files");

  await app.press("id:chat-composer-add");
  await app.press("text:Upload Files");
  await app.waitFor("id:chat-attach-source-gallery");
  expect(app.texts().includes("Gallery")).toBe(true);
  expect(app.texts().includes("File")).toBe(true);
  await app.press("id:chat-attach-source-files");
  await app.waitFor("id:chat-attach-source-files", { state: "gone" });
  await app.waitFor("label:Preview file: report.pdf");
  expect(app.picks().map((pick) => [pick.kind, pick.multiple, pick.filters.length])).toEqual([["files", true, 0]]);

  await app.press("id:chat-composer-add");
  await app.press("text:Upload Files");
  await app.press("id:chat-attach-source-gallery");
  await app.waitFor("label:Preview file: photo.png");
  expect(app.picks().map((pick) => pick.kind)).toEqual(["files", "images"]);
  // Both went up with the draft's topic, the document as it is.
  await app.waitUntil(() => calls.filter((call) => call.method === "POST" && call.uri === "/files/upload").length === 2);
  expect(app.value("id:chat-composer-input")).toBe("two files");
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));

  // The document previews from the agent once uploaded, as before.
  expect(app.enabled("label:Preview file: report.pdf")).toBe(true);
});

test("on the phone a cancelled sheet or picker keeps the draft, and a removed file can be picked again", async () => {
  const { app } = await openPhone();
  let answer: "cancel" | "pick" = "cancel";
  app.onPick(() => (answer === "cancel" ? null : [{ name: "report.pdf", type: "application/pdf", data: bytes("%PDF-1.4") }]));
  await app.waitFor("id:chat-composer-input");
  await app.type("id:chat-composer-input", "keep me");

  // The sheet closed with Back: nothing is picked.
  await app.press("id:chat-composer-add");
  await app.press("text:Upload Files");
  await app.waitFor("id:chat-attach-source-files");
  await app.back();
  await app.waitFor("id:chat-attach-source-files", { state: "gone" });
  expect(app.picks().length).toBe(0);
  expect(app.value("id:chat-composer-input")).toBe("keep me");

  // The document picker cancelled: no file, the draft as it was.
  await app.press("id:chat-composer-add");
  await app.press("text:Upload Files");
  await app.press("id:chat-attach-source-files");
  await app.waitUntil(() => app.picks().length === 1);
  await app.wait(100);
  expect(app.count("id:chat-composer-files")).toBe(0);
  expect(app.value("id:chat-composer-input")).toBe("keep me");

  // Picked, removed, picked again.
  answer = "pick";
  for (let round = 0; round < 2; round += 1) {
    await app.press("id:chat-composer-add");
    await app.press("text:Upload Files");
    await app.press("id:chat-attach-source-files");
    await app.waitFor("label:Preview file: report.pdf");
    await app.waitUntil(() => app.enabled("id:chat-composer-send"));
    if (round === 0) {
      await app.press("role:button[Remove from task: report.pdf]");
      await app.waitFor("label:Preview file: report.pdf", { state: "gone" });
    }
  }
  expect(app.picks().length).toBe(3);
  expect(app.count("label:Preview file: report.pdf")).toBe(1);
  expect(app.value("id:chat-composer-input")).toBe("keep me");
});
