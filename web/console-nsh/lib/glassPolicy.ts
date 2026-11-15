// Blurred glass: the look of the surfaces that float over scrolling content (the composer's frame,
// a page's bar over its list, the phone's bottom navigation). One tint and one blur for all of
// them, and one answer to whether this window draws them at all:
//
//   - a browser: where CSS `backdrop-filter` works, and the reader has not asked for less
//     transparency (`prefers-reduced-transparency`, followed as it changes);
//   - Android: from Android 12 (API 31), where nsh draws a backdrop blur; older ones draw the
//     tint alone, which leaves text on text;
//   - iOS: always;
//   - the desktop app: never. Its renderer (GPUI) draws no backdrop blur at all.
//
// Where the answer is no the surfaces are opaque, on the theme's own fills, and the lists stop
// under the bars as they always did (components/frame/glassBar.tsx). nsh reports no "reduce
// transparency" setting of Android or iOS, so only a browser follows that one.
//
// This file is the policy alone, with no state and nothing of nsh in it (tests read it as it is);
// lib/glass.ts answers for the window the app runs in.
/** The blur of what lies behind a glass surface, in points. */
export const GLASS_BLUR = 20;
/** How much of a glass surface is its own fill (percent); the rest is the blurred content. */
export const GLASS_TINT = 78;
/** The first Android that draws a backdrop blur (`RenderEffect`). */
const ANDROID_BLUR_API = 31;

export interface GlassEnvironment {
  /** nsh's `platform.os`. */
  os: string;
  /** nsh's `platform.version`: Android's API level. */
  version?: string;
  /** A browser's `CSS.supports("backdrop-filter", …)`. */
  backdropFilter?: boolean;
  /** The reader asked for less transparency. */
  reducedTransparency?: boolean;
}

/** Whether a window in `env` draws glass (see above). */
export function glassAvailable(env: GlassEnvironment): boolean {
  if (env.reducedTransparency) return false;
  if (env.os === "web") return env.backdropFilter === true;
  if (env.os === "android") return Number.parseInt(String(env.version ?? ""), 10) >= ANDROID_BLUR_API;
  return env.os === "ios";
}

interface MediaQuery {
  matches: boolean;
  addEventListener?: (type: "change", listener: (event: { matches: boolean }) => void) => void;
}
export interface BrowserGlobals {
  CSS?: { supports?: (property: string, value: string) => boolean };
  matchMedia?: (query: string) => MediaQuery;
}

/** What a browser says of `backdrop-filter` (Safari before 18 knows only the prefixed name). */
export function browserBackdropFilter(globals: BrowserGlobals): boolean {
  const supports = globals.CSS?.supports;
  if (typeof supports !== "function") return false;
  try {
    return supports.call(globals.CSS, "backdrop-filter", "blur(1px)") || supports.call(globals.CSS, "-webkit-backdrop-filter", "blur(1px)");
  } catch {
    return false;
  }
}

/** The fills behind each surface: a page's paper, the navigation's card, the field's white. */
const GLASS_FILL = { bar: "background", nav: "card", composer: "dialog" } as const;
/** Each surface's fill where no glass is drawn. A bar has none of its own: nothing scrolls under it
 * there, and it lies on the page's paper as it always did. The composer keeps the field's fill, on
 * the conversation's fade to the paper. */
const OPAQUE_FILL = { bar: "", nav: "bg-card", composer: "bg-field" } as const;
export type GlassSurface = keyof typeof GLASS_FILL;

/** The classes of `surface`'s fill for `glass` (or not): its tint, or its opaque fill. */
export function glassFill(surface: GlassSurface, glass: boolean): string {
  return glass ? `bg-${GLASS_FILL[surface]}/${GLASS_TINT}` : OPAQUE_FILL[surface];
}
