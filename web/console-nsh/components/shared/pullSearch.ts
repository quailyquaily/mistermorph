// A list's search that hides on touch phones until the list is pulled down from its top, as
// Telegram's chat list does (Topics, Contacts). Elsewhere (desktops, and a desktop's window
// narrowed to the phone layout, which has no finger to pull with) the search shows as before.
//
//   const pull = createPullSearch({ query: () => text(), revealed });
//   <If when={pull.shown()}><IndexSearch … /></If>
//   <Scroll                                      // or a List: the same props
//     refreshIndicator={pull.indicator}
//     refreshing={pull.refreshing()}
//     onRefresh={pull.onRefresh}
//     onScrollDragStart={pull.onDragStart}
//     accessibilityActions={pull.actions()}
//     onAccessibilityAction={pull.onAction}
//   >
//
// The pull is the scroll view's own pull-to-refresh (nsh draws no spinner, as the app has an
// indicator of its own, which is none), so the platform decides what a pull is: a vertical drag
// (a mostly sideways one never starts the scroll view's drag), past the top by
// `PULL_SEARCH_DISTANCE` when the finger lifts (pulled back first, it is cancelled). It works on a
// list too short to scroll, and on an empty one. A drag that began lower down and ran on past the
// top does not reveal: only a pull that starts with the list at its top. Nothing takes the
// touches from the scroll view, so scrolling is as before; the field is not focused (no keyboard):
// a tap on it does that.
//
// Once shown the search stays for the page's life (`revealed` is the page's, so a list the page
// rebuilds keeps it), and a query always shows it.
import { effect, platform, signal, untracked, type Signal } from "nsh";
import { isMobile } from "../../lib/shell";

/** How far past its top (points of the rubber-banded offset) a pull reveals the search. */
export const PULL_SEARCH_DISTANCE = 44;
/** The accessibility action that reveals the search without the gesture. */
export const PULL_SEARCH_ACTION = "search";

export interface PullSearch {
  /** The search shows: always but on a touch phone, there once pulled or while it holds a query. */
  shown: () => boolean;
  /** Shows the search (does not focus it). */
  reveal: () => void;
  /** The scroll view's `refreshIndicator` (none on a desktop: it never pulls). */
  indicator: { height: number } | undefined;
  /** The scroll view's `refreshing`. */
  refreshing: () => boolean;
  /** The scroll view's `onRefresh` (none on a desktop). */
  onRefresh: (() => void) | undefined;
  /** The scroll view's `onScrollDragStart`. */
  onDragStart: (e: { offset: { x: number; y: number } }) => void;
  /** The scroll view's `accessibilityActions`: "search" while it is hidden, else none. */
  actions: () => { name: string; label?: string }[] | undefined;
  /** The scroll view's `onAccessibilityAction`. */
  onAction: (e: { actionName: string }) => void;
}

export function createPullSearch(options: {
  /** The search's text. */
  query: () => string;
  /** Kept by the page, so the list can be rebuilt (default: this list's own). */
  revealed?: Signal<boolean>;
  /** The phone layout (default: the console's mobile breakpoint). */
  mobile?: () => boolean;
  /** The accessibility action's label (the search's placeholder). */
  label?: string;
}): PullSearch {
  const revealed = options.revealed ?? signal(false);
  // A finger to pull with: phones, tablets and browsers in their touch idiom.
  const touch = !platform.desktop;
  const hides = () => touch && (options.mobile ? options.mobile() : isMobile());
  const shown = () => !hides() || revealed() || options.query() !== "";
  // A query keeps the field once it is there, so emptying it (its clear button, Escape) does not
  // take the field away under the finger.
  effect(() => {
    if (options.query() !== "" && !untracked(revealed)) revealed.set(true);
  });
  const reveal = () => {
    if (!untracked(revealed)) revealed.set(true);
  };

  // Where the last drag began: at the top, or lower down.
  let fromTop = true;
  // A released pull leaves the platform's refresh on (it keeps the indicator's room above the
  // content) until the app turns it off: on, then off in the next turn, so the change reaches it.
  const refreshing = signal(false);
  const onRefresh = () => {
    if (fromTop && untracked(hides)) reveal();
    refreshing.set(true);
    setTimeout(() => refreshing.set(false), 0);
  };
  return {
    shown,
    reveal,
    indicator: touch ? { height: PULL_SEARCH_DISTANCE } : undefined,
    refreshing: () => refreshing(),
    onRefresh: touch ? onRefresh : undefined,
    onDragStart: (e) => {
      fromTop = (e?.offset?.y ?? 0) <= 1;
    },
    actions: () => (shown() ? undefined : [{ name: PULL_SEARCH_ACTION, label: options.label }]),
    onAction: (e) => {
      if (e?.actionName === PULL_SEARCH_ACTION) reveal();
    },
  };
}
