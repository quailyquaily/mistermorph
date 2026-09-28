import test from "node:test";
import assert from "node:assert/strict";

import { ghostMarkSVG, ghostScene } from "./ghost-mark.js";

test("with the ghost at the centre, the scene is the icon's 64 drawing", () => {
  const rows = ghostScene();
  assert.equal(rows.length, 11);
  // The first rows of design/brand/icons/aojashin/icon-64.svg.
  assert.deepEqual(rows[0].runs, [{ x: 6.49, width: 31.7 }, { x: 61.81, width: 31.7 }]);
  assert.deepEqual(rows[5].runs, [{ x: 1.6, width: 3.7 }, { x: 94.7, width: 3.7 }]);
  assert.ok(rows[0].curve.startsWith("M40.89 9 L"));
  assert.ok(rows[0].curve.endsWith(" L59.11 9"));
  assert.ok(rows.every((row) => row.curveWidth === 3));
});

test("every position of the ghost can be drawn with the same elements", () => {
  const size = (rows) => rows.map((row) => [row.runs.length, row.curve.split(" L").length]);
  const centre = size(ghostScene());
  for (const [cx, cy] of [[41, 50], [59, 56], [50, 44], [45, 53]]) {
    assert.deepEqual(size(ghostScene(cx, cy)), centre);
  }
});

test("a row the ghost leaves closes into one dim run", () => {
  const bottom = ghostScene(50, 44).at(-1);
  assert.equal(bottom.curveWidth, 0);
  assert.equal(bottom.runs[1].width, 0);
  assert.ok(bottom.runs[0].width > 80);
});

test("the markup is the icon with one curve per row", () => {
  const svg = ghostMarkSVG({ className: "x" });
  assert.ok(svg.startsWith('<svg class="x"'));
  assert.equal((svg.match(/data-curve/g) || []).length, 11);
  assert.equal((svg.match(/data-run/g) || []).length, 22);
});
