// A file pill: a file attached to the composer (ChatComposer) or carried by a sent message
// (ChatHistoryItem). Both are round at the ends as the one-row composer is (composerField.ts,
// COMPOSER_RADIUS: half its height), whatever their height and on every width: `rounded-full` takes
// half of each pill's own height, so a pill with a second line (uploading, failed) stays a capsule.
// Their texts start and end past the curve (the padding), so a long name is cut inside the pill.
import type { IconName } from "../ui";
import { isPreviewImage } from "./filePreview";

/** The pill's shape: fully round ends. */
export const FILE_PILL_SHAPE = "rounded-full";

/** A composer attachment: its frame (the border colour says failed or not) and padding. */
export function draftFilePillClass(failed: boolean): string {
  return `max-w-full flex-row items-center gap-1 ${FILE_PILL_SHAPE} border ${failed ? "border-danger" : "border-line-faint"} bg-card py-1 pl-3 pr-1`;
}

/** A sent message's file: a full-width pill in the bubble, a soft fill on hover and press. */
export const SENT_FILE_PILL_CLASS = `group/file flex-row items-center gap-2 ${FILE_PILL_SHAPE} border border-line-faint py-[5px] pl-[11px] pr-3 hover:bg-hover-soft`;

/** The pill's glyph: an image's, or the paperclip. */
export function fileIcon(name: unknown, type?: unknown): IconName {
  return isPreviewImage(name, type) ? "PhImage" : "PhPaperclip";
}
