// FT197: images pasted into the chat composer (components/chat/imagePaste.ts and the chat page's
// controller). An image paste adds pending attachments through the upload every picked file takes
// (pills, previews, retry, removal, the sent message's file_references) and never sends; the paste's
// text goes into the field as before. The bytes decide what an image is; images the model cannot
// take (another format, unreadable, over 5 MiB, past three) are refused with a reason before any
// upload, and a draft holding such images is not sent. Pastes are attached in their order however
// their checks and uploads end, a paste for a draft no longer on screen is dropped, and one the
// composer cannot take now (an edit, the TODO list) says why and keeps the draft.
//
// These run headless: `app.paste` hands the field nsh's paste event. A real browser ClipboardEvent is
// tests/chat-image-paste-web.test.tsx; no test here is the operating system's clipboard or menu.
import { expect, test } from "nsh/test";
import type { App } from "nsh/test";
import {
  checkPastedImages,
  createComposerPaste,
  draftImageLimitMessage,
  imageIntact,
  isModelImageName,
  MODEL_IMAGE_MAX_BYTES,
  modelImageNote,
  pastedImageCandidates,
  sniffImage,
} from "../components/chat/imagePaste";
import {
  createUploadGate,
  formatLimit,
  missingReferenceIndexes,
  PASTE_BATCH_MAX_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_REQUEST_BYTES,
  uploadFailure,
} from "../components/chat/uploads";
import { openConsole, type ApiRequest } from "./harness";

const FIXTURES = "tests/fixtures/paste";
const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };

/* ---------- the bytes: what is an image the model can be shown ---------- */

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const PNG_END = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** A PNG-shaped file of `size` bytes: its header chunk first, its end chunk last. */
function png(name: string, size = 120, type = "image/png") {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_HEAD, 0);
  bytes.set(PNG_END, size - PNG_END.length);
  return new File([bytes], name, { type });
}
function jpeg(name: string, type = "image/jpeg") {
  const bytes = new Uint8Array(200);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return new File([bytes], name, { type });
}
function webp(name: string, riff = 30, size = 38) {
  const bytes = new Uint8Array(size);
  bytes.set(ascii("RIFF"), 0);
  bytes.set([riff & 0xff, (riff >> 8) & 0xff, 0, 0], 4);
  bytes.set(ascii("WEBPVP8L"), 8);
  return new File([bytes], name, { type: "image/webp" });
}
const raw = (name: string, bytes: number[], type = "image/png") => new File([new Uint8Array(bytes)], name, { type });

test("the bytes say what a pasted file is, whatever its name and type say", () => {
  expect(sniffImage(new Uint8Array(PNG_HEAD))).toBe("png");
  expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe("jpeg");
  expect(sniffImage(new Uint8Array(ascii("RIFF\x1e\0\0\0WEBPVP8L")))).toBe("webp");
  expect(sniffImage(new Uint8Array(ascii("GIF89a....")))).toBe("gif");
  expect(sniffImage(new Uint8Array([...ascii("BM"), ...new Array(14).fill(0)]))).toBe("bmp");
  expect(sniffImage(new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0]))).toBe("tiff");
  expect(sniffImage(new Uint8Array([0, 0, 0, 24, ...ascii("ftypheic")]))).toBe("heic");
  expect(sniffImage(new Uint8Array([0, 0, 0, 24, ...ascii("ftypavif")]))).toBe("avif");
  expect(sniffImage(new Uint8Array([0xef, 0xbb, 0xbf, ...ascii("  <svg onload=x>")]))).toBe("svg");
  expect(sniffImage(new Uint8Array(ascii("<html><img src=x>")))).toBe("svg");
  expect(sniffImage(new Uint8Array(ascii("hello")))).toBe("");
  expect(sniffImage(new Uint8Array([]))).toBe("");
  // A PNG cut short (no end chunk) or a WebP whose RIFF size runs past the file does not hold together.
  const head = new Uint8Array([...PNG_HEAD, ...new Array(48).fill(0)]);
  expect(imageIntact("png", head, new Uint8Array(PNG_END), 120)).toBe(true);
  expect(imageIntact("png", head, head.slice(-12), 120)).toBe(false);
  expect(imageIntact("png", head, new Uint8Array(PNG_END), 40)).toBe(false);
  expect(imageIntact("webp", new Uint8Array(ascii("RIFF\x1e\0\0\0WEBPVP8L")), new Uint8Array(), 38)).toBe(true);
  expect(imageIntact("webp", new Uint8Array(ascii("RIFF\xff\0\0\0WEBPVP8L").map((c) => c & 0xff)), new Uint8Array(), 38)).toBe(false);
  // What the agent shows the model, by the uploaded name's extension (internal/imagemime).
  expect(["a.png", "b.JPG", "c.jpeg", "d.webp"].every(isModelImageName)).toBe(true);
  expect(["a.gif", "b.heic", "c.png.txt", "d"].some(isModelImageName)).toBe(false);
});

