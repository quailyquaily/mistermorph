// A page's own levels on phones: a list (level 0) and one of its items (level 1, and further in),
// shown one at a time by the same page instance (Chat's topics and a conversation, Settings'
// sections and a section, Memories, Audit, Skills, TODO, Contacts, the context inspector's steps).
// The page host (components/frame/PageStack.tsx) sees no new page there, so the page moves its
// panes itself with the same slides: further in slides in from the right over the list, back
// slides the item out to the right, revealing the list.
//
//   const panes = createPaneStack(() => (isMobile() ? (detailVisible() ? 1 : 0) : null));
//   <If when={panes.shown(0, showIndex())}>
//     <View
//       class="flex-1"
//       style={panes.style(0)}
//       accessibilityElementsHidden={panes.hidden(0) || undefined}
//       importantForAccessibility={panes.hidden(0) ? "no-hide-descendants" : undefined}
//     >…</View>
//   </If>
//
// `level` is null where the panes stand side by side (wide windows): nothing moves and `style`
// adds nothing. The pane going out stays mounted until its slide ends (`shown`), laid over the
// panes' box, inert and hidden from assistive tech; what it shows is the page's: a page whose item
// clears as it goes back shows it through `held`, or lets it go once the pane has gone
// (`settled`). A change during a slide turns it round from where the panes are; a resize, a
// rotation or reduced motion ends it at once.
import type { Motion } from "nsh";
import { batch, createMotion, effect, Keyboard, reduceMotion, signal, untracked, windowSize } from "nsh";
import { currentX, FILL, nativeSlide, pageSlideMs, slideFrames, type SlideDriver } from "./pageSlide";

const LEVELS = 4;

export interface PaneStack {
  /** Whether the pane of `level` is drawn: `wanted` (the page's own condition), or while it goes out. */
  shown(level: number, wanted: boolean): boolean;
  /** The pane's motion, its place above or below the other and, while it goes out, its box over the panes. */
  style(level: number): Record<string, unknown> | undefined;
  /** Whether the pane of `level` is going out (inert, hidden from assistive tech). */
  hidden(level: number): boolean;
  /** The level going out, null when none. */
  exiting(): number | null;
  /** The slide running now: `"push"` (further in) or `"pop"` (back), else null. */
  sliding(): "push" | "pop" | null;
  /** Resolves once no pane is going out. */
  settled(): Promise<void>;
  /**
   * `read` as the pane of `level` shows it: its value, except while that pane goes out (from the
   * moment another level is wanted until its slide has ended), when it keeps the last one (the pane
   * going out keeps its title, its item).
   */
  held<T>(level: number, read: () => T): () => T;
}

/**
 * How long after the page appears a change of level is still part of its arrival (an address that
 * names a section or an item, opened as the page mounts or its data comes): it switches at once,
 * so a page never slides twice as it arrives (the page host slides it in).
 */
export const PANE_ARRIVAL_MS = 500;

