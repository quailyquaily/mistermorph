// FT183: previewing a file the agent sent (send_file) in the chat's file preview dialog.
//
// A received file the dialog can show (an image, a PDF, UTF-8 text) has a preview button beside
// its download, and its name and inline image open the dialog too; an archive or another binary
// keeps the download alone. The dialog opens on that file, steps through the reply's other files
// that preview (never one that does not), and fetches the bytes from the console's attachment
// route (`/attachments?preview=1`) with the session's token. A file it cannot show (refused,
// over the 2 MiB text cap, not UTF-8) says why and offers the card's download, as a PDF does.
import { expect, test } from "nsh/test";
import { openConsole, ORIGIN, type ApiRequest } from "./harness";
import {
  canOpenReceivedFile,
  canPreviewReceivedFile,
  isReceivedTextCandidate,
  receivedFilePreviewKind,
  receivedFileTooLarge,
  RECEIVED_TEXT_PREVIEW_MAX_BYTES,
} from "../lib/core/received-files.js";
import { createFilePreview } from "../components/chat/filePreview";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Files", created_at: NOW, updated_at: NOW }] } };
const PDF = { id: "f-pdf", name: "report.pdf", content_type: "application/pdf", size_bytes: 20 };
const MD = { id: "f-md", name: "notes.md", content_type: "text/plain; charset=utf-8", size_bytes: 22 };
const PNG = { id: "f-png", name: "photo.png", content_type: "image/png", size_bytes: 40 };
const ZIP = { id: "f-zip", name: "archive.zip", content_type: "application/octet-stream", size_bytes: 64 };

function reply(attachments: unknown[]) {
  return {
    id: "t1",
    task: "Send the files",
    topic_id: "topic-1",
    status: "done",
    created_at: NOW,
    finished_at: NOW,
    result: { final: { output: "Here are the files." } },
    attachments,
  };
}

/** What the console's attachment route serves for a preview, by file id. */
const PREVIEWS: Record<string, { headers: Record<string, string>; body: string }> = {
  "f-pdf": { headers: { "content-type": "application/pdf" }, body: "%PDF-1.4\n%%EOF\n" },
  "f-md": { headers: { "content-type": "text/plain; charset=utf-8" }, body: "# Notes\n\n*hello*, file" },
  "f-png": { headers: { "content-type": "image/png" }, body: "\x89PNG\r\n" },
};

function attachments(request: ApiRequest) {
  if (request.query.get("preview") !== "1") return { headers: { "content-type": "application/octet-stream" }, body: "bytes" };
  return PREVIEWS[request.query.get("id") || ""] ?? { status: 400, body: { error: "file type has no preview; download it instead" } };
}

async function openChat(files: unknown[], options: { api?: Record<string, unknown>; host?: Record<string, unknown>; android?: boolean } = {}) {
  const opened = await openConsole({
    ...(options.android ? { platform: "android" as const } : {}),
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": { body: { items: [reply(files)] } },
      "GET /proxy:/todo/tasks": { body: { items: [] } },
      "GET /attachments": attachments,
      ...((options.api || {}) as any),
    },
    host: options.host,
  });
  await opened.app.waitFor("text:Here are the files.");
  return opened;
}

const previewRequests = (calls: ApiRequest[]) => calls.filter((call) => call.path === "/attachments" && call.query.get("preview") === "1");

/* ---------- which received files preview ---------- */

test("images, PDFs and text preview; archives, binaries and markup a browser would render do not", () => {
  expect(receivedFilePreviewKind(PNG)).toBe("image");
  expect(receivedFilePreviewKind(PDF)).toBe("pdf");
  expect(receivedFilePreviewKind(MD)).toBe("text");
  expect(receivedFilePreviewKind(ZIP)).toBe("");
  for (const name of ["data.json", "table.csv", "run.log", "main.go", "app.tsx", "README", "Makefile", "NOTES.TXT"]) {
    expect(receivedFilePreviewKind({ id: "x", name, content_type: "application/octet-stream" })).toBe("text");
  }
  for (const name of ["page.html", "drawing.svg", "feed.xml", "program", "archive.tar.gz", "movie.mp4", "sheet.xlsx"]) {
    expect(receivedFilePreviewKind({ id: "x", name, content_type: "application/octet-stream" })).toBe("");
  }
  // Sent before PDFs previewed: the name decides, and the server checks the bytes.
  expect(receivedFilePreviewKind({ id: "x", name: "old.pdf", content_type: "application/octet-stream" })).toBe("pdf");
  expect(receivedFilePreviewKind({ id: "x", name: "old.pdf" })).toBe("pdf");
  // A type of its own the server does not preview wins over the name.
  expect(receivedFilePreviewKind({ id: "x", name: "page.txt", content_type: "text/html" })).toBe("");
  expect(isReceivedTextCandidate({ name: "data", content_type: "text/plain" })).toBe(true);
  // Only raster images show inline on the card.
  expect(canPreviewReceivedFile(PNG)).toBe(true);
  expect(canPreviewReceivedFile(PDF)).toBe(false);
  expect(canOpenReceivedFile({ name: "notes.md" })).toBe(false);
  // The text cap is 2 MiB, by the recorded size.
  expect(RECEIVED_TEXT_PREVIEW_MAX_BYTES).toBe(2 * 1024 * 1024);
  expect(receivedFileTooLarge({ ...MD, size_bytes: RECEIVED_TEXT_PREVIEW_MAX_BYTES })).toBe(false);
  expect(receivedFileTooLarge({ ...MD, size_bytes: RECEIVED_TEXT_PREVIEW_MAX_BYTES + 1 })).toBe(true);
  expect(receivedFileTooLarge({ ...PDF, size_bytes: RECEIVED_TEXT_PREVIEW_MAX_BYTES + 1 })).toBe(false);
});

