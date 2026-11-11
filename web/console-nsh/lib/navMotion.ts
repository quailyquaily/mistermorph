// Which way a navigation moves, decided once where it is committed (lib/router.ts) and drawn by
// the page host (pages/routes.tsx) and by pages that switch between a list and one of its items
// on phones (components/motion/PaneStack.tsx). Pure: no signals, no platform, so it is tested as is.
//
// - forward: a page further in (a topic, a section, the context inspector) slides in from the right;
// - back: the reverse, the page leaving slides out to the right over the one it reveals;
// - tab-forward / tab-back: the bottom navigation's pages side by side, in its order, as tiles of a
//   strip that moves left (to a later page) or right (to an earlier one);
// - fade: the frame itself changes (login, setup, the overview: no navigation around them), the
//   page settles in as before;
// - none: nothing moves (the first page, the same page with other data, another agent's copy).
//
// History knows where it goes: a browser's back or forward button, and Android's Back, replay the
// motion of the step they undo (reversed) or redo, from the entries the router keeps in this run.
import { NAV_TAB_PATHS } from "./navOrder";

export type PageMotion = "none" | "fade" | "forward" | "back" | "tab-forward" | "tab-back";

export { NAV_TAB_PATHS };

/** Where a page sits: its bottom-navigation page (-1 for none), how deep below it, and its frame. */
export interface NavPosition {
  tab: number;
  depth: number;
  frame: "shell" | "standalone" | "shellless";
}

/** The path below the endpoint prefix (`/e/default/chat/1` → `/chat/1`), or the path itself. */
export function pagePathOf(path: string) {
  const value = String(path || "").trim() || "/";
  const match = value.match(/^\/e\/[^/]+(?=\/|$)/);
  if (!match) return value;
  return value.slice(match[0].length) || "/";
}

// Pages outside the navigation that open from one of its pages, as a page further in.
const CHILD_PAGES: { prefix: string; tab: string; depth: number }[] = [
  // Settings → System → Logs.
  { prefix: "/logs", tab: "/settings", depth: 2 },
];

const SHELLLESS = ["/login", "/__boot-preview", "/__components", "/troubleshooting"];

function frameOf(pagePath: string, fullPath: string): NavPosition["frame"] {
  if (fullPath === "/" || SHELLLESS.some((prefix) => pagePath === prefix || pagePath.startsWith(`${prefix}/`))) return "shellless";
  if (pagePath === "/overview" || pagePath === "/setup" || pagePath.startsWith("/setup/")) return "standalone";
  return "shell";
}

/** Where `path` (no query) sits in the navigation. */
export function navPosition(path: string): NavPosition {
  const full = String(path || "").trim() || "/";
  const page = pagePathOf(full);
  const frame = frameOf(page, full);
  const parts = page.split("/").filter(Boolean);
  for (const child of CHILD_PAGES) {
    if (page === child.prefix || page.startsWith(`${child.prefix}/`)) {
      return { tab: NAV_TAB_PATHS.indexOf(child.tab), depth: child.depth, frame };
    }
  }
  const tab = NAV_TAB_PATHS.findIndex((root) => page === root || page.startsWith(`${root}/`));
  if (tab < 0) return { tab: -1, depth: 0, frame };
  const rootParts = NAV_TAB_PATHS[tab].split("/").filter(Boolean).length;
  return { tab, depth: Math.max(0, parts.length - rootParts), frame };
}

export interface MotionOptions {
  /** The navigation came from the navigation itself (sidebar, bottom bar, More). */
  tab?: boolean;
  /** A history step whose direction is not known: an equal step counts as going back. */
  pop?: boolean;
}

/** The motion from `from` to `to` (paths without query), by where they sit. */
export function classifyPageMotion(from: string | null | undefined, to: string, options: MotionOptions = {}): PageMotion {
  if (from === null || from === undefined) return "none";
  if (from === to) return "none";
  const a = navPosition(from);
  const b = navPosition(to);
  if (a.frame !== b.frame) return "fade";
  const tabs = a.tab >= 0 && b.tab >= 0;
  const byTab = (): PageMotion => (b.tab > a.tab ? "tab-forward" : "tab-back");
  if (options.tab && tabs && a.tab !== b.tab) return byTab();
  if (tabs && a.tab === b.tab) {
    if (b.depth > a.depth) return "forward";
    if (b.depth < a.depth) return "back";
    return "none";
  }
  if (tabs && a.depth === 0 && b.depth === 0) return byTab();
  if (b.depth > a.depth) return "forward";
  if (b.depth < a.depth) return "back";
  if (a.frame !== "shell") return "none";
  return options.pop ? "back" : "forward";
}

