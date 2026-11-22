// The Flow view's layout (TodoFlow): where each job stands and how each link runs. Pure: no
// framework, nothing measured, nothing saved; the same jobs always give the same picture.
//
// The rule (the approved prototype's, design Flow.dc.html):
// - a job sits one column after the last job it uses;
// - each column is stacked next to the jobs it links to: first by the mean of the jobs it uses,
//   then, from the last column back, by the mean of the jobs that use it; jobs keep a row apart.
//
// What the prototype did not do, and this does:
// - a link that skips a column gets a place of its own in every column it passes (a "pass": a
//   stand-in that is stacked with the column's jobs, so room is kept for it), and runs through
//   those places: it goes round the jobs in between, never behind them;
// - every link of one job leaves on one line (its trunk): out of the job, along a lane of the
//   gutter after its column, and on. Lanes are ordered so that trunks cross as little as moving
//   one of them can save, and trunks that are never side by side share a lane;
// - a gutter grows by a lane's width for each lane past those that fit;
// - a job's inputs arrive at ports of their own on its side, in the order they come from, so two
//   links into one job stay two lines (their styles say different things) and each can be picked;
//   the ports move along the side to meet a link that comes in nearly level, which then runs
//   straight.
//
// On a phone the same rule runs top to bottom (`FLOW_PHONE`): columns become rows, and the links
// leave and arrive under the jobs' markers, a rail down the left of each job.

/** What the layout reads of a job. */
export interface FlowLayoutJob {
  id: string;
  uses: { job_id: string }[];
}

export interface FlowMetrics {
  /** Columns run down the page (a phone) instead of across it. */
  vertical: boolean;
  /** A job's size along the columns' direction, and across it. */
  nodeMain: number;
  nodeCross: number;
  /** How far across a job the line its links leave on lies (and the middle of its ports). */
  anchor: number;
  /** The room between two jobs of a column. */
  rowGap: number;
  /** The room between a passing link and a job (two passing links are a lane apart). Half the
   *  room between two jobs at least, so a link between two jobs never brings them closer. */
  passGap: number;
  /** More room after a job that shows its join rule under it, before a passing link. */
  joinRoom: number;
  /** From a column's end to the gutter's first lane; from its last lane to the next column. */
  lead: number;
  tail: number;
  /** Between two lanes. */
  lane: number;
  /** A gutter's least width. */
  gutter: number;
  /** A turn's radius. */
  turn: number;
  /** Between two ports of a job, and the least distance of a port from the job's corners. */
  port: number;
  portInset: number;
  /** A link that arrives within this of its port runs straight: the ports move to meet it. */
  level: number;
  /** Room around a link in its own box (its stroke and the pulse's round ends). */
  pad: number;
  /** A link's picker target: its length along the link and its greatest thickness. */
  hitLength: number;
  hitThick: number;
}

/** The prototype's numbers: 228 × 58 jobs, 360 from column to column, 92 from row to row, 8pt turns. */
export const FLOW_DESKTOP: FlowMetrics = {
  vertical: false,
  nodeMain: 228,
  nodeCross: 58,
  anchor: 29,
  rowGap: 34,
  passGap: 17,
  joinRoom: 26,
  lead: 34,
  tail: 40,
  lane: 12,
  gutter: 132,
  turn: 8,
  port: 14,
  portInset: 8,
  level: 20,
  pad: 6,
  hitLength: 26,
  hitThick: 20,
};

/** A phone: narrower jobs in rows, the links on a rail under the markers. */
export const FLOW_PHONE: FlowMetrics = {
  vertical: true,
  nodeMain: 58,
  nodeCross: 172,
  anchor: 17,
  rowGap: 14,
  passGap: 12,
  joinRoom: 0,
  lead: 30,
  tail: 26,
  lane: 10,
  gutter: 56,
  turn: 8,
  port: 10,
  portInset: 7,
  level: 20,
  pad: 6,
  hitLength: 22,
  hitThick: 20,
};

