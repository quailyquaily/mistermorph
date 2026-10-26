import assert from "node:assert/strict";
import test from "node:test";

import {
  ELEVATION_PINS_STORAGE_KEY,
  elevationPinNeedsConfirm,
  forgetElevationIdentity,
  pinElevationIdentity,
  pinnedElevationIdentity,
} from "./elevation-pins.js";

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

test("a pin can be forgotten", () => {
  const storage = memoryStorage();
  pinElevationIdentity("remote", "key-b", storage);
  assert.equal(forgetElevationIdentity("remote", storage), true);
  assert.equal(pinnedElevationIdentity("remote", storage), "");
  assert.equal(forgetElevationIdentity("remote", storage), false);
});

test("only the Console's own runtime, reached locally, is pinned without asking", () => {
  const local = "ep_console_local";
  const cases = [
    [{ hostname: "localhost" }, local, false],
    [{ hostname: "127.0.0.1" }, local, false],
    [{ hostname: "[::1]" }, local, false],
    [{ desktop: true, hostname: "" }, local, false],
    [{ hostname: "console.example" }, local, true],
    [{ hostname: "192.168.1.5" }, local, true],
    [{ hostname: "localhost" }, "ep_remote", true],
    [{ hostname: "localhost" }, "", true],
  ];
  for (const [env, ref, want] of cases) {
    assert.equal(elevationPinNeedsConfirm(ref, { localEndpointRef: local, ...env }), want, `${ref} ${JSON.stringify(env)}`);
  }
});
