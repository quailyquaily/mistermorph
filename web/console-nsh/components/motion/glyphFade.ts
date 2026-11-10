// FadeText's fade where the platform draws no masks: Android (nsh 0.4.0). Its runtime takes
// `maskImage` (nsh-core parses it) but never hands it to the Java views that draw (the effects it
// sends them hold no masks), so a masked text is drawn whole and cut hard at its box's edge. The
// desktop's patched GPUI backend fades a masked text glyph by glyph, each at the mask's alpha near
// its middle; this does the same in the app: the text is laid out as it is up to where the fade
// starts, and each letter under the fade is a text of its own at the mask's alpha there (a view's
// opacity, so it fades into whatever the row is drawn on: hover, selection, paper). Where the letters
// are comes from their measured widths (Latin and Chinese letters differ), never from a count.

/** Where nsh draws `maskImage` itself: everywhere the console runs but Android. */
export function platformDrawsMasks(os: string): boolean {
  return os !== "android";
}

/** Below this a letter is not drawn at all (the desktop patch's cut-off). */
const INVISIBLE = 0.002;

/** Points of slack before the fade: the text laid out whole is a little narrower than its letters
 * measured one by one (kerning), so the letters it keeps whole stop that much short of the fade. */
const SLACK = 1;

/**
 * The text's letters as a reader sees them (grapheme clusters, near enough): a letter with its
 * combining marks, an emoji with its modifiers, variation selectors and joined parts, a flag's two
 * regional indicators. QuickJS has no `Intl.Segmenter`.
 */
export function splitGlyphs(text: string): string[] {
  const glyphs: string[] = [];
  let joinNext = false;
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0) ?? 0;
    const last = glyphs.length - 1;
    const attaches =
      last >= 0 &&
      (joinNext ||
        /\p{M}/u.test(char) ||
        code === 0x200d ||
        (code >= 0x1f3fb && code <= 0x1f3ff) ||
        (code >= 0xe0020 && code <= 0xe007f) ||
        (isRegional(code) && isRegional(glyphs[last].codePointAt(0) ?? 0) && Array.from(glyphs[last]).length === 1));
    if (attaches) glyphs[last] += char;
    else glyphs.push(char);
    joinNext = code === 0x200d;
  }
  return glyphs;
}

function isRegional(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

/**
 * A letter as it is drawn on its own: a space alone (or ending a run) is laid out as no width, so
 * it is a no-break space, which has a space's width.
 */
export function drawnGlyph(glyph: string): string {
  return glyph.replace(/ $/, " ");
}

/** The mask's alpha at `x` (points from the text's start): FadeText's
 * `linear-gradient(to left, transparent, #000 <fade>px)` over a box `box` wide. */
export function maskAlpha(x: number, box: number, fade: number): number {
  if (fade <= 0) return x < box ? 1 : 0;
  return Math.min(1, Math.max(0, (box - x) / fade));
}

/** How a cut text is drawn without a mask. */
export type GlyphFadePlan = {
  /** The letters before the fade, laid out as one text. */
  head: string;
  /** The letters under the fade, one by one, at the mask's alpha at their middles. */
  fading: { glyph: string; alpha: number }[];
  /** The letters past the fade (at or beyond the box's edge): laid out, not drawn. */
  rest: string;
};

/**
 * Where the fade falls on a text whose letters (`glyphs`) are `widths` wide, in a box `box` wide
 * with a fade `fade` long. `null` when the widths do not match the letters (not measured yet).
 */
export function planGlyphFade(glyphs: string[], widths: number[], box: number, fade: number): GlyphFadePlan | null {
  if (glyphs.length !== widths.length || !widths.every((width) => Number.isFinite(width) && width >= 0)) return null;
  const fadeStart = box - fade;
  let x = 0;
  let headEnd = 0;
  while (headEnd < glyphs.length && x + widths[headEnd] <= fadeStart - SLACK) {
    x += widths[headEnd];
    headEnd += 1;
  }
  const fading: { glyph: string; alpha: number }[] = [];
  let restStart = headEnd;
  while (restStart < glyphs.length) {
    const alpha = maskAlpha(x + widths[restStart] / 2, box, fade);
    if (alpha <= INVISIBLE) break;
    fading.push({ glyph: glyphs[restStart], alpha: Math.round(alpha * 1000) / 1000 });
    x += widths[restStart];
    restStart += 1;
  }
  return {
    head: glyphs.slice(0, headEnd).join(""),
    fading,
    rest: glyphs.slice(restStart).join(""),
  };
}