export interface FlowBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowNode extends FlowBox {
  id: string;
  /** Its column (row on a phone): one after the last job it uses. */
  col: number;
  /** It uses more than one job: its join rule shows. */
  joined: boolean;
}

export interface FlowLink {
  /** `<used job>><job>`. */
  key: string;
  /** The job whose result is used, and the job that uses it. */
  from: string;
  to: string;
  /** The corners of its route on the canvas, from the used job's edge to the job's edge. */
  points: [number, number][];
  /** Its box on the canvas (the route and `pad` around it), and the route as SVG path data in it. */
  box: FlowBox;
  d: string;
  /** The route's length, turns rounded. */
  length: number;
  /** Where its picker's target lies: on its last run, before the job. */
  hit: FlowBox;
}

export interface FlowLayout {
  nodes: FlowNode[];
  links: FlowLink[];
  /** The extent of the jobs and links. */
  width: number;
  height: number;
  columns: number;
  /** Changes when a job moved or a link's route did (not when only a kind or a name changed). */
  signature: string;
}

/* ---------- the graph ---------- */

export interface FlowGraph {
  ids: string[];
  /** A job's inputs that count: of jobs that exist, one per job, never itself, never a loop. */
  uses: Map<string, { from: string }[]>;
  /** The jobs that use a job. */
  users: Map<string, string[]>;
}

/**
 * The jobs' links as a graph without loops. Data may be wrong (a job gone, a loop saved by an older
 * build): such an input is left out here, so the picture is always drawable. In the jobs' order, an
 * input that would close a loop over the inputs kept so far is the one left out.
 */
export function flowGraph(jobs: readonly FlowLayoutJob[]): FlowGraph {
  const ids = jobs.map((job) => job.id);
  const known = new Set(ids);
  const uses = new Map<string, { from: string }[]>();
  const users = new Map<string, string[]>();
  for (const id of ids) {
    uses.set(id, []);
    users.set(id, []);
  }
  const dependsOn = (id: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const at = stack.pop() as string;
      if (at === target) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const use of uses.get(at) ?? []) stack.push(use.from);
    }
    return false;
  };
  for (const job of jobs) {
    const mine = uses.get(job.id);
    // A second job of the same id: the first one's inputs stand.
    if (!mine || mine.length) continue;
    for (const use of job.uses ?? []) {
      if (!known.has(use.job_id) || use.job_id === job.id) continue;
      if (mine.some((kept) => kept.from === use.job_id)) continue;
      if (dependsOn(use.job_id, job.id)) continue;
      mine.push({ from: use.job_id });
      users.get(use.job_id)?.push(job.id);
    }
  }
  return { ids, uses, users };
}

function walk(start: string, next: (id: string) => string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...next(start)];
  while (stack.length) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...next(id));
  }
  return out;
}

/** Every job `id` depends on, directly or not. */
export function upstreamOf(graph: FlowGraph, id: string): Set<string> {
  return walk(id, (at) => (graph.uses.get(at) ?? []).map((use) => use.from));
}

/** Every job that depends on `id`, directly or not. */
export function downstreamOf(graph: FlowGraph, id: string): Set<string> {
  return walk(id, (at) => graph.users.get(at) ?? []);
}

/**
 * Whether `candidate` may start using `from`: not itself, not a job that uses it already, and not a
 * job `from` depends on (directly or not), which would close a loop.
 */
export function canUse(graph: FlowGraph, from: string, candidate: string): boolean {
  if (from === candidate || !graph.uses.has(from) || !graph.uses.has(candidate)) return false;
  if ((graph.uses.get(candidate) ?? []).some((use) => use.from === from)) return false;
  return !upstreamOf(graph, from).has(candidate);
}

