import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { tabsOverflowEdges, tabsScrollTarget } from "./tabs-scroll.js";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("tabsScrollTarget brings the active option of a scrolling row into view", () => {
  const row = { clientWidth: 280, scrollWidth: 440 };
  // A row that fits never scrolls.
  assert.equal(tabsScrollTarget({ clientWidth: 300, scrollWidth: 300, start: 200, end: 290 }), null);
  // Already in view.
  assert.equal(tabsScrollTarget({ ...row, scrollLeft: 0, start: 100, end: 200 }), null);
  // Past the right edge: scroll just far enough, keeping the track's 2px inset.
  assert.equal(tabsScrollTarget({ ...row, scrollLeft: 0, start: 306, end: 438 }), 160);
  // Past the left edge.
  assert.equal(tabsScrollTarget({ ...row, scrollLeft: 160, start: 2, end: 100 }), 0);
  assert.equal(tabsScrollTarget({ ...row, scrollLeft: 160, start: 102, end: 230 }), 100);
  // Never past the row's ends.
  assert.equal(tabsScrollTarget({ ...row, scrollLeft: 0, start: 400, end: 500 }), 160);
});

test("tabsOverflowEdges marks the ends that hide options", () => {
  assert.deepEqual(tabsOverflowEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }), { start: false, end: false });
  assert.deepEqual(tabsOverflowEdges({ scrollLeft: 0, clientWidth: 280, scrollWidth: 440 }), { start: false, end: true });
  assert.deepEqual(tabsOverflowEdges({ scrollLeft: 80, clientWidth: 280, scrollWidth: 440 }), { start: true, end: true });
  assert.deepEqual(tabsOverflowEdges({ scrollLeft: 160, clientWidth: 280, scrollWidth: 440 }), { start: true, end: false });
});

test("AppTabs keeps labels whole on narrow screens and scrolls an overflowing row", async () => {
  const styles = await source("../components/AppTabs.css");
  const component = await source("../components/AppTabs.js");

  assert.match(styles, /\.app-tabs \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;[^}]*scrollbar-width: none;/us);
  // Options keep their natural width: no option is squeezed to an ellipsis.
  assert.match(styles, /\.app-tabs-option \{[^}]*flex: 0 0 auto;/us);
  assert.equal(/\.app-tabs-option \{[^}]*flex: 0 1 auto;/us.test(styles), false);
  // Equal options share the row but never drop below their label.
  assert.match(styles, /\.app-tabs\.is-equal \.app-tabs-option,\s*\.app-tabs\.is-equal \.app-tabs-option\.is-icon-only \{[^}]*flex: 1 1 0;[^}]*min-width: max-content;/us);
  // The track hugs its options, so its inner padding is even on every side.
  assert.match(styles, /\.app-tabs:not\(\.is-equal\) \{\s*width: fit-content;\s*max-width: 100%;/u);
  // Hidden ends fade.
  assert.match(styles, /\.app-tabs\.is-overflow-start \{\s*--app-tabs-fade-start: 24px;/u);
  assert.match(styles, /\.app-tabs\.is-overflow-end \{\s*--app-tabs-fade-end: 24px;/u);
  assert.match(component, /'is-overflow-start': overflow\.start, 'is-overflow-end': overflow\.end/u);
  assert.match(component, /@scroll\.passive="updateOverflow"/u);
  // The active option is revealed along the row, smoothly only without reduced motion.
  assert.match(component, /revealActive\(el, active\);/u);
  assert.match(component, /prefers-reduced-motion: reduce/u);
});

test("equal-width tab rows use the equal prop instead of their own flex overrides", async () => {
  const todo = await source("../views/TodoView.js");
  const todoStyles = await source("../views/TodoView.css");
  const picker = await source("../components/InferenceProviderPicker.js");
  const pickerStyles = await source("../components/InferenceProviderPicker.css");

  assert.match(todo, /:tabs="repeatKindTabs"\s*equal/u);
  assert.match(picker, /:tabs="groupTabs"\s*equal/u);
  assert.equal(todoStyles.includes(".todo-repeat-kind-tabs .app-tabs-option {\n  flex: 1 1 0;"), false);
  assert.equal(pickerStyles.includes(".inference-provider-tabs .app-tabs-option {"), false);
});
