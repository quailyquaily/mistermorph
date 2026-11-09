// The software keyboard, for a back arrow that lowers it before it leaves the view: a phone's
// keyboard covers the view, and the first tap of the arrow closes it, as the system's Back does
// on Android (the system closes the keyboard itself before the app hears its Back).
//
// Whether the keyboard is up comes from its frame (`keyboardFrame()`, native on Android and iOS,
// the visual viewport on the web). A focused field alone is not a keyboard: with a hardware
// keyboard the field has the focus and nothing covers the view. Until the frame has reported a
// keyboard once in this run, though, there is no telling that it reports one at all (a browser
// that does not shrink its visual viewport, headless runs), and the focused field counts. The
// desktops have no software keyboard.
import { effect, Keyboard, keyboardFrame, platform, untracked } from "nsh";

export interface SoftKeyboardState {
  /** The desktops' idiom: no software keyboard. */
  desktop: boolean;
  /** The keyboard's height over the surface now (0 when hidden). While it is still going down it
   * counts as up: a second tap then only lowers it again, and never leaves by accident. */
  height: number;
  /** The frame has reported a keyboard in this run: it is the one to believe. */
  frameReported: boolean;
  /** A text field of the view has the focus. */
  fieldFocused: boolean;
}

/** Whether the software keyboard covers the view (see above). */
export function softKeyboardUp(state: SoftKeyboardState): boolean {
  if (state.desktop) return false;
  if (state.height > 0) return true;
  return !state.frameReported && state.fieldFocused;
}

let frameReported = false;
effect(() => {
  if (keyboardFrame().height > 0) frameReported = true;
});

/**
 * Lowers the software keyboard if it is up and reports whether it did: a back arrow then stays
 * where it is, and its next tap goes back. The field loses the focus and keeps its text; nothing
 * gives the focus back. `fieldFocused` tells whether the view's text field has the focus.
 */
export function dismissSoftKeyboard(fieldFocused: boolean): boolean {
  const up = softKeyboardUp({
    desktop: platform.desktop,
    height: untracked(keyboardFrame).height,
    frameReported,
    fieldFocused,
  });
  if (up) Keyboard.dismiss();
  return up;
}
