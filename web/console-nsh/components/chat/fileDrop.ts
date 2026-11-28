// Files and directories dragged from the system's file manager onto the composer (FT195). nsh
// gives a drop to the closest view under the pointer that listens to `onFileDrop`, within its
// modal: the composer's frame listens, so a drop elsewhere on the page, on a drop target of
// another part, or over an open dialog never reaches it. The view hears `file:` URLs only; what
// they are (a file, a directory, something that cannot be read) is the host's to say
// (lib/platform.ts `resolveDroppedFiles`), and only the desktop app has such a host: a browser
// never tells a page where a dropped file is.
import { CONSOLE_LOCAL_ENDPOINT_REF } from "../../lib/core/endpoints.js";
import { hasFeature, isDesktop, type DroppedFiles, type PickedFile } from "../../lib/platform";

/** Whether drops from the file manager can be taken at all: the desktop app with a host that reads them. */
export const fileDropAvailable = () => isDesktop() && hasFeature("fileDrop");

/**
 * Whether a directory of this machine is one the agent at `endpointRef` can work in: the desktop
 * app's own agent only. Any other agent runs elsewhere, where the path names nothing (or something
 * else), so it is never sent one (the same rule as the workspace dialog's native folder picker).
 */
export function localDirectoryUsable(endpointRef: string): boolean {
  return isDesktop() && String(endpointRef || "").trim() === CONSOLE_LOCAL_ENDPOINT_REF;
}

/** The `file:` URLs of a drop event, in their order, without blanks. */
export function droppedURIs(event: unknown): string[] {
  const uris = (event as { uris?: unknown } | null)?.uris;
  return Array.isArray(uris) ? uris.map((uri) => String(uri ?? "").trim()).filter((uri) => uri !== "") : [];
}

/** How many names a refusal lists before it says "and N more". */
const NAMED = 3;

/** The names a refusal is about, shortened: `a.txt, b.txt, c.txt +2`. */
export function droppedNames(names: string[]): string {
  const list = (Array.isArray(names) ? names : []).map((name) => String(name ?? "").trim()).filter((name) => name !== "");
  const shown = list.slice(0, NAMED).join(", ");
  return list.length > NAMED ? `${shown} +${list.length - NAMED}` : shown;
}

/** The message key of a refused drop (`DroppedFiles.reason`). */
export function dropRefusalKey(reason: string): string {
  switch (reason) {
    case "multiple_directories":
      return "chat_composer_drop_multiple_directories";
    case "unreadable":
      return "chat_composer_drop_unreadable";
    default:
      return "chat_composer_drop_invalid";
  }
}

/** What a composer's drop handling works with (the chat page's controller; fakes in tests). */
export interface ComposerDropHost {
  /** Asks the host what the URLs are (`resolveDroppedFiles`). */
  resolve: (uris: string[]) => Promise<DroppedFiles>;
  /** Gives a file the host holds back to it (`releaseFile`). */
  release: (file: PickedFile) => void;
  /**
   * Names the draft on screen now: another conversation, another agent, a draft that was sent or
   * a page that was left give another name. An answer for a draft of another name is not applied.
   */
  draft: () => string;
  /** Why the composer takes nothing now (sending, editing a message, read-only), or "". */
  blocked: () => string;
  /** Why a directory of this machine cannot be the next message's workspace here, or "". */
  workspaceRefusal: () => string;
  /** Makes `dir` the workspace of the next message, as choosing one by hand does. */
  takeWorkspace: (dir: string) => void;
  /** Adds the files to the draft and uploads them, as picked files are. */
  takeFiles: (files: PickedFile[]) => void | Promise<void>;
  /** Tells the user why a drop was not taken. */
  refuse: (text: string, type: "error" | "warning") => void;
  /** The words of a refusal by the host (`dropRefusalKey`, with `{names}`). */
  refusalText: (key: string, names: string) => string;
  /** The words for a host that could not answer. */
  failedText: (error: unknown) => string;
}

/**
 * A composer's handling of drops from the file manager. The host looks at the whole drop first,
 * and it is taken whole or not at all: its files become attachments in the order of the drop, one
 * directory the workspace of the next message. A refused drop says why and changes nothing. No
 * message is sent and no task starts.
 *
 * The host answers later (it reads the disk). An answer for a draft that is no longer the one on
 * screen is dropped without a word and its files go back to the host: it never lands in another
 * conversation, on another agent, or in the draft after the one that was sent.
 */
export function createComposerDrop(host: ComposerDropHost) {
  return async function drop(uris: string[]): Promise<"taken" | "refused" | "stale" | "empty"> {
    const list = (Array.isArray(uris) ? uris : []).map((uri) => String(uri ?? "").trim()).filter((uri) => uri !== "");
    if (list.length === 0) return "empty";
    const blocked = host.blocked();
    if (blocked) {
      host.refuse(blocked, "warning");
      return "refused";
    }
    const draft = host.draft();
    let dropped: DroppedFiles;
    try {
      dropped = await host.resolve(list);
    } catch (error) {
      if (draft !== host.draft()) return "stale";
      host.refuse(host.failedText(error), "error");
      return "refused";
    }
    const giveBack = () => {
      if (dropped.ok) for (const file of dropped.files) host.release(file);
    };
    if (draft !== host.draft()) {
      giveBack();
      return "stale";
    }
    if (!dropped.ok) {
      host.refuse(host.refusalText(dropRefusalKey(dropped.reason), droppedNames(dropped.names)), "error");
      return "refused";
    }
    if (dropped.files.length === 0 && !dropped.directory) return "empty";
    // What held before the host answered may not hold now (a send began, an edit opened).
    const nowBlocked = host.blocked();
    const refusal = nowBlocked || (dropped.directory ? host.workspaceRefusal() : "");
    if (refusal) {
      giveBack();
      host.refuse(refusal, nowBlocked ? "warning" : "error");
      return "refused";
    }
    // The workspace first: the files are uploaded into the workspace the message will use.
    if (dropped.directory) host.takeWorkspace(dropped.directory);
    if (dropped.files.length) await host.takeFiles(dropped.files);
    return "taken";
  };
}
