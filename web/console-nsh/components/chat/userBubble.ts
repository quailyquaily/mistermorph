// The shape of a sent message's bubble (ChatHistoryItem): one frame around its text and the files
// it carried, whose pills (filePill.ts) sit inside it.

/** The sent bubble's frame. Its parts pad themselves: the text block, the file pills. */
export const BUBBLE_CLASS = "max-w-[557px] rounded-[14px] rounded-tr-[2px] border border-line-soft bg-card";

/**
 * The file pills' block inside the bubble: 3pt above and below, 4pt in from the sides, 4pt between
 * pills. A pill's ends are round (half its height, 13pt or more), more than the 10pt concentric with
 * the bubble's 14pt corners 4pt out, so its border and its hover and pressed fill stay inside the
 * bubble's curve at every corner, the 2pt tail included.
 */
export const FILES_CLASS = "gap-1 px-1 py-[3px]";
