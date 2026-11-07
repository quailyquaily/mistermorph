// The Vue console's soul editor (OverType's default theme) colours Markdown headings: the `#`
// marker in the ink at 52%, the heading's text orange-red, both bold. The nsh Editor's Markdown
// highlighting has its own heading colour, so the persona editor lays these over it as decorations.
import type { EditorDecoration } from "nsh/base";

// OverType's `.syntax-marker` (rgba(13, 59, 102, 0.52)) and `h1`..`h6` (#f95738), measured in Vue.
const MARKER_CLASS = "font-bold text-[#0d3b6685]";
const HEADING_CLASS = "font-bold text-[#f95738]";

/** Decorations for the ATX headings of `source` (not inside fenced code blocks). */
export function markdownHeadingDecorations(source: string): EditorDecoration[] {
  const out: EditorDecoration[] = [];
  let fence = "";
  String(source || "")
    .split("\n")
    .forEach((text, line) => {
      const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
      if (opener) {
        if (!fence) fence = opener[1][0];
        else if (opener[1][0] === fence) fence = "";
        return;
      }
      if (fence) return;
      const heading = /^(\s{0,3}#{1,6})(\s+)(\S.*)?$/.exec(text);
      if (!heading) return;
      const markerEnd = heading[1].length + heading[2].length;
      out.push({ range: { start: { line, column: 0 }, end: { line, column: markerEnd } }, class: MARKER_CLASS });
      if (heading[3]) {
        out.push({ range: { start: { line, column: markerEnd }, end: { line, column: text.length } }, class: HEADING_CLASS });
      }
    });
  return out;
}
