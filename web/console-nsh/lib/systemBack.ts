// Android's Back: the back button, and with gesture navigation the swipe in from the left or the
// right edge of the screen, which the system turns into the same back event (there is no gesture
// of the app's own to add). nsh hands it to the app only while the app listens (`BackHandler`);
// otherwise the system takes it and leaves the app, as it should on the first screen.
//
// What Back does, first match:
// 1. A dialog (an Overlay on Android, ui.tsx DialogLayer) or a sheet of nsh's closes: nsh asks
//    them before any listener here. The keyboard, when shown, is closed by the system first.
// 2. The newest action registered with `onSystemBack` whose `when` holds: what the screen's own
//    back arrow does (the open topic back to the list, a settings section back to the sections),
//    or closing the phone's More and agent sheets.
// 3. The place before in this run's history (lib/platform.ts `goBack`), which the router takes as
//    a browser's back: the page's leave guard asks first, and the guard redirects as usual.
// With none of them, nothing listens, and Back leaves the app.
//
// Other platforms keep what they have: the browser's back button and Escape on the desktop.
import { cleanup, computed, context, effect, platform, signal, untracked } from "nsh";
import { BackHandler } from "nsh/mobile";
import { canGoBack, goBack } from "./platform";

interface BackAction {
  when: () => boolean;
  run: () => void;
}

const actions = signal<BackAction[]>([]);

/**
 * Whether the screen around the caller is the one shown (components/frame/PageStack.tsx provides
 * it for each page): a page on its way out stays mounted through its slide, and its registrations
 * must not take Back from the page coming in. Outside a page (the frame's sheets) it is null.
 */
export const SystemBackScope = context<(() => boolean) | null>(null);

/**
 * While the calling component lives (and `when` holds), Back runs `run` instead of going back in
 * the history. Newer registrations go first, so a sheet opened over a page closes before the
 * page's own back. Call it in a component body; it is removed with the component. Inside a page
 * going out (SystemBackScope) it no longer applies.
 */
export function onSystemBack(when: () => boolean, run: () => void) {
  const shown = SystemBackScope();
  const action: BackAction = { when: shown ? () => shown() && when() : when, run };
  actions.update((list) => [...list, action]);
  cleanup(() => actions.update((list) => list.filter((item) => item !== action)));
}

/** The action Back runs now, if any (the newest that applies). */
const currentAction = computed(() => {
  const list = actions();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].when()) return list[i];
  }
  return null;
});

/** Whether Back stays in the app now: an action applies or there is a place to go back to. */
export const handlesBack = computed(() => currentAction() !== null || canGoBack());

/** Takes one Back press: true when the app handled it, false when it should leave. */
export function handleBack(): boolean {
  const action = untracked(currentAction);
  if (action) {
    action.run();
    return true;
  }
  return goBack();
}

/**
 * Listens to Android's Back while the app has a use for it, so the system's own back (leaving the
 * app, with its predictive animation) stays on the first screen. Call once, in the app's root.
 */
export function startSystemBack() {
  if (platform.os !== "android") return;
  effect(() => {
    if (!handlesBack()) return;
    return BackHandler.on("press", () => handleBack());
  });
}
