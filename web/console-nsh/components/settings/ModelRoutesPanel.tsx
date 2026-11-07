// Model routes (llm.routes.*) as a map (the Vue console's ModelRoutesPanel): the kinds of work on
// the left, model profiles on the right, and lines showing where each one's requests go. Line weight
// is the share; dashed, numbered lines are fallbacks in order. Select a route to change it from the
// profiles: Use, Split (with steppers for the shares), or Fallback.
//
// The lines are drawn on a Canvas from the nodes' measured positions (lib/core/route-lines.js lays
// them out, as in Vue), with Vue's motion (ModelRoutesPanel.css): on first show the nodes fade in
// one after another and each line draws in like a pen plotter (dashed fallbacks keep their own
// dashes); then a tapered pulse travels along every line in use, more often for bigger shares, and
// rings where it arrives. Selecting a route dims the others. The motion runs natively from
// animated values; reduced motion shows the drawn map without traffic.
//
// Vue to nsh: `save` is `onSave(update)`, `update:dirty` is `onDirtyChange(dirty)`, `add-profile`
// is `onAddProfile()`.
import type { AnimatedNode, AnimatedValue, CanvasRenderingContext2D, ViewRef } from "nsh";
import {
  batch,
  Canvas,
  cleanup,
  computed,
  createAnimatedValue,
  Easing,
  effect,
  Path2D,
  reduceMotion,
  signal,
  Text,
  token,
  untracked,
  View,
} from "nsh";
import { Button as BaseButton } from "nsh/base";
import {
  addToSplit,
  percentWeights,
  removeFromSplit,
  ROUTE_MODE_SPLIT,
  ROUTE_PURPOSES,
  routeFromValue,
  routeIsUnset,
  routeProblems,
  routeSingleProfile,
  routeToValue,
  setShare,
  toggleFallback,
  useProfile,
} from "../../lib/core/model-routes.js";
import { layoutRouteLines } from "../../lib/core/route-lines.js";
import { Button, Icon } from "../ui";
import { isMobile } from "../../lib/shell";
import { motionMs } from "../motion";
import { SettingsCard } from "../settings-page/parts";
import { type ConfigFieldState, type ConfigUpdate, SettingsSaveRegistryContext } from "./ConfigSettingsPanel";

export interface RouteProfileItem {
  title?: string;
  value: string;
  note?: string;
}

export interface ModelRoutesPanelProps {
  values?: Record<string, unknown>;
  fieldStates?: Record<string, ConfigFieldState | undefined>;
  /** [{ title, value, note }], "default" first. */
  profiles?: RouteProfileItem[];
  loading?: boolean;
  saving?: boolean;
  saveScope?: string;
  onSave?: (update: ConfigUpdate) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Open the Models page with a new profile started. */
  onAddProfile?: () => void;
  testID?: string;
}

const SHARE_STEP = 5;
const STEP_BUTTON =
  "size-[22px] items-center justify-center rounded-(--radius) border border-input bg-field transition-colors duration-120 hover:border-blue disabled:opacity-40";

interface Purpose {
  key: string;
  path: string;
  label: string;
  note: string;
  legacy?: boolean;
  single?: boolean;
  unsetOff?: boolean;
}

interface Route {
  mode: string;
  profile: string;
  candidates: { profile: string; weight: number }[];
  fallbacks: string[];
}

interface Edge {
  id: string;
  purpose: string;
  profile: string;
  kind: "split" | "route" | "fallback";
  share?: number;
  index?: number;
  order?: number;
  implicit?: boolean;
}

interface Role {
  role: "" | "use" | "split" | "fallback";
  share?: number;
  order?: number;
  implicit?: boolean;
}

type Point = { x: number; y: number };

let panelSeq = 0;

// Vue's --routes-node-step, --routes-plot-start, --routes-plot-step and the keyframes' timings.
const NODE_STEP_MS = 70;
const NODE_IN_MS = 380;
const NODE_EASE = "cubic-bezier(0.25, 1, 0.5, 1)" as const;
const PLOT_START_MS = 260;
const PLOT_STEP_MS = 110;
const PLOT_MS = 800;
const TRAFFIC_START_MS = 1200;
const TRAFFIC_IN_MS = 400;
// After this, lines and nodes that appear draw in at once (Vue's `is-drawn`).
const DRAWN_AFTER_MS = 1800;
const LINE_MS = 200;
// lib/core/route-lines.js rounds each corner with this radius.
const CORNER_RADIUS = 8;

/** `color-mix(in srgb, a share, b)` for two #rrggbb tokens, as an opaque #rrggbb. */
function mix(a: string, share: number, b: string) {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v * share + y[i] * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The line through `corners` as route-lines.js's roundedPath draws it (straight runs, each corner a
 * quadratic curve), as a dense polyline with the length along it at each point: for the line's
 * length (dash patterns run along it) and for cutting it into dashes.
 */
