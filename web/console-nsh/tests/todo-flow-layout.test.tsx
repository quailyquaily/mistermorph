// The Flow view's layout on its own (components/todo/flow-layout.ts): columns and rows as the
// approved prototype stacks them, links that skip a column going round the jobs in between, one
// trunk for a job's links, loops in the data left out, and forty jobs with sixty links laid out
// without anything on top of anything. The view itself: tests/todo-flow.test.tsx.
import { expect, test } from "nsh/test";
import {
  canUse,
  downstreamOf,
  FLOW_DESKTOP,
  FLOW_PHONE,
  flowGraph,
  layoutFlow,
  tracePath,
  upstreamOf,
  type FlowBox,
  type FlowLayout,
  type FlowLayoutJob,
  type FlowLinkMode,
} from "../components/todo/flow-layout";

const job = (id: string, ...uses: (string | [string, FlowLinkMode])[]): FlowLayoutJob => ({
  id,
  uses: uses.map((use) => (typeof use === "string" ? { job_id: use, mode: "each" as const } : { job_id: use[0], mode: use[1] })),
});

/** The prototype's jobs. */
const PROTOTYPE = [
  job("report"),
  job("digest", "report"),
  job("risk", "report"),
  job("brief", "digest", "risk"),
  job("peer", ["report", "latest"]),
  job("notes", ["report", "fresh"]),
  job("triage"),
  job("heartbeat"),
  job("backup"),
];

const nodeOf = (layout: FlowLayout, id: string) => {
  const node = layout.nodes.find((item) => item.id === id);
  if (!node) throw new Error(`no job ${id}`);
  return node;
};
const linkOf = (layout: FlowLayout, key: string) => {
  const link = layout.links.find((item) => item.key === key);
  if (!link) throw new Error(`no link ${key}`);
  return link;
};

type Segment = { x1: number; y1: number; x2: number; y2: number; link: string; from: string };
const segments = (layout: FlowLayout): Segment[] =>
  layout.links.flatMap((link) =>
    link.points.slice(1).map((p, i) => ({
      x1: Math.min(link.points[i][0], p[0]),
      y1: Math.min(link.points[i][1], p[1]),
      x2: Math.max(link.points[i][0], p[0]),
      y2: Math.max(link.points[i][1], p[1]),
      link: link.key,
      from: link.from,
    })),
  );
/** Whether a run goes through a box (more than touching its edge). */
const through = (s: Segment, box: FlowBox, slack = 0.5) =>
  s.x1 < box.x + box.w - slack && s.x2 > box.x + slack && s.y1 < box.y + box.h - slack && s.y2 > box.y + slack;
