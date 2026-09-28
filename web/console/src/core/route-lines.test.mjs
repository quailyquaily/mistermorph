import test from "node:test";
import assert from "node:assert/strict";

import { layoutRouteLines, roundedPath } from "./route-lines.js";

// Five routes on the left and three profiles on the right, rows 70 px apart, like the settings page.
const routes = Object.fromEntries(
  ["main", "decision", "awareness", "think", "plan"].map((key, index) => [key, { x: 280, y: 40 + index * 70 }]),
);
const profiles = Object.fromEntries(
  ["default", "backup", "nest"].map((name, index) => [name, { x: 540, y: 70 + index * 70, top: 41 + index * 70, bottom: 99 + index * 70 }]),
);
const edges = [
  { id: "main", purpose: "main", profile: "default" },
  { id: "decision", purpose: "decision", profile: "default" },
  { id: "awareness:0", purpose: "awareness", profile: "default" },
  { id: "awareness:1", purpose: "awareness", profile: "nest" },
  { id: "think", purpose: "think", profile: "backup" },
  { id: "plan", purpose: "plan", profile: "default" },
];

function runs(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (x1 !== x2 || y1 !== y2) {
      out.push(y1 === y2 ? { h: true, c: y1, lo: Math.min(x1, x2), hi: Math.max(x1, x2) } : { h: false, c: x1, lo: Math.min(y1, y2), hi: Math.max(y1, y2) });
    }
  }
  return out;
}

test("every line runs from its route to its profile at right angles", () => {
  const layout = layoutRouteLines(edges, routes, profiles);
  assert.deepEqual(Object.keys(layout).sort(), edges.map((edge) => edge.id).sort());
  for (const edge of edges) {
    const { points, entry } = layout[edge.id];
    assert.equal(points[0][0], routes[edge.purpose].x);
    assert.equal(entry.x, profiles[edge.profile].x);
    assert.ok(entry.y > profiles[edge.profile].top && entry.y < profiles[edge.profile].bottom);
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i][0] === points[i - 1][0] || points[i][1] === points[i - 1][1], `${edge.id} has a diagonal`);
    }
  }
});

test("lines that share no end never share a run", () => {
  const layout = layoutRouteLines(edges, routes, profiles);
  const ids = Object.keys(layout);
  // Lone lines into default share its track; awareness's lines share awareness's.
  const route = { main: "d", decision: "d", plan: "d", think: "think", "awareness:0": "awareness", "awareness:1": "awareness" };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (route[ids[i]] === route[ids[j]]) {
        continue;
      }
      for (const s of runs(layout[ids[i]].points)) {
        for (const t of runs(layout[ids[j]].points)) {
          const shared = s.h === t.h && Math.abs(s.c - t.c) < 2 && Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo) > 0.5;
          assert.ok(!shared, `${ids[i]} and ${ids[j]} share a run`);
        }
      }
    }
  }
});

test("every line turns up or down at most once", () => {
  const layout = layoutRouteLines(edges, routes, profiles);
  for (const { points } of Object.values(layout)) {
    assert.ok(runs(points).filter((run) => !run.h).length <= 1);
  }
});

test("a route's lines leave together on one track", () => {
  const layout = layoutRouteLines(edges, routes, profiles);
  const [a, b] = [layout["awareness:0"].points, layout["awareness:1"].points];
  assert.deepEqual(a[0], b[0]);
  assert.equal(a[1][0], b[1][0]);
});

test("lines from routes with one line join at their profile", () => {
  const layout = layoutRouteLines(edges, routes, profiles);
  const { main, decision, plan } = layout;
  assert.equal(main.entry.y, plan.entry.y);
  assert.equal(decision.entry.y, plan.entry.y);
  assert.equal(decision.points[1][0], plan.points[1][0]);
  assert.notEqual(layout["awareness:0"].entry.y, plan.entry.y);
});

test("lines with a missing end are left out", () => {
  const layout = layoutRouteLines([{ id: "x", purpose: "main", profile: "gone" }], routes, profiles);
  assert.deepEqual(layout, {});
});

test("corners are rounded", () => {
  assert.equal(roundedPath([[0, 0], [20, 0], [20, 30]]), "M 0 0 L 12 0 Q 20 0 20 8 L 20 30");
});
