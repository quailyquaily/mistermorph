// The window's layout: the phone layout (bottom navigation, one column) at and below the
// breakpoint, the desktop layout (sidebar, columns) above it. Width alone decides it, on every
// platform: a narrow desktop window has the phone layout, a wide tablet the desktop one.
// lib/shell.ts hands these on to the frame; lib/shortcutPolicy.ts reads the same signal.
import { computed, windowSize } from "nsh";

/** Below this width the sidebar gives way to the bottom navigation. */
export const MOBILE_BREAKPOINT = 980;
export const isMobile = computed(() => windowSize().width <= MOBILE_BREAKPOINT);
