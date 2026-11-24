// Files the agent sent (task attachments): which show inline, which open in the file preview
// dialog, and the console's URL of their bytes.
//
// What previews follows the server's policy (internal/daemonruntime/console_attachment_preview.go):
// raster images and PDFs, and UTF-8 text by name or recorded type, at most
// RECEIVED_TEXT_PREVIEW_MAX_BYTES. Markup a browser would render (HTML, SVG, XML) never previews;
// nor do archives and other binaries, which keep their download alone. A file sent before text
// and PDF previews existed is recorded as application/octet-stream: its name decides, and the
// server checks the bytes.
const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The largest text file the server previews (2 MiB); larger ones are download only. */
export const RECEIVED_TEXT_PREVIEW_MAX_BYTES = 2 << 20;

// Keep in step with attachmentTextExtensions and attachmentTextNames on the server.
const TEXT_EXTENSIONS = new Set(
  `.txt .text .md .markdown .mdown .rst .adoc .asciidoc .org .log .out .csv .tsv .json .jsonl .ndjson
  .yaml .yml .toml .ini .cfg .conf .properties .env .diff .patch .tex .bib .srt .vtt
  .go .mod .sum .py .pyi .rb .php .pl .pm .lua .r .jl .js .mjs .cjs .ts .mts .cts .tsx .jsx .vue .svelte
  .java .kt .kts .scala .groovy .gradle .c .h .cc .cpp .cxx .hh .hpp .hxx .m .mm .cs .fs .swift
  .rs .zig .dart .ex .exs .erl .hrl .hs .clj .cljs .elm .ml .mli .nim .sh .bash .zsh .fish .ps1 .bat .cmd
  .sql .graphql .gql .proto .css .scss .sass .less .cmake .mk .dockerfile .tf .hcl .nix .gitignore .editorconfig`
    .split(/\s+/)
    .filter(Boolean),
);
const TEXT_NAMES = new Set(
  "readme license licence changelog makefile dockerfile containerfile procfile gemfile rakefile justfile vagrantfile notice authors contributing todo".split(" "),
);

function contentType(file) {
  return String(file?.content_type || "").trim().toLowerCase();
}

function baseName(file) {
  return String(file?.name || "").trim().replace(/\\/g, "/").split("/").pop().toLowerCase();
}

/** Whether a file's raster image shows inline on its card. */
export function canPreviewReceivedFile(file) {
  return RASTER_TYPES.has(contentType(file));
}

/** Whether the server may preview a file of this name and recorded type as text. */
export function isReceivedTextCandidate(file) {
  if (contentType(file).startsWith("text/plain")) return true;
  const base = baseName(file);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return TEXT_NAMES.has(base) || TEXT_EXTENSIONS.has(base);
  return TEXT_EXTENSIONS.has(base.slice(dot));
}

/**
 * How the file preview dialog shows a received file: "image", "pdf", "text", or "" when it cannot
 * (it keeps its download alone).
 */
export function receivedFilePreviewKind(file) {
  if (!file || !String(file.id || "").trim()) return "";
  const type = contentType(file);
  if (RASTER_TYPES.has(type)) return "image";
  if (type === "application/pdf") return "pdf";
  // Anything else recorded with a type of its own is not one the server previews.
  if (type && type !== "application/octet-stream" && !type.startsWith("text/plain")) return "";
  if (!type || type === "application/octet-stream") {
    if (baseName(file).endsWith(".pdf")) return "pdf";
  }
  return isReceivedTextCandidate(file) ? "text" : "";
}

/** Whether a received file opens in the file preview dialog. */
export function canOpenReceivedFile(file) {
  return receivedFilePreviewKind(file) !== "";
}

/** Whether a received text file is over the preview cap, by its recorded size. */
export function receivedFileTooLarge(file) {
  return receivedFilePreviewKind(file) === "text" && Number(file?.size_bytes) > RECEIVED_TEXT_PREVIEW_MAX_BYTES;
}

export function receivedFileURL(topicID, taskID, fileID, preview = false) {
  const query = new URLSearchParams({ topic_id: topicID, task_id: taskID, id: fileID });
  if (preview) query.set("preview", "1");
  return `/attachments?${query}`;
}