/** Each job's column: one after the last job it uses. */
export function flowDepths(graph: FlowGraph): Map<string, number> {
  const depth = new Map<string, number>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // The graph has no loops (flowGraph), so this ends.
    let d = 0;
    for (const use of graph.uses.get(id) ?? []) d = Math.max(d, visit(use.from) + 1);
    depth.set(id, d);
    return d;
  };
  for (const id of graph.ids) visit(id);
  return depth;
}

/* ---------- the layout ---------- */

/** A job, or a link's place in a column it passes. */
interface Item {
  key: string;
  node: boolean;
  /** The job; for a pass, the job whose links pass here. */
  id: string;
  col: number;
  index: number;
  ups: Item[];
  downs: Item[];
  /** Room it takes before and after its line, across the column. */
  before: number;
  after: number;
  joined: boolean;
  /** Its line across the column: where its links leave. */
  pos: number;
}

/** The part of one job's links that runs along a gutter. */
interface Trunk {
  item: Item;
  entry: number;
  exits: number[];
  lo: number;
  hi: number;
  lane: number;
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

// A turn is a quadratic curve round its corner: this is its length for a radius of 1.
const TURN_LENGTH = (() => {
  let length = 0;
  const steps = 64;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    length += (2 * Math.hypot(1 - t, t)) / steps;
  }
  return length;
})();

const round = (value: number) => Math.round(value * 100) / 100;

/** What crossing costs when trunk `a` takes a lane before trunk `b`'s. */
function laneCost(a: Trunk, b: Trunk): number {
  let cost = 0;
  // b's way in passes a's lane.
  if (a.lo < b.entry && b.entry < a.hi) cost += 1;
  for (const exit of a.exits) {
    // a's way out passes b's lane.
    if (b.lo < exit && exit < b.hi) cost += 1;
    // a's way out and b's way in on one line, over each other: they would read as one link.
    if (Math.abs(exit - b.entry) < 4) cost += 100;
  }
  return cost;
}

/** How far apart a job's `count` ports are: whole points, as many as fit on its side. */
function portStep(m: FlowMetrics, count: number): number {
  if (count < 2) return 0;
  return Math.max(1, Math.floor(Math.min(m.port, (m.nodeCross - 2 * m.portInset) / (count - 1))));
}

/** Orders the trunks of one gutter, in place: fewer crossings, by moving one trunk at a time. */
function orderLanes(trunks: Trunk[]) {
  const n = trunks.length;
  if (n < 2) return;
  // cost[i][j]: trunk i before trunk j.
  const cost = trunks.map((a) => trunks.map((b) => (a === b ? 0 : laneCost(a, b))));
  const order = trunks.map((_, i) => i);
  for (let round = 0; round < n * 4; round++) {
    let best = 0;
    let move: [number, number] | null = null;
    for (let from = 0; from < n; from++) {
      // Moving order[from] past its neighbours one by one, each way.
      let saved = 0;
      for (let to = from + 1; to < n; to++) {
        saved += cost[order[from]][order[to]] - cost[order[to]][order[from]];
        if (saved > best) {
          best = saved;
          move = [from, to];
        }
      }
      saved = 0;
      for (let to = from - 1; to >= 0; to--) {
        saved += cost[order[to]][order[from]] - cost[order[from]][order[to]];
        if (saved > best) {
          best = saved;
          move = [from, to];
        }
      }
    }
    if (!move) break;
    const [taken] = order.splice(move[0], 1);
    order.splice(move[1], 0, taken);
  }
  const sorted = order.map((i) => trunks[i]);
  sorted.forEach((trunk, i) => {
    trunks[i] = trunk;
  });
}