const overlap = (a: FlowBox, b: FlowBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** What must hold for any layout: runs along the axes, no job over another, no link through a job. */
function checkSound(layout: FlowLayout) {
  for (const s of segments(layout)) {
    // Each run lies along one axis.
    expect(s.x1 === s.x2 || s.y1 === s.y2).toBe(true);
    for (const node of layout.nodes) {
      if (through(s, node)) throw new Error(`${s.link} runs through ${node.id}`);
    }
  }
  layout.nodes.forEach((a, i) => {
    for (const b of layout.nodes.slice(i + 1)) {
      if (overlap(a, b)) throw new Error(`${a.id} lies over ${b.id}`);
    }
  });
  for (const link of layout.links) {
    const from = nodeOf(layout, link.from);
    const to = nodeOf(layout, link.to);
    const [sx, sy] = link.points[0];
    const [ex, ey] = link.points[link.points.length - 1];
    // Lines end on the job boxes.
    expect(sx >= from.x && sx <= from.x + from.w && sy >= from.y && sy <= from.y + from.h).toBe(true);
    expect(ex >= to.x && ex <= to.x + to.w && ey >= to.y && ey <= to.y + to.h).toBe(true);
    expect(link.length).toBeGreaterThan(0);
  }
}

/** Crossings between runs of different jobs' links (a job's own links share their trunk). */
function crossings(layout: FlowLayout) {
  const all = segments(layout);
  const seen = new Set<string>();
  for (const a of all) {
    if (a.y1 !== a.y2) continue;
    for (const b of all) {
      if (b.x1 !== b.x2 || a.from === b.from) continue;
      if (b.x1 > a.x1 && b.x1 < a.x2 && a.y1 > b.y1 && a.y1 < b.y2) seen.add(`${a.from}/${b.from}@${b.x1},${a.y1}`);
    }
  }
  return seen.size;
}

test("columns and rows as the prototype stacks them", () => {
  const layout = layoutFlow(PROTOTYPE);
  expect(layout.columns).toBe(3);
  const at = (id: string) => [nodeOf(layout, id).x, nodeOf(layout, id).y];
  // A job sits one column after the last job it uses: 360 from column to column.
  expect(at("brief")[0]).toBe(720);
  for (const id of ["digest", "risk", "peer", "notes"]) expect(at(id)[0]).toBe(360);
  // Rows: each column next to what it links to, 92 apart: the prototype's numbers, less the 46
  // it left empty above the topmost job.
  expect(at("digest")).toEqual([360, 0]);
  expect(at("risk")).toEqual([360, 92]);
  expect(at("brief")).toEqual([720, 0]);
  expect(at("peer")).toEqual([360, 184]);
  expect(at("notes")).toEqual([360, 276]);
  expect(at("triage")).toEqual([0, 46]);
  expect(at("report")).toEqual([0, 138]);
  expect(at("heartbeat")).toEqual([0, 230]);
  expect(at("backup")).toEqual([0, 322]);
  expect(nodeOf(layout, "brief").joined).toBe(true);
  expect(nodeOf(layout, "digest").joined).toBe(false);
  checkSound(layout);
});

test("a job's links leave on one trunk and arrive at ports of their own", () => {
  const layout = layoutFlow(PROTOTYPE);
  const out = layout.links.filter((link) => link.from === "report");
  expect(out).toHaveLength(4);
  // One way out and one lane for all four.
  for (const link of out) {
    expect(link.points[0]).toEqual(out[0].points[0]);
    expect(link.points[1][0]).toBe(out[0].points[1][0]);
  }
  expect(out[0].points[1][0]).toBe(228 + 34);
  // Two inputs of one job: two ports, 14 apart, the upper job's above. Team digest stands level
  // with Weekly brief, so the ports meet it: its link runs straight, the other arrives under it.
  const a = linkOf(layout, "digest>brief");
  const b = linkOf(layout, "risk>brief");
  const end = (points: [number, number][]) => points[points.length - 1];
  expect(a.points).toEqual([
    [588, 29],
    [720, 29],
  ]);
  expect(end(b.points)).toEqual([720, 29 + 14]);
  // Their pickers' targets lie on those last runs and do not overlap.
  expect(overlap(a.hit, b.hit)).toBe(false);
  expect(a.hit.x + a.hit.w).toBeLessThanOrEqual(720);
  expect(crossings(layout)).toBe(0);
});

test("a link that skips a column goes round the jobs in between", () => {
  // c uses a and b; a>c skips b's column, where b, d and e stand.
  const jobs = [job("a"), job("b", "a"), job("d", "a"), job("e", "a"), job("c", "b", ["a", "latest"]), job("f", "e", ["a", "fresh"])];
  const layout = layoutFlow(jobs);
  expect(nodeOf(layout, "c").col).toBe(2);
  checkSound(layout);
  const skip = linkOf(layout, "a>c");
  // It passes the middle column between two jobs, or outside them: somewhere no job is.
  const middle = segments(layout).filter((s) => s.link === "a>c" && s.y1 === s.y2 && s.x1 < 360 + 228 && s.x2 > 360);
  expect(middle.length).toBeGreaterThan(0);
  for (const node of layout.nodes.filter((item) => item.col === 1)) {
    for (const s of middle) expect(s.y1 < node.y - 8 || s.y1 > node.y + node.h + 8).toBe(true);
  }
  // The jobs it passes between keep a whole row's distance.
  const rows = layout.nodes.filter((item) => item.col === 1).map((item) => item.y).sort((p, q) => p - q);
  rows.slice(1).forEach((y, i) => expect(y - rows[i]).toBeGreaterThanOrEqual(92));
  // Both links that skip leave a on its one trunk, and stay one line as far as they go together.
  const other = linkOf(layout, "a>f");
  expect(other.points[0]).toEqual(skip.points[0]);
  expect(other.points[1][0]).toBe(skip.points[1][0]);
  // The route's length is its runs less what the turns cut.
  const straight = skip.points.slice(1).reduce((sum, p, i) => sum + Math.abs(p[0] - skip.points[i][0]) + Math.abs(p[1] - skip.points[i][1]), 0);
  expect(skip.length).toBeLessThanOrEqual(straight);
  expect(skip.length).toBeGreaterThan(straight - (skip.points.length - 2) * 8);
});

test("a long skip over several full columns still touches no job", () => {
  const jobs: FlowLayoutJob[] = [job("root")];
  for (let c = 1; c <= 4; c++) {
    for (let r = 0; r < 4; r++) jobs.push(job(`n${c}${r}`, c === 1 ? "root" : `n${c - 1}${r}`));
  }
  jobs.push(job("end", "n40", ["root", "fresh"], ["n11", "latest"], ["n22", "each"]));
  const layout = layoutFlow(jobs);
  expect(nodeOf(layout, "end").col).toBe(5);
  checkSound(layout);
  expect(nodeOf(layout, "end").joined).toBe(true);
});

test("lanes are ordered so that two trunks side by side do not cross", () => {
  // a over b, both feeding jobs below them: the upper job's trunk must take the farther lane.
  const jobs = [job("a"), job("b"), job("x"), job("y"), job("p", "x"), job("q", "y"), job("ta", "a"), job("tb", "b")];
  const layout = layoutFlow(jobs);
  checkSound(layout);
  expect(crossings(layout)).toBe(0);
  // Fans: three jobs each used by two, none crossing.
  const fan = layoutFlow([job("s1"), job("s2"), job("s3"), job("t1", "s1"), job("t2", "s1", "s2"), job("t3", "s2", "s3"), job("t4", "s3")]);
  checkSound(fan);
  expect(crossings(fan)).toBeLessThanOrEqual(1);
});

test("a gutter grows with its lanes", () => {
  // Eight jobs whose links all turn and lie side by side need more than the 132pt gutter's lanes.
  const jobs: FlowLayoutJob[] = [];
  for (let i = 0; i < 9; i++) jobs.push(job(`s${i}`));
  for (let i = 0; i < 9; i++) jobs.push(job(`t${i}`, `s${8 - i}`, `s${i}`));
  const layout = layoutFlow(jobs);
  checkSound(layout);
  expect(nodeOf(layout, "t0").x).toBeGreaterThan(360);
  // Every lane is a lane's width from the next and clear of both columns.
  const lanes = [...new Set(segments(layout).filter((s) => s.x1 === s.x2).map((s) => s.x1))].sort((a, b) => a - b);
  expect(lanes[0]).toBe(228 + 34);
  expect(lanes[lanes.length - 1]).toBeLessThanOrEqual(nodeOf(layout, "t0").x - 40);
  lanes.slice(1).forEach((x, i) => expect(x - lanes[i]).toBeGreaterThanOrEqual(12));
});

test("loops and links to jobs that are gone are left out, and the loop guard knows what may be linked", () => {
  const jobs = [job("a", "c", "gone", "a"), job("b", "a", "a"), job("c", "b"), job("d")];
  const graph = flowGraph(jobs);
  // In the jobs' order: a uses c, b uses a (once), and c using b would close the loop.
  expect(graph.uses.get("a")).toEqual([{ from: "c", mode: "each" }]);
  expect(graph.uses.get("b")).toEqual([{ from: "a", mode: "each" }]);
  expect(graph.uses.get("c")).toEqual([]);
  expect([...upstreamOf(graph, "b")].sort()).toEqual(["a", "c"]);
  expect([...downstreamOf(graph, "c")].sort()).toEqual(["a", "b"]);
  const layout = layoutFlow(jobs);
  expect(layout.links.map((link) => link.key).sort()).toEqual(["a>b", "c>a"]);
  checkSound(layout);
  // Who may use b: not itself, not what it depends on (a, c), so only d.
  expect(["a", "b", "c", "d"].filter((id) => canUse(graph, "b", id))).toEqual(["d"]);
  // Who may use c: b would not close a loop but a uses it already; b and d may.
  expect(["a", "b", "c", "d"].filter((id) => canUse(graph, "c", id))).toEqual(["b", "d"]);
  expect(canUse(graph, "nobody", "a")).toBe(false);
});

test("only a moved job or route changes the signature", () => {
  const before = layoutFlow(PROTOTYPE);
  const kind = layoutFlow(PROTOTYPE.map((item) => (item.id === "peer" ? job("peer", ["report", "each"]) : item)));
  expect(kind.signature).toBe(before.signature);
  expect(linkOf(kind, "report>peer").mode).toBe("each");
  const linked = layoutFlow(PROTOTYPE.map((item) => (item.id === "triage" ? job("triage", "brief") : item)));
  expect(linked.signature).not.toBe(before.signature);
  expect(nodeOf(linked, "triage").col).toBe(3);
});

test("on a phone the same rule runs top to bottom", () => {
  const layout = layoutFlow(PROTOTYPE, FLOW_PHONE);
  checkSound(layout);
  const report = nodeOf(layout, "report");
  const digest = nodeOf(layout, "digest");
  const brief = nodeOf(layout, "brief");
  expect(report.y).toBe(0);
  expect(digest.y).toBeGreaterThanOrEqual(report.h + FLOW_PHONE.gutter);
  expect(brief.y).toBeGreaterThan(digest.y + digest.h);
  expect(report.w).toBe(FLOW_PHONE.nodeCross);
  expect(report.h).toBe(58);
  // Links leave a job's bottom and arrive at a job's top.
  const link = linkOf(layout, "report>digest");
  expect(link.points[0][1]).toBe(report.y + report.h);
  expect(link.points[link.points.length - 1][1]).toBe(digest.y);
});

/** A repeatable pseudo-random graph: `count` jobs, `links` links, each to an earlier job. */
function randomJobs(count: number, links: number, seed: number): FlowLayoutJob[] {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const jobs: FlowLayoutJob[] = Array.from({ length: count }, (_, i) => ({ id: `j${i}`, uses: [] }));
  const modes: FlowLinkMode[] = ["each", "each", "latest", "fresh"];
  let made = 0;
  let guard = 0;
  while (made < links && guard++ < 10000) {
    const to = 1 + Math.floor(next() * (count - 1));
    // Mostly a near neighbour, sometimes a job far back (a link that skips columns).
    const back = next() < 0.75 ? 1 + Math.floor(next() * 6) : 1 + Math.floor(next() * to);
    const from = Math.max(0, to - back);
    if (jobs[to].uses.some((use) => use.job_id === `j${from}`)) continue;
    jobs[to].uses.push({ job_id: `j${from}`, mode: modes[Math.floor(next() * modes.length)] });
    made++;
  }
  return jobs;
}

test("forty jobs and sixty links lay out with nothing on top of anything, the same each time, quickly", () => {
  for (const seed of [1, 7, 42, 2026]) {
    const jobs = randomJobs(40, 60, seed);
    expect(jobs.reduce((sum, item) => sum + item.uses.length, 0)).toBe(60);
    for (const metrics of [FLOW_DESKTOP, FLOW_PHONE]) {
      const started = Date.now();
      const layout = layoutFlow(jobs, metrics);
      const took = Date.now() - started;
      expect(layout.nodes).toHaveLength(40);
      expect(layout.links).toHaveLength(60);
      checkSound(layout);
      expect(layoutFlow(jobs, metrics).signature).toBe(layout.signature);
      expect(took).toBeLessThan(200);
      // No two pickers' targets over each other, none over a job.
      layout.links.forEach((a, i) => {
        for (const b of layout.links.slice(i + 1)) {
          if (overlap(a.hit, b.hit)) throw new Error(`${a.key} and ${b.key}: targets overlap (seed ${seed})`);
        }
        for (const node of layout.nodes) {
          if (overlap(a.hit, node)) throw new Error(`${a.key}: target over ${node.id}`);
        }
      });
    }
  }
});

test("a route's turns are curves no wider than its runs allow", () => {
  const { d, length } = tracePath(
    [
      [0, 0],
      [40, 0],
      [40, 6],
      [100, 6],
    ],
    8,
  );
  // The 6pt step has room for two 3pt turns.
  expect(d).toBe("M0 0 L37 0 Q40 0 40 3 L40 3 Q40 6 43 6 L100 6");
  expect(length).toBeGreaterThan(37 + 57 + 4);
  expect(length).toBeLessThan(40 + 6 + 60);
  expect(tracePath([[0, 5], [30, 5]], 8).d).toBe("M0 5 L30 5");
});
