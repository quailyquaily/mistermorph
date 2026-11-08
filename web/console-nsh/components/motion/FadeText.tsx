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
// fades the glyphs under one, letter by letter.
import { signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";

export function FadeText(props: {
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
}) {
  const tip = () =>
    cut() && !props.noTooltip ? (
      <Tooltip class="max-w-75 rounded-(--radius) border border-line-soft bg-card px-2 pb-1.25 pt-1">
        <Text class="text-xs text-foreground">{props.text}</Text>
      </Tooltip>
    ) : undefined;
  const boxWidth = signal(0);
  const textWidth = signal(0);
  const cut = () => textWidth() > boxWidth() + 0.5;
  // The text sits unshrunk in a clipping row: it lays out as one line at its natural width (it
  // never breaks at a space), and the row cuts it wherever its edge falls, mid-word, under the fade.
  return (
    <View
      class={`min-w-0 max-w-full flex-row overflow-hidden ${props.class ?? ""}`}
      onLayout={(event) => boxWidth.set(event.bounds.size.width)}
      tooltip={tip()}
      style={{ maskImage: cut() ? `linear-gradient(to left, transparent, #000 ${props.fade ?? 34}px)` : undefined }}
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
