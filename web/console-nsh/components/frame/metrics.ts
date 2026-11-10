// The frame's metrics (layouts/AppLayout.css): the page bar and the sidebar's switcher share one
// height so their bottom hairlines are one line across the window; content gutters follow the
// window's width (CSS clamp() on vw), tighter on tablets and phones. No imports beyond nsh, so
// the design system can read them without pulling in the app's state.
import { computed, windowSize } from "nsh";

const MOBILE_BREAKPOINT = 980;
/** The page bar's and the agent switcher's height, hairline included (`--chrome-bar-height`). */
export const CHROME_BAR_HEIGHT = 57;
const clamp = (min: number, value: number, max: number) => Math.min(max, Math.max(min, value));
/** The content's side gutter (`--content-gutter-x`): clamp(16px, 2vw, 28px); 14 under 980, 12 under 620. */
export const gutterX = computed(() => {
  const width = windowSize().width;
  if (width <= 620) return 12;
  if (width <= MOBILE_BREAKPOINT) return 14;
  return Math.round(clamp(16, width * 0.02, 28) * 10) / 10;
});
/** The content's top and bottom gutter (`--content-gutter-y`): clamp(12px, 1.4vw, 20px); 12 under 980, 10 under 620. */
export const gutterY = computed(() => {
  const width = windowSize().width;
  if (width <= 620) return 10;
  if (width <= MOBILE_BREAKPOINT) return 12;
  return Math.round(clamp(12, width * 0.014, 20) * 10) / 10;
});
/** A page body's gap between sections and its top padding (AppPage.css `.page-body`). */
export const pageGap = computed(() => Math.round(clamp(14, windowSize().width * 0.016, 24) * 10) / 10);
export const pageTop = computed(() => Math.round(clamp(14, windowSize().width * 0.014, 20) * 10) / 10);

/**
 * The size of a title in a list row of the second column (Topics, Contacts, Memories, Skills,
 * TODO): 14pt on a desktop, 15pt below the mobile breakpoint, where the list is a screen of its own
 * (the 15pt of the phone panels' titles). Each row sets its line height to match; meta lines stay
 * 12pt.
 */
export const listTitleSize = (mobile: boolean) => (mobile ? "text-[15px]" : "text-sm");
