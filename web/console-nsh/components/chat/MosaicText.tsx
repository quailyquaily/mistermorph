// A word assembling itself from mosaic pieces (lib/core/mosaic-text.js), for a wait: a reply on its
// way. The word is for the eye; screen readers get `label`, or the word.
import { Canvas, cleanup, reduceMotion, signal, token, View } from "nsh";
import { drawMosaicText, layoutMosaicText, shadeColors } from "../../lib/core/mosaic-text.js";

const ROWS = 7;

/** [r, g, b] of a theme color written as #rrggbb or #rrggbbaa. */
function rgbOf(name: Parameters<typeof token>[0], fallback: number[]) {
  const value = String(token(name) ?? "");
  const match = /^#([0-9a-f]{6})/i.exec(value);
  if (!match) return fallback;
  const hex = match[1];
  return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

export function MosaicText(props: { text: string; label?: string; pitch?: number }) {
  const elapsed = signal(0);
  const pitch = () => props.pitch ?? 2;
  const layout = () => layoutMosaicText(props.text);
  const width = () => Math.ceil(layout().widthCols * pitch());
  const height = () => Math.ceil(ROWS * pitch());

  // A timer rather than animation frames: 20 steps a second is enough for the pieces, and leaves
  // the app quiet between them.
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (!reduceMotion()) elapsed.set(Date.now() - startedAt);
  }, 50);
  cleanup(() => clearInterval(timer));

  return (
    <View role="text" accessibilityLabel={props.label || props.text} testID="chat-awaiting">
      <Canvas
        accessibilityElementsHidden
        style={{ width: width(), height: height() }}
        draw={(cx) => {
          const current = layout();
          const shades = shadeColors(rgbOf("line", [165, 186, 208]), rgbOf("subtle", [60, 74, 90]));
          const size = { pitch: pitch(), piece: pitch() * 0.8 };
          drawMosaicText(cx as never, current, shades, size, elapsed(), reduceMotion());
        }}
      />
    </View>
  );
}