test("a paste's candidates are its files of an image type or of none; other files are left alone", () => {
  const pdf = raw("a.pdf", [0x25, 0x50], "application/pdf");
  const bare = raw("blob", [1], "");
  const binary = raw("shot", [1], "application/octet-stream");
  const image = png("image.png");
  expect(pastedImageCandidates({ text: "x", files: [pdf, bare, binary, image] })).toEqual([bare, binary, image]);
  expect(pastedImageCandidates({ text: "only words", files: [] })).toEqual([]);
  expect(pastedImageCandidates(null)).toEqual([]);
});

test("accepted images keep the paste's order and are named and typed after their bytes; the rest say why", async () => {
  const checked = await checkPastedImages([
    png("image.png"), // nsh's name for an image that had none
    jpeg("holiday.png", "image/png"), // a JPEG under a PNG's name and type
    raw("anim.gif", ascii("GIF89a\0\0\0\0\0\0"), "image/gif"),
    raw("drawing.png", ascii("<svg><script>alert(1)</script></svg>")),
    raw("noise.png", [1, 2, 3, 4, 5, 6, 7, 8, 9]),
    raw("empty.png", []),
    webp("", 30, 38),
  ]);
  expect(checked.accepted.map((file) => `${file.name}|${file.type}|${file.size}`)).toEqual([
    "clipboard-image-1.png|image/png|120",
    "holiday.jpg|image/jpeg|200",
    "clipboard-image-2.webp|image/webp|38",
  ]);
  expect(checked.refused).toEqual([
    { name: "anim.gif", reason: "unsupported", format: "GIF" },
    { name: "drawing.png", reason: "unsupported", format: "SVG" },
    { name: "noise.png", reason: "corrupt" },
    { name: "empty.png", reason: "empty" },
  ]);
  // A file already named and typed right is taken as it is.
  const right = png("chart.png");
  expect((await checkPastedImages([right])).accepted[0]).toBe(right);
});

/**
 * A PNG-shaped file that says it holds `size` bytes without holding them (a size stub): its first
 * and last bytes are a PNG's, which is all the check reads.
 */
function pngOfSize(name: string, size: number): File {
  const head = new Uint8Array(64);
  head.set(PNG_HEAD, 0);
  const tail = new Uint8Array(64);
  tail.set(PNG_END, 64 - PNG_END.length);
  return {
    name,
    size,
    type: "image/png",
    slice: (start = 0, end = size) => new Blob([start === 0 ? head.slice(0, end - start) : tail.slice(64 - (end - start))]),
  } as unknown as File;
}

test("a pasted file of exactly 128 MiB is taken and one byte more is not, before any upload; the model's 5 MiB is no paste limit", async () => {
  expect(UPLOAD_MAX_FILE_BYTES).toBe(134_217_728);
  const checked = await checkPastedImages([pngOfSize("max.png", 134_217_728), pngOfSize("over.png", 134_217_729), png("model-max.png", MODEL_IMAGE_MAX_BYTES + 1)]);
  expect(checked.accepted.map((file) => `${file.name}|${file.size}`)).toEqual(["max.png|134217728", `model-max.png|${MODEL_IMAGE_MAX_BYTES + 1}`]);
  expect(checked.refused).toEqual([{ name: "over.png", reason: "too_large" }]);
});

test("a paste attaches up to 256 MiB of images in all, in its order: exactly 256 MiB is taken, one byte more refuses the file that passes it", async () => {
  expect(PASTE_BATCH_MAX_BYTES).toBe(268_435_456);
  const half = 134_217_728;
  const exact = await checkPastedImages([pngOfSize("a.png", half), pngOfSize("b.png", half)]);
  expect(exact.accepted.map((file) => file.name)).toEqual(["a.png", "b.png"]);
  expect(exact.refused).toEqual([]);
  const over = await checkPastedImages([pngOfSize("a.png", half), pngOfSize("b.png", half - 100), pngOfSize("c.png", 101), pngOfSize("d.png", 100)]);
  // c takes the paste one byte past its budget: refused, and named; d, which still fits, is taken.
  expect(over.accepted.map((file) => file.name)).toEqual(["a.png", "b.png", "d.png"]);
  expect(over.refused).toEqual([{ name: "c.png", reason: "batch_too_large" }]);
  // Many images: no count limit at the paste (the send checks the model's three).
  const many = await checkPastedImages([png("1.png"), png("2.png"), png("3.png"), png("4.png"), png("5.png")]);
  expect(many.accepted.length).toBe(5);
});

