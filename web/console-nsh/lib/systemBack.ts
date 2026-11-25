// Android's Back: the back button, and with gesture navigation the swipe in from the left or the
// right edge of the screen, which the system turns into the same back event (there is no gesture
// of the app's own to add). nsh hands it to the app only while the app listens (`BackHandler`);
// otherwise the system takes it and leaves the app, as it should on the first screen.
//
// What Back does, first match:
// 1. A dialog (ui.tsx DialogLayer) or a sheet of nsh's closes, the newest first (both are nsh
//    modals): nsh asks them before any listener here. The keyboard, when shown, is closed by the
//    system first.
// 2. The newest action registered with `onSystemBack` whose `when` holds: what the screen's own
//    back arrow does (the open topic back to the list, a settings section back to the sections,
//    the skill store back to Skills, Logs back to Settings), or closing the phone's More and agent
//    sheets.
// With neither, nothing listens, and Back leaves the app.
//
// The page hierarchy decides, never the history: a navigation page's own list (Topics, Contacts,
// TODO, ...) has no back arrow and takes no Back, however many pages were opened before it, and a
// page below one (an open item, a page reached from another) has both, also when the app opened
// on it. So a page that shows a back arrow registers the same action here with the same `when`,
// and one without an arrow registers nothing.
//
// iOS has no system Back: there the swipe in from the left edge of the screen is the app's own
// (`edgeSwipeBack`), and runs the same action, so it goes back wherever a back arrow shows. Other
// platforms keep what they have: the browser's back button and Escape on the desktop.
import type { TouchProps } from "nsh";
import { cleanup, computed, context, effect, PanResponder, platform, signal, untracked } from "nsh";
import { BackHandler } from "nsh/mobile";
import { OWN_HISTORY } from "./platform";
import { navigate } from "./router";

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
 * While the calling component lives (and `when` holds), Back runs `run` instead of leaving the
 * app. Newer registrations go first, so a sheet opened over a page closes before the
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

/** Whether Back stays in the app now: an action applies (the history alone never keeps it). */
export const handlesBack = computed(() => currentAction() !== null);

/** Takes one Back press: true when the app handled it, false when it should leave. */
export function handleBack(): boolean {
  const action = untracked(currentAction);
  if (!action) return false;
  action.run();
  return true;
}

/**
 * What the back arrow of a page below another does: opens its parent page (`parent`, a location).
 * In the phone apps the parent takes this page's place in the run's history, which is going back
 * to it when it is the place before (lib/mobileHost.ts), so the pages left this way do not pile
 * up there. On the web it is a navigation like any other: the browser's history is the browser's.
 */
export function openParentPage(parent: string) {
  return navigate(parent, { replace: OWN_HISTORY });
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

/** The swipe back's numbers, in points: how near the left edge it starts, how far it goes before it
 *  is taken (well past a tap's wobble, mostly sideways), and how far, or how far and how fast
 *  (points per second), it goes to go back on release. */
export const EDGE_SWIPE = { edge: 24, claim: 12, commit: 72, flick: 32, flickSpeed: 400 };

interface SwipeState {
  x0: number;
  dx: number;
  dy: number;
  vx: number;
}

/** Whether a finger's move is the swipe back: from the left edge, rightwards, mostly sideways. */
export function claimsEdgeSwipe(gesture: SwipeState): boolean {
  return gesture.x0 <= EDGE_SWIPE.edge && gesture.dx >= EDGE_SWIPE.claim && Math.abs(gesture.dx) > 2 * Math.abs(gesture.dy);
}

/** Whether the swipe, let go, goes back: far enough, or a flick a little way. */
export function edgeSwipeGoesBack(gesture: SwipeState): boolean {
  return gesture.dx >= EDGE_SWIPE.commit || (gesture.dx >= EDGE_SWIPE.flick && gesture.vx >= EDGE_SWIPE.flickSpeed);
}

/**
 * On iOS, the handlers of the swipe back, for the app's frame (App.tsx); none elsewhere. Only a move
 * is claimed (a capture, before the views under the finger): taps, presses and scrolling that do
 * not start at the edge going right are left as they were, and nothing is claimed while there is
 * no back to go to. Dialogs and sheets are layers over the frame, so a swipe on them is theirs.
 * Elsewhere it is an empty object, not undefined: the frame spreads it, and nsh's web renderer
 * reads a spread's keys, so spreading undefined stops the web Console from starting.
 */
export function edgeSwipeBack(): TouchProps {
  if (platform.os !== "ios") return {};
  return PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => untracked(handlesBack) && claimsEdgeSwipe(gesture),
    onPanResponderRelease: (_event, gesture) => {
      if (edgeSwipeGoesBack(gesture)) handleBack();
    },
    // Taken, the swipe stays the app's until the finger lifts.
    onPanResponderTerminationRequest: () => false,
  }).panHandlers;
}
