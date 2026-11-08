import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transitionTimeMs } from "./transition-time.js";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("transitionTimeMs reads the longest transition, and zero under reduced motion", () => {
  assert.equal(transitionTimeMs({ transitionDuration: "0.2s", transitionDelay: "0s" }), 200);
  assert.equal(transitionTimeMs({ transitionDuration: "200ms, 0.28s", transitionDelay: "0s, 10ms" }), 290);
  assert.equal(transitionTimeMs({ transitionDuration: "0.1s, 0.2s", transitionDelay: "0.15s" }), 350);
  // Reduced motion sets the sheet's durations to 0ms: the sheet unmounts at once.
  assert.equal(transitionTimeMs({ transitionDuration: "0s", transitionDelay: "0s" }), 0);
  assert.equal(transitionTimeMs({}), 0);
  assert.equal(transitionTimeMs(null), 0);
});

test("the mobile bottom sheets slide in and out and stay mounted until they have gone", async () => {
  const component = await source("../components/AppMobileBottomMenu.js");

  // rendered keeps the sheet in the page; open is where it is heading.
  assert.match(component, /const rendered = ref\(props\.modelValue\);\s*const open = ref\(props\.modelValue\);/u);
  assert.match(component, /<div v-if="rendered" class="mobile-bottom-menu-layer" :class="\{ 'is-open': open \}">/u);
  assert.equal(component.includes("<Transition"), false);
  // Opening lays a new sheet out at its closed position before heading open, so it rises.
  assert.match(component, /if \(mounting\) \{[\s\S]*?void panel\.value\?\.offsetHeight;\s*\}\s*open\.value = true;/u);
  // Closing waits for the slide as styled (zero under reduced motion), then unmounts, unless
  // the sheet was opened again meanwhile.
  assert.match(component, /const duration = panel\.value \? transitionTimeMs\(window\.getComputedStyle\(panel\.value\)\) : 0;/u);
  assert.match(component, /closeTimer = setTimeout\(finishClose, duration \+ 50\);/u);
  assert.match(component, /function finishClose\(\) \{\s*clearCloseTimer\(\);\s*if \(!props\.modelValue\) \{\s*rendered\.value = false;/u);
  assert.match(component, /if \(value\) \{\s*clearCloseTimer\(\);/u);
  // A closing sheet takes no focus; focus goes back to what opened it.
  assert.match(component, /:inert="!open"/u);
  assert.match(component, /focusBeforeOpen\.focus\(\);/u);
  assert.match(component, /onBeforeUnmount\(\(\) => \{\s*clearCloseTimer\(\);\s*window\.removeEventListener\("keydown", onWindowKeydown\);/u);
});

test("the sheet motion rises from behind the nav strip and respects reduced motion", async () => {
  const styles = await source("../components/AppMobileBottomMenu.css");

  assert.match(styles, /--mobile-sheet-in: 280ms;\s*--mobile-sheet-out: 200ms;/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.mobile-bottom-menu-layer \{\s*--mobile-sheet-in: 0ms;\s*--mobile-sheet-out: 0ms;/u);
  // Closed: a full sheet-height lower, behind the strip; open: in place.
  assert.match(styles, /\.mobile-bottom-menu-panel \{[^}]*bottom: calc\(var\(--mobile-nav-height\) \+ env\(safe-area-inset-bottom, 0px\)\);[^}]*transform: translate3d\(0, 100%, 0\);[^}]*transition: transform var\(--mobile-sheet-out\) var\(--mobile-sheet-ease-out\);/us);
  assert.match(styles, /\.mobile-bottom-menu-layer\.is-open \.mobile-bottom-menu-panel \{\s*transform: translate3d\(0, 0, 0\);\s*transition: transform var\(--mobile-sheet-in\) var\(--mobile-sheet-ease-in\);/u);
  // The tint fades with it, and a closing layer lets taps through to the page.
  assert.match(styles, /\.mobile-bottom-menu-layer \{[^}]*background-color: rgb\(20 29 48 \/ 0%\);[^}]*pointer-events: none;/us);
  assert.match(styles, /\.mobile-bottom-menu-layer\.is-open \{\s*background-color: rgb\(20 29 48 \/ 14%\);\s*pointer-events: auto;/u);
});

test("both the More sheet and the agent sheet use the shared bottom menu", async () => {
  const nav = await source("../components/AppMobileBottomNav.js");
  const agent = await source("../components/AppMobileAgentSwitcher.js");

  assert.match(nav, /<AppMobileBottomMenu\s+:modelValue="modelValue"/u);
  assert.match(agent, /<AppMobileBottomMenu\s+:modelValue="modelValue"/u);
});