/** The motion that undoes `motion` (a history step back over it). */
export function reversePageMotion(motion: PageMotion): PageMotion {
  switch (motion) {
    case "forward":
      return "back";
    case "back":
      return "forward";
    case "tab-forward":
      return "tab-back";
    case "tab-back":
      return "tab-forward";
    default:
      return motion;
  }
}

interface Entry {
  location: string;
  /** The motion that arrived here (from the entry before). */
  motion: PageMotion;
}

/**
 * The run's history as the router wrote it (push, replace) with the motion of each step, so a
 * history step can replay it: back over an entry plays its motion reversed, forward to one plays
 * it again. A step to a place that is neither neighbour (a jump of several entries, a history from
 * before a reload) is not known: the caller decides it from the pages.
 */
export class MotionHistory {
  private entries: Entry[] = [];
  private index = -1;
  /** Replacing with the place before is going back to it (the phone app's own history does so). */
  constructor(private readonly collapseReplaceToPrevious = false) {}

  push(location: string, motion: PageMotion) {
    if (this.index >= 0 && this.entries[this.index].location === location) return;
    this.entries = [...this.entries.slice(0, this.index + 1), { location, motion }];
    this.index = this.entries.length - 1;
  }

  replace(location: string, motion: PageMotion = "none") {
    if (this.index < 0) {
      this.entries = [{ location, motion: "none" }];
      this.index = 0;
      return;
    }
    if (this.collapseReplaceToPrevious && this.index > 0 && this.entries[this.index - 1].location === location) {
      this.entries = this.entries.slice(0, this.index);
      this.index -= 1;
      return;
    }
    const kept = this.entries[this.index].motion;
    this.entries = [...this.entries.slice(0, this.index), { location, motion: kept === "none" ? motion : kept }];
  }

  /** A history step to `location`: its motion, or null when it is not a neighbour. */
  pop(location: string): PageMotion | null {
    const back = this.index > 0 ? this.entries[this.index - 1] : null;
    const forward = this.index >= 0 && this.index + 1 < this.entries.length ? this.entries[this.index + 1] : null;
    if (back && back.location === location) {
      const motion = reversePageMotion(this.entries[this.index].motion);
      this.index -= 1;
      return motion;
    }
    if (forward && forward.location === location) {
      this.index += 1;
      return forward.motion;
    }
    // Somewhere else: start again from there.
    this.entries = [{ location, motion: "none" }];
    this.index = 0;
    return null;
  }

  /** The motion recorded for the current entry (tests). */
  current(): { location: string; motion: PageMotion } | null {
    return this.index >= 0 ? { ...this.entries[this.index] } : null;
  }
}

/** How the page host draws a motion. */
export type PagePresentation = "none" | "rise" | "push" | "pop" | "tab-forward" | "tab-back";

/** What the page host plays for `motion` on a phone (`stacked`) or a wide window, as the user asks. */
export function pagePresentation(
  motion: PageMotion,
  options: { stacked: boolean; reduced: boolean; topChanged: boolean },
): PagePresentation {
  if (options.reduced) return "none";
  if (!options.stacked) {
    // Wide windows keep the console's page entrance: a new top-level page rises into place.
    return motion !== "none" && options.topChanged ? "rise" : "none";
  }
  switch (motion) {
    case "forward":
      return "push";
    case "back":
      return "pop";
    case "tab-forward":
    case "tab-back":
      return motion;
    case "fade":
      return "rise";
    default:
      return "none";
  }
}

/** The top-level page of a path (`chat` for `/e/default/chat/1`), as the old page entrance keyed it. */
export function topPageOf(path: string) {
  return pagePathOf(path).split("/")[1] || "";
}