test("uploads of a composer run two at a time in their order, and a refusal over a size is never retried", async () => {
  const gate = createUploadGate();
  const started: string[] = [];
  const releases: Record<string, () => void> = {};
  const job = (name: string) => () =>
    new Promise<string>((resolve) => {
      started.push(name);
      releases[name] = () => resolve(name);
    });
  const done = ["a", "b", "c", "d"].map((name) => gate.run(job(name)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(started).toEqual(["a", "b"]);
  expect(gate.state()).toEqual({ running: 2, waiting: 2 });
  releases.b();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(started).toEqual(["a", "b", "c"]);
  releases.a();
  releases.c();
  await new Promise((resolve) => setTimeout(resolve, 10));
  releases.d();
  expect(await Promise.all(done)).toEqual(["a", "b", "c", "d"]);
  expect(gate.state()).toEqual({ running: 0, waiting: 0 });

  const words = (key: string, values?: Record<string, string>) => `${key}${values ? JSON.stringify(values) : ""}`;
  const fail = (status: number, message: string, code?: string) => uploadFailure(Object.assign(new Error(message), { status, code }), words, "upload failed");
  expect(fail(413, "file \"x\" exceeds 128 MiB (134217728 bytes)", "upload_file_too_large")).toEqual({
    message: 'chat_composer_upload_file_refused{"limit":"128 MiB (134,217,728 bytes)"}',
    retryable: false,
  });
  expect(fail(413, "upload request exceeds 129 MiB (135266304 bytes)", "upload_request_too_large").retryable).toBe(false);
  // An ingress page, or no words at all: who refused, and that no limit was given.
  expect(fail(413, "<html><body>413 Request Entity Too Large</body></html>")).toEqual({ message: "chat_composer_upload_refused_size_unknown", retryable: false });
  expect(fail(413, "HTTP 413").message).toBe("chat_composer_upload_refused_size_unknown");
  // An agent from before FT197 says its own limit, which is shown as it said it.
  expect(fail(413, "upload exceeds 64 MiB")).toEqual({ message: 'chat_composer_upload_refused_size{"message":"upload exceeds 64 MiB"}', retryable: false });
  expect(fail(503, "the console is receiving other uploads", "upload_busy")).toEqual({ message: "chat_composer_upload_busy", retryable: true });
  expect(fail(504, "the agent did not take the upload in time")).toEqual({ message: "chat_composer_upload_timeout", retryable: true });
  expect(fail(0, "network down").retryable).toBe(true);
  expect(formatLimit(UPLOAD_MAX_REQUEST_BYTES)).toBe("129 MiB (135,266,304 bytes)");
  expect(missingReferenceIndexes(Object.assign(new Error("file_references[1]: file does not exist"), { status: 400 }))).toEqual([1]);
  expect(missingReferenceIndexes(Object.assign(new Error("file_references[1]: file does not exist"), { status: 500 }))).toEqual([]);
});

test("a file whose bytes cannot be read is refused as unreadable, the others are still taken", async () => {
  const broken = png("gone.png");
  (broken as any).slice = () => ({ arrayBuffer: () => Promise.reject(new Error("the grant expired")) });
  const checked = await checkPastedImages([broken, png("kept.png")]);
  expect(checked.accepted.map((file) => file.name)).toEqual(["kept.png"]);
  expect(checked.refused).toEqual([{ name: "gone.png", reason: "unreadable" }]);
});

/** A file whose bytes are read only when `release()` is called: a slow clipboard or a large image. */
function slowFile(file: File) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slice = file.slice.bind(file);
  (file as any).slice = (start?: number, end?: number) => {
    const part = slice(start, end);
    return { arrayBuffer: () => gate.then(() => part.arrayBuffer()) };
  };
  return { file, release };
}

function pasteHost(overrides: Partial<Parameters<typeof createComposerPaste>[0]> = {}) {
  const taken: string[][] = [];
  const refused: { text: string; type: string }[] = [];
  let draft = "d1";
  let blocked = "";
  const host = {
    draft: () => draft,
    blocked: () => blocked,
    takeFiles: (files: File[]) => void taken.push(files.map((file) => file.name)),
    refuse: (text: string, type: string) => void refused.push({ text, type }),
    text: (key: string, values: Record<string, string>) => `${key}(${values.names})`,
    ...overrides,
  };
  return {
    paste: createComposerPaste(host),
    taken,
    refused,
    setDraft: (next: string) => void (draft = next),
    setBlocked: (next: string) => void (blocked = next),
  };
}

test("pastes are attached in the order they were made, though a later one's bytes are read first", async () => {
  const host = pasteHost();
  const first = slowFile(png("first.png"));
  const firstDone = host.paste([first.file]);
  const secondDone = host.paste([png("second.png"), png("third.png")]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The second paste waits for the first, whose bytes are not read yet.
  expect(host.taken).toEqual([]);
  first.release();
  expect(await firstDone).toBe("taken");
  expect(await secondDone).toBe("taken");
  expect(host.taken).toEqual([["first.png"], ["second.png", "third.png"]]);
  // A fourth image is attached too: the model's three are the send's to check.
  expect(await host.paste([png("fourth.png")])).toBe("taken");
  expect(host.refused).toEqual([]);
});

test("a paste for a draft no longer on screen is dropped; one the composer cannot take says why and takes nothing", async () => {
  const host = pasteHost();
  const slow = slowFile(png("late.png"));
  const late = host.paste([slow.file]);
  host.setDraft("d2"); // another conversation, or the draft was sent
  slow.release();
  expect(await late).toBe("stale");
  expect(host.taken).toEqual([]);
  expect(host.refused).toEqual([]);

  host.setBlocked("Finish or cancel the edit first.");
  expect(await host.paste([png("a.png")])).toBe("refused");
  expect(host.refused).toEqual([{ text: "Finish or cancel the edit first.", type: "warning" }]);
  expect(host.taken).toEqual([]);

  // Blocked while its bytes were read (a send began): refused then, with the reason.
  host.setBlocked("");
  const reading = slowFile(png("b.png"));
  const during = host.paste([reading.file]);
  host.setBlocked("Wait until the message is sent.");
  reading.release();
  expect(await during).toBe("refused");
  expect(host.refused.at(-1)).toEqual({ text: "Wait until the message is sent.", type: "warning" });
  expect(host.taken).toEqual([]);
  // A paste of no files is nothing at all.
  expect(await host.paste([])).toBe("empty");
});

test("a draft is not sent with an image over 5 MiB or with more than three images", () => {
  const text = (key: string, values?: Record<string, string>) => `${key}:${JSON.stringify(values)}`;
  const item = (name: string, sizeBytes = 100) => ({ name, status: "ready", sizeBytes });
  expect(draftImageLimitMessage([item("a.png"), item("b.jpg"), item("c.webp"), item("notes.txt", 99e6)], text)).toBe("");
  expect(draftImageLimitMessage([item("a.png", MODEL_IMAGE_MAX_BYTES)], text)).toBe("");
  expect(draftImageLimitMessage([item("a.png", MODEL_IMAGE_MAX_BYTES + 1)], text)).toBe(
    'chat_composer_images_too_large:{"names":"a.png","limit":"5 MiB (5,242,880 bytes)"}',
  );
  // The pill of a large original says it is stored, not shown to the model.
  expect(modelImageNote("a.png", MODEL_IMAGE_MAX_BYTES + 1, text)).toBe('chat_composer_file_model_too_large:{"limit":"5 MiB (5,242,880 bytes)"}');
  expect(modelImageNote("a.png", MODEL_IMAGE_MAX_BYTES, text)).toBe("");
  expect(modelImageNote("a.zip", 1e9, text)).toBe("");
  expect(draftImageLimitMessage([item("a.png"), item("b.png"), item("c.png"), item("d.png")], text)).toBe(
    'chat_composer_images_too_many:{"count":"4","max":"3","extra":"1"}',
  );
  // A GIF is not shown to the model: it counts for neither.
  expect(draftImageLimitMessage([item("a.png"), item("b.png"), item("c.png"), item("d.gif", 9e6)], text)).toBe("");
});

/* ---------- the chat page: pasted images in the real console ---------- */

interface Upload {
  name: string;
  type: string;
  fields: string;
  /** When the request came (ms). */
  at: number;
}

/** The parts of a multipart upload: the file's name and type, the form's other fields. */
function uploadOf(request: ApiRequest): Upload {
  const body = String(request.body ?? "");
  return {
    name: /filename="([^"]+)"/.exec(body)?.[1] ?? "",
    type: /filename="[^"]+"\r?\nContent-Type: ([^\r\n]+)/i.exec(body)?.[1] ?? "",
    fields: [...body.matchAll(/name="([a-z_]+)"\r?\n\r?\n([^\r\n]*)/g)].map((m) => `${m[1]}=${m[2]}`).join("&"),
    at: Date.now(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openChat(options: { location?: string; delay?: (upload: Upload) => number; fail?: (upload: Upload, attempt: number) => { status: number; body: unknown; headers?: Record<string, string> } | null; extraApi?: Record<string, any>; host?: Record<string, unknown> } = {}) {
  const uploads: Upload[] = [];
  const posts: any[] = [];
  let created = false;
  const attempts = new Map<string, number>();
  const { app, calls } = await openConsole({
    location: options.location ?? "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/topics": () => ({ body: { items: created || options.location === undefined ? TOPICS.body.items : [] } }),
      "GET /proxy:/tasks": { body: { items: [] } },
      "GET /proxy:/tasks/task-1": { body: { id: "task-1", task: "see", status: "running", topic_id: "topic-1", created_at: NOW } },
      "POST /proxy:/files/upload": (request: ApiRequest) => {
        const upload = uploadOf(request);
        uploads.push(upload);
        const attempt = (attempts.get(upload.name) ?? 0) + 1;
        attempts.set(upload.name, attempt);
        const delay = options.delay?.(upload) ?? 0;
        const failure = options.fail?.(upload, attempt);
        if (failure) return { ...failure, delay };
        return { body: { files: [{ name: upload.name, dir_name: "workspace_dir", path: upload.name, size_bytes: 100 }] }, delay };
      },
      "POST /proxy:/tasks": (request: ApiRequest) => {
        created = true;
        posts.push(request.json);
        return { body: { id: "task-1", status: "queued", topic_id: "topic-1" } };
      },
      ...(options.extraApi || {}),
    },
    host: options.host,
  });
  await app.waitFor("id:chat-composer-input");
  return { app, calls, uploads, posts };
}

/** The names the composer's pills show, in their order. */
function pills(app: App, names: string[]): string[] {
  return app.texts().filter((text) => names.includes(text));
}

/** Closes the notices: they lie over the foot of the window, where Send is. */
async function dismissNotices(app: App) {
  while (app.count("role:button[Dismiss]") > 0) await app.press("role:button[Dismiss] >> nth=0");
}

test("an image pasted into an empty draft becomes a pending attachment, uploaded with the session, and goes with the message", async () => {
  const { app, calls, uploads, posts } = await openChat();
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`] });
  await app.waitFor("label:Preview file: red.png");
  await app.waitUntil(() => uploads.length === 1);
  expect({ ...uploads[0], at: 0 }).toEqual({ name: "red.png", type: "image/png", fields: "topic_id=topic-1", at: 0 });
  const upload = calls.find((call) => call.uri === "/files/upload");
  expect(upload?.endpoint).toBe("ep_console_local");
  expect(upload?.headers?.authorization ?? upload?.headers?.Authorization).toBe("Bearer token-1");
  // Nothing was sent and the field is as it was.
  expect(app.value("id:chat-composer-input")).toBe("");
  await sleep(200);
  expect(posts).toEqual([]);
  // The pasted image previews from the device.
  await app.press("label:Preview file: red.png");
  await app.waitFor("id:chat-file-preview-image");
  await app.press("id:chat-file-preview-close");
  await app.waitFor("id:chat-file-preview-image", { state: "gone" });

  await app.type("id:chat-composer-input", "what is this");
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].task).toBe("what is this");
  expect(posts[0].file_references).toEqual([{ dir_name: "workspace_dir", path: "red.png" }]);
});

test("text and images pasted into a new conversation's draft: the text goes in at the caret, the images are attached, a GIF is refused", async () => {
  const { app, uploads, posts } = await openChat({ location: "/e/default/chat" });
  await app.type("id:chat-composer-input", "Look: ");
  await app.paste("id:chat-composer-input", { text: "the chart", files: [`${FIXTURES}/mislabelled.png`, `${FIXTURES}/dark.gif`, `${FIXTURES}/blue.webp`] });
  await app.waitUntil(() => uploads.length === 2);
  expect(app.value("id:chat-composer-input")).toBe("Look: the chart");
  // A JPEG copied under a PNG's name is uploaded as what it is.
  expect(uploads.map((upload) => `${upload.name}|${upload.type}`)).toEqual(["mislabelled.jpg|image/jpeg", "blue.webp|image/webp"]);
  await app.waitUntil(() => pills(app, ["mislabelled.jpg", "blue.webp"]).length === 2);
  expect(pills(app, ["mislabelled.jpg", "blue.webp", "dark.gif"])).toEqual(["mislabelled.jpg", "blue.webp"]);
  await app.waitFor("text:/^Not added: dark\\.gif \\(GIF\\)\\. Only PNG, JPEG and WebP images can be pasted/");
  expect(posts).toEqual([]);
  await dismissNotices(app);
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].task).toBe("Look: the chart");
  expect(posts[0].file_references).toEqual([
    { dir_name: "workspace_dir", path: "mislabelled.jpg" },
    { dir_name: "workspace_dir", path: "blue.webp" },
  ]);
});

test("pastes made quickly one after another keep their order though the first upload ends last", async () => {
  const { app, uploads, posts } = await openChat({ delay: (upload) => (upload.name === "green.jpg" ? 900 : 0) });
  await app.type("id:chat-composer-input", "compare");
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/green.jpg`] });
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`] });
  await app.waitUntil(() => uploads.length === 2);
  expect(pills(app, ["green.jpg", "red.png"])).toEqual(["green.jpg", "red.png"]);
  // The second is uploaded while the first still is.
  await app.waitUntil(() => app.texts().filter((text) => text === "Uploading...").length === 1);
  await app.waitUntil(() => app.enabled("id:chat-composer-send"), { timeout: 4000 });
  expect(pills(app, ["green.jpg", "red.png"])).toEqual(["green.jpg", "red.png"]);
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].file_references.map((reference: any) => reference.path)).toEqual(["green.jpg", "red.png"]);
});

test("a pasted image whose upload fails can be retried with the same bytes; refused images and the draft's text stay as they were", async () => {
  const { app, uploads, posts } = await openChat({
    // The agent refused it (an upstream 401: the console's session still holds).
    fail: (upload, attempt) =>
      upload.name === "red.png" && attempt === 1 ? { status: 401, headers: { "X-MisterMorph-Proxy-Upstream": "1" }, body: { error: "agent token rejected" } } : null,
  });
  await app.type("id:chat-composer-input", "keep me");
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`, `${FIXTURES}/truncated.png`, `${FIXTURES}/empty.png`] });
  await app.waitFor("role:button[Retry upload]");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("agent token rejected")));
  await app.waitFor("text:/^Not added: truncated\\.png, empty\\.png could not be read as a PNG, JPEG or WebP image/");
  expect(uploads.map((upload) => upload.name)).toEqual(["red.png"]);
  expect(app.value("id:chat-composer-input")).toBe("keep me");
  await dismissNotices(app);
  await app.press("role:button[Retry upload]");
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  expect(uploads.map((upload) => `${upload.name}|${upload.type}`)).toEqual(["red.png|image/png", "red.png|image/png"]);
  // Removed, it can be pasted again.
  await app.press("role:button[Remove from task: red.png]");
  await app.waitFor("label:Preview file: red.png", { state: "gone" });
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`] });
  await app.waitFor("label:Preview file: red.png");
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  expect(posts).toEqual([]);
});

test("a fourth image and a large original are attached, but the send says why the model cannot take them and keeps the draft", async () => {
  const big = { id: "p1", name: "huge.png", size: MODEL_IMAGE_MAX_BYTES + 1, type: "image/png", preview: "" };
  const { app, uploads, posts } = await openChat({
    host: {
      "morph.file.pick": [big],
      "morph.file.upload": () => ({ ok: true, status: 200, statusText: "OK", body: JSON.stringify({ files: [{ name: "huge.png", dir_name: "workspace_dir", path: "huge.png", size_bytes: MODEL_IMAGE_MAX_BYTES + 1 }] }) }),
      "morph.file.release": null,
    },
  });
  await app.type("id:chat-composer-input", "four of them");
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`, `${FIXTURES}/green.jpg`] });
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/blue.webp`, `${FIXTURES}/mislabelled.png`] });
  await app.waitUntil(() => uploads.length === 4);
  expect(uploads.map((upload) => upload.name)).toEqual(["red.png", "green.jpg", "blue.webp", "mislabelled.jpg"]);
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.press("id:chat-composer-send");
  await app.waitFor("Not sent: the message has 4 images, and the model takes at most 3. Remove 1 to send.");
  await dismissNotices(app);
  await sleep(200);
  expect(posts).toEqual([]);
  await app.press("role:button[Remove from task: green.jpg]");
  // A picked image over the model's limit is uploaded, and its pill says the model cannot see it.
  await app.press("id:chat-composer-add");
  await app.press("Upload Files");
  await app.waitFor("label:Preview file: huge.png");
  await app.waitFor("text:/^Uploaded\\. Over 5 MiB \\(5,242,880 bytes\\): the model cannot be shown it/");
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.press("id:chat-composer-send");
  await app.waitFor("text:/^Not sent: huge\\.png is uploaded, but larger than 5 MiB \\(5,242,880 bytes\\)/");
  await dismissNotices(app);
  await sleep(200);
  expect(posts).toEqual([]);
  expect(app.value("id:chat-composer-input")).toBe("four of them");
  // Removed, the draft goes.
  await app.press("role:button[Remove from task: huge.png]");
  await app.waitFor("label:Preview file: huge.png", { state: "gone" });
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].file_references.map((reference: any) => reference.path)).toEqual(["red.png", "blue.webp", "mislabelled.jpg"]);
});

test("a picked file over 128 MiB is refused on the device with no upload and no Retry; one of exactly 128 MiB is uploaded", async () => {
  const picks = [
    [{ id: "p1", name: "too-big.mov", size: 134_217_729, type: "video/quicktime", preview: "" }],
    [{ id: "p2", name: "max.mov", size: 134_217_728, type: "video/quicktime", preview: "" }],
  ];
  const hostUploads: string[] = [];
  const { app } = await openChat({
    host: {
      "morph.file.pick": () => picks.shift() ?? [],
      "morph.file.upload": (data: any) => {
        hostUploads.push(data.id);
        return { ok: true, status: 200, statusText: "OK", body: JSON.stringify({ files: [{ name: "max.mov", dir_name: "workspace_dir", path: "max.mov", size_bytes: 134_217_728 }] }) };
      },
      "morph.file.release": null,
    },
  });
  await app.type("id:chat-composer-input", "two videos");
  await app.press("id:chat-composer-add");
  await app.press("Upload Files");
  await app.waitFor("Not uploaded: larger than 128 MiB (134,217,728 bytes), the most one upload takes.");
  expect(app.count("role:button[Retry upload]")).toBe(0);
  await app.press("id:chat-composer-add");
  await app.press("Upload Files");
  await app.waitUntil(() => hostUploads.length === 1);
  expect(hostUploads).toEqual(["p2"]);
  expect(app.value("id:chat-composer-input")).toBe("two videos");
});

test("an agent's or a proxy's refusal over a size says which limit and offers no Retry; a busy console may be retried", async () => {
  const { app, uploads } = await openChat({
    fail: (upload, attempt) => {
      if (upload.name === "red.png") return { status: 413, body: { error: 'file "red.png" exceeds 128 MiB (134217728 bytes)', code: "upload_file_too_large", limit_bytes: 134217728 } };
      if (upload.name === "green.jpg") return { status: 413, headers: { "content-type": "text/html" }, body: "<html><body><h1>413 Request Entity Too Large</h1></body></html>" } as any;
      if (upload.name === "blue.webp" && attempt === 1) return { status: 503, headers: { "Retry-After": "5" }, body: { error: "the console is receiving other uploads; try again in a few seconds", code: "upload_busy" } } as any;
      return null;
    },
  });
  await app.type("id:chat-composer-input", "keep");
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`, `${FIXTURES}/green.jpg`, `${FIXTURES}/blue.webp`] });
  await app.waitFor("The agent refused the file: it takes at most 128 MiB (134,217,728 bytes) per file.");
  await app.waitFor("text:/^The server, or a proxy in front of it, refused the upload as too large \\(HTTP 413\\) and gave no limit/");
  await app.waitFor("text:/^The console is receiving other uploads\\./");
  // Only the busy one has Retry.
  expect(app.count("role:button[Retry upload]")).toBe(1);
  await app.press("role:button[Retry upload]");
  await app.waitUntil(() => uploads.filter((upload) => upload.name === "blue.webp").length === 2);
  await app.waitUntil(() => app.count("role:button[Retry upload]") === 0);
  expect(app.value("id:chat-composer-input")).toBe("keep");
});

