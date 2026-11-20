// The phone apps' cache store (lib/cacheFiles.ts) on a file system in memory.
import assert from "node:assert/strict";
import test from "node:test";

import { CACHE_VERSION, openCacheFiles } from "../cacheFiles.ts";

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const missing = (path) => Object.assign(new Error(`no such file: ${path}`), { code: "ENOENT" });
  return {
    files,
    names: () => [...files.keys()].map((path) => path.replace("/data/cache/", "")).sort(),
    readFile: async (path) => {
      if (!files.has(path)) throw missing(path);
      return files.get(path);
    },
    writeFile: async (path, data) => void files.set(path, data),
    readdir: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
    unlink: async (path) => {
      if (!files.delete(path)) throw missing(path);
    },
    mkdir: async () => {},
    rename: async (from, to) => {
      if (!files.has(from)) throw missing(from);
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

const DIR = "/data/cache";
let scope = "https://morph.test/|console";
const open = (fs, options = {}) => openCacheFiles({ fs, dir: DIR, scope: () => scope, indexDelay: 0, ...options });
const index = (fs) => JSON.parse(fs.files.get(`${DIR}/index.json`));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("an entry written is read back, also by a store opened later", async () => {
  const fs = fakeFs();
  const store = await open(fs);
  assert.equal(await store.get("a"), null);
  await store.set("a", "one");
  await store.set("a", "two");
  assert.equal(await store.get("a"), "two");
  assert.equal(await (await open(fs)).get("a"), "two");
  assert.deepEqual(fs.names(), ["e1.json", "index.json"]);
});

test("the eager entries are listed, the others are not", async () => {
  const fs = fakeFs();
  const store = await open(fs);
  await store.set("topics", "T", { eager: true });
  await store.set("history", "H");
  assert.deepEqual(await (await open(fs)).eager(), [["topics", "T"]]);
});

test("remove takes a key and what is under it; clear takes everything", async () => {
  const fs = fakeFs();
  const store = await open(fs);
  await store.set("chat:history:ep1:a", "1");
  await store.set("chat:history:ep1:b", "2");
  await store.set("chat:history:ep10:a", "3");
  await store.remove("chat:history:ep1");
  assert.equal(await store.get("chat:history:ep1:a"), null);
  assert.equal(await store.get("chat:history:ep10:a"), "3");
  assert.deepEqual(fs.names(), ["e3.json", "index.json"]);
  await store.clear();
  assert.deepEqual(fs.names(), ["index.json"]);
  assert.equal(await store.get("chat:history:ep10:a"), null);
});

test("over the total, the entries used longest ago go first", async () => {
  const fs = fakeFs();
  let time = 0;
  const store = await open(fs, { maxTotal: 10, now: () => ++time });
  await store.set("a", "aaaa");
  await store.set("b", "bbbb");
  // Reading a makes b the older one.
  await store.get("a");
  await store.set("c", "cccc");
  assert.equal(await store.get("b"), null);
  assert.equal(await store.get("a"), "aaaa");
  assert.equal(await store.get("c"), "cccc");
  assert.deepEqual(fs.names(), ["e1.json", "e3.json", "index.json"]);
});

test("an entry over the limit of one is not stored, and its older text goes", async () => {
  const fs = fakeFs();
  const store = await open(fs, { maxEntry: 5 });
  await store.set("a", "short");
  await store.set("a", "too long");
  assert.equal(await store.get("a"), null);
  assert.deepEqual(fs.names(), ["index.json"]);
});

test("an index of another version or scope, or one that does not parse, starts empty and its files go", async () => {
  for (const text of [
    JSON.stringify({ version: CACHE_VERSION + 1, scope, next: 2, entries: { a: { file: "e1.json", size: 3, used: 1 } } }),
    JSON.stringify({ version: CACHE_VERSION, scope: "https://other.test/|console", next: 2, entries: { a: { file: "e1.json", size: 3, used: 1 } } }),
    "{broken",
  ]) {
    const fs = fakeFs({ [`${DIR}/index.json`]: text, [`${DIR}/e1.json`]: "old" });
    const store = await open(fs);
    assert.equal(await store.get("a"), null);
    assert.deepEqual(fs.names(), ["index.json"]);
    assert.deepEqual(index(fs).entries, {});
  }
});

test("another account in the same run reads nothing of the first, and its first write removes it", async () => {
  const fs = fakeFs();
  const store = await open(fs);
  await store.set("topics", "alice's", { eager: true });
  scope = "https://morph.test/|bob";
  try {
    assert.equal(await store.get("topics"), null);
    assert.deepEqual(await store.eager(), []);
    await store.set("todo", "bob's");
    assert.equal(await store.get("topics"), null);
    assert.equal(await store.get("todo"), "bob's");
    assert.equal(index(fs).scope, scope);
    assert.deepEqual(Object.keys(index(fs).entries), ["todo"]);
  } finally {
    scope = "https://morph.test/|console";
  }
});

test("a file the index does not name is removed at the start; an entry whose file is gone reads as nothing", async () => {
  const fs = fakeFs();
  const store = await open(fs);
  await store.set("a", "one");
  fs.files.set(`${DIR}/e9.json`, "stray");
  fs.files.delete(`${DIR}/e1.json`);
  const again = await open(fs);
  assert.deepEqual(fs.names(), ["index.json"]);
  assert.equal(await again.get("a"), null);
  await settle();
  assert.deepEqual(index(fs).entries, {});
});

test("a directory that takes no write gives no store", async () => {
  const fs = fakeFs();
  fs.writeFile = async () => {
    throw Object.assign(new Error("read-only"), { code: "EROFS" });
  };
  await assert.rejects(open(fs), /read-only/);
});
