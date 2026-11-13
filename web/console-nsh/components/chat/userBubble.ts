// The shape of a sent message's bubble (ChatHistoryItem): one frame around its text and the files
// it carried, and the corners of the file rows inside it.

/** The sent bubble's frame. Its parts pad themselves: the text block, the file rows. */
export const BUBBLE_CLASS = "max-w-[557px] rounded-[14px] rounded-tr-[2px] border border-line-soft bg-card";

/** The file rows' block inside the bubble: 3pt above and below, 4pt in from the sides, so a row's
 * hover and pressed fill never reaches the bubble's edge. */
export const FILES_CLASS = "px-1 py-[3px]";

/**
 * A file row's corners. The rows are inset in the bubble (FILES_CLASS), and their fill keeps the
 * ui-kit's 2pt corners, but a row at a 14pt corner of the bubble rounds that corner 10pt so its
 * fill follows the bubble's curve (concentric, 4pt in) instead of covering it: the last row's bottom
 * corners, and the first row's top left when no text sits above it (the top right is the 2pt tail).
 */
export function fileRowCornerClass(index: number, count: number, textAbove: boolean) {
  const corners = ["rounded-(--radius)"];
  if (index === 0 && !textAbove) corners.push("rounded-tl-[10px]");
  if (index === count - 1) corners.push("rounded-b-[10px]");
  return corners.join(" ");
}
