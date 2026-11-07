// The context window inspector: the topic's last main request, split into parts by the runtime
// (GET /topic/{id}/context), laid out on one bar the size of the context window.

export const CONTEXT_PART_KINDS = ["system", "skills", "tools", "history", "current", "steps"];

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The bar's scale is the context window when it is known, else the request itself.
export function contextInspectorLayout(snapshot) {
  if (!snapshot?.available) return null;
  const parts = (Array.isArray(snapshot.parts) ? snapshot.parts : []).filter((part) => positive(part?.tokens) > 0);
  const used = positive(snapshot.input_tokens) || parts.reduce((sum, part) => sum + positive(part.tokens), 0);
  const window = positive(snapshot.context_window_tokens);
  const scale = Math.max(window, used) || 1;
  const trigger = window ? Math.min(positive(snapshot.compaction_trigger_tokens), window) : 0;
  let offset = 0;
  const segments = parts.map((part) => {
    const share = positive(part.tokens) / scale;
    const segment = { kind: part.kind, tokens: positive(part.tokens), start: offset, share, usedShare: used ? positive(part.tokens) / used : 0 };
    offset += share;
    return segment;
  });
  return {
    used,
    window,
    free: window ? Math.max(0, window - used) : 0,
    ratio: window ? used / window : null,
    triggerShare: trigger ? trigger / scale : null,
    trigger,
    cached: Math.min(positive(snapshot.cached_input_tokens), used),
    segments,
  };
}

// The used part of the window as a grid of cells (20×20 by default): each part gets cells in
// proportion to its tokens, and at least one, so a small part still shows. Cells run in the
// request's order, so each part is one run. The free space is left out.
export const CONTEXT_GRID_CELLS = 400;

export function allocateCells(values, total = CONTEXT_GRID_CELLS) {
  const sizes = values.map(positive);
  const sum = sizes.reduce((a, b) => a + b, 0);
  const count = sizes.filter((v) => v > 0).length;
  if (!sum || total < count) return sizes.map(() => 0);
  const exact = sizes.map((v) => (v / sum) * total);
  const cells = exact.map((e, i) => (sizes[i] > 0 ? Math.max(1, Math.floor(e)) : 0));
  let left = total - cells.reduce((a, b) => a + b, 0);
  // Hand out what is left by largest remainder; take back from the most over-served parts.
  while (left > 0) {
    let best = -1;
    for (let i = 0; i < cells.length; i++) {
      if (sizes[i] > 0 && (best < 0 || exact[i] - cells[i] > exact[best] - cells[best])) best = i;
    }
    cells[best] += 1;
    left -= 1;
  }
  while (left < 0) {
    let best = -1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] > 1 && (best < 0 || exact[i] - cells[i] < exact[best] - cells[best])) best = i;
    }
    cells[best] -= 1;
    left += 1;
  }
  return cells;
}

export function contextCellGrid(snapshot, total = CONTEXT_GRID_CELLS) {
  const layout = contextInspectorLayout(snapshot);
  if (!layout) return null;
  const parts = (Array.isArray(snapshot.parts) ? snapshot.parts : []).filter((part) => positive(part?.tokens) > 0);
  const partTotal = parts.reduce((sum, part) => sum + positive(part.tokens), 0);
  if (!partTotal) return { ...layout, groups: [], cells: [], caches: [] };
  const counts = allocateCells(parts.map((part) => part.tokens), total);
  const cells = [];
  const caches = [];
  const groups = parts.map((part, index) => {
    const children = (Array.isArray(part.children) ? part.children : []).filter((child) => positive(child?.tokens) > 0);
    const start = cells.length;
    for (let i = 0; i < counts[index]; i++) cells.push({ key: `${part.kind}:${i}`, kind: part.kind, cache: null });
    let through = 0;
    const items = (children.length ? children : [part]).map((item, itemIndex) => {
      through += positive(item.tokens);
      const entry = {
        key: `${part.kind}:${itemIndex}`,
        part: item,
        tokens: positive(item.tokens),
        share: positive(item.tokens) / positive(part.tokens),
        cache: item.cache_breakpoint ? { ttl: String(item.cache_ttl || "").trim() } : null,
      };
      // A cache tag sits on the cell where its item ends: the cached prefix runs up to there.
      if (entry.cache && counts[index] > 0) {
        const offset = Math.min(counts[index], Math.max(1, Math.ceil((through / positive(part.tokens)) * counts[index] - 1e-9))) - 1;
        const cell = cells[start + offset];
        cell.cache = entry.cache;
        caches.push({ kind: part.kind, item: entry.key, cell: start + offset, ttl: entry.cache.ttl });
      }
      return entry;
    });
    return { key: part.kind, kind: part.kind, tokens: positive(part.tokens), share: positive(part.tokens) / partTotal, cells: counts[index], items };
  });
  return { ...layout, groups, cells, caches, cellTokens: partTotal / total };
}

// The header's ring: the context window as a circle, the parts as arcs from the top in request
// order, and the compaction point as an angle. A part too small to see still gets a sliver.
export function contextRing(grid, circumference, minArc = 1.5) {
  if (!grid || !grid.window) return null;
  const arcs = [];
  let offset = 0;
  for (const group of grid.groups || []) {
    const length = Math.min(circumference - offset, Math.max(minArc, (group.tokens / grid.window) * circumference));
    if (length <= 0) break;
    arcs.push({ kind: group.kind, length, offset });
    offset += length;
  }
  return { arcs, triggerAngle: grid.trigger ? (grid.trigger / grid.window) * 360 : null };
}
