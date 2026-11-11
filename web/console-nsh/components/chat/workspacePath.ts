// How the workspace panel writes a workspace's path: the home directory of the host the workspace
// is on as `~`, and a path too long for its line cut in the middle with a literal "...", keeping
// its beginning and its end. Display only: the path itself (the tooltip, every request) stays raw.

/** What a path cut in the middle shows in place of what it leaves out. */
export const PATH_ELLIPSIS = "...";

/** The fewest characters a cut path keeps on each side of the ellipsis. */
const MIN_SIDE_UNITS = 1;

function isWindowsLike(path: string) {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^[\\/]{2}[^\\/]/u.test(path);
}

function isRootPath(path: string) {
  return /^[\\/]+$/u.test(path) || /^[A-Za-z]:[\\/]*$/u.test(path);
}

/**
 * `path` with `home` written as `~`: the home itself is `~`, a path inside it `~/rest` (with the
 * path's own separator). Nothing else is touched: not a sibling that only starts like the home
 * (`/home/me2`), not the home's text further into a path (`/srv/home/me`). `home` is the home
 * directory of the host the workspace is on, as that host reports it; without one (or with a root
 * as home, where everything would be "inside" it) the path stays as it is.
 *
 * POSIX paths compare exactly with `/` as the only separator; Windows paths (a drive or a UNC
 * share) compare case-insensitively with `\` and `/` both separators, as Windows does.
 */
export function abbreviateHomePath(path: string, home: string | null | undefined): string {
  const value = String(path ?? "").trim();
  const rawHome = String(home ?? "").trim();
  if (!value || !rawHome || isRootPath(rawHome)) return value;
  const windows = isWindowsLike(rawHome);
  const separators = windows ? /[\\/]+$/u : /\/+$/u;
  const base = rawHome.replace(separators, "");
  if (!base || isRootPath(base)) return value;
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(value.replace(separators, ""), base)) return "~";
  if (value.length <= base.length || !same(value.slice(0, base.length), base)) return value;
  const next = value.charAt(base.length);
  if (next === "/" || (windows && next === "\\")) return `~${value.slice(base.length)}`;
  return value;
}

/** Splits a path into what comes before its last part and the part, for the workspace panel. */
export function splitWorkspaceDisplayPath(path: string) {
  const value = String(path || "").trim();
  if (!value) return { prefix: "", separator: "", tail: "" };
  if (/^[\\/]+$/u.test(value) || /^[A-Za-z]:[\\/]?$/u.test(value)) return { prefix: "", separator: "", tail: value };
  const normalized = value.replace(/[\\/]+$/u, "");
  if (!normalized) return { prefix: "", separator: "", tail: value };
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index < 0) return { prefix: "", separator: "", tail: normalized };
  const tail = normalized.slice(index + 1);
  if (!tail) return { prefix: "", separator: "", tail: value };
  return { prefix: normalized.slice(0, index), separator: normalized.charAt(index), tail };
}

/** A workspace path as the panel writes it: `text` (the host's `home` as `~`), and `leafStart`, where its last part starts (code points). */
export function workspacePathDisplay(path: string, home: string | null | undefined) {
  const parts = splitWorkspaceDisplayPath(abbreviateHomePath(path, home));
  const head = parts.prefix + parts.separator;
  return { text: head + parts.tail, leafStart: Array.from(head).length };
}

// Characters a monospace line gives two cells: CJK, Hangul, full-width forms, most emoji.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;

/** How many monospace cells `char` (one code point) takes: 2 for wide characters, else 1. */
export function charUnits(char: string) {
  return WIDE.test(char) ? 2 : 1;
}

/** How many monospace cells `text` takes (`charUnits` summed). */
export function textUnits(text: string) {
  let units = 0;
  for (const char of Array.from(text)) units += charUnits(char);
  return units;
}

/** A run of a written path: the last part (`strong`) is drawn stronger than the folders before it. */
export interface PathRun {
  text: string;
  strong: boolean;
}

