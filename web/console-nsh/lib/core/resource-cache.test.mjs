import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  cacheClear,
  cacheDrop,
  cacheFlush,
  cacheHydrate,
  cachePeek,
  cacheRead,
  cacheWrite,
  clearCacheStateForTests,
  setCacheStore,
} from "./resource-cache.js";

/** A store in memory that records what it was asked. */
function fakeStore(initial = {}) {
  const files = new Map(Object.entries(initial));
  const eager = new Set();
  const log = [];
  return {
    files,
    log,
    get: async (key) => (log.push(`get ${key}`), files.get(key) ?? null),
    set: async (key, text, options) => {
      log.push(`set ${key}`);
      files.set(key, text);
      if (options?.eager) eager.add(key);
    },
    remove: async (prefix) => {
      log.push(`remove ${prefix}`);
      for (const key of [...files.keys()]) if (key === prefix || key.startsWith(`${prefix}:`)) files.delete(key);
    },
    clear: async () => (log.push("clear"), files.clear()),
    eager: async () => [...files].filter(([key]) => eager.has(key)),
  };
}

const stored = (value, group = "") => JSON.stringify({ value, at: 1, group });

beforeEach(() => clearCacheStateForTests());

test("a write is read back at once, without a store", async () => {
  assert.equal(cachePeek("a"), undefined);
  assert.equal(await cacheRead("a"), undefined);
  cacheWrite("a", { n: 1 });
  assert.deepEqual(cachePeek("a").value, { n: 1 });
  assert.deepEqual((await cacheRead("a")).value, { n: 1 });
});

test("a drop takes the key and what is under it, and nothing beside it", () => {
  cacheWrite("chat:topics:ep1", 1);
  cacheWrite("chat:topics:ep1:x", 2);
  cacheWrite("chat:topics:ep10", 3);
  cacheDrop("chat:topics:ep1");
  assert.equal(cachePeek("chat:topics:ep1"), undefined);
  assert.equal(cachePeek("chat:topics:ep1:x"), undefined);
  assert.equal(cachePeek("chat:topics:ep10").value, 3);
});

test("memory keeps the 20 conversations used last; the others stay in the store", async () => {
  const store = fakeStore();
  setCacheStore(store);
  for (let i = 0; i < 21; i += 1) cacheWrite(`h:${i}`, i, { group: "history" });
  cacheWrite("topics", "list");
  assert.equal(cachePeek("h:0"), undefined);
  assert.equal(cachePeek("h:1").value, 1);
  assert.equal(cachePeek("topics").value, "list");
  await cacheFlush();
  assert.equal((await cacheRead("h:0")).value, 0);
  // Reading h:0 back put h:2 out (h:1 was used a moment ago).
  assert.equal(cachePeek("h:2"), undefined);
});

test("writes reach the store together, a moment later; the last one of a key wins", async () => {
  const store = fakeStore();
  setCacheStore(store);
  cacheWrite("a", 1, { eager: true });
  cacheWrite("a", 2, { eager: true });
  assert.deepEqual(store.log, []);
  await cacheFlush();
  assert.deepEqual(store.log, ["set a"]);
  assert.equal(JSON.parse(store.files.get("a")).value, 2);
  assert.deepEqual((await store.eager()).map(([key]) => key), ["a"]);
});

test("a miss in memory is read from the store, once", async () => {
  const store = fakeStore({ a: stored("kept") });
  setCacheStore(store);
  assert.equal(cachePeek("a"), undefined);
  assert.equal((await cacheRead("a")).value, "kept");
  assert.equal(cachePeek("a").value, "kept");
  await cacheRead("a");
  assert.deepEqual(store.log, ["get a"]);
});

test("a text in the store that is no entry reads as nothing", async () => {
  setCacheStore(fakeStore({ a: "{not json", b: JSON.stringify({ at: 1 }) }));
  assert.equal(await cacheRead("a"), undefined);
  assert.equal(await cacheRead("b"), undefined);
});

test("an entry too long for the store stays in memory, and the store's older one goes", async () => {
  const store = fakeStore({ a: stored("old") });
  setCacheStore(store);
  cacheWrite("a", "x".repeat(1024 * 1024 + 1));
  await cacheFlush();
  assert.equal(store.files.has("a"), false);
  assert.equal(cachePeek("a").value.length, 1024 * 1024 + 1);
});

test("an entry kept from the store (persist: false) is not written to it", async () => {
  const store = fakeStore();
  setCacheStore(store);
  cacheWrite("a", 1, { persist: false });
  await cacheFlush();
  assert.equal(store.files.size, 0);
  assert.equal(cachePeek("a").value, 1);
});

test("a drop and a clear reach the store, and writes waiting for it are not sent after", async () => {
  const store = fakeStore({ "a:1": stored(1), b: stored(2) });
  setCacheStore(store);
  cacheWrite("a:2", 3);
  cacheDrop("a");
  await cacheFlush();
  assert.deepEqual([...store.files.keys()], ["b"]);
  cacheWrite("c", 4);
  cacheClear();
  await cacheFlush();
  assert.equal(store.files.size, 0);
  assert.equal(cachePeek("c"), undefined);
});

test("a clear while the store is read does not bring the entry back", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const store = fakeStore({ a: stored("old account") });
  const get = store.get;
  store.get = async (key) => {
    const text = await get(key);
    await gate;
    return text;
  };
  setCacheStore(store);
  const reading = cacheRead("a");
  cacheClear();
  release();
  assert.equal(await reading, undefined);
  assert.equal(cachePeek("a"), undefined);
});

test("the eager entries are in memory after the start, the others are read when asked for", async () => {
  const store = fakeStore();
  setCacheStore(store);
  cacheWrite("topics", ["t"], { eager: true });
  cacheWrite("history", ["h"], { group: "history" });
  await cacheFlush();
  // A new run: memory is empty, the store is the same.
  const files = store.files;
  const eager = await store.eager();
  clearCacheStateForTests();
  setCacheStore({ ...store, files, eager: async () => eager });
  await cacheHydrate();
  assert.deepEqual(cachePeek("topics").value, ["t"]);
  assert.equal(cachePeek("history"), undefined);
  assert.deepEqual((await cacheRead("history")).value, ["h"]);
});

test("a store that fails is a miss, not an error", async () => {
  setCacheStore({
    get: async () => {
      throw new Error("disk");
    },
    set: async () => {
      throw new Error("disk");
    },
    remove: async () => {},
    clear: async () => {},
    eager: async () => {
      throw new Error("disk");
    },
  });
  assert.equal(await cacheRead("a"), undefined);
  cacheWrite("a", 1);
  await cacheFlush();
  await cacheHydrate();
  assert.equal(cachePeek("a").value, 1);
});
