// The file preview dialog's state (pages/chat/FilePreviewDialog.tsx): which files it steps through,
// the one it shows, and where that one's bytes come from.
//
// A file attached to the composer and not sent yet previews from the device first: an image the
// user picked shows from the host's preview URL (PickedFile.preview, the host's: valid until the
// file is released, never revoked here) or, for a pasted browser `File`, from an object URL made
// here (revoked as soon as the preview shows something else or closes). That works before the
// upload ends, after it failed, and in a new topic, where an upload into a workspace has no topic
// to fetch it back through. Anything else (a PDF, text, a sent file) comes from the agent once it
// is uploaded (`fetchRemote`), as before.
//
// Every load is numbered: a fetch or a read that ends after the preview closed, moved on or lost
// its file changes nothing, so it can never reopen a preview or show a removed file.
import { signal, untracked } from "nsh";
import type { PickedFile } from "../../lib/platform";

export interface FilePreviewState {
  open: boolean;
  loading: boolean;
  name: string;
  kind: "" | "image" | "pdf" | "text";
  url: string;
  text: string;
  error: string;
  items: any[];
  index: number;
  /** What the preview steps through: the composer's attachments, or a sent message's files. */
  source: "" | "draft" | "sent";
}

export const CLOSED_PREVIEW: FilePreviewState = {
  open: false,
  loading: false,
  name: "",
  kind: "",
  url: "",
  text: "",
  error: "",
  items: [],
  index: -1,
  source: "",
};

/** Extensions shown as images. SVG is not one: it previews as its text. */
export const PREVIEW_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"]);

export function fileExtension(name: unknown): string {
  const normalized = String(name || "").trim().toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index >= 0 ? normalized.slice(index) : "";
}

/** Whether a file of this name and media type shows as an image (never an SVG). */
export function isPreviewImage(name: unknown, type: unknown): boolean {
  const mime = String(type || "").trim().toLowerCase();
  const extension = fileExtension(name);
  if (mime === "image/svg+xml" || extension === ".svg") return false;
  return PREVIEW_IMAGE_EXTENSIONS.has(extension) || mime.startsWith("image/");
}

export function isBrowserFile(file: unknown): file is File {
  return typeof File !== "undefined" && file instanceof File;
}

/** A file the host keeps (lib/platform's PickedFile), as opposed to a browser `File` (a paste). */
export function isPickedFile(file: unknown): file is PickedFile {
  return !!file && !isBrowserFile(file) && typeof (file as PickedFile).id === "string" && "preview" in (file as object);
}

/** Where an attachment's image shows from on this device: the host's URL, a pasted `File`, or nothing. */
export function localImageSource(item: any): { url: string } | { file: File } | null {
  const source = item?.sourceFile;
  if (!source) return null;
  if (isBrowserFile(source)) return isPreviewImage(source.name || item?.name, source.type) ? { file: source } : null;
  if (isPickedFile(source)) {
    const url = String(source.preview || "").trim();
    return url && isPreviewImage(source.name || item?.name, source.type) ? { url } : null;
  }
  return null;
}

/** Whether a composer attachment can be previewed now: an image on the device, or any file the agent has. */
export function draftFilePreviewable(item: any): boolean {
  return String(item?.status || "").trim() === "ready" || localImageSource(item) !== null;
}

/** The kind of preview for bytes of this name and type, or "" for text to try. */
export function previewKind(name: unknown, type: unknown): "image" | "pdf" | "" {
  const mime = String(type || "").trim().toLowerCase();
  if (isPreviewImage(name, mime)) return "image";
  if (fileExtension(name) === ".pdf" || mime === "application/pdf") return "pdf";
  return "";
}

export interface FilePreviewDeps {
  /** The bytes of a file uploaded to the agent; rejects when it has none to give. */
  fetchRemote: (item: any) => Promise<Blob>;
  /** What the dialog says of a file it cannot show. */
  unavailable: () => string;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

export type FilePreview = ReturnType<typeof createFilePreview>;

export function createFilePreview(deps: FilePreviewDeps) {
  const state = signal<FilePreviewState>(CLOSED_PREVIEW);
  const createURL = deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeURL = deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  let sequence = 0;
  // The object URL this preview made, the only one it revokes.
  let ownedURL = "";

  function releaseOwnedURL() {
    if (ownedURL) revokeURL(ownedURL);
    ownedURL = "";
  }

  function close() {
    sequence += 1;
    releaseOwnedURL();
    state.set(CLOSED_PREVIEW);
  }

  /** Whether load `seq` is still the one on screen. */
  const current = (seq: number) => seq === sequence && untracked(state).open;

  async function load(item: any) {
    releaseOwnedURL();
    const seq = ++sequence;
    const name = String(item?.name || "").trim();
    state.update((s) => ({ ...s, open: true, loading: true, name, kind: "", url: "", text: "", error: "" }));
    const local = localImageSource(item);
    if (local && "url" in local) {
      state.update((s) => ({ ...s, loading: false, kind: "image", url: local.url }));
      return;
    }
    try {
      let blob: Blob;
      if (local) blob = local.file;
      else if (isBrowserFile(item?.sourceFile)) blob = item.sourceFile;
      else if (String(item?.status || "").trim() === "ready") blob = await deps.fetchRemote(item);
      else throw new Error(deps.unavailable());
      if (!current(seq)) return;
      const kind = previewKind(name || (blob as File)?.name, blob?.type);
      if (kind) {
        ownedURL = createURL(blob);
        state.update((s) => ({ ...s, kind, url: ownedURL }));
      } else {
        const buffer = await blob.arrayBuffer();
        if (!current(seq)) return;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        state.update((s) => ({ ...s, kind: "text", text }));
      }
    } catch {
      if (current(seq)) state.update((s) => ({ ...s, error: deps.unavailable() }));
    } finally {
      if (current(seq)) state.update((s) => ({ ...s, loading: false }));
    }
  }

  /** Opens on the item with `id` among `items` (the first when it is not there); nothing when `items` is empty. */
  function open(items: any[], id: string, source: "draft" | "sent") {
    if (!items.length) return;
    const index = Math.max(0, items.findIndex((candidate) => String(candidate?.id || "").trim() === String(id || "").trim()));
    state.update((s) => ({ ...s, items, index, source }));
    void load(items[index]);
  }

  function navigate(offset: number) {
    const s = untracked(state);
    const next = s.index + offset;
    if (!s.open || next < 0 || next >= s.items.length) return;
    state.update((now) => ({ ...now, index: next }));
    void load(s.items[next]);
  }

  /**
   * The composer's attachments changed while it previews them: removed ones leave the list (the
   * preview closes when the one it shows went, since its bytes may be gone with it), and the rest
   * follow their latest state. Only previewable ones are kept.
   */
  function followDraft(items: any[], previewable: (item: any) => boolean) {
    const s = untracked(state);
    if (!s.open || s.source !== "draft") return;
    const byID = new Map(items.map((item) => [String(item?.id || ""), item]));
    const shownID = String(s.items[s.index]?.id || "");
    const shown = byID.get(shownID);
    if (!shown || !previewable(shown)) {
      close();
      return;
    }
    const next = s.items.map((item) => byID.get(String(item?.id || ""))).filter((item) => item && previewable(item));
    const index = next.findIndex((item) => String(item?.id || "") === shownID);
    state.update((now) => ({ ...now, items: next, index }));
  }

  return { state, open, navigate, close, followDraft };
}
