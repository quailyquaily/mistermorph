// Fade truncation (the Vue console's core/fade-truncate.js): a one-line text that does not fit
// fades out over its last letters instead of ending in "…"; a text that fits is drawn as it is,
// with no fade (fading every label reads as a rendering bug). While it is cut, its full text is
// its tooltip.
//
//   <FadeText text={topic().title} class="flex-1 text-sm text-foreground" />
//
// It is one unbroken line (no wrapping at spaces), so a cut falls mid-word under the fade rather
// than at the last word that fits (a clamped <Text> breaks at words and shows the first line,
// which ends clean, so the text is laid out unshrunk inside a clipping row instead). It knows it
// is cut from its own layout: the text's line (onTextLayout) is wider than its box, or
// holds less than the whole text. The fade is a mask over the text itself (the end ~2.4em), so a
// row's hover or selection tint shows through it unchanged. The web draws the mask; nsh's GPUI
// backend does not draw masks, and the desktop shell's patched copy of it (desktop/nsh/patches)
// fades the glyphs under one, letter by letter. Android's runtime draws no masks either and its
// renderer is prebuilt (no patch to carry), so there the letters under the fade are drawn one by
// one at the mask's alpha (glyphFade.ts): the same look, from the same measured overflow.
import { computed, effect, platform, signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { drawnGlyph, type GlyphFadePlan, planGlyphFade, platformDrawsMasks, splitGlyphs } from "./glyphFade";

type FadeTextProps = {
  /** The text (a string, so its length can be compared with what fits). */
  text: string;
  /** Layout and text classes together, as on a `<Text>`: text classes pass to the text inside. */
  class?: string;
  /** Extra text styles (color, size) over `class`. */
  style?: Record<string, unknown>;
  /** The fade's length in points (default 2.4em of a 14pt text). */
  fade?: number;
  /** No tooltip with the full text while cut. */
  noTooltip?: boolean;
  role?: "header";
  testID?: string;
  /** Android only, for tests: how the fade is drawn letter by letter (`null`: one plain text). */
  onGlyphFade?: (plan: GlyphFadePlan | null) => void;
};

const DEFAULT_FADE = 34;

export function FadeText(props: FadeTextProps) {
  return platformDrawsMasks(platform.os) ? MaskFadeText(props) : GlyphFadeText(props);
}

function fullTextTip(props: FadeTextProps, cut: () => boolean) {
  return cut() && !props.noTooltip ? (
    <Tooltip class="max-w-75 rounded-(--radius) border border-line-soft bg-card px-2 pb-1.25 pt-1">
      <Text class="text-xs text-foreground">{props.text}</Text>
    </Tooltip>
  ) : undefined;
}

// The web and the desktops: the platform fades the text under a mask.
function MaskFadeText(props: FadeTextProps) {
  const boxWidth = signal(0);
  const textWidth = signal(0);
  const cut = () => textWidth() > boxWidth() + 0.5;
  // The text sits unshrunk in a clipping row: it lays out as one line at its natural width (it
  // never breaks at a space), and the row cuts it wherever its edge falls, mid-word, under the fade.
  return (
    <View
      class={`min-w-0 max-w-full flex-row overflow-hidden ${props.class ?? ""}`}
      onLayout={(event) => boxWidth.set(event.bounds.size.width)}
      tooltip={fullTextTip(props, cut)}
      style={{ maskImage: cut() ? `linear-gradient(to left, transparent, #000 ${props.fade ?? DEFAULT_FADE}px)` : undefined }}
    >
      <Text
        role={props.role}
        testID={props.testID}
        accessibilityLabel={props.text}
        onLayout={(event) => textWidth.set(event.bounds.size.width)}
        style={{ ...(props.style ?? {}), flexShrink: 0 }}
      >
        {props.text}
      </Text>
    </View>
  );
}

// Android: the same clipping row and the same overflow test; once the text is cut, its letters'
// widths are measured (each laid out alone, out of sight, once per letter and text style), and the
// row draws the letters before the fade as one text, those under it one by one at the mask's
// alpha at their middles, and the rest (past the box's edge) laid out but not drawn. A text that
// fits stays one plain text, as do a text and a box not yet laid out.
function GlyphFadeText(props: FadeTextProps) {
  const fade = () => props.fade ?? DEFAULT_FADE;
  const textStyle = () => ({ ...(props.style ?? {}), flexShrink: 0 });
  // What the letters' widths depend on besides the letters.
  const styleKey = () => `${props.class ?? ""}\u0000${JSON.stringify(props.style ?? {})}`;
  const boxWidth = signal(0);
  // The whole text's width as laid out in one piece, for the text and style it was laid out with.
  const natural = signal<{ text: string; style: string; width: number } | null>(null);
  const cut = () => {
    const laidOut = natural();
    const box = boxWidth();
    return box > 0 && laidOut !== null && laidOut.text === props.text && laidOut.style === styleKey() && laidOut.width > box + 0.5;
  };
  const glyphs = computed(() => splitGlyphs(props.text));
  // Letter widths measured so far (for the current style), by letter.
  const widths = signal<{ style: string; byGlyph: Record<string, number> }>({ style: "", byGlyph: {} });
  const known = () => (widths().style === styleKey() ? widths().byGlyph : {});
  const unmeasured = computed(() => {
    if (!cut()) return [];
    const have = known();
    return [...new Set(glyphs())].filter((glyph) => !(glyph in have));
  });
  const measure = (glyph: string, width: number) => {
    const style = styleKey();
    widths.update((current) => ({
      style,
      byGlyph: { ...(current.style === style ? current.byGlyph : {}), [glyph]: width },
    }));
  };
  const plan = computed(() => {
    if (!cut() || unmeasured().length > 0) return null;
    const have = known();
    return planGlyphFade(glyphs(), glyphs().map((glyph) => have[glyph]), boxWidth(), fade());
  });
  effect(() => {
    const drawn = plan();
    props.onGlyphFade?.(drawn);
  });

  return (
    <View
      class={`min-w-0 max-w-full flex-row overflow-hidden ${props.class ?? ""}`}
      onLayout={(event) => boxWidth.set(event.bounds.size.width)}
      tooltip={fullTextTip(props, cut)}
      style={{ alignItems: plan() ? "baseline" : undefined }}
    >
      <If
        when={plan()}
        else={
          // One text per text and style, so a new one reports its layout even at the old width
          // (the overflow test holds only for the text it was laid out with).
          <Each of={[`${props.text}\u0001${styleKey()}`]} key={(layoutKey) => layoutKey}>
            {() => (
              <Text
                role={props.role}
                testID={props.testID}
                accessibilityLabel={props.text}
                onLayout={(event) => natural.set({ text: props.text, style: styleKey(), width: event.bounds.size.width })}
                style={textStyle()}
              >
                {props.text}
              </Text>
            )}
          </Each>
        }
      >
        {(drawn) => (
          <>
            <Text role={props.role} testID={props.testID} accessibilityLabel={props.text} style={textStyle()}>
              {drawnGlyph(drawn().head)}
            </Text>
            <Each of={drawn().fading} key="index">
              {(letter) => (
                <Text accessibilityElementsHidden style={{ ...textStyle(), opacity: letter().alpha }}>
                  {drawnGlyph(letter().glyph)}
                </Text>
              )}
            </Each>
            <Text accessibilityElementsHidden style={{ ...textStyle(), opacity: 0 }}>
              {drawn().rest}
            </Text>
          </>
        )}
      </If>
      <If when={unmeasured().length > 0}>
        <View
          accessibilityElementsHidden
          style={{ position: "absolute", left: 0, top: 0, flexDirection: "row", opacity: 0, pointerEvents: "none" }}
        >
          <Each of={unmeasured()} key={(glyph) => glyph}>
            {(glyph) => (
              <Text style={textStyle()} onLayout={(event) => measure(glyph(), event.bounds.size.width)}>
                {drawnGlyph(glyph())}
              </Text>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
