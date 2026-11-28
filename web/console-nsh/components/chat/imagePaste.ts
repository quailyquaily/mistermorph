// Images pasted into the chat composer (FT197): a screenshot or an image copied in another app,
// pasted with Ctrl/Cmd+V, the edit menu's Paste, Android's long-press Paste or a keyboard's image
// (Gboard's clipboard), or the iPhone's edit menu. The platform reads the clipboard when the user
// pastes and gives the field's `onPaste` the images as `File`s (the browser's ClipboardEvent files on
// the web; GPUI's, Android's and UIKit's clipboard on the apps); the app never reads the clipboard
// itself. The text of a paste goes into the field as before (nsh's `pasteBehavior` "insert"): an
// image paste adds attachments and never sends.
//
// What the platform says of a pasted file is not trusted: nsh names an image of unknown bytes
// `image.png` (nsh-core `PastedFile::image`), a browser may give no name or a wrong type. The bytes
// decide: PNG, JPEG and WebP (what the agent shows the model, internal/imagemime) are taken, named
// with their own extension; GIF, BMP, TIFF, HEIC, AVIF and SVG are refused with the formats that
// work (no conversion here; the desktop app turns BMP and TIFF into PNG before they get here); bytes
// that are no image, an empty file or a truncated PNG/WebP are refused as unreadable. An image over
// the model's 5 MiB, or past the message's three images, is refused before it is uploaded: the
// console's agent fails a task with a larger image and shows the model no more than three
// (cmd/mistermorph/consolecmd console_file_references.go).
//
// Pastes are taken one after another in the order the user made them: each waits for the one
// before, so a large first image read slowly never lands after a later small one, and the files of
// one paste keep their order. The draft is named when the paste comes; a paste whose draft is no
// longer on screen when its check ends (another conversation, a sent draft, a page left) is
// dropped without a word.
import { droppedNames } from "./fileDrop";

/** The console agent's limits for the images a message shows the model (consolecmd consoleLLMMaxImage*). */
export const MODEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MODEL_IMAGE_MAX_COUNT = 3;

/** What the bytes of a pasted file are. */
export type ImageKind = "png" | "jpeg" | "webp" | "gif" | "bmp" | "tiff" | "heic" | "avif" | "svg" | "";

/** The formats the model is shown, with the type and extension a pasted one is given. */
const MODEL_FORMATS: Partial<Record<ImageKind, { mime: string; extension: string }>> = {
  png: { mime: "image/png", extension: "png" },
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  webp: { mime: "image/webp", extension: "webp" },
};

/** Names of the formats refused, as the refusal says them. */
const FORMAT_NAMES: Record<string, string> = {
  gif: "GIF",
  bmp: "BMP",
  tiff: "TIFF",
  heic: "HEIC",
  avif: "AVIF",
  svg: "SVG",
};

/** How many bytes of a file's start and end the check reads. */
const HEAD = 64;
const TAIL = 64;

const ascii = (bytes: Uint8Array, at: number, text: string) => {
  if (bytes.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/** The image format of a file's first bytes, or "" for bytes that are none of them. */
export function sniffImage(head: Uint8Array): ImageKind {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "webp";
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "gif";
  if (ascii(b, 0, "BM") && b.length >= 14) return "bmp";
  if ((ascii(b, 0, "II") && b[2] === 42 && b[3] === 0) || (ascii(b, 0, "MM") && b[2] === 0 && b[3] === 42)) return "tiff";
  if (ascii(b, 4, "ftyp")) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "heic";
  }
  // Markup: an SVG or HTML (never shown as an image, never run).
  let at = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) at = 3;
  while (at < b.length && (b[at] === 0x20 || b[at] === 0x09 || b[at] === 0x0a || b[at] === 0x0d)) at++;
  if (b[at] === 0x3c /* < */) return "svg";
  return "";
}

/**
 * Whether the bytes of a file that starts as a `kind` image hold together as far as can be seen
 * without decoding it: a PNG starts with its header chunk and ends with its end chunk, a WebP's
 * RIFF size fits the file. A JPEG has no end that can be relied on (cameras append data after it).
 */
export function imageIntact(kind: ImageKind, head: Uint8Array, tail: Uint8Array, size: number): boolean {
  if (kind === "png") {
    if (size < 57 || !ascii(head, 12, "IHDR")) return false;
    for (let i = tail.length - 8; i >= 0; i--) if (ascii(tail, i, "IEND")) return true;
    return false;
  }
  if (kind === "webp") {
    if (head.length < 16) return false;
    const riff = (head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24)) >>> 0;
    if (riff + 8 > size) return false;
    return ascii(head, 12, "VP8 ") || ascii(head, 12, "VP8L") || ascii(head, 12, "VP8X");
  }
  if (kind === "jpeg") return size >= 125;
  return true;
}

