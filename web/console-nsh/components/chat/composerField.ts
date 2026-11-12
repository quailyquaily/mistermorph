// The composer field's box. On one row the field sits between the add button and the actions,
// and its line of text shares their centre line. The box does not come from the field's measured
// height, because a multiline field draws its first line at the top of its content box. A field
// sized to its measured text plus even padding (as the composer used to be) is only centred when
// every platform measures the line as LINE_HEIGHT. Instead the field is as tall as the controls
// and the first line box starts where a LINE_HEIGHT line is centred in that height. The measured
// height still fixes the content box, so a line measured a little taller is not scrolled or clipped:
// the extra goes below the line.

/** The Vue field: IBM Plex Mono at 14pt in 1.58 lines. */
export const COMPOSER_LINE_HEIGHT = 22.12;
/** The add button and Send: 38pt squares (`size-[38px]` in ChatComposer). */
export const COMPOSER_CONTROL_SIZE = 38;
/** The field's text: its font and size (also the hidden copies' in ComposerMeasure.tsx). */
export const COMPOSER_FIELD_TEXT = "font-mono text-sm";
const DEFAULT_MAX_ROWS = 24;

/** One row: add, the field, actions. Two rows: the field above a row of the controls. */
export function composerRowClass(multi: boolean): string {
  return multi ? "min-h-[104px] gap-2 px-2.5 pb-2 pt-3" : "min-h-[54px] flex-row items-center gap-2.5 px-2.5 py-2";
}

/** The text's height: what the field reports, at least one line, at most the maximum rows. */
export function composerContentHeight(measured: number, maxRows = DEFAULT_MAX_ROWS): number {
  const height = Number.isFinite(measured) ? measured : COMPOSER_LINE_HEIGHT;
  return Math.max(COMPOSER_LINE_HEIGHT, Math.min(height, maxRows * COMPOSER_LINE_HEIGHT));
}

export interface ComposerFieldBox {
  height: number;
  paddingTop: number;
  paddingBottom: number;
  lineHeight: number;
}

/** The field's height, vertical padding and line height for `measured` text height. */
export function composerFieldBox(multi: boolean, measured: number, maxRows = DEFAULT_MAX_ROWS): ComposerFieldBox {
  const content = composerContentHeight(measured, maxRows);
  if (multi) return { height: content, paddingTop: 0, paddingBottom: 0, lineHeight: COMPOSER_LINE_HEIGHT };
  const paddingTop = (COMPOSER_CONTROL_SIZE - COMPOSER_LINE_HEIGHT) / 2;
  const height = Math.max(COMPOSER_CONTROL_SIZE, paddingTop + content);
  return { height, paddingTop, paddingBottom: height - paddingTop - content, lineHeight: COMPOSER_LINE_HEIGHT };
}

/** The colour of the composer's 1pt frame: on a phone, the design's composer border (`line`,
 *  design/ui-refresh.html's `.composer`); on a desktop, the fields' `input`, as before. On a
 *  phone `input` over the field's white is too pale to see where the composer begins. */
export function composerFrameBorder(mobile: boolean): "border-line" | "border-input" {
  return mobile ? "border-line" : "border-input";
}

/** The composer's frame. Only the border's colour differs between a phone and a desktop: its width
 *  and radius are the same, so switching never moves anything. The border is the same in every
 *  state: idle, focused, typing, sending, running (the beam rides it), after a send and with a kept
 *  draft. Focus shows as the shadow alone. A focus colour (it was `border-blue/45`) replaced the
 *  light border while the field had the focus, and the frame only got it back when it lost the
 *  focus. Only the shadow eases (`transition-shadow`), so the border never animates. */
export function composerFrameClass(mobile: boolean): string {
  return `relative rounded-[27px] border ${composerFrameBorder(mobile)} bg-field transition-shadow duration-[260ms] focus-within:shadow-md`;
}

/** The frame's corner radius: half the one-row height, so one row is a pill; its round controls
 *  sit 8pt in, concentric with the corners (19 + 8). */
export const COMPOSER_RADIUS = 27;