export function layoutFlow(jobs: readonly FlowLayoutJob[], metrics: FlowMetrics = FLOW_DESKTOP): FlowLayout {
  const m = metrics;
  const graph = flowGraph(jobs);
  const depth = flowDepths(graph);

  // Items: the jobs, in their order, then a pass for each column a job's links run through.
  const columns: Item[][] = [];
  const items = new Map<string, Item>();
  const add = (key: string, node: boolean, id: string, col: number, joined: boolean): Item => {
    const list = (columns[col] = columns[col] ?? []);
    const item: Item = {
      key,
      node,
      id,
      col,
      index: list.length,
      ups: [],
      downs: [],
      before: node ? m.anchor : 0,
      after: node ? m.nodeCross - m.anchor : 0,
      joined,
      pos: 0,
    };
    list.push(item);
    items.set(key, item);
    return item;
  };
  const seen = new Set<string>();
  for (const id of graph.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const inputs = graph.uses.get(id) ?? [];
    add(id, true, id, depth.get(id) ?? 0, inputs.length > 1);
  }
  for (let c = 0; c < columns.length; c++) columns[c] = columns[c] ?? [];
  const connect = (up: Item, down: Item) => {
    if (up.downs.includes(down)) return;
    up.downs.push(down);
    down.ups.push(up);
  };
  /** The item of the column before `to`'s that the link from `from` arrives from. */
  const feeders = new Map<string, Item>();
  for (const to of seen) {
    for (const use of graph.uses.get(to) ?? []) {
      let feeder = items.get(use.from) as Item;
      const last = (depth.get(to) ?? 0) - 1;
      for (let c = feeder.col + 1; c <= last; c++) {
        const key = `${use.from}@${c}`;
        const pass = items.get(key) ?? add(key, false, use.from, c, false);
        connect(feeder, pass);
        feeder = pass;
      }
      connect(feeder, items.get(to) as Item);
      feeders.set(`${use.from}>${to}`, feeder);
    }
  }

  // Across the columns: each is stacked near what its items are linked to, a row apart.
  const apart = (a: Item, b: Item) => {
    if (a.node && b.node) return a.after + m.rowGap + b.before;
    if (!a.node && !b.node) return m.lane;
    return a.after + (a.joined ? m.joinRoom : 0) + m.passGap + b.before;
  };
  const place = (list: Item[], want: (item: Item) => number) => {
    const sorted = list.map((item) => ({ item, want: want(item) })).sort((a, b) => a.want - b.want || a.item.index - b.item.index);
    let prev: Item | null = null;
    for (const entry of sorted) {
      const least: number = prev ? prev.pos + apart(prev, entry.item) : entry.item.before;
      // Whole points, so straight runs can be drawn on the pixels a job's border is drawn on.
      entry.item.pos = Math.round(Math.max(entry.want, least));
      prev = entry.item;
    }
  };
  columns.forEach((list, c) => place(list, (item) => (c === 0 || !item.ups.length ? 0 : mean(item.ups.map((up) => up.pos)))));
  for (let c = columns.length - 2; c >= 0; c--) {
    place(columns[c], (item) => (item.downs.length ? mean(item.downs.map((down) => down.pos)) : item.pos));
  }

  // The picture starts at the top (the left on a phone): the stacking only ever pushes down.
  let first = Infinity;
  for (const list of columns) for (const item of list) first = Math.min(first, item.pos - item.before);
  if (Number.isFinite(first) && first !== 0) for (const list of columns) for (const item of list) item.pos -= first;

  // Ports: a job's inputs arrive side by side, in the order of where they come from.
  const ports = new Map<string, number>();
  for (const to of seen) {
    const inputs = (graph.uses.get(to) ?? [])
      .map((use, index) => ({ key: `${use.from}>${to}`, feeder: feeders.get(`${use.from}>${to}`) as Item, index }))
      .sort((a, b) => a.feeder.pos - b.feeder.pos || a.index - b.index);
    const n = inputs.length;
    if (!n) continue;
    const item = items.get(to) as Item;
    const step = portStep(m, n);
    const span = step * (n - 1);
    const least = m.portInset;
    const most = m.nodeCross - m.portInset - span;
    let start = Math.min(Math.max(m.anchor - span / 2, least), most);
    // A link that comes in nearly level meets its port: the ports move along the side (as far as
    // the side has room) so that it runs straight, instead of taking a step a few points high.
    const edge = item.pos - m.anchor;
    let nearest = Infinity;
    inputs.forEach((input, i) => {
      const off = input.feeder.pos - (edge + start + i * step);
      if (Math.abs(off) < Math.abs(nearest)) nearest = off;
    });
    if (Math.abs(nearest) <= m.level) start = Math.min(Math.max(start + nearest, least), most);
    inputs.forEach((input, i) => ports.set(input.key, Math.round(edge + start + i * step)));
  }

  // Gutters: each item with links out has a trunk; trunks that turn take lanes.
  const trunks = new Map<string, Trunk>();
  const gutters: number[] = [];
  for (let c = 0; c < columns.length - 1; c++) {
    const turning: Trunk[] = [];
    for (const item of columns[c]) {
      if (!item.downs.length) continue;
      const exits = item.downs.map((down) => (down.node ? (ports.get(`${item.id}>${down.id}`) as number) : down.pos));
      const trunk: Trunk = { item, entry: item.pos, exits, lo: Math.min(item.pos, ...exits), hi: Math.max(item.pos, ...exits), lane: -1 };
      trunks.set(item.key, trunk);
      if (trunk.hi - trunk.lo > 0.5) turning.push(trunk);
    }
    // The prototype's order (the upper job's lane first), then one trunk at a time moves to the
    // place that saves most, while any move saves anything.
    turning.sort((a, b) => a.entry - b.entry || a.item.index - b.item.index);
    orderLanes(turning);
    // Trunks that are never side by side share a lane; the others keep their order.
    let lanes = 0;
    turning.forEach((trunk, k) => {
      let lane = 0;
      for (let i = 0; i < k; i++) {
        const other = turning[i];
        if (other.lo - 2 * m.turn < trunk.hi && trunk.lo - 2 * m.turn < other.hi) lane = Math.max(lane, other.lane + 1);
      }
      trunk.lane = lane;
      lanes = Math.max(lanes, lane + 1);
    });
    gutters[c] = Math.max(m.gutter, m.lead + Math.max(0, lanes - 1) * m.lane + m.tail);
  }
  const starts: number[] = [];
  columns.forEach((_, c) => {
    starts[c] = c === 0 ? 0 : starts[c - 1] + m.nodeMain + gutters[c - 1];
  });

  // Out: boxes on the canvas. `main` runs along the columns' direction, `cross` across it.
  const point = (main: number, cross: number): [number, number] => (m.vertical ? [round(cross), round(main)] : [round(main), round(cross)]);
  const nodes: FlowNode[] = [];
  for (const id of seen) {
    const item = items.get(id) as Item;
    const [x, y] = point(starts[item.col], item.pos - m.anchor);
    nodes.push({ id, col: item.col, x, y, w: m.vertical ? m.nodeCross : m.nodeMain, h: m.vertical ? m.nodeMain : m.nodeCross, joined: item.joined });
  }

  const links: FlowLink[] = [];
  for (const to of seen) {
    const target = items.get(to) as Item;
    for (const use of graph.uses.get(to) ?? []) {
      const key = `${use.from}>${to}`;
      const source = items.get(use.from) as Item;
      const port = ports.get(key) as number;
      // Along the columns: out of the job, and in each gutter along its trunk's lane to the next place.
      const route: [number, number][] = [[starts[source.col] + m.nodeMain, source.pos]];
      let at = source.pos;
      let feeder = source;
      for (let c = source.col; c < target.col; c++) {
        const next = c + 1 === target.col ? port : (items.get(`${use.from}@${c + 1}`) as Item).pos;
        if (Math.abs(next - at) > 0.5) {
          const trunk = trunks.get(feeder.key) as Trunk;
          const lane = starts[c] + m.nodeMain + m.lead + Math.max(0, trunk.lane) * m.lane;
          route.push([lane, at], [lane, next]);
          at = next;
        }
        if (c + 1 < target.col) feeder = items.get(`${use.from}@${c + 1}`) as Item;
      }
      route.push([starts[target.col], at]);
      // Drop the corners that are no turn (two runs on one line).
      const corners = route.filter((p, i) => {
        if (i === 0 || i === route.length - 1) return true;
        const a = route[i - 1];
        const b = route[i + 1];
        return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
      });
      const points = corners.map(([main, cross]) => point(main, cross));
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const box: FlowBox = {
        x: Math.min(...xs) - m.pad,
        y: Math.min(...ys) - m.pad,
        w: Math.max(...xs) - Math.min(...xs) + 2 * m.pad,
        h: Math.max(...ys) - Math.min(...ys) + 2 * m.pad,
      };
      const traced = tracePath(points, m.turn, box.x, box.y);
      // The picker's target: on the last run, just before the job; no thicker than the ports are apart.
      const inputs = (graph.uses.get(to) ?? []).length;
      const thick = inputs > 1 ? Math.min(m.hitThick, portStep(m, inputs)) : m.hitThick;
      const [ex, ey] = points[points.length - 1];
      const hit: FlowBox = m.vertical
        ? { x: ex - thick / 2, y: ey - 6 - m.hitLength, w: thick, h: m.hitLength }
        : { x: ex - 6 - m.hitLength, y: ey - thick / 2, w: m.hitLength, h: thick };
      links.push({ key, from: use.from, to, points, box, d: traced.d, length: traced.length, hit });
    }
  }

  let width = 0;
  let height = 0;
  for (const node of nodes) {
    width = Math.max(width, node.x + node.w);
    height = Math.max(height, node.y + node.h);
  }
  for (const link of links) {
    for (const [x, y] of link.points) {
      width = Math.max(width, x);
      height = Math.max(height, y);
    }
  }
  const signature = [
    ...nodes.map((node) => `${node.id}:${node.x},${node.y}`),
    ...links.map((link) => `${link.key}:${link.points.map((p) => p.join(",")).join(" ")}`),
  ].join("|");
  return { nodes, links, width, height, columns: columns.length, signature };
}

