// The rule for the name the Console's user is addressed by, as the server has it
// (internal/consoleuser): what Setup's first page checks before it asks the server to save. No
// imports, so it can be used and tested on its own.

/** Where the name is kept in the Console's config. */
export const CONSOLE_USER_NAME_KEY = "console.user_name";
/** The longest name, in Unicode code points (internal/consoleuser MaxNameLength). */
export const CONSOLE_USER_NAME_MAX = 80;

// What the server drops from both ends of a name: Unicode white space and the byte order mark
// (internal/consoleuser isSurroundingSpace). String.prototype.trim differs by U+0085.
const SURROUNDING_SPACE = "[\\t\\n\\v\\f\\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]";
const LEADING = new RegExp(`^${SURROUNDING_SPACE}+`);
const TRAILING = new RegExp(`${SURROUNDING_SPACE}+$`);
// Control characters (line breaks and tabs among them) and the line and paragraph separators.
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Half of a surrogate pair on its own is not text the server would get as typed.
function hasLoneSurrogate(text) {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * The name as it would be saved, by the server's rule: the white space around it dropped, then one
 * line of 1 to 80 code points. `error` is "" for a name that can be saved, else which rule it
 * breaks: "empty", "invalid" (a line break or a control character) or "too_long". Nothing is cut.
 * @param {unknown} raw
 * @returns {{ name: string, error: "" | "empty" | "invalid" | "too_long", length: number }}
 */
export function normalizeConsoleUserName(raw) {
  const name = String(raw ?? "").replace(LEADING, "").replace(TRAILING, "");
  const length = Array.from(name).length;
  if (name === "") return { name: "", error: "empty", length: 0 };
  if (NOT_ONE_LINE.test(name) || hasLoneSurrogate(name)) return { name: "", error: "invalid", length };
  if (length > CONSOLE_USER_NAME_MAX) return { name: "", error: "too_long", length };
  return { name, error: "", length };
}
