// The composer's popups on touch screens. nsh's Menu and Select are sheets at the bottom of the
// screen there (their `placement` is the desktops'), and the software keyboard lies over the bottom
// of the surface: Android shrinks neither the surface nor an overlay for it (PORTING.md). The
// composer lowers the keyboard as its add menu or model picker opens; the model picker's search
// field can raise it again, and then its sheet rises above the keyboard by this lift. A pure
// function, so the tests can check the numbers.

/** The model picker's list at most (`max-h-80`), as on the desktops. */
export const PROFILE_SHEET_MAX_HEIGHT = 320;

const size = (value: number | undefined) => (Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0);

/**
 * The style that keeps a bottom sheet of at most `contentMax` points clear of a software keyboard
 * `keyboard` points tall, in a window `windowHeight` points tall whose top `topInset` points the
 * status bar takes: the keyboard's height as bottom padding (it covers the navigation bar, so that
 * inset is in it), and room for the content above it. `undefined` while the keyboard is hidden: the
 * sheet is as nsh places it.
 */
export function sheetKeyboardLift(
  keyboard: number,
  topInset: number,
  windowHeight: number,
  contentMax: number,
): { paddingBottom: number; maxHeight: number } | undefined {
  const raised = size(keyboard);
  if (raised === 0) return undefined;
  const room = Math.max(0, size(windowHeight) - size(topInset) - raised);
  return { paddingBottom: raised, maxHeight: raised + Math.min(size(contentMax), room) };
}
