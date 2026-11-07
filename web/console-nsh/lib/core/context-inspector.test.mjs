import assert from "node:assert/strict";
import test from "node:test";

import { contextInspectorLayout } from "./context-inspector.js";

test("parts are laid out along the context window, with the compaction point", () => {
  const layout = contextInspectorLayout({
    available: true,
    context_window_tokens: 1000,
    input_tokens: 400,
    compaction_trigger_tokens: 720,
    parts: [
      { kind: "system", tokens: 100 },
      { kind: "tools", tokens: 0 },
      { kind: "steps", tokens: 300 },
    ],
  });
  assert.deepEqual(
    layout.segments.map((segment) => [segment.kind, segment.start, segment.share]),
    [["system", 0, 0.1], ["steps", 0.1, 0.3]],
  );
  assert.equal(layout.ratio, 0.4);
  assert.equal(layout.free, 600);
  assert.equal(layout.triggerShare, 0.72);
  assert.equal(layout.segments[1].usedShare, 0.75);
});

test("without a window the bar is the request itself", () => {
  const layout = contextInspectorLayout({ available: true, input_tokens: 50, parts: [{ kind: "history", tokens: 50 }] });
  assert.equal(layout.ratio, null);
  assert.equal(layout.segments[0].share, 1);
  assert.equal(layout.triggerShare, null);
  assert.equal(contextInspectorLayout({ available: false }), null);
});

test("cells are shared out by tokens, at least one per part", async () => {
  const { allocateCells } = await import("./context-inspector.js");
  assert.deepEqual(allocateCells([50, 30, 20]), [200, 120, 80]);
  // A tiny part still gets a cell, taken from the largest.
  assert.deepEqual(allocateCells([10000, 1, 0, 1], 100), [98, 1, 0, 1]);
  assert.deepEqual(allocateCells([1, 1, 1], 100).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(allocateCells([0, 0]), [0, 0]);
});

test("the grid holds only the used space, in request order", async () => {
  const { contextCellGrid } = await import("./context-inspector.js");
  const grid = contextCellGrid({
    available: true,
    context_window_tokens: 100000,
    input_tokens: 400,
    parts: [
      { kind: "system", tokens: 100, children: [{ kind: "section", label: "Persona", tokens: 60 }, { kind: "section", tokens: 40 }] },
      { kind: "tools", tokens: 0 },
      { kind: "steps", tokens: 300 },
    ],
  });
  assert.equal(grid.cells.length, 400);
  assert.deepEqual(grid.groups.map((group) => [group.kind, group.cells]), [["system", 100], ["steps", 300]]);
  assert.equal(grid.cells[0].kind, "system");
  assert.equal(grid.cells[399].kind, "steps");
  assert.equal(grid.cellTokens, 1);
  assert.deepEqual(grid.groups[0].items.map((item) => item.share), [0.6, 0.4]);
  assert.equal(grid.groups[1].items.length, 1);
});

test("cache tags mark the cell where their item ends", async () => {
  const { contextCellGrid } = await import("./context-inspector.js");
  const grid = contextCellGrid(
    {
      available: true,
      input_tokens: 100,
      parts: [
        { kind: "system", tokens: 40, children: [{ kind: "section", tokens: 30 }, { kind: "section", tokens: 10, cache_breakpoint: true, cache_ttl: "1h" }] },
        { kind: "history", tokens: 60, children: [{ kind: "message", tokens: 15, cache_breakpoint: true }, { kind: "message", tokens: 45 }] },
      ],
    },
    100,
  );
  assert.deepEqual(grid.caches.map((mark) => [mark.item, mark.cell, mark.ttl]), [["system:1", 39, "1h"], ["history:0", 54, ""]]);
  assert.deepEqual(grid.cells[39].cache, { ttl: "1h" });
  assert.equal(grid.cells[40].cache, null);
  assert.deepEqual(grid.groups[1].items[0].cache, { ttl: "" });
});

test("the ring draws parts as arcs of the window, each visible", async () => {
  const { contextRing } = await import("./context-inspector.js");
  const ring = contextRing({ window: 1000, trigger: 750, groups: [{ kind: "system", tokens: 100 }, { kind: "steps", tokens: 1 }] }, 100);
  assert.deepEqual(ring.arcs, [{ kind: "system", length: 10, offset: 0 }, { kind: "steps", length: 1.5, offset: 10 }]);
  assert.equal(ring.triggerAngle, 270);
  assert.equal(contextRing({ window: 0, groups: [] }, 100), null);
});
