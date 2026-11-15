// Blurred glass in this window: whether it is drawn (lib/glassPolicy.ts has the rules), and the
// classes and style of a surface that takes it. Reactive: a browser's "reduce transparency"
// setting is followed as it changes.
import { platform, signal, untracked } from "nsh";
import { browserBackdropFilter, GLASS_BLUR, glassAvailable, glassFill, type BrowserGlobals, type GlassSurface } from "./glassPolicy";

export { GLASS_BLUR, GLASS_TINT, glassAvailable, glassFill, type GlassSurface } from "./glassPolicy";

const browser = globalThis as unknown as BrowserGlobals;
const backdropFilter = platform.os === "web" && browserBackdropFilter(browser);
const reducedTransparency = signal(false);
if (platform.os === "web" && typeof browser.matchMedia === "function") {
  try {
    const query = browser.matchMedia("(prefers-reduced-transparency: reduce)");
    reducedTransparency.set(query.matches === true);
    query.addEventListener?.("change", (event) => reducedTransparency.set(event.matches === true));
  } catch {
    // An engine without the query: no preference to follow.
  }
}

// Tests set the answer (tests/glassConsole.tsx, the fixtures): a headless window has no browser to ask.
const forced = signal<boolean | null>(null);
export function forceGlass(value: boolean | null) {
  forced.set(value);
}

/** Whether this window draws glass now (reactive). */
export function glassEnabled(): boolean {
  const answer = forced();
  if (answer !== null) return answer;
  return glassAvailable({ os: platform.os, version: platform.version, backdropFilter, reducedTransparency: reducedTransparency() });
}

/** The fill of `surface` in this window (reactive). */
export function glassClass(surface: GlassSurface): string {
  return glassFill(surface, glassEnabled());
}

// Android (nsh 0.5.0) can leave a glass view drawn without its blur for good: a view's backdrop is
// recorded just before each frame, and the view's own (cached) drawing takes it only if it was
// already recorded when the view was first drawn. Another glass view that lies over the page (the
// phone's bottom navigation) records first and draws the page for its own backdrop, the new bar
// in it, before the bar's backdrop exists; nothing draws the bar again after. So a bar under the
// navigation stayed sharp (Contacts, Settings) unless something else repainted it (Todo's head,
// whose border changes as its list scrolls). A new blur radius is the one change that surely
// repaints the view (`Backdrop.setBlur`), so each mounted glass surface asks for one, after its
// first frames: the radius moves by a hundredth of a point, which nobody sees.
const REPAINT_NUDGE = 0.01;
const REPAINT_AFTER = [80, 450];
const repaints = signal(0);
/** A glass surface was mounted (`BarRoom`): on Android, has every glass view drawn again once its backdrop is there (see above). */
export function glassMounted() {
  if (platform.os !== "android") return;
  for (const delay of REPAINT_AFTER) setTimeout(() => repaints.set(untracked(repaints) + 1), delay);
}

/** The style that blurs what lies behind a surface (nothing where no glass is drawn); spread it into the surface's own style. Only the backdrop blurs: what the surface holds stays sharp. */
export function glassStyle(): { backdropFilter?: string } {
  if (!glassEnabled()) return {};
  const blur = platform.os === "android" && repaints() % 2 === 1 ? GLASS_BLUR + REPAINT_NUDGE : GLASS_BLUR;
  return { backdropFilter: `blur(${blur}px)` };
}
