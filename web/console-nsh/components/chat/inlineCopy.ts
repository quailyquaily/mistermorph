// Inline code in a reply copies its text when pressed (the Vue console's markdown renderer did it
// on click). nsh's TextView has no press for inline code, so before a reply is shown each inline
// code span becomes a link around itself, `[`code`](mmcopy:…)`: the code keeps its own look and
// stays text (a selection across it copies it with the rest), and a press arrives as a link press
// that copies instead of opening. Fenced code blocks have their own copy button and are left
// alone, as is code already inside a link (a press there follows the link).

export const INLINE_COPY_SCHEME = "mmcopy:";

/** The code a pressed link copies, or null for an ordinary link. */
export function inlineCopyText(url: string): string | null {
  const value = String(url || "");
  if (!value.startsWith(INLINE_COPY_SCHEME)) return null;
  try {
    return decodeURIComponent(value.slice(INLINE_COPY_SCHEME.length));
  } catch {
    return null;
  }
}

function copyURL(code: string) {
  // encodeURIComponent leaves parentheses, which would end the link's destination early.
  return INLINE_COPY_SCHEME + encodeURIComponent(code).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// A code span's content as CommonMark reads it: line endings are spaces, and one space at each
// end is dropped when both ends have one and it is not all spaces.
function spanContent(raw: string) {
  const text = raw.replace(/\r\n|\r|\n/g, " ");
  if (text.length >= 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") return text.slice(1, -1);
  return text;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** `markdown` with each inline code span outside fenced blocks and links pressable to copy. */
export function linkInlineCode(markdown: string): string {
  const source = String(markdown ?? "");
  if (!source.includes("`")) return source;
  const lines = source.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let chunk: string[] = [];
  const flush = () => {
    if (chunk.length) out.push(linkSpans(chunk.join("\n")));
    chunk = [];
  };
  for (const line of lines) {
    const open = FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
      continue;
    }
    if (open) {
      flush();
      fence = open[1];
      out.push(line);
      continue;
    }
    chunk.push(line);
  }
  flush();
  return out.join("\n");
}

// Code spans in text outside fences: a run of backticks closed by a run of the same length.
function linkSpans(text: string): string {
  let result = "";
  let i = 0;
  // Open square brackets: code inside a link's text stays as it is (links do not nest).
  let brackets = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      result += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch !== "`") {
      if (ch === "[") brackets += 1;
      else if (ch === "]" && brackets > 0) brackets -= 1;
      result += ch;
      i += 1;
      continue;
    }
    let run = 0;
    while (text[i + run] === "`") run += 1;
    const ticks = "`".repeat(run);
    // The closing run: the same number of backticks, not part of a longer run.
    let close = -1;
    let from = i + run;
    while (from < text.length) {
      const at = text.indexOf(ticks, from);
      if (at < 0) break;
      let end = at + run;
      if (text[end] === "`") {
        while (text[end] === "`") end += 1;
        from = end;
        continue;
      }
      close = at;
      break;
    }
    if (close < 0) {
      // Unclosed (still streaming, or literal backticks): the run is text.
      result += ticks;
      i += run;
      continue;
    }
    const span = text.slice(i, close + run);
    const code = spanContent(text.slice(i + run, close));
    result += brackets > 0 || code.trim() === "" ? span : `[${span}](${copyURL(code)})`;
    i = close + run;
  }
  return result;
}
