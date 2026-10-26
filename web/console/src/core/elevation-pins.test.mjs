import assert from "node:assert/strict";
import test from "node:test";

import { ELEVATION_PINS_STORAGE_KEY, pinElevationIdentity, pinnedElevationIdentity } from "./elevation-pins.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test("an identity is pinned per endpoint", () => {
  const storage = memoryStorage();
  assert.equal(pinnedElevationIdentity("local", storage), "");
  assert.equal(pinElevationIdentity("local", "key-a", storage), true);
  assert.equal(pinElevationIdentity("remote", "key-b", storage), true);
  assert.equal(pinnedElevationIdentity("local", storage), "key-a");
  assert.equal(pinnedElevationIdentity("remote", storage), "key-b");
  assert.equal(pinElevationIdentity("local", "key-c", storage), true);
  assert.equal(pinnedElevationIdentity("local", storage), "key-c");
});

test("pins survive broken or missing storage", () => {
  const broken = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(pinnedElevationIdentity("local", broken), "");
  assert.equal(pinElevationIdentity("local", "key-a", broken), false);
  assert.equal(pinnedElevationIdentity("local", null), "");
  const garbled = memoryStorage();
  garbled.setItem(ELEVATION_PINS_STORAGE_KEY, "[1,2");
  assert.equal(pinnedElevationIdentity("local", garbled), "");
  assert.equal(pinElevationIdentity("", "key-a", garbled), false);
});
