// Orthogonal lines for the Model Routes map: routes on the left, profiles on the right.
//
// Every line turns up or down once, on a vertical track, and lines share a track only when they
// share an end:
// - A route with several lines has one track. Its lines leave the route together, share the
//   track, and branch off it to their profiles, each entering at its own port.
// - Lines from routes with one line each, into the same profile, share that profile's track:
//   they join it and enter the profile together at one port.
// Everything else gets its own track and port, so lines that share no end never share a run.
// Tracks are ordered to cross as few other lines as possible.

const PORT = 6; // between ports on one profile
const RADIUS = 8;
const OVERLAP_COST = 50;

// edges: [{ id, purpose, profile }]; routes: { [purpose]: { x, y } } at the route's right edge;
// profiles: { [name]: { x, y, top, bottom } } at the profile's left edge.
// Returns { [id]: { points, path, entry, label } }: the corners, the SVG path, where the line
// arrives, and a spot for a label.
export function layoutRouteLines(edges, routes, profiles) {
  const live = edges.filter((edge) => routes[edge.purpose] && profiles[edge.profile]);
  if (!live.length) {
    return {};
  }
  const left = Math.max(...live.map((edge) => routes[edge.purpose].x));
  const right = Math.min(...live.map((edge) => profiles[edge.profile].x));

  const countBy = (key) => live.reduce((map, edge) => map.set(key(edge), (map.get(key(edge)) || 0) + 1), new Map());
  const perRoute = countBy((edge) => edge.purpose);
  const lone = (edge) => perRoute.get(edge.purpose) === 1;
  const lonePerProfile = countBy((edge) => (lone(edge) ? edge.profile : ""));
  // The track (and group of lines sharing runs) each line belongs to.
  const group = Object.fromEntries(
    live.map((edge) => [edge.id, lone(edge) && lonePerProfile.get(edge.profile) > 1 ? `p:${edge.profile}` : `r:${edge.purpose}`]),
  );
  const joined = (id) => group[id].startsWith("p:");

  // Ports: one per line, or one for the lines that join a profile's track. A profile's ports are
  // in the order of where their lines come from, so no two cross at the node.
  const ports = new Map();
  for (const edge of live) {
    const key = joined(edge.id) ? group[edge.id] : edge.id;
    if (!ports.has(key)) {
      ports.set(key, { id: key, profile: edge.profile, from: [] });
    }
    ports.get(key).from.push(routes[edge.purpose].y);
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const portY = spreadPorts([...ports.values()], (port) => port.profile, (port) => mean(port.from), (port) => profiles[port.profile].y);
  const entryY = Object.fromEntries(live.map((edge) => [edge.id, portY[joined(edge.id) ? group[edge.id] : edge.id]]));

  // Lines level with their port run straight across; the rest get their group's track. The
  // search below improves this order.
  const level = (edge) => Math.abs(entryY[edge.id] - routes[edge.purpose].y) < 1;
  const tracks = [...new Set(live.filter((edge) => !level(edge)).map((edge) => group[edge.id]))];
  const trackY = (key) => mean(live.filter((edge) => group[edge.id] === key).map((edge) => routes[edge.purpose].y));
  tracks.sort((a, b) => trackY(a) - trackY(b));

  function corners() {
    const trackX = new Map(tracks.map((key, index) => [key, left + ((right - left) * (index + 1)) / (tracks.length + 1)]));
    const out = {};
    for (const edge of live) {
      const a = routes[edge.purpose];
      const b = profiles[edge.profile];
      const from = a.y;
      const to = entryY[edge.id];
      const x = level(edge) ? undefined : trackX.get(group[edge.id]);
      out[edge.id] = x === undefined ? [[a.x, from], [b.x, from]] : [[a.x, from], [x, from], [x, to], [b.x, to]];
    }
    return out;
  }

  // Search: swap neighbours in any order while that lowers the cost.
  const orders = [tracks];
  const cost = (lines) => crossings(lines, group);
  let best = cost(corners());
  for (let pass = 0; pass < 40; pass++) {
    let improved = false;
    for (const list of orders) {
      for (let i = 0; i + 1 < list.length; i++) {
        [list[i], list[i + 1]] = [list[i + 1], list[i]];
        const next = cost(corners());
        if (next < best) {
          best = next;
          improved = true;
        } else {
          [list[i], list[i + 1]] = [list[i + 1], list[i]];
        }
      }
    }
    if (!improved) {
      break;
    }
  }

  const final = corners();
  const verticals = Object.entries(final).flatMap(([id, points]) => segments(points).filter((run) => !run.h).map((run) => ({ ...run, id })));
  const result = {};
  for (const [id, points] of Object.entries(final)) {
    // A label goes on a run the line has to itself: the last run when it shares its route's, the
    // first when it shares its profile's.
    const shared = joined(id) || perRoute.get(live.find((edge) => edge.id === id).purpose) > 1;
    const run = !shared ? points : joined(id) ? points.slice(0, 2) : points.slice(-2);
    const label = labelPoint(run, verticals.filter((v) => group[v.id] !== group[id]));
    result[id] = { points, path: roundedPath(points), entry: { x: points.at(-1)[0], y: points.at(-1)[1] }, label };
  }
  return result;
}

// The middle of the longest stretch of a horizontal run that no other line crosses; the later
// one on a tie, nearer the profile.
function labelPoint(points, crossing) {
  let best = null;
  let bestLength = -1;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (Math.abs(y1 - y2) > 0.01) {
      continue;
    }
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    const cuts = crossing.filter((v) => v.c > lo && v.c < hi && y1 > v.lo && y1 < v.hi).map((v) => v.c);
    const stops = [lo, ...cuts.sort((a, b) => a - b), hi];
    for (let k = 1; k < stops.length; k++) {
      const length = stops[k] - stops[k - 1];
      if (length >= bestLength - 0.5) {
        best = { x: (stops[k] + stops[k - 1]) / 2, y: y1 };
        bestLength = Math.max(bestLength, length);
      }
    }
  }
  return best;
}

