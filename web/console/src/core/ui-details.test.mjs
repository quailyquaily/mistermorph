import assert from "node:assert/strict";
import test from "node:test";

import { wheelStep } from "./rolling-wheel.js";
import { splitShortcut } from "./tooltips.js";

test("a tooltip's shortcut at its end is split into key caps", () => {
  assert.deepEqual(splitShortcut("New topic (Ctrl+N)"), { label: "New topic", keys: ["Ctrl", "N"] });
  assert.deepEqual(splitShortcut("Close (Esc)"), { label: "Close", keys: ["Esc"] });
  assert.deepEqual(splitShortcut("Send (Shift + Enter)"), { label: "Send", keys: ["Shift", "Enter"] });
  assert.deepEqual(splitShortcut("Search (⌘K)"), { label: "Search", keys: ["⌘K"] });
  // Parentheses that are not a shortcut stay text.
  assert.deepEqual(splitShortcut("Tokens (cached)"), { label: "Tokens (cached)", keys: [] });
  assert.deepEqual(splitShortcut(""), { label: "", keys: [] });
});

test("a rolling digit turns the short way round", () => {
  assert.equal(wheelStep(19, 0), 1); // 9 to 0: one step on
  assert.equal(wheelStep(10, 9), -1); // 0 to 9: one step back
  assert.equal(wheelStep(12, 8), -4);
  assert.equal(wheelStep(13, 8), 5); // a tie goes forward
  assert.equal(wheelStep(15, 5), 0);
});
