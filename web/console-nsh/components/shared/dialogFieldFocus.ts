// The text field of a dialog that opens and closes in place: each opening focuses it, each closing
// lets go of it. A dialog stays drawn while it goes out (its closing motion), and its field keeps
// the focus that long unless it is blurred: keys still landed in a dialog already closed, and on
// a phone the software keyboard stayed up (the Android app drops no keyboard for a field that
// leaves the screen). So every closing, whatever closed it (Cancel, the close button, Escape, the
// scrim, Back, a save, the page closing it, the page going), blurs the field at once and, where
// there is a software keyboard, lowers it.
//
// The field's `autoFocus` focuses it when it is mounted. A dialog reopened while it was still
// going out keeps the field it had, blurred: the opening focuses it again, a turn later (a tap's
// own focus change on the web comes after its press, PORTING.md), and only if that opening is
// still the one on screen.
//
// A dialog may also ask for the field's text to be selected as it opens (`selectOnOpen`: the
// rename dialog's current name, so typing replaces it). Each opening then focuses and selects its
// field once, a turn after both the opening and its field are there: a field mounted after the
// opening (the dialog drawn anew, or mounted with its opening already on screen) waits for its own
// turn. Only openings select: an edit, a generated name put in the field or a failed save never
// select again, and a turn of an opening already gone touches nothing.
import { cleanup, effect, Keyboard, platform, untracked, type InputRef } from "nsh";

export interface DialogFieldFocusOptions {
  /** The opening on screen (one value per opening), null or undefined while the dialog is closed. */
  session: () => unknown;
  /** Lowers the software keyboard (default: `Keyboard.dismiss()` except on the desktops, which have none). */
  dismissKeyboard?: () => void;
  /** Runs `fn` a turn later (default `setTimeout(fn, 0)`). */
  defer?: (fn: () => void) => void;
  /**
   * The field's text as an opening comes in: given, each opening selects all of it (UTF-16 units,
   * as `InputRef.setSelection` counts) once it focuses the field; empty text selects nothing.
   */
  selectOnOpen?: () => string;
}

function defaultDismissKeyboard() {
  if (!platform.desktop) Keyboard.dismiss();
}

/** Call in the dialog's component; pass `ref` to the field's `inputRef`. */
export function createDialogFieldFocus(options: DialogFieldFocusOptions) {
  const dismissKeyboard = options.dismissKeyboard ?? defaultDismissKeyboard;
  const defer = options.defer ?? ((fn: () => void) => void setTimeout(fn, 0));
  const selectText = options.selectOnOpen;
  let field: InputRef | null = null;
  let shown: unknown = untracked(options.session) ?? null;
  // The opening whose field is still to be focused (and selected), null once it was.
  let pending: unknown = selectText ? shown : null;

  function release() {
    field?.blur();
    dismissKeyboard();
  }

  function settle(opening: unknown) {
    defer(() => {
      if (shown !== opening || pending !== opening || !field) return;
      pending = null;
      field.focus();
      if (selectText) field.setSelection(0, String(untracked(selectText) ?? "").length);
    });
  }

  effect(() => {
    const next = options.session() ?? null;
    untracked(() => {
      const previous = shown;
      if (next === previous) return;
      shown = next;
      pending = next;
      if (previous !== null) release();
      if (next === null) return;
      settle(next);
    });
  });

  // The dialog went with the page while it was open.
  cleanup(() => {
    if (shown !== null) release();
    shown = null;
    pending = null;
    field = null;
  });

  return {
    ref(node: InputRef) {
      if (node === field) return;
      field = node;
      if (pending !== null && pending === shown) settle(pending);
    },
  };
}