function spreadPorts(edges, groupOf, orderOf, centerOf) {
  const groups = new Map();
  for (const edge of edges) {
    const key = groupOf(edge);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(edge);
  }
  const out = {};
  for (const list of groups.values()) {
    list.sort((a, b) => orderOf(a) - orderOf(b) || a.id.localeCompare(b.id));
    list.forEach((edge, index) => {
      out[edge.id] = centerOf(edge) + (index - (list.length - 1) / 2) * PORT;
    });
  }
  return out;
}

function segments(points) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    if (Math.abs(x1 - x2) < 0.01 && Math.abs(y1 - y2) < 0.01) {
      continue;
    }
    out.push(Math.abs(y1 - y2) < 0.01
      ? { h: true, c: y1, lo: Math.min(x1, x2), hi: Math.max(x1, x2) }
      : { h: false, c: x1, lo: Math.min(y1, y2), hi: Math.max(y1, y2) });
  }
  return out;
}

// Crossings between lines from different groups, and runs they share (much worse: they read as
// one line). Lines in one group share runs on purpose.
function crossings(lines, owner) {
  const ids = Object.keys(lines);
  const all = ids.map((id) => segments(lines[id]));
  let total = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (owner[ids[i]] === owner[ids[j]]) {
        continue;
      }
      for (const s of all[i]) {
        for (const t of all[j]) {
          if (s.h === t.h) {
            if (Math.abs(s.c - t.c) < 2 && Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo) > 0.5) {
              total += OVERLAP_COST;
            }
          } else if (t.c > s.lo && t.c < s.hi && s.c > t.lo && s.c < t.hi) {
            total += 1;
          }
        }
      }
    }
  }
  return total;
}

// An orthogonal path through the corners, each corner rounded.
export function roundedPath(points) {
  const pts = points.filter((p, i) => i === 0 || Math.abs(p[0] - points[i - 1][0]) > 0.01 || Math.abs(p[1] - points[i - 1][1]) > 0.01);
  const f = (v) => Math.round(v * 100) / 100;
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i + 1 < pts.length; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(RADIUS, inLen / 2, outLen / 2);
    const sx = cx - ((cx - px) / inLen) * r;
    const sy = cy - ((cy - py) / inLen) * r;
    const ex = cx + ((nx - cx) / outLen) * r;
    const ey = cy + ((ny - cy) / outLen) * r;
    d += ` L ${f(sx)} ${f(sy)} Q ${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${f(last[0])} ${f(last[1])}`;
}