/**
 * The route through `points` (runs along the axes) with each corner turned on a curve of radius
 * `turn` (less where a run is too short for two turns): its SVG path data, moved by (`-ox`, `-oy`),
 * and its length.
 */
export function tracePath(points: readonly [number, number][], turn: number, ox = 0, oy = 0): { d: string; length: number } {
  const at = (p: readonly [number, number]) => `${round(p[0] - ox)} ${round(p[1] - oy)}`;
  let d = `M${at(points[0])}`;
  let length = 0;
  let from = points[0];
  for (let i = 1; i < points.length; i++) {
    const corner = points[i];
    const next = points[i + 1];
    if (!next) {
      length += Math.hypot(corner[0] - from[0], corner[1] - from[1]);
      d += ` L${at(corner)}`;
      break;
    }
    const before = Math.hypot(corner[0] - points[i - 1][0], corner[1] - points[i - 1][1]);
    const after = Math.hypot(next[0] - corner[0], next[1] - corner[1]);
    const r = Math.min(turn, before / 2, after / 2);
    const enter: [number, number] = [corner[0] - ((corner[0] - points[i - 1][0]) / before) * r, corner[1] - ((corner[1] - points[i - 1][1]) / before) * r];
    const leave: [number, number] = [corner[0] + ((next[0] - corner[0]) / after) * r, corner[1] + ((next[1] - corner[1]) / after) * r];
    length += Math.hypot(enter[0] - from[0], enter[1] - from[1]) + TURN_LENGTH * r;
    d += ` L${at(enter)} Q${at(corner)} ${at(leave)}`;
    from = leave;
  }
  return { d, length: round(length) };
}