test("at most two of a composer's uploads run at once, the next starts as one ends, in the order of the pastes", async () => {
  const { app, uploads, posts } = await openChat({ delay: () => 700 });
  await app.type("id:chat-composer-input", "three");
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`] });
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/green.jpg`] });
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/blue.webp`] });
  await app.waitUntil(() => uploads.length === 2);
  await sleep(300);
  // The third waits for one of the first two.
  expect(uploads.length).toBe(2);
  await app.waitUntil(() => uploads.length === 3, { timeout: 4000 });
  expect(uploads[2].at - uploads[0].at).toBeGreaterThan(500);
  expect(uploads.map((upload) => upload.name)).toEqual(["red.png", "green.jpg", "blue.webp"]);
  await app.waitUntil(() => app.enabled("id:chat-composer-send"), { timeout: 4000 });
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].file_references.map((reference: any) => reference.path)).toEqual(["red.png", "green.jpg", "blue.webp"]);
});

test("a send refused because the agent's file cache let an attachment go marks it to upload again and keeps the draft", async () => {
  let refuseOnce = true;
  const sent: any[] = [];
  const { app, uploads } = await openChat({
    extraApi: {
      "POST /proxy:/tasks": (request: ApiRequest) => {
        if (refuseOnce) {
          refuseOnce = false;
          return { status: 400, body: { error: "file_references[0]: file does not exist" } };
        }
        sent.push(request.json);
        return { body: { id: "task-1", status: "queued", topic_id: "topic-1" } };
      },
    },
  });
  await app.type("id:chat-composer-input", "about this");
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`] });
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.press("id:chat-composer-send");
  await app.waitFor("text:/^The agent no longer has this file \\(its file cache let it go\\)\\. Upload it again with Retry upload\\./");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "about this");
  await dismissNotices(app);
  await app.press("role:button[Retry upload]");
  await app.waitUntil(() => uploads.length === 2);
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => sent.length === 1);
  expect(sent[0].file_references).toEqual([{ dir_name: "workspace_dir", path: "red.png" }]);
});

