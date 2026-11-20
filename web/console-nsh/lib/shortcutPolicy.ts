// Where the Console's application keyboard shortcuts are on: the one decision behind the keys
// that act, the hints that show them and Settings' Keyboard shortcuts section, so that a shortcut
// that is not shown never fires and one that fires is always shown.
//
//   the desktop app            always, at any window width
//   a browser                  in the desktop layout only (lib/layout.ts); never in the phone
//                              layout, whatever keyboard the device has
//   the phone app              only while its native part says a hardware keyboard is connected
//                              (lib/mobileHost.ts); "disconnected" and "unknown" are both off
//
// A browser does not tell a page whether a hardware keyboard is there, and the Console does not
// guess it from the keys that arrive or from a software keyboard that stays hidden: in a browser
// the layout decides, in the phone app the native part does. Everything here is read reactively:
// resizing a browser window across the breakpoint, or connecting a keyboard to a tablet, turns
// the shortcuts, their hints and the Settings section on or off at once.
//
// An application shortcut is a key the Console itself gives to an action of the app or of a page:
// the actions of lib/shortcuts.ts, and in the chat Enter to send, Up and Down through the sent
// messages, Escape to leave an edit, the number keys of a question's choices, and Escape closing
// a panel beside the content. Keys that operate the control that has the focus or a popup that is
// open (a dialog's Escape, a list's arrows and Enter, a splitter's arrows) are not: they stay.
// docs/console/keyboard-shortcuts.md lists both.
import { isMobile } from "./layout";
import { physicalKeyboard, runtime, type Boot, type PhysicalKeyboard } from "./platform";

export interface ShortcutSituation {
  /** Where the Console runs (lib/platform.ts `runtime`). */
  runtime: Boot["runtime"];
  /** The window has the phone layout (lib/layout.ts `isMobile`). */
  mobileLayout: boolean;
  /** The phone app's native part's word on a hardware keyboard. */
  keyboard: PhysicalKeyboard;
}

/** Whether application shortcuts are on in `situation`. Anything unknown is off. */
export function shortcutsAllowed(situation: ShortcutSituation): boolean {
  switch (situation.runtime) {
    case "desktop":
      return true;
    case "web":
      return situation.mobileLayout === false;
    case "mobile":
      return situation.keyboard === "connected";
    default:
      return false;
  }
}

/**
 * Whether application shortcuts are on here and now. Reads the layout and the keyboard state as
 * signals: an effect or a view that calls it follows them.
 */
export function shortcutsEligible(): boolean {
  const where = runtime();
  // Each runtime reads only the signal that decides for it.
  if (where === "desktop") return shortcutsAllowed({ runtime: where, mobileLayout: false, keyboard: "unknown" });
  if (where === "web") return shortcutsAllowed({ runtime: where, mobileLayout: isMobile(), keyboard: "unknown" });
  return shortcutsAllowed({ runtime: where, mobileLayout: isMobile(), keyboard: physicalKeyboard() });
}