test("bytes that are not UTF-8 say why, and so does a fetch the server refused as too large", async () => {
  const reasons: unknown[] = [];
  const blobs: Record<string, () => Promise<Blob>> = {
    "bad.txt": async () => new Blob([new Uint8Array([0x6f, 0x6b, 0xff, 0xfe])], { type: "text/plain" }),
    "big.txt": async () => {
      throw Object.assign(new Error("too large"), { status: 413 });
    },
    "gone.txt": async () => {
      throw Object.assign(new Error("no preview"), { status: 400 });
    },
  };
  const preview = createFilePreview({
    fetchRemote: (item) => blobs[item.name](),
    unavailable: (reason, item) => {
      reasons.push([reason, item?.name]);
      return `cannot: ${reason}`;
    },
  });
  const items = Object.keys(blobs).map((name) => ({ id: name, name, status: "ready", received: true }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  preview.open(items, "bad.txt", "sent");
  await settle();
  await settle();
  expect(preview.state()).toMatchObject({ kind: "", text: "", error: "cannot: not_text", loading: false });
  preview.navigate(1);
  await settle();
  expect(preview.state()).toMatchObject({ kind: "", error: "cannot: too_large", loading: false });
  preview.navigate(1);
  await settle();
  expect(preview.state()).toMatchObject({ kind: "", error: "cannot: failed", loading: false });
  expect(reasons).toEqual([
    ["not_text", "bad.txt"],
    ["too_large", "big.txt"],
    ["failed", "gone.txt"],
  ]);
});

/* ---------- the card's actions ---------- */

test("a PDF, a Markdown file and a PNG each offer a preview beside their download; a .zip offers the download alone", async () => {
  const { app } = await openChat([PDF, MD, PNG, ZIP]);
  await app.waitFor("label:Preview report.pdf");
  for (const file of [PDF, MD, PNG]) {
    expect(app.count(`label:Preview ${file.name}`) >= 1).toBe(true);
    expect(app.count(`label:Download ${file.name}`)).toBe(1);
  }
  expect(app.count("label:Preview archive.zip")).toBe(0);
  expect(app.count("label:Download archive.zip")).toBe(1);
  // One preview icon button and one pressable name per previewable file, 32pt on a desktop.
  expect(app.count("id:chat-received-file-preview.xs")).toBe(3);
  expect(app.count("id:chat-received-file-name")).toBe(3);
  // Nothing is fetched for the dialog before it opens (the PNG's inline picture aside).
  await app.wait(50);
  expect(app.count("id:chat-file-preview-text")).toBe(0);
});

test("the dialog opens on the file, fetches it with the session's token and steps through the reply's previewable files only", async () => {
  const { app, calls } = await openChat([PDF, MD, ZIP, PNG]);
  await app.waitFor("label:Preview notes.md");
  await app.press("id:chat-received-file-preview.xs >> nth=1");
  await app.waitFor("id:chat-file-preview-text");
  expect(app.texts()).toContain("# Notes\n\n*hello*, file");
  const request = previewRequests(calls).find((call) => call.query.get("id") === "f-md")!;
  expect(request).toBeTruthy();
  expect(request.url.startsWith(`${ORIGIN}/api/attachments?`)).toBe(true);
  expect(request.query.get("topic_id")).toBe("topic-1");
  expect(request.query.get("task_id")).toBe("t1");
  const headers = request.headers as Record<string, string>;
  expect(headers.Authorization || headers.authorization).toBe("Bearer token-1");
  // Previous: the PDF, shown in a web view.
  expect(app.enabled("label:Previous file")).toBe(true);
  await app.press("label:Previous file");
  await app.waitFor("id:chat-file-preview-pdf");
  expect(app.enabled("label:Previous file")).toBe(false);
  // Not every platform's web view draws a PDF: its download is beside it.
  expect(app.count("id:chat-file-preview-download.idle")).toBe(1);
  // Next twice: the PNG; the .zip between them is not in the list, and nothing follows the PNG.
  await app.press("label:Next file");
  await app.waitFor("id:chat-file-preview-text");
  await app.press("label:Next file");
  await app.waitFor("id:chat-file-preview-image");
  expect(app.enabled("label:Next file")).toBe(false);
  expect(previewRequests(calls).some((call) => call.query.get("id") === "f-zip")).toBe(false);
  // An image or text that shows needs no download in the dialog.
  expect(app.count("id:chat-file-preview-download.idle")).toBe(0);
  await app.press("id:chat-file-preview-close");
  await app.waitUntil(() => app.count("id:chat-file-preview-image") === 0);
  // Opened again, it starts on the file pressed.
  await app.press("id:chat-received-file-name >> nth=0");
  await app.waitFor("id:chat-file-preview-pdf");
});

test("pressing the file's name opens the dialog on it", async () => {
  const { app } = await openChat([PDF, MD]);
  await app.waitFor("label:Preview report.pdf");
  await app.press("id:chat-received-file-name >> nth=0");
  await app.waitFor("id:chat-file-preview-pdf");
  expect(app.count("text:report.pdf") >= 1).toBe(true);
});

test("an image keeps its inline picture, and pressing it opens the dialog on the image", async () => {
  const { app, calls } = await openChat([PNG, MD]);
  await app.waitFor("id:chat-received-file-image");
  await app.press("id:chat-received-file-image");
  await app.waitFor("id:chat-file-preview-image");
  // The inline picture and the dialog both fetched the preview.
  expect(previewRequests(calls).filter((call) => call.query.get("id") === "f-png").length >= 2).toBe(true);
  expect(app.enabled("label:Next file")).toBe(true);
});

/* ---------- what cannot show ---------- */

test("a preview the server refuses says so and offers the download, which saves the file itself", async () => {
  const OLD = { id: "f-old", name: "old.log", content_type: "application/octet-stream", size_bytes: 12 };
  const saves: any[] = [];
  const { app } = await openChat([OLD], {
    host: {
      "morph.file.save": (data: any) => {
        saves.push(data);
        return "saved";
      },
    },
  });
  await app.waitFor("label:Preview old.log");
  await app.press("label:Preview old.log");
  await app.waitFor("id:chat-file-preview-error");
  expect(app.texts()).toContain("This file cannot be previewed. Download it instead.");
  await app.press("id:chat-file-preview-download.idle");
  await app.waitFor("id:chat-file-preview-download.saved");
  expect(saves.length).toBe(1);
  expect(saves[0].name).toBe("old.log");
  expect(saves[0].url.startsWith(`${ORIGIN}/api/attachments?`)).toBe(true);
  expect(new URL(saves[0].url).searchParams.get("preview")).toBe(null);
  expect(saves[0].headers.Authorization).toBe("Bearer token-1");
  // The card's download shows the same save.
  expect(app.count("id:chat-received-file-download.xs.saved")).toBe(1);
});

test("a text file over 2 MiB says it is too large without fetching it; a 413 from the server says the same", async () => {
  const BIG = { id: "f-big", name: "big.log", content_type: "application/octet-stream", size_bytes: 3 * 1024 * 1024 };
  const GROWN = { id: "f-grown", name: "grown.txt", content_type: "text/plain; charset=utf-8", size_bytes: 10 };
  const { app, calls } = await openChat([BIG, GROWN], {
    api: { "GET /attachments": (request: ApiRequest) => (request.query.get("id") === "f-grown" ? { status: 413, body: { error: "too large" } } : attachments(request)) },
  });
  await app.waitFor("label:Preview big.log");
  await app.press("label:Preview big.log");
  await app.waitFor("id:chat-file-preview-error");
  const TOO_LARGE = "This text file is larger than 2 MiB, too large to preview. Download it instead.";
  expect(app.texts()).toContain(TOO_LARGE);
  expect(previewRequests(calls).some((call) => call.query.get("id") === "f-big")).toBe(false);
  expect(app.count("id:chat-file-preview-download.idle")).toBe(1);
  await app.press("label:Next file");
  await app.waitUntil(() => previewRequests(calls).some((call) => call.query.get("id") === "f-grown"));
  await app.waitFor("id:chat-file-preview-error");
  expect(app.texts()).toContain(TOO_LARGE);
});

/* ---------- the phone ---------- */

test("on the phone the preview button is a 44pt touch target and opens the dialog's sheet on the file", async () => {
  const { app } = await openChat([MD, ZIP], { android: true });
  await app.waitFor("id:chat-received-file-preview.md");
  expect(app.count("id:chat-received-file-preview.md")).toBe(1);
  await app.press("id:chat-received-file-preview.md");
  await app.waitFor("id:chat-file-preview-text");
  expect(app.texts()).toContain("# Notes\n\n*hello*, file");
  // One previewable file: no stepping.
  expect(app.count("label:Next file")).toBe(0);
});