/** A path as its line writes it. */
export interface FittedPath {
  /** What the line shows. */
  text: string;
  runs: PathRun[];
  /** Whether the middle was cut out. */
  truncated: boolean;
}

function pushRun(runs: PathRun[], text: string, strong: boolean) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.strong === strong) last.text += text;
  else runs.push({ text, strong });
}

/** Splits `chars[from, to)` into runs at `leafStart` (the first character of the last part). */
function pushSlice(runs: PathRun[], chars: string[], from: number, to: number, leafStart: number) {
  const split = Math.min(Math.max(leafStart, from), to);
  pushRun(runs, chars.slice(from, split).join(""), false);
  pushRun(runs, chars.slice(split, to).join(""), true);
}

/**
 * `path` written in at most `maxUnits` monospace cells (`null`: no limit). A path that fits is
 * written whole; a longer one keeps its beginning and its end around `PATH_ELLIPSIS`, at least
 * one character on each side however narrow the line. The end gets the larger share: half the
 * room, or up to two thirds of it when that keeps the whole last part (the folder's own name).
 *
 * `leafStart` is the index (in code points) of the last part's first character: the runs mark
 * what lies from there on `strong`; the ellipsis is strong when everything it stands for is.
 */
export function fitPath(path: string, leafStart: number, maxUnits: number | null): FittedPath {
  const chars = Array.from(String(path ?? ""));
  const units = chars.map(charUnits);
  const total = units.reduce((sum, value) => sum + value, 0);
  const leaf = Math.min(Math.max(0, leafStart), chars.length);
  if (maxUnits === null || total <= maxUnits || chars.length <= 2 * MIN_SIDE_UNITS) {
    const runs: PathRun[] = [];
    pushSlice(runs, chars, 0, chars.length, leaf);
    return { text: chars.join(""), runs, truncated: false };
  }
  const room = Math.max(2 * MIN_SIDE_UNITS, Math.floor(maxUnits) - PATH_ELLIPSIS.length);
  const leafUnits = units.slice(leaf).reduce((sum, value) => sum + value, 0) + (leaf > 0 ? 1 : 0);
  const half = Math.ceil(room / 2);
  const most = Math.max(half, room - Math.max(MIN_SIDE_UNITS, Math.floor(room / 3)));
  const tailRoom = Math.min(room - MIN_SIDE_UNITS, Math.max(half, Math.min(leafUnits, most)));
  // The end first, then the beginning in what is left, a whole character at a time.
  let tailStart = chars.length;
  let used = 0;
  while (tailStart > 1 && used + units[tailStart - 1] <= tailRoom) used += units[--tailStart];
  if (tailStart === chars.length) used += units[--tailStart];
  let headEnd = 0;
  const headRoom = Math.max(MIN_SIDE_UNITS, room - used);
  let headUsed = 0;
  while (headEnd < tailStart && headUsed + units[headEnd] <= headRoom) headUsed += units[headEnd++];
  if (headEnd === 0) headEnd = 1;
  if (headEnd >= tailStart) {
    const runs: PathRun[] = [];
    pushSlice(runs, chars, 0, chars.length, leaf);
    return { text: chars.join(""), runs, truncated: false };
  }
  const runs: PathRun[] = [];
  pushSlice(runs, chars, 0, headEnd, leaf);
  pushRun(runs, PATH_ELLIPSIS, headEnd >= leaf);
  pushSlice(runs, chars, tailStart, chars.length, leaf);
  return {
    text: chars.slice(0, headEnd).join("") + PATH_ELLIPSIS + chars.slice(tailStart).join(""),
    runs,
    truncated: true,
  };
}

/**
 * How many monospace cells fit in `room` points, from a measured line: `measuredWidth` is the
 * natural width of `measuredText`, written in the same font. `null` until both are known.
 */
export function unitsThatFit(room: number, measuredText: string, measuredWidth: number): number | null {
  const units = textUnits(measuredText);
  if (!(room > 0) || !(measuredWidth > 0) || units === 0) return null;
  return Math.floor(((room + 0.5) * units) / measuredWidth);
}
