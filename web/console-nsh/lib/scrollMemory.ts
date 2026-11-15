// Where a page's columns were scrolled, remembered while the console runs: leaving a page through
// the navigation (the sidebar, the phone's bottom bar) and coming back finds its list (column 2)
// and what is open beside it (column 3) where they were left.
//
// It is kept in this module's memory only: never in localStorage, sessionStorage, a database or on
// the server. A reload, or the app started again, begins with nothing remembered.
//
// An area is one scroller of a page: the page instance (its kind and its agent, as the page host
// keys it), the column, and a name within the column. Areas are remembered independently.
//
// Column 3 belongs to column 2's current item: its areas are remembered with that item's identity
// (`selection`). Coming back to the same item restores them; any other item, or none, forgets them
// and starts at the top. Only the last item's place is kept, never a history per item.
//
//   const memory = useScrollMemory({ column: 3, area: "detail", selection: () => selectedID() });
//   <Scroll ref={memory.ref} onScroll={memory.onScroll}>…</Scroll>      // a `List` too
//
// A page's content often arrives after the page: the remembered offset is applied again as the
// content grows (a scroller clamps an offset past its content's end), for a few seconds, and is
// kept as it was through that time. `ready` holds the restore back while it is false (a load in
// flight). The reader scrolling in the meantime ends it. Nothing animates.
import type { ListRef, ScrollEvent, ScrollRef } from "nsh";
import { cleanup, effect, signal, untracked } from "nsh";
import { currentRoute, pageInstanceKey } from "./router";
import { SystemBackScope } from "./systemBack";

/** A place in a list by its item: the item at the viewport's start, and how far past its start. */
export interface ScrollAnchor {
  id: string;
  offset: number;
}

export interface SavedScroll {
  /** The content offset. */
  y: number;
  /** Column 2's item it was saved with ("" for an area that has none). */
  selection: string;
  /** For a list whose rows are measured as they show (the conversation): the place by its item. */
  anchor?: ScrollAnchor;
}

const saved = new Map<string, SavedScroll>();

/** Told each area's offset as it scrolls (the tests' readout; nothing else listens). */
type Watcher = (key: string, y: number) => void;
const watchers = new Set<Watcher>();

