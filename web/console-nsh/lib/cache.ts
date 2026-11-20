// Starts the cache of the pages' last answers (lib/core/resource-cache.js): gives it its store on
// disk in the phone apps, reads what the first frame shows, and empties it when another account
// logs in (docs/feat/feat_20261120_console_local_cache.md). A logout, a rejected session and
// another server empty it where they happen.
import { effect, untracked } from "nsh";
import * as nativeFs from "fs/promises";
import { type CacheFs, openCacheFiles } from "./cacheFiles";
import { authState } from "./core/context.js";
import { cacheClear, cacheHydrate, setCacheStore } from "./core/resource-cache.js";
import { basePath, isMobile, origin } from "./platform";

/** The store's directory: in the app's own data directory, which `nsh.json` grants (`capabilities.fs`). */
const CACHE_DIR = "${dataDir}/cache";

/** Whose answers the cache holds: the console server and the account. */
const cacheScope = () => `${origin()}${basePath()}|${authState.account}`;

let testFs: CacheFs | null = null;
/** Gives the store a file system of the tests' own; they have none of the device's. */
export function useCacheFsForTests(fs: CacheFs | null) {
  testFs = fs;
}

/** Call once, after the session was restored and before the first page mounts. */
export async function startCache() {
  // Another account in the same run: the answers in memory are not its own.
  let lastScope = "";
  effect(() => {
    if (!authState.token) return;
    const scope = cacheScope();
    untracked(() => {
      if (lastScope && lastScope !== scope) cacheClear();
      lastScope = scope;
    });
  });
  // Web and desktop keep the answers in memory only.
  if (!isMobile() && !testFs) return;
  try {
    const store = await openCacheFiles({ fs: testFs ?? (nativeFs as unknown as CacheFs), dir: CACHE_DIR, scope: cacheScope });
    setCacheStore(store);
    await cacheHydrate();
  } catch (error) {
    // A device without the app's own files: the answers stay in memory, as on the web.
    console.warn("cache: no store on disk:", (error as Error)?.message || error);
  }
}
