// A round avatar with a notch cut out of it where a badge or a status mark sits: what lies behind
// (the paper and its grid, a row's hover or selection tint) shows through the gap, as the Vue
// console's CSS masks do (OverviewView.css .endpoint-overview-portrait, ContactsView.css
// .contacts-index-kind .contact-avatar). Masks of that shape are web-only in nsh, so the avatar is
// drawn on a Canvas clipped to the disc and then to everything but the notch (an evenodd path),
// which every platform draws. Its content: an image cropped to cover the disc, or a drawing of
// its own (a logo, an initial) while there is no image. A faint inner hairline keeps a pale
// avatar from melting into the paper; the notch cuts it too.
import type { CanvasRenderingContext2D, ImageAsset, StyleProp, ViewStyle } from "nsh";
import { Canvas, effect, Image, Path2D, signal, untracked } from "nsh";

/** The notch: a circle (`r`) or a rounded box (`w`, `h`, `radius`), in the avatar's points. */
export type Notch = { x: number; y: number; r: number } | { x: number; y: number; w: number; h: number; radius?: number };

export interface CutoutAvatarProps {
  /** The avatar's diameter in points. */
  size: number;
  /** The image, cropped to cover the disc; while it loads (or without one) `paint` draws instead. */
  src?: string | ImageAsset | null;
  /** Draws the avatar without an image, in a `size` square (already clipped). */
  paint?: (cx: CanvasRenderingContext2D, size: number) => void;
  /** The notch cut out of the avatar; none draws a whole disc. */
  notch?: Notch | null;
  /** The disc's fill under the image or the drawing. */
  background?: string;
  /** The inner hairline's colour (Vue: color-mix(in srgb, --q-c-dark 9%, transparent)). */
  hairline?: string;
  /** The image could not be loaded. */
  onError?: () => void;
  class?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const AVATAR_HAIRLINE = "rgba(24, 24, 50, 0.09)";

export function CutoutAvatar(props: CutoutAvatarProps) {
  // The image's pixel size, once known (the crop needs it); null while loading or without one.
  const natural = signal<{ src: string | ImageAsset; width: number; height: number } | null>(null);
  let ticket = 0;
  effect(() => {
    const src = props.src;
    untracked(() => {
      const mine = ++ticket;
      natural.set(null);
      if (!src) return;
      Image.getSize(src).then(
        (size) => {
          if (mine === ticket && size.width > 0 && size.height > 0) natural.set({ src, width: size.width, height: size.height });
        },
        () => {
          if (mine === ticket) props.onError?.();
        },
      );
    });
  });

  const draw = (cx: CanvasRenderingContext2D) => {
    const size = props.size;
    const half = size / 2;
    const notch = props.notch;
    const image = natural();
    cx.save();
    cx.beginPath();
    cx.arc(half, half, half, 0, Math.PI * 2);
    cx.clip();
    if (notch) {
      // Everything around the notch: a box past the disc, and the notch inside it (evenodd).
      const around = new Path2D();
      around.rect(-1, -1, size + 2, size + 2);
      if ("r" in notch) {
        around.moveTo(notch.x + notch.r, notch.y);
        around.arc(notch.x, notch.y, notch.r, 0, Math.PI * 2);
      } else {
        around.roundRect(notch.x, notch.y, notch.w, notch.h, notch.radius ?? 0);
      }
      cx.clip(around, "evenodd");
    }
    if (props.background) {
      cx.fillStyle = props.background;
      cx.fillRect(0, 0, size, size);
    }
    if (image && image.src === props.src) {
      // object-fit: cover, centred.
      const scale = Math.max(size / image.width, size / image.height);
      const sw = size / scale;
      const sh = size / scale;
      cx.drawImage(image.src, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, 0, 0, size, size);
    } else {
      props.paint?.(cx, size);
    }
    if (props.hairline !== "none") {
      cx.strokeStyle = props.hairline ?? AVATAR_HAIRLINE;
      cx.lineWidth = 1;
      cx.beginPath();
      cx.arc(half, half, half - 0.5, 0, Math.PI * 2);
      cx.stroke();
    }
    cx.restore();
  };

  return (
    <Canvas
      accessibilityElementsHidden
      class={props.class}
      style={[{ width: props.size, height: props.size, flexShrink: 0 }, props.style]}
      testID={props.testID}
      draw={draw}
    />
  );
}
