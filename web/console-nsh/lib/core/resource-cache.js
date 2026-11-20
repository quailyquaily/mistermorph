// The last answer of each cached request, kept so a page that was seen before opens with its data
// while the request runs again (docs/feat/feat_20261120_console_local_cache.md).
//
// Two layers behind one API: a map in memory (every platform) and a store on disk, when the host
// has one (the phone apps: lib/cacheFiles.ts). A read answers from memory, then from the store;
// a write goes to both, the store's a moment later and off the caller's path.
//
// Nothing here knows who is logged in: the owner clears the cache when the session or the server
// changes (`cacheClear`), and the store keeps its own scope.

/** An entry over this many characters stays in memory only. */
const MAX_PERSISTED_CHARS = 1024 * 1024;
/** How long writes to the store are gathered before they go. */
const PERSIST_DELAY_MS = 250;
/** How many entries of a group memory keeps (the least recently used go first). */
const GROUP_LIMITS = { history: 20 };

/** key -> { value, at, group }. A Map keeps insertion order: the first key is the oldest. */
const entries = new Map();
/** key -> { text, eager } | null (a removal), waiting for the store. */
const pending = new Map();
let store = null;
let persistTimer = null;
let flushing = Promise.resolve();
/** Raised by a clear, so a read of the store that was under way does not bring an entry back. */
let generation = 0;

function matches(key, keyOrPrefix) {
  return key === keyOrPrefix || key.startsWith(`${keyOrPrefix}:`);
}

function touch(key, entry) {
  entries.delete(key);
  entries.set(key, entry);
}

function trimGroup(group) {
  const limit = GROUP_LIMITS[group];
  if (!limit) return;
  let count = 0;
  for (const entry of entries.values()) if (entry.group === group) count += 1;
  if (count <= limit) return;
  for (const [key, entry] of entries) {
    if (entry.group !== group) continue;
    // Out of memory only: the store keeps it within its own limit.
    entries.delete(key);
    count -= 1;
    if (count <= limit) return;
  }
}

function schedulePersist() {
  if (!store || persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void cacheFlush();
  }, PERSIST_DELAY_MS);
}

/**
 * The store on disk: `{ get(key), set(key, text, { eager }), remove(keyOrPrefix), clear(), eager() }`,
 * all promises, or null for none.
 */
function setCacheStore(next) {
  store = next || null;
  pending.clear();
}

/** The entry in memory now, `{ value, at }`, or undefined. */
function cachePeek(key) {
  const entry = entries.get(key);
  if (!entry) return undefined;
  touch(key, entry);
  return entry;
}

/** The entry from memory, else from the store. */
async function cacheRead(key) {
  const held = cachePeek(key);
  if (held || !store) return held;
  const waiting = pending.get(key);
  if (waiting === null) return undefined;
  const started = generation;
  let text = waiting?.text;
  if (text === undefined) {
    try {
      text = await store.get(key);
    } catch (error) {
      console.warn("cache: read", key, error?.message || error);
      return undefined;
    }
  }
  if (started !== generation || pending.get(key) === null) return undefined;
  // A write that came while the store was read is newer.
  const newer = entries.get(key);
  if (newer) return newer;
  const entry = parseEntry(text);
  if (!entry) return undefined;
  entries.set(key, entry);
  trimGroup(entry.group);
  return entry;
}

function parseEntry(text) {
  if (typeof text !== "string" || !text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !("value" in parsed)) return undefined;
    return { value: parsed.value, at: Number(parsed.at) || 0, group: typeof parsed.group === "string" ? parsed.group : "" };
  } catch {
    return undefined;
  }
}

/**
 * Keeps `value` as the key's last answer. `group` names a set memory keeps only so many of
 * (`"history"`); `eager` entries are read from the store before the app's first frame, the
 * others when they are asked for; `persist: false` keeps the entry in memory only.
 */
function cacheWrite(key, value, options = {}) {
  const entry = { value, at: Date.now(), group: String(options.group || "") };
  touch(key, entry);
  trimGroup(entry.group);
  if (!store) return;
  let text = null;
  if (options.persist !== false) {
    try {
      text = JSON.stringify(entry);
    } catch (error) {
      console.warn("cache: an entry that is not JSON", key, error?.message || error);
    }
    if (text !== null && text.length > MAX_PERSISTED_CHARS) text = null;
  }
  // What cannot be stored replaces nothing: the store's older answer goes.
  pending.set(key, text === null ? null : { text, eager: options.eager === true });
  schedulePersist();
}

/** Forgets a key, or every key under a prefix (`a:b` covers `a:b:c`). */
function cacheDrop(keyOrPrefix) {
  for (const key of [...entries.keys()]) if (matches(key, keyOrPrefix)) entries.delete(key);
  for (const key of [...pending.keys()]) if (matches(key, keyOrPrefix)) pending.delete(key);
  if (!store) return;
  const target = store;
  flushing = flushing.then(() => target.remove(keyOrPrefix)).catch((error) => console.warn("cache: remove", keyOrPrefix, error?.message || error));
}

/** Forgets everything, in memory and in the store. */
function cacheClear() {
  generation += 1;
  entries.clear();
  pending.clear();
  if (!store) return;
  const target = store;
  flushing = flushing.then(() => target.clear()).catch((error) => console.warn("cache: clear", error?.message || error));
}

/** Reads the store's eager entries into memory: once, before the first frame. */
async function cacheHydrate() {
  if (!store) return;
  const started = generation;
  let items = [];
  try {
    items = await store.eager();
  } catch (error) {
    console.warn("cache: hydrate", error?.message || error);
    return;
  }
  if (started !== generation) return;
  for (const [key, text] of items) {
    if (entries.has(key)) continue;
    const entry = parseEntry(text);
    if (entry) entries.set(key, entry);
  }
}

/** Sends the waiting writes to the store now; resolves when the store has them. */
function cacheFlush() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!store || pending.size === 0) return flushing;
  const target = store;
  const batch = [...pending];
  pending.clear();
  flushing = flushing.then(async () => {
    for (const [key, write] of batch) {
      try {
        if (write === null) await target.remove(key);
        else await target.set(key, write.text, { eager: write.eager });
      } catch (error) {
        console.warn("cache: write", key, error?.message || error);
      }
    }
  });
  return flushing;
}

function clearCacheStateForTests() {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = null;
  entries.clear();
  pending.clear();
  store = null;
  flushing = Promise.resolve();
  generation += 1;
}

export { cacheClear, cacheDrop, cacheFlush, cacheHydrate, cachePeek, cacheRead, cacheWrite, clearCacheStateForTests, setCacheStore };
