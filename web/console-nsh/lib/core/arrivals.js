// Tells which list items just arrived, so only those animate. A first load, a change of scope
// (another topic, agent or filter) or a wholesale replacement marks everything as already seen;
// items loaded from the far side of the list (older history) never count as arrivals.

// edge is where new items appear: "end" for a chat thread, "start" for newest-first lists,
// "any" for sorted lists where a new item can land anywhere.
export function createArrivalTracker({ edge = "end" } = {}) {
  let scope = null;
  let known = new Set();

  function update(ids, nextScope = "") {
    const list = (Array.isArray(ids) ? ids : []).map((id) => String(id ?? "")).filter(Boolean);
    const arrived = new Set();
    const firstSight = scope === null || nextScope !== scope || known.size === 0;
    const survivors = list.filter((id) => known.has(id));
    scope = nextScope;
    if (firstSight || survivors.length === 0) {
      known = new Set(list);
      return arrived;
    }
    // Items past the last (or before the first) surviving known item are arrivals.
    const anchor = edge === "start" ? list.indexOf(survivors[0]) : list.lastIndexOf(survivors[survivors.length - 1]);
    list.forEach((id, index) => {
      if (known.has(id)) {
        return;
      }
      if (edge === "any" || (edge === "start" ? index < anchor : index > anchor)) {
        arrived.add(id);
      }
    });
    known = new Set(list);
    return arrived;
  }

  function reset() {
    scope = null;
    known = new Set();
  }

  return { update, reset };
}

// Tells which known items changed (by a caller-chosen signature, e.g. status) since the last
// update. New items and first loads are not changes.
export function createChangeTracker() {
  let scope = null;
  let signatures = new Map();

  function update(entries, nextScope = "") {
    const changed = new Set();
    const next = new Map();
    const firstSight = scope === null || nextScope !== scope;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const id = String(entry?.id ?? "");
      if (!id) {
        continue;
      }
      const signature = String(entry?.signature ?? "");
      if (!firstSight && signatures.has(id) && signatures.get(id) !== signature) {
        changed.add(id);
      }
      next.set(id, signature);
    }
    scope = nextScope;
    signatures = next;
    return changed;
  }

  return { update };
}

// Keeps ids highlighted for a while after they arrive or change, so a refresh that lands
// mid-animation does not cut the highlight short.
export function createHighlightWindow(windowMs, now = () => Date.now()) {
  let until = new Map();

  function add(ids) {
    const t = now();
    const next = new Map([...until].filter(([, expiry]) => expiry > t));
    for (const id of ids) {
      next.set(String(id), t + windowMs);
    }
    until = next;
    return next;
  }

  function has(id) {
    const expiry = until.get(String(id));
    return expiry !== undefined && expiry > now();
  }

  return { add, has };
}

// Stable identities for rows that have no id of their own: the row's content, with an
// occurrence count so identical rows stay distinct.
export function contentKeys(values) {
  const seen = new Map();
  return (Array.isArray(values) ? values : []).map((value) => {
    const base = String(value ?? "");
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return `${base}#${count}`;
  });
}