/** Whether an attachment of this name is an image the agent shows the model (imagemime: by extension). */
export function isModelImageName(name: unknown): boolean {
  return /\.(png|jpe?g|webp)$/i.test(String(name || "").trim());
}

/** Names nsh and browsers give an image that had none: they say nothing of the image. */
const GENERIC_NAME = /^(image|clipboard|unknown|untitled|blob)(\.[a-z0-9]+)?$/i;

/**
 * The pasted files that may be images: of an image type, of none or of the generic binary type (the
 * bytes decide). Files of another known type (a PDF copied in a file manager) are left as before.
 */
export function pastedImageCandidates(event: unknown): File[] {
  const files = (event as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((file): file is File => {
    if (!file || typeof (file as Blob).size !== "number") return false;
    const type = String((file as File).type || "").trim().toLowerCase();
    return type === "" || type === "application/octet-stream" || type.startsWith("image/");
  });
}

export type PasteRefusalReason = "empty" | "unreadable" | "unsupported" | "corrupt" | "too_large" | "too_many";

export interface PasteRefusal {
  name: string;
  reason: PasteRefusalReason;
  /** The format of an unsupported image ("GIF"). */
  format?: string;
}

export interface CheckedPaste {
  /** The images to attach, in the paste's order, named and typed after their bytes. */
  accepted: File[];
  refused: PasteRefusal[];
}

export interface CheckOptions {
  /** Model images the draft has already: a paste adds up to MODEL_IMAGE_MAX_COUNT with them. */
  existingImages?: number;
  maxBytes?: number;
  maxCount?: number;
  /** The number the next unnamed image is named after (`clipboard-image-<n>.png`). */
  nextNumber?: () => number;
}

async function bytesOf(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** The name an accepted image is attached as: its own stem with the extension of its bytes. */
function imageName(name: string, extension: string, nextNumber: () => number): string {
  const trimmed = String(name || "").trim().replace(/[\\/]/g, "_");
  if (!trimmed || GENERIC_NAME.test(trimmed)) return `clipboard-image-${nextNumber()}.${extension}`;
  const dot = trimmed.lastIndexOf(".");
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${stem}.${extension}`;
}

/**
 * Looks at the bytes of pasted files: the images the model can be shown, within its limits, are
 * accepted (in their order, named and typed after their bytes); every other one is refused with
 * its reason. Reads only the first and last bytes of each file.
 */
export async function checkPastedImages(files: File[], options: CheckOptions = {}): Promise<CheckedPaste> {
  const maxBytes = options.maxBytes ?? MODEL_IMAGE_MAX_BYTES;
  const maxCount = options.maxCount ?? MODEL_IMAGE_MAX_COUNT;
  let counter = 0;
  const nextNumber = options.nextNumber ?? (() => ++counter);
  const looks = await Promise.all(
    files.map(async (file) => {
      const name = String(file?.name || "").trim();
      const size = Number(file?.size) || 0;
      if (size <= 0) return { file, name, refusal: { name, reason: "empty" as const } };
      try {
        const head = await bytesOf(file, 0, Math.min(HEAD, size));
        const tail = size > HEAD ? await bytesOf(file, Math.max(0, size - TAIL), size) : head;
        return { file, name, size, kind: sniffImage(head), head, tail };
      } catch {
        return { file, name, refusal: { name, reason: "unreadable" as const } };
      }
    }),
  );
  const accepted: File[] = [];
  const refused: PasteRefusal[] = [];
  let images = Math.max(0, options.existingImages ?? 0);
  for (const look of looks) {
    if ("refusal" in look && look.refusal) {
      refused.push(look.refusal);
      continue;
    }
    const { file, name, size = 0, kind = "", head, tail } = look as {
      file: File;
      name: string;
      size: number;
      kind: ImageKind;
      head: Uint8Array;
      tail: Uint8Array;
    };
    const format = MODEL_FORMATS[kind];
    if (!format) {
      refused.push(kind && FORMAT_NAMES[kind] ? { name, reason: "unsupported", format: FORMAT_NAMES[kind] } : { name, reason: "corrupt" });
      continue;
    }
    if (!imageIntact(kind, head, tail, size)) {
      refused.push({ name, reason: "corrupt" });
      continue;
    }
    if (size > maxBytes) {
      refused.push({ name, reason: "too_large" });
      continue;
    }
    if (images >= maxCount) {
      refused.push({ name, reason: "too_many" });
      continue;
    }
    images += 1;
    const named = imageName(name, format.extension, nextNumber);
    accepted.push(named === file.name && file.type === format.mime ? file : new File([file], named, { type: format.mime }));
  }
  return { accepted, refused };
}

/** The message key of a refusal reason (with `{names}`, and `{format}` for unsupported ones). */
export function pasteRefusalKey(reason: PasteRefusalReason): string {
  switch (reason) {
    case "unsupported":
      return "chat_composer_paste_unsupported";
    case "too_large":
      return "chat_composer_paste_too_large";
    case "too_many":
      return "chat_composer_paste_too_many";
    case "unreadable":
      return "chat_composer_paste_unreadable";
    default:
      return "chat_composer_paste_corrupt";
  }
}

/** One line per reason, in the order the reasons first came, naming the files (unnamed: "image"). */
export function pasteRefusalLines(refused: PasteRefusal[], text: (key: string, values: Record<string, string>) => string): string[] {
  const groups = new Map<string, { names: string[]; formats: string[] }>();
  for (const refusal of refused) {
    const key = pasteRefusalKey(refusal.reason);
    const group = groups.get(key) ?? { names: [], formats: [] };
    group.names.push(refusal.name || "image");
    if (refusal.format && !group.formats.includes(refusal.format)) group.formats.push(refusal.format);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) =>
    text(key, {
      names: droppedNames(group.names),
      format: group.formats.join(", "),
      max: String(MODEL_IMAGE_MAX_COUNT),
    }),
  );
}

/** What a composer's paste handling works with (the chat page's controller; fakes in tests). */
export interface ComposerPasteHost {
  /** Names the draft on screen now (as the drop's): a paste is applied only to the draft it was made in. */
  draft: () => string;
  /** Why the composer takes no images now (editing, sending, no agent, the TODO list), or "". */
  blocked: () => string;
  /** Model images the draft has (pending, uploaded or failed). */
  imageCount: () => number;
  /** Adds the images to the draft and uploads them, as picked files are; adds them before it returns. */
  takeFiles: (files: File[]) => void;
  /** Tells the user why images were not taken. */
  refuse: (text: string, type: "error" | "warning") => void;
  /** The words of a refusal (`pasteRefusalKey`). */
  text: (key: string, values: Record<string, string>) => string;
}

export type PasteOutcome = "taken" | "partial" | "refused" | "stale" | "empty";

/**
 * A composer's handling of pasted images: checked one paste after another, attached in the order
 * of the pastes, refused with a reason, never sent. The returned function takes the paste's
 * candidate files (`pastedImageCandidates`) and resolves once the paste is handled.
 */
export function createComposerPaste(host: ComposerPasteHost) {
  let queue: Promise<unknown> = Promise.resolve();
  let numbered = 0;
  const nextNumber = () => ++numbered;
  return function paste(files: File[]): Promise<PasteOutcome> {
    const list = (Array.isArray(files) ? files : []).filter(Boolean);
    if (list.length === 0) return Promise.resolve("empty");
    // Named and checked as the paste comes: what the user pasted into is the draft on screen now.
    const draft = host.draft();
    const blocked = host.blocked();
    if (blocked) {
      host.refuse(blocked, "warning");
      return Promise.resolve("refused");
    }
    const run = queue.then(async (): Promise<PasteOutcome> => {
      if (draft !== host.draft()) return "stale";
      const checked = await checkPastedImages(list, { existingImages: host.imageCount(), nextNumber });
      if (draft !== host.draft()) return "stale";
      // What held as the paste came may not hold now (a send began, an edit opened).
      const nowBlocked = host.blocked();
      if (nowBlocked) {
        host.refuse(nowBlocked, "warning");
        return "refused";
      }
      if (checked.accepted.length) host.takeFiles(checked.accepted);
      if (checked.refused.length) host.refuse(pasteRefusalLines(checked.refused, host.text).join("\n"), "error");
      if (!checked.accepted.length) return "refused";
      return checked.refused.length ? "partial" : "taken";
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

/** The draft's images over the model's limits, as the send refuses them: why, or "". */
export function draftImageLimitMessage(
  items: { name?: unknown; status?: unknown; sizeBytes?: unknown }[],
  text: (key: string, values: Record<string, string>) => string,
): string {
  const images = (Array.isArray(items) ? items : []).filter((item) => isModelImageName(item?.name));
  const large = images.filter((item) => Number(item?.sizeBytes) > MODEL_IMAGE_MAX_BYTES).map((item) => String(item?.name || ""));
  if (large.length) return text("chat_composer_images_too_large", { names: droppedNames(large) });
  if (images.length > MODEL_IMAGE_MAX_COUNT) {
    return text("chat_composer_images_too_many", { count: String(images.length), max: String(MODEL_IMAGE_MAX_COUNT), extra: String(images.length - MODEL_IMAGE_MAX_COUNT) });
  }
  return "";
}