test("while a message is edited a pasted image is refused with the reason, and the edit and the draft are kept", async () => {
  const task = { id: "t1", task: "Where do foxes live?", topic_id: "topic-1", status: "done", created_at: NOW, started_at: NOW, finished_at: NOW, result: { final: { output: "Woods." } } };
  const { app, uploads } = await openChat({ extraApi: { "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: request.uri?.includes("topic_id=topic-1") ? [task] : [] } }) } });
  await app.waitFor("Woods.");
  await app.type("id:chat-composer-input", "unsent thought");
  await app.press("id:chat-edit");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "Where do foxes live?");
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`] });
  await app.waitFor("Finish or cancel the edit before pasting images: an edit sends text only.");
  expect(app.value("id:chat-composer-input")).toBe("Where do foxes live?");
  expect(app.count("label:Preview file: red.png")).toBe(0);
  await dismissNotices(app);
  await app.press("role:button[Cancel]");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "unsent thought");
  await sleep(200);
  expect(uploads).toEqual([]);
});

test("the TODO list's composer takes words only: a pasted image is refused with the reason, its text goes in", async () => {
  const { app, calls } = await openConsole({ location: "/e/default/todo", api: { "GET /proxy:/todo/tasks": { body: { items: [] } } } });
  await app.waitFor("id:chat-composer-input");
  await app.paste("id:chat-composer-input", { text: "water the plants", files: [`${FIXTURES}/red.png`] });
  await app.waitFor("A job is written in words: pasted images are not added.");
  await app.waitUntil(() => app.value("id:chat-composer-input") === "water the plants");
  expect(calls.some((call) => call.uri === "/files/upload")).toBe(false);
});

for (const platform of ["android", "ios"] as const) {
  test(`in the ${platform} app a pasted image is attached and sent the same way, through the app's own upload`, async () => {
    const uploads: Upload[] = [];
    const posts: any[] = [];
    const { app } = await openConsole({
      platform,
      location: "/e/default/chat/topic-1",
      api: {
        "GET /proxy:/todo/tasks": { body: { items: [] } },
        "GET /proxy:/topics": TOPICS,
        "GET /proxy:/tasks": { body: { items: [] } },
        "POST /proxy:/files/upload": (request: ApiRequest) => {
          const upload = uploadOf(request);
          uploads.push(upload);
          return { body: { files: [{ name: upload.name, dir_name: "workspace_dir", path: upload.name, size_bytes: 78 }] } };
        },
        "POST /proxy:/tasks": (request: ApiRequest) => {
          posts.push(request.json);
          return { body: { id: "task-1", status: "queued", topic_id: "topic-1" } };
        },
      },
    });
    await app.waitFor("id:chat-composer-input");
    await app.type("id:chat-composer-input", "on the phone");
    // The test host types a .bmp as generic binary: the bytes still say what it is.
    await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/green.jpg`, `${FIXTURES}/dark.bmp`] });
    await app.waitUntil(() => uploads.length === 1);
    expect(uploads[0].name).toBe("green.jpg");
    expect(uploads[0].type).toBe("image/jpeg");
    await app.waitFor("text:/^Not added: dark\\.bmp \\(BMP\\)/");
    expect(app.value("id:chat-composer-input")).toBe("on the phone");
    await dismissNotices(app);
    await app.waitUntil(() => app.enabled("id:chat-composer-send"));
    await app.press("id:chat-composer-send");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0].file_references).toEqual([{ dir_name: "workspace_dir", path: "green.jpg" }]);
  });
}

test("in the Android app, images the runtime could not read are said next to the composer the paste was made in, and nowhere else", async () => {
  const { app } = await openConsole({
    platform: "android",
    location: "/e/default/chat/topic-1",
    api: { "GET /proxy:/todo/tasks": { body: { items: [] } }, "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("id:chat-composer-input");
  // Not in the composer (nothing focused): nothing is said.
  await app.host.send("morph.paste.refused", { reason: "too_large", count: 1 });
  await sleep(200);
  expect(app.texts().some((text) => text.startsWith("Not added"))).toBe(false);
  await app.type("id:chat-composer-input", "draft stays");
  await app.host.send("morph.paste.refused", { reason: "too_large", count: 1 });
  await app.waitFor("Not added: the pasted image is larger than 128 MiB (134,217,728 bytes), the most one upload takes.");
  await app.host.send("morph.paste.refused", { reason: "batch_too_large", count: 3 });
  await app.waitFor("text:/^Not added: the pasted images are larger than 256 MiB \\(268,435,456 bytes\\) in all/");
  await app.host.send("morph.paste.refused", { reason: "unreadable", count: 2 });
  await app.waitFor("Not added: the pasted image could not be read. Copy it again, then paste.");
  // What the native part does not say this way is not taken for a refusal.
  await app.host.send("morph.paste.refused", { reason: "content://media/42", count: 1 });
  await sleep(200);
  expect(app.texts().filter((text) => text.startsWith("Not added")).length).toBe(3);
  expect(app.value("id:chat-composer-input")).toBe("draft stays");
});
