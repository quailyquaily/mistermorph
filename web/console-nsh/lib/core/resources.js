import { cleanup, effect, signal, untracked } from "nsh";

const resourceCache = new Map();
const resourceInflight = new Map();
const resourceVersions = new Map();

function resourceKey(...parts) {
  return parts.map((part) => encodeURIComponent(String(part ?? ""))).join(":");
}

function normalizeResourceKey(value) {
  return String(value || "").trim();
}

function resolveValue(value) {
  if (typeof value === "function") {
    return value();
  }
  if (value && typeof value === "object" && "value" in value) {
    return value.value;
  }
  return value;
}

function resolveBool(value) {
  return Boolean(resolveValue(value));
}

function resourceVersion(key) {
  return resourceVersions.get(key) || 0;
}

function bumpResourceVersion(key) {
  resourceVersions.set(key, resourceVersion(key) + 1);
}

async function loadResource(key, loader, options = {}) {
  const normalizedKey = normalizeResourceKey(key);
  if (!normalizedKey) {
    throw new Error("missing resource key");
  }
  if (typeof loader !== "function") {
    throw new Error("missing resource loader");
  }

  const force = options.force === true;
  const cache = options.cache === true;
  if (force) {
    bumpResourceVersion(normalizedKey);
    resourceCache.delete(normalizedKey);
    resourceInflight.delete(normalizedKey);
  }
  if (!force && cache && resourceCache.has(normalizedKey)) {
    return resourceCache.get(normalizedKey);
  }

  const inflight = resourceInflight.get(normalizedKey);
  if (inflight) {
    return inflight;
  }

  const version = resourceVersion(normalizedKey);
  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (cache && version === resourceVersion(normalizedKey)) {
        resourceCache.set(normalizedKey, value);
      }
      return value;
    })
    .finally(() => {
      if (resourceInflight.get(normalizedKey) === promise) {
        resourceInflight.delete(normalizedKey);
      }
    });

  resourceInflight.set(normalizedKey, promise);
  return promise;
}

function invalidateResource(keyOrPrefix = "") {
  const value = normalizeResourceKey(keyOrPrefix);
  if (!value) {
    for (const key of new Set([...resourceCache.keys(), ...resourceInflight.keys()])) {
      bumpResourceVersion(key);
    }
    resourceCache.clear();
    resourceInflight.clear();
    return;
  }
  for (const key of new Set([...resourceCache.keys(), ...resourceInflight.keys()])) {
    if (key === value || key.startsWith(`${value}:`)) {
      bumpResourceVersion(key);
      resourceCache.delete(key);
      resourceInflight.delete(key);
    }
  }
}

function clearResourceStateForTests() {
  resourceCache.clear();
  resourceInflight.clear();
  resourceVersions.clear();
}

// A keyed load owned by the component that calls it: `data`, `error` and `loading` are signals,
// and the load runs again when `options.key` or `options.enabled` (accessors) change.
function useResource(options) {
  const data = signal(options?.initialData ?? null);
  const error = signal(null);
  const loading = signal(false);
  const key = signal("");
  const enabled = options?.enabled ?? true;
  const immediate = options?.immediate !== false;
  const cache = options?.cache === true;
  let version = 0;
  let disposed = false;

  async function refresh(refreshOptions = {}) {
    const nextKey = normalizeResourceKey(untracked(() => resolveValue(options?.key)));
    key.set(nextKey);
    const isEnabled = untracked(() => resolveBool(enabled));
    if (!isEnabled || !nextKey) {
      version += 1;
      loading.set(false);
      error.set(null);
      if (options?.clearOnDisabled !== false) {
        data.set(options?.initialData ?? null);
      }
      return null;
    }

    const currentVersion = version + 1;
    version = currentVersion;
    loading.set(true);
    error.set(null);
    try {
      const value = await loadResource(
        nextKey,
        () =>
          options.load({
            key: nextKey,
            force: refreshOptions.force === true,
          }),
        {
          force: refreshOptions.force === true,
          cache,
        }
      );
      if (!disposed && currentVersion === version) {
        data.set(value);
      }
      return value;
    } catch (e) {
      if (!disposed && currentVersion === version) {
        error.set(e);
      }
      return null;
    } finally {
      if (!disposed && currentVersion === version) {
        loading.set(false);
      }
    }
  }

  let first = true;
  effect(() => {
    // Track the key and the switch; the load itself runs untracked.
    resolveBool(enabled);
    normalizeResourceKey(resolveValue(options?.key));
    if (first && !immediate) {
      first = false;
      return;
    }
    first = false;
    untracked(() => void refresh());
  });

  cleanup(() => {
    disposed = true;
    version += 1;
  });

  return {
    data,
    error,
    loading,
    key,
    refresh,
  };
}

export {
  clearResourceStateForTests,
  invalidateResource,
  loadResource,
  resourceKey,
  useResource,
};