/** Follows every area's live offset; returns how to stop. For tests. */
export function watchScrollAreas(watcher: Watcher) {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/** The scrolled places remembered now, by area. For tests. */
export function savedScrollAreas(): Record<string, SavedScroll> {
  return Object.fromEntries(saved);
}

/** Tells the watchers where an area is. */
export function reportScrollArea(key: string, y: number) {
  for (const watcher of watchers) watcher(key, y);
}

/**
 * An area's key: the page instance around the caller (call it in a component's body), the column
 * and the area's name. Readable, for the tests: `chat|ep_console_local|2|topics`.
 */
export function scrollAreaKey(column: 2 | 3, area: string) {
  // Outside a page (a component mounted on its own, as the tests' fixtures do) there is no route.
  const route = untracked(currentRoute) as ReturnType<typeof currentRoute> | null;
  const [page, endpoint] = (route ? pageInstanceKey(route) : "").split("\u0000");
  return `${page}|${endpoint ?? ""}|${column}|${area}`;
}

/** What is remembered for an area, if it was saved with this `selection`. */
export function recallScroll(key: string, selection = ""): SavedScroll | undefined {
  const entry = saved.get(key);
  return entry && entry.selection === selection ? entry : undefined;
}

/** Remembers an area's place; one at its top is not kept (an area never saved starts there). */
export function rememberScroll(key: string, value: SavedScroll) {
  if (value.y > 0.5 || value.anchor) saved.set(key, value);
  else saved.delete(key);
}

export function forgetScroll(key: string) {
  saved.delete(key);
}

/** Whether anything is remembered for an area, whatever it was saved with. */
export function hasSavedScroll(key: string) {
  return saved.has(key);
}

/**
 * The gaps between two tries of a restore, in milliseconds: the content may still be on its way
 * (a request, rows being measured). After the last one the place the scroller could reach is kept.
 */
const RETRY_GAPS_MS = [16, 40, 80, 150, 300, 500, 800, 1200, 2000];
/** How long after a try a scroll report is taken as that try's. */
const OWN_SCROLL_MS = 250;
/**
 * After a page's slide ended, when a restored place is applied again (see `notePageSettled`): at
 * once, and after the page host's own changes of that moment are on screen.
 */
const SETTLED_REAPPLY_MS = [0, 60, 200];

const settled = signal(0);

/**
 * The page host tells that a page's slide ended (components/frame/PageStack.tsx). nsh orders the
 * pages by moving their views, and a browser puts the scrollers of a view it moves back at their
 * top without a scroll report: the places restored in the page that arrived are applied again.
 */
export function notePageSettled() {
  settled.update((count) => count + 1);
}

/** Runs `run` each time a page's slide ended, for as long as the calling component lives. */
export function onPageSettled(run: () => void) {
  let first = true;
  effect(() => {
    void settled();
    if (first) {
      first = false;
      return;
    }
    untracked(run);
  });
}

export interface ScrollMemoryOptions {
  /** The page's column: 2 is its list, 3 what is open beside it. */
  column: 2 | 3;
  /** The area's name within the column (a page may have several). */
  area: string;
  /**
   * Column 3: the identity of column 2's current item ("" or null: none). The area is remembered
   * for that item only, and goes back to its top when the item changes.
   */
  selection?: () => string | null | undefined;
  /** False while the content is not there yet (a load in flight): the restore waits. */
  ready?: () => boolean;
}

export interface ScrollMemory {
  /** The scroller's `ref` (a `Scroll` or a `List`). */
  ref: (node: ScrollRef | ListRef) => void;
  /** The scroller's `onScroll`. */
  onScroll: (event: Pick<ScrollEvent, "offset" | "size" | "contentSize">) => void;
}

/**
 * Remembers where a page's scroller is, and puts it back when the page (or the scroller) is made
 * again. Call it in the body of the component that renders the scroller, inside a page.
 */
export function useScrollMemory(options: ScrollMemoryOptions): ScrollMemory {
  const key = scrollAreaKey(options.column, options.area);
  const selectionOf = () => String(options.selection?.() ?? "");
  const isReady = () => (options.ready ? Boolean(untracked(options.ready)) : true);
  let node: ScrollRef | ListRef | undefined;
  /** The offset the scroller last reported. */
  let live = 0;
  /** The offset being restored, while it is. */
  let target: number | null = null;
  let tries = 0;
  let triedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let selection = untracked(selectionOf);
  /** Whether the page around is the one shown (a page sliding out reports nothing worth keeping). */
  const shown = SystemBackScope();
  /** The place a restore reached, until the reader scrolls. */
  let restored: number | null = null;
  let reapplying: ReturnType<typeof setTimeout>[] = [];

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const store = (y: number) => {
    // Column 3 with nothing selected shows nothing to come back to.
    if (options.selection && !selection) return;
    rememberScroll(key, { y, selection });
  };
  /** The restore is over: what the scroller shows now is what is remembered. */
  const settle = (y: number, reached = false) => {
    stop();
    target = null;
    restored = reached ? y : null;
    store(y);
  };
  /** Tries the restore again from its first try. */
  const retry = (y: number) => {
    stop();
    target = y;
    tries = 0;
    attempt();
  };
  const attempt = () => {
    timer = undefined;
    if (target === null || !node || !isReady()) return;
    if (tries >= RETRY_GAPS_MS.length) {
      // The content stayed shorter than it was: as far as it goes.
      settle(live);
      return;
    }
    triedAt = Date.now();
    node.scrollTo({ y: target, animated: false });
    timer = setTimeout(attempt, RETRY_GAPS_MS[tries]);
    tries += 1;
  };
  /** Starts restoring what is remembered for the current item, if anything. */
  const begin = () => {
    stop();
    target = null;
    const entry = recallScroll(key, selection);
    if (!entry || entry.y <= 0.5) return;
    retry(entry.y);
  };

  if (options.selection) {
    // Remembered for another item: gone. While no item is known yet (the page is still finding
    // its selection), what is remembered waits for it.
    if (selection && hasSavedScroll(key) && !recallScroll(key, selection)) forgetScroll(key);
    effect(() => {
      const next = selectionOf();
      untracked(() => {
        if (next === selection) return;
        const previous = selection;
        selection = next;
        // The page found its selection, the one this area was left with.
        if (!previous && recallScroll(key, next)) {
          begin();
          return;
        }
        // Another item (or none): its column starts at the top, and the old place is not kept.
        stop();
        target = null;
        forgetScroll(key);
        if (node && live > 0.5) node.scrollTo({ y: 0, animated: false });
      });
    });
  }
  if (options.ready) {
    effect(() => {
      if (!options.ready?.()) return;
      untracked(() => {
        if (target === null || timer) return;
        tries = 0;
        attempt();
      });
    });
  }
  const stopReapplying = () => {
    for (const pending of reapplying) clearTimeout(pending);
    reapplying = [];
  };
  onPageSettled(() => {
    stopReapplying();
    reapplying = SETTLED_REAPPLY_MS.map((ms) =>
      setTimeout(() => {
        // Still where the restore put it, as far as the reader goes: there again.
        if (restored !== null && target === null && node) node.scrollTo({ y: restored, animated: false });
      }, ms),
    );
  });
  cleanup(() => {
    stop();
    stopReapplying();
    node = undefined;
  });

  return {
    ref(next) {
      node = next;
      live = 0;
      restored = null;
      begin();
    },
    onScroll(event) {
      // A page on its way out is not the reader's any more.
      if (shown && !untracked(shown)) return;
      const y = event.offset.y;
      const previous = live;
      live = y;
      reportScrollArea(key, y);
      // How far the content lets the scroller go.
      const end = Math.max(0, event.contentSize.height - event.size.height);
      if (target === null) {
        // Pulled back because the content no longer reaches where it was (rows going with the page
        // as it leaves, a list emptied while it loads again; a browser then puts it at the top,
        // other platforms at the content's end): not the reader's doing, and not their place.
        if (y < previous - 1 && previous > end + 1) return;
        restored = null;
        store(y);
        return;
      }
      if (Math.abs(y - target) <= 1) {
        settle(y, true);
        return;
      }
      // Short of the place: the content does not reach it yet (the try was clamped to its end),
      // so it stays remembered and is tried again.
      const own = Date.now() - triedAt <= OWN_SCROLL_MS && y <= target + 1 && y >= previous - 1;
      if (own || (y < target && Math.abs(y - end) <= 1)) return;
      // Anything else is the reader's own scroll: theirs is the place now.
      if (Math.abs(y - previous) > 1) settle(y);
    },
  };
}
