// The cache's store on disk for the phone apps: one file per entry in the app's own data
// directory, and an index of them (docs/feat/feat_20261120_console_local_cache.md). It answers
// lib/core/resource-cache.js's store: `get`, `set`, `remove`, `clear`, `eager`.
//
// Not nsh's `Storage`: the app reads every saved value into memory when it starts
// (lib/mobileHost.ts), so a server's answers there would slow every launch.
//
// The index names each entry's file, size and last use. It is written a moment after it changes;
// an entry's file is written before the index names it and removed after the index dropped it, so
// an app that stops in between leaves at worst a file nothing names, removed at the next start.

/** The part of `fs/promises` the store uses: the tests give their own. */
export interface CacheFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, text: string, options?: { eager?: boolean }): Promise<void>;
  /** Removes a key, or every key under a prefix (`a:b` covers `a:b:c`). */
  remove(keyOrPrefix: string): Promise<void>;
  clear(): Promise<void>;
  /** The entries to read before the app's first frame. */
  eager(): Promise<[string, string][]>;
}

export interface CacheFilesOptions {
  fs: CacheFs;
  /** The store's directory, the app's own. */
  dir: string;
  /** Whose answers these are (the server, the account): an index of another scope is emptied. */
  scope: () => string;
  /** All entries together, in characters (20 MB). */
  maxTotal?: number;
  /** One entry, in characters (1 MB); a longer one is not stored. */
  maxEntry?: number;
  /** How long index changes are gathered before the index is written (ms). */
  indexDelay?: number;
  now?: () => number;
}

interface IndexEntry {
  /** The entry's file in the directory. */
  file: string;
  size: number;
  /** When it was last written or read. */
  used: number;
  eager?: boolean;
}

interface Index {
  version: number;
  scope: string;
  next: number;
  entries: Record<string, IndexEntry>;
}

/** Raised when a stored shape changes: the entries of another version are removed at start. */
export const CACHE_VERSION = 1;
const INDEX_FILE = "index.json";
const INDEX_TEMP = "index.json.tmp";

const matches = (key: string, keyOrPrefix: string) => key === keyOrPrefix || key.startsWith(`${keyOrPrefix}:`);

/**
 * Opens the store in `dir`: reads its index (an unreadable one, or one of another version or
 * scope, is emptied) and removes the files the index does not name. Rejects when the directory
 * cannot be written: the caller then goes without a store.
 */
export async function openCacheFiles(options: CacheFilesOptions): Promise<CacheStore> {
  const { fs, dir } = options;
  const maxTotal = options.maxTotal ?? 20 * 1024 * 1024;
  const maxEntry = options.maxEntry ?? 1024 * 1024;
  const indexDelay = options.indexDelay ?? 2000;
  const now = options.now ?? Date.now;
  const path = (name: string) => `${dir}/${name}`;
  const empty = (): Index => ({ version: CACHE_VERSION, scope: options.scope(), next: 1, entries: {} });

  await fs.mkdir(dir, { recursive: true });
  let index = empty();
  try {
    const parsed = JSON.parse(await fs.readFile(path(INDEX_FILE), "utf8")) as Index;
    if (parsed?.version === CACHE_VERSION && parsed.scope === options.scope() && parsed.entries && typeof parsed.entries === "object") {
      index = { version: CACHE_VERSION, scope: parsed.scope, next: Number(parsed.next) || 1, entries: parsed.entries };
    }
  } catch {
    // No index yet, or one that does not parse: start empty.
  }
  // The directory must take a write, or there is no store.
  await writeIndexNow();
  await sweep();

  let indexTimer: ReturnType<typeof setTimeout> | null = null;
  // One operation at a time: the index and the files change together.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  }

  async function writeIndexNow() {
    await fs.writeFile(path(INDEX_TEMP), JSON.stringify(index));
    await fs.rename(path(INDEX_TEMP), path(INDEX_FILE));
  }
  function writeIndexSoon() {
    if (indexTimer !== null) return;
    indexTimer = setTimeout(() => {
      indexTimer = null;
      void serial(writeIndexNow).catch((error: Error) => console.warn("cache: index", error?.message || error));
    }, indexDelay);
  }
  async function unlinkQuietly(name: string) {
    try {
      await fs.unlink(path(name));
    } catch {
      // Already gone.
    }
  }
  /** Removes the files no entry names. */
  async function sweep() {
    const named = new Set(Object.values(index.entries).map((entry) => entry.file));
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === INDEX_FILE || named.has(name)) continue;
      await unlinkQuietly(name);
    }
  }
  /** Drops entries from the index (written at once), then their files. */
  async function drop(keys: string[]) {
    if (keys.length === 0) return;
    const files = keys.map((key) => index.entries[key]?.file).filter(Boolean) as string[];
    for (const key of keys) delete index.entries[key];
    await writeIndexNow();
    for (const file of files) await unlinkQuietly(file);
  }
  /** The least recently used entries that must go for the total to fit, never `keep`. */
  function overLimit(keep: string) {
    let total = 0;
    for (const entry of Object.values(index.entries)) total += entry.size;
    if (total <= maxTotal) return [];
    const oldestFirst = Object.entries(index.entries)
      .filter(([key]) => key !== keep)
      .sort((a, b) => a[1].used - b[1].used);
    const out: string[] = [];
    for (const [key, entry] of oldestFirst) {
      if (total <= maxTotal) break;
      out.push(key);
      total -= entry.size;
    }
    return out;
  }
  async function readEntry(key: string): Promise<string | null> {
    const entry = index.entries[key];
    if (!entry) return null;
    try {
      return await fs.readFile(path(entry.file), "utf8");
    } catch {
      // The index names a file that is gone: the entry goes too.
      delete index.entries[key];
      writeIndexSoon();
      return null;
    }
  }

  return {
    get: (key) =>
      serial(async () => {
        if (index.scope !== options.scope()) return null;
        const text = await readEntry(key);
        const entry = index.entries[key];
        if (text !== null && entry) {
          entry.used = now();
          writeIndexSoon();
        }
        return text;
      }),
    set: (key, text, setOptions = {}) =>
      serial(async () => {
        if (text.length > maxEntry) {
          await drop(index.entries[key] ? [key] : []);
          return;
        }
        if (index.scope !== options.scope()) {
          // Another account or server since the index was written: its entries are not this one's.
          const old = Object.keys(index.entries);
          index.scope = options.scope();
          await drop(old);
        }
        const known = index.entries[key];
        const file = known?.file ?? `e${index.next++}.json`;
        await fs.writeFile(path(file), text);
        index.entries[key] = { file, size: text.length, used: now(), ...(setOptions.eager ? { eager: true } : {}) };
        const out = overLimit(key);
        if (out.length > 0) await drop(out);
        else if (known) writeIndexSoon();
        // A new entry is named at once: a file the index does not name is removed at the next start.
        else await writeIndexNow();
      }),
    remove: (keyOrPrefix) => serial(() => drop(Object.keys(index.entries).filter((key) => matches(key, keyOrPrefix)))),
    clear: () =>
      serial(async () => {
        index = empty();
        await writeIndexNow();
        await sweep();
      }),
    eager: () =>
      serial(async () => {
        const out: [string, string][] = [];
        if (index.scope !== options.scope()) return out;
        for (const [key, entry] of Object.entries(index.entries)) {
          if (!entry.eager) continue;
          const text = await readEntry(key);
          if (text !== null) out.push([key, text]);
        }
        return out;
      }),
  };
}