export function createPaneStack(
  level: () => number | null,
  options: { driver?: SlideDriver; arrivalMs?: number } = {},
): PaneStack {
  const bornAt = Date.now();
  const motions: Motion[] = Array.from({ length: LEVELS }, () => createMotion());
  const exiting = signal<number | null>(null);
  const sliding = signal<"push" | "pop" | null>(null);
  const top = signal<number | null>(null);
  // The level fully shown: the one before while a slide runs, the new one once it has ended.
  const shownLevel = signal<number | null>(untracked(level));
  let generation = 0;
  let waiting: (() => void)[] = [];

  function release() {
    const list = waiting;
    waiting = [];
    for (const resolve of list) resolve();
  }

  /** Stops the running slide's motions where they end (no state change). */
  function stopMotions() {
    generation += 1;
    for (const motion of motions) {
      motion.stop();
      motion.reset();
    }
  }

  /** Ends the running slide at once: the pane going out goes, the level wanted is the one shown. */
  function settle() {
    const wasRunning = untracked(exiting) !== null;
    // The pane going out goes first, then the motions come back to rest (never a frame of it back in place).
    batch(() => {
      exiting.set(null);
      sliding.set(null);
      top.set(null);
      shownLevel.set(untracked(level));
    });
    stopMotions();
    if (wasRunning) release();
  }

  let previous = untracked(level);
  effect(() => {
    const next = level();
    untracked(() => {
      const prev = previous;
      previous = next;
      if (prev === next) return;
      const arriving = Date.now() - bornAt < (options.arrivalMs ?? PANE_ARRIVAL_MS);
      const slides =
        !arriving && prev !== null && next !== null && prev >= 0 && next >= 0 && prev < LEVELS && next < LEVELS && !reduceMotion() && pageSlideMs() > 0;
      if (!slides) {
        settle();
        return;
      }
      // One change of state for the whole start, so `held` values never see a step between. A
      // slide still running turns round: its panes go on from where they are, the others rest.
      const running = untracked(exiting);
      const moving = running === null ? [] : [running, prev];
      generation += 1;
      motions.forEach((motion, at) => {
        if (!moving.includes(at)) {
          motion.stop();
          motion.reset();
        }
      });
      const kind = next > prev ? "push" : "pop";
      const frames = slideFrames(kind, windowSize().width);
      // A text field of the pane going out keeps neither the focus nor the keyboard.
      Keyboard.dismiss();
      if (!moving.includes(next)) motions[next].translateX.set(frames.incoming[0]);
      batch(() => {
        exiting.set(prev);
        sliding.set(kind);
        top.set(kind === "push" ? next : prev);
        shownLevel.set(prev);
      });
      const gen = generation;
      const driver = options.driver ?? nativeSlide;
      const duration = pageSlideMs();
      const from = (at: number, start: number) => (moving.includes(at) ? currentX(motions[at]) : Promise.resolve(start));
      void Promise.all([from(next, frames.incoming[0]), from(prev, frames.outgoing[0])])
        .then(([inFrom, outFrom]) =>
          gen !== generation
            ? null
            : Promise.all([
                driver.play(motions[next], inFrom, frames.incoming[1], duration),
                driver.play(motions[prev], outFrom, frames.outgoing[1], duration),
              ]),
        )
        .then(() => {
          if (gen === generation) settle();
        });
    });
  });

  // A resize, a rotation or reduced motion turned on ends the slide where it ends.
  effect(() => {
    void windowSize().width;
    void windowSize().height;
    void reduceMotion();
    untracked(() => {
      if (exiting() !== null) settle();
    });
  });

  return {
    // The level shown until now stays drawn from the moment another is wanted: the slide starts in
    // the effects of that change, and a pane dropped in between would come back as a new one.
    shown: (at, wanted) => wanted || exiting() === at || (shownLevel() === at && level() !== null),
    style(at) {
      if (level() === null || at >= LEVELS) return undefined;
      const out = exiting() === at;
      return {
        ...motions[at].style,
        ...(out ? FILL : {}),
        zIndex: top() === null ? 0 : top() === at ? 2 : 1,
        pointerEvents: out ? "none" : "auto",
      };
    },
    hidden: (at) => exiting() === at,
    exiting: () => exiting(),
    sliding: () => sliding(),
    held<T>(at: number, read: () => T) {
      // A plain accessor, not a memo: it reads nothing until it is read (a page may hold what it
      // defines further down), and whoever reads it tracks `read` and the slide's state.
      let last: T;
      let has = false;
      return () => {
        const value = read();
        const now = level();
        const leaving = now !== null && now !== at && (exiting() === at || shownLevel() === at);
        if (!leaving || !has) {
          last = value;
          has = true;
        }
        return last;
      };
    },
    settled: () =>
      untracked(exiting) === null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.push(resolve);
          }),
  };
}

