// Blurred glass in this window: whether it is drawn (lib/glassPolicy.ts has the rules), and the
// classes and style of a surface that takes it. Reactive: a browser's "reduce transparency"
// setting is followed as it changes.
import { platform, signal } from "nsh";
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

/** The style that blurs what lies behind a surface (nothing where no glass is drawn); spread it into the surface's own style. Only the backdrop blurs: what the surface holds stays sharp. */
export function glassStyle(): { backdropFilter?: string } {
  return glassEnabled() ? { backdropFilter: `blur(${GLASS_BLUR}px)` } : {};
}
