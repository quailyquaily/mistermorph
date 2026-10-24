// Page changes settle in: moving to another page (Chat to Settings, not to another topic or
// another settings section) lets the new page rise a few pixels into place as it fades in. The
// sidebar and the phone's nav keep still, and their selection glides as soon as a page is chosen
// (composables/useAppShell.js).
//
// The page is animated once it is on screen, by the compositor. Nothing waits for it: the browser
// keeps rendering while the new page's code and data load, so the selection's glide never stalls.
// (A view transition would hold every frame, the glide's included, until the new page was built.)
// With reduced motion, pages simply switch.

import { nextTick } from "vue";

const PAGE_SELECTOR = ".workspace > .content";
const ENTER_MS = 220;
const ENTER_EASE = "cubic-bezier(0.2, 0, 0, 1)";

function pageOf(path, pagePath) {
  return String(pagePath(path) || "").split("/")[1] || "";
}

function installPageTransitions(router, pagePath) {
  if (typeof document === "undefined") {
    return;
  }
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  router.afterEach((to, from, failure) => {
    if (failure || reduced?.matches || !from.matched.length || pageOf(to.path, pagePath) === pageOf(from.path, pagePath)) {
      return;
    }
    void nextTick(() => {
      const page = document.querySelector(PAGE_SELECTOR);
      page?.animate?.(
        [
          { opacity: 0, transform: "translateY(6px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: ENTER_MS, easing: ENTER_EASE },
      );
    });
  });
}

export { installPageTransitions };