function tracePolyline(corners: [number, number][]) {
  const pts = corners.filter(
    (p, i) => i === 0 || Math.abs(p[0] - corners[i - 1][0]) > 0.01 || Math.abs(p[1] - corners[i - 1][1]) > 0.01,
  );
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(CORNER_RADIUS, inLen / 2, outLen / 2);
    const sx = cx - ((cx - px) / inLen) * r;
    const sy = cy - ((cy - py) / inLen) * r;
    const ex = cx + ((nx - cx) / outLen) * r;
    const ey = cy + ((ny - cy) / outLen) * r;
    out.push([sx, sy]);
    for (let k = 1; k <= 12; k++) {
      const t = k / 12;
      const u = 1 - t;
      out.push([u * u * sx + 2 * u * t * cx + t * t * ex, u * u * sy + 2 * u * t * cy + t * t * ey]);
    }
  }
  out.push(pts[pts.length - 1]);
  const at = [0];
  for (let i = 1; i < out.length; i++) at.push(at[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  return { points: out, at, length: at[at.length - 1] };
}

/** The stretch of a traced line from `a` to `b` along it, as a path. */
function cutPolyline(trace: ReturnType<typeof tracePolyline>, a: number, b: number) {
  const { points, at } = trace;
  const pointAt = (s: number): [number, number] => {
    let i = 1;
    while (i < at.length - 1 && at[i] < s) i++;
    const span = at[i] - at[i - 1] || 1;
    const t = Math.min(1, Math.max(0, (s - at[i - 1]) / span));
    return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
  };
  const path = new Path2D();
  const start = pointAt(a);
  path.moveTo(start[0], start[1]);
  for (let i = 0; i < points.length; i++) {
    if (at[i] > a && at[i] < b) path.lineTo(points[i][0], points[i][1]);
  }
  const end = pointAt(b);
  path.lineTo(end[0], end[1]);
  return path;
}

/** The animated values of one line, kept while it stays on the map. */
interface LineMotion {
  /** Its draw-in, 0 to 1 (eased). */
  plot: AnimatedValue;
  /** Its traffic's phase, 0 to 1, looping once per period. */
  phase: AnimatedValue;
  /** Its traffic's fade-in, 0 to 1. */
  traffic: AnimatedValue;
  /** 1 while its route is selected (the full colour). */
  active: AnimatedValue;
  /** 1 while another route is selected (Vue's `is-dim`). */
  dim: AnimatedValue;
  period: number;
  state: string;
  showsTraffic: boolean;
}

export function ModelRoutesPanel(props: ModelRoutesPanelProps) {
  const registry = SettingsSaveRegistryContext();
  const registered = () => Boolean(registry && props.saveScope);
  const draft = signal<Record<string, Route>>({});
  const original = signal<Record<string, string>>({});
  const selected = signal("");
  const validationError = signal("");

  effect(() => {
    const values = props.values || {};
    untracked(() => {
      const next: Record<string, Route> = {};
      const saved: Record<string, string> = {};
      for (const purpose of ROUTE_PURPOSES as Purpose[]) {
        const route = routeFromValue(values[purpose.path]) as Route;
        next[purpose.key] = route;
        saved[purpose.key] = JSON.stringify(routeToValue(route));
      }
      batch(() => {
        draft.set(next);
        original.set(saved);
        validationError.set("");
      });
    });
  });

  const knownProfiles = () => (props.profiles || []).map((item) => item.value).filter(Boolean);
  const routeOf = (purpose: Purpose): Route => draft()[purpose.key] || (routeFromValue(null) as Route);
  const changed = (purpose: Purpose) => JSON.stringify(routeToValue(routeOf(purpose))) !== original()[purpose.key];
  const dirty = computed(() => (ROUTE_PURPOSES as Purpose[]).some(changed));
  let firstDirty = true;
  effect(() => {
    const value = dirty();
    if (firstDirty) {
      firstDirty = false;
      if (!value) return;
    }
    untracked(() => props.onDirtyChange?.(value));
  });

  // Legacy routes are shown only while set, so an old config stays visible and editable.
  const purposes = computed(() =>
    (ROUTE_PURPOSES as Purpose[]).filter(
      (purpose) => !purpose.legacy || !routeIsUnset(routeFromValue((props.values || {})[purpose.path])),
    ),
  );
  const selectedPurpose = () => purposes().find((purpose) => purpose.key === selected()) || null;

  const problems = (purpose: Purpose): string[] =>
    (routeProblems as (route: Route, known: string[] | null, options: { single: boolean }) => string[])(
      routeOf(purpose),
      knownProfiles().length ? knownProfiles() : null,
      { single: purpose.single === true },
    );
  const locked = (purpose: Purpose | null) =>
    Boolean(props.loading || props.saving || (purpose && props.fieldStates?.[purpose.path]?.editable === false));

  // Every line on the map.
  const edges = computed<Edge[]>(() => {
    const out: Edge[] = [];
    for (const purpose of purposes()) {
      const route = routeOf(purpose);
      if (route.mode === ROUTE_MODE_SPLIT) {
        const shares = percentWeights(route.candidates);
        route.candidates.forEach((item, index) => {
          out.push({ id: `${purpose.key}:s:${index}`, purpose: purpose.key, profile: item.profile || "?", share: shares[index], index, kind: "split" });
        });
      } else if (purpose.unsetOff && routeIsUnset(route)) {
        // An unset route that means "off" has no line to the default profile.
      } else {
        out.push({
          id: `${purpose.key}:r`,
          purpose: purpose.key,
          profile: routeSingleProfile(route) || "default",
          share: 100,
          kind: "route",
          implicit: routeIsUnset(route) || route.mode !== "profile",
        });
      }
      route.fallbacks.forEach((name, index) => {
        out.push({ id: `${purpose.key}:f:${index}`, purpose: purpose.key, profile: name, order: index + 1, kind: "fallback" });
      });
    }
    return out;
  });

  // Profiles in use, plus every profile while a route is selected. A profile a route names but the
  // config does not have is shown as missing.
  const profileNodes = computed(() => {
    const used = new Set(edges().map((edge) => edge.profile));
    const listed = (props.profiles || []).map((item) => ({ name: item.value, note: item.note || "", missing: false }));
    const names = new Set(listed.map((item) => item.name));
    const nodes = listed.filter((item) => selected() || used.has(item.name) || item.name === "default");
    for (const name of used) {
      if (!names.has(name)) nodes.push({ name, note: "", missing: true });
    }
    return nodes;
  });
  const hiddenProfiles = () => (props.profiles || []).length - profileNodes().filter((node) => !node.missing).length;

  // Where the selected route sends a profile's requests.
  const roleOf = (name: string): Role => {
    const purpose = selectedPurpose();
    if (!purpose) return { role: "" };
    const route = routeOf(purpose);
    const fallback = route.fallbacks.indexOf(name);
    if (route.mode === ROUTE_MODE_SPLIT) {
      const index = route.candidates.findIndex((item) => item.profile === name);
      if (index >= 0) return { role: "split", share: percentWeights(route.candidates)[index] };
    } else if (routeSingleProfile(route) === name && !(purpose.unsetOff && routeIsUnset(route))) {
      return { role: "use", implicit: route.mode !== "profile" };
    }
    return fallback >= 0 ? { role: "fallback", order: fallback + 1 } : { role: "" };
  };

  const edit = (change: (route: Route) => Route) => {
    const purpose = selectedPurpose();
    if (!purpose || locked(purpose)) return;
    batch(() => {
      draft.update((current) => ({ ...current, [purpose.key]: change(current[purpose.key] || (routeFromValue(null) as Route)) }));
      validationError.set("");
    });
  };
  const actions = {
    use: (name: string) => edit((route) => useProfile(route, name)),
    split: (name: string) => edit((route) => addToSplit(route, name)),
    unsplit: (name: string) => edit((route) => removeFromSplit(route, name)),
    fallback: (name: string) => edit((route) => toggleFallback(route, name)),
    reset: () => edit(() => routeFromValue(null) as Route),
    step: (index: number, delta: number) =>
      edit((route) => setShare(route, index, percentWeights(route.candidates)[index] + delta)),
  };
  const splitIndex = (name: string) => {
    const purpose = selectedPurpose();
    return purpose ? routeOf(purpose).candidates.findIndex((item) => item.profile === name) : -1;
  };
  const select = (purpose: Purpose) => selected.update((current) => (current === purpose.key ? "" : purpose.key));

  /* ---------- line geometry, measured from the nodes ---------- */

  let mapRef: ViewRef | undefined;
  const routeRefs = new Map<string, ViewRef>();
  const profileRefs = new Map<string, ViewRef>();
  const geometry = signal<{ from: Record<string, Point>; to: Record<string, Point & { top: number; bottom: number }> }>({
    from: {},
    to: {},
  });
  let measureSeq = 0;
  let scheduled = false;
  let alive = true;
  cleanup(() => {
    alive = false;
  });

  const measure = async () => {
    const seq = ++measureSeq;
    const map = await mapRef?.measure();
    if (!map || !alive || seq !== measureSeq) return;
    const origin = map.pagePosition;
    const from: Record<string, Point> = {};
    const to: Record<string, Point & { top: number; bottom: number }> = {};
    await Promise.all([
      ...[...routeRefs].map(async ([key, ref]) => {
        const box = await ref.measure();
        if (!box) return;
        const x = box.pagePosition.x - origin.x + box.bounds.size.width;
        const y = box.pagePosition.y - origin.y + box.bounds.size.height / 2;
        from[key] = { x, y };
      }),
      ...[...profileRefs].map(async ([name, ref]) => {
        const box = await ref.measure();
        if (!box) return;
        const top = box.pagePosition.y - origin.y;
        to[name] = { x: box.pagePosition.x - origin.x, y: top + box.bounds.size.height / 2, top, bottom: top + box.bounds.size.height };
      }),
    ]);
    if (!alive || seq !== measureSeq) return;
    geometry.set({ from, to });
  };
  const scheduleMeasure = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      void measure();
    });
  };
  effect(() => {
    void edges();
    void profileNodes();
    void selected();
    untracked(scheduleMeasure);
  });

  interface Line extends Edge {
    path: string;
    corners: [number, number][];
    arrive: Point;
    /** Seconds between pulses; 0 for no traffic (fallbacks). */
    period: number;
    width: number;
    mid: Point;
    end: Point;
    active: boolean;
    dim: boolean;
  }
  const lines = computed<Line[]>(() => {
    const { from, to } = geometry();
    const layout = layoutRouteLines(edges(), from, to) as Record<
      string,
      { path: string; points: [number, number][]; entry: Point; label: Point }
    >;
    const out: Line[] = [];
    for (const edge of edges()) {
      const placed = layout[edge.id];
      if (!placed) continue;
      out.push({
        ...edge,
        path: placed.path,
        corners: placed.points,
        arrive: placed.entry,
        width: edge.kind === "fallback" ? 1 : 1.5,
        // Bigger shares carry traffic more often.
        period: edge.kind === "fallback" ? 0 : Math.min(7, 3 * Math.sqrt(100 / Math.max(1, edge.share ?? 100))),
        // Shares and steppers sit on the line's longest horizontal run.
        mid: placed.label,
        end: { x: placed.entry.x - 12, y: placed.entry.y },
        active: selected() === edge.purpose,
        dim: Boolean(selected()) && selected() !== edge.purpose,
      });
    }
    return out;
  });

  /* ---------- saving ---------- */

  const buildUpdate = (): ConfigUpdate => {
    const changes: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const purpose of ROUTE_PURPOSES as Purpose[]) {
      if (!untracked(() => changed(purpose))) continue;
      const found = untracked(() => problems(purpose));
      if (found.length) {
        errors.push(`${purpose.label}: ${found.join(" ")}`);
        continue;
      }
      changes[purpose.path] = routeToValue(untracked(() => routeOf(purpose)));
    }
    if (errors.length) throw new Error(errors.join(" "));
    return { config_changes: changes, reset: [] };
  };
  const collectUpdate = () => {
    if (!untracked(dirty)) return null;
    try {
      const update = buildUpdate();
      validationError.set("");
      return update;
    } catch (error: any) {
      validationError.set(error?.message || "Invalid route");
      throw error;
    }
  };
  const save = () => {
    try {
      props.onSave?.(buildUpdate());
      validationError.set("");
    } catch (error: any) {
      validationError.set(error?.message || "Invalid route");
    }
  };

  const registryKey = `model-routes-${++panelSeq}`;
  if (untracked(registered)) {
    registry!.register({
      key: registryKey,
      scope: untracked(() => props.saveScope || ""),
      label: () => "Model Routes",
      dirty: () => dirty(),
      collectUpdate,
    });
    cleanup(() => registry!.unregister(registryKey));
  }

  /* ---------- drawing ---------- */

  // Lines and nodes that appear in the first moments draw in one after another; later ones at once.
  const still = () => untracked(reduceMotion);
  let drawn = still();
  const timers: ReturnType<typeof setTimeout>[] = [];
  cleanup(() => timers.forEach((id) => clearTimeout(id)));
  const mountedAt = Date.now();
  timers.push(
    setTimeout(() => {
      drawn = true;
    }, DRAWN_AFTER_MS),
  );
  // A hidden page (a background tab) runs no animation frames, and the web runtime steps animated
  // values only at their deadlines: values are also set where they land once they should have.
  const landAt = (value: AnimatedValue, to: number, afterMs: number) => {
    timers.push(
      setTimeout(() => {
        if (alive) value.set(to);
      }, afterMs + 60),
    );
  };

  /**
   * A node's fade-in (Vue's model-routes-node-in: opacity only, since the lines are measured from
   * the nodes): its style starts at 0 and turns to 1 a moment after it is laid out, carried by a
   * transition with the node's delay. Nodes that appear later, and reduced motion, start at 1.
   */
  const nodeEntrance = (index: number) => {
    const instant = drawn || still();
    const shown = signal(instant);
    if (!instant) timers.push(setTimeout(() => shown.set(true), 32));
    return () => ({
      opacity: shown() ? 1 : 0,
      transitionProperty: "opacity",
      transitionDuration: instant ? 0 : NODE_IN_MS,
      transitionDelay: instant ? 0 : index * NODE_STEP_MS,
      transitionTimingFunction: NODE_EASE,
    });
  };

  // The "more" note and Add profile have no index in Vue: they fade in first.
  const addEntrance = nodeEntrance(0);

  const motions = new Map<string, LineMotion>();
  cleanup(() => {
    for (const motion of motions.values()) {
      for (const value of [motion.plot, motion.phase, motion.traffic, motion.active, motion.dim]) void value.stop();
    }
  });

  // Each line keeps its animated values while it stays: the draw-in plays once, the traffic loops,
  // and its colour and dimming follow the selection over 200ms (Vue's transition on the lines).
  const motionFor = (line: Line, index: number): LineMotion => {
    let motion = motions.get(line.id);
    const state = line.active ? "active" : line.dim ? "dim" : "";
    if (!motion) {
      motion = {
        plot: createAnimatedValue(0),
        phase: createAnimatedValue(0),
        traffic: createAnimatedValue(0),
        active: createAnimatedValue(line.active ? 1 : 0),
        dim: createAnimatedValue(line.dim ? 1 : 0),
        period: 0,
        state,
        showsTraffic: false,
      };
      motions.set(line.id, motion);
      if (still()) {
        motion.plot.set(1);
      } else {
        const delay = drawn ? 0 : PLOT_START_MS + index * PLOT_STEP_MS;
        void motion.plot.timing(1, { duration: PLOT_MS, delay, easing: Easing.bezier(0.55, 0, 0.25, 1) });
        landAt(motion.plot, 1, delay + PLOT_MS);
      }
    } else if (motion.state !== state) {
      motion.state = state;
      const duration = motionMs(LINE_MS);
      void motion.active.timing(line.active ? 1 : 0, { duration, easing: Easing.ease });
      void motion.dim.timing(line.dim ? 1 : 0, { duration, easing: Easing.ease });
    }

    // Traffic: on lines in use, not while another route is selected (Vue removes it then, and
    // brings it back with its fade-in).
    const showsTraffic = Boolean(line.period) && !line.dim && !still();
    if (showsTraffic && line.period !== motion.period) {
      motion.period = line.period;
      void motion.phase.stop();
      motion.phase.set(0);
      void motion.phase.keyframes([0, 1], { duration: line.period * 1000, easing: Easing.linear, iterations: "infinite" });
    }
    if (showsTraffic !== motion.showsTraffic) {
      motion.showsTraffic = showsTraffic;
      if (showsTraffic) {
        const delay = drawn ? 0 : Math.max(0, TRAFFIC_START_MS - (Date.now() - mountedAt));
        motion.traffic.set(0);
        void motion.traffic.timing(1, { duration: TRAFFIC_IN_MS, delay, easing: Easing.bezier(0, 0, 0.58, 1) });
        landAt(motion.traffic, 1, delay + TRAFFIC_IN_MS);
      } else {
        void motion.traffic.stop();
        motion.traffic.set(0);
      }
    }
    return motion;
  };

  const color = (name: Parameters<typeof token>[0]) => token(name) as string;
  const draw = (cx: CanvasRenderingContext2D) => {
    const list = lines();
    // Vue's `.model-routes-line`: the accent 30% into the page (20% for a route left on the
    // default), the full accent while its route is selected; fallbacks orange 65%, dashed.
    const accent = color("primary");
    const orange = color("warn");
    const paper = color("background");
    const traced = list.map((line) => tracePolyline(line.corners));
    const lineMotions = untracked(() => list.map((line, index) => motionFor(line, index)));
    // A line that leaves and comes back draws in again, as Vue remounts it.
    const live = new Set(list.map((line) => line.id));
    for (const [id, motion] of motions) {
      if (live.has(id)) continue;
      for (const value of [motion.plot, motion.phase, motion.traffic, motion.active, motion.dim]) void value.stop();
      motions.delete(id);
    }

    list.forEach((line, index) => {
      const motion = lineMotions[index];
      const trace = traced[index];
      const length = trace.length;
      const fallback = line.kind === "fallback";
      const rest = fallback ? mix(orange, 0.65, paper) : mix(accent, line.implicit ? 0.2 : 0.3, paper);
      cx.save();
      cx.lineCap = "round";
      cx.lineJoin = "round";
      cx.lineWidth = line.width;
      cx.strokeStyle = motion.active.interpolate({ inputRange: [0, 1], outputRange: [rest, fallback ? orange : accent] });
      cx.globalAlpha = motion.dim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.18] });
      if (fallback) {
        // Dashed 4 6. Each dash draws in as the pen passes it, so the dashes stay put.
        for (let a = 0; a < length; a += 10) {
          const b = Math.min(length, a + 4);
          const dash = b - a;
          cx.setLineDash([dash, dash + 2]);
          cx.lineDashOffset = motion.plot.interpolate({ inputRange: [a / length, b / length], outputRange: [dash + 1, 0] });
          cx.stroke(cutPolyline(trace, a, b));
        }
      } else {
        // The pen: one dash as long as the line, moving in.
        cx.setLineDash([length, length + 2]);
        cx.lineDashOffset = motion.plot.interpolate({ inputRange: [0, 1], outputRange: [length + 1, 0] });
        cx.stroke(new Path2D(line.path));
      }
      cx.restore();
    });

    // Traffic: a tapered pulse along each live line (six strokes, the shortest widest), fading in
    // and out at the ends, and a ring where it arrives.
    list.forEach((line, index) => {
      const motion = lineMotions[index];
      if (!motion.showsTraffic) return;
      const length = traced[index].length;
      const tint = line.implicit ? mix(accent, 0.6, paper) : accent;
      const path = new Path2D(line.path);
      // Vue starts each line's pulse 0.45s further along than the last one's.
      const phase: AnimatedNode = motion.phase.add(((index * 0.45) / line.period) % 1).mod(1);
      const visible = phase.interpolate({ inputRange: [0, 0.05, 0.95, 1], outputRange: [0, 1, 1, 0] }).mul(motion.traffic);
      for (let part = 1; part <= 6; part++) {
        const pulse = 19 - part * 3;
        cx.save();
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.strokeStyle = tint;
        cx.lineWidth = 0.4 + part * 0.6;
        cx.globalAlpha = visible.mul(part / 6);
        cx.setLineDash([pulse, length]);
        cx.lineDashOffset = phase.interpolate({ inputRange: [0, 1], outputRange: [pulse / 2, pulse / 2 - length] });
        cx.stroke(path);
        cx.restore();
      }
      // model-routes-arrival: r 5 scaled 0.8 to 1.6 (its 1pt stroke too), 0.6 to 0 opaque, in the
      // first 28% of the period.
      const arrival = Easing.bezier(0.25, 1, 0.5, 1);
      const scale = phase.interpolate({ inputRange: [0, 0.28, 1], outputRange: [0.8, 1.6, 1.6], easing: arrival });
      cx.save();
      cx.strokeStyle = tint;
      cx.lineWidth = scale;
      cx.globalAlpha = phase
        .interpolate({ inputRange: [0, 0.28, 1], outputRange: [0.6, 0, 0], easing: arrival })
        .mul(motion.traffic);
      cx.beginPath();
      cx.arc(line.arrive.x, line.arrive.y, scale.mul(5), 0, Math.PI * 2);
      cx.stroke();
      cx.restore();
    });
  };

  const stepper = (name: string, share: number, index: number, testPrefix: string) => (
    // `.model-routes-stepper`: a blue-framed chip with − and + buttons, 11pt mono.
    <View class="flex-row items-center gap-1 rounded-(--radius) border border-blue bg-card p-0.5">
      <BaseButton
        accessibilityLabel={`Less to ${name}`}
        disabled={share <= 1}
        onPress={() => actions.step(index, -SHARE_STEP)}
        testID={`${testPrefix}-less-${name}`}
        class={STEP_BUTTON}
      >
        <Text class="text-xs text-subtle">−</Text>
      </BaseButton>
      <Text class="font-mono text-[11px] font-semibold leading-none text-blue">{share}%</Text>
      <BaseButton
        accessibilityLabel={`More to ${name}`}
        disabled={share >= 99}
        onPress={() => actions.step(index, SHARE_STEP)}
        testID={`${testPrefix}-more-${name}`}
        class={STEP_BUTTON}
      >
        <Text class="text-xs text-subtle">+</Text>
      </BaseButton>
    </View>
  );

  const nodeAction = (label: string, onPress: () => void, pressed?: boolean) => (
    <BaseButton
      onPress={onPress}
      selected={pressed}
      accessibilityLabel={label}
      class="h-[26px] justify-center rounded-(--radius) border border-input bg-field px-2 transition-colors duration-120 hover:border-blue active:bg-selection selected:border-dashed"
    >
      <Text class="text-xs text-subtle">{label}</Text>
    </BaseButton>
  );

  return (
    <SettingsCard
      title="Model Routes"
      meta="Where each kind of work sends its requests. Line weight is the share; dashed lines are fallbacks, in order. Select a route to change it."
      actions={
        !registered() ? (
          <Button
            variant="plain"
            size="xs"
            label="Save"
            loading={props.saving}
            disabled={props.loading || props.saving || !dirty()}
            onPress={save}
            testID={props.testID ? `${props.testID}-save` : "model-routes-save"}
          />
        ) : undefined
      }
    >
      <View class="gap-3" testID={props.testID}>
        <If when={validationError()}>
          <View class="rounded-(--radius) border border-danger bg-card px-3 py-2" role="alert">
            <Text class="text-sm text-danger">{validationError()}</Text>
          </View>
        </If>

        <If when={selectedPurpose()}>
          {(purpose) => (
            <View class="mb-2 flex-row flex-wrap items-center gap-x-3 gap-y-2 border-l-2 border-blue bg-blue/4 px-3 py-2.5">
              <Text class="text-sm font-semibold text-foreground">{purpose().label}</Text>
              <View class="flex-1 min-w-48">
                <If
                  when={problems(purpose()).length}
                  else={
                    <Text class="text-xs text-muted-foreground">
                      {locked(purpose())
                        ? "This route is managed outside the settings file."
                        : purpose().single
                          ? "Use picks the one profile for these requests; this route has no split or fallbacks."
                          : "Use sends everything to one profile; Split shares requests; Fallback is tried, in order, when a request fails."}
                    </Text>
                  }
                >
                  <Text class="text-xs text-danger" role="alert">
                    {problems(purpose()).join(" ")}
                  </Text>
                </If>
              </View>
              <Button
                variant="plain"
                size="xs"
                label={purpose().unsetOff ? "Turn off" : "Reset to default"}
                disabled={locked(purpose())}
                onPress={actions.reset}
              />
              <Button variant="plain" size="xs" label="Done" onPress={() => selected.set("")} />
            </View>
          )}
        </If>

        <View ref={mapRef} class={`relative flex-row pb-1 pt-2 ${selected() ? "items-start" : "items-center"}`} onLayout={scheduleMeasure}>
          <Canvas class="absolute inset-0" style={{ pointerEvents: "none" }} draw={draw} accessibilityElementsHidden />

          <View class="min-w-[150px] flex-1 gap-2.5" accessibilityLabel="Kinds of work">
            <Each of={purposes()} key={(purpose) => purpose.key}>
              {(purpose, index) => {
                const entrance = nodeEntrance(untracked(index));
                return (
                  <View style={entrance()}>
                    <BaseButton
                      ref={(node: ViewRef) => {
                        routeRefs.set(purpose().key, node);
                        cleanup(() => routeRefs.delete(purpose().key));
                      }}
                      selected={selected() === purpose().key}
                      onPress={() => select(purpose())}
                      onLayout={scheduleMeasure}
                      accessibilityLabel={purpose().label}
                      testID={`route-${purpose().key}`}
                      class={`gap-0.5 rounded-(--radius) border bg-card px-2.5 py-2 transition duration-200 ${
                        selected() === purpose().key
                          ? "border-blue ring-2 ring-blue/22"
                          : problems(purpose()).length
                            ? "border-danger"
                            : "border-line hover:border-blue/45"
                      } ${selected() && selected() !== purpose().key ? "opacity-60" : ""}`}
                    >
                      <View class="flex-row flex-wrap items-baseline gap-1.5">
                        <Text class="text-sm font-semibold text-foreground">{purpose().label}</Text>
                        <If when={purpose().legacy}>
                          <Text class="rounded-(--radius) border border-line px-[5px] font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Legacy</Text>
                        </If>
                        <If when={changed(purpose())}>
                          <View class="size-1.5 rounded-full bg-warn" accessibilityLabel="Unsaved" />
                        </If>
                      </View>
                      <If when={!isMobile()}>
                        <Text class="text-xs leading-[15.4px] text-muted-foreground">{purpose().note}</Text>
                      </If>
                    </BaseButton>
                  </View>
                );
              }}
            </Each>
          </View>

          <View class={isMobile() ? "w-9" : "min-w-14 flex-[0.9]"} />

          <View class={`min-w-[170px] flex-1 ${selected() ? "gap-1.5" : "gap-2.5"}`} accessibilityLabel="Profiles">
            <Each of={profileNodes()} key={(node) => node.name}>
              {(node, index) => {
                const entrance = nodeEntrance(untracked(index) + 1);
                return (
                  <View style={entrance()}>
                    <View
                      ref={(ref: ViewRef) => {
                        profileRefs.set(node().name, ref);
                        cleanup(() => profileRefs.delete(node().name));
                      }}
                      onLayout={scheduleMeasure}
                      testID={`profile-${node().name}`}
                      class={`gap-0.5 rounded-(--radius) border ${selected() ? "px-2 py-1.5" : "px-2.5 py-2"} ${
                        node().missing
                          ? "border-dashed border-danger bg-card"
                          : roleOf(node().name).role === "use" || roleOf(node().name).role === "split"
                            ? "border-blue bg-blue/6"
                            : roleOf(node().name).role === "fallback"
                              ? "border-dashed border-muted-foreground bg-card"
                              : "border-line bg-card"
                      }`}
                    >
                      <View class="flex-row flex-wrap items-baseline gap-1.5">
                        <Text class="font-mono text-sm font-semibold text-foreground">{node().name}</Text>
                        <If when={roleOf(node().name).role === "use"}>
                          <Text class="rounded-(--radius) bg-blue/12 px-[5px] font-mono text-[11px] font-medium uppercase leading-[17.6px] tracking-[0.04em] text-blue">
                            {roleOf(node().name).implicit ? "default" : "all"}
                          </Text>
                        </If>
                        {/* The share as a role chip; on phones, where the gap between the columns is too
                            narrow for the stepper on the line, a stepper in the node instead. */}
                        <If when={roleOf(node().name).role === "split" && !isMobile()}>
                          <Text class="rounded-(--radius) bg-blue/12 px-[5px] font-mono text-[11px] font-medium uppercase leading-[17.6px] tracking-[0.04em] text-blue">
                            {roleOf(node().name).share}%
                          </Text>
                        </If>
                        <If when={roleOf(node().name).role === "split" && isMobile() && !locked(selectedPurpose())}>
                          {stepper(node().name, roleOf(node().name).share ?? 0, splitIndex(node().name), "node")}
                        </If>
                        <If when={roleOf(node().name).role === "fallback"}>
                          <Text class="rounded-(--radius) bg-blue/12 px-[5px] font-mono text-[11px] font-medium uppercase leading-[17.6px] tracking-[0.04em] text-blue">
                            fallback {roleOf(node().name).order}
                          </Text>
                        </If>
                      </View>
                      <If when={node().missing}>
                        <Text class="text-xs text-danger">No profile has this name.</Text>
                      </If>
                      <If when={!node().missing && node().note}>
                        <Text class="text-xs leading-[15.4px] text-muted-foreground">{node().note}</Text>
                      </If>
                      <If when={selectedPurpose() && !locked(selectedPurpose())}>
                        <View class="flex-row flex-wrap gap-1">
                          <If when={roleOf(node().name).role !== "use" || roleOf(node().name).implicit}>
                            {nodeAction("Use", () => actions.use(node().name))}
                          </If>
                          <If
                            when={roleOf(node().name).role === "split"}
                            else={
                              <If
                                when={!selectedPurpose()?.single && (roleOf(node().name).role !== "use" || roleOf(node().name).implicit)}
                              >
                                {nodeAction("Split", () => actions.split(node().name))}
                              </If>
                            }
                          >
                            {nodeAction("Remove", () => actions.unsplit(node().name))}
                          </If>
                          <If
                            when={
                              !selectedPurpose()?.single && (roleOf(node().name).role === "" || roleOf(node().name).role === "fallback")
                            }
                          >
                            {nodeAction(
                              roleOf(node().name).role === "fallback" ? "No fallback" : "Fallback",
                              () => actions.fallback(node().name),
                              roleOf(node().name).role === "fallback",
                            )}
                          </If>
                        </View>
                      </If>
                    </View>
                  </View>
                );
              }}
            </Each>
            <If when={!selected() && hiddenProfiles() > 0}>
              <Text class="text-xs text-muted-foreground" style={addEntrance()}>
                +{hiddenProfiles()} more profiles; select a route to use them
              </Text>
            </If>
            <View style={addEntrance()}>
              <BaseButton
                disabled={props.loading || props.saving}
                onPress={() => props.onAddProfile?.()}
                accessibilityLabel="Add profile"
                class="min-h-10 flex-row items-center justify-center gap-1.5 rounded-(--radius) border border-dashed border-input px-2.5 py-1.5 transition-colors duration-120 hover:border-blue disabled:opacity-55"
              >
                <Icon name="PhPlus" size={14} color="subtle" />
                <Text class="text-sm text-subtle">Add profile</Text>
              </BaseButton>
            </View>
          </View>

          {/* Shares and fallback order sit on the lines. */}
          <Each of={lines()} key={(line) => line.id}>
            {(line) => (
              <>
                <If when={line().kind === "fallback"}>
                  {/* `.model-routes-order`: 16pt, dashed text-2 ring; blue while its route is selected. */}
                  <View
                    class={`absolute size-4 items-center justify-center rounded-full border border-dashed bg-card ${
                      line().active ? "border-blue" : "border-muted-foreground"
                    }`}
                    style={{ left: line().end.x - 8, top: line().end.y - 8, opacity: line().dim ? 0.25 : 1 }}
                    accessibilityLabel={`Fallback ${line().order}`}
                  >
                    <Text class={`font-mono text-[11px] font-semibold leading-none ${line().active ? "text-blue" : "text-subtle"}`}>
                      {line().order}
                    </Text>
                  </View>
                </If>
                <If when={line().kind === "split" && !line().active}>
                  {/* `.model-routes-share`, centred on the line's longest free run. */}
                  <View
                    class="absolute w-20 items-center"
                    style={{ left: line().mid.x - 40, top: line().mid.y - 8.8, opacity: line().dim ? 0.25 : 1, pointerEvents: "none" }}
                  >
                    <View class="rounded-(--radius) bg-card px-[5px]">
                      <Text class="font-mono text-[11px] font-medium leading-[17.6px] text-subtle">{line().share}%</Text>
                    </View>
                  </View>
                </If>
                <If when={line().kind === "split" && line().active && !locked(selectedPurpose()) && !isMobile()}>
                  <View class="absolute w-40 items-center" style={{ left: line().mid.x - 80, top: line().mid.y - 14 }}>
                    {stepper(line().profile, line().share ?? 0, line().index ?? 0, "line")}
                  </View>
                </If>
              </>
            )}
          </Each>
        </View>
      </View>
    </SettingsCard>
  );
}
